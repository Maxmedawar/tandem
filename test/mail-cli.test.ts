/**
 * U-R1A-41: `tandem mail send`, `inbox` and `ls` (bridge/mail-cli.ts) do what `fleetbus send`,
 * `inbox` and `ls` do. The CLI never opens state.db: it asks the running runtime over its control
 * socket (bridge/control-socket.ts ops mail_send, mail_read, who), and the runtime answers with its
 * own mailbox and presence (runtimeMail, wired by src/server.ts). Who asks is worked out by the
 * runtime from the facts the request carries (caller token, pid ancestry), never from a name.
 *
 * The test process plays the runtime, as test/status-cli.test.ts does: its route() opens the
 * sessions (the pinned `sh` of the shell harness file, no agent program), and it serves the control
 * socket with the real mailbox and presence. Every folder is under one mkdtemp folder in TMPDIR
 * named r1a41-: HOME, TANDEM_HOME (Tandem's own tmux socket, state.db, the control socket), the
 * work folders. afterAll ends every tmux server whose socket is in that folder, then removes it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as netServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a41-')))
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
delete process.env.TANDEM_CALLER_TOKEN
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const ONE = join(WORK, 'one')
const TWO = join(WORK, 'two')
for (const d of [HOME, ONE, TWO]) mkdirSync(d, { recursive: true })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.TANDEM_HUB_LINK_ID = 'alpha'
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'

const mail = await import('../bridge/mail-cli.ts')
const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { controlSocketPath, startControlServer } = await import('../bridge/control-socket.ts')
const { runKillSwitchCommand } = await import('../bridge/kill-switch.ts')
const { openMailbox, UNTRUSTED_MAIL } = await import('../bridge/mailbox.ts')
const { createPresence } = await import('../bridge/presence.ts')
const { mintCallerToken } = await import('../bridge/caller-tokens.ts')

vi.setConfig({ testTimeout: 30_000 })

const STATES = ['working', 'idle', 'waiting_for_approval', 'unknown']
const AGE = '(\\d+ s|\\d+ min|\\d+ h|\\d+ d|unknown)'
const USAGE_FIRST = 'usage: tandem mail send <to> <message...> [--level fyi|ask|interrupt] [--json]'
const NAME_LINE = 'usage: tandem mail inbox --name <session> (required for the owner)\n'
/** A raw C0/C1 control, bidi or tag character anywhere but a newline or tab. */
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|[\u{e0000}-\u{e007f}]/u

let BASE_LIMITS: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE_LIMITS, ...extra })
  limits.applyLimits()
}

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })

let box: ReturnType<typeof openMailbox>
let presence: ReturnType<typeof createPresence>
let runtime: { close(): Promise<void> } | undefined
let T1 = ''
let T2 = ''

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  if (!sh) throw new Error('the shell harness file did not load')
  BASE_LIMITS = { folders: [WORK], shell: true, agents: { shell: agentEntry(sh) } }
  setLimits()
  for (const [name, cwd] of [['s1', ONE], ['s2', TWO]]) {
    const res = await rq('POST', '/sessions/open', { engine: 'shell', name, cwd })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }
  // Each session's own token (a new mint replaces the one spawn handed its pane).
  T1 = mintCallerToken('s1', ONE)
  T2 = mintCallerToken('s2', TWO)
  // The runtime, as src/server.ts wires it: its one mailbox and presence behind the control socket.
  box = openMailbox()
  presence = createPresence()
  runtime = await startControlServer({ run: runKillSwitchCommand, mail: mail.runtimeMail({ mailbox: () => box, presence: () => presence }) } as Json)
}, 60_000)

afterAll(async () => {
  await runtime?.close()
  for (const name of ['s1', 's2']) await rq('POST', `/sessions/${name}/close`)
  box?.close()
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

/** Runs main(args) in this process with stdout and stderr captured, as the caller holding `token` (none: the owner). */
async function cli(args: string[], o: { token?: string; maxReply?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  if (o.token === undefined) delete process.env.TANDEM_CALLER_TOKEN
  else process.env.TANDEM_CALLER_TOKEN = o.token
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Json) => { out += String(chunk); return true })
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Json) => { err += String(chunk); return true })
  try {
    const code = await mail.main(args, o.maxReply === undefined ? {} : { maxReply: o.maxReply })
    return { code, out, err }
  } finally {
    so.mockRestore()
    se.mockRestore()
    delete process.env.TANDEM_CALLER_TOKEN
  }
}

