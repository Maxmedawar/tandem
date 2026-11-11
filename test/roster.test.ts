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
import { chmodSync, copyFileSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
    // U-R1A-31B-2 ordering rule: a branch that does not hold A is refused ('fork'); else A ends on
    // the winner by forkWinner of the two entries at the fork point (ec here, the branch's entry 2).
    for (const list of [[ea, eb, branch], [ea, eb, branch, forge(b.key, branch, 'e', memKey().publicKey)]]) {
      on(a)
      const before = bytes(rosterFile(a)) as Buffer
      const holdsA = list.some((e) => e.key === a.key.publicKey && e.id === a.id)
      const want = roster.forkWinner(ec, branch) === 'a' ? 'kept' : holdsA ? 'rebased' : 'fork'
      let got: string
      try {
        got = receiveRoster(doc(list))
      } catch (e) {
        got = e instanceof RosterError ? e.reason : 'threw'
      }
      expect(got).toBe(want)
      if (want === 'rebased') {
        // A's own entry for c, signed again by A after the winner's entries; then back to A's branch for the rows below.
        const now = readRoster() as Entry[]
        expect(now.slice(0, list.length)).toEqual(list)
        expect(now.slice(list.length).map((e) => [e.id, e.key, e.signer])).toEqual([['c', c.key.publicKey, a.key.publicKey]])
        writeFileSync(rosterFile(a), before, { mode: 0o600 })
      }
      expect(bytes(rosterFile(a))).toEqual(before)
      expect(readRoster()).toEqual(entries)
    }
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

describe('(j) audit rows (U-R1A-31 audit)', () => {
  const a = computer('a')
  const b = computer('b')
  const c = computer('c')
  const h = memKey()
  const entries = pair(a, [b, c])
  const [ea, eb, ec] = entries
  // A small-order point with the sign bit set: refused as a key by our own list.
  const weak = Buffer.from('01' + '00'.repeat(30) + '80', 'hex').toString('base64url')
  // The same signature bytes with the four spare base64url bits set: not the canonical text.
  const spare = (sig: string) => sig.slice(0, 85) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(sig[85]) | 1]

  it('attack table: each row refused with its reason, roster.json unchanged, no key text in the message', () => {
    on(a)
    const before = bytes(rosterFile(a))
    const cyclic: Record<string, unknown> = { v: 1 }
    cyclic.entries = cyclic
    const rawEntries = (text: string) => `{"v":1,"entries":[${text}]}`
    const rows: [string, () => unknown, string][] = [
      ['id with a newline (would shift signed fields)', () => verifyRoster(doc([ea, eb, { ...ec, id: 'c\nx' }])), 'shape'],
      ['seq as a string', () => verifyRoster(doc([ea, eb, { ...ec, seq: '2' as unknown as number }])), 'shape'],
      ['ts as a string', () => verifyRoster(doc([ea, eb, { ...ec, ts: String(ec.ts) as unknown as number }])), 'shape'],
      ['ts past the safe integers', () => verifyRoster(rawEntries(JSON.stringify(ea).replace(`"ts":${ea.ts}`, '"ts":9007199254740993'))), 'shape'],
      ['ts overflowing to Infinity', () => verifyRoster(rawEntries(JSON.stringify(ea).replace(`"ts":${ea.ts}`, '"ts":1e400'))), 'shape'],
      ['an entry with a __proto__ field', () => verifyRoster(rawEntries(JSON.stringify(ea).replace('{', '{"__proto__":{"key":"x"},'))), 'shape'],
      ['a small-order key as an entry key', () => verifyRoster(doc([ea, eb, { ...ec, key: weak }])), 'shape'],
      ['a small-order key as a signer', () => verifyRoster(doc([ea, eb, { ...ec, signer: weak }])), 'shape'],
      ['deep nesting', () => verifyRoster('['.repeat(60_000) + ']'.repeat(60_000)), 'shape'],
      ['a value JSON cannot hold (BigInt)', () => verifyRoster({ v: 1, entries: [{ ...ea, ts: 1n }] }), 'shape'],
      ['a value JSON cannot hold (cycle)', () => verifyRoster(cyclic), 'shape'],
      ['an offer JSON cannot hold', () => receiveOffer({ v: 1n }, T), 'shape'],
      ['a root signed by another key', () => verifyRoster(doc([{ ...ea, sig: h.sign(entryText(ea)) }])), 'signature'],
      ['a root naming another signer', () => verifyRoster(doc([forge(h, undefined, 'a', a.key.publicKey)])), 'root'],
      ['the right bytes in a non-canonical signature text', () => verifyRoster(doc([ea, eb, { ...ec, sig: spare(ec.sig) }])), 'signature'],
      ['an entry text signed under the offer tag', () => verifyRoster(doc([ea, eb, { ...ec, sig: a.key.sign(entryText(ec).replace('tandem-roster-v1', 'tandem-roster-offer-v1')) }])), 'signature'],
      ['an offer signed under the entry tag', () => receiveOffer(JSON.stringify({ v: 1, id: 'x', key: h.publicKey, ts: T, sig: h.sign(offerText({ id: 'x', key: h.publicKey, ts: T }).replace('tandem-roster-offer-v1', 'tandem-roster-v1')) }), T), 'signature'],
      ['an offer for a small-order key', () => receiveOffer(JSON.stringify({ v: 1, id: 'x', key: weak, ts: T, sig: h.sign('x') }), T), 'shape'],
      ['an offer whose id has a path in it', () => receiveOffer(JSON.stringify({ ...makeOffer(h, 'x', T), id: '../x' }), T), 'shape'],
      ['trust: a path as the fingerprint', () => trustOffer(a.key, '../../../../x'), 'bad fingerprint'],
      ['trust: a trailing newline', () => trustOffer(a.key, b.key.fingerprint + '\n'), 'bad fingerprint'],
      ['trust: not a string', () => trustOffer(a.key, ['0123456789abcdef'] as unknown as string), 'bad fingerprint'],
      ['join: a trailing newline', () => joinRoster(a.key, b.key.fingerprint + '\n'), 'bad fingerprint'],
      ['join: a roster is already here', () => joinRoster(a.key, b.key.fingerprint), 'roster exists'],
      ['trust by a key that is not in the roster', () => trustOffer(h, b.key.fingerprint, T), 'not trusted'],
    ]
    const messages: string[] = []
    for (const [name, fn, reason] of rows) {
      let got = 'accepted'
      try {
        fn()
      } catch (e) {
        got = e instanceof RosterError ? e.reason : `threw ${(e as Error).name}`
        messages.push(String((e as Error).message))
      }
      expect([name, got]).toEqual([name, reason])
      expect([name, bytes(rosterFile(a))]).toEqual([name, before])
    }
    for (const text of [a.key.publicKey, b.key.publicKey, h.publicKey, weak, ea.sig, ec.sig]) expect(messages.join('\n')).not.toContain(text)
    expect(readdirSync(join(a.home, 'roster')).filter((f) => f !== 'roster.json' && f !== 'offers')).toEqual([])
    expect(trustedKey('__proto__')).toBeUndefined()
    expect(trustedKey('constructor')).toBeUndefined()
    expect(a.key.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(a.key.fingerprint).toBe(hash('sha256', Buffer.from(a.key.publicKey, 'base64url'), 'hex').slice(0, 16))
  })

  it('replayed offers and a taken id: never a second entry, never a key swapped under an id', () => {
    on(a)
    const before = bytes(rosterFile(a))
    // B's own offer again after B is trusted: it waits, but trusting it changes nothing.
    receiveOffer(JSON.stringify(makeOffer(b.key, 'b', T)), T)
    expect(reasonOf(() => trustOffer(a.key, b.key.fingerprint, T))).toBe('duplicate')
    // The hub's key under A's id, and B's key under a new id.
    receiveOffer(JSON.stringify(makeOffer(h, 'a', T)), T)
    expect(reasonOf(() => trustOffer(a.key, h.fingerprint, T))).toBe('duplicate')
    receiveOffer(JSON.stringify(makeOffer(b.key, 'b2', T)), T)
    expect(reasonOf(() => trustOffer(a.key, b.key.fingerprint, T))).toBe('duplicate')
    expect(bytes(rosterFile(a))).toEqual(before)
    expect(trustedKey('a')).toBe(a.key.publicKey)
    expect(trustedKey('b2')).toBeUndefined()
    // An offer may not be re-dated by anyone but its key.
    const old = makeOffer(h, 'x', T - DAY - 1)
    expect(reasonOf(() => receiveOffer(JSON.stringify({ ...old, ts: T }), T))).toBe('signature')
  })

  it('join binds the key the owner compared, not an id and not another trusted key', () => {
    // D was signed in by C. The owner must type C's fingerprint: A's (the root's) and B's are refused.
    const d = computer('d')
    on(c)
    receiveOffer(JSON.stringify(makeOffer(d.key, 'd', T)), T)
    trustOffer(c.key, d.key.fingerprint, T)
    const text = readFileSync(rosterFile(c), 'utf8')
    on(d)
    expect(receiveRoster(text)).toBe('pending')
    for (const fp of [a.key.fingerprint, b.key.fingerprint, d.key.fingerprint, h.fingerprint]) {
      expect(reasonOf(() => joinRoster(d.key, fp))).toBe('signer')
      expect(existsSync(rosterFile(d))).toBe(false)
    }
    // A hub roster whose root calls itself 'a' and signs D replaces the pending one, and is refused under A's fingerprint.
    const root = forge(h, undefined, 'a', h.publicKey)
    expect(receiveRoster(doc([root, forge(h, root, 'd', d.key.publicKey)]))).toBe('pending')
    expect(reasonOf(() => joinRoster(d.key, a.key.fingerprint))).toBe('signer')
    expect(reasonOf(() => joinRoster(d.key, c.key.fingerprint))).toBe('signer')
    expect(readRoster()).toBeUndefined()
    // D's key under another id is not D.
    expect(reasonOf(() => receiveRoster(doc([root, forge(h, root, 'dd', d.key.publicKey)])))).toBe('not for this computer')
    expect(receiveRoster(text)).toBe('pending')
    expect(joinRoster(d.key, c.key.fingerprint)).toHaveLength(4)
    expect(trustedKey('a')).toBe(a.key.publicKey)
  })

  it('a file or folder owned by another user: refused with its path, left as is', () => {
    if (!process.getuid) return
    const real = process.getuid()
    /** This user for the first `n` owner checks, another user after. */
    const otherAfter = (n: number, fn: () => unknown): { reason: string; path: string | undefined } => {
      let calls = 0
      const spy = vi.spyOn(process, 'getuid').mockImplementation(() => (calls++ < n ? real : real + 1))
      try {
        fn()
        return { reason: 'accepted', path: undefined }
      } catch (e) {
        if (!(e instanceof RosterError)) throw e
        return { reason: e.reason, path: e.path }
      } finally {
        spy.mockRestore()
      }
    }
    const x = computer('x')
    const y = computer('y')
    on(x)
    initRoster(x.key, 'x', T)
    receiveOffer(JSON.stringify(makeOffer(h, 'h', T)), T)
    const dir = join(x.home, 'roster')
    const offer = join(dir, 'offers', `${h.fingerprint}.json`)
    const keep = [bytes(rosterFile(x)), bytes(offer)]
    const NOT_OWNED = 'not owned by this user'
    expect(otherAfter(0, () => readRoster())).toEqual({ reason: NOT_OWNED, path: dir })
    expect(otherAfter(1, () => readRoster())).toEqual({ reason: NOT_OWNED, path: rosterFile(x) })
    expect(otherAfter(1, () => trustedKey('x'))).toEqual({ reason: NOT_OWNED, path: rosterFile(x) })
    expect(otherAfter(1, () => listOffers())).toEqual({ reason: NOT_OWNED, path: join(dir, 'offers') })
    expect(otherAfter(2, () => listOffers())).toEqual({ reason: NOT_OWNED, path: offer })
    expect(otherAfter(0, () => trustOffer(x.key, h.fingerprint, T))).toEqual({ reason: NOT_OWNED, path: dir })
    expect(otherAfter(1, () => trustOffer(x.key, h.fingerprint, T))).toEqual({ reason: NOT_OWNED, path: rosterFile(x) })
    expect(otherAfter(3, () => trustOffer(x.key, h.fingerprint, T))).toEqual({ reason: NOT_OWNED, path: offer })
    expect(otherAfter(2, () => receiveOffer(JSON.stringify(makeOffer(h, 'h', T + 1)), T))).toEqual({ reason: NOT_OWNED, path: offer })
    expect(otherAfter(1, () => initRoster(x.key, 'x', T))).toEqual({ reason: NOT_OWNED, path: rosterFile(x) })
    expect([bytes(rosterFile(x)), bytes(offer)]).toEqual(keep)
    expect(readdirSync(dir).sort()).toEqual(['offers', 'roster.json'])
    expect(readRoster()).toHaveLength(1)
    // pending.json on a computer that has not joined.
    const text = (trustOffer(x.key, h.fingerprint, T), receiveOffer(JSON.stringify(makeOffer(y.key, 'y', T)), T), trustOffer(x.key, y.key.fingerprint, T), readFileSync(rosterFile(x), 'utf8'))
    on(y)
    receiveRoster(text)
    const pending = join(y.home, 'roster', 'pending.json')
    const was = bytes(pending)
    expect(otherAfter(1, () => joinRoster(y.key, x.key.fingerprint))).toEqual({ reason: NOT_OWNED, path: pending })
    expect(otherAfter(1, () => initRoster(y.key, 'y', T))).toEqual({ reason: NOT_OWNED, path: pending })
    expect(bytes(pending)).toEqual(was)
    expect(existsSync(rosterFile(y))).toBe(false)
  })

  it('wrong modes on pending.json, offers/ and an offer: refused, never replaced', () => {
    const x = computer('x')
    const y = computer('y')
    const text = readFileSync(rosterFile((pair(x, [y]), x)), 'utf8')
    const z = computer('z')
    on(x)
    receiveOffer(JSON.stringify(makeOffer(z.key, 'z', T)), T)
    trustOffer(x.key, z.key.fingerprint, T)
    const longer = readFileSync(rosterFile(x), 'utf8')
    on(z)
    receiveRoster(longer)
    const pending = join(z.home, 'roster', 'pending.json')
    const was = bytes(pending)
    chmodSync(pending, 0o644)
    expect(reasonOf(() => joinRoster(z.key, x.key.fingerprint))).toMatch(/mode 0644/)
    expect(reasonOf(() => receiveRoster(longer))).toMatch(/mode 0644/)
    expect(reasonOf(() => initRoster(z.key, 'z', T))).toMatch(/mode 0644/)
    expect([mode(pending), bytes(pending)]).toEqual([0o644, was])
    expect(existsSync(rosterFile(z))).toBe(false)
    chmodSync(pending, 0o600)
    expect(text).not.toBe(longer)

    on(x)
    const offers = join(x.home, 'roster', 'offers')
    const first = makeOffer(h, 'h', T)
    receiveOffer(JSON.stringify(first), T)
    const path = join(offers, `${h.fingerprint}.json`)
    const kept = bytes(path)
    chmodSync(path, 0o644)
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(h, 'h', T + 1)), T))).toMatch(/mode 0644/)
    expect(reasonOf(() => trustOffer(x.key, h.fingerprint, T))).toMatch(/mode 0644/)
    expect(() => listOffers()).toThrow(RosterError)
    expect([mode(path), bytes(path)]).toEqual([0o644, kept])
    chmodSync(path, 0o600)
    // The offer path a symlink: a new offer for that key does not replace or follow it.
    const elsewhere = join(box(), 'o.json')
    writeFileSync(elsewhere, 'untouched', { mode: 0o600 })
    rmSync(path)
    symlinkSync(elsewhere, path)
    expect(reasonOf(() => receiveOffer(JSON.stringify(first), T))).toMatch(/symlink/)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
    rmSync(path)
    receiveOffer(JSON.stringify(first), T)
    chmodSync(offers, 0o755)
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(memKey(), 'k', T)), T))).toMatch(/mode 0755/)
    expect(() => listOffers()).toThrow(RosterError)
    expect(reasonOf(() => trustOffer(x.key, h.fingerprint, T))).toMatch(/mode 0755/)
    expect(mode(offers)).toBe(0o755)
    expect(readRoster()).toHaveLength(3)
    // offers/ itself a symlink.
    chmodSync(offers, 0o700)
    const moved = join(box(), 'offers')
    mkdirSync(moved, { mode: 0o700 })
    rmSync(offers, { recursive: true })
    symlinkSync(moved, offers)
    expect(reasonOf(() => receiveOffer(JSON.stringify(first), T))).toMatch(/symlink/)
    expect(readdirSync(moved)).toEqual([])
  })

  it('a bad lock path: an old symlink is removed and never followed; a folder ends in busy, not a hang', () => {
    const x = computer('x')
    const dir = join(x.home, 'roster')
    const lock = join(dir, '.lock')
    mkdirSync(dir, { mode: 0o700 })
    const old = (Date.now() - 31_000) / 1000
    // An old lock that is a symlink to a file elsewhere, then one to a path that does not exist.
    const outside = box()
    writeFileSync(join(outside, 'target'), 'untouched', { mode: 0o600 })
    for (const target of [join(outside, 'target'), join(outside, 'made-by-lock')]) {
      symlinkSync(target, lock)
      lutimesSync(lock, old - 60, old - 60)
      expect(lstatSync(lock).mtimeMs).toBeLessThan(old * 1000)
      rmSync(rosterFile(x), { force: true })
      expect(reasonOf(() => initRoster(x.key, 'x', T))).toBe('accepted')
      expect(existsSync(lock)).toBe(false)
      expect(readdirSync(outside)).toEqual(['target'])
      expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('untouched')
    }
    // A folder at the lock path cannot be removed: the wait ends after 5 s with 'busy'. Run in a
    // child with a timeout, so a loop that never ends fails this row instead of hanging the run.
    const before = bytes(rosterFile(x))
    mkdirSync(lock, { mode: 0o700 })
    utimesSync(lock, old, old)
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(repo, 'bridge', 'roster.ts'), 'trust', '0123456789abcdef'], {
      env: { ...process.env, TANDEM_HOME: x.home, TANDEM_HUB_LINK_ID: 'x' },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect({ code: r.status, signal: r.signal, err: r.stderr }).toEqual({ code: 1, signal: null, err: `tandem: busy (${lock})\n` })
    expect(lstatSync(lock).isDirectory()).toBe(true)
    expect(bytes(rosterFile(x))).toEqual(before)
  }, 40_000)
})

