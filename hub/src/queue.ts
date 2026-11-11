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
 *
 * The logic is a plain class over injected SQL storage (the shape of a Durable
 * Object's ctx.storage.sql) and a clock, so it tests on a local SQLite file. Every method
 * is synchronous: inside the Durable Object one call never interleaves with
 * another. This file deliberately does not import 'cloudflare:workers'.
 * `body` is opaque: the queue never parses it.
 */

export const MAX_COPIES = 1000
export const MAX_BYTES = 10 * 1024 * 1024
export const TTL_MS = 7 * 86_400_000

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

export class HubQueue {
  private readonly sql: QueueSql
  private readonly now: () => number

  constructor(sql: QueueSql, now: () => number) {
    this.sql = sql
    this.now = now
    sql.exec(`CREATE TABLE IF NOT EXISTS queue_copies (
      to_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, from_id TEXT NOT NULL,
      room TEXT, room_seq INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL,
      bytes INTEGER NOT NULL, queued_at INTEGER NOT NULL, PRIMARY KEY (to_id, seq))`)
    sql.exec('CREATE INDEX IF NOT EXISTS queue_copies_queued_at ON queue_copies (queued_at)')
    // Last number handed out, per 'c:<computer>' and per 'r:<room>'.
    sql.exec('CREATE TABLE IF NOT EXISTS queue_counters (key TEXT PRIMARY KEY, last INTEGER NOT NULL)')
  }

  /** Queue one copy per receiving computer. One result per computer, in `to` order. */
  put(msg: QueueMessage): PutResult[] {
    const to = [...new Set(msg.to)]
    if (to.length === 0) throw new Error('queue put: `to` is empty')
    this.expire()
    const now = this.now()
    const bytes = new TextEncoder().encode(msg.body).byteLength
    const room = msg.room ?? null
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
  }

  /** That computer's copies after `afterSeq`, in `seq` order. */
  take(to: string, afterSeq = 0, limit = 100): QueuedCopy[] {
    this.expire()
    return this.sql
      .exec(
        'SELECT id, from_id, room, room_seq, seq, kind, body FROM queue_copies WHERE to_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        to,
        afterSeq,
        limit,
      )
      .toArray()
      .map((r) => ({
        id: String(r.id),
        from: String(r.from_id),
        room: r.room === null ? null : String(r.room),
        room_seq: r.room_seq === null ? null : Number(r.room_seq),
        seq: Number(r.seq),
        kind: r.kind === 'expired' ? 'expired' : 'message',
        body: String(r.body),
      }))
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
