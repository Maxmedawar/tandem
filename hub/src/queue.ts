/**
 * queue.ts — the hub's durable queue, one per receiving computer.
 *
 * Messages to a computer that is offline wait here until it takes them. Every
 * accepted copy gets that computer's next running number (`seq`); a message to a
 * room also gets the room's next number (`room_seq`), the same on every copy, so
 * every member reads a group chat in one order. Numbers are never reused.
 *
 * Limits per receiving computer: MAX_COPIES copies or MAX_BYTES of body (UTF-8);
 * a copy over either is refused, an older one is never dropped. A copy queued more
 * than TTL_MS ago is removed and the sender's computer gets one `expired` receipt.
 * Every copy must fit one link frame: `put` throws, before anything is written, when
 * its copy as `take` returns it (JSON, UTF-8, both numbers at their widest) is over
 * MAX_COPY_BYTES, when a name or the body is not well-formed text (a lone
 * surrogate), or when `to` is empty. `take` pages by bytes: a page's copies sum to
 * at most `maxBytes`, except that the first waiting copy always comes back.
 *
 * The logic is a plain class over injected SQL storage (the shape of a Durable
 * Object's ctx.storage.sql), a clock and a transaction runner, so it tests on a
 * local SQLite file. `put` and `take` each run their writes in one transaction:
 * all or nothing. Every method is synchronous: inside the Durable Object one call
 * never interleaves with another. This file deliberately does not import
 * 'cloudflare:workers'. `body` is opaque: the queue never parses it.
 *
 * Epoch (U-R1A-33B-4): 16 random bytes as base64url (22 characters) kept in `queue_meta` in the
 * same storage as the copies and the counters. It changes only when that storage is new (a new
 * hub, a deleted Durable Object, wiped storage: exactly when the seq numbers start again), never on
 * a deploy, a restart, a roster change or with time. A take that names it (`takeFor`) acks as
 * before; one that names '' or another epoch deletes nothing and is answered from seq 0 with this
 * epoch, so a bridge whose numbers come from another queue life never acks copies it has not seen.
 * A take with no epoch is answered exactly as before.
 */

import { WS_MAX_FRAME_BYTES } from './frame-size'

export const MAX_COPIES = 1000
export const MAX_BYTES = 10 * 1024 * 1024
export const TTL_MS = 7 * 86_400_000
/** Largest copy, as JSON in UTF-8; the rest of a frame is left for its own fields. */
export const MAX_COPY_BYTES = WS_MAX_FRAME_BYTES - 65_536

/** The part of ctx.storage.sql the queue uses. */
export interface QueueSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
}

export interface QueueMessage {
  id: string
  from: string
  /** Receiving computers. A name listed twice counts once. */
  to: string[]
  room?: string
  body: string
}

const EPOCH = /^[A-Za-z0-9_-]{22}$/

/** A take request: exactly `{ ack }` or `{ ack, epoch }`, ack a whole number >= 0, epoch '' or 22 base64url characters; else undefined. */
export function takeRequest(value: unknown): { ack: number; epoch?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const o = value as Record<string, unknown>
  const keys = Object.keys(o).sort().join()
  if ((keys !== 'ack' && keys !== 'ack,epoch') || !Number.isSafeInteger(o.ack) || (o.ack as number) < 0) return undefined
  if (keys === 'ack') return { ack: o.ack as number }
  if (typeof o.epoch !== 'string' || !(o.epoch === '' || EPOCH.test(o.epoch))) return undefined
  return { ack: o.ack as number, epoch: o.epoch }
}

export type PutResult = { to: string; seq: number } | { to: string; error: 'queue_full' }

export interface QueuedCopy {
  id: string
  /** The sender; on an `expired` receipt, the computer the copy never reached. */
  from: string
  room: string | null
  room_seq: number | null
  seq: number
  kind: 'message' | 'expired'
  body: string
}

/** UTF-8 bytes of a copy as JSON, keys in QueuedCopy order. */
function copyBytes(c: QueuedCopy): number {
  const { id, from, room, room_seq, seq, kind, body } = c
  return new TextEncoder().encode(JSON.stringify({ id, from, room, room_seq, seq, kind, body })).byteLength
}

export class HubQueue {
  private readonly sql: QueueSql
  private readonly now: () => number
  private readonly transaction: <T>(fn: () => T) => T
  private readonly storeEpoch: string

