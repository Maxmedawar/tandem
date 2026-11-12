/**
 * transcripts/index.ts: a pointer to the agent's own history file for every session Tandem starts,
 * with that file's sha256 fingerprint, kept in `<base>/transcripts/index.sqlite3` (folder 0700,
 * file 0600; `<base>` = TANDEM_HOME, else ~/.tandem, read once at load).
 *
 * A row is noted only when the agent's harness file names `history` (harnesses/SCHEMA.md). The file
 * is found later, at the first transcriptFor (the agent may create it only on its first message):
 * a reader in ./readers/ finds it for its agent; any other agent's `history` file is the pointer
 * itself, and a `history` folder gives its earliest regular file created since the session started.
 * Only a file a Tandem session started is ever pointed to, returned or stored: Tandem never lists
 * agents' history. No function throws to its caller; a failure writes one stderr line holding no
 * path and no text.
 */
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, mkdirSync, type Dirent, type Stats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tandemHome } from '../tandem-home.ts'
import { loadedHarnesses } from '../engine-registry.ts'
import { DatabaseSync, type DatabaseSync as NodeDatabaseSync, ensureDbFile } from '../sqlite-file.ts'
import * as claudeReader from './readers/claude.ts'
import * as codexReader from './readers/codex.ts'

/** Tandem's transcript folder: pane logs (terminal-session.ts) and the pointer index. */
export const TRANSCRIPTS_DIR = join(tandemHome(), 'transcripts')
const DB_PATH = join(TRANSCRIPTS_DIR, 'index.sqlite3')

export interface Message {
  role: 'user' | 'assistant'
  text: string
}

export interface Pointer {
  name: string
  agent: string
  cwd: string
  startedAtMs: number
  path?: string
  sha256?: string
  bytes?: number
  mtimeMs?: number
  recordedAtMs?: number
}

interface Reader {
  agent: string
  locate(root: string, cwd: string, sinceMs: number, taken: Set<string>): Promise<string | undefined>
  readMessages(path: string): Promise<{ id: string; cwd: string; messages: Message[] }>
}

const READERS = new Map<string, Reader>([claudeReader, codexReader].map((r): [string, Reader] => [r.agent, r]))

interface Row {
  rowid: number
  name: string
  agent: string
  cwd: string
  started_at: number
  path: string | null
  sha256: string | null
  bytes: number | null
  mtime_ms: number | null
  recorded_at: number | null
}

/** One stderr line: the step and the error code, never a path or any text. */
function warn(step: string, e: unknown): void {
  const code = (e as { code?: unknown })?.code
  process.stderr.write(`[transcripts] ${step} failed (${typeof code === 'string' ? code : e instanceof Error ? e.name : 'error'})\n`)
}

let handle: NodeDatabaseSync | undefined
function db(): NodeDatabaseSync {
  if (handle) return handle
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(TRANSCRIPTS_DIR, 0o700)
  // Never let SQLite create the file under the process umask; never close a plain handle of an existing one.
  ensureDbFile(DB_PATH)
  const d = new DatabaseSync(DB_PATH)
  d.exec(`CREATE TABLE IF NOT EXISTS transcript_pointers (
    name TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, started_at INTEGER NOT NULL,
    path TEXT, sha256 TEXT, bytes INTEGER, mtime_ms REAL, recorded_at INTEGER);
    CREATE INDEX IF NOT EXISTS transcript_pointers_name ON transcript_pointers (name, started_at)`)
  handle = d
  return d
}

const created = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs)
const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** A `history` that is neither claude's nor codex's: a file is the pointer itself (shared by its
 *  sessions); a folder gives its earliest regular file created at or after `sinceMs - 2000`, at
 *  most 4 levels down, symlinks skipped (so never a path outside the folder), not taken. */
async function locateAny(root: string, sinceMs: number, taken: Set<string>): Promise<string | undefined> {
  const top = await stat(root).catch(() => undefined)
  if (top?.isFile()) return root
  if (!top?.isDirectory()) return undefined
  let best: { path: string; at: number } | undefined
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 4) await walk(path, depth + 1)
      } else if (e.isFile() && !taken.has(path)) {
        const st = await lstat(path).catch(() => undefined)
        if (st?.isFile() && created(st) >= sinceMs - 2000 && (!best || created(st) < best.at)) best = { path, at: created(st) }
      }
    }
  }
  await walk(root, 1)
  return best?.path
}

/** sha256 hex of the file's first `size` bytes, streamed; with its size and mtime. */
async function fingerprint(path: string): Promise<{ sha256: string; bytes: number; mtimeMs: number }> {
  const st = await stat(path)
  const hash = createHash('sha256')
  if (st.size > 0) for await (const chunk of createReadStream(path, { start: 0, end: st.size - 1 })) hash.update(chunk)
  return { sha256: hash.digest('hex'), bytes: st.size, mtimeMs: st.mtimeMs }
}

