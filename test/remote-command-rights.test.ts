/**
 * U-R1A-36E: a command from another computer needs the right for what it does, read from this
 * computer's applied limits file (bridge/limits.ts rightsOf): `open`, `send`, `close`, `read` (a
 * poll, send with empty text) and `ask` (remote Ask mail), each granted by `control_from` or by its
 * own list `control_from_<right>`. Commands are signed under their own tag, `tandem-command-v1`,
 * and live 60 s (60 s of skew); a remote read is refused while the kill switch is on; `status`
 * answers the sender's own receipt by command id, and the A side asks it once after a lost answer;
 * a device key that cannot be opened is 500, not `hub unreachable`.
 *
 * This computer is beta (TANDEM_HUB_LINK_ID) with a roster of root, alpha and beta; gamma's key
 * exists but gamma is not in the roster. Every folder is under one mkdtemp folder named r1a36e- in
 * TMPDIR: TANDEM_HOME (roster, limits file, state.db, Tandem's tmux socket), HOME (the audit log),
 * the keys, the work folder. TMUX is deleted before the dynamic imports. afterAll ends every tmux
 * server whose socket is in that folder, then removes it. Sessions are the pinned shell harness
 * file only. The A side runs against an in-process node:http fake hub that hands each envelope to
 * handleRemoteCommand in this process (this process is beta) and counts the POSTs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a36e-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a36e: temp folder is under the real home')
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
delete process.env.TANDEM_CALLER_TOKEN
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
for (const d of [HOME, WORK]) mkdirSync(d, { mode: 0o700 })
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
const { signEnvelope, openEnvelope, openReplayStore, EnvelopeError } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { handleRemoteCommand, sendRemoteCommand } = await import('../bridge/remote-command.ts')
const { route } = await import('../bridge/router.ts')
const { openMailbox, MailError } = await import('../bridge/mailbox.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const { KILL_SWITCH_ON } = await import('../bridge/kill-switch.ts')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SOCK = join(TH, 'tmux', 'tandem')
const AUDIT = join(HOME, '.tandem', 'bridge.log')
const CALLER = 'session:r1a36e-agent'
const NOT = (id: string) => `control_from: ${id} may not act on this computer (limits file)`
const NO_OPEN = 'control_from_open: alpha may not open sessions here (limits file)'
const NO_SEND = 'control_from_send: alpha may not type into sessions here (limits file)'
const NO_CLOSE = 'control_from_close: alpha may not close sessions here (limits file)'
const NO_READ = 'control_from_read: alpha may not read sessions here (limits file)'
const ASK_REFUSED = 'control_from: alpha may not send Ask here (limits file); nothing was saved'
const NO_RECEIPT = 'command_status: no receipt for that id'
const LISTS = ['control_from_open', 'control_from_send', 'control_from_close', 'control_from_read', 'control_from_ask'] as const
const ALL = ['open', 'send', 'close', 'read', 'ask']
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
void G

let clock = Date.now()
const now = () => clock

let BASE_LIMITS: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE_LIMITS, ...extra })
  limits.applyLimits()
}
const rightsOf = (id: string): string[] => (limits as Json).rightsOf(id)

/** A command body; `over` replaces or adds fields. */
const cmd = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'command', op: 'open', args: { engine: 'shell', name: 'r1a36e-x', cwd: WORK }, caller: CALLER, ...over })
const seal = (k: Json, from: string, to: string, body: string, ts = clock, kind: Json = 'command') =>
  JSON.stringify((signEnvelope as Json)(k, { from, to, body }, ts, kind))
