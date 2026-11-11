/**
 * roster.ts: the owner's signed roster of trusted computers (plan section 3, "Who sent it: keys
 * and the roster"). The roster starts at the owner's first computer as one self-signed entry. A
 * new computer sends an offer (its id and public key, signed by that key); the owner compares
 * fingerprints and a trusted computer signs the key into the roster; the new computer takes that
 * roster only from the computer whose fingerprint the owner gives it. Every entry is signed by a
 * key earlier in the roster and covers the hash of the entry before it, so the whole chain goes
 * back to the root, and every computer checks it itself: a key the hub adds or swaps is refused.
 *
 * Files, under `<TANDEM_HOME, else ~/.tandem>/roster/` (worked out at each call, folder 0700):
 * roster.json (the trusted roster), pending.json (a roster received before this computer is in
 * one), offers/<fingerprint>.json (keys waiting). Every file 0600, written whole through a tmp
 * file and a rename; read-modify-write runs under roster/.lock. A symlink, a file or folder not
 * owned by this user, a folder with group/world bits or a file other than 0600 is refused with
 * RosterError (path and reason, never key text) and left as is. Nothing is printed outside main.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintOf, openDeviceKey, verifySignature } from './device-keys.ts'
import type { DeviceKey } from './device-keys.ts'
import { deriveBridgeId } from './hub-link.ts'

export type Entry = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }
export type Offer = { v: 1; id: string; key: string; ts: number; sig: string }

export class RosterError extends Error {
  readonly reason: string
  readonly path: string | undefined
  constructor(reason: string, path?: string) {
    super(path ? `roster ${path} refused: ${reason}` : `roster refused: ${reason}`)
    this.name = 'RosterError'
    this.reason = reason
    this.path = path
  }
}

const ID = /^[a-z0-9._-]{1,64}$/
const SIG = /^[A-Za-z0-9_-]{86}$/
const SHA256 = /^[0-9a-f]{64}$/
const FINGERPRINT = /^[0-9a-f]{16}$/
const ZERO = '0'.repeat(64)
const MAX_ENTRIES = 100
const MAX_ROSTER_BYTES = 131_072
const MAX_OFFER_BYTES = 4096
const MAX_OFFERS = 32
const OFFER_MAX_AGE_MS = 24 * 3_600_000
const CLOCK_SKEW_MS = 300_000
const LOCK_POLL_MS = 50
const LOCK_WAIT_MS = 5000
const LOCK_STALE_MS = 30_000
const ENTRY_FIELDS = ['id', 'key', 'prev', 'seq', 'sig', 'signer', 'ts'].join()
const OFFER_FIELDS = ['id', 'key', 'sig', 'ts', 'v'].join()

const entryText = (e: Omit<Entry, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`
const offerText = (o: Omit<Offer, 'v' | 'sig'>) => `tandem-roster-offer-v1\n${o.id}\n${o.key}\n${o.ts}`
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const goodKey = (k: unknown): k is string => {
  if (typeof k !== 'string') return false
  try {
    fingerprintOf(k)
    return true
  } catch {
    return false
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function rosterDir(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'roster')
}
const thisId = (): string => deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname())

/** JSON text within `max` bytes, parsed; RosterError 'shape' otherwise. */
function parseJson(raw: unknown, max: number): unknown {
  try {
    // JSON.stringify throws on a BigInt or a cycle: that is a bad shape too, never a TypeError.
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > max) throw new RosterError('shape')
    return JSON.parse(text)
  } catch {
    throw new RosterError('shape')
  }
}

/**
 * The entries of a roster that checks out, else RosterError with the first failing reason in this
 * order: shape, root (not self-signed, or entries[0].key is not `root` when given), chain (seq,
 * prev or time order), signer (not an earlier entry's key), duplicate (id or key), signature.
 */
