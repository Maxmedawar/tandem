/**
 * U-R1A-18C-2: relay turns and mail notices are typed only through the input gate
 * (bridge/input-gate.ts). A relay turn waits at most HELD_TURN_MS (60 s) for an idle, empty prompt;
 * still held, the relay stops with the reason and nothing is typed. Right before the call that types
 * and presses Enter, one fresh read (recheckInput) must still say idle and empty.
 *
 * Plus the director's K1 amendment (terminal-session.ts at the choke point): a caller argument that
 * ends in ';' stays text (tmux would read it as a command separator), a one-element argv is a program
 * name, and a new session name with '.' (tmux turns it into '_') is refused.
 *
 * Setup as test/relay-kill-switch.test.ts: an r1a18c2- folder holds HOME and TANDEM_HOME, set before
 * any import; TMUX unset, TMUX_TMPDIR in it; tmux only on Tandem's socket in that TANDEM_HOME.
 * Relay cases drive fake sessions; their gates read the real claude harness file's rules over the
 * fixture screen test/fixtures/screens/claude-idle-real.txt (EMPTY) and that screen with its prompt
 * row's text replaced (TYPED). Time bounds use fake timers only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BOX = mkdtempSync(join(tmpdir(), 'r1a18c2-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const BIN = join(BOX, 'bin')
mkdirSync(HOME)
mkdirSync(BIN)
mkdirSync(TH, { mode: 0o700 })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.TANDEM_ALLOW_BYPASS = '1'
for (const k of Object.keys(process.env)) if (k.startsWith('TANDEM_NTFY') || k === 'TANDEM_DONE_WEBHOOK') delete process.env[k]
// A fake `claude` first on PATH, so the built-in claude harness file loads with a program path.
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`

const relay = await import('../bridge/relay.ts')
const gateMod: Record<string, unknown> = await import('../bridge/input-gate.ts')
const { noticeLine, noticePass } = await import('../bridge/delivery-notice.ts')
const { openMailbox } = await import('../bridge/mailbox.ts')
const { registerLive, unregisterLive, listSessions } = await import('../bridge/sessions.ts')
const { HarnessSession } = await import('../bridge/engines/harness-engine.ts')
const { isPromptEmpty, readScreen } = await import('../bridge/harness-detect.ts')
const { loadedHarnesses } = await import('../bridge/engine-registry.ts')
const { TerminalSession } = await import('../bridge/terminal-session.ts')
const { initManagerMemory, managerDir } = await import('../bridge/manager.ts')

const SCREENS = fileURLToPath(new URL('./fixtures/screens/', import.meta.url))
const EMPTY = readFileSync(join(SCREENS, 'claude-idle-real.txt'), 'utf8')
const TYPED = EMPTY.split('\n').map((l) => (l.startsWith('❯') ? '❯ r1a18c2 half-typed' : l)).join('\n')
const WORKING = readFileSync(join(SCREENS, 'claude-working-1.txt'), 'utf8')
const claude = loadedHarnesses().get('claude')!
const SOCK = join(TH, 'tmux', 'tandem')
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }
const HELD_LINE = 'turn held (held: prompt not empty): waiting up to 60 s; nothing typed'

vi.setConfig({ testTimeout: 60_000 })
afterAll(() => {
  if (spawnSync('test', ['-S', SOCK]).status === 0) spawnSync('tmux', ['-S', SOCK, 'kill-server'])
  rmSync(BOX, { recursive: true, force: true })
})

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** A relay session that records every send and interrupt; answers `replies` in order, then DONE. */
function fakeSession(name: string, replies: string[] = []) {
  const sent: { text: string; at: number }[] = []
  const interrupts: number[] = []
  return {
    name,
    sent,
    interrupts,
    async send(text: string) {
      sent.push({ text, at: Date.now() })
      return { report: replies.shift() ?? 'DONE' }
    },
    async interrupt() {
      interrupts.push(Date.now())
    },
    async close() {},
  }
}