const run = (envelope: string) => handleRemoteCommand({ envelope }, { now })
const fromAlpha = (over: Json = {}) => run(seal(A, 'alpha', 'beta', cmd(over)))
const nonceOf = (envelope: string): string => JSON.parse(envelope).nonce
const statusBy = (k: Json, from: string, id: string, args: Json = { id }) => run(seal(k, from, 'beta', cmd({ op: 'status', args })))
const used = (from: string, envelope: string) => {
  const store = openReplayStore({ now })
  try {
    return store.has(from, nonceOf(envelope))
  } finally {
    store.close()
  }
}
const ownerOpen = async (name: string) => {
  const r = await route({ method: 'POST', path: '/sessions/open', query: new URLSearchParams(), body: { engine: 'shell', name, cwd: WORK } })
  if (r.status !== 200) throw new Error(`open ${name}: ${r.status} ${JSON.stringify(r.body)}`)
}
const ownerClose = (name: string) => route({ method: 'POST', path: `/sessions/${name}/close`, query: new URLSearchParams(), body: {} })

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

/* ---- the fake hub (A side): each POST is handed to `act` with its envelope and its number ---- */
let posts = 0
type Act = (envelope: string, n: number, res: ServerResponse) => Promise<void>
let act: Act = async (_e, _n, res) => reply(res, 200, { ok: true })
let server: Server
let port = 0
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
/** The fake hub passes the envelope to beta (this process) and answers what beta answered. */
const pass: Act = async (e, _n, res) => {
  const r = await run(e)
  reply(res, r.status, r.body)
}
const cfg = () => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN, bridgeId: 'alpha' })

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  if (!sh) throw new Error('the shell harness file did not load')
  BASE_LIMITS = { folders: [WORK], shell: true, agents: { shell: agentEntry(sh) } }
  setLimits()
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      posts += 1
      const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { envelope: string }
      act(sent.envelope, posts, res).catch(() => res.destroy())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve))
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

beforeEach(() => {
  clock = Date.now()
  rmSync(join(TH, 'kill-switch'), { force: true })
  setLimits()
})

describe('(g1) the per-right lists in the limits file', () => {
  it.each(LISTS.map((f, i) => [f, ALL[i]]))('(36E) (g1) %s = ["alpha"] alone: alpha holds exactly %s', (field, right) => {
    setLimits({ [field]: ['alpha'] })
    expect(limits.limitsSnapshot().problem).toBeUndefined()
    expect(rightsOf('alpha')).toEqual([right])
    expect(rightsOf('root')).toEqual([])
  })

  it.each(LISTS.map((f) => [f]))('(36E) (g1) %s: "alpha", ["Alpha"], ["alpha","alpha"] and [1] refuse the whole file', (field) => {
    for (const bad of ['alpha', ['Alpha'], ['alpha', 'alpha'], [1]]) {
      setLimits({ control_from: ['alpha'], [field]: bad })
      expect([bad, limits.limitsSnapshot().problem]).toEqual([bad, `${join(TH, 'limits.toml')}: wrong type for ${field}: expected an array of computer ids`])
      expect(rightsOf('alpha')).toEqual([])
      expect(limits.limitsSnapshot().folders).toEqual([])
    }
  })

  it('(36E) (g1) control_from = ["alpha"] alone grants all five', () => {
    setLimits({ control_from: ['alpha'] })
    expect(rightsOf('alpha')).toEqual(ALL)
  })

  it('(36E) (g1) control_from = ["root"] with control_from_send = ["alpha"]: alpha send only, root all five', () => {
    setLimits({ control_from: ['root'], control_from_send: ['alpha'] })
    expect(rightsOf('alpha')).toEqual(['send'])
    expect(rightsOf('root')).toEqual(ALL)
  })

  it('(36E) (g1) control_from_open = [] with control_from = ["alpha"]: an empty list takes nothing away', () => {
    setLimits({ control_from: ['alpha'], control_from_open: [] })
    expect(rightsOf('alpha')).toEqual(ALL)
  })

  it('(36E) (g1) the snapshot keeps its listed keys; the five are readable on it, in limitsOnDisk().fields and in INIT_DEFAULTS', () => {
    setLimits({ control_from_read: ['alpha'] })
    const snap = limits.limitsSnapshot() as Json
    expect(Object.keys(snap).sort()).toEqual(['agents', 'digest', 'folders', 'permission_skip', 'shell'])
    for (const f of LISTS) expect([f, Array.isArray(snap[f])]).toEqual([f, true])
    expect(snap.control_from_read).toEqual(['alpha'])
    const fields = limits.limitsOnDisk().fields as Json
    for (const f of LISTS) expect([f, fields[f]]).toEqual([f, f === 'control_from_read' ? ['alpha'] : []])
    for (const f of LISTS) expect([f, (limits.INIT_DEFAULTS as Json)[f]]).toEqual([f, []])
    for (const f of LISTS) expect(limits.FIELDS).toContain(f)
  })
})

