/**
 * presence-store.ts — the latest presence envelope each computer sent to each other one.
 *
 * One row per (sender, receiver): a newer envelope replaces the older one. A row older than
 * PRESENCE_TTL_MS is removed at the next put. The store keeps the text as given (opaque: the
 * receiver checks its signature); the route (index.ts) checks sizes and who may send. At most
 * 100 x 100 rows of MAX_PRESENCE_BYTES.
 *
 * A plain synchronous class over injected SQL storage (the shape of a Durable Object's
 * ctx.storage.sql), a clock and a transaction runner, as ./queue is, so it tests on a local
 * SQLite file. This file deliberately does not import the Workers runtime.
 */

import type { QueueSql } from './queue'

export const PRESENCE_TTL_MS = 86_400_000
export const MAX_PRESENCE_BYTES = 16_384

export interface PresenceItem {
  to: string
  envelope: string
}

export interface PresenceRow {
  from: string
  envelope: string
  at: number
}

export class PresenceStore {
  private readonly sql: QueueSql
  private readonly now: () => number
  private readonly transaction: <T>(fn: () => T) => T

  constructor(sql: QueueSql, now: () => number, transaction: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql = sql
    this.now = now
    this.transaction = transaction
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_presence (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, envelope TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id))`)
  }

  /** In one transaction: drop rows past PRESENCE_TTL_MS, then keep each item as the latest from `from` to its `to`. */
  put(from: string, items: PresenceItem[]): void {
    if (items.length === 0) return
    this.transaction(() => {
      const now = this.now()
      this.sql.exec('DELETE FROM hub_presence WHERE at < ?', now - PRESENCE_TTL_MS)
      for (const item of items) {
        this.sql.exec(
          'INSERT INTO hub_presence (from_id, to_id, envelope, at) VALUES (?, ?, ?, ?) ON CONFLICT (from_id, to_id) DO UPDATE SET envelope = excluded.envelope, at = excluded.at',
          from, item.to, item.envelope, now,
        )
      }
    })
  }

  /** The rows addressed to `to`, sorted by sender. */
  for(to: string): PresenceRow[] {
    return this.sql
      .exec('SELECT from_id, envelope, at FROM hub_presence WHERE to_id = ? ORDER BY from_id', to)
      .toArray()
      .map((r) => ({ from: String(r.from_id), envelope: String(r.envelope), at: Number(r.at) }))
  }
}