export function verifyRoster(raw: unknown, root?: string): Entry[] {
  const doc = parseJson(raw, MAX_ROSTER_BYTES)
  if (!isObject(doc) || Object.keys(doc).sort().join() !== 'entries,v' || doc.v !== 1) throw new RosterError('shape')
  const list = doc.entries
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTRIES) throw new RosterError('shape')
  const entries: Entry[] = list.map((e: unknown) => {
    if (!isObject(e) || Object.keys(e).sort().join() !== ENTRY_FIELDS) throw new RosterError('shape')
    const { seq, id, key, signer, ts, prev, sig } = e
    if (!isTime(seq) || typeof id !== 'string' || !ID.test(id) || !goodKey(key) || !goodKey(signer) || !isTime(ts) ||
      typeof prev !== 'string' || !SHA256.test(prev) || typeof sig !== 'string' || !SIG.test(sig)) {
      throw new RosterError('shape')
    }
    return { seq, id, key, signer, ts, prev, sig }
  })
  if (entries[0].signer !== entries[0].key || (root !== undefined && entries[0].key !== root)) throw new RosterError('root')
  entries.forEach((e, i) => {
    const before = entries[i - 1]
    if (e.seq !== i || e.prev !== (before ? sha256(entryText(before)) : ZERO) || (before && e.ts < before.ts)) throw new RosterError('chain')
  })
  entries.forEach((e, i) => {
    if (i > 0 && !entries.slice(0, i).some((earlier) => earlier.key === e.signer)) throw new RosterError('signer')
  })
  if (new Set(entries.map((e) => e.id)).size !== entries.length || new Set(entries.map((e) => e.key)).size !== entries.length) {
    throw new RosterError('duplicate')
  }
  for (const e of entries) if (!verifySignature(e.signer, entryText(e), e.sig)) throw new RosterError('signature')
  return entries
}

/** An offer whose shape and proof check out (signed by its own key); time is checked by the caller. */
function checkOffer(raw: unknown): Offer {
  const o = parseJson(raw, MAX_OFFER_BYTES)
  if (!isObject(o) || Object.keys(o).sort().join() !== OFFER_FIELDS) throw new RosterError('shape')
  const { v, id, key, ts, sig } = o
  if (v !== 1 || typeof id !== 'string' || !ID.test(id) || !goodKey(key) || !isTime(ts) || typeof sig !== 'string' || !SIG.test(sig)) {
    throw new RosterError('shape')
  }
  if (!verifySignature(key, offerText({ id, key, ts }), sig)) throw new RosterError('signature')
  return { v: 1, id, key, ts, sig }
}

const fresh = (o: Offer, now: number) => now - o.ts <= OFFER_MAX_AGE_MS && o.ts - now <= CLOCK_SKEW_MS

// ---- files ----

const uid = (): number | undefined => process.getuid?.()

function checkOwner(st: Stats, path: string): void {
  const me = uid()
  if (me !== undefined && st.uid !== me) throw new RosterError('not owned by this user', path)
}

/** The folder `dir` checked; made 0700 when missing and `make`, else false when missing. */
function checkDir(dir: string, make: boolean): boolean {
  let st = lstatSync(dir, { throwIfNoEntry: false })
  if (!st) {
    if (!make) return false
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
    try {
      mkdirSync(dir, { mode: 0o700 })
      chmodSync(dir, 0o700)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    st = lstatSync(dir)
  }
  if (st.isSymbolicLink()) throw new RosterError('the folder is a symlink', dir)
  if (!st.isDirectory()) throw new RosterError('not a folder', dir)
  checkOwner(st, dir)
  const mode = st.mode & 0o777
  if (mode & 0o077) throw new RosterError(`the folder has mode 0${mode.toString(8)}, not 0700`, dir)
  return true
}

/** The text of the file at `path`, or undefined when there is none. Never changes the file. */
function readChecked(path: string, max: number): string | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP' || code === 'EMLINK') throw new RosterError('the file is a symlink', path)
    throw e
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new RosterError('not a regular file', path)
    checkOwner(st, path)
    const mode = st.mode & 0o777
    if (mode !== 0o600) throw new RosterError(`the file has mode 0${mode.toString(8)}, not 0600`, path)
    if (st.size > max) throw new RosterError('shape', path)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * `text` written whole to `path`: a 0600 tmp file, fsynced, renamed over the target. A target that
 * a read would refuse (a symlink, not a regular file, not ours, not 0600) is never replaced.
 */
function writeAtomic(path: string, text: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (st) {
    if (st.isSymbolicLink()) throw new RosterError('the file is a symlink', path)
    if (!st.isFile()) throw new RosterError('not a regular file', path)
    checkOwner(st, path)
    const mode = st.mode & 0o777
    if (mode !== 0o600) throw new RosterError(`the file has mode 0${mode.toString(8)}, not 0600`, path)
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd = openSync(tmp, 'wx', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    renameSync(tmp, path)
  } finally {
    if (fd >= 0) closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {
      // renamed into place
    }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))

/** `fn` under roster/.lock (the folder made and checked first). */
function withLock<T>(fn: (dir: string) => T): T {
  const dir = rosterDir()
  checkDir(dir, true)
  const lock = join(dir, '.lock')
  const start = Date.now()
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const st = lstatSync(lock, { throwIfNoEntry: false })
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      try {
        unlinkSync(lock)
        continue
      } catch {
        // Gone already, or it cannot be removed (a folder at the lock path): wait below, so the
        // loop still ends in 'busy' instead of spinning for ever.
      }
    }
    if (Date.now() - start >= LOCK_WAIT_MS) throw new RosterError('busy', lock)
    Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS)
  }
  try {
    return fn(dir)
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // already gone
    }
  }
}