describe('(g1b) each op needs its own right', () => {
  it('(36E) (g1b) only control_from_open: open 200; send text, poll and close 403 with their texts; no nonce used', async () => {
    setLimits({ control_from_open: ['alpha'] })
    const opened = await fromAlpha({ args: { engine: 'shell', name: 'r1a36e-g1b', cwd: WORK } })
    expect(opened.status).toBe(200)
    expect(ccm()).toContain('ccm-r1a36e-g1b')
    const mark = auditLines().length
    const typed = seal(A, 'alpha', 'beta', cmd({ op: 'send', args: { name: 'r1a36e-g1b', text: 'true' } }))
    expect(await run(typed)).toEqual({ status: 403, body: { error: NO_SEND } })
    expect(used('alpha', typed)).toBe(false)
    expect(auditLines().slice(mark).filter((l) => l.route === 'POST /sessions/:name/send' && l.name === 'r1a36e-g1b')).toEqual([])
    const poll = await fromAlpha({ op: 'send', args: { name: 'r1a36e-g1b', text: '' } })
    expect(poll).toEqual({ status: 403, body: { error: NO_READ } })
    expect(Object.keys(poll.body as Json)).toEqual(['error'])
    expect(await fromAlpha({ op: 'close', args: { name: 'r1a36e-g1b' } })).toEqual({ status: 403, body: { error: NO_CLOSE } })
    expect(ccm()).toContain('ccm-r1a36e-g1b')
    setLimits({ control_from_open: ['alpha'], control_from_close: ['alpha'] })
    expect((await fromAlpha({ op: 'close', args: { name: 'r1a36e-g1b' } })).status).toBe(200)
    expect(ccm()).not.toContain('ccm-r1a36e-g1b')
  })

  it('(36E) (g1b) only control_from_read: the poll answers the screen; send text is 403; open 403', async () => {
    await ownerOpen('r1a36e-g1r')
    try {
      setLimits({ control_from_read: ['alpha'] })
      const poll: Json = await fromAlpha({ op: 'send', args: { name: 'r1a36e-g1r', text: '' } })
      expect([poll.status, poll.body.live, typeof poll.body.text]).toEqual([200, true, 'string'])
      expect(await fromAlpha({ op: 'send', args: { name: 'r1a36e-g1r', text: 'true' } })).toEqual({ status: 403, body: { error: NO_SEND } })
      expect(await fromAlpha({ args: { engine: 'shell', name: 'r1a36e-g1r2', cwd: WORK } })).toEqual({ status: 403, body: { error: NO_OPEN } })
      expect(ccm()).not.toContain('ccm-r1a36e-g1r2')
    } finally {
      await ownerClose('r1a36e-g1r')
    }
  })

  it('(36E) (g1b) only control_from = ["root"]: alpha gets the BASE text for every op', async () => {
    setLimits({ control_from: ['root'] })
    for (const over of [{}, { op: 'send', args: { name: 'r1a36e-x', text: 'hi' } }, { op: 'send', args: { name: 'r1a36e-x', text: '' } }, { op: 'close', args: { name: 'r1a36e-x' } }]) {
      expect(await fromAlpha(over)).toEqual({ status: 403, body: { error: NOT('alpha') } })
    }
  })

  it('(36E) (g1b) only control_from_send: a poll needs read, not send', async () => {
    setLimits({ control_from_send: ['alpha'] })
    expect(await fromAlpha({ op: 'send', args: { name: 'r1a36e-x', text: '' } })).toEqual({ status: 403, body: { error: NO_READ } })
    setLimits({ control_from_open: ['alpha'], control_from_close: ['alpha'] })
    expect(await fromAlpha({ op: 'send', args: { name: 'r1a36e-x', text: '' } })).toEqual({ status: 403, body: { error: NO_READ } })
  })
})

