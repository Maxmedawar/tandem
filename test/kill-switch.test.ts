/**
 * U-R1A-35: one switch stops every agent on a computer, and the session cap stops a spawn storm.
 * `tandem kill-switch on` (bridge/kill-switch.ts) writes `<TANDEM_HOME>/kill-switch`, then presses
 * every Tandem session's own interrupt key (or ends it with --close); while the file is there
 * route() refuses opens, sends with text and relay starts with 423, TerminalSession.send types
 * nothing, and the delivery hook hands nothing over. The limits file's `session_cap` (default 12)
 * refuses an open past it with 429, counted across every process through reservation files.
 *
 * tmux runs only on a private socket: before any import TMUX is unset and TMUX_TMPDIR is a new
 * r1a35- folder; HOME, TANDEM_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME live in it too. afterAll ends
 * every tmux server whose socket is in that folder, then removes it. Sessions are the pinned `sh`
 * (the shell harness file) and test/fixtures/fake-cli.sh; the made-up `claude` on PATH is the fake
 * CLI and no row starts it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.sh', import.meta.url))
const KS = join(repo, 'bridge', 'kill-switch.ts')
const BOX = mkdtempSync(join(tmpdir(), 'r1a35-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const BIN = join(BOX, 'bin')
const CONFIG = join(BOX, 'claude-config')
const CODEX = join(BOX, 'codex-home')
for (const d of [HOME, WORK, BIN, CONFIG, CODEX]) mkdirSync(d)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.env.CODEX_HOME = CODEX
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_ENABLED_ENGINES = 'shell,claude'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'
delete process.env.TANDEM_ALLOW_BYPASS
// The relay rows need the claude harness enabled and found: a made-up `claude` (the fake CLI) comes
// first on PATH. No row lets the relay start it.
writeFileSync(join(BIN, 'claude'), `#!/bin/sh\nexec /bin/sh '${FAKE}' "$@"\n`, { mode: 0o755 })
process.env.PATH = `${BIN}:/usr/bin:/bin:${process.env.PATH ?? ''}`

const ks = await import('../bridge/kill-switch.ts')
const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { getLive, registerLive, unregisterLive, liveSessionNames } = await import('../bridge/sessions.ts')
const { TerminalSession } = await import('../bridge/terminal-session.ts')
const { HarnessSession, harnessDescriptor } = await import('../bridge/engines/harness-engine.ts')
const { noticePass } = await import('../bridge/delivery-notice.ts')
const { openMailbox } = await import('../bridge/mailbox.ts')
const dh = await import('../bridge/delivery-hooks.ts')

const SOCK = join(TH, 'tmux', 'tandem')
const SWITCH = join(TH, 'kill-switch')
const OPENING = join(TH, 'opening')
const AUDIT = join(TH, 'bridge.log')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Rows that open real sessions pass 5 s when the affected files run together (audit: k2 timed out at 5000 ms).
vi.setConfig({ testTimeout: 30_000 })

let BASE: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE, ...extra })
  limits.applyLimits()
}

beforeAll(() => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  const claude = loadedHarnesses().get('claude')
  if (!sh || !claude) throw new Error('the shell or claude harness file did not load')
  BASE = {
    folders: [WORK],
    shell: true,
    permission_skip: [WORK],
    agents: { shell: agentEntry(sh), claude: agentEntry(claude) },
    interrupt_from: ['owner'],
  }
  setLimits()
})

afterAll(() => {
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })
const open = (name: string) => rq('POST', '/sessions/open', { engine: 'shell', name, cwd: WORK })

function tmuxNames(sock = SOCK): string[] {
  try {
    return execFileSync('tmux', ['-S', sock, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean).sort()
  } catch {
    return []
  }
}
const ccm = () => tmuxNames().filter((n) => n.startsWith('ccm-'))
function screen(name: string): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'capture-pane', '-p', '-J', '-S', '-', '-t', `=ccm-${name}:`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
/** The program in the foreground of ccm-<name>'s pane. */
function current(name: string): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'display-message', '-p', '-t', `=ccm-${name}:`, '#{pane_current_command}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(100)
  }
  return test()
}
function auditLines(denied: string): Json[] {
  if (!existsSync(AUDIT)) return []
  return readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.denied === denied)
}
/** The switch on by its file alone (no keys pressed): what engage() writes first. */
function switchFile() {
  mkdirSync(TH, { recursive: true, mode: 0o700 })
  writeFileSync(SWITCH, `on ${new Date().toISOString()}\n`, { mode: 0o600 })
}