const rosterText = (entries: Entry[]) => JSON.stringify({ v: 1, entries })

/** The verified roster in `dir`/roster.json, or undefined when there is none. */
function rosterIn(dir: string): Entry[] | undefined {
  const path = join(dir, 'roster.json')
  const text = readChecked(path, MAX_ROSTER_BYTES)
  if (text === undefined) return undefined
  try {
    return verifyRoster(text)
  } catch (e) {
    if (e instanceof RosterError) throw new RosterError(e.reason, path)
    throw e
  }
}

/** This computer's trusted roster, re-verified at every read; undefined when there is none. */
export function readRoster(): Entry[] | undefined {
  const dir = rosterDir()
  return checkDir(dir, false) ? rosterIn(dir) : undefined
}

/** The key for `id` in this computer's verified roster, else undefined. Throws on a tampered file. */
export function trustedKey(id: string): string | undefined {
  return readRoster()?.find((e) => e.id === id)?.key
}

/** Start the roster on the owner's first computer: one entry, signed by its own key. */
export function initRoster(key: DeviceKey, id: string, now: number = Date.now()): Entry[] {
  if (typeof id !== 'string' || !ID.test(id) || !isTime(now)) throw new RosterError('shape')
  return withLock((dir) => {
    for (const name of ['roster.json', 'pending.json']) {
      if (readChecked(join(dir, name), MAX_ROSTER_BYTES) !== undefined) throw new RosterError('roster exists')
    }
    const head = { seq: 0, id, key: key.publicKey, signer: key.publicKey, ts: now, prev: ZERO }
    const entries = verifyRoster(rosterText([{ ...head, sig: key.sign(entryText(head)) }]), key.publicKey)
    writeAtomic(join(dir, 'roster.json'), rosterText(entries))
    return entries
  })
}

/** This computer's offer: its id and key, signed by that key (proof it holds it). */
export function makeOffer(key: DeviceKey, id: string, now: number = Date.now()): Offer {
  if (typeof id !== 'string' || !ID.test(id) || !isTime(now)) throw new RosterError('shape')
  const head = { id, key: key.publicKey, ts: now }
  return { v: 1, ...head, sig: key.sign(offerText(head)) }
}

/** Keep an offer for the owner to compare (after a sweep, so stale offers never fill the slots); returns its fingerprint. */
export function receiveOffer(raw: unknown, now: number = Date.now()): string {
  const offer = checkOffer(raw)
  if (!fresh(offer, now)) throw new RosterError('time')
  const fingerprint = fingerprintOf(offer.key)
  return withLock((dir) => {
    const offers = join(dir, 'offers')
    checkDir(offers, true)
    sweepIn(dir, offers, now)
    const path = join(offers, `${fingerprint}.json`)
    const waiting = readdirSync(offers).filter((f) => f.endsWith('.json'))
    if (!waiting.includes(`${fingerprint}.json`) && waiting.length >= MAX_OFFERS) throw new RosterError('full')
    writeAtomic(path, JSON.stringify(offer))
    return fingerprint
  })
}