  constructor(sql: QueueSql, now: () => number, transaction: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql = sql
    this.now = now
    this.transaction = transaction
    sql.exec(`CREATE TABLE IF NOT EXISTS queue_copies (
      to_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, from_id TEXT NOT NULL,
      room TEXT, room_seq INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL,
      bytes INTEGER NOT NULL, queued_at INTEGER NOT NULL, PRIMARY KEY (to_id, seq))`)
    sql.exec('CREATE INDEX IF NOT EXISTS queue_copies_kind_queued_at ON queue_copies (kind, queued_at)')
    // Last number handed out, per 'c:<computer>' and per 'r:<room>'.
    sql.exec('CREATE TABLE IF NOT EXISTS queue_counters (key TEXT PRIMARY KEY, last INTEGER NOT NULL)')
    // The epoch of this storage: written once, when it is new; read back on every later start.
    sql.exec('CREATE TABLE IF NOT EXISTS queue_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    sql.exec("INSERT INTO queue_meta (k, v) VALUES ('epoch', ?) ON CONFLICT (k) DO NOTHING", fresh)
    this.storeEpoch = String(sql.exec("SELECT v FROM queue_meta WHERE k = 'epoch'").toArray()[0].v)
  }

  /** This storage's epoch (see the file header). */
  get epoch(): string {
    return this.storeEpoch
  }

  /**
   * A mail take: no `epoch`, ack then the page after `ack` as `{ copies }` (as before); this
   * storage's epoch, the same with `epoch`; '' or another one, nothing deleted and the page from
   * seq 0 with this storage's epoch.
   */
  takeFor(to: string, ack: number, epoch?: string): { copies: QueuedCopy[]; epoch?: string } {
    if (epoch === undefined || epoch === this.storeEpoch) {
      this.ack(to, ack)
      return epoch === undefined ? { copies: this.take(to, ack) } : { copies: this.take(to, ack), epoch }
    }
    return { copies: this.take(to, 0), epoch: this.storeEpoch }
  }

  /** Queue one copy per receiving computer. One result per computer, in `to` order. */
  put(msg: QueueMessage): PutResult[] {
    const to = [...new Set(msg.to)]
    if (to.length === 0) throw new Error('queue put: `to` is empty')
    for (const text of [msg.id, msg.from, ...to, msg.room ?? '', msg.body]) {
      if (!text.isWellFormed()) throw new Error('queue put: a name or the body holds a lone surrogate')
    }
    const room = msg.room ?? null
    const widest = 2 ** 53 - 1
    const size = copyBytes({ id: msg.id, from: msg.from, room, room_seq: widest, seq: widest, kind: 'message', body: msg.body })
    if (size > MAX_COPY_BYTES) throw new Error(`queue put: copy is ${size} bytes, over ${MAX_COPY_BYTES}`)
    const bytes = new TextEncoder().encode(msg.body).byteLength
    return this.transaction(() => {
      this.expire()
      const now = this.now()
      const roomSeq = room === null ? null : this.next(`r:${room}`)
      return to.map((computer): PutResult => {
        const used = this.sql
          .exec(
            "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM queue_copies WHERE to_id = ? AND kind = 'message'",
            computer,
          )
          .toArray()[0]
        if (Number(used.n) >= MAX_COPIES || Number(used.b) + bytes > MAX_BYTES) return { to: computer, error: 'queue_full' }
        const seq = this.insert(computer, msg.id, msg.from, room, roomSeq, 'message', msg.body, bytes, now)
        return { to: computer, seq }
      })
    })
  }

  /**
   * That computer's copies after `afterSeq`, in `seq` order: at most `limit`, and
   * stopping before the copy that would take the page over `maxBytes` (copyBytes).
   * The first waiting copy always comes back.
   */
  take(to: string, afterSeq = 0, limit = 100, maxBytes = MAX_COPY_BYTES): QueuedCopy[] {
    return this.transaction(() => {
      this.expire()
      const page: QueuedCopy[] = []
      let total = 0
      for (const r of this.sql
        .exec(
          'SELECT id, from_id, room, room_seq, seq, kind, body FROM queue_copies WHERE to_id = ? AND seq > ? ORDER BY seq LIMIT ?',
          to,
          afterSeq,
          limit,
        )
        .toArray()) {
        const copy: QueuedCopy = {
          id: String(r.id),
          from: String(r.from_id),
          room: r.room === null ? null : String(r.room),
          room_seq: r.room_seq === null ? null : Number(r.room_seq),
          seq: Number(r.seq),
          kind: r.kind === 'expired' ? 'expired' : 'message',
          body: String(r.body),
        }
        total += copyBytes(copy)
        if (page.length > 0 && total > maxBytes) break
        page.push(copy)
      }
      return page
    })
  }

  /** Delete that computer's copies up to and including `uptoSeq`. */
  ack(to: string, uptoSeq: number): void {
    this.sql.exec('DELETE FROM queue_copies WHERE to_id = ? AND seq <= ?', to, uptoSeq)
  }

  /** Remove every message copy older than TTL_MS; queue one receipt to its sender. Receipts never expire. */
  private expire(): void {
    const now = this.now()
    const old = this.sql
      .exec(
        "SELECT to_id, seq, id, from_id FROM queue_copies WHERE kind = 'message' AND queued_at < ? ORDER BY queued_at, to_id, seq",
        now - TTL_MS,
      )
      .toArray()
    for (const r of old) {
      this.sql.exec('DELETE FROM queue_copies WHERE to_id = ? AND seq = ?', r.to_id, r.seq)
      this.insert(String(r.from_id), String(r.id), String(r.to_id), null, null, 'expired', '', 0, now)
    }
  }

  private insert(
    to: string, id: string, from: string, room: string | null, roomSeq: number | null,
    kind: QueuedCopy['kind'], body: string, bytes: number, now: number,
  ): number {
    const seq = this.next(`c:${to}`)
    this.sql.exec(
      'INSERT INTO queue_copies (to_id, seq, id, from_id, room, room_seq, kind, body, bytes, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      to, seq, id, from, room, roomSeq, kind, body, bytes, now,
    )
    return seq
  }

  private next(key: string): number {
    const row = this.sql
      .exec(
        'INSERT INTO queue_counters (key, last) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET last = last + 1 RETURNING last',
        key,
      )
      .toArray()[0]
    return Number(row.last)
  }
}
