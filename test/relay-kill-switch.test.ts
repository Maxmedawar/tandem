/**
 * U-R1A-35B (35 audit G2): a running relay waits while the kill switch is on instead of spending
 * its turns. runTask (bridge/relay.ts, exported as runTaskForTest) is driven directly with a
 * RelayLoop-shaped object whose lead and worker are fakes: each send throws KillSwitchError while
 * the switch reads on, as TerminalSession.send does. The switch file is toggled in this file's own
 * TANDEM_HOME (an r1a35b- folder, HOME too, set before any import). No real agent, no tmux.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BOX = mkdtempSync(join(tmpdir(), 'r1a35b-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
mkdirSync(HOME)
mkdirSync(TH, { mode: 0o700 })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH

const relay = await import('../bridge/relay.ts')
const { KILL_SWITCH_ON, KillSwitchError, killSwitchOn } = await import('../bridge/kill-switch.ts')
const { initManagerMemory } = await import('../bridge/manager.ts')

const SWITCH = join(TH, 'kill-switch')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
vi.setConfig({ testTimeout: 30_000 })
afterAll(() => rmSync(BOX, { recursive: true, force: true }))

const on = () => writeFileSync(SWITCH, `on ${new Date().toISOString()}\n`, { mode: 0o600 })
const off = () => rmSync(SWITCH, { force: true })

interface Sent { text: string; whileOn: boolean }
/** A session that answers `replies` in order; `before(call)` may act first (turn the switch on, throw, or return a report). */
function fakeSession(name: string, replies: string[], before?: (call: number) => string | undefined) {
  const sent: Sent[] = []
  return {
    name,
    sent,
    async send(text: string) {
      const whileOn = killSwitchOn()
      sent.push({ text, whileOn })
      const early = before?.(sent.length)
      if (early !== undefined) return { report: early }
      if (killSwitchOn()) throw new KillSwitchError()
      await sleep(5)
      return { report: replies.shift() ?? 'DONE' }
    },
    async interrupt() {},
  }
}

let n = 0
function fakeLoop(lead: ReturnType<typeof fakeSession>, worker: ReturnType<typeof fakeSession>) {
  const dir = join(BOX, `loop-${++n}`)
  initManagerMemory(dir, { goal: 'r35b goal' })
  return {
    loopId: `r35b-${n}`, leadName: 'l', workerName: 'w', lead, worker, logPath: join(dir, 'transcript.log'), cwd: BOX, memDir: dir,
    running: true, deadline: Date.now() + 60_000, finished: Promise.resolve(), maxTurns: 6, perTaskWallClockMs: 60_000,
    idleTimeoutMs: 5_000, answerIdleTimeoutMs: 5_000, parked: false,
  }
}
const run = (loop: ReturnType<typeof fakeLoop>) =>
  relay.runTaskForTest(loop as unknown as Parameters<typeof relay.runTaskForTest>[0], 'go', loop.maxTurns)
