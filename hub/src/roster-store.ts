/**
 * roster-store.ts — the hub's copy of the owner's roster and the pairing offers waiting
 * (U-R1A-31B-2). Computers fetch and upload them through the roster routes (index.ts).
 *
 * The hub never checks a signature: every computer verifies the whole chain itself
 * (bridge/roster.ts), so a roster or offer the hub made or changed is refused there. The hub only
 * keeps one order (an upload must extend exactly the roster it holds), checks that the sender is
 * in what it uploads or is the computer it offers for, and keeps the limits: one offer per
 * computer, OFFER_SLOTS offers from other computers, MAX_POSTS accepted offer posts per computer
 * per POST_WINDOW_MS, offers dropped OFFER_TTL_MS after their own ts or when their key or id is
 * in the roster.
 *
 * The table is a plain class over injected SQL storage (the shape of a Durable Object's
 * ctx.storage.sql), a clock and a transaction runner, as ./queue.ts and ./devices.ts are, so it
 * tests on a local SQLite file. Every method is one synchronous transaction. This file
 * deliberately imports nothing from the Workers runtime.
 */

export const MAX_ROSTER_BYTES = 131_072
export const MAX_ROSTER_ENTRIES = 100
export const MAX_OFFER_BYTES = 4096
export const OFFER_SLOTS = 32
export const OFFER_TTL_MS = 86_400_000
/** An offer's own ts may be this far ahead of the hub's clock (the computers' own limit, bridge/roster.ts). */
export const OFFER_SKEW_MS = 300_000
export const POST_WINDOW_MS = 3_600_000
export const MAX_POSTS = 5

/** The part of ctx.storage.sql the store uses. */
export interface RosterSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
}

export type PutAnswer = 'ok' | 'conflict' | 'not_in_roster' | 'invalid'
export type OfferAnswer = 'ok' | 'not_yours' | 'full' | 'slow' | 'invalid'

interface Entry { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }

const ENTRY_FIELDS = ['id', 'key', 'prev', 'seq', 'sig', 'signer', 'ts'].join()
const OFFER_FIELDS = ['id', 'key', 'sig', 'ts', 'v'].join()
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** `text` parsed when it is JSON within `max` bytes, else undefined. */
function parse(text: unknown, max: number): unknown {
  if (typeof text !== 'string' || bytes(text) > max) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The entries of a roster text of the right shape, else undefined. Signatures are the computers' to check. */
function rosterEntries(text: unknown): Entry[] | undefined {
  const doc = parse(text, MAX_ROSTER_BYTES)
  if (!isObject(doc) || Object.keys(doc).sort().join() !== 'entries,v' || doc.v !== 1) return undefined
  const list = doc.entries
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ROSTER_ENTRIES) return undefined
  const good = list.every((e: unknown, i) =>
    isObject(e) && Object.keys(e).sort().join() === ENTRY_FIELDS && e.seq === i && Number.isSafeInteger(e.ts) &&
    typeof e.id === 'string' && typeof e.key === 'string' && typeof e.signer === 'string' && typeof e.prev === 'string' && typeof e.sig === 'string')
  return good ? (list as Entry[]) : undefined
}

/** The offer of the right shape, else undefined. */
function offerOf(text: unknown): { id: string; key: string; ts: number } | undefined {
  const o = parse(text, MAX_OFFER_BYTES)
  if (!isObject(o) || Object.keys(o).sort().join() !== OFFER_FIELDS || o.v !== 1) return undefined
  if (typeof o.id !== 'string' || typeof o.key !== 'string' || typeof o.sig !== 'string' || !Number.isSafeInteger(o.ts)) return undefined
  return { id: o.id, key: o.key, ts: o.ts as number }
}

export class RosterStore {
  private readonly sql: RosterSql
  private readonly now: () => number
  private readonly transaction: <T>(fn: () => T) => T

  constructor(sql: RosterSql, now: () => number, transaction: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql = sql
    this.now = now
    this.transaction = transaction
    sql.exec('CREATE TABLE IF NOT EXISTS hub_roster (k INTEGER PRIMARY KEY CHECK (k = 0), body TEXT NOT NULL, len INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS hub_offers (id TEXT PRIMARY KEY, key TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS hub_offer_posts (id TEXT NOT NULL, at INTEGER NOT NULL)')
  }

