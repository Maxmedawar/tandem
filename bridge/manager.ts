/**
 * manager.ts — the disk-backed memory layer for a persistent relay "manager".
 *
 * The relay's lead session is a real OS process, but its working memory today is
 * a single rolling string held in the bridge process (relay.ts `nextLeadMessage`)
 * plus whatever survives the lead's own context window — both volatile. This
 * module gives the manager a real mind on disk so it survives context
 * compaction WITHIN a run: continuity comes from re-reading files each turn, not
 * from a process "staying alive". (The files are also durable across a bridge
 * restart, but auto-resuming a parked manager on restart is not yet wired —
 * Phase 6c; see the README "Limitation" note.)
 *
 * Three files per manager, under ~/.tandem/manager/<loopId>/:
 *   MISSION.md   — the standing definition of "done". Written once, re-read each turn.
 *   STATE.json   — the working set: status / turn / current task / blocked reason.
 *   LOG.md       — append-only decision log, one line per turn. The durable memory.
 *
 * All write/read helpers take an explicit `dir` (no hidden global) so they are
 * unit-testable against a tmp dir, and they never throw — a broken memory file
 * must not take down the relay loop.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tandemHome } from './tandem-home.ts'

/** The manager's working set, persisted to STATE.json. */
export interface ManagerState {
  /**
   * running        — actively driving the worker on the current task.
   * parked         — idle, alive, waiting for the next task (Phase 6b).
   * awaiting_input — mid-task; asked the human a question; parked ALIVE awaiting
   *                  their answer (delivered via enqueue), then resumes (Phase 6c).
   * blocked        — stuck; escalated to the human, loop halted (terminal).
   * done           — fully finished and torn down.
   */
  status: 'running' | 'parked' | 'awaiting_input' | 'blocked' | 'done'
  /** last completed lead turn. */
  turn: number
  /** short description of the current task/focus. */
  task: string
  /** set when status === 'blocked'; the reason to surface to the human. */
  blockedReason?: string
  /** ISO timestamp of the last write. */
  updatedTs: string
}

/** Absolute memory dir for a given relay loopId. */
export function managerDir(loopId: string): string {
  return join(tandemHome(), 'manager', loopId)
}

/**
 * Detect the escalation sentinel. The lead emits `BLOCKED: <reason>` (on its own
 * line) when it cannot proceed without the human — mirrors isDone()'s tolerant,
 * own-line matching so the word "blocked" inside a sentence never trips it.
 * Returns the reason (possibly '' for a bare BLOCKED), or null if not present.
 */