/** The texts queued for `name`, from the runtime's own store, without marking anything. */
async function queued(name: string): Promise<string[]> {
  const r = await cli(['inbox', '--name', name, '--peek', '--json'])
  expect(r.code, r.err).toBe(0)
  return JSON.parse(r.out).messages.map((m: Json) => m.text)
}

/** Reads `name`'s inbox until it is empty (as its own session), so each case starts clean. */
async function drain(token: string) {
  for (let i = 0; i < 5; i++) {
    const r = await cli(['inbox', '--json'], { token })
    if (JSON.parse(r.out).messages.length === 0) return
  }
}

describe('U-R1A-41 tandem mail', () => {
  it('(a) owner `send s1 hi`; the s1 session\'s own token reads `inbox`: hi once under the untrusted header; then the inbox is empty', async () => {
    await drain(T1)
    const sent = await cli(['send', 's1', 'hi'])
    expect(sent.err).toBe('')
    expect(sent.code).toBe(0)
    expect(sent.out).toMatch(/^sent mail-[0-9a-f-]{36} to s1 \(queued\)\n$/)

    const read = await cli(['inbox'], { token: T1 })
    expect(read.err).toBe('')
    expect(read.code).toBe(0)
    const lines = read.out.split('\n')
    expect(lines[0]).toBe(UNTRUSTED_MAIL)
    expect(lines[1]).toMatch(/^from owner · fyi · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(lines.filter((l) => l === 'hi')).toHaveLength(1)
    expect(lines.indexOf('hi')).toBeGreaterThan(lines.indexOf(UNTRUSTED_MAIL))
    expect(lines.filter((l) => l === UNTRUSTED_MAIL)).toHaveLength(1)

    const again = await cli(['inbox'], { token: T1 })
    expect([again.code, again.out, again.err]).toEqual([0, '(empty)\n', ''])
    const json = await cli(['inbox', '--json'], { token: T1 })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toEqual({ untrusted: UNTRUSTED_MAIL, messages: [] })

    // The session sends as itself; its own name for --name is allowed; --json send parses.
    const fromS1 = await cli(['send', 's2', 'from s1', '--json'], { token: T1 })
    expect(fromS1.code, fromS1.err).toBe(0)
    expect(JSON.parse(fromS1.out)).toMatchObject({ to: 's2', level: 'fyi', state: 'queued' })
    const s2 = await cli(['inbox', '--name', 's2', '--json'], { token: T2 })
    expect(s2.code, s2.err).toBe(0)
    const got = JSON.parse(s2.out)
    expect(got.untrusted).toBe(UNTRUSTED_MAIL)
    expect(got.messages.map((m: Json) => [m.from, m.text, m.state])).toEqual([['session:s1', 'from s1', 'delivered']])
  })

  it('(b) `--peek` lists without marking: twice the same, then a read takes it once, then peek is empty', async () => {
    await drain(T1)
    expect((await cli(['send', 's1', 'peek-me', '--level', 'ask'])).code).toBe(0)
    const p1 = await cli(['inbox', '--name', 's1', '--peek'])
    const p2 = await cli(['inbox', '--peek'], { token: T1 })
    for (const p of [p1, p2]) {
      expect(p.code, p.err).toBe(0)
      expect(p.out.split('\n')[0]).toBe(UNTRUSTED_MAIL)
      expect(p.out.split('\n')[1]).toMatch(/^from owner · ask · /)
      expect(p.out.split('\n').filter((l) => l === 'peek-me')).toHaveLength(1)
    }
    const peekJson = JSON.parse((await cli(['inbox', '--name', 's1', '--peek', '--json'])).out)
    expect(peekJson.messages.map((m: Json) => [m.text, m.state])).toEqual([['peek-me', 'queued']])
    const read = await cli(['inbox', '--json'], { token: T1 })
    expect(JSON.parse(read.out).messages.map((m: Json) => [m.text, m.state])).toEqual([['peek-me', 'delivered']])
    expect(await queued('s1')).toEqual([])
    expect((await cli(['inbox', '--name', 's1', '--peek'])).out).toBe('(empty)\n')
  })

  it('(c) a session token reading `--name other` is refused own_inbox_only (exit 1); nothing of that inbox is marked', async () => {
    await drain(T2)
    expect((await cli(['send', 's2', 'for s2 only'])).code).toBe(0)
    for (const args of [['inbox', '--name', 's2'], ['inbox', '--name', 's2', '--peek'], ['inbox', '--name', 'nobody']]) {
      const r = await cli(args, { token: T1 })
      expect([r.code, r.out, r.err], args.join(' ')).toEqual([1, '', 'own_inbox_only\n'])
    }
    expect(await queued('s2')).toEqual(['for s2 only'])
    const own = await cli(['inbox', '--name', 's2', '--json'], { token: T2 })
    expect(JSON.parse(own.out).messages.map((m: Json) => m.text)).toEqual(['for s2 only'])
  })

  it('(d) no token, run inside a Tandem session (a tmux session the test runtime started): refused agent_without_token, nothing stored', async () => {
    await drain(T1)
    const out = join(BOX, 'd.out')
    const err = join(BOX, 'd.err')
    const rc = join(BOX, 'd.rc')
    const cmd = `unset TANDEM_CALLER_TOKEN; TANDEM_HOME='${TH}' '${process.execPath}' --experimental-strip-types --no-warnings '${join(repo, 'bridge', 'mail-cli.ts')}' send s1 from-inside > '${out}' 2> '${err}'; echo $? > '${rc}'`
    const typed = await rq('POST', '/sessions/s2/send', { text: cmd })
    expect(typed.status, JSON.stringify(typed.body)).toBe(200)
    const deadline = Date.now() + 20_000
    while (!(existsSync(rc) && readFileSync(rc, 'utf8').trim() !== '') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect([readFileSync(rc, 'utf8').trim(), readFileSync(out, 'utf8'), readFileSync(err, 'utf8')]).toEqual(['1', '', 'agent_without_token\n'])
    expect(await queued('s1')).toEqual([])
  })

  it('(e) a forged token is refused bad_token (exit 1) for send, inbox and ls; nothing stored', async () => {
    await drain(T1)
    const forged = 'A'.repeat(43)
    for (const args of [['send', 's1', 'forged'], ['inbox'], ['inbox', '--name', 's1', '--peek'], ['ls']]) {
      const r = await cli(args, { token: forged })
      expect([r.code, r.out, r.err], args.join(' ')).toEqual([1, '', 'bad_token\n'])
    }
    expect(await queued('s1')).toEqual([])
  })

  it('(f) interrupt_from = []: --level interrupt refused for a session and the owner; ["owner"]: the owner\'s is stored, a session\'s still refused', async () => {
    await drain(T1)
    const denied = (from: string) => `interrupt_from: ${from} may not send Interrupt (limits file); nothing was saved\n`
    try {
      setLimits({ interrupt_from: [] })
      const owner = await cli(['send', 's1', 'stop', '--level', 'interrupt'])
      expect([owner.code, owner.out, owner.err]).toEqual([1, '', denied('owner')])
      const session = await cli(['send', 's1', 'stop', '--level', 'interrupt'], { token: T2 })
      expect([session.code, session.out, session.err]).toEqual([1, '', denied('session:s2')])
      expect(await queued('s1')).toEqual([])

      setLimits({ interrupt_from: ['owner'] })
      const owner2 = await cli(['send', 's1', 'stop now', '--level', 'interrupt'])
      expect(owner2.err).toBe('')
      expect(owner2.code).toBe(0)
      const session2 = await cli(['send', 's1', 'stop', '--level', 'interrupt'], { token: T2 })
      expect([session2.code, session2.out, session2.err]).toEqual([1, '', denied('session:s2')])
      expect(await queued('s1')).toEqual(['stop now'])
    } finally {
      setLimits()
    }
  })

  it('(g) no hub link: `send other-computer:s1 x` is refused exactly as mail_send refuses an unknown computer (exit 1)', async () => {
    let expected = ''
    try {
      box.send({ from: 'owner', to: 'other-computer:s1', level: 'fyi', text: 'x' })
    } catch (e) {
      expected = (e as Error).message
    }
    expect(expected).toBe("to: computer other-computer is not in this computer's roster; nothing was saved")
    const r = await cli(['send', 'other-computer:s1', 'x'])
    expect([r.code, r.out, r.err]).toEqual([1, '', `${expected}\n`])
  })

  it('(h) `ls` lists the test\'s sessions with engine, state and age; `ls --json` parses to the same rows, no folder', async () => {
    const r = await cli(['ls'])
    expect(r.code, r.err).toBe(0)
    const lines = r.out.split('\n').filter(Boolean)
    for (const name of ['s1', 's2']) {
      const line = lines.find((l) => l.startsWith(`alpha:${name}  `))
      expect(line, r.out).toMatch(new RegExp(`^alpha:${name}  shell  (${STATES.join('|')})  ${AGE}$`))
    }
    const j = await cli(['ls', '--json'])
    expect(j.code, j.err).toBe(0)
    const doc = JSON.parse(j.out)
    expect(Object.keys(doc)).toEqual(['sessions'])
    const rows = doc.sessions.filter((s: Json) => s.name === 's1' || s.name === 's2')
    expect(rows.map((s: Json) => [s.computer, s.name, s.engine])).toEqual([['alpha', 's1', 'shell'], ['alpha', 's2', 'shell']])
    for (const s of rows) {
      expect(Object.keys(s)).toEqual(['computer', 'name', 'engine', 'state', 'ageMs'])
      expect(STATES).toContain(s.state)
      expect(typeof s.ageMs).toBe('number')
    }
    for (const p of [ONE, TWO, WORK, TH]) expect(j.out.includes(p) || r.out.includes(p), p).toBe(false)
    // A session token may list too.
    expect((await cli(['ls'], { token: T1 })).code).toBe(0)
  })

  it('(i) runtime not running -> exit 3 `tandem: runtime not running` (no socket, and a dead socket); unknown_command -> exit 3 `tandem: runtime too old for mail`', async () => {
    const empty = mkdtempSync(join(BOX, 'down-'))
    process.env.TANDEM_HOME = empty
    try {
      for (const args of [['send', 's1', 'x'], ['inbox', '--name', 's1'], ['ls']]) {
        const r = await cli(args)
        expect([r.code, r.out, r.err], args.join(' ')).toEqual([3, '', 'tandem: runtime not running\n'])
      }
      // A socket file nobody listens on (its process ended): ECONNREFUSED.
      mkdirSync(join(empty, 'run'), { recursive: true, mode: 0o700 })
      const dead = spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"))', controlSocketPath()])
      expect(dead.signal).toBe('SIGKILL')
      expect(existsSync(controlSocketPath())).toBe(true)
      const refused = await cli(['ls'])
      expect([refused.code, refused.out, refused.err]).toEqual([3, '', 'tandem: runtime not running\n'])
      rmSync(controlSocketPath())

      // An older runtime: a control server without the mail handler.
      const older = await startControlServer({ run: runKillSwitchCommand, socketPath: controlSocketPath() })
      try {
        for (const args of [['send', 's1', 'x'], ['inbox', '--name', 's1'], ['ls']]) {
          const r = await cli(args)
          expect([r.code, r.out, r.err], args.join(' ')).toEqual([3, '', 'tandem: runtime too old for mail\n'])
        }
      } finally {
        await older.close()
      }
      const fake = await fakeSocket(`${JSON.stringify({ ok: false, error: 'unknown_command' })}\n`)
      try {
        const r = await cli(['ls'])
        expect([r.code, r.out, r.err]).toEqual([3, '', 'tandem: runtime too old for mail\n'])
        expect(JSON.parse(fake.lines[0])).toMatchObject({ op: 'who', pid: process.pid })
      } finally {
        await fake.close()
      }
    } finally {
      process.env.TANDEM_HOME = TH
    }
  })

  it('(j) ESC, U+202E or U+E0041 in the text: refused (exit 1, the mailbox\'s line), nothing stored; a presence name that breaks the NAME rule prints `?`', async () => {
    await drain(T1)
    const cases: [string, string][] = [
      ['a\u001b[2Jb', 'text: a control character (only newline and tab are allowed); nothing was saved\n'],
      ['a\u202eb', 'text: a bidi control character; nothing was saved\n'],
      ['a\u{e0041}b', 'text: an invisible tag character; nothing was saved\n'],
    ]
    for (const [text, line] of cases) {
      const r = await cli(['send', 's1', text])
      expect([r.code, r.out, r.err], JSON.stringify(text)).toEqual([1, '', line])
    }
    expect(await queued('s1')).toEqual([])

    // A runtime whose presence holds hostile names (here and on another computer).
    const hostile = {
      names: async () => [],
      whoIsUp: async () => ({
        computer: 'alpha', at: Date.now(), ageMs: 0,
        sessions: [
          { name: 'evil\u001b[2J', engine: 'shell', project: 'p', cwd: '/x', state: 'idle', stateAt: Date.now(), ageMs: 1000 },
          { name: 'ok-name', engine: 'sh\u202eell', project: 'p', cwd: '/x', state: 'idle', stateAt: Date.now(), ageMs: 61_000 },
          { name: 'x\nfake', engine: 'shell', project: 'p', cwd: '/x', state: 'bogus\u0007', stateAt: Date.now(), ageMs: 1000 },
        ],
        others: [{ computer: 'be\u001bta', at: 1, ageMs: 5000, stale: true, more: 0, sessions: [{ name: 'b-one', engine: 'claude', project: 'p', state: 'working', stateAt: 1, ageMs: 5000 }] }],
      }),
    }
    const alt = mkdtempSync(join(BOX, 'alt-'))
    process.env.TANDEM_HOME = alt
    const server = await startControlServer({ run: runKillSwitchCommand, mail: mail.runtimeMail({ mailbox: () => box, presence: () => hostile as Json }) } as Json)
    try {
      const r = await cli(['ls', '--all'])
      expect(r.code, r.err).toBe(0)
      expect(RAW.test(r.out.replace(/\n/g, '')), JSON.stringify(r.out)).toBe(false)
      expect(r.out.split('\n').filter(Boolean)).toEqual([
        'alpha:?  shell  idle  1 s',
        'alpha:ok-name  ?  idle  1 min',
        'alpha:?  shell  unknown  1 s',
        '?:b-one  claude  working  5 s',
      ])
      const local = await cli(['ls'])
      expect(local.out.split('\n').filter(Boolean)).toHaveLength(3)
      const j = await cli(['ls', '--all', '--json'])
      expect(j.code, j.err).toBe(0)
      expect(RAW.test(j.out), JSON.stringify(j.out)).toBe(false)
      expect(JSON.parse(j.out).sessions.map((s: Json) => [s.computer, s.name, s.engine])).toEqual([
        ['alpha', 'evil\u001b[2J', 'shell'], ['alpha', 'ok-name', 'sh\u202eell'], ['alpha', 'x\nfake', 'shell'], ['be\u001bta', 'b-one', 'claude'],
      ])
    } finally {
      await server.close()
      process.env.TANDEM_HOME = TH
    }
  })

  it('(k) a reply over the cap (forced small through main\'s maxReply) -> reply_too_large, exit 1; the message stays queued', async () => {
    await drain(T2)
    expect(mail.MAX_MAIL_REPLY).toBe(1024 * 1024)
    expect((await cli(['send', 's2', 'y'.repeat(300)])).code).toBe(0)
    const r = await cli(['inbox', '--name', 's2', '--peek'], { maxReply: 200 })
    expect([r.code, r.out, r.err]).toEqual([1, '', 'reply_too_large\n'])
    expect(await queued('s2')).toEqual(['y'.repeat(300)])
    await drain(T2)
  })

  it('(l) `tandem mail` with no subcommand, an unknown one, or bad options -> exit 2 with usage; the owner\'s `inbox` without --name -> exit 2 with its line', async () => {
    for (const args of [[], ['bogus'], ['send'], ['send', 's1'], ['send', 's1', 'x', '--level'], ['send', 's1', 'x', '--level', 'loud'], ['inbox', '--limit', 'x'], ['inbox', '--limit', '0'], ['inbox', 'extra'], ['inbox', '--name'], ['ls', 'x'], ['ls', '--bogus']]) {
      const r = await cli(args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(r.out, args.join(' ')).toBe('')
      expect(r.err.split('\n')[0], args.join(' ')).toBe(USAGE_FIRST)
    }
    const owner = await cli(['inbox'])
    expect([owner.code, owner.out, owner.err]).toEqual([2, '', NAME_LINE])
    const peek = await cli(['inbox', '--peek'])
    expect([peek.code, peek.out, peek.err]).toEqual([2, '', NAME_LINE])
  })

  it('(m) packaging/tandem\'s `mail` case dispatches to bridge/mail-cli.ts (a fake runtime folder); help lists mail', async () => {
    await drain(T1)
    const usage = await launcher('mail')
    expect(usage.status).toBe(2)
    expect(usage.stdout).toBe('')
    expect(usage.stderr.split('\n')[0]).toBe(USAGE_FIRST)
    const sent = await launcher('mail', 'send', 's1', 'via launcher')
    expect(sent.status, sent.stderr).toBe(0)
    expect(sent.stdout).toMatch(/^sent mail-[0-9a-f-]{36} to s1 \(queued\)\n$/)
    const ls = await launcher('mail', 'ls', '--json')
    expect(ls.status, ls.stderr).toBe(0)
    expect(JSON.parse(ls.stdout).sessions.map((s: Json) => s.name)).toEqual(expect.arrayContaining(['s1', 's2']))
    const peek = await launcher('mail', 'inbox', '--name', 's1', '--peek')
    expect(peek.status, peek.stderr).toBe(0)
    expect(peek.stdout.split('\n')).toContain('via launcher')
    const help = await launcher('help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('tandem mail send <to> <message...>')
    expect(help.stdout).toContain('tandem mail inbox')
    expect(help.stdout).toContain('tandem mail ls')
    await drain(T1)
  }, 60_000)
})

/** The installed launcher with a fake runtime folder (a link to this repo), run without blocking this process (it serves the runtime's socket). */
function launcher(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const inst = join(BOX, 'inst')
  if (!existsSync(join(inst, 'runtime'))) {
    mkdirSync(join(inst, 'bin'), { recursive: true })
    copyFileSync(join(repo, 'packaging', 'tandem'), join(inst, 'bin', 'tandem'))
    symlinkSync(repo, join(inst, 'runtime'))
  }
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_NODE: process.execPath }
    delete env.TANDEM_CALLER_TOKEN
    const p = spawn('sh', [join(inst, 'bin', 'tandem'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (c) => { stdout += c })
    p.stderr.on('data', (c) => { stderr += c })
    p.on('close', (status) => done({ status, stdout, stderr }))
  })
}

/** A socket at the control path that answers each connection with `reply`. */
async function fakeSocket(reply: string): Promise<{ lines: string[]; close(): Promise<void> }> {
  const lines: string[] = []
  const open = new Set<Socket>()
  const server = netServer((c) => {
    open.add(c)
    c.on('close', () => open.delete(c))
    c.setEncoding('utf8')
    let body = ''
    c.on('data', (chunk) => {
      body += chunk
      if (!body.includes('\n')) return
      lines.push(body.slice(0, body.indexOf('\n')))
      c.end(reply)
    })
  })
  mkdirSync(join(process.env.TANDEM_HOME!, 'run'), { recursive: true, mode: 0o700 })
  await new Promise<void>((r) => server.listen(controlSocketPath(), r))
  return { lines, close: () => new Promise<void>((r) => { server.close(() => r()); for (const c of open) c.destroy() }) }
}