  private stored(): { len: number; roster: string } | undefined {
    const row = this.sql.exec('SELECT body, len FROM hub_roster WHERE k = 0').toArray()[0]
    return row ? { len: Number(row.len), roster: String(row.body) } : undefined
  }

  /** Offers past OFFER_TTL_MS after their ts and post records past POST_WINDOW_MS are dropped. */
  private expire(now: number): void {
    this.sql.exec('DELETE FROM hub_offers WHERE ts < ?', now - OFFER_TTL_MS)
    this.sql.exec('DELETE FROM hub_offer_posts WHERE at < ?', now - POST_WINDOW_MS)
  }

  /** The roster the hub holds and its length, or undefined. */
  get(): { len: number; roster: string } | undefined {
    return this.transaction(() => this.stored())
  }

  /**
   * Store `rosterText` from the computer `senderId`/`senderKey` (the proof's). In order: the
   * shape ('invalid'); the sender is an entry ('not_in_roster'); then the order ('conflict'):
   * with none stored, base 0 and a root self-signed by the sender's key; with one, base its
   * length, every stored entry unchanged at its index, and longer. On 'ok' every offer whose key
   * or id is in the roster is dropped.
   */
  put(senderId: string, senderKey: string, base: number, rosterText: string): PutAnswer {
    const entries = rosterEntries(rosterText)
    if (!entries || !Number.isSafeInteger(base)) return 'invalid'
    if (!entries.some((e) => e.id === senderId && e.key === senderKey)) return 'not_in_roster'
    return this.transaction((): PutAnswer => {
      const held = this.stored()
      if (!held) {
        if (base !== 0 || entries[0].key !== senderKey || entries[0].signer !== senderKey) return 'conflict'
      } else {
        const before = rosterEntries(held.roster) ?? []
        if (base !== held.len || entries.length <= held.len) return 'conflict'
        if (!before.every((e, i) => JSON.stringify(e) === JSON.stringify(entries[i]))) return 'conflict'
      }
      this.sql.exec('INSERT OR REPLACE INTO hub_roster (k, body, len) VALUES (0, ?, ?)', rosterText, entries.length)
      for (const e of entries) this.sql.exec('DELETE FROM hub_offers WHERE key = ? OR id = ?', e.key, e.id)
      return 'ok'
    })
  }

  /**
   * Keep `offerText` from `senderId`/`senderKey`. In order: the shape ('invalid'); its id and key
   * are the sender's ('not_yours'); its ts within OFFER_TTL_MS back and OFFER_SKEW_MS ahead of the
   * hub's clock ('invalid'); after the expiry, MAX_POSTS accepted posts by this id in the
   * window ('slow'); OFFER_SLOTS offers from other ids waiting ('full'). One offer per id: a new
   * one replaces it. Only an accepted post is counted.
   */
  postOffer(senderId: string, senderKey: string, offerText: string): OfferAnswer {
    const offer = offerOf(offerText)
    if (!offer) return 'invalid'
    if (offer.id !== senderId || offer.key !== senderKey) return 'not_yours'
    return this.transaction((): OfferAnswer => {
      const now = this.now()
      // A ts no computer would take; one far ahead would also never expire here and hold a slot.
      if (offer.ts < now - OFFER_TTL_MS || offer.ts > now + OFFER_SKEW_MS) return 'invalid'
      this.expire(now)
      const posts = Number(this.sql.exec('SELECT COUNT(*) AS n FROM hub_offer_posts WHERE id = ?', senderId).toArray()[0].n)
      if (posts >= MAX_POSTS) return 'slow'
      const others = Number(this.sql.exec('SELECT COUNT(*) AS n FROM hub_offers WHERE id != ?', senderId).toArray()[0].n)
      if (others >= OFFER_SLOTS) return 'full'
      this.sql.exec('INSERT OR REPLACE INTO hub_offers (id, key, body, ts) VALUES (?, ?, ?, ?)', senderId, senderKey, offerText, offer.ts)
      this.sql.exec('INSERT INTO hub_offer_posts (id, at) VALUES (?, ?)', senderId, now)
      return 'ok'
    })
  }

  /** The offers waiting, oldest ts first, after the expiry. */
  offers(): string[] {
    return this.transaction(() => {
      this.expire(this.now())
      return this.sql.exec('SELECT body FROM hub_offers ORDER BY ts, id').toArray().map((r) => String(r.body))
    })
  }
}
