/**
 * roster-verify.ts — the hub's own check of the owner's roster (U-R1A-31C-1), for one decision
 * only: which computers may be the memory home (tunnel-do.ts handleFabricRpc). The rules are
 * bridge/roster.ts verifyRoster's with no root given: shape, a self-signed root, the chain (seq,
 * prev = SHA-256 of the entry text before, ts never going back), each signer an earlier entry's
 * key, no id or key twice, every Ed25519 signature; at most 100 entries and 131,072 bytes; a
 * small-order key refused as ./devices.ts refuses it. Roster acceptance is unchanged: the store
 * (./roster-store.ts) still keeps any extension, and every computer still checks it itself.
 *
 * Pure: WebCrypto only, no Workers runtime, no node: module, no bridge code.
 */

const ID = /^[a-z0-9._-]{1,64}$/
const SIG = /^[A-Za-z0-9_-]{86}$/
const SHA256 = /^[0-9a-f]{64}$/
const ZERO = '0'.repeat(64)
const MAX_ENTRIES = 100
const MAX_ROSTER_BYTES = 131_072
const ENTRY_FIELDS = ['id', 'key', 'prev', 'seq', 'sig', 'signer', 'ts'].join()

/** The small-order Ed25519 points, every encoding with the sign bit cleared (as ./devices.ts). */
const WEAK_KEYS = new Set([
  '00'.repeat(32),
  '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f',
  'ed' + 'ff'.repeat(30) + '7f',
  'ee' + 'ff'.repeat(30) + '7f',
])

type Entry = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const entryText = (e: Omit<Entry, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`

/** `text` as `chars` base64url characters that decode to `bytes` bytes and encode back to `text`, else undefined. */
function decode(text: string, chars: number, bytes: number): Uint8Array<ArrayBuffer> | undefined {
  if (text.length !== chars || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined
  let binary: string
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return undefined
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  if (out.length !== bytes) return undefined
  const again = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return again === text ? out : undefined
}

/** The 32 raw bytes of a base64url Ed25519 public key that is not a weak one, else undefined. */
function publicKeyBytes(key: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof key !== 'string') return undefined
  const raw = decode(key, 43, 32)
  if (!raw) return undefined
  const unsigned = raw.slice()
  unsigned[31] &= 0x7f
  return WEAK_KEYS.has(hex(unsigned)) ? undefined : raw
}

async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

async function signedBy(key: string, text: string, sig: string): Promise<boolean> {
  const raw = publicKeyBytes(key)
  const signature = decode(sig, 86, 64)
  if (!raw || !signature) return false
  const imported = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'Ed25519' }, imported, signature, new TextEncoder().encode(text))
}

/** The `{ id, key }` of every entry of a roster that checks out, else undefined. Never throws. */
export async function verifyRosterText(text: string): Promise<{ id: string; key: string }[] | undefined> {
  try {
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_ROSTER_BYTES) return undefined
    const doc: unknown = JSON.parse(text)
    if (!isObject(doc) || Object.keys(doc).sort().join() !== 'entries,v' || doc.v !== 1) return undefined
    const list = doc.entries
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTRIES) return undefined
    const entries: Entry[] = []
    for (const e of list as unknown[]) {
      if (!isObject(e) || Object.keys(e).sort().join() !== ENTRY_FIELDS) return undefined
      const { seq, id, key, signer, ts, prev, sig } = e
      if (!isTime(seq) || typeof id !== 'string' || !ID.test(id) || !publicKeyBytes(key) || !publicKeyBytes(signer) || !isTime(ts) ||
        typeof prev !== 'string' || !SHA256.test(prev) || typeof sig !== 'string' || !SIG.test(sig)) {
        return undefined
      }
      entries.push({ seq, id, key: key as string, signer: signer as string, ts, prev, sig })
    }
    if (entries[0].signer !== entries[0].key) return undefined
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const before = entries[i - 1]
      if (e.seq !== i || e.prev !== (before ? await sha256Hex(entryText(before)) : ZERO) || (before && e.ts < before.ts)) return undefined
      if (i > 0 && !entries.slice(0, i).some((earlier) => earlier.key === e.signer)) return undefined
    }
    if (new Set(entries.map((e) => e.id)).size !== entries.length || new Set(entries.map((e) => e.key)).size !== entries.length) return undefined
    for (const e of entries) if (!(await signedBy(e.signer, entryText(e), e.sig))) return undefined
    return entries.map((e) => ({ id: e.id, key: e.key }))
  } catch {
    return undefined
  }
}
