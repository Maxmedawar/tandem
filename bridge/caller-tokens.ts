/**
 * caller-tokens.ts: a caller token per session (U-R1A-36A), so the bridge knows which agent asks.
 *
 * TerminalSession.spawn (the one place every session starts) mints a token for the session's exact
 * name right before tmux new-session and hands it to that session alone (`new-session -e
 * TANDEM_CALLER_TOKEN=...`); close() revokes it. An agent's own stdio server (src/stdio-server.ts)
 * reads the variable once at start, deletes it from its environment, and resolves it here: a name
 * makes that process the agent `session:<name>` for its whole life (setProcessCaller); an unknown
 * token refuses to start, never the owner. No token at all is the owner's own client, as before.
 *
 * Storage: table `caller_tokens` in `<TANDEM_HOME, else ~/.tandem>/state.db` (folder 0700, file
 * 0600, opened as bridge/mailbox.ts opens it). A token is 32 random bytes as base64url; only its
 * SHA-256 is stored, and a lookup goes by that hash, so the token itself is never compared, stored
 * or logged. One row per exact name (case kept): a new spawn of a name replaces its token. A row
 * outlives a bridge restart, so an adopted session keeps the token its agent already has.
 *
 * Stated limits (T23, same user): any process inside the session can read the token from the
 * agent's environment, and an agent that strips the variable before starting its stdio server is
 * the owner: the token names an agent, it does not wall agents off from each other. The tmux client
 * holds `-e TANDEM_CALLER_TOKEN=...` in its argument list while the new-session call runs (visible
 * to the same user only). A session that dies without close() keeps a valid row until its name is
 * spawned again.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Vitest does not know about this Node 22 builtin; native require keeps the real node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

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
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  chmodSync(path, 0o600)
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS caller_tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_ms INTEGER NOT NULL)`)
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

/** A fresh token for `name`, replacing that exact name's row. Only its hash is stored. */
export function mintCallerToken(name: string): string {
  checkName(name)
  const token = randomBytes(32).toString('base64url')
  withTokens((db) =>
    db.prepare(`INSERT INTO caller_tokens (name, hash, created_ms) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, created_ms = excluded.created_ms`).run(name, hashOf(token), Date.now()),
  )
  return token
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