describe('(g1c) remote Ask needs the ask right', () => {
  const ask = () => ({
    id: `mail-${crypto.randomUUID()}`, from: 'machine:alpha/session:x', to: 'bob', level: 'ask' as const, text: 'r1a36e ask', sentAt: clock, replyBy: clock + 600_000,
  })
  const refusal = (fn: () => unknown) => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof MailError) return { status: e.status, message: e.message }
      throw e
    }
  }

  it('(36E) (g1c) only control_from_ask = ["alpha"]: stored', () => {
    setLimits({ control_from_ask: ['alpha'] })
    const box = openMailbox({ path: join(BOX, 'mail-g1c-a', 'state.db'), now })
    expect(box.receive(ask())).toBe('stored')
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 1, interrupt: 0 })
    box.close()
  })

  it('(36E) (g1c) only control_from_open = ["alpha"]: the BASE Ask text, nothing stored', () => {
    setLimits({ control_from_open: ['alpha'] })
    const box = openMailbox({ path: join(BOX, 'mail-g1c-b', 'state.db'), now })
    expect(refusal(() => box.receive(ask()))).toEqual({ status: 403, message: ASK_REFUSED })
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    box.close()
  })

  it('(36E) (g1c) control_from = ["alpha"]: stored', () => {
    setLimits({ control_from: ['alpha'] })
    const box = openMailbox({ path: join(BOX, 'mail-g1c-c', 'state.db'), now })
    expect(box.receive(ask())).toBe('stored')
    box.close()
  })
})

describe('(g1e) the applied copy decides', () => {
  it('(36E) (g1e) a per-right list written to limits.toml but not applied grants nothing; after commitLimits it does', async () => {
    const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
    await ownerOpen('r1a36e-g1e')
    try {
      const file = writeLimits(TH, { ...BASE_LIMITS, control_from_open: ['alpha'] })
      expect(limits.commitLimits(sha(file))).toBeUndefined()
      expect(existsSync(limits.appliedFile())).toBe(true)
      writeLimits(TH, { ...BASE_LIMITS, control_from_open: ['alpha'], control_from_send: ['alpha'] })
      expect(await fromAlpha({ op: 'send', args: { name: 'r1a36e-g1e', text: 'true' } })).toEqual({ status: 403, body: { error: NO_SEND } })
      expect(limits.commitLimits(sha(file))).toBeUndefined()
      expect((await fromAlpha({ op: 'send', args: { name: 'r1a36e-g1e', text: 'true' } })).status).toBe(200)
    } finally {
      rmSync(limits.appliedFile(), { force: true })
      limits.applyLimits()
      await ownerClose('r1a36e-g1e')
    }
  })
})

