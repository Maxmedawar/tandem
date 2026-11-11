/**
 * roster-store.test.ts — the hub's copy of the owner's roster and the offers waiting (U-R1A-31B-2).
 *
 * RosterStore runs over real SQLite (node:sqlite) on a file in a temp folder, wrapped to the shape
 * of a Durable Object's ctx.storage.sql, with a fake clock, as queue.test.ts runs HubQueue. The
 * hub never checks a signature (every computer does), so entries here carry well-shaped filler
 * values: the store only checks shape, ownership, order and limits.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { RosterStore } from '../src/roster-store.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-roster-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** A RosterStore over a fresh database file, plus a way to restart it on the same file. */
function openStore(file = join(dir, `r${++files}.sqlite`)) {
  const clock = { now: T0 }
  let db = new DatabaseSync(file)
  const sqlOf = (d: DatabaseSync) => ({
    exec(query: string, ...bindings: unknown[]) {
      const rows = d.prepare(query).all(...(bindings as SQLInputValue[]))
      return { toArray: () => rows as Record<string, unknown>[] }
    },
  })
  const txOf = (d: DatabaseSync) => <T,>(fn: () => T): T => {
    d.exec('BEGIN')
    try {
      const out = fn()
      d.exec('COMMIT')
      return out
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  }
  const h = { s: new RosterStore(sqlOf(db), () => clock.now, txOf(db)) }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    h.s = new RosterStore(sqlOf(db), () => clock.now, txOf(db))
  }
  return { h, clock, restart }
}

/** A well-shaped key-like value per name (the hub never parses keys). */
const key = (name: string) => `${name}`.padEnd(43, 'k')
const SIG = 's'.repeat(86)
const ZERO = '0'.repeat(64)
type Entry = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }
const entry = (seq: number, id: string, signer = 'a'): Entry => ({ seq, id, key: key(id), signer: key(signer), ts: T0, prev: ZERO, sig: SIG })
const doc = (entries: unknown[]) => JSON.stringify({ v: 1, entries })
/** entries a, then b, c, ... signed by a. */
const chain = (...ids: string[]) => ids.map((id, i) => entry(i, id, i === 0 ? id : 'a'))
const offer = (id: string, ts = T0, k = key(id)) => JSON.stringify({ v: 1, id, key: k, ts, sig: SIG })

