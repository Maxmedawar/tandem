/**
 * U-R1A-31C-1: the hub's own check of the owner's roster (hub/src/roster-verify.ts) agrees with
 * every computer's (bridge/roster.ts verifyRoster): for each roster in the table, built with real
 * Ed25519 keys, verifyRosterText gives the entries' { id, key } exactly when verifyRoster accepts
 * and undefined exactly when it throws. No file is written: every key is held in memory.
 */
import { createPublicKey, generateKeyPairSync, hash, randomBytes, sign as edSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyRoster } from '../bridge/roster.ts'
import { verifyRosterText } from '../hub/src/roster-verify.ts'

type Key = { publicKey: string; sign(data: string): string }
type Entry = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }

const T = 1_800_000_000_000
const ZERO = '0'.repeat(64)

const memKey = (): Key => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x as string
  return { publicKey, sign: (d) => edSign(null, Buffer.from(d), privateKey).toString('base64url') }
}
const entryText = (e: Omit<Entry, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`
const sha = (s: string) => hash('sha256', s, 'hex')
/** An entry after `before` (the root when undefined), signed by `by`; `over` changes the signed fields. */
function forge(by: Key, before: Entry | undefined, id: string, key: string, over: Partial<Omit<Entry, 'sig'>> = {}): Entry {
  const head = { seq: before ? before.seq + 1 : 0, id, key, signer: by.publicKey, ts: before ? before.ts + 1 : T, prev: before ? sha(entryText(before)) : ZERO, ...over }
  return { ...head, sig: by.sign(entryText(head)) }
}
const doc = (entries: Entry[]) => JSON.stringify({ v: 1, entries })

const root = memKey()
const keys = Array.from({ length: 101 }, () => memKey())
/** A good roster of `n` entries: the root, then keys[1..] each signed by the root. */
function chain(n: number): Entry[] {
  const out = [forge(root, undefined, 'r1a31c1-0', root.publicKey)]
  for (let i = 1; i < n; i++) out.push(forge(root, out[i - 1], `r1a31c1-${i}`, keys[i].publicKey))
  return out
}
const two = chain(2)
const stranger = memKey()
// The small-order point 01 00..00: refused as a key everywhere.
const weak = Buffer.from('01' + '00'.repeat(31), 'hex').toString('base64url')

const table: [label: string, text: string, good: boolean][] = [
  ['good: 1 entry', doc(chain(1)), true],
  ['good: 2 entries', doc(two), true],
  ['good: 100 entries', doc(chain(100)), true],
  ['shape: v is 2', JSON.stringify({ v: 2, entries: two }), false],
  ['shape: an extra field in an entry', doc([two[0], { ...two[1], extra: 1 } as Entry]), false],
  ['shape: no entries', doc([]), false],
  ['root: the first entry signed by another key', doc([forge(stranger, undefined, 'r1a31c1-0', root.publicKey)]), false],
  ['chain: a wrong prev', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { prev: 'a'.repeat(64) })]), false],
  ['chain: ts going back', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { ts: T - 1 })]), false],
  ['chain: seq skipping one', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { seq: 2 })]), false],
  ['signer: not an earlier key', doc([two[0], forge(stranger, two[0], 'r1a31c1-1', keys[1].publicKey)]), false],
  ['duplicate id', doc([two[0], forge(root, two[0], 'r1a31c1-0', keys[1].publicKey)]), false],
  ['duplicate key', doc([two[0], forge(root, two[0], 'r1a31c1-1', root.publicKey)]), false],
  ['signature: copied from another entry', doc([two[0], { ...two[1], sig: two[0].sig }]), false],
  ['a weak key', doc([two[0], forge(root, two[0], 'r1a31c1-1', weak)]), false],
  ['101 entries', doc(chain(101)), false],
  ['over 131,072 bytes', doc(two) + ' '.repeat(131_072), false],
  ['a text that is not JSON', 'not json {', false],
]

describe('(31C-1) verifyRosterText agrees with verifyRoster', () => {
  it.each(table)('%s', async (_label, text, good) => {
    let expected: { id: string; key: string }[] | undefined
    try {
      expected = verifyRoster(text).map((e) => ({ id: e.id, key: e.key }))
    } catch {
      expected = undefined
    }
    expect(expected !== undefined).toBe(good)
    expect(await verifyRosterText(text)).toEqual(expected)
  })

  it('never throws on 1 MB of noise', async () => {
    const noise = randomBytes(1_048_576).toString('latin1')
    for (const text of [noise, `{"v":1,"entries":${noise}`, randomBytes(786_432).toString('base64')]) {
      await expect(verifyRosterText(text)).resolves.toBeUndefined()
    }
  })
})

/**
 * Audit rows (U-R1A-31C-1): the same agreement on malformed, truncated, repeated, forked, stale,
 * oversize and respelled rosters, on keys and signatures in other spellings, and on 4,000 seeded
 * mutations of a good roster. The hub must never take a roster a computer refuses.
 */
describe('audit rows (U-R1A-31C-1): verifyRosterText and verifyRoster agree', () => {
  const three = chain(3)
  const deep = [two[0], two[1], forge(keys[1], two[1], 'r1a31c1-2', keys[2].publicKey)]
  const swap = (text: string, from: string, to: string) => {
    expect(text).toContain(from)
    return text.replace(from, to)
  }
  /** `b64` (base64url, spare bits zero) with its spare bits set: decodes to the same bytes in a lax decoder. */
  const respelled = (b64: string) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    return b64.slice(0, -1) + alphabet[alphabet.indexOf(b64.at(-1)!) + 1]
  }
  /** The signature with the group order added to S: the same point equation, another spelling. */
  const malleated = (sig: string) => {
    const raw = Buffer.from(sig, 'base64url')
    const L = (1n << 252n) + 27742317777372353535851937790883648493n
    let s = 0n
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(raw[i])
    s += L
    for (let i = 32; i < 64; i++) { raw[i] = Number(s & 255n); s >>= 8n }
    return raw.toString('base64url')
  }
  const weakKeys = ['00'.repeat(32), '01' + '00'.repeat(31), '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'ec' + 'ff'.repeat(30) + '7f', 'ed' + 'ff'.repeat(30) + '7f', 'ee' + 'ff'.repeat(30) + '7f']
    .flatMap((h) => {
      const signed = Buffer.from(h, 'hex')
      signed[31] |= 0x80
      return [Buffer.from(h, 'hex').toString('base64url'), signed.toString('base64url')]
    })
  const pad = doc(two) + ' '.repeat(131_072 - Buffer.byteLength(doc(two)))

  const rows: [label: string, text: string, good: boolean][] = [
    ['good: a third entry signed by the second', doc(deep), true],
    ['good: a stale copy (the first 2 of 3)', doc(three.slice(0, 2)), true],
    ['good: the same ts twice', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { ts: T })]), true],
    ['good: white space around the text', `\n ${doc(two)}\n`, true],
    ['good: v spelled 1.0 and ts spelled 18e11', swap(swap(doc(chain(1)), '"v":1', '"v":1.0'), `"ts":${T}`, '"ts":18e11'), true],
    ['good: exactly 131,072 bytes', pad, true],
    ['131,073 bytes', pad + ' ', false],
    ['good: an id given twice in one entry, the signed one last', swap(doc(two), '"id":"r1a31c1-1"', '"id":"r1a31c1-other","id":"r1a31c1-1"'), true],
    ['an id given twice in one entry, another one last', swap(doc(two), '"id":"r1a31c1-1"', '"id":"r1a31c1-1","id":"r1a31c1-other"'), false],
    ['truncated', doc(two).slice(0, -5), false],
    ['a byte order mark first', `﻿${doc(two)}`, false],
    ['the same entry twice', doc([two[0], two[0]]), false],
    ['forked: two entries after the root, both seq 1', doc([two[0], two[1], forge(root, two[0], 'r1a31c1-f', keys[2].publicKey)]), false],
    ['forked: the second entry replaced, the third kept', doc([three[0], forge(root, three[0], 'r1a31c1-f', keys[3].publicKey), three[2]]), false],
    ['the root dropped', doc(three.slice(1)), false],
    ['signer: a later entry', doc([two[0], forge(keys[2], two[0], 'r1a31c1-1', keys[1].publicKey), forge(root, undefined, 'r1a31c1-2', keys[2].publicKey, { seq: 2 })]), false],
    ['signer: the new key itself', doc([two[0], forge(keys[1], two[0], 'r1a31c1-1', keys[1].publicKey)]), false],
    ['the root key swapped under its signature', doc([{ ...two[0], key: stranger.publicKey, signer: stranger.publicKey }]), false],
    ['signature over the offer text', doc([two[0], { ...two[1], sig: root.sign(`tandem-roster-offer-v1\n${two[1].id}\n${two[1].key}\n${two[1].ts}`) }]), false],
    ['signature with the group order added to S', doc([two[0], { ...two[1], sig: malleated(two[1].sig) }]), false],
    ['signature respelled (spare bits set)', doc([two[0], { ...two[1], sig: respelled(two[1].sig) }]), false],
    ['signature in the + / alphabet', doc([two[0], { ...two[1], sig: `${'+/'}${two[1].sig.slice(2)}` }]), false],
    ['signature 85 characters', doc([two[0], { ...two[1], sig: two[1].sig.slice(1) }]), false],
    ['key respelled (spare bits set)', doc([two[0], forge(root, two[0], 'r1a31c1-1', respelled(keys[1].publicKey))]), false],
    ['key padded with =', doc([two[0], forge(root, two[0], 'r1a31c1-1', `${keys[1].publicKey}=`)]), false],
    ['key a number', swap(doc(two), `"key":"${keys[1].publicKey}"`, '"key":1'), false],
    ['seq a string', swap(doc(two), '"seq":1', '"seq":"1"'), false],
    ['seq 1.5', swap(doc(two), '"seq":1', '"seq":1.5'), false],
    ['seq past 2^53', swap(doc(two), '"seq":1', '"seq":123456789012345678901234567890'), false],
    ['seq 1e400', swap(doc(two), '"seq":1', '"seq":1e400'), false],
    ['seq -1', swap(doc(two), '"seq":1', '"seq":-1'), false],
    ['ts 2^53', doc([forge(root, undefined, 'r1a31c1-0', root.publicKey, { ts: 2 ** 53 })]), false],
    ['ts -1', doc([forge(root, undefined, 'r1a31c1-0', root.publicKey, { ts: -1 })]), false],
    ['id in capitals', doc([two[0], forge(root, two[0], 'R1A31C1-1', keys[1].publicKey)]), false],
    ['id of 65 characters', doc([two[0], forge(root, two[0], 'a'.repeat(65), keys[1].publicKey)]), false],
    ['id empty', doc([two[0], forge(root, two[0], '', keys[1].publicKey)]), false],
    ['id with a line break', doc([two[0], forge(root, two[0], 'a\nb', keys[1].publicKey)]), false],
    ['prev in capitals', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { prev: sha(entryText(two[0])).toUpperCase() })]), false],
    ['prev all zero on the second entry', doc([two[0], forge(root, two[0], 'r1a31c1-1', keys[1].publicKey, { prev: ZERO })]), false],
    ['an entry with __proto__ for a field', swap(doc(two), '"seq":1', '"__proto__":{"seq":1}'), false],
    ['a third top-level field', JSON.stringify({ v: 1, entries: two, more: 1 }), false],
    ['a top-level __proto__ field', swap(doc(two), '{"v":1', '{"__proto__":{},"v":1'), false],
    ['v a string', JSON.stringify({ v: '1', entries: two }), false],
    ['entries an object', '{"v":1,"entries":{"0":1,"length":1}}', false],
    ['entries holding null', '{"v":1,"entries":[null]}', false],
    ['entries holding a list', '{"v":1,"entries":[[]]}', false],
    ['no entries field', '{"v":1}', false],
    ['the text null', 'null', false],
    ['the text []', '[]', false],
    ['the text 1', '1', false],
    ['the empty text', '', false],
    ...weakKeys.flatMap((k, i): [string, string, boolean][] => [
      [`weak key ${i} as a new key`, doc([two[0], forge(root, two[0], 'r1a31c1-1', k)]), false],
      [`weak key ${i} as the root`, doc([{ ...two[0], key: k, signer: k }]), false],
    ]),
  ]

  const both = async (text: string) => {
    let expected: { id: string; key: string }[] | undefined
    try {
      expected = verifyRoster(text).map((e) => ({ id: e.id, key: e.key }))
    } catch {
      expected = undefined
    }
    return { expected, got: await verifyRosterText(text) }
  }

  it.each(rows)('%s', async (_label, text, good) => {
    const { expected, got } = await both(text)
    expect(expected !== undefined).toBe(good)
    expect(got).toEqual(expected)
  })

  it('4,000 seeded mutations of a good roster: the two never differ, and some of each kind are seen', async () => {
    let seed = 0x31c1
    const next = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    const base = doc(deep)
    const parts = base.split(/([,:{}\[\]"])/)
    let accepted = 0
    let refused = 0
    for (let i = 0; i < 4000; i++) {
      let text: string
      const kind = next(5)
      if (kind === 0) {
        const at = next(base.length)
        text = base.slice(0, at) + String.fromCharCode(32 + next(95)) + base.slice(at + 1)
      } else if (kind === 1) {
        const at = next(base.length)
        text = base.slice(0, at) + base.slice(at + 1 + next(3))
      } else if (kind === 2) {
        const p = parts.slice()
        const a = next(p.length)
        const b = next(p.length)
        ;[p[a], p[b]] = [p[b], p[a]]
        text = p.join('')
      } else if (kind === 3) {
        const p = parts.slice()
        const a = next(p.length)
        p.splice(next(p.length), 0, p[a])
        text = p.join('')
      } else {
        // A whole entry moved, dropped or repeated: the JSON stays well formed.
        const e = deep.slice()
        const a = next(e.length)
        const op = next(3)
        if (op === 0) e.splice(next(e.length + 1), 0, e[a])
        else if (op === 1) e.splice(a, 1)
        else e.reverse()
        text = next(4) === 0 ? doc(deep) : doc(e)
      }
      const { expected, got } = await both(text)
      expect(got, text).toEqual(expected)
      if (expected) accepted++
      else refused++
    }
    expect(accepted).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(3000)
  })

  it('100 entries are checked in well under a second, and a refused roster costs no more', async () => {
    const good = doc(chain(100))
    const bad = swap(good, '"seq":99', '"seq":98')
    const started = performance.now()
    expect(await verifyRosterText(good)).toHaveLength(100)
    expect(await verifyRosterText(bad)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