describe('(g2) commands are signed under their own tag', () => {
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const byHand = (tag: string) => {
    const head = { from: 'alpha', to: 'beta', nonce: randomBytes(16).toString('base64url'), ts: clock, body_sha256: sha256('r1a36e') }
    const sig = A.sign(`${tag}\n${head.from}\n${head.to}\n${head.nonce}\n${head.ts}\n${head.body_sha256}`)
    return JSON.stringify({ v: 1, ...head, sig, body: 'r1a36e' })
  }
  const opens = (e: string, kind?: string) => {
    try {
      openEnvelope(e, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock, ...(kind === undefined ? {} : { kind: kind as Json }) })
      return 'opens'
    } catch (e) {
      return e instanceof EnvelopeError ? e.reason : String(e)
    }
  }

  it('(36E) (g2) a command under the mail tag or the presence tag: 401 signature, nothing run, no nonce used', async () => {
    setLimits({ control_from: ['alpha'] })
    for (const kind of [undefined, 'mail', 'presence']) {
      const body = cmd({ args: { engine: 'shell', name: 'r1a36e-g2', cwd: WORK } })
      // kind omitted: signEnvelope's own default (seal's default is the command tag).
      const e = kind === undefined ? JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body }, clock)) : seal(A, 'alpha', 'beta', body, clock, kind)
      expect([kind, await run(e)]).toEqual([kind, { status: 401, body: { error: 'envelope', reason: 'signature' } }])
      expect(used('alpha', e)).toBe(false)
    }
    expect(ccm()).not.toContain('ccm-r1a36e-g2')
  })

  it('(36E) (g2) a command-tagged envelope does not open as mail (the mail carrier and presence reader pass no kind)', () => {
    const e = seal(A, 'alpha', 'beta', cmd())
    expect(opens(e)).toBe('signature')
    expect(opens(e, 'mail')).toBe('signature')
    expect(opens(e, 'presence')).toBe('signature')
    expect(opens(e, 'command')).toBe('opens')
  })

  it('(36E) (g2) an unknown kind is a RangeError on sign and on open', () => {
    expect(() => (signEnvelope as Json)(A, { from: 'alpha', to: 'beta', body: 'x' }, clock, 'x')).toThrow(RangeError)
    expect(() => (signEnvelope as Json)(A, { from: 'alpha', to: 'beta', body: 'x' }, clock, 'x')).toThrow('kind must be mail, command or presence')
    const e = seal(A, 'alpha', 'beta', cmd(), clock, 'mail')
    expect(() => openEnvelope(e, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock, kind: 'x' } as Json)).toThrow('kind must be mail, command or presence')
  })

  it('(36E) (g2) fixed bytes: each tag opens only under its own kind; mail is the default', () => {
    const mail = byHand('tandem-envelope-v1')
    expect([opens(mail), opens(mail, 'mail'), opens(mail, 'command'), opens(mail, 'presence')]).toEqual(['opens', 'opens', 'signature', 'signature'])
    const command = byHand('tandem-command-v1')
    expect([opens(command), opens(command, 'mail'), opens(command, 'command'), opens(command, 'presence')]).toEqual(['signature', 'signature', 'opens', 'signature'])
    const presence = byHand('tandem-presence-v1')
    expect([opens(presence), opens(presence, 'mail'), opens(presence, 'command'), opens(presence, 'presence')]).toEqual(['signature', 'signature', 'signature', 'opens'])
  })
})

describe('(g3) the kill switch stops a remote read', () => {
  it('(36E) (g3) switch on: a remote poll is 423 with no screen, one denied audit line, its receipt done 423; close and status still answer', async () => {
    setLimits({ control_from: ['alpha'] })
    await ownerOpen('r1a36e-g3')
    writeFileSync(join(TH, 'kill-switch'), 'on (36E)\n', { mode: 0o600 })
    const mark = auditLines().length
    const poll = seal(A, 'alpha', 'beta', cmd({ op: 'send', args: { name: 'r1a36e-g3', text: '' } }))
    expect(await run(poll)).toEqual({ status: 423, body: { error: KILL_SWITCH_ON } })
    const lines = auditLines().slice(mark)
    expect(lines.filter((l) => l.route === 'POST /sessions/:name/send' && l.name === 'r1a36e-g3').map((l) => l.denied)).toEqual(['kill-switch'])
    expect(lines.filter((l) => l.event === 'remote.command').map((l) => [l.op, l.name, l.status])).toEqual([['send', 'r1a36e-g3', 423]])
    expect(await statusBy(A, 'alpha', nonceOf(poll))).toEqual({ status: 200, body: { state: 'done', status: 423 } })
    const closed = seal(A, 'alpha', 'beta', cmd({ op: 'close', args: { name: 'r1a36e-g3' } }))
    expect((await run(closed)).status).toBe(200)
    expect(ccm()).not.toContain('ccm-r1a36e-g3')
    expect(await statusBy(A, 'alpha', nonceOf(closed))).toEqual(expect.objectContaining({ status: 200, body: expect.objectContaining({ state: 'done', status: 200 }) }))
  })
})

