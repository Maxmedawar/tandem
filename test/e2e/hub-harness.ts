/**
 * A local hub and real bridges for end-to-end tests (moved from hub-local.test.ts).
 *
 * The hub is `wrangler dev --local` (as in hub/test/url-token.test.ts); each bridge is a
 * real `src/server.ts` child with its own HOME, tmux socket (TMUX_TMPDIR, no TMUX) and
 * folder. Folders are made under the prefix given to startHub (e.g. `/tmp/r1a07-`).
 * signIn does what claude.ai does: register, authorize with the password, token with PKCE.
 * Each test file gets its own copy of this module's state.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = fileURLToPath(new URL('../..', import.meta.url))
const hubDir = join(repo, 'hub')
const wranglerBin = join(hubDir, 'node_modules', '.bin', 'wrangler')
const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
/** What is missing to run a hub test ('' when nothing is): callers skip on it. */
export const missing = [existsSync(wranglerBin) ? '' : 'hub/node_modules/.bin/wrangler', hasTmux ? '' : 'tmux']
  .filter(Boolean)
  .join(' and ')

export const rand = (chars: number) => randomBytes(chars).toString('hex').slice(0, chars)
export const LINK_TOKEN = rand(32)
const HUB_PASSWORD = rand(32)

export interface Bridge {
  id: string
  base: string
  home: string
  tmuxDir: string
  /** U-R1A-19: Tandem's own tmux socket, <its TANDEM_HOME, else HOME/.tandem>/tmux/tandem. */
  socket: string
  folder: string
  child?: ChildProcess
  stderr: string
  /** U-R1A-33B-2: the environment startBridge built, for restartBridge and a stdio server on this computer. */
  env?: NodeJS.ProcessEnv
}

let wrangler: ChildProcess | undefined
let hubLog = ''
let port = 0
let persist = ''
let prefix = ''
/** The hub's base URL once startHub has returned. */
export let hub = ''

export async function freePort(): Promise<number> {
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

/** `folderPrefix`: every folder this module makes starts with it (the hub's store, each bridge's). */
export async function startHub(folderPrefix: string): Promise<void> {
  prefix = folderPrefix
  port = await freePort()
  const inspectorPort = await freePort()
  persist = mkdtempSync(`${prefix}wrangler-`)
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

/** Stops the hub this module started (its own process group) and removes its store. */
export async function stopHub(): Promise<void> {
  if (wrangler?.pid && wrangler.exitCode === null && wrangler.signalCode === null) {
    const exited = once(wrangler, 'exit')
    try { process.kill(-wrangler.pid, 'SIGTERM') } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  if (persist) rmSync(persist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** Starts bridge `id` linked to the hub; returns once its stderr says `hub link: connected`. */
export async function startBridge(id: string, extraEnv: Record<string, string> = {}): Promise<Bridge> {
  // Under /tmp, not os.tmpdir(): the tmux socket path must stay under the 104-byte limit.
  const base = realpathSync(mkdtempSync(`${prefix}${id}-`))
  const bridge: Bridge = {
    id,
    base,
    home: join(base, 'home'),
    tmuxDir: join(base, 'tmux'),
    socket: join(base, 'home', '.tandem', 'tmux', 'tandem'),
    folder: join(base, 'work'),
    stderr: '',
  }
  try {
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
    }, extraEnv)
    bridge.env = env
    // U-R1A-17: the limits file, where this bridge looks (TANDEM_HOME when extraEnv sets it, else its
    // HOME's .tandem), allowing what it already enables: its work folder, and the shell pinned to the
    // sh its PATH finds.
    const tandemHome = env.TANDEM_HOME || join(env.HOME!, '.tandem')
    bridge.socket = join(tandemHome, 'tmux', 'tandem')
    const { agentEntry, writeLimits } = await import('../fixtures/limits.ts')
    const { loadHarnesses } = await import('../../bridge/harness-registry.ts')
    const sh = loadHarnesses({ ownerDir: join(tandemHome, 'harnesses'), path: env.PATH ?? '' }).harnesses.get('shell')!
    writeLimits(tandemHome, { folders: [bridge.folder], shell: true, agents: { shell: agentEntry(sh) } })
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
  } catch (error) {
    await stopBridge(bridge)
    throw error
  }
  return bridge
}

/** SIGTERM to the bridge's own process group (5 s at most), its own tmux server, its folder. */
export async function stopBridge(bridge: Bridge | undefined): Promise<void> {
  if (!bridge) return
  const child = bridge.child
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  spawnSync('tmux', ['-S', socketOf(bridge), 'kill-server'], { stdio: 'ignore' })
  // Retries: a shell killed just now may still be writing its history file into this folder.
  rmSync(bridge.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

export function socketOf(bridge: Bridge): string {
  return bridge.socket
}

const decodeHtml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** OAuth as claude.ai does it: register, authorize (form, then password), token with PKCE. */
export async function signIn(): Promise<string> {
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

/**
 * U-R1A-33B-2: stop the bridge (its own process group, `signal`), waiting up to 5 s for it to
 * exit; its folder, keys, mailbox and tmux server stay for restartBridge.
 */
export async function pauseBridge(bridge: Bridge, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
  const child = bridge.child
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  try { process.kill(-child.pid, signal) } catch { /* already gone */ }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
}

/** U-R1A-33B-2: start `src/server.ts` again with the env startBridge kept; resolves on one more `hub link: connected`. */
export async function restartBridge(bridge: Bridge): Promise<void> {
  if (!bridge.env) throw new Error(`${bridge.id}: no kept env`)
  const count = () => bridge.stderr.split('hub link: connected').length - 1
  const before = count()
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: repo,
    env: bridge.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.child = child
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', (chunk: Buffer) => { bridge.stderr += chunk.toString() })
  await waitFor(() => count() > before || child.exitCode !== null, 60_000, `${bridge.id} to connect again`)
  if (child.exitCode !== null) throw new Error(`${bridge.id} exited ${child.exitCode}:\n${bridge.stderr}`)
}

/** U-R1A-33B-2: SIGTERM to the hub's own process group, then `wrangler dev` again on the same port and persist folder. */
export async function restartHub(): Promise<void> {
  if (wrangler?.pid && wrangler.exitCode === null && wrangler.signalCode === null) {
    const exited = once(wrangler, 'exit')
    try { process.kill(-wrangler.pid, 'SIGTERM') } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
  }
  const inspectorPort = await freePort()
  const next = spawn(wranglerBin, [
    'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--var', `TANDEM_HUB_LINK_TOKEN:${LINK_TOKEN}`,
    '--var', `TANDEM_HUB_PASSWORD:${HUB_PASSWORD}`,
    '--persist-to', persist,
  ], { cwd: hubDir, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  wrangler = next
  let log = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev was not ready again in 60 s:\n${log}`)), 60_000)
    const read = (chunk: Buffer) => {
      log += chunk.toString()
      hubLog += chunk.toString()
      if (log.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    next.stdout!.on('data', read)
    next.stderr!.on('data', read)
    next.once('exit', (code) => { clearTimeout(timer); reject(new Error(`wrangler dev exited ${code}:\n${log}`)) })
  })
}
