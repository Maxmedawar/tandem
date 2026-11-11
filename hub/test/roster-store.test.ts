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
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

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

describe('audit rows (U-R1A-31B-2 audit)', () => {
  const SKEW = 300_000

  it('an offer whose ts is outside the hub window (24 h back, 300,000 ms ahead): invalid, not stored, not counted', () => {
    const { h, clock } = openStore()
    const rows: [string, number, string][] = [
      ['a year ahead', T0 + 365 * DAY, 'invalid'],
      ['one ms past the skew', T0 + SKEW + 1, 'invalid'],
      ['one ms past 24 h back', T0 - DAY - 1, 'invalid'],
      ['at the skew', T0 + SKEW, 'ok'],
      ['24 h back', T0 - DAY, 'ok'],
    ]
    rows.forEach(([name, ts, want], i) => {
      expect([name, h.s.postOffer(`r${i}`, key(`r${i}`), offer(`r${i}`, ts))]).toEqual([name, want])
    })
    expect(h.s.offers()).toEqual([offer('r4', T0 - DAY), offer('r3', T0 + SKEW)])
    // A refused post is not counted: five good ones still fit in the hour.
    for (let i = 0; i < 5; i++) expect(h.s.postOffer('r0', key('r0'), offer('r0', T0 + i))).toBe('ok')
    // No offer outlives 24 h plus the skew after the hub took it.
    clock.now = T0 + DAY + SKEW + 1
    expect(h.s.offers()).toEqual([])
  })

  it('32 ids posting far-future offers never hold the slots', () => {
    const { h, clock } = openStore()
    for (let i = 0; i < 32; i++) h.s.postOffer(`j${i}`, key(`j${i}`), offer(`j${i}`, T0 + 365 * DAY))
    clock.now = T0 + DAY + SKEW + 1
    expect(h.s.postOffer('late', key('late'), offer('late', clock.now))).toBe('ok')
    expect(h.s.offers()).toEqual([offer('late', clock.now)])
  })

  it('put: only an extension; a sender outside the roster, a fork at a stored index, a truncation and a replay all leave the stored bytes', () => {
    const { h } = openStore()
    const held = doc(chain('a', 'b', 'c'))
    expect(h.s.put('a', key('a'), 0, held)).toBe('ok')
    const fork = chain('a', 'b', 'c')
    fork[2] = { ...fork[2], sig: 't'.repeat(86) }
    const rows: [string, string, number, string, string][] = [
      ['a fork at index 2, longer', 'a', 3, doc([...fork, entry(3, 'd')]), 'conflict'],
      ['a truncation', 'a', 3, doc(chain('a', 'b')), 'conflict'],
      ['a replay of the same roster', 'a', 3, held, 'conflict'],
      ['a new root over the stored one', 'z', 0, doc(chain('z')), 'conflict'],
      ['a new root, base at len', 'z', 3, doc(chain('z', 'a', 'b', 'c')), 'conflict'],
      ['an id in the roster under another key', 'b', 3, doc(chain('a', 'b', 'c', 'd')), 'not_in_roster'],
      ['a base that is not an integer', 'a', 3.5, doc(chain('a', 'b', 'c', 'd')), 'invalid'],
    ]
    for (const [name, id, base, text, want] of rows) {
      const k = name.startsWith('an id in') ? key('other') : key(id)
      expect([name, h.s.put(id, k, base, text)]).toEqual([name, want])
      expect([name, h.s.get()]).toEqual([name, { len: 3, roster: held }])
    }
  })
})

describe('(31C-2) the hub keeps only the spelling every computer writes (31B-2 G4)', () => {
  it('each non-canonical spelling of a good roster: invalid, the stored bytes unchanged; the canonical text: ok', () => {
    const { h } = openStore()
    const held = doc(chain('a'))
    expect(h.s.put('a', key('a'), 0, held)).toBe('ok')
    const entries = chain('a', 'b')
    const good = doc(entries)
    const rows: [string, string][] = [
      ['a space after a colon', good.replace('"v":1', '"v": 1')],
      ['a space after a comma', good.replace('"seq":1,', '"seq":1, ')],
      ['entries before v', JSON.stringify({ entries, v: 1 })],
      ["an entry's keys in another order", JSON.stringify({ v: 1, entries: entries.map(({ seq, id, key: k, signer, ts, prev, sig }) => ({ id, seq, key: k, signer, ts, prev, sig })) })],
      ['a trailing newline', `${good}\n`],
      ['\\u0061 for a in an id', good.replace('"id":"a"', '"id":"\\u0061"')],
    ]
    for (const [name, text] of rows) {
      expect([name, text === good, JSON.parse(text)]).toEqual([name, false, JSON.parse(good)])
      expect([name, h.s.put('a', key('a'), 1, text)]).toEqual([name, 'invalid'])
      expect([name, h.s.get()]).toEqual([name, { len: 1, roster: held }])
    }
    expect(h.s.put('a', key('a'), 1, good)).toBe('ok')
    expect(h.s.get()).toEqual({ len: 2, roster: good })
  })
})