/** The offer stored under `fingerprint` in `offers`, checked, or undefined. */
function offerAt(offers: string, fingerprint: string): Offer | undefined {
  const path = join(offers, `${fingerprint}.json`)
  const text = readChecked(path, MAX_OFFER_BYTES)
  if (text === undefined) return undefined
  try {
    return checkOffer(text)
  } catch (e) {
    if (e instanceof RosterError) throw new RosterError(e.reason, path)
    throw e
  }
}

const OFFER_FILE = /^[0-9a-f]{16}\.json$/

/**
 * Remove, from the checked folder `offers`, each waiting offer that is not fresh or whose key or
 * id is already in roster.json (it can never be trusted). Every offer is read (and checked) before
 * the roster, so a refused file stops the sweep with its own path. Returns the count removed.
 */
function sweepIn(dir: string, offers: string, now: number): number {
  const waiting = readdirSync(offers).filter((f) => OFFER_FILE.test(f)).map((f) => ({ f, offer: offerAt(offers, f.slice(0, 16)) }))
  if (waiting.length === 0) return 0
  const entries = rosterIn(dir) ?? []
  let removed = 0
  for (const { f, offer } of waiting) {
    if (!offer) continue
    if (fresh(offer, now) && !entries.some((e) => e.key === offer.key || e.id === offer.id)) continue
    unlinkSync(join(offers, f))
    removed++
  }
  return removed
}

/** Sweep the waiting offers (see sweepIn); returns the count removed. */
export function sweepOffers(now: number = Date.now()): number {
  return withLock((dir) => {
    const offers = join(dir, 'offers')
    return checkDir(offers, false) ? sweepIn(dir, offers, now) : 0
  })
}

/** Remove every waiting offer; returns the count. roster.json is never touched. */
export function clearOffers(): number {
  return withLock((dir) => {
    const offers = join(dir, 'offers')
    if (!checkDir(offers, false)) return 0
    const names = readdirSync(offers).filter((f) => f.endsWith('.json'))
    for (const f of names) unlinkSync(join(offers, f))
    return names.length
  })
}

/** Remove pending.json; true when one was there. roster.json is never touched. */
export function clearPending(): boolean {
  return withLock((dir) => {
    const path = join(dir, 'pending.json')
    if (!lstatSync(path, { throwIfNoEntry: false })) return false
    unlinkSync(path)
    return true
  })
}

/** The offers waiting, by id and fingerprint. */
export function listOffers(): { id: string; fingerprint: string }[] {
  const dir = rosterDir()
  if (!checkDir(dir, false)) return []
  const offers = join(dir, 'offers')
  if (!checkDir(offers, false)) return []
  return readdirSync(offers)
    .filter((f) => /^[0-9a-f]{16}\.json$/.test(f))
    .sort()
    .flatMap((f) => {
      // No lock here: an offer trusted since the listing is simply gone.
      const offer = offerAt(offers, f.slice(0, 16))
      return offer ? [{ id: offer.id, fingerprint: fingerprintOf(offer.key) }] : []
    })
}

/** Sign the waiting offer whose whole fingerprint is `fingerprint` into the roster, by `key`. */
export function trustOffer(key: DeviceKey, fingerprint: string, now: number = Date.now()): { id: string; fingerprint: string } {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) throw new RosterError('bad fingerprint')
  return withLock((dir) => {
    const entries = rosterIn(dir)
    if (!entries || !entries.some((e) => e.key === key.publicKey)) throw new RosterError('not trusted')
    const offers = join(dir, 'offers')
    const offer = checkDir(offers, false) ? offerAt(offers, fingerprint) : undefined
    if (!offer || fingerprintOf(offer.key) !== fingerprint) throw new RosterError('no matching offer')
    if (!fresh(offer, now)) throw new RosterError('time')
    const last = entries[entries.length - 1]
    const head = { seq: entries.length, id: offer.id, key: offer.key, signer: key.publicKey, ts: Math.max(now, last.ts), prev: sha256(entryText(last)) }
    const next = verifyRoster(rosterText([...entries, { ...head, sig: key.sign(entryText(head)) }]), entries[0].key)
    writeAtomic(join(dir, 'roster.json'), rosterText(next))
    unlinkSync(join(offers, `${fingerprint}.json`))
    return { id: offer.id, fingerprint }
  })
}