beforeEach(async () => {
  rmSync(SWITCH, { recursive: true, force: true })
  for (const name of liveSessionNames()) {
    const s = getLive(name)
    unregisterLive(name)
    await s?.close().catch(() => {})
  }
  for (const n of ccm()) spawnSync('tmux', ['-S', SOCK, 'kill-session', '-t', `=${n}`])
  rmSync(OPENING, { recursive: true, force: true })
  setLimits()
})

describe('(k1) the switch file', () => {
  it('(35) k1 off at start; engage() turns it on: a 0600 file `on <ISO time>` in a 0700 folder; again leaves it as it is', async () => {
    expect(ks.killSwitchPath()).toBe(SWITCH)
    expect(ks.killSwitchOn()).toBe(false)
    expect(await ks.engage()).toEqual({ stopped: [], closed: [], failed: [] })
    expect(ks.killSwitchOn()).toBe(true)
    expect(statSync(SWITCH).mode & 0o777).toBe(0o600)
    expect(statSync(TH).mode & 0o777).toBe(0o700)
    const text = readFileSync(SWITCH, 'utf8')
    expect(text).toMatch(/^on \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/)
    await ks.engage()
    expect(readFileSync(SWITCH, 'utf8')).toBe(text)
  })

  it('(35) k1 a folder, a dangling symlink or a symlink to a file at the path reads on; release() throws a `tandem:` line naming the path and the switch stays on', () => {
    const target = join(BOX, 'k1-target')
    writeFileSync(target, 'x')
    const makers: [string, () => void][] = [
      ['folder', () => mkdirSync(SWITCH)],
      ['dangling symlink', () => symlinkSync(join(BOX, 'k1-nowhere'), SWITCH)],
      ['symlink to a file', () => symlinkSync(target, SWITCH)],
    ]
    for (const [label, make] of makers) {
      rmSync(SWITCH, { recursive: true, force: true })
      make()
      expect(ks.killSwitchOn(), label).toBe(true)
      let message = ''
      try {
        ks.release()
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, label).toMatch(/^tandem: /)
      expect(message, label).toContain(SWITCH)
      expect(ks.killSwitchOn(), label).toBe(true)
    }
    expect(readFileSync(target, 'utf8')).toBe('x')
  })

  it('(35) k1 release() removes a regular file and returns true; a missing file returns false', async () => {
    await ks.engage()
    expect(ks.release()).toBe(true)
    expect(ks.killSwitchOn()).toBe(false)
    expect(existsSync(SWITCH)).toBe(false)
    expect(ks.release()).toBe(false)
  })

  it('(35) k1 main as the entry file: status, on, on --close, off print the exact lines and exit codes; anything else is usage, exit 2; an error is one tandem: line, exit 1', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', KS, ...args], { encoding: 'utf8', env: process.env, timeout: 30_000 })
    const expectRun = (args: string[], stdout: string, status: number) => {
      const r = run(...args)
      expect([args.join(' '), r.stdout, r.status]).toEqual([args.join(' '), stdout, status])
      return r
    }
    expectRun(['status'], 'tandem: kill switch off\n', 0)
    expectRun(['on'], 'tandem: kill switch on; 0 sessions stopped\n', 0)
    expectRun(['status'], 'tandem: kill switch on\n', 0)
    expectRun(['on', '--close'], 'tandem: kill switch on; 0 sessions ended\n', 0)
    expectRun(['off'], 'tandem: kill switch off\n', 0)
    expectRun(['off'], 'tandem: kill switch was already off\n', 0)
    expectRun(['status'], 'tandem: kill switch off\n', 0)
    for (const bad of [[], ['bogus'], ['on', '--bogus'], ['status', 'x']]) {
      const r = expectRun(bad, '', 2)
      expect(r.stderr).toContain('tandem kill-switch on [--close]')
    }
    mkdirSync(SWITCH)
    const r = expectRun(['off'], '', 1)
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('tandem: '))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(SWITCH)
    expect(r.stderr).not.toMatch(/\n\s+at /)
    expect(ks.killSwitchOn()).toBe(true)
  })

  it('(35) k1 the launcher: `tandem kill-switch on|status|off` runs bridge/kill-switch.ts; help lists both usage lines', () => {
    const inst = join(BOX, 'inst')
    mkdirSync(join(inst, 'bin'), { recursive: true })
    copyFileSync(join(repo, 'packaging', 'tandem'), join(inst, 'bin', 'tandem'))
    if (!existsSync(join(inst, 'runtime'))) symlinkSync(repo, join(inst, 'runtime'))
    const tandem = (...args: string[]) =>
      spawnSync('sh', [join(inst, 'bin', 'tandem'), ...args], { encoding: 'utf8', env: { ...process.env, TANDEM_NODE: process.execPath }, timeout: 30_000 })
    const help = tandem('help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('tandem kill-switch on [--close]')
    expect(help.stdout).toContain('tandem kill-switch off|status')
    expect([tandem('kill-switch', 'on').stdout, ks.killSwitchOn()]).toEqual(['tandem: kill switch on; 0 sessions stopped\n', true])
    expect(tandem('kill-switch', 'status').stdout).toBe('tandem: kill switch on\n')
    expect([tandem('kill-switch', 'off').stdout, ks.killSwitchOn()]).toEqual(['tandem: kill switch off\n', false])
    expect(tandem('kill-switch').status).toBe(2)
  })
})

