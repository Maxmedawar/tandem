/**
 * U-R1A-27B: Interrupt-level mail presses the harness file's own interrupt key on a session that
 * reads `working`, once per newest Interrupt message (mailbox interruptFor), and 27A's notice line
 * follows once the session reads idle (bridge/delivery-notice.ts). An approval or unknown screen
 * gets no key and nothing typed. Whenever Tandem presses an interrupt key on a hook agent (this
 * mail path or the owner's interrupt route) the session's turn file goes, so the input gate stops
 * reading a stopped turn as working (HarnessSession.interrupt, bridge/delivery-hooks.ts clearTurn).
 *
 * tmux runs only on a private socket: before any import TMUX is unset and TMUX_TMPDIR is a new
 * r1a27b- folder; TANDEM_HOME and HOME live in it too. afterAll kills that folder's tmux servers
 * (after `test -S`) and removes it. The agent is a copy of test/fixtures/fake-cli.sh with one
 * added trap line, so C-c ends a `slow` turn and the prompt comes back.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-cli.sh', import.meta.url))
const BOX = mkdtempSync(join(tmpdir(), 'r1a27b-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
process.env.TANDEM_HOME = TH
const HOME = join(BOX, 'home')
mkdirSync(HOME)
process.env.HOME = HOME
const WORK = join(BOX, 'work')
mkdirSync(WORK)

// The fake with a trap: C-c ends `sleep 12`, the trap prints, the turn ends and `fake> ` is back.
const FAKE = join(BOX, 'fake-cli.sh')
{
  const lines = readFileSync(FIXTURE, 'utf8').split('\n')
  const at = lines.findIndex((l, i) => i > 0 && !l.startsWith('#'))
  lines.splice(at, 0, `trap 'printf "\\ninterrupted\\n"' INT`)
  writeFileSync(FAKE, lines.join('\n'), { mode: 0o755 })
}

const { noticePass } = await import('../bridge/delivery-notice.ts')
const { openMailbox, MailError } = await import('../bridge/mailbox.ts')
const { HarnessSession } = await import('../bridge/engines/harness-engine.ts')
const { registerLive, unregisterLive } = await import('../bridge/sessions.ts')
const { turnState } = await import('../bridge/delivery-hooks.ts')
const { route } = await import('../bridge/router.ts')
const { applyLimits } = await import('../bridge/limits.ts')
const { writeLimits } = await import('./fixtures/limits.ts')

writeLimits(TH, { interrupt_from: ['owner'] })
applyLimits()

const box = openMailbox()

afterAll(() => {
  box.close()
  const uid = process.getuid!()
  for (const sock of [join(BOX, `tmux-${uid}`, 'default'), join(BOX, 'tandem', 'tmux', 'tandem')]) {
    if (spawnSync('test', ['-S', sock]).status === 0) spawnSync('tmux', ['-S', sock, 'kill-server'])
  }
  rmSync(BOX, { recursive: true, force: true })
})

const SOCK = join(TH, 'tmux', 'tandem')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const LINE = 'Tandem: 1 messages waiting. Call mail_read.'

const STATES = {
  working: ['^fake is thinking\\z'],
  idle: ['^fake>\\z'],
  waiting_for_approval: ['\\(y/n\\)\\z'],
  debounce_ms: 300,
  precedence: ['waiting_for_approval', 'working', 'idle'],
}
function harness(name: string, delivery: 'hook' | 'notice'): Json {
  return {
    name, program: FAKE, programPath: FAKE, args: [], skip_prompts_args: [], resume: [], fork: [],
    has_prompts: true, delivery, ...(delivery === 'hook' ? { hook: '--settings' } : {}), permission_hook: false,
    reports_context: false, source: 'owner', file: join(BOX, `${name}.toml`), kind: 'agent', states: STATES,
    keys: { interrupt: 'C-c' },
  }
}

function screenOf(name: string): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'capture-pane', '-p', '-J', '-S', '-', '-t', `=ccm-${name}:`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
const count = (name: string, line: string) => screenOf(name).split('\n').filter((l) => l === line).length
const noticeLines = (name: string) => screenOf(name).split('\n').filter((l) => l.startsWith('reply: Tandem:'))

const auditLog = join(HOME, '.tandem', 'bridge.log')
const auditLines = (): Record<string, unknown>[] =>
  existsSync(auditLog) ? readFileSync(auditLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const interruptLines = (name: string) => auditLines().filter((l) => l.event === 'mail.interrupt' && l.name === name)

/** Spawns, registers, and counts every interrupt() call (one key press each, C-c). */
async function spawnFake(name: string, h: Json) {
  const s = await HarnessSession.spawn(h, { name, cwd: WORK, allowlist: [WORK] })
  registerLive(s)
  const presses = { n: 0 }
  const orig = s.interrupt.bind(s)
  s.interrupt = async () => {
    presses.n++
    await orig()
  }
  return { s, presses }
}
async function untilState(s: { inputState(): Promise<{ state: string }> }, want: string, ms = 30_000) {
  const end = Date.now() + ms
  let last = ''
  while (Date.now() < end) {
    last = (await s.inputState()).state
    if (last === want) return
    await sleep(100)
  }
  throw new Error(`state never became ${want}; last ${last}`)
}
/** A hook agent with a working turn file reads working at its prompt too: wait for the slow turn on screen. */
async function untilThinking(name: string, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end && !screenOf(name).trimEnd().endsWith('fake is thinking')) await sleep(100)
  expect(screenOf(name).trimEnd().endsWith('fake is thinking')).toBe(true)
}
async function done(name: string, s: { close(): Promise<void> }) {
  unregisterLive(name)
  await s.close()
}
const interrupt = (to: string, text = 'stop now', from = 'owner') => box.send({ from, to, level: 'interrupt', text })
const fyi = (to: string, text = 'a note') => box.send({ from: 'owner', to, level: 'fyi', text })
const turnFile = (name: string) => join(TH, 'delivery', `${name}.turn`)
function markWorking(name: string) {
  const settings = JSON.parse(readFileSync(join(TH, 'delivery', `${name}.settings.json`), 'utf8'))
  const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command
  const ran = spawnSync('sh', ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'r1a27b-sid', cwd: WORK }), encoding: 'utf8', timeout: 30_000 })
  expect(ran.status).toBe(0)
  expect(turnState(name)).toBe('working')
}
/** A registered stand-in: a fixed input state; counts key presses and typed text. */
function standIn(id: string, state: string | undefined) {
  const presses = { n: 0 }
  const typed: string[] = []
  registerLive({
    id, engine: 'r1a27b-fake', cwd: WORK, deliveryClass: () => 'notice',
    ...(state === undefined ? {} : { inputState: async () => ({ state, screen: 'x', debounceMs: 0 }) }),
    interrupt: async () => { presses.n++ },
    send: async (text: string) => { typed.push(text); return { status: 'done', report: '', cursor: 0 } },
  } as Json)
  return { presses, typed }
}