const same = (a: Entry, b: Entry) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Which of two different entries at a fork point wins (U-R1A-31B-2): the lower fingerprint of
 * the signer, then of the key, then the lower sig (plain string order). Every computer applies
 * the same rule, so two that trusted a new computer at once end on one roster.
 */
export function forkWinner(a: Entry, b: Entry): 'a' | 'b' {
  const order: [string, string][] = [[fingerprintOf(a.signer), fingerprintOf(b.signer)], [fingerprintOf(a.key), fingerprintOf(b.key)], [a.sig, b.sig]]
  for (const [x, y] of order) if (x !== y) return x < y ? 'a' : 'b'
  return 'a'
}

/**
 * Take a roster from another computer. With a roster here, the incoming one must verify under
 * this roster's root (every refusal of verifyRoster stands); then: the same is 'same', a longer
 * one with this one as its exact prefix 'updated', a strict prefix of this one 'stale'. Two
 * branches: at the fork point k, forkWinner of the two entries decides (`from` 'hub': the
 * incoming one always wins, the hub keeps one order and accepts only an extension of it; but one
 * that would drop an entry after k signed by another computer is 'fork', nothing written). This
 * one wins: 'kept', nothing written. The incoming one wins: it must hold this computer's key and
 * id ('fork' otherwise, nothing written: its signer re-signs it later); this computer's own
 * entries after k whose key and id are both missing from it are signed again on its end, and the
 * whole is verified again ('rebased'). Entries after k signed by another computer are dropped
 * here: their signer re-signs them when it applies the same rule.
 * Without a roster here: kept as pending.json when it holds this computer's key and id ('pending').
 */
export function receiveRoster(raw: unknown, now: number = Date.now(), from: 'peer' | 'hub' = 'peer'): 'updated' | 'same' | 'pending' | 'kept' | 'rebased' {
  if (!isTime(now)) throw new RosterError('shape')
  return withLock((dir) => {
    const local = rosterIn(dir)
    if (local) {
      const root = local[0].key
      const next = verifyRoster(raw, root)
      const both = Math.min(local.length, next.length)
      let k = 0
      while (k < both && same(local[k], next[k])) k++
      if (k === both) {
        if (next.length === local.length) return 'same'
        if (next.length < local.length) throw new RosterError('stale')
        writeAtomic(join(dir, 'roster.json'), rosterText(next))
        return 'updated'
      }
      if (from !== 'hub' && forkWinner(local[k], next[k]) === 'a') return 'kept'
      const key = openDeviceKey()
      const id = thisId()
      if (!next.some((e) => e.key === key.publicKey && e.id === id)) throw new RosterError('fork')
      // The hub's say never drops a computer another one signed (a hub that kept an old branch
      // could cut the roster back with it): refused until that signer has signed it onto the hub's roster.
      if (from === 'hub' && local.slice(k).some((e) => e.signer !== key.publicKey && !next.some((o) => o.key === e.key))) throw new RosterError('fork')
      const out = [...next]
      for (const e of local.slice(k)) {
        if (e.signer !== key.publicKey || out.some((o) => o.key === e.key || o.id === e.id)) continue
        const last = out[out.length - 1]
        const head = { seq: out.length, id: e.id, key: e.key, signer: key.publicKey, ts: Math.max(now, last.ts), prev: sha256(entryText(last)) }
        out.push({ ...head, sig: key.sign(entryText(head)) })
      }
      const rebased = verifyRoster(rosterText(out), root)
      writeAtomic(join(dir, 'roster.json'), rosterText(rebased))
      return 'rebased'
    }
    const next = verifyRoster(raw)
    const me = openDeviceKey().publicKey
    const id = thisId()
    if (!next.some((e) => e.key === me && e.id === id)) throw new RosterError('not for this computer')
    writeAtomic(join(dir, 'pending.json'), rosterText(next))
    return 'pending'
  })
}