describe('(k2) route() while the switch is on', () => {
  it('(35) k2 open answers 423 with exactly KILL_SWITCH_ON and one audit line; nothing is spawned', async () => {
    await ks.engage()
    const before = tmuxNames()
    const lines = auditLines('kill-switch').length
    expect(await open('r35-k2a')).toEqual({ status: 423, body: { error: ks.KILL_SWITCH_ON } })
    expect(ks.KILL_SWITCH_ON).toBe('kill switch on: nothing may start or be typed into on this computer until the owner runs tandem kill-switch off here')
    expect(tmuxNames()).toEqual(before)
    const added = auditLines('kill-switch').slice(lines)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ route: 'POST /sessions/open', denied: 'kill-switch' })
  })

  it('(35) k2 send with text answers 423 and types nothing (the pane unchanged)', async () => {
    expect((await open('r35-k2b')).status).toBe(200)
    await ks.engage()
    await sleep(800)
    const before = screen('r35-k2b')
    expect(await rq('POST', '/sessions/r35-k2b/send', { text: 'echo r35-k2b-typed' })).toEqual({ status: 423, body: { error: ks.KILL_SWITCH_ON } })
    await sleep(800)
    expect(screen('r35-k2b')).toBe(before)
    expect(before).not.toContain('r35-k2b-typed')
  })

  it('(35) k2 relay start, inject and enqueue answer 423; nothing is spawned', async () => {
    await ks.engage()
    const before = tmuxNames()
    const refused = { status: 423, body: { error: ks.KILL_SWITCH_ON } }
    expect(await rq('POST', '/relay/start', { goal: 'r35 relay', cwd: WORK })).toEqual(refused)
    expect(await rq('POST', '/relay/r35loop/inject', { message: 'r35 inject' })).toEqual(refused)
    expect(await rq('POST', '/relay/r35loop/enqueue', { task: 'r35 task' })).toEqual(refused)
    expect(tmuxNames()).toEqual(before)
  })

  it('(35) k2 list, read, poll-mode send, interrupt, close, relay read and stop answer as before; no route turns the switch off', async () => {
    expect((await open('r35-k2d')).status).toBe(200)
    await ks.engage()
    const list = await rq('GET', '/sessions')
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).toContain('r35-k2d')
    expect((await rq('GET', '/sessions/r35-k2d/read')).status).toBe(200)
    const poll = await rq('POST', '/sessions/r35-k2d/send', { text: '' })
    expect(poll.status).toBe(200)
    expect(poll.body).toMatchObject({ live: true })
    expect(await rq('POST', '/sessions/r35-k2d/interrupt')).toMatchObject({ status: 200, body: { ok: true } })
    expect((await rq('GET', '/relay/r35loop/read')).status).toBe(404)
    expect((await rq('POST', '/relay/r35loop/stop')).status).toBe(200)
    for (const [m, p] of [['POST', '/kill-switch/off'], ['DELETE', '/kill-switch'], ['POST', '/sessions/kill-switch/off'], ['POST', '/relay/kill-switch/off']]) {
      expect((await rq(m!, p!, { on: false })).status, `${m} ${p}`).toBe(404)
    }
    expect(await rq('POST', '/sessions/r35-k2d/close')).toMatchObject({ status: 200, body: { ok: true } })
    expect(ccm()).toEqual([])
    expect(ks.killSwitchOn()).toBe(true)
  })

  it('(35) k2 after release() an open works again', async () => {
    await ks.engage()
    expect((await open('r35-k2e')).status).toBe(423)
    expect(ks.release()).toBe(true)
    expect((await open('r35-k2e')).status).toBe(200)
    expect(ccm()).toEqual(['ccm-r35-k2e'])
  })
})