export function parseBlocked(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*(?:[>*\-+#]\s*)*/, '') // leading markdown bullets/quotes/headings
      .replace(/^[*_`"'(\[\s]+/, '') // leading emphasis/quote/bracket
      .trim()
    // Populated form: keyword + optional emphasis + a REQUIRED separator + reason.
    // The mandatory separator stops ordinary prose ("blocked by the rate limiter")
    // from being misread as the sentinel.
    const m = /^blocked\b[*_`"'\s]*[:\-—]\s*(.*)$/i.exec(line)
    if (m) {
      // Strip any trailing emphasis/punctuation noise from the captured reason.
      return m[1].replace(/[*_`"')\]\s]+$/, '').trim()
    }
    // Bare form: the keyword alone on its own line (optionally emphasized).
    if (/^blocked[*_`"'\s]*$/i.test(line)) return ''
  }
  return null
}

/**
 * Detect the NON-TERMINAL "ask the human a question" sentinel (Phase 6c). The
 * lead emits `NEEDS_INPUT: <question>` (or `QUESTION:` / `NEEDS INPUT:`) on its
 * own line when it needs an answer to continue — UNLIKE BLOCKED, this pauses the
 * manager ALIVE rather than tearing it down. Mirrors parseBlocked's tolerant,
 * own-line matching. Returns the question ('' for a bare sentinel), or null.
 * Disjoint from parseBlocked (neither sentinel matches the other).
 */
export function parseNeedsInput(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*(?:[>*\-+#]\s*)*/, '') // leading markdown bullets/quotes/headings
      .replace(/^[*_`"'(\[\s]+/, '') // leading emphasis/quote/bracket
      .trim()
    // Populated form: keyword + optional emphasis + a REQUIRED separator + question.
    // The mandatory separator stops natural prose ("needs input validation", a
    // line starting "Question ...") from falsely tripping the sentinel.
    const m = /^(?:needs[_\s]?input|question)\b[*_`"'\s]*[:\-—]\s*(.*)$/i.exec(line)
    if (m) {
      return m[1].replace(/[*_`"')\]\s]+$/, '').trim()
    }
    // Bare form: the keyword alone on its own line (optionally emphasized).
    if (/^(?:needs[_\s]?input|question)[*_`"'\s]*$/i.test(line)) return ''
  }
  return null
}

function statePath(dir: string): string {
  return join(dir, 'STATE.json')
}
function missionPath(dir: string): string {
  return join(dir, 'MISSION.md')
}
function logPath(dir: string): string {
  return join(dir, 'LOG.md')
}

/** Seed the three memory files for a fresh manager. Never throws. */
export function initManagerMemory(dir: string, opts: { goal: string; context?: string }): void {
  try {
    mkdirSync(dir, { recursive: true })
    const ctx = opts.context && opts.context.trim() ? `\n\n## Context / spec\n\n${opts.context.trim()}\n` : ''
    writeFileSync(missionPath(dir), `# Mission\n\n${opts.goal.trim()}\n${ctx}`)
    const state: ManagerState = {
      status: 'running',
      turn: 0,
      task: 'initializing',
      updatedTs: new Date().toISOString(),
    }
    writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\n')
    appendFileSync(logPath(dir), `# Decision log\n\n[${state.updatedTs}] manager started\n`)
  } catch (e) {
    process.stderr.write(`[manager] init failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/** Append one decision line to LOG.md. Never throws. */
export function appendDecision(dir: string, entry: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(logPath(dir), `[${new Date().toISOString()}] ${entry.trim()}\n`)
  } catch (e) {
    process.stderr.write(`[manager] log append failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/** Read+merge+write STATE.json. Returns the new state. Never throws. */
export function updateState(dir: string, patch: Partial<ManagerState>): ManagerState {
  const current = readMemory(dir).state ?? {
    status: 'running' as const,
    turn: 0,
    task: 'initializing',
    updatedTs: new Date().toISOString(),
  }
  const next: ManagerState = { ...current, ...patch, updatedTs: new Date().toISOString() }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(statePath(dir), JSON.stringify(next, null, 2) + '\n')
  } catch (e) {
    process.stderr.write(`[manager] state write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
  return next
}

function queuePath(dir: string): string {
  return join(dir, 'QUEUE.json')
}

/**
 * The pending task queue, persisted to QUEUE.json (FIFO) so the backlog is
 * durable on disk. Tasks are plain instruction strings. (NOTE: the bridge does
 * not yet re-read this on restart to auto-resume a parked manager — that's
 * Phase 6c; see the README "Limitation" note.) All helpers never throw — a
 * broken queue file degrades to empty.
 */
export function readQueue(dir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(queuePath(dir), 'utf8'))
    return Array.isArray(parsed?.pending) ? parsed.pending.filter((t: unknown) => typeof t === 'string') : []
  } catch {
    return []
  }
}

function writeQueue(dir: string, pending: string[]): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(queuePath(dir), JSON.stringify({ pending }, null, 2) + '\n')
  } catch (e) {
    process.stderr.write(`[manager] queue write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/**
 * Append a task to the queue. Blank tasks are ignored, and the queue is bounded
 * by `maxDepth` (default unbounded) so an authenticated caller can't grow it
 * without limit. Returns true if the task was accepted, false otherwise. Never
 * throws.
 */
export function enqueueTask(dir: string, task: string, maxDepth = Infinity): boolean {
  const t = task.trim()
  if (!t) return false // never let an empty enqueue wake a parked manager
  const q = readQueue(dir)
  if (q.length >= maxDepth) return false // queue full — reject rather than grow unbounded
  writeQueue(dir, [...q, t])
  return true
}

/** Pop and return the first pending task (FIFO), persisting the rest. Null if empty. */
export function dequeueTask(dir: string): string | null {
  const q = readQueue(dir)
  if (q.length === 0) return null
  const [head, ...rest] = q
  writeQueue(dir, rest)
  return head
}

function answerPath(dir: string): string {
  return join(dir, 'ANSWER.json')
}

/**
 * The ANSWER channel (Phase 6c) — SEPARATE from the task queue so an answer to a
 * NEEDS_INPUT question can never be confused with a task that happened to be
 * queued before the question was asked. Persisted to disk (durable, like the
 * queue) and a single slot. Never throws.
 */
export function setAnswer(dir: string, answer: string): boolean {
  const t = answer.trim()
  if (!t) return false
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(answerPath(dir), JSON.stringify({ answer: t }, null, 2) + '\n')
  } catch (e) {
    process.stderr.write(`[manager] answer write failed: ${e instanceof Error ? e.message : String(e)}\n`)
    return false
  }
  return true
}

/** Read the pending answer (non-destructive). Null if none. */
export function readAnswer(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(answerPath(dir), 'utf8'))
    return typeof parsed?.answer === 'string' ? parsed.answer : null
  } catch {
    return null
  }
}

/** Read and clear the pending answer. Null if none. */
export function takeAnswer(dir: string): string | null {
  const a = readAnswer(dir)
  if (a === null) return null
  try {
    rmSync(answerPath(dir))
  } catch {
    /* already gone */
  }
  return a
}

/** Clear any pending answer (used at teardown). Never throws. */
export function clearAnswer(dir: string): void {
  try {
    rmSync(answerPath(dir))
  } catch {
    /* nothing to clear */
  }
}

/** Read the manager's memory. Missing/corrupt files degrade gracefully. */
export function readMemory(dir: string): {
  mission: string
  state: ManagerState | null
  logTail: string
} {
  let mission = ''
  try {
    mission = readFileSync(missionPath(dir), 'utf8')
  } catch {
    /* no mission yet */
  }
  let state: ManagerState | null = null
  try {
    state = JSON.parse(readFileSync(statePath(dir), 'utf8')) as ManagerState
  } catch {
    /* no/corrupt state */
  }
  let logTail = ''
  try {
    logTail = tailLines(readFileSync(logPath(dir), 'utf8'), 40)
  } catch {
    /* no log yet */
  }
  return { mission, state, logTail }
}

/** Last `n` non-empty-trimmed lines of a text blob. */
function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/**
 * Build the re-grounding preamble prepended to the lead each turn: the mission
 * plus the recent decision log. This is what makes the manager resumable — even
 * after a context compaction the lead re-reads what it is doing and what it has
 * already decided. Returns '' when there is no memory yet.
 */
export function regroundPreamble(dir: string, maxLogLines = 20): string {
  const { mission, logTail } = readMemory(dir)
  if (!mission && !logTail) return ''
  const recent = tailLines(logTail, maxLogLines)
  return [
    '=== STANDING MEMORY (re-read every turn — your real state lives on disk) ===',
    mission.trim(),
    '',
    'Recent decisions (append-only log):',
    recent.trim() || '(none yet)',
    '',
    'If you need the human, you have TWO options, each on its OWN line:',
    '  • "NEEDS_INPUT: <question>" — ask a question and PAUSE. You will NOT be torn',
    '    down: you stay alive, the human is pinged, and you RESUME with their answer.',
    '  • "BLOCKED: <reason>" — a hard stop you believe is unrecoverable (ends the run).',
    'Prefer NEEDS_INPUT whenever an answer would let you keep going.',
    '=== END STANDING MEMORY ===',
    '',
  ].join('\n')
}