describe('(k) 31B-2 ordering, sweep, clear', () => {
  const { forkWinner, sweepOffers } = roster as unknown as {
    forkWinner(a: Entry, b: Entry): 'a' | 'b'
    sweepOffers(now?: number): number
  }
  /** receiveRoster's answer, or the reason it refused. */
  const receive = (raw: string, now = T + 50) => {
    try {
      return (roster.receiveRoster as (raw: unknown, now?: number) => string)(raw, now)
    } catch (e) {
      if (e instanceof RosterError) return e.reason
      throw e
    }
  }
  const text = (c: Computer) => readFileSync(rosterFile(c), 'utf8')
  /** `c` trusts `other` (its offer received at T). */
  const trusts = (c: Computer, other: Computer, at = T + 1) => {
    on(c)
    receiveOffer(JSON.stringify(makeOffer(other.key, other.id, T)), T)
    trustOffer(c.key, other.key.fingerprint, at)
  }
  /** Three keys, lowest fingerprint first. */
  const sorted = () => [memKey(), memKey(), memKey()].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1))

  it('(a) forkWinner: lower signer fingerprint, then lower key fingerprint, then lower sig; swapping swaps the answer', () => {
    const [k1, k2, k3] = sorted()
    const base = forge(k1, undefined, 'x', k1.publicKey)
    const e = (signer: Key, key: Key, sig: string): Entry => ({ ...base, signer: signer.publicKey, key: key.publicKey, sig })
    const rows: [string, Entry, Entry][] = [
      ['lower signer wins over a lower key and sig', e(k1, k3, 'z'.repeat(86)), e(k2, k1, 'a'.repeat(86))],
      ['same signer: lower key wins over a lower sig', e(k2, k1, 'z'.repeat(86)), e(k2, k3, 'a'.repeat(86))],
      ['same signer and key: lower sig', e(k3, k2, 'A'.repeat(86)), e(k3, k2, 'B'.repeat(86))],
    ]
    for (const [name, lo, hi] of rows) {
      expect([name, forkWinner(lo, hi), forkWinner(hi, lo)]).toEqual([name, 'a', 'b'])
    }
  })

  it('(b) A and C each append D: one keeps, the other rebases; both files the same, D once', () => {
    const a = computer('a')
    const c = computer('c')
    const d = computer('d')
    pair(a, [c])
    trusts(a, d)
    trusts(c, d)
    const fromA = text(a)
    const fromC = text(c)
    const da = (JSON.parse(fromA).entries as Entry[])[2]
    const dc = (JSON.parse(fromC).entries as Entry[])[2]
    expect(da.signer).toBe(a.key.publicKey)
    expect(dc.signer).toBe(c.key.publicKey)
    on(a)
    const atA = receive(fromC)
    on(c)
    const atC = receive(fromA)
    const aWins = forkWinner(da, dc) === 'a'
    expect([atA, atC]).toEqual(aWins ? ['kept', 'rebased'] : ['rebased', 'kept'])
    expect(text(a)).toBe(text(c))
    expect(text(a)).toBe(aWins ? fromA : fromC)
    on(a)
    expect((readRoster() as Entry[]).filter((x) => x.key === d.key.publicKey)).toHaveLength(1)
  })

  it('(c) A trusts D and C trusts E at the same seq: after two exchanges both hold D and E once, the loser re-signed at the end', () => {
    const a = computer('a')
    const c = computer('c')
    const d = computer('d')
    const e = computer('e')
    pair(a, [c])
    trusts(a, d)
    trusts(c, e)
    const ea = (JSON.parse(text(a)).entries as Entry[])[2]
    const ec = (JSON.parse(text(c)).entries as Entry[])[2]
    const aWins = forkWinner(ea, ec) === 'a'
    const seen: string[] = []
    for (let round = 0; round < 2; round++) {
      on(a)
      seen.push(receive(text(c)))
      on(c)
      seen.push(receive(text(a)))
    }
    expect(seen).toEqual(aWins ? ['kept', 'rebased', 'updated', 'same'] : ['rebased', 'updated', 'same', 'same'])
    expect(text(a)).toBe(text(c))
    on(a)
    const final = readRoster() as Entry[]
    expect(final).toHaveLength(4)
    expect(final.filter((x) => x.key === d.key.publicKey)).toHaveLength(1)
    expect(final.filter((x) => x.key === e.key.publicKey)).toHaveLength(1)
    const [winner, loser, lost] = aWins ? [ea, c, e] : [ec, a, d]
    expect(final[2]).toEqual(winner)
    expect(final[3]).toMatchObject({ seq: 3, id: lost.id, key: lost.key.publicKey, signer: loser.key.publicKey, prev: sha(entryText(final[2])) })
    expect(final[3].ts).toBeGreaterThanOrEqual(final[2].ts)
  })

  it("(d) B's own entry only on the losing branch: fork for B until its signer rebases, then B is on the winner", () => {
    const p = computer('p')
    const q = computer('q')
    const [w, l] = p.key.fingerprint < q.key.fingerprint ? [p, q] : [q, p]
    const b = computer('b')
    const d = computer('d')
    // L starts the roster, W joins, then L signs B (B joins); W, not yet seeing B, signs D.
    pair(l, [w, b])
    trusts(w, d)
    const winner = text(w)
    on(b)
    const before = bytes(rosterFile(b))
    expect(receive(winner)).toBe('fork')
    expect(bytes(rosterFile(b))).toEqual(before)
    on(l)
    expect(receive(winner)).toBe('rebased')
    const rebased = readRoster() as Entry[]
    expect(text(l).startsWith(winner.slice(0, -2))).toBe(true)
    expect(rebased[3]).toMatchObject({ id: 'b', key: b.key.publicKey, signer: l.key.publicKey })
    on(b)
    expect(receive(text(l))).toBe('rebased')
    expect(text(b)).toBe(text(l))
    expect(trustedKey('b')).toBe(b.key.publicKey)
    expect(trustedKey('d')).toBe(d.key.publicKey)
    on(w)
    expect(receive(text(l))).toBe('updated')
    expect(text(w)).toBe(text(l))
  })

  it('(e) the rule cannot be used by a hub: a hub-signed or other-root branch is refused even when its fingerprints would win', () => {
    const a = computer('a')
    const b = computer('b')
    const c = computer('c')
    const [ea, eb, ec] = pair(a, [b, c])
    let h = memKey()
    for (let i = 0; i < 1_000_000 && h.fingerprint >= a.key.fingerprint; i++) h = memKey()
    expect(h.fingerprint < a.key.fingerprint).toBe(true)
    const hubSigned = forge(h, eb, 'hub', h.publicKey)
    const otherRoot = forge(h, undefined, 'a', h.publicKey)
    const lowSigner = { ...forge(a.key, eb, 'hub', h.publicKey), signer: h.publicKey }
    const rows: [string, Entry[], Entry, Entry, string][] = [
      ['hub-signed at the fork point', [ea, eb, hubSigned], ec, hubSigned, 'signer'],
      ['another root', [otherRoot, forge(h, otherRoot, 'b', b.key.publicKey)], ea, otherRoot, 'root'],
      ["a's signature under the hub as signer", [ea, eb, lowSigner], ec, lowSigner, 'signer'],
    ]
    on(a)
    const before = bytes(rosterFile(a))
    for (const [name, list, local, incoming, reason] of rows) {
      expect([name, forkWinner(local, incoming)]).toEqual([name, 'b'])
      expect([name, receive(doc(list))]).toEqual([name, reason])
      expect([name, bytes(rosterFile(a))]).toEqual([name, before])
    }
    expect(trustedKey('hub')).toBeUndefined()
    expect(readRoster()).toEqual([ea, eb, ec])
  })

  it('(f) sweep: stale, key-in-roster and id-in-roster offers are gone after the next receiveOffer; 32 stale offers no longer fill the slots', () => {
    const a = computer('a')
    const b = computer('b')
    pair(a, [b])
    on(a)
    const offers = join(a.home, 'roster', 'offers')
    const stale = memKey()
    const h = memKey()
    /** Three offers put straight into offers/ (as a file the computer kept earlier). */
    const place = () => {
      for (const [k, o] of [[stale, makeOffer(stale, 's', T - DAY - 10)], [b.key, makeOffer(b.key, 'b-again', T)], [h, makeOffer(h, 'b', T)]] as const) {
        writeFileSync(join(offers, `${k.fingerprint}.json`), JSON.stringify(o), { mode: 0o600 })
      }
    }
    place()
    expect(listOffers()).toHaveLength(3)
    const n = memKey()
    expect(receiveOffer(JSON.stringify(makeOffer(n, 'n', T)), T)).toBe(n.fingerprint)
    expect(listOffers()).toEqual([{ id: 'n', fingerprint: n.fingerprint }])
    place()
    expect(sweepOffers(T)).toBe(3)
    expect(listOffers()).toEqual([{ id: 'n', fingerprint: n.fingerprint }])
    expect(sweepOffers(T)).toBe(0)
    // 31 more fresh ones at T fill the 32 slots; a day and a bit later a new one is taken.
    for (let i = 1; i < 32; i++) receiveOffer(JSON.stringify(makeOffer(memKey(), `k${i}`, T)), T)
    expect(reasonOf(() => receiveOffer(JSON.stringify(makeOffer(memKey(), 'k33', T)), T))).toBe('full')
    const late = memKey()
    expect(receiveOffer(JSON.stringify(makeOffer(late, 'late', T + DAY + 1)), T + DAY + 1)).toBe(late.fingerprint)
    expect(listOffers()).toEqual([{ id: 'late', fingerprint: late.fingerprint }])
    expect(readRoster()).toHaveLength(2)
  })

  it('(g) tandem roster clear through the launcher; tandem trust with nothing says how to reach the hub', () => {
    const tree = box()
    mkdirSync(join(tree, 'bin'))
    copyFileSync(join(repo, 'packaging', 'tandem'), join(tree, 'bin', 'tandem'))
    chmodSync(join(tree, 'bin', 'tandem'), 0o755)
    symlinkSync(repo, join(tree, 'runtime'))
    const home = box()
    const tandem = (c: { home: string; id: string }, ...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_NODE: process.execPath, TANDEM_HOME: c.home, HOME: home, TANDEM_HUB_LINK_ID: c.id }
      delete env.TANDEM_HUB_LINK_URL
      delete env.TANDEM_HUB_LINK_TOKEN
      const r = spawnSync(join(tree, 'bin', 'tandem'), args, { env, encoding: 'utf8', timeout: 60_000 })
      return { code: r.status, out: r.stdout, err: r.stderr }
    }
    const x = computer('x')
    const y = computer('y')
    const z = computer('z')
    on(x)
    initRoster(x.key, 'x', T)
    receiveOffer(JSON.stringify(makeOffer(y.key, 'y', Date.now())))
    receiveOffer(JSON.stringify(makeOffer(memKey(), 'w', Date.now())))
    const pending = join(x.home, 'roster', 'pending.json')
    writeFileSync(pending, readFileSync(rosterFile(x)), { mode: 0o600 })
    const before = bytes(rosterFile(x))
    expect(tandem(x, 'roster', 'clear')).toEqual({ code: 0, out: 'cleared 2 waiting offers; pending join removed\n', err: '' })
    expect(existsSync(pending)).toBe(false)
    expect(readdirSync(join(x.home, 'roster', 'offers'))).toEqual([])
    expect(bytes(rosterFile(x))).toEqual(before)
    expect(tandem(x, 'roster', 'clear')).toEqual({ code: 0, out: 'cleared 0 waiting offers; no pending join\n', err: '' })
    expect(bytes(rosterFile(x))).toEqual(before)
    expect(tandem(z, 'trust', x.key.fingerprint)).toEqual({ code: 1, out: '', err: 'tandem: no roster and no pending join (set TANDEM_HUB_LINK_URL to fetch one from the hub)\n' })
    expect(tandem(z, 'help').out).toContain('  tandem roster clear        forget waiting offers and a pending join (the roster stays)\n')
    expect(tandem(z, 'roster', 'bogus').err).toContain('tandem roster clear')
  }, 120_000)
})

