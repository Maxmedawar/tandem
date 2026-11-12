/**
 * U-R1A-36B: a signed command from another computer (bridge/remote-command.ts), run here only when
 * this computer's limits file lists the sender in `control_from`; remote Ask mail likewise.
 *
 * This computer is beta (TANDEM_HUB_LINK_ID) with a roster of root, alpha and beta; gamma's key
 * exists but gamma is not in the roster. Every folder is under one mkdtemp folder named r1a36b- in
 * TMPDIR: TANDEM_HOME (roster, limits file, state.db, Tandem's tmux socket), HOME (the audit log),
 * the keys, the work folders. TMUX is deleted before the dynamic imports. afterAll ends every tmux
 * server whose socket is in that folder, then removes it. Sessions are the pinned shell harness
 * file only. The A side runs against an in-process node:http fake hub that records each request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a36b-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a36b: temp folder is under the real home')
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
delete process.env.TANDEM_CALLER_TOKEN
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const OUT = join(BOX, 'out')
const CHILD_HOME = join(BOX, 'child-home')
for (const d of [HOME, WORK, OUT, CHILD_HOME]) mkdirSync(d, { mode: 0o700 })
mkdirSync(TH, { mode: 0o700 })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.TANDEM_HUB_LINK_ID = 'beta'
process.env.CCM_CWD_ALLOWLIST = BOX
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.TANDEM_WAIT_MS = '4000'
process.env.SHELL = '/bin/sh'

const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { signEnvelope, openEnvelope } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { handleRemoteCommand, sendRemoteCommand } = await import('../bridge/remote-command.ts')
const { route } = await import('../bridge/router.ts')
const { handleHubRequest } = await import('../bridge/hub-rpc.ts')
const { openMailbox, MailError } = await import('../bridge/mailbox.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const { KILL_SWITCH_ON } = await import('../bridge/kill-switch.ts')
const tokens = await import('../bridge/caller-tokens.ts')
const { parseProof, verifyProof } = await import('../hub/src/devices.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SOCK = join(TH, 'tmux', 'tandem')
const AUDIT = join(HOME, '.tandem', 'bridge.log')
const AGENT = 'r1a36b-agent'
const CALLER = `session:${AGENT}`
const NOT_ALPHA = 'control_from: alpha may not act on this computer (limits file)'
const ASK_REFUSED = 'control_from: alpha may not send Ask here (limits file); nothing was saved'
const DEVICE_REFUSED = "device: an agent acts on another computer only through the hub, as that computer's control_from allows"
const INTERRUPT_REFUSED = 'interrupt: an agent never interrupts a session'
const CONTROL_FROM_TYPE = 'wrong type for control_from: expected an array of computer ids'
const TOKEN = 'r'.repeat(40)

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const ROOT = key('root')
const A = key('alpha')
const B = key('beta')
const G = key('gamma')
initRoster(ROOT, 'root')
for (const [id, k] of [['alpha', A], ['beta', B]] as const) {
  receiveOffer(JSON.stringify(makeOffer(k, id)))
  trustOffer(ROOT, k.fingerprint)
}

let clock = Date.now()
const now = () => clock

let BASE_LIMITS: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE_LIMITS, ...extra })
  limits.applyLimits()
}

/** A command body; `over` replaces or adds fields. */
const cmd = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'command', op: 'open', args: { engine: 'shell', name: 'r1a36b-x', cwd: WORK }, caller: CALLER, ...over })
const seal = (k: Json, from: string, to: string, body: string, ts = clock) => JSON.stringify(signEnvelope(k, { from, to, body }, ts))
const run = (envelope: string) => handleRemoteCommand({ envelope }, { now })
const fromAlpha = (over: Json = {}) => run(seal(A, 'alpha', 'beta', cmd(over)))

function tmuxOut(args: string[]): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
const ccm = () => tmuxOut(['list-sessions', '-F', '#{session_name}']).split('\n').filter((n) => n.startsWith('ccm-'))
function auditLines(): Json[] {
  if (!existsSync(AUDIT)) return []
  return readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const commandLines = (from: number) => auditLines().slice(from).filter((l) => l.event === 'remote.command')

/* ---- the fake hub (A side) ---- */
type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
const seen: Seen[] = []
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, name: 'r1a36b-remote' } }
let server: Server
let port = 0