/**
 * Make the pending roster this computer's own, only when this computer's entry in it was signed
 * by the key whose fingerprint the owner gives. That signature covers prev, which fixes every
 * entry back to the root, so a roster the hub made itself cannot pass.
 */
export function joinRoster(key: DeviceKey, signerFingerprint: string): Entry[] {
  if (typeof signerFingerprint !== 'string' || !FINGERPRINT.test(signerFingerprint)) throw new RosterError('bad fingerprint')
  return withLock((dir) => {
    if (readChecked(join(dir, 'roster.json'), MAX_ROSTER_BYTES) !== undefined) throw new RosterError('roster exists')
    const path = join(dir, 'pending.json')
    const text = readChecked(path, MAX_ROSTER_BYTES)
    if (text === undefined) throw new RosterError('no pending join')
    const entries = verifyRoster(text)
    const mine = entries.find((e) => e.key === key.publicKey)
    if (!mine) throw new RosterError('not for this computer')
    if (fingerprintOf(mine.signer) !== signerFingerprint || mine.signer === mine.key) throw new RosterError('signer')
    writeAtomic(join(dir, 'roster.json'), rosterText(entries))
    unlinkSync(path)
    return entries
  })
}

// ---- CLI (packaging/tandem: fingerprint, roster, roster init, roster clear, trust <fingerprint>; through bridge/roster-hub.ts) ----

const USAGE = 'usage: tandem fingerprint | tandem roster | tandem roster init | tandem roster clear | tandem trust <fingerprint>\n'

export function main(args: string[]): number {
  const say = (s: string) => process.stdout.write(s + '\n')
  try {
    const [command, ...rest] = args
    if (command === 'fingerprint' && rest.length === 0) {
      say(`this computer: ${thisId()} ${openDeviceKey().fingerprint}`)
      return 0
    }
    if (command === 'roster' && rest.length === 0) {
      const entries = readRoster()
      if (!entries) say('no roster yet')
      for (const e of entries ?? []) say(`${e.seq} ${e.id} ${fingerprintOf(e.key)} signed by ${fingerprintOf(e.signer)}`)
      for (const o of listOffers()) say(`waiting: ${o.id} ${o.fingerprint}`)
      return 0
    }
    if (command === 'roster' && rest.length === 1 && rest[0] === 'init') {
      const key = openDeviceKey()
      const id = thisId()
      initRoster(key, id)
      say(`roster started: ${id} ${key.fingerprint}`)
      return 0
    }
    if (command === 'roster' && rest.length === 1 && rest[0] === 'clear') {
      const n = clearOffers()
      say(`cleared ${n} waiting offers; ${clearPending() ? 'pending join removed' : 'no pending join'}`)
      return 0
    }
    if (command === 'trust' && rest.length === 1) {
      const key = openDeviceKey()
      const dir = rosterDir()
      const has = (name: string) => checkDir(dir, false) && readChecked(join(dir, name), MAX_ROSTER_BYTES) !== undefined
      if (has('roster.json')) {
        const t = trustOffer(key, rest[0])
        say(`trusted ${t.id} ${t.fingerprint}. On ${t.id} run: tandem trust ${key.fingerprint}`)
        return 0
      }
      if (!has('pending.json')) throw new RosterError('no roster and no pending join (set TANDEM_HUB_LINK_URL to fetch one from the hub)')
      joinRoster(key, rest[0])
      say(`joined the roster signed by ${rest[0]}`)
      return 0
    }
    process.stderr.write(command === 'trust' ? 'usage: tandem trust <fingerprint>\n' : USAGE)
    return 2
  } catch (e) {
    if (e instanceof RosterError) {
      process.stderr.write(`tandem: ${e.reason}${e.path ? ` (${e.path})` : ''}\n`)
      return 1
    }
    if (e instanceof Error && e.name === 'DeviceKeyError') {
      process.stderr.write(`tandem: ${e.message}\n`)
      return 1
    }
    throw e
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) process.exitCode = main(process.argv.slice(2))
