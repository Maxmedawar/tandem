/**
 * envelope.ts: the signed envelope every message or command between computers travels in (plan
 * section 3, "Who sent it: keys and the roster"; the hub passes things on, it never vouches for
 * who sent them). An envelope is exactly `{ v: 1, from, to, nonce, ts, body_sha256, sig, body }`,
 * at most 1,048,576 bytes as JSON. The signature covers the UTF-8 bytes of
 * `tandem-envelope-v1\n<from>\n<to>\n<nonce>\n<ts>\n<body_sha256>` (domain-separated, no JSON
 * canonicalization), so a forged sender, a changed body, a message for another computer, a moved
 * time or nonce and a replay are each refused by openEnvelope with an EnvelopeError reason.
 *
 * The sender's public key is passed in (the roster, U-R1A-31, comes later). Nonces are kept in
 * the table `envelope_seen` of `<TANDEM_HOME, else ~/.tandem>/state.db` (the mailbox's file), so
 * a replay is refused after a restart too. Nothing is printed or audited here: the caller audits.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { verifySignature } from './device-keys.ts'
import type { DeviceKey } from './device-keys.ts'
import { ensureDbFile } from './sqlite-file.ts'

// Vitest does not know about this Node 22 builtin; native require keeps the real node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type Envelope = {
  v: 1
  from: string
  to: string
  nonce: string
  ts: number
  body_sha256: string
  sig: string
  body: string
}

export type Reason = 'shape' | 'to' | 'from' | 'time' | 'body' | 'signature' | 'replay'

export class EnvelopeError extends Error {
  readonly reason: Reason
  constructor(reason: Reason) {
    super(`envelope refused: ${reason}`)
    this.name = 'EnvelopeError'
    this.reason = reason
  }
}

export interface ReplayStore {
  /** True when `from` + `nonce` is new (now recorded until `expiresAt`), false when already seen. */
  remember(from: string, nonce: string, expiresAt: number): boolean
  /** True when `from` + `nonce` is recorded; nothing changes (U-R1A-33B-2: the mail carrier records a nonce only once its message is stored). */
  has(from: string, nonce: string): boolean
  size(): number
  close(): void
}

export const MAX_ENVELOPE_BYTES = 1_048_576
/** How far ahead of now a sender's clock may be, and the slack added to every nonce's lifetime. */
export const CLOCK_SKEW_MS = 300_000
export const DEFAULT_MAX_AGE_MS = 300_000
/** The longest maxAgeMs: 7 days of hub queue plus the skew (U-R1A-33 passes it for queued mail). */
export const MAX_AGE_CAP_MS = 7 * 24 * 3_600_000 + CLOCK_SKEW_MS

const ID = /^[a-z0-9._-]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{22}$/
const SHA256 = /^[0-9a-f]{64}$/
const SIG = /^[A-Za-z0-9_-]{86}$/
const LONE_SURROGATE = /\p{Cs}/u
const FIELDS = ['body', 'body_sha256', 'from', 'nonce', 'sig', 'to', 'ts', 'v'].join()

const sha256 = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex')
const signingText = (e: Omit<Envelope, 'v' | 'sig' | 'body'>) =>
  `tandem-envelope-v1\n${e.from}\n${e.to}\n${e.nonce}\n${e.ts}\n${e.body_sha256}`
const goodBody = (body: unknown): body is string => typeof body === 'string' && !LONE_SURROGATE.test(body)
const sizeOf = (e: unknown) => Buffer.byteLength(JSON.stringify(e), 'utf8')

/** A signed envelope from `from` to `to` carrying `body`; EnvelopeError 'shape' on a bad id, body or size. */
export function signEnvelope(key: Pick<DeviceKey, 'sign'>, input: { from: string; to: string; body: string }, now: number = Date.now()): Envelope {
  const { from, to, body } = input
  if (typeof from !== 'string' || !ID.test(from) || typeof to !== 'string' || !ID.test(to) || !goodBody(body) || !Number.isSafeInteger(now) || now < 0) {
    throw new EnvelopeError('shape')
  }
  const head = { from, to, nonce: randomBytes(16).toString('base64url'), ts: now, body_sha256: sha256(body) }
  const envelope: Envelope = { v: 1, ...head, sig: key.sign(signingText(head)), body }
  if (sizeOf(envelope) > MAX_ENVELOPE_BYTES) throw new EnvelopeError('shape')
  return envelope
}