/* ---- stdio children (the agent on this computer) ---- */
interface Child { err: { text: string }; call(name: string, args?: Record<string, unknown>): Promise<Json>; close(): Promise<void> }
const CHILDREN: Child[] = []
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'TMUX' || k === 'TMUX_PANE' || k.startsWith('TANDEM_') || k.startsWith('CCM_')) continue
    env[k] = v
  }
  return Object.assign(env, {
    HOME: CHILD_HOME, TANDEM_HOME: TH, TMUX_TMPDIR: BOX, TANDEM_CWD_ALLOWLIST: BOX, TANDEM_ENABLED_ENGINES: 'shell',
    TANDEM_WAIT_MS: '4000', SHELL: '/bin/sh', NODE_NO_WARNINGS: '1',
  }, extra)
}
async function startChild(extra: Record<string, string>): Promise<Child> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, stderr: 'pipe', env: childEnv(extra),
  })
  const err = { text: '' }
  transport.stderr?.on('data', (d) => { err.text += d })
  const client = new Client({ name: 'r1a36b', version: '0.0.0' })
  await client.connect(transport)
  const child: Child = {
    err,
    async call(name, args = {}) {
      return JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text)
    },
    close: () => client.close(),
  }
  CHILDREN.push(child)
  return child
}

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  if (!sh) throw new Error('the shell harness file did not load')
  BASE_LIMITS = { folders: [WORK], shell: true, agents: { shell: agentEntry(sh) } }
  setLimits()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  for (const c of CHILDREN) await c.close().catch(() => {})
  await new Promise((resolve) => server?.close(resolve))
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

beforeEach(() => {
  clock = Date.now()
  rmSync(join(TH, 'kill-switch'), { force: true })
  setLimits()
})

describe('(l1) control_from in the limits file', () => {
  it('(36B) (l1) control_from = ["alpha"] applies; absent is []', () => {
    setLimits({ control_from: ['alpha'] })
    expect(limits.limitsSnapshot().problem).toBeUndefined()
    expect(limits.limitsSnapshot().control_from).toEqual(['alpha'])
    setLimits()
    expect(limits.limitsSnapshot().problem).toBeUndefined()
    expect(limits.limitsSnapshot().control_from).toEqual([])
  })

  it('(36B) (l1) "alpha", ["Alpha"], ["alpha","alpha"] and [1] refuse the whole file with the exact text', () => {
    for (const bad of ['alpha', ['Alpha'], ['alpha', 'alpha'], [1]]) {
      setLimits({ control_from: bad })
      expect(limits.limitsSnapshot().problem).toBe(`${join(TH, 'limits.toml')}: ${CONTROL_FROM_TYPE}`)
      expect(limits.limitsSnapshot().folders).toEqual([])
      expect(limits.limitsSnapshot().control_from).toEqual([])
    }
  })
})

describe('(r1) default limits: nobody acts here', () => {
  it('(36B) (r1) a good command from alpha: 403 with the control_from text, nothing spawned, one audit line', async () => {
    const before = ccm()
    const mark = auditLines().length
    const r = await fromAlpha()
    expect(r).toEqual({ status: 403, body: { error: NOT_ALPHA } })
    expect(ccm()).toEqual(before)
    const lines = commandLines(mark)
    expect(lines.length).toBe(1)
    expect(lines[0]).toEqual(expect.objectContaining({ event: 'remote.command', from: 'alpha', caller: CALLER, op: 'open', name: 'r1a36b-x', status: 403 }))
  })
})