describe('(a) interruptFor: once per newest queued Interrupt message', () => {
  it('one queued -> true, again false, a second -> true; fyi and ask only -> false; relay-x 400', () => {
    const b = openMailbox({ path: join(BOX, 'a', 'state.db') })
    const to = 'r1a27b-ia'
    b.send({ from: 'owner', to, level: 'interrupt', text: 'one' })
    expect(b.interruptFor(to)).toBe(true)
    expect(b.interruptFor(to)).toBe(false)
    b.send({ from: 'owner', to, level: 'interrupt', text: 'two' })
    expect(b.interruptFor(to)).toBe(true)
    expect(b.interruptFor(to)).toBe(false)
    const quiet = 'r1a27b-ib'
    b.send({ from: 'owner', to: quiet, level: 'fyi', text: 'f' })
    b.send({ from: 'owner', to: quiet, level: 'ask', text: 'q' })
    expect(b.interruptFor(quiet)).toBe(false)
    let status: number | undefined
    try {
      b.interruptFor('relay-x')
    } catch (e) {
      expect(e).toBeInstanceOf(MailError)
      status = (e as InstanceType<typeof MailError>).status
    }
    expect(status).toBe(400)
    b.close()
  })
})

describe('(b)-(e) the pass over live fake agents', () => {
  it('(b) working + Interrupt mail: one key, one mail.interrupt line; idle within 3 s; next pass one line; a third pass nothing', async () => {
    const name = 'r1a27b-busy'
    const { s, presses } = await spawnFake(name, harness('r1a27b-fake', 'notice'))
    try {
      await untilState(s, 'idle')
      void s.send('slow').catch(() => undefined)
      await untilState(s, 'working', 10_000)
      interrupt(name)
      const first = await noticePass(box)
      expect(first.typed).toEqual([])
      expect(presses.n).toBe(1)
      expect(interruptLines(name)).toEqual([expect.objectContaining({ event: 'mail.interrupt', name, engine: 'r1a27b-fake' })])
      await untilState(s, 'idle', 3_000)
      expect(count(name, 'interrupted')).toBe(1)
      expect(await noticePass(box)).toEqual({ typed: [name], held: [] })
      const end = Date.now() + 10_000
      while (Date.now() < end && noticeLines(name).length < 1) await sleep(100)
      await sleep(800)
      expect(noticeLines(name)).toEqual([`reply: ${LINE}`])
      await untilState(s, 'idle')
      expect((await noticePass(box)).typed).toEqual([])
      await sleep(800)
      expect(presses.n).toBe(1)
      expect(interruptLines(name)).toHaveLength(1)
      expect(noticeLines(name)).toHaveLength(1)
      expect(count(name, 'interrupted')).toBe(1)
    } finally {
      await done(name, s)
    }
  }, 60_000)

  it('(c) only fyi while slow: no key, nothing typed until the turn ends, then one line', async () => {
    const name = 'r1a27b-fyi'
    const { s, presses } = await spawnFake(name, harness('r1a27b-fake', 'notice'))
    try {
      await untilState(s, 'idle')
      void s.send('slow').catch(() => undefined)
      await untilState(s, 'working', 10_000)
      fyi(name)
      for (let k = 0; k < 2; k++) expect(await noticePass(box)).toEqual({ typed: [], held: [name] })
      expect(presses.n).toBe(0)
      expect(interruptLines(name)).toEqual([])
      expect(screenOf(name)).not.toContain('Tandem:')
      await untilState(s, 'idle', 20_000)
      expect(screenOf(name)).toContain('reply: slow done')
      expect(count(name, 'interrupted')).toBe(0)
      expect(await noticePass(box)).toEqual({ typed: [name], held: [] })
      const end = Date.now() + 10_000
      while (Date.now() < end && noticeLines(name).length < 1) await sleep(100)
      expect(noticeLines(name)).toEqual([`reply: ${LINE}`])
      expect(presses.n).toBe(0)
    } finally {
      await done(name, s)
    }
  }, 60_000)

  it('(d) an approval question: no key, nothing typed, the question stays; no inputState (unknown): no key', async () => {
    const name = 'r1a27b-asking'
    const blind = 'r1a27b-blind'
    const { s, presses } = await spawnFake(name, harness('r1a27b-fake', 'notice'))
    const b = standIn(blind, undefined)
    try {
      await untilState(s, 'idle')
      void s.send('ask').catch(() => undefined)
      await untilState(s, 'waiting_for_approval', 10_000)
      interrupt(name)
      interrupt(blind)
      for (let k = 0; k < 2; k++) {
        const r = await noticePass(box)
        expect(r.typed).toEqual([])
        expect([...r.held].sort()).toEqual([name, blind].sort())
      }
      await sleep(500)
      expect(presses.n).toBe(0)
      expect(b.presses.n).toBe(0)
      expect(b.typed).toEqual([])
      expect(interruptLines(name)).toEqual([])
      expect(interruptLines(blind)).toEqual([])
      expect(screenOf(name)).not.toContain('Tandem:')
      expect(screenOf(name).trimEnd().endsWith('(y/n)')).toBe(true)
      expect((await s.inputState()).state).toBe('waiting_for_approval')
    } finally {
      unregisterLive(blind)
      await done(name, s)
    }
  }, 60_000)

  it('(e) hook agent, turn file working, slow: Interrupt mail: one key, the turn file gone when interrupt() returns, idle once the prompt is back', async () => {
    const name = 'r1a27b-hooked'
    const { s, presses } = await spawnFake(name, harness('r1a27b-hookfake', 'hook'))
    const goneAfter: boolean[] = []
    const counted = s.interrupt
    s.interrupt = async () => {
      await counted()
      goneAfter.push(!existsSync(turnFile(name)))
    }
    try {
      expect(s.deliveryClass()).toBe('hook')
      await untilState(s, 'idle')
      markWorking(name)
      void s.send('slow').catch(() => undefined)
      await untilThinking(name)
      interrupt(name)
      expect((await noticePass(box)).typed).toEqual([])
      expect(presses.n).toBe(1)
      expect(goneAfter).toEqual([true])
      expect(existsSync(turnFile(name))).toBe(false)
      await untilState(s, 'idle', 3_000)
      expect(turnState(name)).toBeUndefined()
      expect(count(name, 'interrupted')).toBe(1)
    } finally {
      await done(name, s)
    }
  }, 60_000)
})

