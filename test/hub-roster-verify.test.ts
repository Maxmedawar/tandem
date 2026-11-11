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
