/**
 * caller-tokens.ts: a caller token per session (U-R1A-36A), so the bridge knows which agent asks.
 *
 * TerminalSession.spawn (the one place every session starts) mints a token for the session's exact
 * name right before tmux new-session and hands it to that session's pane alone (`new-session -e
 * TANDEM_CALLER_TOKEN=...`, unset from the session environment in the same call); close() revokes it. An agent's own stdio server (src/stdio-server.ts)
 * reads the variable once at start, deletes it from its environment, and resolves it here: a name
 * makes that process the agent `session:<name>` for its whole life (setProcessCaller); an unknown
 * token refuses to start, never the owner. No token at all is the owner's own client, as before.
 *
 * Storage: table `caller_tokens` in `<TANDEM_HOME, else ~/.tandem>/state.db` (folder 0700, file
 * 0600, opened as bridge/mailbox.ts opens it). A token is 32 random bytes as base64url; only its
 * SHA-256 is stored, and a lookup goes by that hash, so the token itself is never compared, stored
 * or logged. One row per exact name (case kept): a new spawn of a name replaces its token. A row
 * outlives a bridge restart, so an adopted session keeps the token its agent already has.
 * The row also keeps the session's real start folder (`folder`, U-R1A-47; spawn passes its checked
 * cwd), which src/mcp-server.ts reads at each memory or transcript call (callerFolder) to keep an
 * agent's reach to its own project. A table made before that gains the column at first use; its
 * rows have no folder, and such an agent gets no memory or transcript tools until it is reopened.
 *
 * Stated limits (T23, same user): the token names an agent, it does not wall agents of one user
 * off from each other. An agent that strips the variable before starting its stdio server is
 * refused when that server runs under one of Tandem's panes (insideTandemSession, U-R1A-36C), but
 * one started detached from its session is the owner. The token lives in the environment of the
 * pane's processes (not in the tmux session environment: spawn removes it there in the same tmux
 * call), so a process of this user can still
 * read it with `ps eww` (macOS: any program that is not Apple's own; Linux: /proc/<pid>/environ),
 * and the tmux client holds `-e TANDEM_CALLER_TOKEN=...` in its argument list while new-session
 * runs. A process of this user can also write its own row into state.db. A session that ends
 * without close() keeps its row until the name is spawned again; the stdio server refuses such a
 * token at start (the session must be there), and one already running checks it again at every
 * tool call (callerStillLive).
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync, ensureDbFile } from './sqlite-file.ts'

/** 32 bytes as base64url, no padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/
/** A session name (bridge/sessions.ts NAME_RE): ASCII only, so no control, bidi or tag character. */
const NAME = /^[A-Za-z0-9._-]{1,256}$/

function withTokens<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const path = join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'state.db')
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // Never let SQLite create the file under the process umask. Only when it is missing: closing a
  // descriptor of the file drops every lock this process's open connections (the mailbox) hold on it.
  ensureDbFile(path)
  chmodSync(path, 0o600)
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS caller_tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_ms INTEGER NOT NULL, folder TEXT)`)
    // A table from before U-R1A-47 has no folder column. Two processes may add it at once: the
    // loser's ALTER fails and the column is there all the same.
    const hasFolder = () => (db.prepare('PRAGMA table_info(caller_tokens)').all() as { name?: unknown }[]).some((c) => c.name === 'folder')
    if (!hasFolder()) {
      try {
        db.exec('ALTER TABLE caller_tokens ADD COLUMN folder TEXT')
      } catch (e) {
        if (!hasFolder()) throw e
      }
    }
    return fn(db)
  } finally {
    db.close()
  }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

function checkName(name: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('caller token: invalid session name')
  return name
}

/**
 * A fresh token for `name`, replacing that exact name's row. Only its hash is stored, with the
 * session's real start folder (an absolute path, else this throws). TerminalSession.spawn always
 * passes it; a row minted without one has no folder, so its agent gets no memory or transcript tools
 * under the project scopes (fail closed).
 */
export function mintCallerToken(name: string, folder?: string): string {
  checkName(name)
  if (folder !== undefined && (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0'))) {
    throw new Error('caller token: the session folder must be an absolute path')
  }
  const token = randomBytes(32).toString('base64url')
  withTokens((db) =>
    db.prepare(`INSERT INTO caller_tokens (name, hash, created_ms, folder) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, created_ms = excluded.created_ms, folder = excluded.folder`)
      .run(name, hashOf(token), Date.now(), folder ?? null),
  )
  return token
}

/** The start folder kept with `name`'s row, or undefined (no row, or a row without one). Read at each call. */
export function callerFolder(name: string): string | undefined {
  checkName(name)
  const row = withTokens((db) => db.prepare('SELECT folder FROM caller_tokens WHERE name = ?').get(name)) as { folder?: unknown } | undefined
  return typeof row?.folder === 'string' && row.folder !== '' ? row.folder : undefined
}

/** The exact name a token was minted for, or undefined (not a well-formed token, unknown or revoked). */
export function resolveCallerToken(token: unknown): string | undefined {
  if (typeof token !== 'string' || !TOKEN.test(token)) return undefined
  const row = withTokens((db) => db.prepare('SELECT name FROM caller_tokens WHERE hash = ?').get(hashOf(token))) as { name?: unknown } | undefined
  return typeof row?.name === 'string' ? row.name : undefined
}

/** Deletes that exact name's row (another case of the name keeps its own). */
export function revokeCallerToken(name: string): void {
  checkName(name)
  withTokens((db) => db.prepare('DELETE FROM caller_tokens WHERE name = ?').run(name))
}

let caller: string | undefined

/** This process serves the agent `name` (a stdio server started with its token): once per process. */
export function setProcessCaller(name: string): void {
  if (caller !== undefined) throw new Error('caller: already set for this process')
  caller = checkName(name)
}

/** The agent this process serves, or undefined for the owner's own client. */
export function processCaller(): string | undefined {
  return caller
}

/**
 * The parent process id of `pid`: /proc/<pid>/stat on Linux, `ps -o ppid= -p <pid>` (execFile, no
 * shell) elsewhere. A process that is gone, or a missing ps, throws.
 */
export async function parentPidOf(pid: number): Promise<number> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('parent pid: bad pid')
  let text: string
  if (process.platform === 'linux') {
    // `<pid> (<comm>) <state> <ppid> ...`; comm may hold spaces or `)`, so read after the last `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    text = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? ''
  } else {
    text = await new Promise<string>((done, fail) =>
      execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (error, stdout) => (error ? fail(error) : done(String(stdout)))),
    )
  }
  const ppid = Number(text.trim())
  if (!Number.isSafeInteger(ppid) || ppid < 0 || text.trim() === '') throw new Error('parent pid: unreadable')
  return ppid
}