/** `raw` (JSON text or a parsed object) as an Envelope when it has exactly the fields and types, else undefined. */
function parse(raw: unknown): Envelope | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) return undefined
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return undefined
  if (Reflect.ownKeys(value).map(String).sort().join() !== FIELDS) return undefined
  // Each field is read once, into a plain object: what was checked is what is returned.
  const { v, from, to, nonce, ts, body_sha256, sig, body } = value as Record<string, unknown>
  const e: Record<string, unknown> = { v, from, to, nonce, ts, body_sha256, sig, body }
  const ok =
    e.v === 1 &&
    typeof e.from === 'string' && ID.test(e.from) &&
    typeof e.to === 'string' && ID.test(e.to) &&
    typeof e.nonce === 'string' && NONCE.test(e.nonce) &&
    Number.isSafeInteger(e.ts) && (e.ts as number) >= 0 &&
    typeof e.body_sha256 === 'string' && SHA256.test(e.body_sha256) &&
    typeof e.sig === 'string' && SIG.test(e.sig) &&
    goodBody(e.body)
  if (!ok || sizeOf(e) > MAX_ENVELOPE_BYTES) return undefined
  return e as Envelope
}

export interface OpenOptions {
  /** Who the envelope must come from, and that computer's public key (base64url). */
  sender: { id: string; publicKey: string }
  /** This computer's id: the envelope must be addressed to it. */
  self: string
  seen: Pick<ReplayStore, 'remember'>
  now?: number
  /** Oldest accepted ts, in ms before now: 1 to MAX_AGE_CAP_MS, default 300,000. */
  maxAgeMs?: number
}

/**
 * The checked contents of `raw`, or EnvelopeError with the first failing reason, in order:
 * shape, to, from, time, body, signature, replay. The nonce is recorded only when every other
 * check passed, so a refused envelope never uses one up. It is kept until ts + MAX_AGE_CAP_MS +
 * CLOCK_SKEW_MS, past the longest window any later caller may pass, whatever maxAgeMs this
 * caller used: an envelope first opened with a short window stays a replay for queued mail too.
 * `seen` must run on the same clock as `now`.
 */
export function openEnvelope(raw: unknown, options: OpenOptions): { from: string; to: string; body: string; ts: number; nonce: string } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_AGE_CAP_MS) {
    throw new RangeError(`maxAgeMs must be a whole number from 1 to ${MAX_AGE_CAP_MS}`)
  }
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now)) throw new RangeError('now must be a whole number of ms')
  const e = parse(raw)
  if (!e) throw new EnvelopeError('shape')
  if (e.to !== options.self) throw new EnvelopeError('to')
  if (e.from !== options.sender.id) throw new EnvelopeError('from')
  if (now - e.ts > maxAgeMs || e.ts - now > CLOCK_SKEW_MS) throw new EnvelopeError('time')
  if (sha256(e.body) !== e.body_sha256) throw new EnvelopeError('body')
  if (!verifySignature(options.sender.publicKey, signingText(e), e.sig)) throw new EnvelopeError('signature')
  if (!options.seen.remember(e.from, e.nonce, e.ts + MAX_AGE_CAP_MS + CLOCK_SKEW_MS)) throw new EnvelopeError('replay')
  return { from: e.from, to: e.to, body: e.body, ts: e.ts, nonce: e.nonce }
}

function stateFile(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'state.db')
}

/** The nonces seen, in `path` (default `<TANDEM_HOME, else ~/.tandem>/state.db`, shared with the mailbox). */
export function openReplayStore(options: { path?: string; now?: () => number } = {}): ReplayStore {
  const path = resolve(options.path ?? stateFile())
  const now = options.now ?? Date.now
  const dir = dirname(path)
  if (!lstatSync(dir, { throwIfNoEntry: false })) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const dirMode = statSync(dir).mode & 0o777
  if (dirMode & 0o077) {
    throw new Error(`replay store ${path} refused: the folder has mode 0${dirMode.toString(8)}, not 0700`)
  }
  // Never let SQLite create the file under the process umask, and never follow a symlinked file.
  try {
    ensureDbFile(path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`replay store ${path} refused: the file is a symlink`)
    throw e
  }
  const db: NodeDatabaseSync = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS envelope_seen (
        from_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_ms INTEGER NOT NULL,
        PRIMARY KEY (from_id, nonce));
      CREATE INDEX IF NOT EXISTS envelope_seen_expires ON envelope_seen (expires_ms)`)
  } catch (e) {
    db.close()
    throw e
  }
  const sweep = db.prepare('DELETE FROM envelope_seen WHERE expires_ms < ?')
  const insert = db.prepare('INSERT OR IGNORE INTO envelope_seen (from_id, nonce, expires_ms) VALUES (?, ?, ?)')
  const count = db.prepare('SELECT count(*) AS n FROM envelope_seen')
  const find = db.prepare('SELECT 1 FROM envelope_seen WHERE from_id = ? AND nonce = ?')
  return {
    remember(from: string, nonce: string, expiresAt: number): boolean {
      sweep.run(now())
      return Number(insert.run(from, nonce, expiresAt).changes) === 1
    },
    has(from: string, nonce: string): boolean {
      return find.get(from, nonce) !== undefined
    },
    size(): number {
      return Number((count.get() as { n: number }).n)
    },
    close(): void {
      db.close()
    },
  }
}