/** A terminal for a HarnessSession gate: its screen is whatever `screen()` returns at each read. */
function fakeTerminal(name: string, screen: () => string, sent: string[] = []): Json {
  return {
    name, cwd: BOX, ready: true, readinessWarning: undefined, skipTag: '1',
    attachHint: () => `r1a18c2 ${name}`,
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => {
      sent.push(text)
      return { status: 'done', report: 'DONE', cursor: 0 }
    },
    readSince: async () => ({ text: '', cursor: 0 }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {},
    screen: async () => screen(),
  }
}
/** The production gate object: the claude harness file's rules over a fake screen. */
const claudeGate = (name: string, screen: () => string) => new HarnessSession(claude, fakeTerminal(name, screen))
/** A gate with no debounce whose n-th read (from 1) shows `screens(n)`, by the claude file's empty rule. */
function countingGate(screens: (n: number) => string) {
  let n = 0
  return {
    reads: () => n,
    async inputState() {
      const screen = screens(++n)
      return { state: readScreen(claude, screen), screen, debounceMs: 0 }
    },
    promptEmpty: (screen: string) => isPromptEmpty(claude, screen),
  }
}

let loops = 0
function fakeLoop(lead: ReturnType<typeof fakeSession>, worker: ReturnType<typeof fakeSession>, gates?: Map<unknown, unknown>) {
  const dir = join(BOX, `loop-${++loops}`)
  initManagerMemory(dir, { goal: 'r1a18c2 goal' })
  return {
    loopId: `r1a18c2-${loops}`, leadName: 'l', workerName: 'w', lead, worker, logPath: join(dir, 'transcript.log'), cwd: BOX, memDir: dir,
    running: true, deadline: Date.now() + 30 * 60_000, finished: Promise.resolve(), maxTurns: 6, perTaskWallClockMs: 30 * 60_000,
    idleTimeoutMs: 5_000, answerIdleTimeoutMs: 5_000, parked: false, ...(gates ? { gates } : {}),
  }
}
const run = (loop: ReturnType<typeof fakeLoop>) =>
  relay.runTaskForTest(loop as unknown as Parameters<typeof relay.runTaskForTest>[0], 'go', loop.maxTurns)
const log = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const lines = (path: string, text: string) => log(path).split('\n').filter((l) => l === text).length

/** Watches a promise: `settled` and `value` once it settles. */
function watch<T>(p: Promise<T>) {
  const w: { settled: boolean; value?: T } = { settled: false }
  void p.then((v) => {
    w.settled = true
    w.value = v
  })
  return w
}
/** Fake time forward in `step` ms slices until `done()` or `max` ms passed. */
async function advanceUntil(done: () => boolean, max: number, step = 250) {
  for (let t = 0; t < max && !done(); t += step) await vi.advanceTimersByTimeAsync(step)
}

describe('(a) relay turns through the input gate (A5.14 relay part)', () => {
  it('(18C2) a1 pin: lead and worker gates read EMPTY: each turn typed once, the run ends done', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const lead = fakeSession('lead', ['step one', 'DONE'])
      const worker = fakeSession('worker', ['did it'])
      const loop = fakeLoop(lead, worker, new Map([[lead, claudeGate('r1a18c2-a1-lead', () => EMPTY)], [worker, claudeGate('r1a18c2-a1-worker', () => EMPTY)]]))
      const w = watch(run(loop))
      await advanceUntil(() => w.settled, 120_000)
      expect(w.value).toEqual({ kind: 'done' })
      expect(lead.sent.map((s) => s.text.endsWith('go') || s.text.includes('did it'))).toEqual([true, true])
      expect(worker.sent.map((s) => s.text)).toEqual(['step one'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('(18C2) a2 RED AT BASE: the lead gate reads TYPED for the whole hold: nothing typed; not ended at 59,999 ms after the first held verdict, ended at 60,000 ms held: prompt not empty; one held line', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const lead = fakeSession('lead')
      const worker = fakeSession('worker')
      let firstRead = 0
      const leadGate = claudeGate('r1a18c2-a2-lead', () => {
        if (!firstRead) firstRead = Date.now()
        return TYPED
      })
      const loop = fakeLoop(lead, worker, new Map([[lead, leadGate], [worker, claudeGate('r1a18c2-a2-worker', () => EMPTY)]]))
      const w = watch(run(loop))
      await vi.advanceTimersByTimeAsync(0)
      expect(firstRead).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(firstRead + 59_999 - Date.now())
      expect(w.settled).toBe(false)
      expect(lead.sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(w.settled).toBe(true)
      expect(w.value).toEqual({ kind: 'held', reason: 'held: prompt not empty' })
      expect([lead.sent.length, worker.sent.length]).toEqual([0, 0])
      expect(lines(loop.logPath, HELD_LINE)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('(18C2) a3 RED AT BASE: TYPED for 5 s, then EMPTY: typed once, only after the prompt emptied', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const t0 = Date.now()
      const lead = fakeSession('lead', ['DONE'])
      const worker = fakeSession('worker')
      const loop = fakeLoop(lead, worker, new Map([[lead, claudeGate('r1a18c2-a3-lead', () => (Date.now() - t0 < 5_000 ? TYPED : EMPTY))], [worker, claudeGate('r1a18c2-a3-worker', () => EMPTY)]]))
      const w = watch(run(loop))
      await advanceUntil(() => w.settled, 120_000)
      expect(w.value).toEqual({ kind: 'done' })
      expect(lead.sent.length).toBe(1)
      expect(lead.sent[0].at - t0).toBeGreaterThanOrEqual(5_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('(18C2) a4 RED AT BASE: a working screen for the whole hold: held: working, nothing typed', async () => {
    expect(readScreen(claude, WORKING)).toBe('working')
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const lead = fakeSession('lead')
      const worker = fakeSession('worker')
      const loop = fakeLoop(lead, worker, new Map([[lead, claudeGate('r1a18c2-a4-lead', () => WORKING)], [worker, claudeGate('r1a18c2-a4-worker', () => EMPTY)]]))
      const w = watch(run(loop))
      await advanceUntil(() => w.settled, 120_000)
      expect(w.value).toEqual({ kind: 'held', reason: 'held: working' })
      expect([lead.sent.length, worker.sent.length]).toEqual([0, 0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('(18C2) a5 RED AT BASE: through startRelay, terminals whose screen is TYPED: the relay stops held: prompt not empty, nothing typed', async () => {
    const typedInto: string[] = []
    const spy = vi.spyOn(TerminalSession, 'spawn').mockImplementation((async (o: { name: string }) => fakeTerminal(o.name, () => TYPED, typedInto)) as Json)
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const work = join(BOX, 'a5-work')
      mkdirSync(work)
      const { loopId } = await relay.startRelay({ goal: 'r1a18c2 a5 goal', cwd: work, allowlist: [work] })
      await advanceUntil(() => relay.info(loopId)?.running === false, 120_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relay.info(loopId)?.running).toBe(false)
      const state = JSON.parse(readFileSync(join(managerDir(loopId), 'STATE.json'), 'utf8'))
      expect(state.blockedReason).toBe('held: prompt not empty')
      const managerLines = log(join(TH, 'relay', `${loopId}.log`)).split('\n').filter((l) => l.startsWith('manager finished'))
      expect(managerLines.at(-1)).toBe('manager finished · reason: held: prompt not empty')
      expect(typedInto).toEqual([])
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
    }
  })

  it('(18C2) a6 RED AT BASE: no gates and sessions with no inputState: held (fail closed), nothing typed', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const lead = fakeSession('lead')
      const worker = fakeSession('worker')
      const loop = fakeLoop(lead, worker)
      const w = watch(run(loop))
      await advanceUntil(() => w.settled, 120_000)
      expect(w.value).toEqual({ kind: 'held', reason: 'held: unknown' })
      expect([lead.sent.length, worker.sent.length]).toEqual([0, 0])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('(b) one fresh read right before the type-and-submit call', () => {
  it('(18C2) b1 RED AT BASE: recheckInput: EMPTY idle true; TYPED, working, no inputState, a throwing inputState false', async () => {
    const recheckInput = gateMod.recheckInput as (s: object) => Promise<boolean>
    expect(typeof recheckInput).toBe('function')
    expect(await recheckInput(claudeGate('r1a18c2-b1-e', () => EMPTY))).toBe(true)
    expect(await recheckInput(claudeGate('r1a18c2-b1-t', () => TYPED))).toBe(false)
    expect(await recheckInput(claudeGate('r1a18c2-b1-w', () => WORKING))).toBe(false)
    expect(await recheckInput({})).toBe(false)
    expect(await recheckInput({ inputState: async () => { throw new Error('r1a18c2') } })).toBe(false)
  })

  it('(18C2) b2 RED AT BASE: notice: EMPTY through admitInput, TYPED at the re-check: nothing typed, held, still not noticed; a later EMPTY pass types the line once', async () => {
    const box = openMailbox()
    const name = 'r1a18c2-b2'
    const typed: string[] = []
    let typedNow = true
    const g = countingGate((n) => (n <= 2 ? EMPTY : typedNow ? TYPED : EMPTY))
    registerLive({
      id: name, engine: 'r1a18c2-fake', cwd: BOX, deliveryClass: () => 'notice',
      inputState: () => g.inputState(), promptEmpty: g.promptEmpty,
      send: async (text: string) => { typed.push(text); return { status: 'done', report: '', cursor: 0 } },
      interrupt: async () => {},
    } as Json)
    try {
      box.send({ from: 'owner', to: name, level: 'fyi', text: 'a note' })
      const first = await noticePass(box)
      expect(g.reads()).toBe(3)
      expect(first).toEqual({ typed: [], held: [name] })
      expect(typed).toEqual([])
      expect(box.pending(name).fyi).toBe(1)
      typedNow = false
      const second = await noticePass(box)
      expect(second.typed).toEqual([name])
      await new Promise((r) => setTimeout(r, 50))
      expect(typed).toEqual([noticeLine(1)])
      expect((await noticePass(box)).typed).toEqual([])
      expect(typed).toEqual([noticeLine(1)])
    } finally {
      unregisterLive(name)
      box.close()
    }
  })

  it('(18C2) b3 RED AT BASE: relay: EMPTY through admitInput, TYPED at the re-check and after: nothing typed, the turn ends held as a2', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    try {
      const lead = fakeSession('lead')
      const worker = fakeSession('worker')
      const g = countingGate((n) => (n <= 2 ? EMPTY : TYPED))
      const loop = fakeLoop(lead, worker, new Map<unknown, unknown>([[lead, g], [worker, claudeGate('r1a18c2-b3-worker', () => EMPTY)]]))
      const w = watch(run(loop))
      await advanceUntil(() => w.settled, 120_000)
      expect(g.reads()).toBeGreaterThanOrEqual(3)
      expect(w.value).toEqual({ kind: 'held', reason: 'held: prompt not empty' })
      expect([lead.sent.length, worker.sent.length]).toEqual([0, 0])
      expect(lines(loop.logPath, HELD_LINE)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- K1 (director amendment): tmux arguments at terminal-session.ts's choke point ----
describe('(k) tmux arguments: a trailing ";" stays text; a one-element argv is a program name; no "." in a new name', () => {
  const WORK = join(BOX, 'k-work')
  mkdirSync(WORK)
  const tx = (...args: string[]) => spawnSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' })
  const pane = (name: string) => tx('capture-pane', '-p', '-J', '-S', '-', '-t', `=ccm-${name}:`).stdout ?? ''
  async function until(f: () => boolean, ms = 10_000) {
    const end = Date.now() + ms
    while (Date.now() < end && !f()) await new Promise((r) => setTimeout(r, 100))
  }
  const owner = async () => 'r1a18c2-owner'

  it('(18C2) k1 RED AT BASE: send text ending in ";" arrives intact: the pane shows it once', async () => {
    const s = await TerminalSession.spawn({
      name: 'r1a18c2-k1', cwd: WORK, allowlist: [WORK], ownerIdProvider: owner,
      descriptor: { id: 'shell', argv: ['sh', '-c', 'stty -echo; printf "r1a18c2-k1 up\\n"; exec cat'], minStableMs: 0 } as Json,
    })
    try {
      await s.send('r1a18c2 k1 x;')
      await until(() => pane('r1a18c2-k1').includes('r1a18c2 k1 x'))
      expect(pane('r1a18c2-k1').split('\n').filter((l) => l.includes('r1a18c2 k1 x'))).toEqual(['r1a18c2 k1 x;'])
    } finally {
      await s.close()
    }
  })

  it('(18C2) k2 RED AT BASE: a program argument and the start folder ending in ";" do not split the start', async () => {
    const dir = join(WORK, 'r1a18c2-d;')
    mkdirSync(dir)
    const s = await TerminalSession.spawn({
      name: 'r1a18c2-k2', cwd: dir, allowlist: [WORK], ownerIdProvider: owner,
      descriptor: { id: 'shell', argv: ['sh', '-c', 'printf "arg=%s|pwd=%s|\\n" "$1" "$(pwd)"; exec cat', 'sh', 'z;'], minStableMs: 0 } as Json,
    })
    try {
      await until(() => pane('r1a18c2-k2').includes('arg='))
      expect(pane('r1a18c2-k2')).toContain(`arg=z;|pwd=${s.cwd}|`)
      expect(s.cwd.endsWith('r1a18c2-d;')).toBe(true)
    } finally {
      await s.close()
    }
  })

  it('(18C2) k3 RED AT BASE: a one-element argv is run as a program name, never shell text (a path with a space)', async () => {
    const prog = join(BIN, 'r1a18c2 prog')
    writeFileSync(prog, '#!/bin/sh\nprintf "r1a18c2-ran\\n"\nexec cat\n', { mode: 0o755 })
    const s = await TerminalSession.spawn({
      name: 'r1a18c2-k3', cwd: WORK, allowlist: [WORK], ownerIdProvider: owner,
      descriptor: { id: 'shell', executable: prog, minStableMs: 0 } as Json,
    }).catch((e: Error) => e)
    try {
      expect(s).toBeInstanceOf(TerminalSession)
      await until(() => pane('r1a18c2-k3').includes('r1a18c2-ran'))
      expect(pane('r1a18c2-k3')).toContain('r1a18c2-ran')
    } finally {
      if (s instanceof TerminalSession) await s.close()
      else tx('kill-session', '-t', '=ccm-r1a18c2-k3')
    }
  })

  it('(18C2) k4 RED AT BASE: a new name with "." is refused at open (the existing text); nothing starts', async () => {
    const res = await TerminalSession.spawn({
      name: 'r1a18c2-k4.b', cwd: WORK, allowlist: [WORK], ownerIdProvider: owner,
      descriptor: { id: 'shell', argv: ['sh', '-c', 'exec cat'], minStableMs: 0 } as Json,
    }).catch((e: Error) => e)
    const started = res instanceof TerminalSession
    if (started) await res.close()
    expect(started).toBe(false)
    expect(String((res as Error).message)).toBe('invalid session name: r1a18c2-k4.b')
    expect(tx('has-session', '-t', '=ccm-r1a18c2-k4_b').status).not.toBe(0)
  })

  it('(18C2) k5 RED AT BASE: an existing session whose name had "." (tmux keeps it as "_") is alive under its own name and listed once', async () => {
    mkdirSync(join(TH, 'tmux'), { recursive: true, mode: 0o700 })
    chmodSync(join(TH, 'tmux'), 0o700)
    expect(tx('new-session', '-d', '-s', 'ccm-r1a18c2-k5.b', 'sleep', '600').status).toBe(0)
    try {
      expect(tx('has-session', '-t', '=ccm-r1a18c2-k5_b').status).toBe(0)
      expect(await TerminalSession.exists('r1a18c2-k5.b')).toBe(true)
      const name = 'r1a18c2-k5.b'
      registerLive({ id: name, engine: 'shell', cwd: WORK, isAlive: async () => true, attachHint: () => 'r1a18c2' } as Json)
      try {
        const { sessions } = await listSessions({
          allowlist: [WORK], enabledEngines: new Set(['shell']) as Json,
          listingDependencies: {
            ownerIdProvider: owner,
            provenanceReader: async () => ({ engine: 'shell', owner: 'r1a18c2-owner' }),
            tmuxFn: async () => `ccm-r1a18c2-k5_b|:|1|:|${WORK}\n`,
          } as Json,
        })
        expect(sessions.filter((x) => x.id.startsWith('r1a18c2-k5')).map((x) => x.id)).toEqual([name])
      } finally {
        unregisterLive(name)
      }
    } finally {
      tx('kill-session', '-t', '=ccm-r1a18c2-k5_b')
    }
  })
})
