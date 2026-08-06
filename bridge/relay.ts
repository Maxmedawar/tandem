/**
 * bridge/relay.ts — the ZERO-API peer-to-peer relay (replaces the removed API brain).
 *
 * Connects TWO interactive tmux-hosted Claude Code sessions, both billed against
 * Max's real interactive subscription (NEVER the Messages API — there is no
 * @anthropic-ai/sdk here, and we never set ANTHROPIC_API_KEY):
 *
 *   - the LEAD ("brain") session, seeded as the reviewer/strategist. Each round
 *     it emits ONE concrete instruction for the worker (or the DONE sentinel).
 *   - the WORKER session, which does the hands-on work and reports back.
 *
 * Both are TerminalSession instances driven through the SHARED INTERFACE CONTRACT
 * (./terminal-session). The relay owns the conversation: lead.send -> worker.send
 * -> feed the worker report back to the lead as the next message, until the lead
 * says DONE, maxTurns is hit, the wall-clock deadline passes, or stop() is called.
 *
 * SAFETY (prior review flagged these):
 *   - maxTurns is a HARD ceiling clamp (default 24, client values above
 *     MAX_TURNS_CEILING are ignored).
 *   - a wall-clock cap (default 30min) is CHECKED DURING awaits: every send() is
 *     raced against the loop deadline, not merely checked between turns, so a
 *     single hung turn can never blow past the budget. On deadline (or stop) the
 *     active session is interrupt()'d so it stops promptly.
 *   - robust DONE detection: case-insensitive "DONE" on its own line, tolerating
 *     surrounding markdown / trailing punctuation.
 *   - stop()/inject() take effect promptly — stop() flips the running flag AND
 *     interrupts both sessions; inject() rewrites the next lead input.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalSession } from './terminal-session.ts'
import { emitCompletion, emitEscalation, emitNeedsInput } from './events.ts'
import {
  managerDir,
  initManagerMemory,
  appendDecision,
  updateState,
  regroundPreamble,
  parseBlocked,
  parseNeedsInput,
  enqueueTask,
  dequeueTask,
  readQueue,
  setAnswer,
  readAnswer,
  takeAnswer,
  clearAnswer,
} from './manager.ts'

const HOME = homedir()
const RELAY_DIR = join(HOME, '.tandem', 'relay')

/** Defaults + hard ceilings. Client-supplied values are clamped to these. */
const DEFAULT_MAX_TURNS = 24
const MAX_TURNS_CEILING = 50
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000 // 30 minutes — now PER TASK (Phase 6b)
/**
 * Phase 6b: how long a manager stays PARKED (idle, alive) awaiting the next task
 * before it tears itself down. Bounded so an abandoned manager never lingers
 * forever holding two tmux sessions.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000 // 15 minutes
const IDLE_TIMEOUT_CEILING_MS = 60 * 60_000 // 1 hour
/**
 * Phase 6c: when the manager is parked AWAITING A HUMAN ANSWER (it asked a
 * question), it waits longer than the routine idle cap — a human needs time to
 * see the buzz and reply — but still bounded so an unanswered manager tears down
 * rather than holding two tmux sessions forever.
 */
const DEFAULT_ANSWER_IDLE_TIMEOUT_MS = 60 * 60_000 // 1 hour
const ANSWER_IDLE_CEILING_MS = 6 * 60 * 60_000 // 6 hours
/** Hard cap on pending queued tasks, so enqueue can't grow the backlog unbounded. */
const MAX_QUEUE_DEPTH = 64

/** The seed that turns the lead session into the strategist/reviewer. */
function leadSeed(goal: string, context?: string): string {
  const spec = context && context.trim() ? `\n\nRelevant spec / context:\n${context.trim()}\n` : ''
  return [
    'You drive a SECOND Claude Code session (the "worker") to achieve a goal.',
    'You are the lead/strategist and reviewer. You do NOT touch files yourself —',
    'the worker does the hands-on work. Each turn, reply with ONE concrete,',
    'self-contained instruction for the worker (it has no memory of this',
    'conversation, so include any needed context in the instruction). After the',
    'worker reports back, review its work against the goal and either give the',
    'next single instruction, or — when the goal is fully achieved — output DONE',
    'on a line by itself. Keep instructions short and actionable.',
    spec,
    `\nGOAL: ${goal}`,
    '\nReply now with your FIRST instruction for the worker.',
  ].join('\n')
}