describe('(f) the owner\'s interrupt route', () => {
  it('a hook harness session with a working turn file: gone afterwards; a notice session\'s interrupt leaves its file alone', async () => {
    const hooked = 'r1a27b-rhook'
    const plain = 'r1a27b-rplain'
    const h = await spawnFake(hooked, harness('r1a27b-hookfake', 'hook'))
    const p = await spawnFake(plain, harness('r1a27b-fake', 'notice'))
    const rq = (name: string) => route({ method: 'POST', path: `/sessions/${name}/interrupt`, query: new URLSearchParams(), body: {} })
    try {
      await untilState(h.s, 'idle')
      await untilState(p.s, 'idle')
      markWorking(hooked)
      const plainTurn = turnFile(plain)
      const kept = JSON.stringify({ state: 'working', at: new Date().toISOString() })
      writeFileSync(plainTurn, kept, { mode: 0o600 })
      for (const s of [h.s, p.s]) void s.send('slow').catch(() => undefined)
      await untilThinking(hooked)
      await untilState(p.s, 'working', 10_000)
      expect(await rq(hooked)).toMatchObject({ status: 200 })
      expect(h.presses.n).toBe(1)
      expect(existsSync(turnFile(hooked))).toBe(false)
      expect(await rq(plain)).toMatchObject({ status: 200 })
      expect(p.presses.n).toBe(1)
      expect(readFileSync(plainTurn, 'utf8')).toBe(kept)
      await untilState(h.s, 'idle', 3_000)
    } finally {
      await done(hooked, h.s)
      await done(plain, p.s)
    }
  }, 60_000)
})

describe('(g) who may interrupt is unchanged; one key per newest message', () => {
  it('a sender not in interrupt_from: 403 at send, no key; a stuck working session: one key per newest Interrupt message', async () => {
    const name = 'r1a27b-stuck'
    const st = standIn(name, 'working')
    try {
      let status: number | undefined
      try {
        interrupt(name, 'from a stranger', 'session:r1a27b-stranger')
      } catch (e) {
        expect(e).toBeInstanceOf(MailError)
        status = (e as InstanceType<typeof MailError>).status
      }
      expect(status).toBe(403)
      expect(box.pending(name).interrupt).toBe(0)
      await noticePass(box)
      expect(st.presses.n).toBe(0)
      interrupt(name)
      for (let k = 0; k < 3; k++) await noticePass(box)
      expect(st.presses.n).toBe(1)
      interrupt(name, 'again')
      for (let k = 0; k < 2; k++) await noticePass(box)
      expect(st.presses.n).toBe(2)
      expect(interruptLines(name)).toHaveLength(2)
      expect(st.typed).toEqual([])
    } finally {
      unregisterLive(name)
    }
  }, 30_000)
})
