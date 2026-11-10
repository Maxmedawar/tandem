/**
 * events.ts — the completion-event EMIT side.
 *
 * When a session turn or a relay reaches "done" (per the engine's existing
 * idle/done detection), the bridge calls emitCompletion() instead of waiting to
 * be polled. Two sinks, both best-effort and non-blocking:
 *
 *   1. Append one JSON line to ~/.tandem/events.log (durable; tail/poll it).
 *   2. If TANDEM_DONE_WEBHOOK is set, POST the same JSON to that URL
 *      (fire-and-forget; uses the global fetch in Node 22+, no deps).
 *   3. If TANDEM_NTFY_TOPIC is set, push a phone notification via ntfy
 *      (fire-and-forget; POST to {TANDEM_NTFY_SERVER}/{topic}). This pings a
 *      DEVICE (your phone), not the chat client — see the README ntfy note.
 *
 * The MCP connection itself cannot reliably carry a server-initiated wake-up in
 * the current stateless Streamable-HTTP setup — see the README "Completion
 * events / waking the client" section for what a client would need to do.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { audit } from './audit.ts'

const EVENTS_DIR = join(homedir(), '.tandem')
const EVENTS_LOG = join(EVENTS_DIR, 'events.log')
/** Append a metadata-only bridge record using the central redaction policy. */
function logBridge(fields: Record<string, unknown>): void {
  audit(fields)
}

/** Append private event content without inheriting a permissive process umask. */
function appendEventLine(line: string): void {
  mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(EVENTS_DIR, 0o700)
  appendFileSync(EVENTS_LOG, line, { encoding: 'utf8', mode: 0o600 })
  chmodSync(EVENTS_LOG, 0o600)
}

export interface CompletionEvent {
  /** "session" (a single turn finished) or "relay" (a relay loop finished). */
  type: 'session' | 'relay'
  /** 'quiet' = a markerless session went still with no completion signal. */
  status: 'done' | 'quiet'
  /** session name (type=session) or relay loopId (type=relay). */
  id: string
  /** transcript byte cursor at completion. */
  cursor: number
  /** short human summary of what finished. */
  summary: string
  /** relay end reason, when applicable. */
  reason?: string
  /**
   * A client-neutral, copy-pasteable handoff block (plain text, multi-line).
   * Pasting it into any capable agent or chat tells it what finished and what
   * to check next. Computed by emitCompletion; absent on escalation and
   * needs-input events.
   */
  handoff?: string
}

/** Git facts for the handoff block; both fall back to safe strings. */
interface GitInfo {
  commit: string
  filesChanged: string
}

/**
 * Best-effort, bounded git facts for the handoff. If `cwd` is a git repo, read
 * the short HEAD hash and the count of files changed in the last commit. Each
 * command is wrapped in try/catch with a hard 3s timeout and stderr silenced, so
 * a missing git binary, a non-repo cwd, or a slow filesystem can never crash or
 * hang the emit path — it just falls back ("none" / "unknown").
 */
function gitInfo(cwd?: string): GitInfo {
  const fallback: GitInfo = { commit: 'none', filesChanged: 'unknown' }
  if (!cwd) return fallback
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  let commit = 'none'
  try {
    commit = run(['rev-parse', '--short', 'HEAD']) || 'none'
  } catch {
    return fallback // not a repo / no git — give up on both, stay fast.
  }
  let filesChanged = 'unknown'
  try {
    // --shortstat yields e.g. " 3 files changed, 40 insertions(+), 2 deletions(-)".
    const stat = run(['diff', '--stat', 'HEAD~1', '--shortstat'])
    const m = stat.match(/(\d+)\s+files?\s+changed/)
    if (m) filesChanged = m[1]
  } catch {
    /* keep "unknown" */
  }
  return { commit, filesChanged }
}

/**
 * Build a client-neutral handoff block for any capable agent, chat, or
 * automation consuming Tandem's completion event.
 */
export function buildHandoff(event: { id: string; status: string; summary: string }, git: GitInfo): string {
  return [
    event.status === 'quiet'
      ? `Tandem check: session "${event.id}" went quiet (no output and no completion signal; it may still be working).`
      : `Tandem check: session "${event.id}" finished (${event.status}).`,
    `Summary: ${event.summary}`,
    `Commit: ${git.commit}`,
    `Files changed: ${git.filesChanged}`,
    `Next: Review the session output and decide the next step.`,
  ].join('\n')
}

/** Collapse whitespace and clamp to a short single-line summary. */
export function summarize(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max - 3) + '...' : t
}

/** A ready-to-send ntfy notification (pure; no I/O — unit-testable). */
export interface NtfyPayload {
  title: string
  body: string
  priority: string
  tags: string
  /** Optional ntfy Click URL — tapping the notification opens this on the phone. */
  click?: string
}

interface NtfyPayloadOptions {
  escalation?: boolean
  needsInput?: boolean
  reason?: string
  clickUrl?: string
}

