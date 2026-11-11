/**
 * devices.ts — per-computer hub credentials: every request on the hub link (the tunnel socket
 * and the fabric link route) carries, beside the shared bearer, a proof signed by the computer's
 * own Ed25519 device key (bridge/device-keys.ts). The hub binds each machine id to the first key
 * that proves it and from then on refuses any other key under that id, so the shared link token
 * alone no longer lets anyone connect as another computer or receive its requests.
 *
 * The proof is the `tandem-proof` header, `v1 <id> <key> <ts> <nonce> <sig>`: sig is the key's
 * signature over proofText (the request's host, method, path and body hash with the other
 * fields). Its own first line, `tandem-hub-proof-v1`, is never used by envelopes or rosters, so a
 * signature made for one of those is never a proof.
 *
 * The table is a plain class over injected SQL storage (the shape of a Durable Object's
 * ctx.storage.sql), a clock and a transaction runner, as ./queue.ts is, so it tests on a local
 * SQLite file. `admit` runs in one transaction and is synchronous: inside the Durable Object one
 * check-and-bind never interleaves with another. WebCrypto only; this file deliberately imports
 * nothing from the Workers runtime.
 *
 * Known limits (not fixed here):
 *   - Trust on first use at the hub: the first proofed connect under an id binds it, so a token
 *     holder who connects first under a new computer's id owns that id at the hub. The roster,
 *     not the hub, decides who is trusted.
 *   - A computer that loses its key cannot connect under its id again until a release exists
 *     (U-R1B-28/U-R1B-31); the workaround is a new TANDEM_HUB_LINK_ID.
 *   - At most MAX_DEVICES (100) ids.
 *   - A proof is good for ±300 s of the hub's clock, and each nonce once per id.
 */
import { slugifyBridgeId } from './bridge-id.ts'

export const PROOF_HEADER = 'tandem-proof'
/** Lowercase hex SHA-256 of zero bytes. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
export const PROOF_TAG = 'tandem-hub-proof-v1'
export const MAX_DEVICES = 100
/** How far a proof's ts may be from the hub's clock. */
export const PROOF_WINDOW_MS = 300_000
/** How long a used nonce is remembered: longer than the window on both sides. */
export const NONCE_TTL_MS = 600_000

export interface ProofFields {
  host: string
  method: string
  path: string
  id: string
  key: string
  ts: number
  nonce: string
  bodySha256: string
}

export interface ParsedProof {
  id: string
  key: string
  ts: number
  nonce: string
  sig: string
}

/** What a request is, as the hub sees it; the proof must be over exactly this. */
export interface ProofContext {
  host: string
  method: string
  path: string
  bodySha256: string
}

/** The signed text. */
export function proofText(f: ProofFields): string {
  return [PROOF_TAG, f.host, f.method, f.path, f.id, f.key, String(f.ts), f.nonce, f.bodySha256].join('\n')
}

const ID = /^[a-z0-9._-]{1,64}$/
const TS = /^[0-9]{13}$/

/**
 * The small-order Ed25519 points, every encoding with the sign bit cleared (a copy of
 * bridge/device-keys.ts WEAK_KEYS: hub/src imports no bridge code).
 */
const WEAK_KEYS = new Set([
  '00'.repeat(32),
  '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f',
  'ed' + 'ff'.repeat(30) + '7f',
  'ee' + 'ff'.repeat(30) + '7f',
])

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

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

function publicKeyBytes(key: string): Uint8Array<ArrayBuffer> | undefined {
  const raw = decode(key, 43, 32)
  if (!raw) return undefined
  const unsigned = raw.slice()
  unsigned[31] &= 0x7f
  return WEAK_KEYS.has(hex(unsigned)) ? undefined : raw
}

/**
 * The fields of a `tandem-proof` value, or undefined unless it is exactly six single-space
 * fields of the right shapes. The id must also be its own slug (hub/src/bridge-id.ts): the
 * tunnel tags a socket with the slug of its bridge_id, so an id like `-alpha` would otherwise be
 * bound under one name and routed under another.
 */
export function parseProof(value: string | null | undefined): ParsedProof | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.split(' ')
  if (parts.length !== 6) return undefined
  const [version, id, key, ts, nonce, sig] = parts
  if (version !== 'v1') return undefined
  if (!ID.test(id) || slugifyBridgeId(id) !== id) return undefined
  if (!publicKeyBytes(key)) return undefined
  if (!TS.test(ts)) return undefined
  if (!decode(nonce, 22, 16)) return undefined
  if (!decode(sig, 86, 64)) return undefined
  return { id, key, ts: Number(ts), nonce, sig }
}

/** True only when `parsed.sig` is the key's signature over proofText for this request. Never throws. */
export async function verifyProof(parsed: ParsedProof, ctx: ProofContext): Promise<boolean> {
  try {
    const raw = publicKeyBytes(parsed.key)
    const sig = decode(parsed.sig, 86, 64)
    if (!raw || !sig) return false
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    const text = proofText({ ...ctx, id: parsed.id, key: parsed.key, ts: parsed.ts, nonce: parsed.nonce })
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(text))
  } catch {
    return false
  }
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
}

/** The part of ctx.storage.sql the table uses. */
export interface DevicesSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
}

export type Admit = 'ok' | 'bound' | 'replay' | 'unknown' | 'taken' | 'full'

export class HubDevices {
  private readonly sql: DevicesSql
  private readonly now: () => number
  private readonly transaction: <T>(fn: () => T) => T

  constructor(sql: DevicesSql, now: () => number, transaction: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql = sql
    this.now = now
    this.transaction = transaction
    sql.exec('CREATE TABLE IF NOT EXISTS hub_devices (id TEXT PRIMARY KEY, key TEXT NOT NULL, bound_at INTEGER NOT NULL)')
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_device_nonces (
      id TEXT NOT NULL, nonce TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (id, nonce))`)
  }

  /**
   * One proof's check and bind, all in one transaction: a used nonce is 'replay'; an id with no
   * key is bound to `key` ('bound') when `mayBind`, else 'unknown' ('full' past MAX_DEVICES); an
   * id bound to another key is 'taken' and nothing is written. On 'ok' and 'bound' the nonce is
   * kept for NONCE_TTL_MS.
   */
  admit(id: string, key: string, nonce: string, mayBind: boolean): Admit {
    return this.transaction((): Admit => {
      const now = this.now()
      this.sql.exec('DELETE FROM hub_device_nonces WHERE exp < ?', now)
      if (this.sql.exec('SELECT 1 FROM hub_device_nonces WHERE id = ? AND nonce = ?', id, nonce).toArray().length > 0) return 'replay'
      const row = this.sql.exec('SELECT key FROM hub_devices WHERE id = ?', id).toArray()[0]
      let result: Admit = 'ok'
      if (!row) {
        if (!mayBind) return 'unknown'
        const count = Number(this.sql.exec('SELECT COUNT(*) AS n FROM hub_devices').toArray()[0].n)
        if (count >= MAX_DEVICES) return 'full'
        this.sql.exec('INSERT INTO hub_devices (id, key, bound_at) VALUES (?, ?, ?)', id, key, now)
        result = 'bound'
      } else if (row.key !== key) {
        return 'taken'
      }
      this.sql.exec('INSERT INTO hub_device_nonces (id, nonce, exp) VALUES (?, ?, ?)', id, nonce, now + NONCE_TTL_MS)
      return result
    })
  }
}