const log = (loop: ReturnType<typeof fakeLoop>) => (existsSync(loop.logPath) ? readFileSync(loop.logPath, 'utf8') : '')
const turns = (loop: ReturnType<typeof fakeLoop>) => (log(loop).match(/^--- turn \d+\//gm) ?? []).length
const sysLines = (loop: ReturnType<typeof fakeLoop>, text: string) => log(loop).split('\n').filter((l) => l === text).length
const stateTurn = (loop: ReturnType<typeof fakeLoop>) => JSON.parse(readFileSync(join(loop.memDir, 'STATE.json'), 'utf8')).turn
const sendsWhileOn = (...s: ReturnType<typeof fakeSession>[]) => s.flatMap((x) => x.sent).filter((x) => x.whileOn).length

/** The run with no switch: the lead instructs once, the worker reports, the lead says DONE. */
async function baseline(): Promise<number> {
  off()
  const loop = fakeLoop(fakeSession('lead', ['step one', 'DONE']), fakeSession('worker', ['did it']))
  expect(await run(loop)).toEqual({ kind: 'done' })
  return turns(loop)
}

describe('(r) the relay while the kill switch is on', () => {
  it('(35B) r1 RED AT BASE: switch on before turn 1 for 3 s: no send while on, the turn counter does not move, one paused and one resumed line; the same turns as no switch; deadline later by the pause', async () => {
    const want = await baseline()
    expect(want).toBe(2)
    const lead = fakeSession('lead', ['step one', 'DONE'])
    const worker = fakeSession('worker', ['did it'])
    const loop = fakeLoop(lead, worker)
    const deadline0 = loop.deadline
    on()
    const t0 = Date.now()
    let offAt = 0
    setTimeout(() => {
      off()
      offAt = Date.now()
    }, 3_000)
    const p = run(loop)
    await sleep(1_500)
    const mid = { turnsSoFar: turns(loop), stateTurn: stateTurn(loop), sendsWhileOn: sendsWhileOn(lead, worker) }
    const outcome = await p
    expect({ outcome, turns: turns(loop), sendsWhileOn: sendsWhileOn(lead, worker), mid }).toEqual({
      outcome: { kind: 'done' }, turns: want, sendsWhileOn: 0, mid: { turnsSoFar: 1, stateTurn: 1, sendsWhileOn: 0 },
    })
    expect([sysLines(loop, 'paused: kill switch on'), sysLines(loop, 'resumed')]).toEqual([1, 1])
    expect(offAt).toBeGreaterThan(0)
    expect(loop.deadline - deadline0).toBeGreaterThanOrEqual(offAt - t0 - 50)
  })

  it('(35B) r2 the switch turned on during a lead send (KillSwitchError once): after off the SAME text is sent again; the worker never sees `kill switch on`; turns as with no switch', async () => {
    const want = await baseline()
    const lead = fakeSession('lead', ['step one', 'DONE'], (call) => {
      if (call !== 1) return undefined
      on()
      setTimeout(off, 2_000)
      throw new KillSwitchError()
    })
    const worker = fakeSession('worker', ['did it'])
    const loop = fakeLoop(lead, worker)
    expect(await run(loop)).toEqual({ kind: 'done' })
    expect(lead.sent.length).toBe(3)
    expect(lead.sent[1].text).toBe(lead.sent[0].text)
    expect(lead.sent[1].whileOn).toBe(false)
    expect(worker.sent.map((s) => s.text)).toEqual(['step one'])
    expect(worker.sent.some((s) => s.text.includes('kill switch on'))).toBe(false)
    expect(turns(loop)).toBe(want)
    expect(sysLines(loop, 'paused: kill switch on')).toBe(1)
  })

  it('(35B) r3 stop() during a pause: runTask returns within 1.5 s with the stopped outcome', async () => {
    const loop = fakeLoop(fakeSession('lead', ['step one', 'DONE']), fakeSession('worker', ['did it']))
    on()
    const p = run(loop)
    await sleep(500)
    expect(sysLines(loop, 'paused: kill switch on')).toBe(1)
    const t = Date.now()
    loop.running = false // as stop() flips it
    const outcome = await p
    expect(Date.now() - t).toBeLessThan(1_500)
    expect(outcome).toEqual({ kind: 'stopped' })
    expect(sendsWhileOn(loop.lead, loop.worker)).toBe(0)
    off()
  })

  it('(35B) r4 a send whose report text carries KILL_SWITCH_ON is treated as r2: the same text again after off, never passed to the worker', async () => {
    const want = await baseline()
    const lead = fakeSession('lead', ['step one', 'DONE'], (call) => {
      if (call !== 1) return undefined
      on()
      setTimeout(off, 1_500)
      return `(session error: ${KILL_SWITCH_ON})`
    })
    const worker = fakeSession('worker', ['did it'])
    const loop = fakeLoop(lead, worker)
    expect(await run(loop)).toEqual({ kind: 'done' })
    expect(lead.sent[1].text).toBe(lead.sent[0].text)
    expect(worker.sent.map((s) => s.text)).toEqual(['step one'])
    expect(worker.sent.some((s) => s.text.includes(KILL_SWITCH_ON))).toBe(false)
    expect(turns(loop)).toBe(want)
  })

  it('(35B) r4 the worker send refused by the switch: the worker gets the same instruction again, the lead never sees the refusal', async () => {
    const want = await baseline()
    const lead = fakeSession('lead', ['step one', 'DONE'])
    const worker = fakeSession('worker', ['did it'], (call) => {
      if (call !== 1) return undefined
      on()
      setTimeout(off, 1_500)
      throw new KillSwitchError()
    })
    const loop = fakeLoop(lead, worker)
    expect(await run(loop)).toEqual({ kind: 'done' })
    expect(worker.sent.map((s) => s.text)).toEqual(['step one', 'step one'])
    expect(lead.sent.some((s) => s.text.includes(KILL_SWITCH_ON))).toBe(false)
    expect(turns(loop)).toBe(want)
  })

  it('(35B) a7 (audit) a report that only quotes the kill switch text while the switch is off is a turn like any other: passed on once, never sent again', async () => {
    off()
    const quote = `I read bridge/kill-switch.ts: it says "${KILL_SWITCH_ON}"`
    const lead = fakeSession('lead', ['step one', 'DONE'])
    const worker = fakeSession('worker', ['did it'], (call) => (call === 1 ? quote : undefined))
    const loop = fakeLoop(lead, worker)
    loop.deadline = Date.now() + 4_000
    expect(await run(loop)).toEqual({ kind: 'done' })
    expect(worker.sent.length).toBe(1)
    expect(lead.sent.length).toBe(2)
    expect(lead.sent[1].text).toContain(quote)
    expect(turns(loop)).toBe(2)
    expect(sysLines(loop, 'paused: kill switch on')).toBe(0)
  })
})