function safeClickUrl(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Build the ntfy notification for an event. A normal completion is a quiet
 * "<id> done"; an escalation (the manager is stuck and needs the human) is an
 * URGENT "<id> NEEDS YOU" carrying the blocking reason, so the two are
 * unmistakable on the phone. Pure: returns the payload, sends nothing.
 */
export function ntfyPayload(
  event: CompletionEvent,
  opts?: NtfyPayloadOptions,
): NtfyPayload {
  const click = safeClickUrl(opts?.clickUrl)
  if (opts?.needsInput) {
    // Non-terminal question: the manager is alive and waiting for an answer.
    // Distinct title from both 'done' and the terminal BLOCKED 'NEEDS YOU'.
    const reason = (opts.reason ?? event.reason ?? event.summary ?? '').trim()
    return {
      title: `tandem: ${event.id} NEEDS YOUR ANSWER`,
      body: summarize(`${event.type} ${event.id} asked: ${reason || 'needs your answer'}`),
      priority: 'urgent',
      tags: 'question,speech_balloon',
      ...(click ? { click } : {}),
    }
  }
  if (opts?.escalation) {
    const reason = (opts.reason ?? event.reason ?? event.summary ?? '').trim()
    return {
      title: `tandem: ${event.id} NEEDS YOU`,
      body: summarize(`${event.type} ${event.id} is BLOCKED: ${reason || 'needs your input'}`),
      priority: 'urgent',
      tags: 'warning,sos',
      ...(click ? { click } : {}),
    }
  }
  return {
    // Short title; the BODY is the chat-ready handoff block (multi-line, NOT
    // collapsed) so you can copy it straight from the notification into a chat.
    // Falls back to the old one-line summary if no handoff was computed.
    title: `tandem: ${event.id} ${event.status}`,
    body: event.handoff ?? summarize(`${event.type} ${event.id} ${event.status} @${event.cursor}: ${event.summary}`),
    priority: 'default',
    tags: event.status === 'quiet' ? 'zzz' : 'white_check_mark',
    ...(click ? { click } : {}),
  }
}

/**
 * Push a phone notification via ntfy (https://ntfy.sh or self-hosted). Disabled
 * unless TANDEM_NTFY_TOPIC is set. Fire-and-forget: a network failure is caught
 * and logged to ~/.tandem/bridge.log, never crashing or blocking the bridge.
 *
 * NOTE: this reaches a DEVICE (your phone/the ntfy app), not the chat client.
 */
function notifyNtfy(event: CompletionEvent, opts?: NtfyPayloadOptions): void {
  const topic = process.env.TANDEM_NTFY_TOPIC
  if (!topic) return // ntfy off unless a topic is configured

  const server = (process.env.TANDEM_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
  const url = `${server}/${encodeURIComponent(topic)}`
  const { title, body, priority, tags, click } = ntfyPayload(event, {
    ...opts,
    clickUrl: process.env.TANDEM_NTFY_CLICK_URL,
  })

  try {
    void fetch(url, {
      method: 'POST',
      // Headers must be ASCII/single-line; the id matches NAME_RE so this is safe.
      // Click (if present) is a plain URL — also single-line ASCII.
      headers: { Title: title, Priority: priority, Tags: tags, ...(click ? { Click: click } : {}) },
      body,
    }).catch((e) => logBridge({ event: 'ntfy', ok: false, error: String(e) }))
  } catch (e) {
    logBridge({ event: 'ntfy', ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Emit a completion event. Never throws and never blocks the caller: log-write
 * failures go to stderr and the webhook POST is fire-and-forget.
 */
export function emitCompletion(
  ev: Omit<CompletionEvent, 'status' | 'ts' | 'handoff'> & { status?: CompletionEvent['status']; silent?: boolean; cwd?: string },
): void {
  // `silent` suppresses ONLY the phone push (sink 3) — events.log + webhook still
  // fire — so routine per-task completions stay durable without buzzing the phone.
  // `cwd` is used only to compute the git facts in the handoff; it is NOT stored
  // in the event (so no local path leaks into events.log / the webhook).
  const { silent, cwd, status = 'done', ...rest } = ev
  const base = { ts: new Date().toISOString(), status, ...rest }
  // Chat-ready handoff block, computed once and carried on the event so all three
  // sinks (log line, webhook JSON, ntfy body) share the same text.
  const handoff = buildHandoff(base, gitInfo(cwd))
  const event = { ...base, handoff }
  const line = JSON.stringify(event) + '\n'

  // 1) Durable local log.
  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] event log write failed\n')
  }

  // 2) Optional outbound webhook.
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 3) Optional phone push via ntfy (env-gated, fire-and-forget) — unless silent.
  if (!silent) notifyNtfy(event)
}

/**
 * Emit a NEEDS-INPUT event (Phase 6c): the manager asked the human a question and
 * is parked ALIVE awaiting the answer (NOT torn down). Same sinks as
 * emitCompletion, but the log line is tagged `event:"needs_input"` and the ntfy
 * push is URGENT with a distinct "NEEDS YOUR ANSWER" title carrying the question.
 * Never throws/blocks.
 */
export function emitNeedsInput(ev: Omit<CompletionEvent, 'status'> & { reason: string }): void {
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...ev }
  const line = JSON.stringify({ event: 'needs_input', ...event }) + '\n'

  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] needs_input log write failed\n')
  }

  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  notifyNtfy(event, { needsInput: true, reason: ev.reason })
}

/**
 * Emit an ESCALATION: the manager is stuck and needs the human. Same sinks as
 * emitCompletion (durable log + ntfy), but the log line is tagged
 * `event:"escalation"` and the ntfy push is URGENT and carries the blocking
 * reason. This is the one place a device-push is the right primitive: the human
 * is the only node at the top that can actually be woken. Never throws/blocks.
 */
export function emitEscalation(ev: Omit<CompletionEvent, 'status'> & { reason: string }): void {
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...ev }
  const line = JSON.stringify({ event: 'escalation', ...event }) + '\n'

  // 1) Durable local log (tagged so watchers can distinguish from completions).
  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] escalation log write failed\n')
  }

  // 2) Optional outbound webhook (same raw JSON line).
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 3) Urgent phone push via ntfy (env-gated, fire-and-forget).
  notifyNtfy(event, { escalation: true, reason: ev.reason })
}
