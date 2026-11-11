/**
 * One local hub, two bridges: every session and relay tool called at the hub
 * reaches the router of the computer it names.
 *
 * The hub is `wrangler dev --local` (as in hub/test/url-token.test.ts); the two
 * bridges, `alpha` and `beta`, are real `src/server.ts` children, each with its
 * own HOME, tmux socket (TMUX_TMPDIR, no TMUX) and folder. The test signs in the
 * way claude.ai does (register, authorize with the password, token with PKCE)
 * and calls the hub's tools with the MCP SDK client.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const hubDir = join(repo, 'hub')
const wranglerBin = join(hubDir, 'node_modules', '.bin', 'wrangler')
const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
const missing = [existsSync(wranglerBin) ? '' : 'hub/node_modules/.bin/wrangler', hasTmux ? '' : 'tmux']
  .filter(Boolean)
  .join(' and ')
const title = missing
  ? `one local hub, two bridges (skipped: ${missing} missing)`
  : 'one local hub, two bridges'

const rand = (chars: number) => randomBytes(chars).toString('hex').slice(0, chars)
const LINK_TOKEN = rand(32)
const HUB_PASSWORD = rand(32)
const uid = process.getuid?.() ?? 0
const WAIT = 120_000

type Id = 'alpha' | 'beta'
interface Bridge {
  id: Id
  base: string
  home: string
  tmuxDir: string
  folder: string
  child?: ChildProcess
  stderr: string
}
type Json = Record<string, any>

let wrangler: ChildProcess | undefined
let hubLog = ''
let port = 0
let persist = ''
let hub = ''
let client: Client | undefined
const bridges = {} as Record<Id, Bridge>
const other = (id: Id): Id => (id === 'alpha' ? 'beta' : 'alpha')

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port: free } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return free
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function startHub(): Promise<void> {
  port = await freePort()
  const inspectorPort = await freePort()
  persist = mkdtempSync(join(tmpdir(), 'r1a07-wrangler-'))
  wrangler = spawn(wranglerBin, [
    'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--var', `TANDEM_HUB_LINK_TOKEN:${LINK_TOKEN}`,
    '--var', `TANDEM_HUB_PASSWORD:${HUB_PASSWORD}`,
    '--persist-to', persist,
  ], { cwd: hubDir, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev was not ready in 60 s:\n${hubLog}`)), 60_000)
    const read = (chunk: Buffer) => {
      hubLog += chunk.toString()
      if (hubLog.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    wrangler!.stdout!.on('data', read)
    wrangler!.stderr!.on('data', read)
    wrangler!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`wrangler dev exited ${code}:\n${hubLog}`)) })
  })
  hub = `http://127.0.0.1:${port}`
}

async function startBridge(id: Id): Promise<void> {
  // Under /tmp, not os.tmpdir(): the tmux socket path must stay under the 104-byte limit.
  const base = realpathSync(mkdtempSync(`/tmp/r1a07-${id}-`))
  const bridge: Bridge = {
    id,
    base,
    home: join(base, 'home'),
    tmuxDir: join(base, 'tmux'),
    folder: join(base, 'work'),
    stderr: '',
  }
  bridges[id] = bridge
  for (const dir of [bridge.home, bridge.tmuxDir, bridge.folder, join(base, 'oauth')]) mkdirSync(dir, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: bridge.home,
    TMUX_TMPDIR: bridge.tmuxDir,
    SHELL: '/bin/sh',
    TANDEM_PORT: '0',
    TANDEM_PUBLIC_URL: 'https://e2e.example/mcp',
    TANDEM_ISSUER_URL: 'https://e2e.example',
    TANDEM_OWNER_PASSWORD: rand(32),
    TANDEM_OAUTH_STATE_DIR: join(base, 'oauth'),
    TANDEM_ENABLED_ENGINES: 'shell',
    TANDEM_CWD_ALLOWLIST: bridge.folder,
    TANDEM_HUB_LINK_URL: `ws://127.0.0.1:${port}`,
    TANDEM_HUB_LINK_TOKEN: LINK_TOKEN,
    TANDEM_HUB_LINK_ID: id,
  })
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.child = child
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', (chunk: Buffer) => { bridge.stderr += chunk.toString() })
  await waitFor(() => bridge.stderr.includes('hub link: connected') || child.exitCode !== null, 30_000, `${id} to connect`)
  if (child.exitCode !== null) throw new Error(`${id} exited ${child.exitCode}:\n${bridge.stderr}`)
}

async function stopBridge(bridge: Bridge | undefined): Promise<void> {
  if (!bridge) return
  const child = bridge.child
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  spawnSync('tmux', ['-S', socketOf(bridge), 'kill-server'], { stdio: 'ignore' })
  rmSync(bridge.base, { recursive: true, force: true })
}

function socketOf(bridge: Bridge): string {
  return join(bridge.tmuxDir, `tmux-${uid}`, 'default')
}

function hasSession(bridge: Bridge, name: string): boolean {
  return spawnSync('tmux', ['-S', socketOf(bridge), 'has-session', '-t', `=ccm-${name}`], { stdio: 'ignore' }).status === 0
}

function auditText(bridge: Bridge): string {
  const path = join(bridge.home, '.tandem', 'bridge.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const decodeHtml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** OAuth as claude.ai does it: register, authorize (form, then password), token with PKCE. */
