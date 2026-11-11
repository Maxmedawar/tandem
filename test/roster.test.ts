/**
 * U-R1A-31: the owner's signed roster of trusted computers (bridge/roster.ts) and its four
 * launcher commands (packaging/tandem: fingerprint, roster, roster init, trust <fingerprint>).
 *
 * Each computer (A, B, C, the hub's own key H) has its own TANDEM_HOME, a folder from
 * mkdtempSync(join(tmpdir(), 'r1a31-')), switched in-process together with TANDEM_HUB_LINK_ID
 * (its id). Clocks are fixed through `now`, except the CLI case, which runs on the real clock.
 * Every folder this file makes is removed in afterAll.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, generateKeyPairSync, hash, randomBytes, sign as edSign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const made: string[] = []
const box = (): string => {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'r1a31-')))
  made.push(p)
  return p
}
const REAL_ROSTER = join(userInfo().homedir, '.tandem', 'roster')
const REAL_KEYS = join(userInfo().homedir, '.tandem', 'keys')
const realBefore = [existsSync(REAL_ROSTER), existsSync(REAL_KEYS)]
const FIRST = box()
// Never the real home: a TANDEM_HOME under it would put a roster beside the live install.
if (!relative(realpathSync(userInfo().homedir), FIRST).startsWith('..')) throw new Error('r1a31: temp folder is under the real home')
process.env.TANDEM_HOME = FIRST
process.env.TANDEM_HUB_LINK_ID = 'first'

const { fingerprintOf, openDeviceKey, verifySignature } = await import('../bridge/device-keys.ts')
const { signEnvelope } = await import('../bridge/envelope.ts')
const roster = await import('../bridge/roster.ts')
const { RosterError, initRoster, joinRoster, listOffers, main, makeOffer, readRoster, receiveOffer, receiveRoster, rosterDir, trustOffer, trustedKey, verifyRoster } = roster

afterAll(() => {
  for (const p of made) rmSync(p, { recursive: true, force: true })
  expect([existsSync(REAL_ROSTER), existsSync(REAL_KEYS)]).toEqual(realBefore)
})

const T = 1_800_000_000_000
const DAY = 24 * 3_600_000
const ZERO = '0'.repeat(64)

type Key = { publicKey: string; fingerprint: string; sign(data: string | Uint8Array): string }
type Computer = { home: string; id: string; key: Key }
type Entry = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }

const on = (c: { home: string; id: string }) => {
  process.env.TANDEM_HOME = c.home
  process.env.TANDEM_HUB_LINK_ID = c.id
}
/** A new computer: its own TANDEM_HOME and id, its device key made there. */
const computer = (id: string): Computer => {
  const c = { home: box(), id }
  on(c)
  return { ...c, key: openDeviceKey() }
}
/** A key held only in memory (the hub's, or filler keys). */
const memKey = (): Key => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x as string
  return { publicKey, fingerprint: fingerprintOf(publicKey), sign: (d) => edSign(null, Buffer.from(d), privateKey).toString('base64url') }
}