describe('(k3) TerminalSession while the switch is on', () => {
  const sh = () => harnessDescriptor(loadedHarnesses().get('shell')!)

  it('(35) k3 send on a live shell throws KillSwitchError before any tmux call; the pane is unchanged', async () => {
    const t = await TerminalSession.spawn({ name: 'r35-k3', cwd: WORK, allowlist: [WORK], descriptor: sh() })
    try {
      await ks.engage()
      await sleep(800)
      const before = screen('r35-k3')
      const e = await t.send('echo r35-k3-typed').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ks.KillSwitchError)
      expect((e as Error).message).toBe(ks.KILL_SWITCH_ON)
      await sleep(800)
      expect(screen('r35-k3')).toBe(before)
    } finally {
      await t.close()
    }
  })

  it('(35) k3 a typed control (applyControls, a per-send model/effort) is refused the same way', async () => {
    const t = await TerminalSession.spawn({ name: 'r35-k3c', cwd: WORK, allowlist: [WORK], descriptor: sh() })
    try {
      switchFile()
      const before = screen('r35-k3c')
      expect(await t.applyControls({ effort: 'high' }).catch((x: unknown) => x)).toBeInstanceOf(ks.KillSwitchError)
      await sleep(800)
      expect(screen('r35-k3c')).toBe(before)
    } finally {
      await t.close()
    }
  })

  it('(35) k3 spawn (the path every open and both relay sessions take) throws KillSwitchError and starts no session', async () => {
    switchFile()
    const e = await TerminalSession.spawn({ name: 'r35-k3s', cwd: WORK, allowlist: [WORK], descriptor: sh() }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ks.KillSwitchError)
    expect(ccm()).toEqual([])
  })
})

/** The fake CLI as a notice or hook agent (test/delivery-notice.test.ts's harness). */
function fakeHarness(name: string, delivery: 'hook' | 'notice', program = FAKE): Json {
  return {
    name, program, programPath: program, args: [], skip_prompts_args: [], resume: [], fork: [],
    has_prompts: true, delivery, ...(delivery === 'hook' ? { hook: '--settings' } : {}), permission_hook: false,
    reports_context: false, source: 'owner', file: join(BOX, `${name}.toml`), kind: 'agent',
    states: { working: ['^fake is thinking\\z'], idle: ['^fake>\\z'], waiting_for_approval: ['\\(y/n\\)\\z'], debounce_ms: 300, precedence: ['waiting_for_approval', 'working', 'idle'] },
  }
}
const stateOf = (b: Json, id: string) => b.sent('owner', 500).find((m: Json) => m.id === id)?.state

describe('(k4) the notice pass while the switch is on', () => {
  it('(35) k4 mail queued for a live notice session at an idle prompt: nothing is typed, the mail stays queued', async () => {
    const s = await HarnessSession.spawn(fakeHarness('r35-k4h', 'notice'), { name: 'r35-k4', cwd: WORK, allowlist: [WORK] })
    registerLive(s)
    const box = openMailbox()
    try {
      const end = Date.now() + 30_000
      while ((await s.inputState()).state !== 'idle' && Date.now() < end) await sleep(150)
      expect((await s.inputState()).state).toBe('idle')
      const id = box.send({ from: 'owner', to: 'r35-k4', level: 'fyi', text: 'r35 k4 note' }).id
      switchFile()
      const before = screen('r35-k4')
      await noticePass(box)
      await sleep(1500)
      expect(screen('r35-k4')).toBe(before)
      expect(screen('r35-k4')).not.toContain('Tandem:')
      expect(stateOf(box, id)).toBe('queued')
    } finally {
      box.close()
    }
  })
})