describe('(31C-2) the hub keeps only a roster whose whole chain checks out (31C-1 audit G1)', () => {
  const real = () => {
    const pair = generateKeyPairSync('ed25519')
    return { pub: pair.publicKey.export({ format: 'jwk' }).x as string, priv: pair.privateKey }
  }
  type Real = ReturnType<typeof real>
  const etext = (e: Omit<Entry, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  /** The entry after `before` (the root when undefined) for id/key, signed by `by`. */
  const signed = (by: Real, before: Entry | undefined, id: string, k: string): Entry => {
    const head = { seq: before ? before.seq + 1 : 0, id, key: k, signer: by.pub, ts: T0, prev: before ? sha(etext(before)) : ZERO }
    return { ...head, sig: sign(null, Buffer.from(etext(head), 'utf8'), by.priv).toString('base64url') }
  }
  const A = real()
  const B = real()
  const C = real()
  const X = real()
  const root = signed(A, undefined, 'a', A.pub)
  const withB = signed(A, root, 'b', B.pub)

  it('a made-up signature appended by a token holder outside the roster: invalid, the stored roster unchanged; a valid extension: ok; a fork: conflict', async () => {
    const { h } = openStore()
    expect(await h.s.putChecked('a', A.pub, 0, doc([root]))).toBe('ok')
    const held = doc([root])
    const madeUp = { ...signed(A, root, 'x', X.pub), sig: 'm'.repeat(86) }
    const selfSigned = signed(X, root, 'x', X.pub)
    const copied = { ...signed(A, root, 'x', X.pub), sig: root.sig }
    const rows: [string, string, string, number, string][] = [
      ['x appends itself with a made-up signature', 'x', X.pub, 1, doc([root, madeUp])],
      ['x appends itself signed by its own key', 'x', X.pub, 1, doc([root, selfSigned])],
      ["x appends itself with the root's signature copied", 'x', X.pub, 1, doc([root, copied])],
      ['a member uploads a made-up signature', 'a', A.pub, 1, doc([root, madeUp])],
    ]
    for (const [name, id, k, base, text] of rows) {
      expect([name, await h.s.putChecked(id, k, base, text)]).toEqual([name, 'invalid'])
      expect([name, h.s.get()]).toEqual([name, { len: 1, roster: held }])
    }
    const two = doc([root, withB])
    expect(await h.s.putChecked('a', A.pub, 1, two)).toBe('ok')
    expect(h.s.get()).toEqual({ len: 2, roster: two })
    // Another valid branch at index 1, longer: a fork of what is held.
    const forkC = signed(A, root, 'c', C.pub)
    const fork = doc([root, forkC, signed(A, forkC, 'x', X.pub)])
    expect(await h.s.putChecked('a', A.pub, 2, fork)).toBe('conflict')
    expect(h.s.get()).toEqual({ len: 2, roster: two })
    // b extends it.
    const three = doc([root, withB, signed(B, withB, 'c', C.pub)])
    expect(await h.s.putChecked('b', B.pub, 2, three)).toBe('ok')
    expect(h.s.get()).toEqual({ len: 3, roster: three })
  })

  it('a first root that does not check out: invalid, nothing stored; every refusal answers before the order rules', async () => {
    const { h } = openStore()
    expect(await h.s.putChecked('a', A.pub, 0, doc([{ ...root, sig: 'm'.repeat(86) }]))).toBe('invalid')
    expect(await h.s.putChecked('a', key('a'), 0, doc(chain('a')))).toBe('invalid')
    expect(h.s.get()).toBeUndefined()
    // A non-canonical spelling of a good roster is refused too.
    expect(await h.s.putChecked('a', A.pub, 0, `${doc([root])}\n`)).toBe('invalid')
    expect(h.s.get()).toBeUndefined()
  })

  it('the check is the one passed in, given the exact bytes; it refusing is invalid, nothing stored (fail closed)', async () => {
    const { h } = openStore()
    const seen: string[] = []
    const refuse = async (text: string) => {
      seen.push(text)
      return undefined
    }
    const text = doc([root])
    expect(await h.s.putChecked('a', A.pub, 0, text, refuse)).toBe('invalid')
    expect(seen).toEqual([text])
    expect(h.s.get()).toBeUndefined()
    const throws = async () => {
      throw new Error('boom')
    }
    expect(await h.s.putChecked('a', A.pub, 0, text, throws).catch(() => 'threw')).toBe('threw')
    expect(h.s.get()).toBeUndefined()
  })
})
