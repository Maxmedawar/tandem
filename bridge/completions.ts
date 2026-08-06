/**
 * completions.ts — READ-ONLY reader for the Stop-hook completion feed.
 *
 * The Stop hook (~/.tandem/hooks/session-complete.sh) appends one JSON line per
 * TURN END to ~/.tandem/completions/log.jsonl:
 *
 *   {"session_id":"<uuid>","brand":"<basename cwd>","cwd":"<abs>","finished_at":"<ISO Z>"}
 *
 * Two facts drive this module's shape (both measured, see PLAN-completions.md):
 *
 *  1. The hook fires per TURN, not per session — 147 records covered only 53
 *     distinct session_ids. A director asking "what finished" wants one row per
 *     session, so we COLLAPSE to the newest record per session_id by default and
 *     expose the raw per-turn feed behind `allTurns`.
 *  2. Records carry NO tmux session name. The only handles back to a live
 *     session are `session_id` and `cwd`, so both are always returned — the
 *     caller joins them against list_sessions' `cwd` itself.
 *
 * SIZE GUARD: the log is append-only and never rotated. We never read the whole
 * file: a positional read takes only the last TAIL_BYTES and discards the first
 * (possibly partial) line of that window. Cost is O(window), not O(file).
 *
 * This module only ever OPENS THE FILE FOR READING. It never writes, truncates,
 * or rotates anything.
 */

import { closeSync, openSync, readSync, fstatSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One completion record as written by the Stop hook. */
export interface CompletionRecord {
  session_id: string
  brand: string
  cwd: string
  finished_at: string
}

export interface CompletionsResult {
  completions: CompletionRecord[]
  /** Max finished_at seen in the tail window; feed back as `since` next call. */
  cursor: string | null
  /** True when the tail window was clipped or `limit` cut the result. */
  truncated: boolean
}

export interface CompletionsOpts {
  /** ISO-8601 Z timestamp (or a prior cursor); returns records strictly newer. */
  since?: string
  /** Exact session_id, or a substring matched against brand / cwd. */
  session?: string
  /** Max records returned, newest first. */
  limit?: number
  /** true = every raw turn record; false (default) = newest per session_id. */
  allTurns?: boolean
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 500

/**
 * Tail window. 256 KiB ≈ 1700 records at the observed ~150 B/line. Read at CALL
 * time (like the dir) so the env stays authoritative without a bridge restart.
 */
function tailBytes(): number {
  const n = Number(process.env.TANDEM_COMPLETIONS_TAIL_BYTES)
  return Number.isFinite(n) && n > 0 ? n : 256 * 1024
}

function completionsDir(): string {
  return process.env.TANDEM_COMPLETIONS_DIR ?? join(homedir(), '.tandem', 'completions')
}

export function logPath(): string {
  return join(completionsDir(), 'log.jsonl')
}

/**
 * Read the tail of the log. Returns the raw text plus whether the window was
 * clipped (i.e. older records exist above it).
 */
function readTail(path: string): { text: string; clipped: boolean } {
  if (!existsSync(path)) return { text: '', clipped: false }
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return { text: '', clipped: false }
    const window = Math.min(size, tailBytes())
    const start = size - window
    const buf = Buffer.allocUnsafe(window)
    let read = 0
    while (read < window) {
      const n = readSync(fd, buf, read, window - read, start + read)
      if (n <= 0) break
      read += n
    }
    return { text: buf.subarray(0, read).toString('utf8'), clipped: start > 0 }
  } catch {
    // An unreadable/vanished log is "no completions", never a tool error.
    return { text: '', clipped: false }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fd already gone */
      }
    }
  }
}

function isRecord(v: unknown): v is CompletionRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['session_id'] === 'string' &&
    typeof r['finished_at'] === 'string' &&
    r['finished_at'].length > 0
  )
}

/** Parse tail text into records, skipping blank and malformed lines. */
function parseLines(text: string, clipped: boolean): CompletionRecord[] {
  const lines = text.split('\n')
  // The first line of a clipped window may be a fragment of an earlier record.
  if (clipped) lines.shift()
  const out: CompletionRecord[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // torn write or hand-edit — ignore, never throw
    }
    if (!isRecord(parsed)) continue
    out.push({
      session_id: parsed.session_id,
      brand: typeof parsed.brand === 'string' ? parsed.brand : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      finished_at: parsed.finished_at,
    })
  }
  return out
}

function matchesSession(r: CompletionRecord, needle: string): boolean {
  if (r.session_id === needle) return true
  const n = needle.toLowerCase()
  return r.brand.toLowerCase().includes(n) || r.cwd.toLowerCase().includes(n)
}

/**
 * Read recent completion records, newest first.
 *
 * `since` uses a plain string compare — safe because finished_at is fixed-width
 * ISO-8601 with a literal Z, so lexicographic order IS chronological order.
 * The compare is strict (>), so re-passing a returned cursor never re-emits the
 * record it came from.
 */
export function readCompletions(opts: CompletionsOpts = {}): CompletionsResult {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const { text, clipped } = readTail(logPath())
  const all = parseLines(text, clipped)

  if (all.length === 0) return { completions: [], cursor: null, truncated: false }

  // Cursor reflects everything in the window, BEFORE filtering, so a caller
  // whose filter matched nothing still advances past what it has seen.
  let cursor: string | null = null
  for (const r of all) if (cursor === null || r.finished_at > cursor) cursor = r.finished_at

  let rows = all
  if (opts.since) rows = rows.filter((r) => r.finished_at > (opts.since as string))
  if (opts.session) rows = rows.filter((r) => matchesSession(r, opts.session as string))

  if (!opts.allTurns) {
    // Collapse to the newest record per session_id. The hook fires per turn, so
    // the uncollapsed feed repeats a busy session many times over.
    const newest = new Map<string, CompletionRecord>()
    for (const r of rows) {
      const prev = newest.get(r.session_id)
      if (!prev || r.finished_at > prev.finished_at) newest.set(r.session_id, r)
    }
    rows = [...newest.values()]
  }

  // Reverse-chronological. Tie-break on session_id so equal-second records have
  // a stable, deterministic order rather than depending on Map insertion.
  rows.sort((a, b) =>
    a.finished_at === b.finished_at
      ? a.session_id.localeCompare(b.session_id)
      : a.finished_at < b.finished_at
        ? 1
        : -1,
  )

  const truncated = clipped || rows.length > limit
  return { completions: rows.slice(0, limit), cursor, truncated }
}