describe('(k5) the delivery hook while the switch is on', () => {
  type Cmds = Record<'PostToolUse' | 'Stop', string>
  function install(name: string): Cmds {
    const argv = dh.installHook(fakeHarness(name, 'hook', '/usr/bin/true'), name)
    const json = JSON.parse(readFileSync(argv[1]!, 'utf8'))
    return { PostToolUse: json.hooks.PostToolUse[0].hooks[0].command, Stop: json.hooks.Stop[0].hooks[0].command }
  }
  const run = (cmd: string, stdin: unknown) => spawnSync('sh', ['-c', cmd], { input: JSON.stringify(stdin), encoding: 'utf8', timeout: 30_000 })
  const ev = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: 'r35-sid', cwd: WORK, ...extra })
  const turn = (name: string) => JSON.parse(readFileSync(join(TH, 'delivery', `${name}.turn`), 'utf8')).state

  it('(35) k5 PostToolUse with an fyi queued prints nothing and the fyi stays queued; off again, it is delivered as before', () => {
    const cmds = install('r35-k5a')
    const box = openMailbox()
    try {
      const id = box.send({ from: 'owner', to: 'r35-k5a', level: 'fyi', text: 'r35 k5a fyi' }).id
      switchFile()
      const r = run(cmds.PostToolUse, ev('PostToolUse', { tool_name: 'Bash' }))
      expect([r.status, r.stdout]).toEqual([0, ''])
      expect(stateOf(box, id)).toBe('queued')
      expect(turn('r35-k5a')).toBe('working')
      ks.release()
      const after = run(cmds.PostToolUse, ev('PostToolUse', { tool_name: 'Bash' }))
      expect(after.status).toBe(0)
      expect(JSON.parse(after.stdout).hookSpecificOutput.additionalContext).toContain('r35 k5a fyi')
      expect(stateOf(box, id)).toBe('delivered')
    } finally {
      box.close()
    }
  })

  it('(35) k5 Stop with an ask queued prints nothing (no `decision: block`), the ask stays queued and the turn file reads idle; off again, Stop hands it over', () => {
    const cmds = install('r35-k5b')
    const box = openMailbox()
    try {
      const id = box.send({ from: 'owner', to: 'r35-k5b', level: 'ask', text: 'r35 k5b ask' }).id
      switchFile()
      const r = run(cmds.Stop, ev('Stop', { stop_hook_active: false }))
      expect([r.status, r.stdout]).toEqual([0, ''])
      expect(stateOf(box, id)).toBe('queued')
      expect(turn('r35-k5b')).toBe('idle')
      ks.release()
      const after = run(cmds.Stop, ev('Stop', { stop_hook_active: false }))
      const out = JSON.parse(after.stdout)
      expect(out.decision).toBe('block')
      expect(out.reason).toContain('r35 k5b ask')
      expect(stateOf(box, id)).toBe('delivered')
    } finally {
      box.close()
    }
  })
})

describe('(k6) engage() stops every session on Tandem\'s socket and nothing else', () => {
  it('(35) k6 two shells running `sleep 100`: after engage() both are back at their shell within 5 s, `stopped` lists both, both still exist', async () => {
    const names = ['r35-k6a', 'r35-k6b']
    for (const n of names) {
      expect((await open(n)).status).toBe(200)
      expect((await rq('POST', `/sessions/${n}/send`, { text: 'sleep 100' })).status).toBe(200)
    }
    expect(await until(() => names.every((n) => current(n) === 'sleep'), 10_000)).toBe(true)
    const r = await ks.engage()
    expect({ ...r, stopped: [...r.stopped].sort() }).toEqual({ stopped: names, closed: [], failed: [] })
    expect(await until(() => names.every((n) => current(n) !== 'sleep' && current(n) !== ''), 5_000)).toBe(true)
    expect(ccm()).toEqual(names.map((n) => `ccm-${n}`))
  }, 60_000)

  it('(35) k6 engage({ close: true }) ends both, `closed` lists both; a tmux server on another socket is untouched', async () => {
    const other = join(BOX, 'other')
    spawnSync('tmux', ['-S', other, 'new-session', '-d', '-s', 'ccm-x'])
    try {
      expect(tmuxNames(other)).toEqual(['ccm-x'])
      const names = ['r35-k6c', 'r35-k6d']
      for (const n of names) expect((await open(n)).status).toBe(200)
      const r = await ks.engage({ close: true })
      expect({ ...r, closed: [...r.closed].sort() }).toEqual({ stopped: [], closed: names, failed: [] })
      expect(ccm()).toEqual([])
      expect(tmuxNames(other)).toEqual(['ccm-x'])
    } finally {
      spawnSync('tmux', ['-S', other, 'kill-server'])
    }
  }, 60_000)
})

describe('(k7) session_cap in the limits file', () => {
  const TEXT = 'wrong type for session_cap: expected a whole number 1 to 100'
  it.each([[0], [101], [1.5], ['12']])('(35) k7 session_cap %j refuses the whole file with the exact text', (v) => {
    setLimits({ session_cap: v })
    const snap = limits.limitsSnapshot()
    expect(snap.problem).toBe(`${limits.limitsFile()}: ${TEXT}`)
    expect(snap.shell).toBe(false)
    expect(snap.folders).toEqual([])
    expect(snap.session_cap).toBe(12)
  })

  it('(35) k7 absent -> 12; 3 -> 3; 1 and 100 load', () => {
    setLimits()
    expect(limits.limitsSnapshot().session_cap).toBe(12)
    expect(limits.limitsSnapshot().problem).toBeUndefined()
    for (const v of [3, 1, 100]) {
      setLimits({ session_cap: v })
      expect(limits.limitsSnapshot().problem).toBeUndefined()
      expect(limits.limitsSnapshot().session_cap).toBe(v)
    }
  })
})