describe('put', () => {
  it('first upload: base 0 and a root self-signed by the sender; anything else conflicts', () => {
    const { h } = openStore()
    expect(h.s.get()).toBeUndefined()
    // b is in the roster but did not sign its root.
    expect(h.s.put('b', key('b'), 0, doc(chain('a', 'b')))).toBe('conflict')
    expect(h.s.put('a', key('a'), 1, doc(chain('a', 'b')))).toBe('conflict')
    // A root whose key is not its signer.
    expect(h.s.put('a', key('a'), 0, doc([{ ...entry(0, 'a'), signer: key('z') }]))).toBe('conflict')
    expect(h.s.get()).toBeUndefined()
    const text = doc(chain('a', 'b'))
    expect(h.s.put('a', key('a'), 0, text)).toBe('ok')
    expect(h.s.get()).toEqual({ len: 2, roster: text })
  })

  it('later uploads: base must be the stored len, the stored entries a prefix, the new one longer', () => {
    const { h } = openStore()
    const two = doc(chain('a', 'b'))
    expect(h.s.put('a', key('a'), 0, two)).toBe('ok')
    const three = doc(chain('a', 'b', 'c'))
    // base mismatch (0, 1, 3)
    for (const base of [0, 1, 3]) expect(h.s.put('b', key('b'), base, three)).toBe('conflict')
    // a changed prefix: entry 1 differs
    expect(h.s.put('a', key('a'), 2, doc([entry(0, 'a', 'a'), { ...entry(1, 'b'), ts: T0 + 1 }, entry(2, 'c')]))).toBe('conflict')
    // shorter and the same
    expect(h.s.put('a', key('a'), 2, doc(chain('a')))).toBe('conflict')
    expect(h.s.put('a', key('a'), 2, two)).toBe('conflict')
    expect(h.s.get()).toEqual({ len: 2, roster: two })
    // b, not the root, may extend it.
    expect(h.s.put('b', key('b'), 2, three)).toBe('ok')
    expect(h.s.get()).toEqual({ len: 3, roster: three })
  })

  it('not_in_roster: no entry with the sender id and key (checked after shape, before order)', () => {
    const { h } = openStore()
    expect(h.s.put('x', key('x'), 0, doc(chain('a', 'b')))).toBe('not_in_roster')
    // the right id with another key, the right key under another id
    expect(h.s.put('b', key('z'), 0, doc(chain('a', 'b')))).toBe('not_in_roster')
    expect(h.s.put('z', key('b'), 0, doc(chain('a', 'b')))).toBe('not_in_roster')
    // shape first
    expect(h.s.put('x', key('x'), 0, '{}')).toBe('invalid')
    expect(h.s.get()).toBeUndefined()
  })

  it('each shape refusal: invalid, nothing stored', () => {
    const { h } = openStore()
    const good = chain('a', 'b')
    const many = Array.from({ length: 101 }, (_, i) => entry(i, i === 0 ? 'a' : `n${i}`, 'a'))
    const big = [entry(0, 'a', 'a'), { ...entry(1, 'b'), id: 'b'.repeat(131_072) }]
    const shapes: [string, string][] = [
      ['not JSON', '{'],
      ['null', 'null'],
      ['an array', '[]'],
      ['v 2', JSON.stringify({ v: 2, entries: good })],
      ['an extra top field', JSON.stringify({ v: 1, entries: good, x: 1 })],
      ['no entries', doc([])],
      ['101 entries', doc(many)],
      ['over 131,072 bytes', doc(big)],
      ['an entry not an object', doc([good[0], 'b'])],
      ['an entry with an extra field', doc([good[0], { ...good[1], x: 1 }])],
      ['an entry missing sig', doc([good[0], { ...good[1], sig: undefined }])],
      ['seq not the index', doc([good[0], { ...good[1], seq: 2 }])],
      ['seq a string', doc([good[0], { ...good[1], seq: '1' }])],
      ['ts a string', doc([good[0], { ...good[1], ts: String(T0) }])],
      ['id a number', doc([good[0], { ...good[1], id: 7 }])],
      ['key null', doc([good[0], { ...good[1], key: null }])],
      ['signer a number', doc([good[0], { ...good[1], signer: 1 }])],
      ['prev an object', doc([good[0], { ...good[1], prev: {} }])],
    ]
    for (const [name, text] of shapes) expect([name, h.s.put('a', key('a'), 0, text)]).toEqual([name, 'invalid'])
    expect(Buffer.byteLength(doc(many))).toBeLessThan(131_072)
    // 100 entries is fine.
    expect(h.s.put('a', key('a'), 0, doc(many.slice(0, 100)))).toBe('ok')
  })

  it('offers whose key or id lands in a stored roster are dropped', () => {
    const { h } = openStore()
    expect(h.s.put('a', key('a'), 0, doc(chain('a')))).toBe('ok')
    expect(h.s.postOffer('b', key('b'), offer('b'))).toBe('ok')
    // c offers under its own id; the roster will hold c's id with another key (another computer named c).
    expect(h.s.postOffer('c', key('c2'), offer('c', T0, key('c2')))).toBe('ok')
    expect(h.s.postOffer('d', key('d'), offer('d'))).toBe('ok')
    expect(h.s.offers()).toHaveLength(3)
    expect(h.s.put('a', key('a'), 1, doc(chain('a', 'b', 'c')))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('d')])
  })
})