function toPointer(r: Row): Pointer {
  const p: Pointer = { name: r.name, agent: r.agent, cwd: r.cwd, startedAtMs: r.started_at }
  if (r.path !== null) p.path = r.path
  if (r.sha256 !== null) p.sha256 = r.sha256
  if (r.bytes !== null) p.bytes = r.bytes
  if (r.mtime_ms !== null) p.mtimeMs = r.mtime_ms
  if (r.recorded_at !== null) p.recordedAtMs = r.recorded_at
  return p
}

/** A row for a session Tandem started, only when its agent's harness file names `history`. */
export function noteSessionStart(s: { name: string; agent: string; cwd: string; startedAtMs: number }): void {
  try {
    if (!loadedHarnesses().get(s.agent)?.history) return
    db().prepare('INSERT INTO transcript_pointers (name, agent, cwd, started_at) VALUES (?, ?, ?, ?)').run(s.name, s.agent, s.cwd, s.startedAtMs)
  } catch (e) {
    warn('note session start', e)
  }
}

// One lookup at a time, so two sessions in one folder never claim the same file.
let queue: Promise<unknown> = Promise.resolve()

/** The newest row for `name`: its file found when not yet known, re-hashed when its size or mtime changed. */
export function transcriptFor(name: string): Promise<Pointer | undefined> {
  const run = queue.then(() => lookup(name))
  queue = run
  return run
}

async function lookup(name: string): Promise<Pointer | undefined> {
  try {
    const d = db()
    const row = d.prepare('SELECT rowid, * FROM transcript_pointers WHERE name = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(name) as Row | undefined
    if (!row) return undefined
    let path = row.path
    if (path === null) {
      const history = loadedHarnesses().get(row.agent)?.history
      if (!history) return toPointer(row)
      const taken = new Set(
        (d.prepare('SELECT path FROM transcript_pointers WHERE path IS NOT NULL AND rowid != ?').all(row.rowid) as { path: string }[]).map((r) => r.path),
      )
      const reader = READERS.get(row.agent)
      const locate = (r: Row, skip: Set<string>) =>
        reader ? reader.locate(expand(history), r.cwd, r.started_at, skip) : locateAny(expand(history), r.started_at, skip)
      // Earlier sessions of this agent that are still open and have no file yet set theirs aside first
      // (not stored), so a later session never takes an earlier one's file, whatever the lookup order.
      // None left for this one: those sessions have no file of their own yet, so nothing is set aside.
      const reserved = new Set(taken)
      const earlier = d
        .prepare(
          'SELECT rowid, * FROM transcript_pointers WHERE agent = ? AND path IS NULL AND recorded_at IS NULL AND (started_at < ? OR (started_at = ? AND rowid < ?)) ORDER BY started_at, rowid',
        )
        .all(row.agent, row.started_at, row.started_at, row.rowid) as unknown as Row[]
      for (const e of earlier) {
        const f = await locate(e, reserved)
        if (f) reserved.add(f)
      }
      path = (await locate(row, reserved)) ?? (earlier.length ? await locate(row, taken) : undefined) ?? null
      if (path === null) return toPointer(row)
    }
    const st = await stat(path).catch(() => undefined)
    if (!st) return toPointer(row)
    if (row.path === path && st.size === row.bytes && st.mtimeMs === row.mtime_ms) return toPointer(row)
    const f = await fingerprint(path)
    const now = Date.now()
    d.prepare('UPDATE transcript_pointers SET path = ?, sha256 = ?, bytes = ?, mtime_ms = ?, recorded_at = ? WHERE rowid = ?').run(path, f.sha256, f.bytes, f.mtimeMs, now, row.rowid)
    return toPointer({ ...row, path, sha256: f.sha256, bytes: f.bytes, mtime_ms: f.mtimeMs, recorded_at: now })
  } catch (e) {
    warn('transcript lookup', e)
    return undefined
  }
}

/** A final transcriptFor when the session closes. A row still with no file gets `recorded_at` (closed
 *  before its file was found), so it never sets aside a later session's file. */
export async function noteSessionClose(name: string): Promise<void> {
  const p = await transcriptFor(name)
  if (!p || p.path) return
  try {
    db()
      .prepare('UPDATE transcript_pointers SET recorded_at = ? WHERE rowid = (SELECT rowid FROM transcript_pointers WHERE name = ? ORDER BY started_at DESC, rowid DESC LIMIT 1) AND path IS NULL')
      .run(Date.now(), name)
  } catch (e) {
    warn('note session close', e)
  }
}

/** The pointer, plus the messages when a reader exists for its agent and its file is known. */
export async function readTranscript(name: string): Promise<{ pointer: Pointer; messages?: Message[] } | undefined> {
  const pointer = await transcriptFor(name)
  if (!pointer) return undefined
  const reader = READERS.get(pointer.agent)
  if (!reader || !pointer.path) return { pointer }
  try {
    return { pointer, messages: (await reader.readMessages(pointer.path)).messages }
  } catch (e) {
    warn('transcript read', e)
    return { pointer }
  }
}