describe('(l) 31B-2 audit rows (U-R1A-31B-2 audit)', () => {
  const { forkWinner } = roster as unknown as { forkWinner(a: Entry, b: Entry): 'a' | 'b' }
  const take = roster.receiveRoster as (raw: unknown, now?: number, from?: 'peer' | 'hub') => string
  const receive = (raw: string, from?: 'peer' | 'hub') => {
    try {
      return take(raw, T + 50, from)
    } catch (e) {
      if (e instanceof RosterError) return e.reason
      throw e
    }
  }
  const text = (c: Computer) => readFileSync(rosterFile(c), 'utf8')
  const trusts = (c: Computer, other: Computer) => {
    on(c)
    receiveOffer(JSON.stringify(makeOffer(other.key, other.id, T)), T)
    trustOffer(c.key, other.key.fingerprint, T + 1)
  }
  /** Two computers, the one with the lower fingerprint first. */
  const ordered = (x: string, y: string): [Computer, Computer] => {
    const p = computer(x)
    const q = computer(y)
    return p.key.fingerprint < q.key.fingerprint ? [p, q] : [q, p]
  }

  it('forkWinner is a total order: one lowest entry whatever the pairing, the same on both sides', () => {
    const keys = [memKey(), memKey(), memKey(), memKey()]
    const base = forge(keys[0], undefined, 'x', keys[0].publicKey)
    const entries: Entry[] = []
    for (const s of keys) for (const k of keys) for (const sig of ['A', 'B']) entries.push({ ...base, signer: s.publicKey, key: k.publicKey, sig: sig.repeat(86) })
    const rank = (e: Entry) => `${fingerprintOf(e.signer)} ${fingerprintOf(e.key)} ${e.sig}`
    for (const x of entries) {
      for (const y of entries) {
        if (x === y) continue
        const want = rank(x) < rank(y) ? 'a' : 'b'
        expect([forkWinner(x, y), forkWinner(y, x)]).toEqual([want, want === 'a' ? 'b' : 'a'])
      }
    }
  })

  it('three computers each trust a different new one at once: one roster after a few exchanges, all three kept once, no flip-flop', () => {
    const a = computer('a')
    const c = computer('c')
    const e = computer('e')
    pair(a, [c, e])
    const fresh = [computer('x'), computer('y'), computer('z')]
    const all = [a, c, e]
    all.forEach((m, i) => trusts(m, fresh[i]))
    let rounds = 0
    const stable = () => new Set(all.map(text)).size === 1
    while (!stable() && rounds < 6) {
      rounds++
      for (const to of all) for (const from of all) if (to !== from) {
        const sent = text(from)
        on(to)
        expect(['kept', 'rebased', 'updated', 'same', 'stale']).toContain(receive(sent))
      }
    }
    expect(stable()).toBe(true)
    expect(rounds).toBeLessThanOrEqual(3)
    on(a)
    const final = readRoster() as Entry[]
    expect(final).toHaveLength(6)
    for (const n of fresh) expect(final.filter((x) => x.key === n.key.publicKey)).toHaveLength(1)
    // One more full exchange changes nothing.
    const before = text(a)
    for (const to of all) for (const from of all) if (to !== from) {
      const sent = text(from)
      on(to)
      expect(receive(sent)).toBe('same')
    }
    expect(all.map(text)).toEqual([before, before, before])
  })

  it('a rebase signs again only what this computer signed: never another signer\'s entry, never a key outside the two rosters', () => {
    const [w, l] = ordered('p', 'q')
    const mine = computer('mine')
    const theirs = computer('theirs')
    const d = computer('d')
    pair(l, [w])
    // L trusts `mine`; W takes that roster and trusts `theirs` on top; then W (alone, from the base) trusts D.
    trusts(l, mine)
    const base = doc((JSON.parse(text(l)).entries as Entry[]).slice(0, 2))
    const withMine = JSON.parse(text(l)).entries as Entry[]
    const theirsEntry = forge(w.key, withMine[2], 'theirs', theirs.key.publicKey, T + 2)
    on(l)
    expect(receive(doc([...withMine, theirsEntry]))).toBe('updated')
    const winner = [...(JSON.parse(base).entries as Entry[]), forge(w.key, withMine[1], 'd', d.key.publicKey, T + 3)]
    expect(forkWinner(withMine[2], winner[2])).toBe('b')
    expect(receive(doc(winner))).toBe('rebased')
    const out = readRoster() as Entry[]
    expect(out.map((x) => [x.id, fingerprintOf(x.signer)])).toEqual([
      [l.id, l.key.fingerprint], [w.id, l.key.fingerprint], ['d', w.key.fingerprint], ['mine', l.key.fingerprint],
    ])
    expect(trustedKey('theirs')).toBeUndefined()
  })

  it('LIMIT, peer path: one trusted key with the lower fingerprint forks at an earlier seq and the other signer\'s computer is dropped until that signer signs again', () => {
    const [m, v] = ordered('m', 'v')
    const d = computer('d')
    const root = computer('root')
    pair(root, [m, v])
    const start = JSON.parse(text(root)).entries as Entry[]
    trusts(v, d)
    const good = text(v)
    on(root)
    expect(receive(good)).toBe('updated')
    expect(trustedKey('d')).toBe(d.key.publicKey)
    // M signs a filler key at the same seq: its fingerprint is lower than V's, so its branch wins.
    const junk = memKey()
    const evil = doc([...start, forge(m.key, start[2], 'junk', junk.publicKey, T + 2)])
    expect(receive(evil)).toBe('rebased')
    expect(trustedKey('d')).toBeUndefined()
    // V, the signer, gets D back by the same rule; the junk key came from a trusted key, as any trust does.
    on(v)
    expect(receive(evil)).toBe('rebased')
    expect(trustedKey('d')).toBe(d.key.publicKey)
    // The other way round (the attacker's fingerprint is the higher one) it loses everywhere.
    const evilHigh = doc([...start, forge(v.key, start[2], 'junk2', memKey().publicKey, T + 2)])
    const mTrusts = forge(m.key, start[2], 'd', d.key.publicKey, T + 1)
    on(root)
    const mid = bytes(rosterFile(root))
    expect(forkWinner((readRoster() as Entry[])[3], (JSON.parse(evilHigh).entries as Entry[])[3])).toBe('a')
    expect(receive(evilHigh)).toBe('kept')
    expect(bytes(rosterFile(root))).toEqual(mid)
    expect(mTrusts.seq).toBe(3)
  })

  it('from the hub: only what verifies under this root, never a roster without this computer, never one that drops a computer another one signed', () => {
    const [w, l] = ordered('p', 'q')
    const x = computer('x')
    const d = computer('d')
    const e = computer('e')
    pair(l, [w, x])
    const start = JSON.parse(text(l)).entries as Entry[]
    on(w)
    expect(receive(text(l))).toBe('updated')
    // W and L trust at once: W signs D, L signs E. Both branches are real, so a hub that saw both can serve either.
    trusts(w, d)
    trusts(l, e)
    const branchW = text(w)
    const branchL = text(l)
    const entryW = (JSON.parse(branchW).entries as Entry[])[3]
    const entryL = (JSON.parse(branchL).entries as Entry[])[3]
    expect(forkWinner(entryW, entryL)).toBe('a')
    // Honest hub: it took W's branch; L moves onto it and signs E again ...
    on(l)
    expect(receive(branchW, 'hub')).toBe('rebased')
    const settled = text(l)
    expect((readRoster() as Entry[]).map((r) => r.id)).toEqual([l.id, w.id, 'x', 'd', 'e'])
    // ... and where forkWinner picks this computer's branch, the hub's order still stands for its own entries.
    on(w)
    const wOwn = text(w)
    expect(receive(branchL, 'peer')).toBe('kept')
    expect(text(w)).toBe(wOwn)
    // X holds the settled roster [.., D by W, E by L]. Each row: what a hub could serve X, and X's roster stays.
    on(x)
    expect(receive(settled, 'hub')).toBe('updated')
    const held = bytes(rosterFile(x))
    const h = memKey()
    const hubRoot = forge(h, undefined, l.id, h.publicKey)
    const rows: [string, string, string][] = [
      ['an older prefix', doc(start), 'stale'],
      ['the settled roster cut by one', doc((JSON.parse(settled).entries as Entry[]).slice(0, 4)), 'stale'],
      ['the losing branch (drops D, signed by W)', branchL, 'fork'],
      ['a branch before X joined', doc([start[0], start[1], forge(l.key, start[1], 'junk', memKey().publicKey)]), 'fork'],
      ['a hub-signed entry at the fork point', doc([...start, forge(h, start[2], 'hub', h.publicKey)]), 'signer'],
      ['a hub-made root', doc([hubRoot, forge(h, hubRoot, 'x', x.key.publicKey)]), 'root'],
      ['an extra field naming the hub', JSON.stringify({ v: 1, entries: start, from: 'hub' }), 'shape'],
    ]
    for (const [name, raw, reason] of rows) {
      expect([name, receive(raw, 'hub')]).toEqual([name, reason])
      expect([name, bytes(rosterFile(x))]).toEqual([name, held])
    }
    expect(trustedKey('d')).toBe(d.key.publicKey)
    expect(trustedKey('e')).toBe(e.key.publicKey)
    // The hub's say is only for a call that names the hub: the same losing branch from a peer is 'kept' by the rule.
    expect(forkWinner((readRoster() as Entry[])[3], entryL)).toBe('a')
    expect(receive(branchL)).toBe('kept')
    expect(bytes(rosterFile(x))).toEqual(held)
    // Once the signer of the dropped entry is on the hub's roster, X follows: nothing is lost.
    on(w)
    expect(receive(settled, 'hub')).toBe('updated')
    on(x)
    expect(receive(text(w), 'hub')).toBe('same')
  })
})