/** How a worker report is wrapped before being fed back to the lead. */
function wrapWorkerReport(report: string): string {
  return [
    'The worker session ran your instruction and reported back:',
    '"""',
    report.trim(),
    '"""',
    'Review this against the GOAL. Reply with the next single instruction for the',
    'worker, or output DONE on its own line if the goal is now fully achieved.',
  ].join('\n')
}

/**
 * DONE detection. Accepts a "DONE" sentinel on its own line, case-insensitive,
 * tolerating surrounding markdown and trailing punctuation. Examples that match:
 *   DONE            done.           **DONE**          > DONE!
 *   - done          ## DONE         `DONE`            DONE:
 * We deliberately require it on its OWN line so the word "done" inside a normal
 * sentence ("almost done with step 2") does NOT trip the sentinel.
 */
export function isDone(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip leading markdown bullets/quotes/heading marks and surrounding
    // emphasis/backtick/whitespace, then any trailing punctuation.
    const line = rawLine
      .replace(/^\s*(?:[>*\-+#]\s*)*/, '') // leading markers
      .replace(/^[*_`"'(\[\s]+/, '') // leading emphasis/quote/bracket
      .replace(/[*_`"')\].!?:;,\s]+$/, '') // trailing emphasis/punct
      .trim()
    if (line.toUpperCase() === 'DONE') return true
  }
  return false
}

/** A single running relay loop. */
interface RelayLoop {
  loopId: string
  leadName: string
  workerName: string
  lead: TerminalSession
  worker: TerminalSession
  logPath: string
  /** the validated working directory both sessions run in (used for git handoff facts). */
  cwd: string
  /** disk-backed manager memory dir (MISSION/STATE/LOG/QUEUE) — durable on disk. */
  memDir: string
  running: boolean
  /** Set by inject(): overrides the next message fed to the lead. */
  pendingInjection?: string
  /** The session currently inside an awaited send(), so stop() can interrupt it. */
  active?: TerminalSession
  /** Absolute wall-clock deadline (ms epoch) for the CURRENT task. */
  deadline: number
  finished: Promise<void>
  // ---- Phase 6b: park-and-wait ----
  /** Per-task hard caps, reset for each new task. */
  maxTurns: number
  perTaskWallClockMs: number
  /** How long to stay parked before tearing down. */
  idleTimeoutMs: number
  /** Longer cap used while parked awaiting a human answer (pendingQuestion set). */
  answerIdleTimeoutMs: number
  /** Set while the manager has asked a question and is awaiting the human's answer. */
  pendingQuestion?: string
  /** True while the manager is parked (idle, awaiting the next task). */
  parked: boolean
  /** Resolver armed only while parked; enqueue()/stop() call it to wake the loop. */
  wake?: (reason: 'task' | 'stop' | 'idle') => void
  /** The active idle-timeout timer while parked (cleared on wake). */
  idleTimer?: ReturnType<typeof setTimeout>
}

const loops = new Map<string, RelayLoop>()

function ensureRelayDir(): void {
  mkdirSync(RELAY_DIR, { recursive: true })
}

/** Append a tagged line to the dual transcript. The byte length is the cursor. */
function transcript(loop: RelayLoop, tag: 'LEAD' | 'WORKER' | 'SYS', text: string): void {
  const block = `\n[${tag}] ${new Date().toISOString()}\n${text.trimEnd()}\n`
  try {
    appendFileSync(loop.logPath, block)
  } catch (e) {
    // Surface — do not silently swallow (mirrors the bridge audit-log rule).
    process.stderr.write(
      `[relay] transcript write failed for ${loop.loopId}: ${e instanceof Error ? e.message : String(e)}\n`,
    )
  }
  // Also render live to stdout so Max watching the bridge sees both sides talk.
  process.stdout.write(block)
}

export interface StartRelayOptions {
  goal: string
  cwd: string
  /** Clamped to [1, MAX_TURNS_CEILING]; defaults to DEFAULT_MAX_TURNS. */
  maxTurns?: number
  /** Optional per-task wall-clock cap override (ms); clamped to <= DEFAULT_WALL_CLOCK_MS. */
  wallClockMs?: number
  /** Optional idle-park timeout (ms); clamped to <= IDLE_TIMEOUT_CEILING_MS. */
  idleTimeoutMs?: number
  /** Optional answer-park timeout (ms); clamped to <= ANSWER_IDLE_CEILING_MS. */
  answerIdleTimeoutMs?: number
  /** Spec/context text seeded into the lead. */
  context?: string
  /** cwd allowlist passed straight through to TerminalSession.spawn. */
  allowlist?: string[]
}

export interface StartRelayResult {
  loopId: string
  leadName: string
  workerName: string
}

/** Clamp a possibly-untrusted turn count to the safe hard ceiling. */
function clampMaxTurns(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_TURNS
  const n = Math.floor(requested)
  if (n < 1) return DEFAULT_MAX_TURNS
  return Math.min(n, MAX_TURNS_CEILING)
}

/**
 * Spawn the two sessions, seed the lead, and kick off the loop in the
 * BACKGROUND. Returns immediately with the ids so the caller (bridge router)
 * never blocks the tunnel; progress is observed via readSince().
 */
export async function startRelay(opts: StartRelayOptions): Promise<StartRelayResult> {
  ensureRelayDir()
  const loopId = randomUUID().slice(0, 8)
  const maxTurns = clampMaxTurns(opts.maxTurns)
  const wallClockMs = Math.min(
    opts.wallClockMs && opts.wallClockMs > 0 ? opts.wallClockMs : DEFAULT_WALL_CLOCK_MS,
    DEFAULT_WALL_CLOCK_MS,
  )

  const leadName = `relay-${loopId}-lead`
  const workerName = `relay-${loopId}-worker`

  // The bridge always passes a built allowlist; default to an empty list (which
  // makes spawn reject every cwd) if a caller omits it, so the type contract is
  // satisfied and an unguarded call can never spawn outside the boundary.
  const allowlist = opts.allowlist ?? []

  // Spawn both interactive sessions. cwd is validated against the allowlist
  // INSIDE TerminalSession.spawn (per the shared contract).
  const lead = await TerminalSession.spawn({ name: leadName, cwd: opts.cwd, allowlist })
  let worker: TerminalSession
  try {
    worker = await TerminalSession.spawn({ name: workerName, cwd: opts.cwd, allowlist })
  } catch (e) {
    // Don't leak the lead session if the worker fails to come up.
    await lead.close().catch(() => {})
    throw e
  }

  // Both TUIs must actually be at their prompt before we start typing into them.
  // spawn()'s own warmup() may have left either NOT ready (e.g. the host was
  // CPU-starved spawning two interactive sessions back to back) — TerminalSession
  // still hands back the session in that case so a human can attach and kick it,
  // but the relay has no human watching, so a not-ready worker previously got
  // driven anyway: send() typed into its still-booting pane, and the frozen boot
  // banner (stable, non-working) was misread as a finished, empty turn within a
  // few seconds. Give each session one more bounded chance via the SAME
  // readiness-poll logic warmup() uses (ensureReady()), and fail loudly instead
  // of silently seeding a dead session if it still isn't ready.
  const [leadReady, workerReady] = await Promise.all([lead.ensureReady(), worker.ensureReady()])
  if (!leadReady || !workerReady) {
    const reasons = [
      !leadReady ? `lead: ${lead.readinessWarning ?? 'did not reach the prompt'}` : null,
      !workerReady ? `worker: ${worker.readinessWarning ?? 'did not reach the prompt'}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    await lead.close().catch(() => {})
    await worker.close().catch(() => {})
    throw new Error(`relay sessions did not reach the prompt before starting: ${reasons}`)
  }

  // Seed the manager's disk-backed memory (mission/state/log) so the loop is
  // resumable and can escalate; failures here never block the loop.
  const memDir = managerDir(loopId)
  initManagerMemory(memDir, { goal: opts.goal, context: opts.context })

  const idleTimeoutMs = Math.min(
    opts.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    IDLE_TIMEOUT_CEILING_MS,
  )
  const answerIdleTimeoutMs = Math.min(
    opts.answerIdleTimeoutMs && opts.answerIdleTimeoutMs > 0 ? opts.answerIdleTimeoutMs : DEFAULT_ANSWER_IDLE_TIMEOUT_MS,
    ANSWER_IDLE_CEILING_MS,
  )

  const loop: RelayLoop = {
    loopId,
    leadName: lead.name,
    workerName: worker.name,
    lead,
    worker,
    logPath: join(RELAY_DIR, `${loopId}.log`),
    cwd: opts.cwd,
    memDir,
    running: true,
    deadline: Date.now() + wallClockMs,
    finished: Promise.resolve(),
    maxTurns,
    perTaskWallClockMs: wallClockMs,
    idleTimeoutMs,
    answerIdleTimeoutMs,
    parked: false,
  }
  loops.set(loopId, loop)

  transcript(loop, 'SYS', `relay started · goal: ${opts.goal}\ncwd: ${opts.cwd}\nmaxTurns: ${maxTurns}/task · wallClock: ${Math.round(wallClockMs / 60_000)}min/task · idle park: ${Math.round(idleTimeoutMs / 60_000)}min`)
  transcript(loop, 'SYS', `attach lead:   ${lead.attachHint()}\nattach worker: ${worker.attachHint()}`)

  loop.finished = runManager(loop, opts.goal, opts.context)

  return { loopId, leadName: lead.name, workerName: worker.name }
}

/**
 * Race a session.send() against the loop deadline AND the running flag. If the
 * deadline passes (or stop() flips running) while we are awaiting, we interrupt
 * the active session so it stops promptly and resolve with a timeout marker —
 * the wall-clock / stop budget is therefore enforced DURING the await, not only
 * between turns.
 */
async function sendRaced(
  loop: RelayLoop,
  session: TerminalSession,
  text: string,
): Promise<
  | { kind: 'report'; report: string }
  | { kind: 'deadline' }
  | { kind: 'stopped' }
> {
  loop.active = session
  let watchdog: ReturnType<typeof setInterval> | undefined
  try {
    const sendP = (async () => {
      const startCursor = session.currentCursor()
      let result = await session.send(text)
      // send() returns status:'running' at its soft cap (~25s) if the turn hasn't
      // gone idle yet — a real Claude Code turn routinely takes longer than that.
      // Treating that as a finished report (the original bug) hands the lead an
      // EMPTY worker report and fires the next instruction into a still-busy pane,
      // which the busy session then echoes back on the following turn. Keep
      // polling the SAME turn (same startCursor, no re-submit) until it genuinely
      // finishes or the outer race (deadline/stop, checked by `guard` below)
      // interrupts it.
      while (result.status === 'running' && loop.running && Date.now() < loop.deadline) {
        result = await session.continueWaiting(startCursor)
      }
      return result.report
    })().then(
      (report: string) => ({ kind: 'report' as const, report }),
      (e: unknown) => ({ kind: 'report' as const, report: `(session error: ${e instanceof Error ? e.message : String(e)})` }),
    )
    const guard = new Promise<{ kind: 'deadline' } | { kind: 'stopped' }>((res) => {
      watchdog = setInterval(() => {
        if (!loop.running) {
          res({ kind: 'stopped' })
        } else if (Date.now() >= loop.deadline) {
          res({ kind: 'deadline' })
        }
      }, 500)
    })
    const winner = await Promise.race([sendP, guard])
    if (winner.kind !== 'report') {
      // We are abandoning this turn — stop the runaway TUI turn promptly.
      await session.interrupt().catch(() => {})
    }
    return winner
  } finally {
    if (watchdog) clearInterval(watchdog)
    loop.active = undefined
  }
}

/** The terminal outcome of a single task's inner loop. */
type TaskOutcome =
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'needsinput'; question: string } // asked the human — park ALIVE, resume on answer
  | { kind: 'stopped' }
  | { kind: 'deadline' } // this task hit its wall-clock cap (not fatal — park after)
  | { kind: 'maxturns' } // this task hit its per-task turn cap (not fatal — park after)

/**
 * How a resumed task is framed after the human answers a NEEDS_INPUT question.
 * Restates the question + answer and tells the lead to RESUME (its in-flight
 * state is reconstructed from the standing memory re-fed each turn).
 */
function answerSeed(answer: string, question: string): string {
  return [
    'The human has ANSWERED the question you were waiting on.',
    `\nYour question was: ${question}`,
    `Their answer: ${answer}`,
    '\nYour mission and decision log are in the standing memory above. RESUME the',
    'work using this answer — reply with your next instruction for the worker, or',
    'DONE on its own line if the task is now complete.',
  ].join('\n')
}

/** How a follow-up task (after the first) is framed for the already-seeded lead. */
function taskSeed(task: string): string {
  return [
    'A NEW TASK has arrived. You are still the same lead/strategist — your mission',
    'and decision log are in the standing memory above. Drive the worker to achieve',
    'this task: reply with ONE concrete instruction at a time, review each report,',
    'and output DONE on its own line when THIS task is complete (or "BLOCKED:',
    '<reason>" on its own line if you need the human).',
    `\nNEW TASK: ${task}`,
    '\nReply now with your FIRST instruction for the worker.',
  ].join('\n')
}

/**
 * Run ONE task to a terminal outcome: the lead<->worker turn loop. Bounded by the
 * per-task turn cap and the per-task wall-clock deadline (loop.deadline, reset by
 * the caller). Returns the outcome; never tears anything down (the outer manager
 * loop owns lifecycle). Does not throw — a thrown send surfaces as a turn report.
 */
async function runTask(loop: RelayLoop, firstLeadMessage: string, maxTurns: number): Promise<TaskOutcome> {
  let nextLeadMessage = firstLeadMessage

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (!loop.running) return { kind: 'stopped' }
    if (Date.now() >= loop.deadline) return { kind: 'deadline' }

    // An inject() takes precedence as the next thing the lead hears.
    if (loop.pendingInjection !== undefined) {
      nextLeadMessage = `Operator injected a message: ${loop.pendingInjection}\n\n${nextLeadMessage}`
      loop.pendingInjection = undefined
    }

    // Re-ground the lead from disk every turn (mission + recent decisions) so it
    // stays on-mission across context compaction, and record the turn.
    updateState(loop.memDir, { turn, status: 'running' })
    const preamble = regroundPreamble(loop.memDir)
    const leadMessage = preamble ? `${preamble}\n${nextLeadMessage}` : nextLeadMessage

    // --- LEAD turn: produce one instruction (or DONE/BLOCKED) ---
    transcript(loop, 'SYS', `--- turn ${turn}/${maxTurns} ---`)
    const leadRes = await sendRaced(loop, loop.lead, leadMessage)
    if (leadRes.kind === 'deadline') return { kind: 'deadline' }
    if (leadRes.kind === 'stopped') return { kind: 'stopped' }
    const leadInstruction = leadRes.report
    transcript(loop, 'LEAD', leadInstruction)

    // Terminal BLOCKED is checked FIRST: a real unrecoverable dead-end must win
    // over a (non-terminal) NEEDS_INPUT or DONE appearing on another line — a
    // genuine block must never be silently downgraded to a stay-alive park.
    const blk = parseBlocked(leadInstruction)
    if (blk !== null) {
      const reason = blk || 'manager requested human input'
      appendDecision(loop.memDir, `turn ${turn}: BLOCKED — ${reason}`)
      updateState(loop.memDir, { status: 'blocked', blockedReason: reason })
      return { kind: 'blocked', reason }
    }

    // Asked the human a question (non-terminal). Checked before DONE so a question
    // is never misread as completion. The manager parks ALIVE and resumes on the
    // answer (handled in runManager).
    const q = parseNeedsInput(leadInstruction)
    if (q !== null) {
      const question = q || 'manager asked a question'
      appendDecision(loop.memDir, `turn ${turn}: NEEDS_INPUT — ${question}`)
      updateState(loop.memDir, { status: 'awaiting_input', blockedReason: question })
      return { kind: 'needsinput', question }
    }

    if (isDone(leadInstruction)) {
      appendDecision(loop.memDir, `turn ${turn}: lead reported DONE`)
      return { kind: 'done' }
    }

    // Record the instruction as this turn's decision (one tidy line).
    const oneLine = leadInstruction.replace(/\s+/g, ' ').trim().slice(0, 160)
    appendDecision(loop.memDir, `turn ${turn}: instructed worker — ${oneLine}`)
    updateState(loop.memDir, { task: oneLine })

    if (!loop.running) return { kind: 'stopped' }

    // --- WORKER turn: carry out the instruction, report back ---
    const workerRes = await sendRaced(loop, loop.worker, leadInstruction)
    if (workerRes.kind === 'deadline') return { kind: 'deadline' }
    if (workerRes.kind === 'stopped') return { kind: 'stopped' }
    transcript(loop, 'WORKER', workerRes.report)

    // Feed the worker's report back to the lead for the next round.
    nextLeadMessage = wrapWorkerReport(workerRes.report)
  }
  return { kind: 'maxturns' }
}

/**
 * Park-and-wait for the next task (Phase 6b). Returns the next task string, or
 * null when the manager should terminate (explicit stop or idle-timeout).
 *
 * Concurrency contract (the wake protocol — designed to never drop a wakeup or
 * busy-spin): enqueue() PERSISTS the task first, THEN calls loop.wake if armed.
 * Here we (1) drain any already-queued task immediately, then (2) arm loop.wake
 * and, inside the same synchronous executor, RE-CHECK the queue and the running
 * flag before awaiting — so a task enqueued in the gap between the drain and the
 * arm is still seen. We never await with a stale empty view.
 */
// Exported for tests: this is the race-critical core and touches no
// TerminalSession, so it is exercised directly against a fake loop.
export async function awaitNextTask(loop: RelayLoop): Promise<string | null> {
  while (loop.running) {
    // When awaiting an answer (a question is outstanding) we drain the SEPARATE
    // answer channel — never the task queue — so a task queued before the question
    // can never be consumed as the answer. Otherwise we drain the task queue.
    const awaitingAnswer = loop.pendingQuestion !== undefined
    const drain = () => (awaitingAnswer ? takeAnswer(loop.memDir) : dequeueTask(loop.memDir))
    const ready = () => (awaitingAnswer ? readAnswer(loop.memDir) !== null : readQueue(loop.memDir).length > 0)

    const first = drain()
    if (first !== null) return first

    const woken = await new Promise<'task' | 'stop' | 'idle'>((resolve) => {
      loop.wake = resolve
      // Double-check inside the executor (synchronously, before any await) to
      // close the lost-wakeup window between the drain above and arming wake.
      if (ready()) return resolve('task')
      if (!loop.running) return resolve('stop')
      loop.parked = true
      // Awaiting a human ANSWER gets the longer cap; a routine between-tasks park
      // gets the short one. Both are bounded so it always tears down eventually.
      const idleMs = awaitingAnswer ? loop.answerIdleTimeoutMs : loop.idleTimeoutMs
      if (awaitingAnswer) {
        updateState(loop.memDir, { status: 'awaiting_input' })
        transcript(loop, 'SYS', `parked ALIVE · awaiting human answer (timeout ${Math.round(idleMs / 60_000)}min)`)
      } else {
        updateState(loop.memDir, { status: 'parked', task: '(idle — awaiting next task)' })
        transcript(loop, 'SYS', `parked · awaiting next task (idle timeout ${Math.round(idleMs / 60_000)}min)`)
      }
      loop.idleTimer = setTimeout(() => resolve('idle'), idleMs)
    })

    // Disarm before acting on the result (resolve is idempotent; first wins).
    loop.parked = false
    loop.wake = undefined
    if (loop.idleTimer) {
      clearTimeout(loop.idleTimer)
      loop.idleTimer = undefined
    }

    if (!loop.running || woken === 'stop') return null
    // A task/answer arrived, or idle fired — drain either way (one may have raced
    // in just as idle fired). Empty + idle => terminate.
    const next = drain()
    if (next !== null) return next
    if (woken === 'idle') return null
    // woken==='task' but nothing to drain (e.g. a blank enqueue) — re-park.
  }
  return null
}

/**
 * The persistent MANAGER loop (Phase 6b). Runs the initial goal, then PARKS and
 * waits for more tasks (via enqueue) instead of dying — surviving idle between
 * tasks, escalating when stuck, and tearing down only on stop / idle-timeout /
 * block / fatal error. Runs in the background; never throws.
 */
async function runManager(loop: RelayLoop, goal: string, context: string | undefined): Promise<void> {
  let endReason = 'completed'
  let blockedReason: string | null = null
  let firstMessage: string | null = leadSeed(goal, context) // task 1 uses the full role seed
  let taskNum = 0

  try {
    while (loop.running) {
      // Pick the next task: the seeded goal first, then queued/awaited tasks.
      let leadMessage: string
      if (firstMessage !== null) {
        leadMessage = firstMessage
        firstMessage = null
        taskNum = 1
        transcript(loop, 'SYS', `--- task ${taskNum} (initial goal) ---`)
      } else {
        const next = await awaitNextTask(loop)
        if (next === null) {
          endReason = !loop.running
            ? 'stopped'
            : loop.pendingQuestion !== undefined
              ? 'idle timeout — unanswered question'
              : 'idle timeout — no new tasks'
          break
        }
        // A fresh task must not inherit a leftover steer from the previous one.
        loop.pendingInjection = undefined
        if (loop.pendingQuestion !== undefined) {
          // This is the ANSWER to an outstanding question — RESUME the same task
          // (don't bump taskNum), and consume the question so a later enqueue is a
          // fresh task, not a re-answer.
          leadMessage = answerSeed(next, loop.pendingQuestion)
          appendDecision(loop.memDir, `task ${taskNum} resumed with human answer: ${next.slice(0, 160)}`)
          transcript(loop, 'SYS', `--- task ${taskNum} resumed (answer received) ---`)
          loop.pendingQuestion = undefined
        } else {
          taskNum++
          leadMessage = taskSeed(next)
          appendDecision(loop.memDir, `task ${taskNum} received: ${next.slice(0, 160)}`)
          transcript(loop, 'SYS', `--- task ${taskNum}: ${next.slice(0, 160)} ---`)
        }
      }

      // Fresh per-task budget (turn loop restarts at 1; wall-clock resets).
      loop.deadline = Date.now() + loop.perTaskWallClockMs
      const outcome = await runTask(loop, leadMessage, loop.maxTurns)

      if (outcome.kind === 'blocked') {
        blockedReason = outcome.reason
        endReason = `blocked: ${outcome.reason}`
        break
      }
      if (outcome.kind === 'stopped') {
        endReason = 'stopped'
        break
      }

      if (outcome.kind === 'needsinput') {
        // The manager asked a question. Buzz the human (urgent), stay ALIVE, and
        // PARK for the answer — do NOT break/teardown. pendingQuestion is set
        // SYNCHRONOUSLY here (before the next awaitNextTask) so the answer that
        // arrives via enqueue is framed as a resume, not a fresh task.
        let cursor = 0
        try {
          cursor = statSync(loop.logPath).size
        } catch {
          /* log may not exist yet */
        }
        emitNeedsInput({ type: 'relay', id: loop.loopId, cursor, summary: `needs your answer: ${outcome.question}`, reason: outcome.question })
        loop.pendingQuestion = outcome.question
        appendDecision(loop.memDir, `task ${taskNum} awaiting human answer · parking`)
        transcript(loop, 'SYS', `task ${taskNum} NEEDS_INPUT · parking ALIVE for the human's answer`)
        continue // fall into awaitNextTask at the top of the loop
      }

      // done | deadline | maxturns => this task finished (possibly capped). Record
      // it SILENTLY (events.log only — no phone buzz on routine completion), then
      // PARK for the next task.
      const taskReason =
        outcome.kind === 'done' ? 'task done' : outcome.kind === 'deadline' ? 'task wall-clock cap' : 'task max turns'
      let cursor = 0
      try {
        cursor = statSync(loop.logPath).size
      } catch {
        /* log may not exist yet */
      }
      emitCompletion({ type: 'relay', id: loop.loopId, cursor, summary: `relay task ${taskNum} ${taskReason}`, reason: taskReason, silent: true, cwd: loop.cwd })
      appendDecision(loop.memDir, `task ${taskNum} ${taskReason} · parking`)
      transcript(loop, 'SYS', `task ${taskNum} ${taskReason} · parking for next task`)
    }
  } catch (e) {
    endReason = `loop error: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    loop.running = false
    if (loop.idleTimer) {
      clearTimeout(loop.idleTimer)
      loop.idleTimer = undefined
    }
    loop.parked = false
    loop.pendingQuestion = undefined // never let a stale question leak past teardown
    clearAnswer(loop.memDir) // discard any unconsumed answer on teardown
    transcript(loop, 'SYS', `manager finished · reason: ${endReason}`)
    let cursor = 0
    try {
      cursor = statSync(loop.logPath).size
    } catch {
      /* log may not exist yet */
    }
    if (blockedReason !== null) {
      // Stuck: escalate to the human (urgent push). Terminal event for a block —
      // no duplicate completion ping.
      emitEscalation({ type: 'relay', id: loop.loopId, cursor, summary: `relay blocked: ${blockedReason}`, reason: blockedReason })
    } else {
      updateState(loop.memDir, { status: 'done', task: 'manager stopped' })
      emitCompletion({ type: 'relay', id: loop.loopId, cursor, summary: `relay manager finished: ${endReason}`, reason: endReason, cwd: loop.cwd })
    }
    // Tear the tmux sessions down so they don't linger.
    await loop.lead.close().catch(() => {})
    await loop.worker.close().catch(() => {})
  }
}

/** Page the dual transcript from a byte cursor. Returns undefined for unknown loopId. */
export function readSince(
  loopId: string,
  cursor = 0,
): { text: string; cursor: number; running: boolean } | undefined {
  const loop = loops.get(loopId)
  if (!loop) return undefined
  let size = 0
  try {
    size = statSync(loop.logPath).size
  } catch {
    return { text: '', cursor: 0, running: loop.running }
  }
  const from = Math.max(0, Math.min(cursor, size))
  let text = ''
  if (size > from) {
    try {
      const buf = readFileSync(loop.logPath)
      text = buf.subarray(from, size).toString('utf8')
    } catch {
      text = ''
    }
  }
  return { text, cursor: size, running: loop.running }
}

/**
 * Stop a loop PROMPTLY: flip the running flag (so the loop body bails at its next
 * guard) AND interrupt the session currently mid-send (so a long-running TUI turn
 * doesn't have to finish first). Idempotent.
 */
export function stop(loopId: string): { ok: boolean; running: boolean } {
  const loop = loops.get(loopId)
  if (!loop) return { ok: false, running: false }
  loop.running = false
  // If parked, break the idle wait immediately so teardown is prompt.
  if (loop.wake) loop.wake('stop')
  // Interrupt whatever is mid-await right now, plus both sessions defensively.
  const active = loop.active
  if (active) void active.interrupt().catch(() => {})
  void loop.lead.interrupt().catch(() => {})
  void loop.worker.interrupt().catch(() => {})
  return { ok: true, running: false }
}

/**
 * Enqueue a new task for a running/parked manager (Phase 6b). Persists the task
 * to disk FIRST (durable, so it's not lost on crash), THEN wakes the loop if it
 * is parked. A blank task, or one past the queue-depth cap, is rejected. Returns
 * whether it was accepted and the resulting queue depth.
 */
export function enqueue(loopId: string, task: string): { ok: boolean; queued: number; answered?: boolean } {
  const loop = loops.get(loopId)
  if (!loop || !loop.running) return { ok: false, queued: 0 }
  const t = task.trim()
  if (!t) return { ok: false, queued: readQueue(loop.memDir).length }
  // If the manager is awaiting an ANSWER to a question, this enqueue IS the
  // answer — route it to the separate answer channel so it can never be confused
  // with a task that was already queued before the question was asked.
  if (loop.pendingQuestion !== undefined) {
    setAnswer(loop.memDir, t) // persist before signalling
    transcript(loop, 'SYS', `answer received: ${t.slice(0, 160)}`)
    if (loop.wake) loop.wake('task')
    return { ok: true, answered: true, queued: readQueue(loop.memDir).length }
  }
  // Persist before signalling (no lost task on crash); bounded so the backlog
  // can't grow without limit. accepted=false here means the queue is full.
  const accepted = enqueueTask(loop.memDir, t, MAX_QUEUE_DEPTH)
  if (!accepted) return { ok: false, queued: readQueue(loop.memDir).length }
  transcript(loop, 'SYS', `task enqueued: ${t.slice(0, 160)}`)
  if (loop.wake) loop.wake('task') // wake a parked loop; a running one drains it later
  return { ok: true, queued: readQueue(loop.memDir).length }
}

/**
 * Inject an operator message to steer the lead mid-task. It is prepended to the
 * next message the lead receives (consumed at the top of the next turn). Returns
 * whether it was accepted. NOTE: to ANSWER a manager that asked a NEEDS_INPUT
 * question (parked-for-answer), or to add the next task, use `enqueue` — inject
 * is rejected while parked (it only steers a task that is actively running).
 */
export function inject(loopId: string, message: string): { ok: boolean } {
  const loop = loops.get(loopId)
  if (!loop || !loop.running) return { ok: false }
  // While PARKED (between tasks OR awaiting an answer) there is no in-flight turn
  // to steer. Reject rather than stash a pending injection that would (a) silently
  // leak into the NEXT task, or (b) be dropped at idle teardown. Use enqueue to
  // add the next task or to answer an outstanding question.
  if (loop.parked) return { ok: false }
  loop.pendingInjection = message
  transcript(loop, 'SYS', `operator injected: ${message}`)
  return { ok: true }
}

/** Loop metadata (for status / list surfaces). undefined if unknown. */
export function info(
  loopId: string,
): { loopId: string; leadName: string; workerName: string; running: boolean; parked: boolean; awaitingAnswer: boolean; queued: number } | undefined {
  const loop = loops.get(loopId)
  if (!loop) return undefined
  return {
    loopId: loop.loopId,
    leadName: loop.leadName,
    workerName: loop.workerName,
    running: loop.running,
    parked: loop.parked,
    awaitingAnswer: loop.pendingQuestion !== undefined,
    queued: readQueue(loop.memDir).length,
  }
}