describe('(g4) a command lives 60 s', () => {
  const closeAt = (ts: number) => run(seal(A, 'alpha', 'beta', cmd({ op: 'close', args: { name: 'r1a36e-none' } }), ts))

  it('(36E) (g4) 61 s old and 61 s ahead: 401 time; 59 s old and 59 s ahead: 200', async () => {
    setLimits({ control_from: ['alpha'] })
    expect(await closeAt(clock - 61_000)).toEqual({ status: 401, body: { error: 'envelope', reason: 'time' } })
    expect((await closeAt(clock - 59_000)).status).toBe(200)
    expect(await closeAt(clock + 61_000)).toEqual({ status: 401, body: { error: 'envelope', reason: 'time' } })
    expect((await closeAt(clock + 59_000)).status).toBe(200)
  })

  it('(36E) (g4) maxSkewMs 0, 300_001 and 1.5 are a RangeError', () => {
    const e = seal(A, 'alpha', 'beta', cmd())
    for (const maxSkewMs of [0, 300_001, 1.5]) {
      expect(() => openEnvelope(e, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock, kind: 'command', maxSkewMs } as Json)).toThrow(
        'maxSkewMs must be a whole number from 1 to 300000',
      )
    }
  })

  it('(36E) (g4) mail keeps its window: 240 s old and 240 s ahead open with the default options', () => {
    for (const ts of [clock - 240_000, clock + 240_000]) {
      const e = JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: 'r1a36e mail' }, ts))
      expect(openEnvelope(e, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock }).ts).toBe(ts)
    }
  })
})

describe('(g5) status at B: the sender\'s own receipt by command id', () => {
  it('(36E) (g5) after a done open: 200 with the open\'s status and body', async () => {
    setLimits({ control_from: ['alpha'] })
    const e = seal(A, 'alpha', 'beta', cmd({ args: { engine: 'shell', name: 'r1a36e-g5', cwd: WORK } }))
    const opened = await run(e)
    expect(opened.status).toBe(200)
    expect(await statusBy(A, 'alpha', nonceOf(e))).toEqual({ status: 200, body: { state: 'done', status: 200, body: JSON.parse(JSON.stringify(opened.body)) } })
  })

  it('(36E) (g5) after a send with text and after a poll: state and status only, no body', async () => {
    setLimits({ control_from: ['alpha'] })
    const typed = seal(A, 'alpha', 'beta', cmd({ op: 'send', args: { name: 'r1a36e-g5', text: 'true' } }))
    const sent = await run(typed)
    const poll = seal(A, 'alpha', 'beta', cmd({ op: 'send', args: { name: 'r1a36e-g5', text: '' } }))
    const read: Json = await run(poll)
    expect(read.status).toBe(200)
    expect(await statusBy(A, 'alpha', nonceOf(typed))).toEqual({ status: 200, body: { state: 'done', status: sent.status } })
    const answer: Json = await statusBy(A, 'alpha', nonceOf(poll))
    expect(answer).toEqual({ status: 200, body: { state: 'done', status: 200 } })
    expect(Object.keys(answer.body)).toEqual(['state', 'status'])
    expect((await fromAlpha({ op: 'close', args: { name: 'r1a36e-g5' } })).status).toBe(200)
  })

  it('(36E) (g5) while an open still runs: 202 received, then 200 done once it settles', async () => {
    setLimits({ control_from: ['alpha'] })
    const e = seal(A, 'alpha', 'beta', cmd({ args: { engine: 'shell', name: 'r1a36e-g5r', cwd: WORK } }))
    const first = run(e)
    expect(await statusBy(A, 'alpha', nonceOf(e))).toEqual({ status: 202, body: { state: 'received' } })
    const opened = await first
    expect(opened.status).toBe(200)
    expect(await statusBy(A, 'alpha', nonceOf(e))).toEqual({ status: 200, body: { state: 'done', status: 200, body: JSON.parse(JSON.stringify(opened.body)) } })
    expect((await fromAlpha({ op: 'close', args: { name: 'r1a36e-g5r' } })).status).toBe(200)
  })

  it('(36E) (g5) an unknown id: 404; root\'s receipt asked by alpha: 404', async () => {
    setLimits({ control_from: ['alpha', 'root'] })
    expect(await statusBy(A, 'alpha', randomBytes(16).toString('base64url'))).toEqual({ status: 404, body: { error: NO_RECEIPT } })
    const byRoot = seal(ROOT, 'root', 'beta', cmd({ op: 'close', args: { name: 'r1a36e-none' } }))
    expect((await run(byRoot)).status).toBe(200)
    expect((await statusBy(ROOT, 'root', nonceOf(byRoot))).status).toBe(200)
    expect(await statusBy(A, 'alpha', nonceOf(byRoot))).toEqual({ status: 404, body: { error: NO_RECEIPT } })
  })

  it('(36E) (g5) any one right asks: only control_from_read asks its own; no right is 403 with the BASE text', async () => {
    setLimits({ control_from: ['alpha'] })
    const e = seal(A, 'alpha', 'beta', cmd({ op: 'close', args: { name: 'r1a36e-none' } }))
    expect((await run(e)).status).toBe(200)
    setLimits({ control_from_read: ['alpha'] })
    expect(await statusBy(A, 'alpha', nonceOf(e))).toEqual(expect.objectContaining({ status: 200, body: expect.objectContaining({ state: 'done', status: 200 }) }))
    setLimits()
    expect(await statusBy(A, 'alpha', nonceOf(e))).toEqual({ status: 403, body: { error: NOT('alpha') } })
  })

  it('(36E) (g5) bad args are 400 command_invalid; the same status envelope twice is 401 replay with no receipt', async () => {
    setLimits({ control_from: ['alpha'] })
    const id = randomBytes(16).toString('base64url')
    for (const args of [{ id: 'short' }, {}, { id, name: 'x' }, { id: `${id.slice(0, 21)}+` }]) {
      expect([args, await statusBy(A, 'alpha', id, args)]).toEqual([args, { status: 400, body: { error: 'command_invalid' } }])
    }
    const mark = auditLines().length
    const asked = seal(A, 'alpha', 'beta', cmd({ op: 'status', args: { id } }))
    expect(await run(asked)).toEqual({ status: 404, body: { error: NO_RECEIPT } })
    expect(used('alpha', asked)).toBe(true)
    const again: Json = await run(asked)
    expect(again).toEqual({ status: 401, body: { error: 'envelope', reason: 'replay' } })
    expect(Object.keys(again.body)).not.toContain('receipt')
    const lines = auditLines().slice(mark).filter((l) => l.event === 'remote.command')
    // The replay is refused while the envelope is opened, before its command is read: that line has no op.
    expect(lines.map((l) => [l.op, l.name, l.status])).toEqual([['status', undefined, 404], [undefined, undefined, 401]])
  })
})