describe('postOffer', () => {
  it('not_yours by id and by key; invalid shapes; ok', () => {
    const { h } = openStore()
    expect(h.s.postOffer('b', key('b'), offer('a', T0, key('b')))).toBe('not_yours')
    expect(h.s.postOffer('b', key('b'), offer('b', T0, key('a')))).toBe('not_yours')
    const shapes = [
      '{', 'null', '[]', JSON.stringify({ v: 2, id: 'b', key: key('b'), ts: T0, sig: SIG }),
      JSON.stringify({ v: 1, id: 'b', key: key('b'), ts: T0, sig: SIG, x: 1 }),
      JSON.stringify({ v: 1, id: 'b', key: key('b'), ts: String(T0), sig: SIG }),
      JSON.stringify({ v: 1, id: 'b', key: key('b'), ts: T0 }),
      JSON.stringify({ v: 1, id: 'b', key: key('b'), ts: T0, sig: 's'.repeat(4096) }),
    ]
    for (const text of shapes) expect([text.slice(0, 40), h.s.postOffer('b', key('b'), text)]).toEqual([text.slice(0, 40), 'invalid'])
    expect(h.s.offers()).toEqual([])
    expect(h.s.postOffer('b', key('b'), offer('b'))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('b')])
  })

  it('one offer per id, replaced; oldest ts first', () => {
    const { h, clock } = openStore()
    expect(h.s.postOffer('b', key('b'), offer('b', T0 + 5))).toBe('ok')
    expect(h.s.postOffer('c', key('c'), offer('c', T0 + 1))).toBe('ok')
    clock.now += 10
    expect(h.s.postOffer('b', key('b'), offer('b', T0 + 9))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('c', T0 + 1), offer('b', T0 + 9)])
  })

  it('the 6th accepted post in an hour: slow; an hour later: ok; a refused post is not counted', () => {
    const { h, clock } = openStore()
    expect(h.s.postOffer('b', key('b'), offer('a', T0, key('b')))).toBe('not_yours')
    for (let i = 0; i < 5; i++) {
      expect(h.s.postOffer('b', key('b'), offer('b', T0 + i))).toBe('ok')
      clock.now += 1000
    }
    expect(h.s.postOffer('b', key('b'), offer('b', T0 + 6))).toBe('slow')
    // another id is not slowed
    expect(h.s.postOffer('c', key('c'), offer('c'))).toBe('ok')
    clock.now = T0 + HOUR - 1
    expect(h.s.postOffer('b', key('b'), offer('b', T0 + 7))).toBe('slow')
    clock.now = T0 + HOUR + 1
    expect(h.s.postOffer('b', key('b'), offer('b', T0 + 8))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('c'), offer('b', T0 + 8)])
  })

  it('the 33rd id: full; its own replacement still fits; 24 h expiry frees the slots', () => {
    const { h, clock } = openStore()
    for (let i = 0; i < 32; i++) expect(h.s.postOffer(`k${i}`, key(`k${i}`), offer(`k${i}`))).toBe('ok')
    expect(h.s.postOffer('late', key('late'), offer('late'))).toBe('full')
    // one already waiting may replace its own
    expect(h.s.postOffer('k0', key('k0'), offer('k0', T0 + 1))).toBe('ok')
    expect(h.s.offers()).toHaveLength(32)
    // a day later the offers from T0 are still kept (ts = now - DAY is not older)
    clock.now = T0 + DAY
    expect(h.s.offers()).toHaveLength(32)
    clock.now = T0 + DAY + 1
    expect(h.s.offers()).toEqual([offer('k0', T0 + 1)])
    expect(h.s.postOffer('late', key('late'), offer('late', clock.now))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('k0', T0 + 1), offer('late', clock.now)])
  })
})

describe('restart', () => {
  it('the roster, the offers and the post counts survive a reopen on the same file', () => {
    const { h, clock, restart } = openStore()
    const text = doc(chain('a', 'b'))
    expect(h.s.put('a', key('a'), 0, text)).toBe('ok')
    for (let i = 0; i < 5; i++) expect(h.s.postOffer('c', key('c'), offer('c', T0 + i))).toBe('ok')
    restart()
    expect(h.s.get()).toEqual({ len: 2, roster: text })
    expect(h.s.offers()).toEqual([offer('c', T0 + 4)])
    expect(h.s.postOffer('c', key('c'), offer('c', T0 + 5))).toBe('slow')
    clock.now += 1
    expect(h.s.put('b', key('b'), 2, doc(chain('a', 'b', 'c')))).toBe('ok')
    restart()
    expect(h.s.get()?.len).toBe(3)
    expect(h.s.offers()).toEqual([])
  })
})