describe('(31C-2) roster clear refuses a folder where a file should be (31B-2 G5); signOffer writes nothing (31B-2 G6)', () => {
  const offerPath = (c: { home: string }, fp: string) => join(c.home, 'roster', 'offers', `${fp}.json`)
  const pathOf = (fn: () => unknown): string | undefined => {
    try {
      fn()
    } catch (e) {
      if (e instanceof RosterError) return e.path
      throw e
    }
    return undefined
  }

  it('clearOffers: a folder offers/0123456789abcdef.json beside a real offer: not a regular file, nothing removed', () => {
    const x = computer('x')
    const y = computer('y')
    on(x)
    initRoster(x.key, 'x', T)
    receiveOffer(JSON.stringify(makeOffer(y.key, 'y', Date.now())))
    const real = offerPath(x, y.key.fingerprint)
    const before = bytes(real)
    const folder = offerPath(x, '0123456789abcdef')
    mkdirSync(folder, { mode: 0o700 })
    expect(reasonOf(() => roster.clearOffers())).toBe('not a regular file')
    expect(pathOf(() => roster.clearOffers())).toBe(folder)
    expect(bytes(real)).toEqual(before)
    expect(lstatSync(folder).isDirectory()).toBe(true)
  })

  it('clearPending: a folder pending.json: not a regular file, the folder still there', () => {
    const x = computer('x')
    on(x)
    initRoster(x.key, 'x', T)
    const folder = join(x.home, 'roster', 'pending.json')
    mkdirSync(folder, { mode: 0o700 })
    expect(reasonOf(() => roster.clearPending())).toBe('not a regular file')
    expect(pathOf(() => roster.clearPending())).toBe(folder)
    expect(lstatSync(folder).isDirectory()).toBe(true)
  })

  it('clearOffers: a symlink offers/fedcba9876543210.json to a file outside the roster folder: removed as a link, the target unchanged', () => {
    const x = computer('x')
    on(x)
    initRoster(x.key, 'x', T)
    mkdirSync(join(x.home, 'roster', 'offers'), { mode: 0o700 })
    const target = join(box(), 'outside.json')
    writeFileSync(target, 'outside bytes', { mode: 0o600 })
    const link = offerPath(x, 'fedcba9876543210')
    symlinkSync(target, link)
    expect(roster.clearOffers()).toBe(1)
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe('outside bytes')
  })

  it('tandem roster clear through the launcher: exit 1, exactly one stderr line naming the folder, roster.json untouched', () => {
    const tree = box()
    mkdirSync(join(tree, 'bin'))
    copyFileSync(join(repo, 'packaging', 'tandem'), join(tree, 'bin', 'tandem'))
    chmodSync(join(tree, 'bin', 'tandem'), 0o755)
    symlinkSync(repo, join(tree, 'runtime'))
    const home = box()
    const tandem = (c: { home: string; id: string }, ...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_NODE: process.execPath, TANDEM_HOME: c.home, HOME: home, TANDEM_HUB_LINK_ID: c.id }
      delete env.TANDEM_HUB_LINK_URL
      delete env.TANDEM_HUB_LINK_TOKEN
      const r = spawnSync(join(tree, 'bin', 'tandem'), args, { env, encoding: 'utf8', timeout: 60_000 })
      return { code: r.status, out: r.stdout, err: r.stderr }
    }
    const x = computer('x')
    const y = computer('y')
    on(x)
    initRoster(x.key, 'x', T)
    receiveOffer(JSON.stringify(makeOffer(y.key, 'y', Date.now())))
    const folder = offerPath(x, '0123456789abcdef')
    mkdirSync(folder, { mode: 0o700 })
    const before = bytes(rosterFile(x))
    expect(tandem(x, 'roster', 'clear')).toEqual({ code: 1, out: '', err: `tandem: not a regular file (${folder})\n` })
    expect(existsSync(offerPath(x, y.key.fingerprint))).toBe(true)
    rmSync(folder, { recursive: true })
    const pending = join(x.home, 'roster', 'pending.json')
    mkdirSync(pending, { mode: 0o700 })
    expect(tandem(x, 'roster', 'clear')).toEqual({ code: 1, out: '', err: `tandem: not a regular file (${pending})\n` })
    expect(lstatSync(pending).isDirectory()).toBe(true)
    expect(bytes(rosterFile(x))).toEqual(before)
  }, 120_000)

  it('signOffer: roster.json and the offer unchanged; its text verifies under the root; trustOffer at the same now writes exactly that text', () => {
    const a = computer('a')
    const b = computer('b')
    on(a)
    initRoster(a.key, 'a', T)
    receiveOffer(JSON.stringify(makeOffer(b.key, 'b', T)), T)
    const file = rosterFile(a)
    const offer = offerPath(a, b.key.fingerprint)
    const [rosterBefore, offerBefore] = [bytes(file), bytes(offer)]
    const signed = roster.signOffer(a.key, b.key.fingerprint, T + 5)
    expect(bytes(file)).toEqual(rosterBefore)
    expect(bytes(offer)).toEqual(offerBefore)
    expect(signed.id).toBe('b')
    expect(signed.fingerprint).toBe(b.key.fingerprint)
    const entries = verifyRoster(signed.text, a.key.publicKey)
    expect(entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(signed.text).toBe(doc(entries))
    // The same refusals as trustOffer, nothing written.
    expect(reasonOf(() => roster.signOffer(a.key, 'f'.repeat(16), T + 5))).toBe('no matching offer')
    expect(reasonOf(() => roster.signOffer(b.key, b.key.fingerprint, T + 5))).toBe('not trusted')
    expect(reasonOf(() => roster.signOffer(a.key, b.key.fingerprint, T + 2 * DAY))).toBe('time')
    expect(bytes(file)).toEqual(rosterBefore)
    expect(trustOffer(a.key, b.key.fingerprint, T + 5)).toEqual({ id: 'b', fingerprint: b.key.fingerprint })
    expect(readFileSync(file, 'utf8')).toBe(signed.text)
    expect(existsSync(offer)).toBe(false)
  })
})
