/**
 * device-keys.ts: this computer's own Ed25519 signing key (plan section 3, "Who sent it: keys and
 * the roster"). The key is made on first use at `<TANDEM_HOME, else ~/.tandem>/keys/device.key`
 * (folder 0700, file 0600, PKCS#8 PEM, worked out at each call) and never replaced. The private
 * key stays in this module's closure: no property, getter, toJSON, output or error message holds
 * it or its text. Others know this computer by its public key (raw 32 bytes, base64url) and its
 * pairing fingerprint (the first 16 hex characters of SHA-256 over those raw bytes).
 *
 * A key file or folder that is a symlink, not owned by this user, has the wrong mode or is not an
 * Ed25519 PKCS#8 private key is refused with DeviceKeyError (path and reason only) and left as is.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export class DeviceKeyError extends Error {
  readonly path: string
  readonly reason: string
  constructor(path: string, reason: string) {
    super(`device key ${path} refused: ${reason}`)
    this.name = 'DeviceKeyError'
    this.path = path
    this.reason = reason
  }
}

export interface DeviceKey {
  /** The raw 32-byte Ed25519 public key, base64url (43 characters). */
  readonly publicKey: string
  /** The first 16 lowercase hex characters of SHA-256 over the raw public key. */
  readonly fingerprint: string
  /** An Ed25519 signature over `data` (a string is signed as its UTF-8 bytes), base64url (86 characters). */
  sign(data: string | Uint8Array): string
}

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/

export function deviceKeyPath(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'keys', 'device.key')
}

/** base64url text that decodes to `bytes` bytes and encodes back to itself, else undefined. */
function decode(text: unknown, shape: RegExp, bytes: number): Buffer | undefined {
  if (typeof text !== 'string' || !shape.test(text)) return undefined
  const raw = Buffer.from(text, 'base64url')
  return raw.length === bytes && raw.toString('base64url') === text ? raw : undefined
}

export function fingerprintOf(publicKey: string): string {
  const raw = decode(publicKey, PUBLIC_KEY, 32)
  if (!raw) throw new TypeError('fingerprintOf: not a base64url Ed25519 public key')
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data)

/** True only when `signature` is a valid Ed25519 signature of `data` by `publicKey`; false on any bad input. */
export function verifySignature(publicKey: string, data: string | Uint8Array, signature: string): boolean {
  try {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) return false
    if (!decode(publicKey, PUBLIC_KEY, 32)) return false
    const sig = decode(signature, SIGNATURE, 64)
    if (!sig) return false
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
    return edVerify(null, bytesOf(data), key, sig)
  } catch {
    return false
  }
}

const uid = (): number | undefined => process.getuid?.()

/** The keys folder: made 0700 when missing; refused when a symlink, not a folder, not ours or not 0700. */
function checkFolder(dir: string, path: string): void {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  let st = lstatSync(dir, { throwIfNoEntry: false })
  if (!st) {
    try {
      mkdirSync(dir, { mode: 0o700 })
      chmodSync(dir, 0o700)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    st = lstatSync(dir)
  }
  if (st.isSymbolicLink()) throw new DeviceKeyError(path, `the folder ${dir} is a symlink`)
  if (!st.isDirectory()) throw new DeviceKeyError(path, `${dir} is not a folder`)
  checkOwnerAndMode(st, path, `the folder ${dir}`, 0o700)
}

function checkOwnerAndMode(st: Stats, path: string, what: string, want: number): void {
  const me = uid()
  if (me !== undefined && st.uid !== me) throw new DeviceKeyError(path, `${what} is not owned by this user`)
  const mode = st.mode & 0o777
  if (mode !== want) throw new DeviceKeyError(path, `${what} has mode 0${mode.toString(8)}, not 0${want.toString(8)}`)
}

/** The private key in the file at `path`, or undefined when there is no file. Never changes the file. */
function readKey(path: string): KeyObject | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP' || code === 'EMLINK') throw new DeviceKeyError(path, 'the key file is a symlink')
    throw e
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new DeviceKeyError(path, 'the key file is not a regular file')
    checkOwnerAndMode(st, path, 'the key file', 0o600)
    let key: KeyObject | undefined
    try {
      // Ed25519 private keys exist only as PKCS#8, so the type check below also settles the format.
      key = createPrivateKey({ key: readFileSync(fd, 'utf8'), format: 'pem' })
    } catch {
      key = undefined
    }
    if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
      throw new DeviceKeyError(path, 'the key file is not an Ed25519 PKCS#8 private key')
    }
    return key
  } finally {
    closeSync(fd)
  }
}

/** Write a new key next to `path` and link it into place; another process that linked first wins. */
function createKey(path: string): void {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd = openSync(tmp, 'wx', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, pem)
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    try {
      linkSync(tmp, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  } finally {
    if (fd >= 0) closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
  }
}

/** This computer's key: the one at `path` (default deviceKeyPath()), made on first use. */
export function openDeviceKey(options: { path?: string } = {}): DeviceKey {
  const path = resolve(options.path ?? deviceKeyPath())
  checkFolder(dirname(path), path)
  let privateKey = readKey(path)
  if (!privateKey) {
    createKey(path)
    privateKey = readKey(path)
    if (!privateKey) throw new DeviceKeyError(path, 'the key file vanished after it was made')
  }
  const signer = privateKey
  const publicKey = createPublicKey(signer).export({ format: 'jwk' }).x as string
  return Object.freeze({
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    sign: (data: string | Uint8Array): string => edSign(null, bytesOf(data), signer).toString('base64url'),
  })
}