const entryText = (e: Omit<Entry, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`
const offerText = (o: { id: string; key: string; ts: number }) => `tandem-roster-offer-v1\n${o.id}\n${o.key}\n${o.ts}`
const sha = (s: string) => hash('sha256', s, 'hex')
/** An entry after `before` (or the root when undefined), signed by `by`. */
function forge(by: Key, before: Entry | undefined, id: string, key: string, ts = T): Entry {
  const head = { seq: before ? before.seq + 1 : 0, id, key, signer: by.publicKey, ts, prev: before ? sha(entryText(before)) : ZERO }
  return { ...head, sig: by.sign(entryText(head)) }
}
const doc = (entries: Entry[]) => JSON.stringify({ v: 1, entries })

const rosterFile = (c: { home: string }) => join(c.home, 'roster', 'roster.json')
const bytes = (p: string) => (existsSync(p) ? readFileSync(p) : undefined)
const mode = (p: string) => statSync(p).mode & 0o777

function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof RosterError) return e.reason
    throw e
  }
  return 'accepted'
}

/** A starts a roster and trusts each of `others` in turn, each joining. Returns A's entries. */
function pair(a: Computer, others: Computer[], at = T): Entry[] {
  on(a)
  if (!existsSync(rosterFile(a))) initRoster(a.key, a.id, at)
  for (const b of others) {
    const offer = makeOffer(b.key, b.id, at)
    on(a)
    receiveOffer(JSON.stringify(offer), at)
    trustOffer(a.key, b.key.fingerprint, at)
    const text = readFileSync(rosterFile(a), 'utf8')
    on(b)
    receiveRoster(text)
    joinRoster(b.key, a.key.fingerprint)
  }
  on(a)
  return readRoster() as Entry[]
}

describe('(a) init', () => {
  it('roster.json 0600 in a 0700 folder, one self-signed entry; a second init is refused', () => {
    const a = computer('a')
    const entries = initRoster(a.key, 'a', T)
    expect(rosterDir()).toBe(join(a.home, 'roster'))
    expect(mode(join(a.home, 'roster'))).toBe(0o700)
    expect(mode(rosterFile(a))).toBe(0o600)
    const file = JSON.parse(readFileSync(rosterFile(a), 'utf8'))
    expect(file).toEqual({ v: 1, entries })
    expect(entries).toHaveLength(1)
    const [root] = entries
    expect(root).toMatchObject({ seq: 0, id: 'a', key: a.key.publicKey, signer: a.key.publicKey, ts: T, prev: ZERO })
    expect(verifySignature(a.key.publicKey, entryText(root), root.sig)).toBe(true)
    expect(readRoster()).toEqual(entries)
    expect(trustedKey('a')).toBe(a.key.publicKey)
    const before = bytes(rosterFile(a))
    expect(reasonOf(() => initRoster(a.key, 'a', T + 1))).toBe('roster exists')
    expect(bytes(rosterFile(a))).toEqual(before)
  })
})

describe('(b) pairing', () => {
  it('A trusts B, B joins: both rosters equal, trustedKey on both', () => {
    const a = computer('a')
    const b = computer('b')
    on(a)
    initRoster(a.key, 'a', T)
    on(b)
    const offer = makeOffer(b.key, 'b', T)
    expect(Object.keys(offer).sort()).toEqual(['id', 'key', 'sig', 'ts', 'v'])
    on(a)
    expect(receiveOffer(JSON.stringify(offer), T + 1000)).toBe(b.key.fingerprint)
    expect(listOffers()).toEqual([{ id: 'b', fingerprint: b.key.fingerprint }])
    expect(mode(join(a.home, 'roster', 'offers'))).toBe(0o700)
    expect(mode(join(a.home, 'roster', 'offers', `${b.key.fingerprint}.json`))).toBe(0o600)
    expect(trustOffer(a.key, b.key.fingerprint, T + 2000)).toMatchObject({ id: 'b', fingerprint: b.key.fingerprint })
    expect(listOffers()).toEqual([])
    const entries = readRoster() as Entry[]
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ seq: 1, id: 'b', key: b.key.publicKey, signer: a.key.publicKey, prev: sha(entryText(entries[0])) })
    const text = readFileSync(rosterFile(a), 'utf8')

    on(b)
    expect(readRoster()).toBeUndefined()
    receiveRoster(text)
    expect(mode(join(b.home, 'roster', 'pending.json'))).toBe(0o600)
    expect(existsSync(rosterFile(b))).toBe(false)
    expect(trustedKey('b')).toBeUndefined()
    joinRoster(b.key, a.key.fingerprint)
    expect(existsSync(join(b.home, 'roster', 'pending.json'))).toBe(false)
    expect(mode(rosterFile(b))).toBe(0o600)
    expect(readRoster()).toEqual(entries)
    expect(readFileSync(rosterFile(b), 'utf8')).toBe(text)
    expect(trustedKey('b')).toBe(b.key.publicKey)
    expect(trustedKey('a')).toBe(a.key.publicKey)
    on(a)
    expect(trustedKey('b')).toBe(b.key.publicKey)
    expect(trustedKey('nobody')).toBeUndefined()
    // The same roster again is no change; B now trusts C and A takes the longer roster.
    expect(receiveRoster(text)).toBe('same')
    const c = computer('c')
    pair(b, [c])
    on(b)
    const longer = readFileSync(rosterFile(b), 'utf8')
    on(a)
    expect(receiveRoster(longer)).toBe('updated')
    expect(trustedKey('c')).toBe(c.key.publicKey)
  })
})

describe('(c) A4.13: a hub that swaps the key shows a different fingerprint', () => {
  it('the swapped offer lists another fingerprint; trust of B, prefixes, 15/17 chars, uppercase: refused, roster unchanged', () => {
    const a = computer('a')
    const b = computer('b')
    const h = memKey()
    on(a)
    initRoster(a.key, 'a', T)
    const before = bytes(rosterFile(a))
    // The hub swaps B's key for its own in a valid offer (it cannot sign with B's key).
    const swapped = makeOffer(h, 'b', T)
    receiveOffer(JSON.stringify(swapped), T)
    const listed = listOffers()
    expect(listed).toEqual([{ id: 'b', fingerprint: h.fingerprint }])
    expect(listed[0].fingerprint).not.toBe(b.key.fingerprint)
    expect(reasonOf(() => trustOffer(a.key, b.key.fingerprint, T))).toBe('no matching offer')
    // A swap that keeps B's signature fails the proof of holding the key.
    const realB = makeOffer(b.key, 'b', T)
    expect(reasonOf(() => receiveOffer(JSON.stringify({ ...realB, key: h.publicKey }), T))).toBe('signature')
    for (const fp of [h.fingerprint.slice(0, 8), h.fingerprint.slice(0, 15), h.fingerprint + '0', h.fingerprint.toUpperCase(), '', 'zz' + h.fingerprint.slice(2)]) {
      expect(reasonOf(() => trustOffer(a.key, fp, T))).toBe('bad fingerprint')
    }
    // An offer file filed under B's fingerprint but holding the hub's key is not B's.
    const offers = join(a.home, 'roster', 'offers')
    writeFileSync(join(offers, `${b.key.fingerprint}.json`), JSON.stringify(swapped), { mode: 0o600 })
    expect(reasonOf(() => trustOffer(a.key, b.key.fingerprint, T))).toBe('no matching offer')
    expect(bytes(rosterFile(a))).toEqual(before)
    expect(trustedKey('b')).toBeUndefined()
  })
})

describe('(d) A4.13: a hub that tries 16 million keys finds no match', () => {
  it('16,777,216 SHA-256s over random 32-byte strings: no first 16 hex equals B\'s fingerprint', () => {
    const b = computer('b')
    const target = Buffer.from(b.key.fingerprint, 'hex')
    // Positive control: the same comparison finds B's own raw key.
    const own = hash('sha256', Buffer.from(b.key.publicKey, 'base64url'), 'buffer') as Buffer
    expect(own.compare(target, 0, 8, 0, 8)).toBe(0)
    const CHUNK = 1 << 16
    const TOTAL = 1 << 24
    let tried = 0
    let hits = 0
    const t0 = performance.now()
    while (tried < TOTAL) {
      const pool = randomBytes(32 * CHUNK)
      for (let i = 0; i < CHUNK; i++) {
        const d = hash('sha256', pool.subarray(i * 32, i * 32 + 32), 'buffer') as Buffer
        if (d.compare(target, 0, 8, 0, 8) === 0) hits++
      }
      tried += CHUNK
    }
    const ms = Math.round(performance.now() - t0)
    console.log(`r1a31 (d): ${tried} SHA-256 in ${ms} ms, ${hits} matches`)
    expect(tried).toBe(16_777_216)
    expect(hits).toBe(0)
  }, 300_000)
})

describe('(e) A4.21: a key the hub adds or swaps is refused', () => {
  const a = computer('a')
  const b = computer('b')
  const c = computer('c')
  const h = memKey()
  const entries = pair(a, [b, c])
  const [ea, eb, ec] = entries

  /** Each refused at A: reason, roster.json bytes unchanged, the hub's id not trusted. */
  function refusedAtA(raw: string, reason: string) {
    on(a)
    const before = bytes(rosterFile(a))
    expect(reasonOf(() => receiveRoster(raw))).toBe(reason)
    expect(bytes(rosterFile(a))).toEqual(before)
    expect(trustedKey('hub')).toBeUndefined()
    expect(readRoster()).toEqual(entries)
  }

  it('an entry signed by a key not earlier in the roster: signer', () => {
    const added = forge(h, ec, 'hub', h.publicKey)
    expect(reasonOf(() => verifyRoster(doc([ea, eb, ec, added])))).toBe('signer')
    refusedAtA(doc([ea, eb, ec, added]), 'signer')
    // A later key may not sign an earlier entry either.
    const d = memKey()
    const early = forge(c.key, ea, 'd', d.publicKey)
    expect(reasonOf(() => verifyRoster(doc([ea, early])))).toBe('signer')
  })

  it('a hub-made root that signs B: root at A; at B joinRoster(B, fpA) refused', () => {
    const root = forge(h, undefined, 'hub', h.publicKey)
    const signsB = forge(h, root, 'b', b.key.publicKey)
    refusedAtA(doc([root, signsB]), 'root')
    expect(reasonOf(() => verifyRoster(doc([root, signsB]), a.key.publicKey))).toBe('root')
    // B has no roster yet: the hub's roster verifies from its own root and holds B, so it waits.
    const fresh = computer('b')
    on(fresh)
    const root2 = forge(h, undefined, 'hub', h.publicKey)
    const signsFresh = forge(h, root2, 'b', fresh.key.publicKey)
    expect(receiveRoster(doc([root2, signsFresh]))).toBe('pending')
    const pending = bytes(join(fresh.home, 'roster', 'pending.json'))
    expect(reasonOf(() => joinRoster(fresh.key, a.key.fingerprint))).toBe('signer')
    expect(existsSync(rosterFile(fresh))).toBe(false)
    expect(bytes(join(fresh.home, 'roster', 'pending.json'))).toEqual(pending)
    expect(trustedKey('hub')).toBeUndefined()
    expect(trustedKey('b')).toBeUndefined()
    // The hub signs A's key under its own root and copies A's real entry for B after it: A's
    // signature covers prev, which fixes the chain back to A's root, so it fails.
    const hubSignsA = forge(h, root2, 'a', a.key.publicKey)
    const copied = { ...eb, seq: 2, prev: sha(entryText(hubSignsA)) }
    expect(reasonOf(() => verifyRoster(doc([root2, hubSignsA, copied])))).toBe('signature')
    // A roster that does not hold this computer is not kept.
    expect(reasonOf(() => receiveRoster(doc([root2])))).toBe('not for this computer')
    // A self-signed root that is not its own signer.
    expect(reasonOf(() => verifyRoster(doc([{ ...forge(h, undefined, 'hub', a.key.publicKey) }])))).toBe('root')
  })

  it('reordered, edited, dropped-middle, re-signed: each refused', () => {
    const cases: [string, Entry[], string][] = [
      ['reordered', [ea, ec, eb], 'chain'],
      ['seq edited', [ea, eb, { ...ec, seq: 5 }], 'chain'],
      ['middle id edited', [ea, { ...eb, id: 'hub' }, ec], 'chain'],
      ['last id edited', [ea, eb, { ...ec, id: 'hub' }], 'signature'],
      ['last key edited', [ea, eb, { ...ec, key: h.publicKey, id: 'hub' }], 'signature'],
      ['dropped middle', [ea, ec], 'chain'],
      ['re-signed by the hub', [ea, eb, { ...ec, sig: h.sign(entryText(ec)) }], 'signature'],
      ['signer swapped to the hub', [ea, eb, forge(h, eb, 'c', c.key.publicKey)], 'signer'],
      ['time moved back', [ea, eb, forge(b.key, eb, 'hub', h.publicKey, T - 1)], 'chain'],
    ]
    for (const [name, list, reason] of cases) {
      expect([name, reasonOf(() => verifyRoster(doc(list)))]).toEqual([name, reason])
      refusedAtA(doc(list), reason)
    }
  })

  it('shorter: stale; another branch: fork; same: no change', () => {
    refusedAtA(doc([ea, eb]), 'stale')
    const d = memKey()
    const branch = forge(b.key, eb, 'hub', d.publicKey)
    expect(verifyRoster(doc([ea, eb, branch]))).toHaveLength(3)
    refusedAtA(doc([ea, eb, branch]), 'fork')
    refusedAtA(doc([ea, eb, branch, forge(b.key, branch, 'e', memKey().publicKey)]), 'fork')
    on(a)
    expect(receiveRoster(doc(entries))).toBe('same')
  })

  it('duplicate id or key; 101 entries; shape: each refused', () => {
    const dupId = forge(a.key, ec, 'b', h.publicKey)
    expect(reasonOf(() => verifyRoster(doc([ea, eb, ec, dupId])))).toBe('duplicate')
    refusedAtA(doc([ea, eb, ec, dupId]), 'duplicate')
    const dupKey = forge(a.key, ec, 'hub', b.key.publicKey)
    refusedAtA(doc([ea, eb, ec, dupKey]), 'duplicate')

    const many = [ea, eb, ec]
    while (many.length < 101) many.push(forge(a.key, many[many.length - 1], `n${many.length}`, memKey().publicKey))
    expect(reasonOf(() => verifyRoster(doc(many.slice(0, 100))))).toBe('accepted')
    refusedAtA(doc(many), 'shape')

    const shapes: unknown[] = [
      '', 'null', '[]', '{}', JSON.stringify({ v: 2, entries }), JSON.stringify({ v: 1, entries: [] }),
      JSON.stringify({ v: 1, entries, extra: 1 }), doc([ea, eb, { ...ec, extra: 1 } as Entry]),
      doc([ea, eb, { ...ec, id: 'Hub!' }]), doc([ea, eb, { ...ec, ts: -1 }]), doc([ea, eb, { ...ec, ts: 1.5 }]),
      doc([ea, eb, { ...ec, prev: ec.prev.toUpperCase() }]), doc([ea, eb, { ...ec, sig: ec.sig.slice(1) }]),
      doc([ea, eb, { ...ec, key: 'A'.repeat(43) }]), doc([ea, eb, { ...ec, key: 'A'.repeat(42) + 'B' }]),
      doc([ea, eb, { ...ec, key: Buffer.alloc(32).toString('base64url') }]),
      doc(entries) + ' '.repeat(131_073),
    ]
    for (const raw of shapes) {
      expect(reasonOf(() => verifyRoster(raw))).toBe('shape')
      if (typeof raw === 'string') refusedAtA(raw, 'shape')
    }
  })
})

describe('(f) cross-protocol', () => {
  it('a roster entry or offer signature never verifies as an envelope signature, nor the reverse', () => {
    const a = computer('a')
    const b = computer('b')
    const [root] = (on(a), initRoster(a.key, 'a', T))
    const offer = makeOffer(b.key, 'b', T)
    // The envelope text over the same fields.
    const env = (from: string, to: string, nonce: string, ts: number, body: string) => `tandem-envelope-v1\n${from}\n${to}\n${nonce}\n${ts}\n${body}`
    expect(verifySignature(a.key.publicKey, env(root.id, root.key, root.signer, root.ts, root.prev), root.sig)).toBe(false)
    expect(verifySignature(a.key.publicKey, entryText(root).replace('tandem-roster-v1', 'tandem-envelope-v1'), root.sig)).toBe(false)
    expect(verifySignature(b.key.publicKey, env(offer.id, offer.key, '', offer.ts, ''), offer.sig)).toBe(false)
    expect(verifySignature(b.key.publicKey, offerText(offer).replace('tandem-roster-offer-v1', 'tandem-envelope-v1'), offer.sig)).toBe(false)
    // Entry and offer texts never stand for each other either.
    expect(verifySignature(b.key.publicKey, entryText({ seq: 0, prev: ZERO, id: 'b', key: b.key.publicKey, signer: b.key.publicKey, ts: T }), offer.sig)).toBe(false)
    // An envelope signature in an entry or an offer is refused.
    const e = signEnvelope(a.key, { from: 'a', to: 'b', body: 'x' }, T)
    expect(reasonOf(() => verifyRoster(doc([{ ...root, sig: e.sig }])))).toBe('signature')
    on(b)
    const eb = signEnvelope(b.key, { from: 'b', to: 'a', body: 'x' }, T)
    on(a)
    expect(reasonOf(() => receiveOffer(JSON.stringify({ ...offer, sig: eb.sig }), T))).toBe('signature')
    // Positive controls: the real ones verify.
    expect(verifySignature(a.key.publicKey, entryText(root), root.sig)).toBe(true)
    expect(verifySignature(b.key.publicKey, offerText(offer), offer.sig)).toBe(true)
  })
})

describe('(g) files', () => {
  it('roster/ 0755, roster.json 0644 or a symlink: refused, left as is', () => {
    const a = computer('a')
    initRoster(a.key, 'a', T)
    const dir = join(a.home, 'roster')
    const file = rosterFile(a)
    const before = bytes(file)
    chmodSync(dir, 0o755)
    expect(() => readRoster()).toThrow(RosterError)
    expect(() => trustedKey('a')).toThrow(RosterError)
    expect(reasonOf(() => initRoster(a.key, 'a', T))).toMatch(/mode/)
    expect(mode(dir)).toBe(0o755)
    chmodSync(dir, 0o700)
    chmodSync(file, 0o644)
    expect(() => readRoster()).toThrow(RosterError)
    expect(() => trustedKey('a')).toThrow(RosterError)
    expect(mode(file)).toBe(0o644)
    chmodSync(file, 0o600)
    // A symlink to a good roster is still refused.
    const elsewhere = join(box(), 'roster.json')
    writeFileSync(elsewhere, before as Buffer, { mode: 0o600 })
    rmSync(file)
    symlinkSync(elsewhere, file)
    expect(() => readRoster()).toThrow(RosterError)
    expect(reasonOf(() => trustedKey('a'))).toMatch(/symlink/)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    // A tampered file throws at every read: fail closed.
    rmSync(file)
    const parsed = JSON.parse((before as Buffer).toString())
    parsed.entries[0].ts = T + 5
    writeFileSync(file, JSON.stringify(parsed), { mode: 0o600 })
    expect(() => trustedKey('a')).toThrow(RosterError)
    // The roster folder itself a symlink.
    rmSync(dir, { recursive: true })
    const other = box()
    symlinkSync(other, dir)
    expect(() => readRoster()).toThrow(RosterError)
  })

  it('an offer a symlink, over 4096 bytes or stale: refused; the 33rd offer: full', () => {
    const a = computer('a')
    initRoster(a.key, 'a', T)
    const b = memKey()
    const offer = makeOffer(b, 'b', T)
    receiveOffer(JSON.stringify(offer), T)
    const offers = join(a.home, 'roster', 'offers')
    const path = join(offers, `${b.fingerprint}.json`)
    const elsewhere = join(box(), 'o.json')
    copyFileSync(path, elsewhere)
    rmSync(path)
    symlinkSync(elsewhere, path)
    expect(() => listOffers()).toThrow(RosterError)
    expect(reasonOf(() => trustOffer(a.key, b.fingerprint, T))).toMatch(/symlink/)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    rmSync(path)

    expect(reasonOf(() => receiveOffer(JSON.stringify(offer) + ' '.repeat(4097), T))).toBe('shape')
    expect(reasonOf(() => receiveOffer(JSON.stringify({ ...offer, extra: 1 }), T))).toBe('shape')
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(b, 'b', T - DAY - 1)), T))).toBe('time')
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(b, 'b', T + 300_001)), T))).toBe('time')
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(b, 'b', T + 300_000)), T))).toBe('accepted')
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(b, 'b', T - DAY)), T))).toBe('accepted')
    // Received fresh, gone stale before the owner trusts it.
    expect(reasonOf(() => trustOffer(a.key, b.fingerprint, T + 1))).toBe('time')
    expect(listOffers()).toHaveLength(1)

    for (let i = 1; i < 32; i++) receiveOffer(JSON.stringify(makeOffer(memKey(), `k${i}`, T)), T)
    expect(listOffers()).toHaveLength(32)
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(memKey(), 'k33', T)), T))).toBe('full')
    // The same key again replaces its own offer.
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(b, 'b', T + 5)), T))).toBe('accepted')
    expect(readdirSync(offers).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a fresh lock: busy after 5 s; a lock older than 30 s is removed', () => {
    const a = computer('a')
    initRoster(a.key, 'a', T)
    const lock = join(a.home, 'roster', '.lock')
    writeFileSync(lock, '', { mode: 0o600 })
    const offer = JSON.stringify(makeOffer(memKey(), 'b', T))
    const t0 = Date.now()
    expect(reasonOf(() => receiveOffer(offer, T))).toBe('busy')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900)
    expect(existsSync(lock)).toBe(true)
    const old = (Date.now() - 31_000) / 1000
    utimesSync(lock, old, old)
    expect(reasonOf(() => receiveOffer(offer, T))).toBe('accepted')
    expect(existsSync(lock)).toBe(false)
  }, 20_000)

  it('two child processes trusting two offers at once: both entries kept, no tmp or lock left', async () => {
    const a = computer('a')
    initRoster(a.key, 'a', T)
    const k1 = memKey()
    const k2 = memKey()
    receiveOffer(JSON.stringify(makeOffer(k1, 'one', T)), T)
    receiveOffer(JSON.stringify(makeOffer(k2, 'two', T)), T)
    const script = join(box(), 'trust.mjs')
    writeFileSync(script, [
      `const { openDeviceKey } = await import(${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'device-keys.ts')).href)})`,
      `const { trustOffer } = await import(${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'roster.ts')).href)})`,
      'const at = Number(process.argv[3])',
      'while (Date.now() < at) {}',
      `trustOffer(openDeviceKey(), process.argv[2], ${T + 10})`,
    ].join('\n'))
    const at = String(Date.now() + 1500)
    const run = (fp: string) => new Promise<{ code: number | null; err: string }>((done) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, fp, at], { env: { ...process.env, TANDEM_HOME: a.home, TANDEM_HUB_LINK_ID: 'a' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => (err += d))
      child.on('close', (code) => done({ code, err }))
    })
    const results = await Promise.all([run(k1.fingerprint), run(k2.fingerprint)])
    expect(results).toEqual([{ code: 0, err: '' }, { code: 0, err: '' }])
    on(a)
    const entries = readRoster() as Entry[]
    expect(entries.map((e) => e.id).sort()).toEqual(['a', 'one', 'two'])
    expect(trustedKey('one')).toBe(k1.publicKey)
    expect(trustedKey('two')).toBe(k2.publicKey)
    expect(readdirSync(join(a.home, 'roster')).sort()).toEqual(['offers', 'roster.json'])
    expect(readdirSync(join(a.home, 'roster', 'offers'))).toEqual([])
  }, 30_000)
})

describe('(h) never printed', () => {
  it('no PEM and no PRIVATE on any stream; refusals carry no key text', () => {
    const out: string[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true)),
      ...(['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...x: unknown[]) => void out.push(x.map(String).join(' ')))),
    ]
    const errors: string[] = []
    const keep = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        errors.push(String((e as Error).message), String(e))
      }
    }
    let a: Computer, b: Computer
    try {
      a = computer('a')
      b = computer('b')
      expect(main(['fingerprint'])).toBe(0)
      on(a)
      expect(main(['roster'])).toBe(0)
      expect(main(['roster', 'init'])).toBe(0)
      expect(main(['roster', 'init'])).toBe(1)
      receiveOffer(JSON.stringify(makeOffer(b.key, 'b', Date.now())))
      expect(main(['roster'])).toBe(0)
      expect(main(['trust', '0123456789abcdef'])).toBe(1)
      expect(main(['trust', b.key.fingerprint])).toBe(0)
      const text = readFileSync(rosterFile(a), 'utf8')
      on(b)
      receiveRoster(text)
      expect(main(['trust', a.key.fingerprint])).toBe(0)
      expect(main(['trust'])).toBe(2)
      expect(main(['bogus'])).toBe(2)
      keep(() => receiveOffer(JSON.stringify({ ...makeOffer(b.key, 'b', T), key: a.key.publicKey }), T))
      keep(() => receiveRoster(JSON.stringify({ v: 1, entries: [{ ...forge(a.key, undefined, 'x', b.key.publicKey) }] })))
      keep(() => joinRoster(b.key, a.key.fingerprint))
      keep(() => trustOffer(b.key, a.key.fingerprint))
      keep(() => verifyRoster(text.replace(a.key.publicKey.slice(0, 10), 'A'.repeat(10))))
    } finally {
      for (const s of spies) s.mockRestore()
    }
    const all = out.join('\n') + '\n' + errors.join('\n')
    expect(out.length).toBeGreaterThan(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(all).not.toMatch(/PRIVATE|-----BEGIN/)
    for (const k of [a!.key.publicKey, b!.key.publicKey]) expect(all).not.toContain(k)
    expect(all).toContain(`this computer: b ${b!.key.fingerprint}`)
    // The private key files are PEM: proof the search above looks for the right text.
    expect(readFileSync(join(a!.home, 'keys', 'device.key'), 'utf8')).toMatch(/PRIVATE/)
    expect(createPrivateKey(readFileSync(join(a!.home, 'keys', 'device.key'))).asymmetricKeyType).toBe('ed25519')
  })
})

describe('(i) CLI through the launcher', () => {
  it('fingerprint, roster init, roster, trust; usage and refusals; version and unknown command as before', () => {
    const tree = box()
    mkdirSync(join(tree, 'bin'))
    copyFileSync(join(repo, 'packaging', 'tandem'), join(tree, 'bin', 'tandem'))
    chmodSync(join(tree, 'bin', 'tandem'), 0o755)
    symlinkSync(repo, join(tree, 'runtime'))
    const x = computer('x')
    const y = computer('y')
    const z = computer('z')
    const home = box()
    const tandem = (c: { home: string; id: string }, ...args: string[]) => {
      const r = spawnSync(join(tree, 'bin', 'tandem'), args, {
        env: { ...process.env, TANDEM_NODE: process.execPath, TANDEM_HOME: c.home, HOME: home, TANDEM_HUB_LINK_ID: c.id },
        encoding: 'utf8',
        timeout: 60_000,
      })
      return { code: r.status, out: r.stdout, err: r.stderr }
    }
    expect(tandem(x, 'fingerprint')).toMatchObject({ code: 0, out: `this computer: x ${x.key.fingerprint}\n` })
    expect(tandem(x, 'roster')).toMatchObject({ code: 0, out: 'no roster yet\n' })
    expect(tandem(x, 'roster', 'init').code).toBe(0)
    const again = tandem(x, 'roster', 'init')
    expect(again.code).toBe(1)
    expect(again.err).toMatch(/^tandem: roster exists/m)
    expect(tandem(x, 'roster', 'bogus').code).toBe(2)

    on(y)
    const offer = makeOffer(y.key, 'y', Date.now())
    on(x)
    receiveOffer(JSON.stringify(offer))
    expect(tandem(x, 'roster')).toMatchObject({ code: 0, out: `0 x ${x.key.fingerprint} signed by ${x.key.fingerprint}\nwaiting: y ${y.key.fingerprint}\n` })

    for (const args of [['trust'], ['trust', y.key.fingerprint, 'extra']]) {
      const r = tandem(x, ...args)
      expect(r.code).toBe(2)
      expect(r.err).toContain('tandem trust <fingerprint>')
    }
    const unknown = tandem(x, 'trust', '0123456789abcdef')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toMatch(/^tandem: no matching offer/m)
    expect(tandem(x, 'trust', y.key.fingerprint)).toMatchObject({ code: 0, out: `trusted y ${y.key.fingerprint}. On y run: tandem trust ${x.key.fingerprint}\n` })
    expect(tandem(x, 'roster')).toMatchObject({ code: 0, out: `0 x ${x.key.fingerprint} signed by ${x.key.fingerprint}\n1 y ${y.key.fingerprint} signed by ${x.key.fingerprint}\n` })

    on(y)
    receiveRoster(readFileSync(rosterFile(x), 'utf8'))
    expect(tandem(y, 'trust', y.key.fingerprint).code).toBe(1)
    expect(tandem(y, 'trust', x.key.fingerprint)).toMatchObject({ code: 0, out: `joined the roster signed by ${x.key.fingerprint}\n` })
    on(y)
    expect(trustedKey('y')).toBe(y.key.publicKey)

    const nothing = tandem(z, 'trust', x.key.fingerprint)
    expect(nothing.code).toBe(1)
    expect(nothing.err).toMatch(/^tandem: no roster and no pending join/m)

    const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
    expect(tandem(z, 'version')).toMatchObject({ code: 0, out: `${version}\n` })
    const bogus = tandem(z, 'bogus')
    expect(bogus.code).toBe(2)
    expect(bogus.err).toContain("tandem: unknown command 'bogus'")
    expect(bogus.err).toContain('tandem roster init')
    const help = tandem(z, 'help')
    expect(help.code).toBe(0)
    for (const line of ['tandem fingerprint', 'tandem roster ', 'tandem roster init', 'tandem trust <fingerprint>', 'tandem version', 'tandem run']) expect(help.out).toContain(line)
    for (const out of [tandem(x, 'roster').out, tandem(x, 'fingerprint').out]) expect(out).not.toMatch(/PRIVATE|-----BEGIN/)
  }, 120_000)
})