describe('(r2) control_from = ["alpha"]: alpha opens, types, closes under every local gate', () => {
  it('(36B) (r2) open (shell, the work folder): 200 and the session exists', async () => {
    setLimits({ control_from: ['alpha'] })
    const r = await fromAlpha({ args: { engine: 'shell', name: 'r1a36b-r2', cwd: WORK } })
    expect(r.status).toBe(200)
    expect(ccm()).toContain('ccm-r1a36b-r2')
  })

  it('(36B) (r2) send text: the input gate gives alpha what it gives a local agent (no text in the audit line)', async () => {
    setLimits({ control_from: ['alpha'] })
    const mark = auditLines().length
    const r: Json = await fromAlpha({ op: 'send', args: { name: 'r1a36b-r2', text: 'true' } })
    const local: Json = await route({ method: 'POST', path: '/sessions/r1a36b-r2/send', query: new URLSearchParams(), body: { text: 'true' }, from: 'agent' })
    process.stderr.write(`(36B) (r2) remote send verdict: ${r.body?.status === 'held' ? 'held' : 'typed'} (status ${r.status}, state ${r.body?.state})\n`)
    expect(r.status).toBe(local.status)
    expect([r.body?.status === 'held', r.body?.state, r.body?.error]).toEqual([local.body?.status === 'held', local.body?.state, local.body?.error])
    const lines = commandLines(mark)
    expect(lines.map((l) => [l.op, l.name, l.status])).toEqual([['send', 'r1a36b-r2', r.status]])
    expect(JSON.stringify(lines)).not.toContain('"true"')
  })

  it('(36B) (r2) close: 200 and gone', async () => {
    setLimits({ control_from: ['alpha'] })
    const r: Json = await fromAlpha({ op: 'close', args: { name: 'r1a36b-r2' } })
    expect(r.status).toBe(200)
    expect(ccm()).not.toContain('ccm-r1a36b-r2')
  })

  it('(36B) (r2) open with a cwd outside the limits folders: 403 with the limits text', async () => {
    setLimits({ control_from: ['alpha'] })
    const r: Json = await fromAlpha({ args: { engine: 'shell', name: 'r1a36b-out', cwd: OUT } })
    expect(r.status).toBe(403)
    expect(String(r.body.error)).toMatch(/^limits: cwd .* is not inside the limits file's folders/)
    expect(ccm()).not.toContain('ccm-r1a36b-out')
  })

  it('(36B) (r2) with the kill switch on: 423', async () => {
    setLimits({ control_from: ['alpha'] })
    writeFileSync(join(TH, 'kill-switch'), 'on (36B)\n', { mode: 0o600 })
    const r: Json = await fromAlpha({ args: { engine: 'shell', name: 'r1a36b-ks', cwd: WORK } })
    expect(r).toEqual({ status: 423, body: { error: KILL_SWITCH_ON } })
    expect(ccm()).not.toContain('ccm-r1a36b-ks')
  })

  it('(36B) (r2) with session_cap reached: 429', async () => {
    setLimits({ control_from: ['alpha'] })
    expect((await fromAlpha({ args: { engine: 'shell', name: 'r1a36b-cap1', cwd: WORK } })).status).toBe(200)
    setLimits({ control_from: ['alpha'], session_cap: 1 })
    const r: Json = await fromAlpha({ args: { engine: 'shell', name: 'r1a36b-cap2', cwd: WORK } })
    expect(r.status).toBe(429)
    expect(String(r.body.error)).toMatch(/^limits: session_cap 1 reached/)
    expect(ccm()).not.toContain('ccm-r1a36b-cap2')
    setLimits({ control_from: ['alpha'] })
    expect((await fromAlpha({ op: 'close', args: { name: 'r1a36b-cap1' } })).status).toBe(200)
  })
})

describe('(r3) refusals: the signature and the shape decide, never the carrier', () => {
  beforeEach(() => setLimits({ control_from: ['alpha'] }))

  it('(36B) (r3) body {} or an extra key: 400 command_invalid', async () => {
    expect(await handleRemoteCommand({}, { now })).toEqual({ status: 400, body: { error: 'command_invalid' } })
    expect(await handleRemoteCommand({ envelope: seal(A, 'alpha', 'beta', cmd()), from: 'alpha' }, { now })).toEqual({ status: 400, body: { error: 'command_invalid' } })
    expect(ccm()).not.toContain('ccm-r1a36b-x')
  })

  it('(36B) (r3) an envelope from gamma (not in beta\'s roster): 401 unknown_sender', async () => {
    expect(await run(seal(G, 'gamma', 'beta', cmd()))).toEqual({ status: 401, body: { error: 'envelope', reason: 'unknown_sender' } })
  })

  it('(36B) (r3) signed by gamma claiming alpha: 401 signature', async () => {
    expect(await run(seal(G, 'alpha', 'beta', cmd()))).toEqual({ status: 401, body: { error: 'envelope', reason: 'signature' } })
    expect(ccm()).not.toContain('ccm-r1a36b-x')
  })

  it('(36B) (r3) addressed to gamma: 401 to', async () => {
    expect(await run(seal(A, 'alpha', 'gamma', cmd()))).toEqual({ status: 401, body: { error: 'envelope', reason: 'to' } })
  })

  it('(36B) (r3) 301 s old: 401 time', async () => {
    expect(await run(seal(A, 'alpha', 'beta', cmd(), clock - 301_000))).toEqual({ status: 401, body: { error: 'envelope', reason: 'time' } })
  })

  it('(36B) (r3) the same envelope twice: the first runs, the second 401 replay and runs nothing', async () => {
    const e = seal(A, 'alpha', 'beta', cmd({ args: { engine: 'shell', name: 'r1a36b-once', cwd: WORK } }))
    expect((await run(e)).status).toBe(200)
    expect(ccm().filter((n) => n === 'ccm-r1a36b-once').length).toBe(1)
    const mark = auditLines().filter((l) => l.route === 'POST /sessions/open').length
    expect(await run(e)).toEqual({ status: 401, body: { error: 'envelope', reason: 'replay' } })
    expect(auditLines().filter((l) => l.route === 'POST /sessions/open').length).toBe(mark)
    expect((await fromAlpha({ op: 'close', args: { name: 'r1a36b-once' } })).status).toBe(200)
  })

  it('(36B) (r3) op relay, an extra arg key, caller owner, a missing key or a bidi character: 400 command_invalid', async () => {
    const bad = [
      { op: 'relay' },
      { args: { engine: 'shell', name: 'r1a36b-x', cwd: WORK, model: 'x' } },
      { caller: 'owner' },
      { op: 'send', args: { name: 'r1a36b-x' } },
      { op: 'send', args: { name: 'r1a36b-x', text: 'a‮b' } },
      { op: 'close', args: { name: 'r1a36b-x', text: 'x' } },
      { v: 2 },
      { kind: 'mail' },
    ]
    for (const over of bad) expect([over, await fromAlpha(over)]).toEqual([over, { status: 400, body: { error: 'command_invalid' } }])
    expect(ccm()).not.toContain('ccm-r1a36b-x')
  })

  it('(36B) (r3) through the hub frame: POST /remote/command is handled here, its tandem-command-from header decides nothing; GET is 404', async () => {
    const frame = (method: string, body: unknown) => ({
      type: 'tunnel_http_request', request_id: 'r1a36b', method, path: '/remote/command',
      headers: { 'tandem-command-from': ['alpha'] }, body_base64: Buffer.from(JSON.stringify(body)).toString('base64'),
    }) as Json
    const answerOf = (f: Json) => ({ status: f.status_code, body: JSON.parse(Buffer.from(f.body_base64, 'base64').toString('utf8')) })
    expect(answerOf(await handleHubRequest(frame('POST', { envelope: seal(G, 'gamma', 'beta', cmd()) })))).toEqual({ status: 401, body: { error: 'envelope', reason: 'unknown_sender' } })
    expect(answerOf(await handleHubRequest(frame('POST', {})))).toEqual({ status: 400, body: { error: 'command_invalid' } })
    expect(answerOf(await handleHubRequest(frame('GET', {}))).status).toBe(404)
    expect(ccm()).not.toContain('ccm-r1a36b-x')
  })
})

describe('(r4) Ask from another computer needs control_from', () => {
  const ask = () => ({
    id: `mail-${crypto.randomUUID()}`, from: 'machine:alpha/session:x', to: 'bob', level: 'ask' as const, text: 'r1a36b ask', sentAt: clock, replyBy: clock + 600_000,
  })
  const refusal = (fn: () => unknown) => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof MailError) return { status: e.status, message: e.message }
      throw e
    }
  }

  it('(36B) (r4) default limits: the 33B-2 403 text, nothing stored', () => {
    const box = openMailbox({ path: join(BOX, 'mail-r4a', 'state.db'), now })
    expect(refusal(() => box.receive(ask()))).toEqual({ status: 403, message: ASK_REFUSED })
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    box.close()
  })

  it('(36B) (r4) control_from = ["alpha"]: stored from machine:alpha/session:x', () => {
    setLimits({ control_from: ['alpha'] })
    const box = openMailbox({ path: join(BOX, 'mail-r4b', 'state.db'), now })
    expect(box.receive(ask())).toBe('stored')
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 1, interrupt: 0 })
    expect(box.read('bob', 10).map((m) => [m.from, m.level])).toEqual([['machine:alpha/session:x', 'ask']])
    box.close()
  })

  it('(36B) (r4) control_from = ["gamma"] does not let alpha\'s Ask in', () => {
    setLimits({ control_from: ['gamma'] })
    const box = openMailbox({ path: join(BOX, 'mail-r4c', 'state.db'), now })
    expect(refusal(() => box.receive(ask()))).toEqual({ status: 403, message: ASK_REFUSED })
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    box.close()
  })
})