describe('(g5b) status at A: one status call after a lost answer, none after a refusal', () => {
  const open = (name: string) => ({ to: 'beta', op: 'open' as const, args: { engine: 'shell', name, cwd: WORK }, caller: CALLER })
  let ran: { status: number; body: unknown } | undefined
  beforeEach(() => {
    setLimits({ control_from: ['alpha'] })
    posts = 0
    ran = undefined
  })
  /** First POST: run at beta, then `then`; every later POST is passed to beta. */
  const first = (then: (res: ServerResponse) => void): Act => async (e, n, res) => {
    if (n > 1) return pass(e, n, res)
    ran = await run(e)
    then(res)
  }

  it('(36E) (g5b) (i) run, then the socket is cut: one status POST, the run\'s status and body', async () => {
    act = first((res) => res.socket?.destroy())
    const r = await sendRemoteCommand(cfg(), open('r1a36e-g5b1'), { key: A, now })
    expect(posts).toBe(2)
    expect(ran?.status).toBe(200)
    expect(r).toEqual({ status: ran!.status, body: JSON.parse(JSON.stringify(ran!.body)) })
    await ownerClose('r1a36e-g5b1')
  })

  it('(36E) (g5b) (ii) a send with text, then the socket is cut: { status: 200, body: { state: "done" } }', async () => {
    await ownerOpen('r1a36e-g5b2')
    act = first((res) => res.socket?.destroy())
    const r = await sendRemoteCommand(cfg(), { to: 'beta', op: 'send', args: { name: 'r1a36e-g5b2', text: 'true' }, caller: CALLER }, { key: A, now })
    expect(posts).toBe(2)
    expect(r).toEqual({ status: 200, body: { state: 'done' } })
    await ownerClose('r1a36e-g5b2')
  })

  it('(36E) (g5b) (iii) 504 without running: one status POST, B answers 404, A answers the 504', async () => {
    act = async (e, n, res) => (n > 1 ? pass(e, n, res) : reply(res, 504, { error: 'gateway_timeout' }))
    const r = await sendRemoteCommand(cfg(), open('r1a36e-g5b3'), { key: A, now })
    expect(posts).toBe(2)
    expect(r).toEqual({ status: 504, body: { error: 'gateway_timeout' } })
    expect(ccm()).not.toContain('ccm-r1a36e-g5b3')
  })

  it('(36E) (g5b) (iv) run, then 503 bridge_offline (no requested): one status POST, the open\'s answer', async () => {
    act = first((res) => reply(res, 503, { error: 'bridge_offline' }))
    const r = await sendRemoteCommand(cfg(), open('r1a36e-g5b4'), { key: A, now })
    expect(posts).toBe(2)
    expect(ran?.status).toBe(200)
    expect(r).toEqual({ status: 200, body: JSON.parse(JSON.stringify(ran!.body)) })
    await ownerClose('r1a36e-g5b4')
  })

  it('(36E) (g5b) (v) 503 bridge_offline with requested (refused before sending): no status POST', async () => {
    act = async (_e, _n, res) => reply(res, 503, { error: 'bridge_offline', requested: 'beta' })
    expect(await sendRemoteCommand(cfg(), open('r1a36e-g5b5'), { key: A, now })).toEqual({ status: 503, body: { error: 'bridge_offline', requested: 'beta' } })
    expect(posts).toBe(1)
  })

  it('(36E) (g5b) (vi) 429 target_busy: no status POST', async () => {
    act = async (_e, _n, res) => reply(res, 429, { error: 'target_busy', requested: 'beta' })
    expect(await sendRemoteCommand(cfg(), open('r1a36e-g5b6'), { key: A, now })).toEqual({ status: 429, body: { error: 'target_busy', requested: 'beta' } })
    expect(posts).toBe(1)
  })

  it('(36E) (g5b) (vii) a dead hub: 503 hub unreachable', async () => {
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as { port: number }).port
    await new Promise((resolve) => dead.close(resolve))
    const r = await sendRemoteCommand({ url: `ws://127.0.0.1:${deadPort}`, token: TOKEN, bridgeId: 'alpha' }, open('r1a36e-g5b7'), { key: A, now })
    expect(r).toEqual({ status: 503, body: { error: 'hub unreachable' } })
    expect(posts).toBe(0)
  })

  it('(36E) (g5b) (viii) run then cut, alpha in no list for the status call: the first failure', async () => {
    act = first((res) => {
      setLimits()
      res.socket?.destroy()
    })
    const r = await sendRemoteCommand(cfg(), open('r1a36e-g5b8'), { key: A, now })
    expect(posts).toBe(2)
    expect(ran?.status).toBe(200)
    expect(r).toEqual({ status: 503, body: { error: 'hub unreachable' } })
    await ownerClose('r1a36e-g5b8')
  })
})

describe('(g9) a device key that cannot be opened', () => {
  it('(36E) (g9) <TANDEM_HOME>/keys a symlink: 500 device key unavailable, nothing sent to the hub', async () => {
    const link = join(TH, 'keys')
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
    const elsewhere = join(BOX, 'keys-elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    symlinkSync(elsewhere, link)
    try {
      posts = 0
      act = pass
      const r = await sendRemoteCommand(cfg(), { to: 'beta', op: 'close', args: { name: 'r1a36e-none' }, caller: CALLER }, { now })
      expect(r).toEqual({ status: 500, body: { error: 'device key unavailable on this computer' } })
      expect(posts).toBe(0)
    } finally {
      rmSync(link, { force: true })
    }
  })
})