/** The program name of `pid`: /proc/<pid>/comm on Linux, `ps -o comm= -p <pid>` elsewhere. */
async function programNameOf(pid: number): Promise<string> {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  return await new Promise<string>((done, fail) =>
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], (error, stdout) => (error ? fail(error) : done(String(stdout).trim()))),
  )
}

/**
 * The Tandem session (its name without `ccm-`) whose pane process is `pid` or one of its parents
 * (stopping at pid 1 or a repeat), else undefined. The panes are read once from Tandem's socket
 * (bridge/terminal-session.ts tmux()); no server running, or a server with no session, is no session. Fails closed (throws) when
 * it cannot tell: a parent id that cannot be read, a refused socket folder, more than 64 parents,
 * or no tmux program to ask while one of the parents is a tmux server (an agent that starts this
 * with a bare PATH is not the owner). The socket is the one TANDEM_HOME names for THIS process: a
 * start with another TANDEM_HOME looks at that home's sessions (stated limit, harnesses/SCHEMA.md).
 */
export async function insideTandemSession(pid: number): Promise<string | undefined> {
  const { tmux } = await import('./terminal-session.ts')
  let listed: string | undefined
  try {
    listed = await tmux(['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'])
  } catch (e) {
    // A server with no session answers `no current target` (tmux 3.4 and 3.6b): no session either (36F G1).
    if (/no server running|error connecting to|no current target/.test(String(e))) return undefined
    if ((e as { code?: unknown }).code !== 'ENOENT') throw e
  }
  const panes = new Map<number, string>()
  for (const line of (listed ?? '').split('\n')) {
    const m = /^ccm-([A-Za-z0-9._-]{1,256}) (\d+)$/.exec(line)
    if (m) panes.set(Number(m[2]), m[1]!)
  }
  if (listed !== undefined && panes.size === 0) return undefined
  const seen = new Set<number>()
  for (let p = pid, step = 0; p > 1 && !seen.has(p); step++) {
    if (step >= 64) throw new Error('inside a session: too many parents to tell')
    const name = panes.get(p)
    if (name !== undefined) return name
    if (listed === undefined && /^tmux/.test(basename(await programNameOf(p)))) {
      throw new Error('inside a session: under a tmux server with no tmux program to ask')
    }
    seen.add(p)
    p = await parentPidOf(p)
  }
  return undefined
}

/** The token still names `name` and that session is there on Tandem's socket; any failure is false. */
export async function callerStillLive(token: string, name: string): Promise<boolean> {
  try {
    if (resolveCallerToken(token) !== name) return false
    const { TerminalSession } = await import('./terminal-session.ts')
    return await TerminalSession.exists(name)
  } catch {
    return false
  }
}