describe('(r5) A side: sendRemoteCommand and the agent\'s tools', () => {
  const cfg = () => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN, bridgeId: 'alpha' })
  const input = { to: 'beta', op: 'open' as const, args: { engine: 'shell', name: 'r1a36b-a', cwd: WORK }, caller: CALLER }

  it('(36B) (r5) the POST is {to, envelope} with the bearer and alpha\'s proof; the envelope opens under alpha\'s key for beta with the exact body', async () => {
    seen.length = 0
    answer = { status: 200, body: { ok: true, name: 'r1a36b-a' } }
    const r = await sendRemoteCommand(cfg(), input, { key: A, now })
    expect(r).toEqual({ status: 200, body: { ok: true, name: 'r1a36b-a' } })
    expect(seen.length).toBe(1)
    expect(seen[0].path).toBe('/__tunnel/command')
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    const proof = parseProof(seen[0].headers['tandem-proof'] as string)
    expect([proof?.id, proof?.key]).toEqual(['alpha', A.publicKey])
    expect(await verifyProof(proof!, { host: `127.0.0.1:${port}`, method: 'POST', path: '/__tunnel/command', bodySha256: createHash('sha256').update(seen[0].body).digest('hex') })).toBe(true)
    const sent = JSON.parse(seen[0].body)
    expect(Object.keys(sent).sort()).toEqual(['envelope', 'to'])
    expect(sent.to).toBe('beta')
    const opened = openEnvelope(sent.envelope, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock })
    expect(JSON.parse(opened.body)).toEqual({ v: 1, kind: 'command', op: 'open', args: { engine: 'shell', name: 'r1a36b-a', cwd: WORK }, caller: CALLER })
    expect(Object.keys(JSON.parse(opened.body))).toEqual(['v', 'kind', 'op', 'args', 'caller'])
  })

  it('(36B) (r5) the hub\'s status and body come back as they are (403 not_in_roster)', async () => {
    answer = { status: 403, body: { error: 'not_in_roster' } }
    expect(await sendRemoteCommand(cfg(), input, { key: A, now })).toEqual({ status: 403, body: { error: 'not_in_roster' } })
    answer = { status: 200, body: { ok: true, name: 'r1a36b-remote' } }
  })

  it('(36B) (r5) a dead hub: 503 hub unreachable', async () => {
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as { port: number }).port
    await new Promise((resolve) => dead.close(resolve))
    const r = await sendRemoteCommand({ url: `ws://127.0.0.1:${deadPort}`, token: TOKEN, bridgeId: 'alpha' }, input, { key: A, now })
    expect(r).toEqual({ status: 503, body: { error: 'hub unreachable' } })
  })

  describe('the tool path: an agent\'s stdio server on alpha', () => {
    let withHub: Child
    let noHub: Child
    beforeAll(async () => {
      const opened = await route({ method: 'POST', path: '/sessions/open', query: new URLSearchParams(), body: { engine: 'shell', name: AGENT, cwd: WORK } })
      if (opened.status !== 200) throw new Error(`open ${AGENT}: ${opened.status}`)
      // A fresh token for the agent's session (replaces the one its spawn minted); kept in memory only.
      const token = tokens.mintCallerToken(AGENT)
      withHub = await startChild({ TANDEM_CALLER_TOKEN: token, TANDEM_HUB_LINK_URL: `ws://127.0.0.1:${port}`, TANDEM_HUB_LINK_TOKEN: TOKEN, TANDEM_HUB_LINK_ID: 'alpha' })
      noHub = await startChild({ TANDEM_CALLER_TOKEN: token, TANDEM_HUB_LINK_ID: 'alpha' })
    })

    it('(36B) (r5) open_session device "beta" reaches the fake hub as one signed command; the tool answer is the remote body', async () => {
      seen.length = 0
      answer = { status: 200, body: { ok: true, name: 'r1a36b-remote' } }
      const r = await withHub.call('open_session', { engine: 'shell', name: 'r1a36b-remote', cwd: '/srv/work', device: 'beta' })
      expect(r).toEqual({ ok: true, name: 'r1a36b-remote' })
      expect(seen.map((s) => s.path)).toEqual(['/__tunnel/command'])
      const sent = JSON.parse(seen[0].body)
      expect(sent.to).toBe('beta')
      const e = JSON.parse(sent.envelope)
      expect([e.from, e.to]).toEqual(['alpha', 'beta'])
      expect(JSON.parse(e.body)).toEqual({ v: 1, kind: 'command', op: 'open', args: { engine: 'shell', name: 'r1a36b-remote', cwd: '/srv/work' }, caller: CALLER })
    })

    it('(36B) (r5) send_to_session and close_session to beta:<name> go as send and close commands', async () => {
      seen.length = 0
      answer = { status: 200, body: { ok: true } }
      await withHub.call('send_to_session', { name: 'beta:r1a36b-remote', text: 'hello' })
      await withHub.call('close_session', { name: 'r1a36b-remote', device: 'beta' })
      const bodies = seen.map((s) => JSON.parse(JSON.parse(JSON.parse(s.body).envelope).body))
      expect(bodies.map((b) => [b.op, b.args])).toEqual([['send', { name: 'r1a36b-remote', text: 'hello' }], ['close', { name: 'r1a36b-remote' }]])
    })

    it('(36B) (r5) interrupt_session device "beta": the exact interrupt 403 and no call reaches the fake hub', async () => {
      seen.length = 0
      expect(await withHub.call('interrupt_session', { name: 'r1a36b-remote', device: 'beta' })).toEqual({ error: INTERRUPT_REFUSED })
      expect(await withHub.call('interrupt_session', { name: 'beta:r1a36b-remote' })).toEqual({ error: INTERRUPT_REFUSED })
      expect(seen.length).toBe(0)
    })

    it('(36B) (r5) list_sessions device "beta" and device "alpha" (this computer) keep the 36A refusal; nothing reaches the hub', async () => {
      seen.length = 0
      expect((await withHub.call('list_sessions', { device: 'beta' })).error).toBe(DEVICE_REFUSED)
      expect((await withHub.call('open_session', { engine: 'shell', device: 'alpha' })).error).toBe(DEVICE_REFUSED)
      expect(seen.length).toBe(0)
    })

    it('(36B) (r5) the same child with no hub URL: the 36A refusal text, nothing sent', async () => {
      seen.length = 0
      expect((await noHub.call('open_session', { engine: 'shell', device: 'beta' })).error).toBe(DEVICE_REFUSED)
      expect((await noHub.call('send_to_session', { name: 'beta:x', text: 'hi' })).error).toBe(DEVICE_REFUSED)
      expect((await noHub.call('close_session', { name: 'beta:x' })).error).toBe(DEVICE_REFUSED)
      expect(seen.length).toBe(0)
    })
  })
})