async function signIn(): Promise<string> {
  const redirect = `http://127.0.0.1:${await freePort()}/cb`
  const registered = await fetch(`${hub}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'r1a07-e2e',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  if (registered.status !== 201) throw new Error(`register: ${registered.status} ${await registered.text()}`)
  const { client_id: clientId } = (await registered.json()) as { client_id: string }

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: rand(16),
  })
  const page = await fetch(`${hub}/authorize?${query}`)
  const html = await page.text()
  if (page.status !== 200) throw new Error(`GET /authorize: ${page.status}`)
  const fields = new URLSearchParams()
  for (const match of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    fields.append(decodeHtml(match[1]), decodeHtml(match[2]))
  }
  fields.set('password', HUB_PASSWORD)
  const authorized = await fetch(`${hub}/authorize`, { method: 'POST', body: fields, redirect: 'manual' })
  if (authorized.status !== 302) throw new Error(`POST /authorize: ${authorized.status}`)
  const code = new URL(authorized.headers.get('location') ?? '').searchParams.get('code')
  if (!code) throw new Error('POST /authorize: no code in the redirect')

  const token = await fetch(`${hub}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  if (token.status !== 200) throw new Error(`POST /token: ${token.status} ${await token.text()}`)
  return ((await token.json()) as { access_token: string }).access_token
}

/** One tool call; the bridge's JSON answer, or what went wrong at the MCP layer. */
async function tool(name: string, args: Record<string, unknown>): Promise<Json> {
  try {
    const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: WAIT })
    const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ''
    if (result.isError) return { toolError: text }
    return JSON.parse(text) as Json
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

const sessionIds = (listed: Json): string[] => ((listed.sessions ?? []) as { id: string }[]).map((s) => s.id)

describe.skipIf(Boolean(missing))(title, () => {
  beforeAll(async () => {
    await startHub()
    await Promise.all([startBridge('alpha'), startBridge('beta')])
    const token = await signIn()
    client = new Client({ name: 'r1a07-e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
  }, 150_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await Promise.all([stopBridge(bridges.alpha), stopBridge(bridges.beta)])
    if (wrangler?.pid && wrangler.exitCode === null) {
      try { process.kill(-wrangler.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    if (persist) rmSync(persist, { recursive: true, force: true })
  }, 30_000)

  it('/mcp without a token gives 401', async () => {
    const response = await fetch(`${hub}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)
  })

  it('with the token, list_machines shows alpha and beta', async () => {
    const machines = await tool('list_machines', {})
    expect([...(machines.connected ?? [])].sort()).toEqual(['alpha', 'beta'])
  })

  describe.each(['alpha', 'beta'] as Id[])('sessions on %s', (id) => {
    it(`open, send, read, interrupt and close reach ${id} only; list_sessions filters by agent`, async () => {
      const bridge = bridges[id]
      const elsewhere = bridges[other(id)]
      const name = `e2e-${id}-${rand(6)}`

      const opened = await tool('open_session', { name, cwd: bridge.folder, engine: 'shell', machine: id })
      expect(opened).toMatchObject({ name, engine: 'shell' })
      expect(hasSession(bridge, name)).toBe(true)
      expect(hasSession(elsewhere, name)).toBe(false)

      const marker = `${id}-${rand(12)}`
      const sent = await tool('send_to_session', { name, text: `echo ${marker}`, machine: id })
      expect(sent).toMatchObject({ name, engine: 'shell' })
      expect(sent.report).toContain(marker)

      // The hub link secret is not in a session's environment: it would let an agent pose as another computer.
      const probe = await tool('send_to_session', { name, text: `echo ${marker}-[$TANDEM_HUB_LINK_TOKEN]`, machine: id })
      expect(probe.report).toContain(`${marker}-[]`)
      expect(JSON.stringify(probe)).not.toContain(LINK_TOKEN)

      const read = await tool('read_session', { name, sinceCursor: 0, machine: id })
      expect(read).toMatchObject({ live: true, engine: 'shell' })
      expect(read.text).toContain(marker)

      expect(sessionIds(await tool('list_sessions', { engine: 'shell', machine: id }))).toContain(name)
      expect(sessionIds(await tool('list_sessions', { engine: 'claude', machine: id }))).toEqual([])
      expect(sessionIds(await tool('list_sessions', { engine: 'shell', machine: other(id) }))).not.toContain(name)
      expect(sessionIds(await tool('list_sessions', { machine: other(id) }))).not.toContain(name)

      expect(await tool('interrupt_session', { name, machine: id })).toMatchObject({ ok: true, name, engine: 'shell' })
      expect(await tool('close_session', { name, machine: id })).toMatchObject({ ok: true, name, engine: 'shell' })
      expect(hasSession(bridge, name)).toBe(false)
    }, WAIT)
  })

  it("open_session with engine no-such-agent on beta returns beta's 400 naming the engine", async () => {
    const opened = await tool('open_session', { name: `e2e-x-${rand(6)}`, cwd: bridges.beta.folder, engine: 'no-such-agent', machine: 'beta' })
    expect(opened.error).toMatch(/^unknown engine: "no-such-agent"\./)
  }, WAIT)

  describe.each(['alpha', 'beta'] as Id[])('relay on %s', (id) => {
    it(`start, read, stop and inject get ${id}'s own answer`, async () => {
      const bridge = bridges[id]
      const elsewhere = bridges[other(id)]
      const started = await tool('start_relay', { goal: 'e2e goal', cwd: bridges.alpha.folder, machine: id })
      if (id === 'alpha') expect(started.error).toMatch(/^relay refused to start/) // 400: no bypass
      else expect(started.error).toBe(`cwd not allowed: ${bridges.alpha.folder}`) // 403: not beta's folder

      const loopId = `${id}-loop-${rand(8)}`
      expect(await tool('read_relay', { loopId, machine: id })).toEqual({ error: `unknown loopId: ${loopId}` }) // 404
      expect(await tool('stop_relay', { loopId, machine: id })).toEqual({ ok: false, running: false })
      expect(await tool('inject_to_relay', { loopId, message: 'e2e note', machine: id })).toEqual({ ok: false })

      const here = auditText(bridge)
      for (const route of ['GET /relay/:loopId/read', 'POST /relay/:loopId/stop', 'POST /relay/:loopId/inject']) {
        expect(here).toContain(JSON.stringify({ route, loopId }).slice(1, -1))
      }
      expect(auditText(elsewhere)).not.toContain(loopId)
    }, WAIT)
  })

  it('oversize: 900 KiB to alpha gives payload_too_large, the link stays up, and the next call to alpha succeeds', async () => {
    const sent = await tool('send_to_session', { name: 'e2e-big', text: 'x'.repeat(900 * 1024), machine: 'alpha' })
    expect(sent).toEqual({ error: 'payload_too_large' })
    await new Promise((resolve) => setTimeout(resolve, 1_500)) // a dropped link would redial within this
    expect(bridges.alpha.stderr.split('hub link: connected').length - 1).toBe(1)
    const loopId = `after-big-${rand(6)}`
    expect(await tool('read_relay', { loopId, machine: 'alpha' })).toEqual({ error: `unknown loopId: ${loopId}` })
  }, WAIT)
})