const capText = (cap: number, n: number) => `limits: session_cap ${cap} reached (${n} sessions open); close one first`

describe('(c) the session cap', () => {
  it('(35) c1 A3.10 with cap 3: 3 opens -> 200; a 4th name -> 429; reopening one of the 3 -> 200 reused; close one -> a new name opens', async () => {
    setLimits({ session_cap: 3 })
    for (const n of ['r35-c1a', 'r35-c1b', 'r35-c1c']) expect((await open(n)).status).toBe(200)
    const lines = auditLines('session_cap').length
    expect(await open('r35-c1d')).toEqual({ status: 429, body: { error: capText(3, 3) } })
    expect(auditLines('session_cap').slice(lines)).toEqual([expect.objectContaining({ route: 'POST /sessions/open', denied: 'session_cap' })])
    expect(ccm()).toHaveLength(3)
    expect(await open('r35-c1a')).toMatchObject({ status: 200, body: { reused: true } })
    expect((await rq('POST', '/sessions/r35-c1b/close')).status).toBe(200)
    expect((await open('r35-c1d')).status).toBe(200)
    expect(ccm()).toEqual(['ccm-r35-c1a', 'ccm-r35-c1c', 'ccm-r35-c1d'])
    expect(readdirSync(OPENING).filter((f) => f !== '.lock')).toEqual([])
  }, 60_000)

  it('(35) c2 storm in one process: cap 3, 8 opens of different names at once -> exactly 3 succeed, 5 get 429, tmux lists 3', async () => {
    setLimits({ session_cap: 3 })
    const names = Array.from({ length: 8 }, (_, i) => `r35-c2-${i}`)
    const rs = await Promise.all(names.map(open))
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3)
    const refused = rs.filter((r) => r.status === 429)
    expect(refused).toHaveLength(5)
    for (const r of refused) expect((r.body as Json).error).toMatch(/^limits: session_cap 3 reached \(\d sessions open\); close one first$/)
    expect(ccm()).toHaveLength(3)
  }, 60_000)

  it('(35) c2 storm across two processes: a child opening other names at the same moment -> at most 3 ccm- sessions in all', async () => {
    setLimits({ session_cap: 3 })
    const script = join(BOX, 'storm.mjs')
    writeFileSync(script, [
      `import { route } from ${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'router.ts')).href)}`,
      `const at = Number(process.argv[2])`,
      `await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())))`,
      `const rs = await Promise.all(process.argv.slice(3).map((name) => route({ method: 'POST', path: '/sessions/open', query: new URLSearchParams(), body: { engine: 'shell', name, cwd: process.env.CCM_CWD_ALLOWLIST } })))`,
      `process.stdout.write(JSON.stringify(rs.map((r) => r.status)) + '\\n')`,
      `process.exit(0)`,
      '',
    ].join('\n'))
    const at = Date.now() + 5000
    const child = new Promise<number[]>((resolve, reject) => {
      const c = spawn(process.execPath, ['--experimental-strip-types', script, String(at), 'r35-c2x-0', 'r35-c2x-1', 'r35-c2x-2', 'r35-c2x-3'], {
        cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      c.stdout.on('data', (d) => (out += d))
      c.on('error', reject)
      c.on('exit', () => {
        try { resolve(JSON.parse(out.trim())) } catch { reject(new Error(`child printed: ${out}`)) }
      })
    })
    await sleep(Math.max(0, at - Date.now()))
    const mine = (await Promise.all(['r35-c2y-0', 'r35-c2y-1', 'r35-c2y-2', 'r35-c2y-3'].map(open))).map((r) => r.status)
    const theirs = await child
    const all = [...mine, ...theirs]
    expect(all.every((s) => s === 200 || s === 429)).toBe(true)
    expect(all.filter((s) => s === 200)).toHaveLength(3)
    expect(ccm()).toHaveLength(3)
  }, 90_000)

  it('(35) c3 relay start with cap 3 and 2 sessions open -> 429 (it needs 2), nothing spawned; with 1 open it passes the cap', async () => {
    setLimits({ session_cap: 3 })
    for (const n of ['r35-c3a', 'r35-c3b']) expect((await open(n)).status).toBe(200)
    const lines = auditLines('session_cap').length
    expect(await rq('POST', '/relay/start', { goal: 'r35 relay', cwd: WORK })).toEqual({ status: 429, body: { error: capText(3, 2) } })
    expect(auditLines('session_cap').slice(lines)).toEqual([expect.objectContaining({ route: 'POST /relay/start', denied: 'session_cap' })])
    expect(ccm()).toEqual(['ccm-r35-c3a', 'ccm-r35-c3b'])
    expect((await rq('POST', '/sessions/r35-c3b/close')).status).toBe(200)
    // Past the cap the relay's own refusal answers (TANDEM_ALLOW_BYPASS is unset): still nothing spawned.
    const passed = await rq('POST', '/relay/start', { goal: 'r35 relay', cwd: WORK })
    expect(passed.status).toBe(400)
    expect(ccm()).toEqual(['ccm-r35-c3a'])
    expect(readdirSync(OPENING).filter((f) => f !== '.lock')).toEqual([])
  }, 60_000)

  it('(35) c4 a reservation 10 s old counts; one 121 s old does not', async () => {
    setLimits({ session_cap: 3 })
    for (const n of ['r35-c4a', 'r35-c4b']) expect((await open(n)).status).toBe(200)
    mkdirSync(OPENING, { recursive: true, mode: 0o700 })
    const ghost = join(OPENING, 'r35-ghost')
    writeFileSync(ghost, '', { mode: 0o600 })
    const ago = (s: number) => new Date(Date.now() - s * 1000)
    utimesSync(ghost, ago(10), ago(10))
    expect(await open('r35-c4c')).toEqual({ status: 429, body: { error: capText(3, 3) } })
    utimesSync(ghost, ago(121), ago(121))
    expect((await open('r35-c4c')).status).toBe(200)
    expect(ccm()).toHaveLength(3)
  }, 60_000)

  it('(35) c4 a lock file 31 s old is removed and the open goes on', async () => {
    mkdirSync(OPENING, { recursive: true, mode: 0o700 })
    const lock = join(OPENING, '.lock')
    writeFileSync(lock, '', { mode: 0o600 })
    utimesSync(lock, new Date(Date.now() - 31_000), new Date(Date.now() - 31_000))
    expect((await open('r35-c4d')).status).toBe(200)
    expect(existsSync(lock)).toBe(false)
  }, 30_000)

  it('(35) c4 a fresh lock held past 5 s: 429 `limits: session_cap check busy; try again`, nothing spawned', async () => {
    mkdirSync(OPENING, { recursive: true, mode: 0o700 })
    const lock = join(OPENING, '.lock')
    writeFileSync(lock, '', { mode: 0o600 })
    const t0 = Date.now()
    expect(await open('r35-c4e')).toEqual({ status: 429, body: { error: 'limits: session_cap check busy; try again' } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900)
    expect(ccm()).toEqual([])
    expect(existsSync(lock)).toBe(true)
  }, 30_000)

  it('(35) c5 A3.10 whole: default cap, opens in a loop stop at exactly 12; engage() gives every session its key; open and send are refused 423; release() and one open works', async () => {
    setLimits()
    const opened: string[] = []
    let refusal: Json
    for (let i = 0; i < 20; i++) {
      const name = `r35-c5-${String(i).padStart(2, '0')}`
      const r = await open(name)
      if (r.status !== 200) {
        refusal = r
        break
      }
      opened.push(name)
    }
    expect(opened).toHaveLength(12)
    expect(refusal).toEqual({ status: 429, body: { error: capText(12, 12) } })
    expect(ccm()).toHaveLength(12)
    const r = await ks.engage()
    expect({ ...r, stopped: [...r.stopped].sort() }).toEqual({ stopped: opened, closed: [], failed: [] })
    expect(await open('r35-c5-new')).toEqual({ status: 423, body: { error: ks.KILL_SWITCH_ON } })
    expect(await rq('POST', `/sessions/${opened[0]}/send`, { text: 'echo r35-c5' })).toEqual({ status: 423, body: { error: ks.KILL_SWITCH_ON } })
    expect(ks.release()).toBe(true)
    expect((await rq('POST', `/sessions/${opened[0]}/close`)).status).toBe(200)
    expect((await open('r35-c5-new')).status).toBe(200)
    expect(ccm()).toHaveLength(12)
  }, 180_000)
})

describe('(a) audit rows', () => {
  const sh = () => harnessDescriptor(loadedHarnesses().get('shell')!)

  it('(35) a1 the switch turned on while a spawn is under way (after its first check, before tmux starts the session): KillSwitchError, no session left', async () => {
    const e = await TerminalSession.spawn({
      name: 'r35-a1', cwd: WORK, allowlist: [WORK], descriptor: sh(),
      ownerIdProvider: async () => { switchFile(); return 'r35-owner' },
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ks.KillSwitchError)
    expect(ccm()).toEqual([])
  }, 30_000)

  it('(35) a2 a notice refused by the switch is not recorded as sent: after release() the next pass types the line', async () => {
    const s = await HarnessSession.spawn(fakeHarness('r35-a2h', 'notice'), { name: 'r35-a2', cwd: WORK, allowlist: [WORK] })
    registerLive(s)
    const box = openMailbox()
    try {
      const end = Date.now() + 30_000
      while ((await s.inputState()).state !== 'idle' && Date.now() < end) await sleep(150)
      box.send({ from: 'owner', to: 'r35-a2', level: 'fyi', text: 'r35 a2 note' })
      switchFile()
      expect(await noticePass(box)).toEqual({ typed: [], held: [] })
      await sleep(500)
      expect(screen('r35-a2')).not.toContain('Tandem:')
      ks.release()
      expect((await noticePass(box)).typed).toEqual(['r35-a2'])
      expect(await until(() => screen('r35-a2').includes('Tandem: 1 messages waiting'), 10_000)).toBe(true)
    } finally {
      box.close()
    }
  }, 60_000)

  it('(35) a3 engage() clears a stopped session\'s turn file, so the input gate does not read it working after the switch is off', async () => {
    expect((await open('r35-a3')).status).toBe(200)
    const dir = dh.deliveryDir()
    writeFileSync(join(dir, 'r35-a3.turn'), JSON.stringify({ state: 'working', at: new Date().toISOString() }), { mode: 0o600 })
    expect(dh.turnState('r35-a3')).toBe('working')
    expect((await ks.engage()).stopped).toEqual(['r35-a3'])
    expect(dh.turnState('r35-a3')).toBeUndefined()
  }, 30_000)

  it('(35) a4 the names `.`, `..` and `.lock` are refused 400 before anything is reserved or spawned', async () => {
    for (const name of ['.', '..', '.lock']) {
      const r = await open(name)
      expect([name, r.status]).toEqual([name, 400])
    }
    expect(ccm()).toEqual([])
    expect(existsSync(join(OPENING, '.lock'))).toBe(false)
  })

  it('(35) a5 reserveSessions with a cap that is not a whole number of 1 or more throws: a lost cap never means no cap', async () => {
    for (const cap of [undefined, NaN, 0, 1.5, '3'] as unknown as number[]) {
      const e = await ks.reserveSessions(['r35-a5'], cap).catch((x: unknown) => x)
      expect(e, String(cap)).toBeInstanceOf(Error)
      expect((e as Error).message, String(cap)).toMatch(/^tandem: /)
    }
    expect(existsSync(join(OPENING, 'r35-a5'))).toBe(false)
  })

  it('(35) a6 status says why the switch reads on when its file is not a plain file or cannot be read (stderr; stdout stays the one line)', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--experimental-strip-types', KS, 'status'], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 })
    mkdirSync(SWITCH)
    const folder = run({})
    expect([folder.status, folder.stdout]).toEqual([0, 'tandem: kill switch on\n'])
    expect(folder.stderr).toContain(`tandem: ${SWITCH} is not a regular file`)
    const notDir = join(BOX, 'a6-file')
    writeFileSync(notDir, 'x')
    const unreadable = run({ TANDEM_HOME: notDir })
    expect([unreadable.status, unreadable.stdout]).toEqual([0, 'tandem: kill switch on\n'])
    expect(unreadable.stderr).toContain('ENOTDIR')
    rmSync(SWITCH, { recursive: true })
    switchFile()
    expect(run({}).stderr).toBe('')
  })

  it('(35) a7 engage() that cannot list the sessions still leaves the switch on and says so', async () => {
    const tmuxDir = join(TH, 'tmux')
    spawnSync('tmux', ['-S', SOCK, 'kill-server'])
    rmSync(tmuxDir, { recursive: true, force: true })
    writeFileSync(tmuxDir, 'not a folder')
    try {
      const e = await ks.engage().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).message).toMatch(/^tandem: the kill switch is on, but /)
      expect(ks.killSwitchOn()).toBe(true)
    } finally {
      rmSync(tmuxDir, { force: true })
    }
  })
})
