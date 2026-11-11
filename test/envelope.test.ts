/**
 * U-R1A-30: each computer's own Ed25519 signing key (bridge/device-keys.ts) and the signed envelope
 * every message or command between computers travels in (bridge/envelope.ts), with the replay store
 * in state.db.
 *
 * Every folder this file makes is under one mkdtemp folder in TMPDIR named r1a30-, removed in
 * afterAll: TANDEM_HOME (set before the dynamic imports), the refusal homes, the temporary HOME of
 * case (a), and the child processes' script of case (c). Clocks are fixed through `now`.
 */
import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a30-')))
const TH = join(BOX, 'tandem')
mkdirSync(TH, { mode: 0o700 })
process.env.TANDEM_HOME = TH

const { DeviceKeyError, deviceKeyPath, fingerprintOf, openDeviceKey, verifySignature } = await import('../bridge/device-keys.ts')
const { EnvelopeError, openEnvelope, openReplayStore, signEnvelope } = await import('../bridge/envelope.ts')
const { openMailbox } = await import('../bridge/mailbox.ts')

afterAll(() => rmSync(BOX, { recursive: true, force: true }))

const T = 1_800_000_000_000
const MAX = 1_048_576
const CAP = 7 * 24 * 3_600_000 + 300_000
const mode = (p: string) => statSync(p).mode & 0o777
let n = 0
/** A new empty folder under BOX (mode 0700). */
const folder = (name = 'h') => {
  const p = join(BOX, `${name}-${++n}`)
  mkdirSync(p, { mode: 0o700 })
  return p
}
const keyAt = (home: string) => openDeviceKey({ path: join(home, 'keys', 'device.key') })
const tmpLeft = (keys: string) => readdirSync(keys).filter((f) => f.endsWith('.tmp'))
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const pkcs8 = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }) as string

const A = openDeviceKey({ path: join(folder('a'), 'keys', 'device.key') })
const B = openDeviceKey({ path: join(folder('b'), 'keys', 'device.key') })
const store = () => openReplayStore({ path: join(folder('db'), 'state.db'), now: () => T })

/** The refusal of `fn` as an EnvelopeError reason. */
function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof EnvelopeError) return e.reason
    throw e
  }
  return 'accepted'
}

describe('(a) device key: made on first use, the same after', () => {
  it('folder 0700, file 0600, Ed25519; same key twice; fingerprint; verifySignature', () => {
    const k1 = openDeviceKey()
    const file = join(TH, 'keys', 'device.key')
    expect(deviceKeyPath()).toBe(file)
    expect(mode(join(TH, 'keys'))).toBe(0o700)
    expect(mode(file)).toBe(0o600)
    expect(createPrivateKey(readFileSync(file)).asymmetricKeyType).toBe('ed25519')
    const before = readFileSync(file)
    const k2 = openDeviceKey()
    expect(k2.publicKey).toBe(k1.publicKey)
    expect(k2.fingerprint).toBe(k1.fingerprint)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(k1.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const raw = Buffer.from(k1.publicKey, 'base64url')
    expect(raw.length).toBe(32)
    expect(k1.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(k1.fingerprint).toBe(sha(raw).slice(0, 16))
    expect(fingerprintOf(k1.publicKey)).toBe(k1.fingerprint)
    expect(tmpLeft(join(TH, 'keys'))).toEqual([])

    const sig = k1.sign('hello')
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(verifySignature(k1.publicKey, 'hello', sig)).toBe(true)
    expect(verifySignature(k1.publicKey, new TextEncoder().encode('hello'), k1.sign(new TextEncoder().encode('hello')))).toBe(true)
    expect(verifySignature(A.publicKey, 'hello', sig)).toBe(false)
    expect(verifySignature(k1.publicKey, 'hellp', sig)).toBe(false)
    const flipped = Buffer.from(sig, 'base64url')
    flipped[10] ^= 1
    expect(verifySignature(k1.publicKey, 'hello', flipped.toString('base64url'))).toBe(false)
    for (const bad of ['', 'garbage', 'x'.repeat(86), null, 42, sig + 'A']) expect(verifySignature(k1.publicKey, 'hello', bad as string)).toBe(false)
    for (const bad of ['', 'garbage', 'A'.repeat(43), undefined]) expect(verifySignature(bad as string, 'hello', sig)).toBe(false)
    expect(verifySignature(k1.publicKey, 42 as unknown as string, sig)).toBe(false)
  })

  it('TANDEM_HOME unset: $HOME/.tandem/keys/device.key under the test temp HOME', () => {
    const saved = { home: process.env.HOME, th: process.env.TANDEM_HOME }
    const home = folder('home')
    process.env.HOME = home
    delete process.env.TANDEM_HOME
    try {
      const path = deviceKeyPath()
      expect(path).toBe(join(homedir(), '.tandem', 'keys', 'device.key'))
      expect(path.startsWith(home + '/')).toBe(true)
      expect(path.startsWith(join(userInfo().homedir, '.tandem'))).toBe(false)
      const k = openDeviceKey()
      expect(existsSync(path)).toBe(true)
      expect(mode(join(home, '.tandem'))).toBe(0o700)
      expect(fingerprintOf(k.publicKey)).toBe(k.fingerprint)
    } finally {
      process.env.HOME = saved.home
      process.env.TANDEM_HOME = saved.th
    }
  })
})

/** Each refusal case: [name, home builder]; the builder returns the paths whose bytes must not change. */
const refusals: [string, () => { home: string; path?: string; watch: string[] }][] = [
  ['keys/ 0755', () => {
    const home = folder()
    keyAt(home)
    chmodSync(join(home, 'keys'), 0o755)
    return { home, watch: [join(home, 'keys', 'device.key')] }
  }],
  ['keys/ a symlink', () => {
    const home = folder()
    const real = folder()
    keyAt(real)
    symlinkSync(join(real, 'keys'), join(home, 'keys'))
    return { home, watch: [join(real, 'keys', 'device.key')] }
  }],
  ['device.key 0644', () => {
    const home = folder()
    keyAt(home)
    chmodSync(join(home, 'keys', 'device.key'), 0o644)
    return { home, watch: [join(home, 'keys', 'device.key')] }
  }],
  ['device.key a symlink to a valid key', () => {
    const home = folder()
    const real = folder()
    keyAt(real)
    mkdirSync(join(home, 'keys'), { mode: 0o700 })
    symlinkSync(join(real, 'keys', 'device.key'), join(home, 'keys', 'device.key'))
    return { home, watch: [join(real, 'keys', 'device.key')] }
  }],
  ['garbage bytes', () => {
    const home = folder()
    mkdirSync(join(home, 'keys'), { mode: 0o700 })
    writeFileSync(join(home, 'keys', 'device.key'), Buffer.from([0, 1, 2, 255, 10, 45, 45]), { mode: 0o600 })
    return { home, watch: [join(home, 'keys', 'device.key')] }
  }],
  ['an RSA private key', () => {
    const home = folder()
    mkdirSync(join(home, 'keys'), { mode: 0o700 })
    writeFileSync(join(home, 'keys', 'device.key'), pkcs8(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), { mode: 0o600 })
    return { home, watch: [join(home, 'keys', 'device.key')] }
  }],
  ['a P-256 private key', () => {
    const home = folder()
    mkdirSync(join(home, 'keys'), { mode: 0o700 })
    writeFileSync(join(home, 'keys', 'device.key'), pkcs8(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), { mode: 0o600 })
    return { home, watch: [join(home, 'keys', 'device.key')] }
  }],
  ['a custom path in a 0755 folder', () => {
    const home = folder()
    mkdirSync(join(home, 'keys'), { mode: 0o755 })
    chmodSync(join(home, 'keys'), 0o755)
    return { home, path: join(home, 'keys', 'mine.key'), watch: [] }
  }],
]

describe('(b) refused, file unchanged, no key text in the error', () => {
  for (const [name, build] of refusals) {
    it(name, () => {
      const { home, path, watch } = build()
      const target = path ?? join(home, 'keys', 'device.key')
      const before = watch.map((p) => ({ bytes: readFileSync(p), mode: mode(p) }))
      const linkBefore = lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
      let err: unknown
      try {
        openDeviceKey({ path: target })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DeviceKeyError)
      const msg = (err as Error).message
      expect(msg).toContain(target)
      expect(msg).toContain('refused: ')
      expect(msg).not.toContain('PRIVATE')
      for (const [i, p] of watch.entries()) {
        expect(readFileSync(p).equals(before[i].bytes)).toBe(true)
        expect(mode(p)).toBe(before[i].mode)
        for (const line of readFileSync(p, 'utf8').split('\n').filter((l) => l.length >= 16 && !l.startsWith('-----'))) expect(msg).not.toContain(line)
      }
      expect(lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(linkBefore)
      if (watch.length === 0) expect(existsSync(target)).toBe(false)
      const keys = join(home, 'keys')
      if (!lstatSync(keys).isSymbolicLink()) expect(tmpLeft(keys)).toEqual([])
    })
  }
})

describe('(c) two processes at once', () => {
  it('same fingerprint, one device.key, no tmp file', async () => {
    const home = folder('race')
    const script = join(folder('script'), 'open.mjs')
    writeFileSync(script, [
      `const { openDeviceKey } = await import(${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'device-keys.ts')).href)})`,
      'const at = Number(process.argv[2])',
      'while (Date.now() < at) {}',
      'process.stdout.write(openDeviceKey().fingerprint)',
    ].join('\n'))
    const at = String(Date.now() + 1500)
    const run = () => new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, at], { env: { ...process.env, TANDEM_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('close', (code) => done({ code, out, err }))
    })
    const [one, two] = await Promise.all([run(), run()])
    expect(one).toMatchObject({ code: 0, err: '' })
    expect(two).toMatchObject({ code: 0, err: '' })
    expect(one.out).toMatch(/^[0-9a-f]{16}$/)
    expect(two.out).toBe(one.out)
    expect(readdirSync(join(home, 'keys'))).toEqual(['device.key'])
    expect(keyAt(home).fingerprint).toBe(one.out)
  }, 30_000)
})

describe('(d) the private key is never printed', () => {
  it('no output during create, sign, open and refusals; no key text in key or errors', () => {
    const home = folder()
    const spies = [
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
      ...(['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir'] as const).map((m) => vi.spyOn(console, m)),
    ]
    const errors: string[] = []
    let key: ReturnType<typeof openDeviceKey>
    try {
      key = keyAt(home)
      key.sign('data')
      keyAt(home).sign(new Uint8Array([1, 2, 3]))
      const file = join(home, 'keys', 'device.key')
      for (const m of [0o644, 0o640, 0o400]) {
        chmodSync(file, m)
        try {
          keyAt(home)
        } catch (e) {
          errors.push(String(e), (e as Error).message, (e as Error).stack ?? '', inspect(e, { showHidden: true, depth: 8 }), JSON.stringify(e))
        }
      }
      chmodSync(file, 0o600)
      chmodSync(join(home, 'keys'), 0o750)
      try {
        keyAt(home)
      } catch (e) {
        errors.push(String(e), (e as Error).message, (e as Error).stack ?? '', inspect(e, { showHidden: true, depth: 8 }))
      }
      chmodSync(join(home, 'keys'), 0o700)
      for (const s of spies) expect(s).not.toHaveBeenCalled()
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(errors.length).toBe(19)
    const pem = readFileSync(join(home, 'keys', 'device.key'), 'utf8')
    const body = pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('')
    const seed = createPrivateKey(pem).export({ format: 'jwk' }).d as string
    expect(seed).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const shown = [JSON.stringify(key!), inspect(key!, { showHidden: true, depth: 8 }), String(key!), ...errors]
    for (const text of shown) {
      expect(text).not.toContain(body)
      expect(text).not.toContain('PRIVATE')
      expect(text).not.toContain(seed)
    }
    expect(Object.keys(key!).sort()).toEqual(['fingerprint', 'publicKey', 'sign'])
  })
})

describe('(e) sign and open', () => {
  it('A signs to B; B opens with sender A: body back', () => {
    const seen = store()
    const env = signEnvelope(A, { from: 'a', to: 'b', body: 'hello é' }, T)
    expect(Object.keys(env).sort()).toEqual(['body', 'body_sha256', 'from', 'nonce', 'sig', 'to', 'ts', 'v'])
    expect(env).toMatchObject({ v: 1, from: 'a', to: 'b', ts: T, body: 'hello é', body_sha256: sha(Buffer.from('hello é', 'utf8')) })
    expect(env.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(env.sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(verifySignature(A.publicKey, `tandem-envelope-v1\na\nb\n${env.nonce}\n${T}\n${env.body_sha256}`, env.sig)).toBe(true)
    const got = openEnvelope(JSON.parse(JSON.stringify(env)), { sender: { id: 'a', publicKey: A.publicKey }, self: 'b', seen, now: T + 1000 })
    expect(got).toEqual({ from: 'a', to: 'b', body: 'hello é', ts: T, nonce: env.nonce })
    expect(openEnvelope(JSON.stringify(signEnvelope(A, { from: 'a', to: 'b', body: '' }, T)), { sender: { id: 'a', publicKey: A.publicKey }, self: 'b', seen, now: T }).body).toBe('')
    expect(seen.size()).toBe(2)
    seen.close()
  })
})

describe('(f) each refusal has its reason and uses no nonce', () => {
  const seen = store()
  const sender = { id: 'a', publicKey: A.publicKey }
  const good = () => signEnvelope(A, { from: 'a', to: 'b', body: 'pay 10' }, T) as unknown as Record<string, unknown>
  const open = (raw: unknown, over: Record<string, unknown> = {}) =>
    reasonOf(() => openEnvelope(raw, { sender, self: 'b', seen, now: T, ...over }))
  afterAll(() => seen.close())

  const cases: [string, () => string][] = [
    ["B's key signs from 'a'", () => open(signEnvelope(B, { from: 'a', to: 'b', body: 'pay 10' }, T))],
    ["opened expecting sender 'c'", () => open(good(), { sender: { id: 'c', publicKey: A.publicKey } })],
    ["self 'c'", () => open(good(), { self: 'c' })],
    ['one body byte changed', () => open({ ...good(), body: 'pay 90' })],
    ['body and body_sha256 both changed', () => open({ ...good(), body: 'pay 90', body_sha256: sha('pay 90') })],
    ['a new well-formed nonce', () => open({ ...good(), nonce: Buffer.alloc(16, 7).toString('base64url') })],
    ['ts moved by 1 ms', () => open({ ...good(), ts: T + 1 })],
    ['a well-formed sig from another message', () => open({ ...good(), sig: signEnvelope(A, { from: 'a', to: 'b', body: 'other' }, T).sig })],
  ]
  const expected = ['signature', 'from', 'to', 'body', 'signature', 'signature', 'signature', 'signature']
  for (const [i, [name, run]] of cases.entries()) {
    it(`${name}: '${expected[i]}'`, () => {
      const size = seen.size()
      expect(run()).toBe(expected[i])
      expect(seen.size()).toBe(size)
    })
  }

  it("sig not matching ^[A-Za-z0-9_-]{86}$, missing/extra/wrongly typed keys, v 2, ids with ':' or capitals: 'shape'", () => {
    const g = good()
    const shapes: unknown[] = [
      { ...g, sig: 'x'.repeat(85) },
      { ...g, sig: 'x'.repeat(87) },
      { ...g, sig: (g.sig as string).slice(0, 85) + '=' },
      { ...g, sig: (g.sig as string).slice(0, 85) + '+' },
      ...Object.keys(g).map((k) => Object.fromEntries(Object.entries(g).filter(([kk]) => kk !== k))),
      { ...g, extra: 1 },
      { ...g, v: 2 },
      { ...g, v: '1' },
      { ...g, ts: String(T) },
      { ...g, ts: T + 0.5 },
      { ...g, body: 42 },
      { ...g, body: null },
      { ...g, from: 1 },
      { ...g, nonce: 'short' },
      { ...g, body_sha256: (g.body_sha256 as string).toUpperCase() },
      { ...g, from: 'a:b' },
      { ...g, to: 'B' },
      { ...g, from: 'A' },
      { ...g, to: 'x'.repeat(65) },
      { ...g, from: '' },
      null,
      'not json',
      '[]',
      [],
      42,
      JSON.stringify({ ...g, v: 2 }),
    ]
    const size = seen.size()
    for (const s of shapes) expect([s, open(s)]).toEqual([s, 'shape'])
    expect(seen.size()).toBe(size)
  })

  it("time: ts at now - maxAgeMs accepted, 1 ms older refused; now + 300,000 accepted, + 300,001 refused", () => {
    const at = (ts: number) => signEnvelope(A, { from: 'a', to: 'b', body: 't' }, ts)
    expect(open(at(T - 300_001))).toBe('time')
    expect(open(at(T - 300_000))).toBe('accepted')
    expect(open(at(T - 60_001), { maxAgeMs: 60_000 })).toBe('time')
    expect(open(at(T - 60_000), { maxAgeMs: 60_000 })).toBe('accepted')
    expect(open(at(T - CAP - 1), { maxAgeMs: CAP })).toBe('time')
    expect(open(at(T - CAP), { maxAgeMs: CAP })).toBe('accepted')
    expect(open(at(T + 300_001))).toBe('time')
    expect(open(at(T + 300_000))).toBe('accepted')
    const size = seen.size()
    expect(open(at(T - 300_001))).toBe('time')
    expect(seen.size()).toBe(size)
  })

  it('maxAgeMs 0 or above the cap throws a RangeError before the envelope is read', () => {
    let reads = 0
    const spy = new Proxy({}, { get: () => { reads++; throw new Error('read') }, ownKeys: () => { reads++; throw new Error('read') }, getPrototypeOf: () => { reads++; throw new Error('read') } })
    for (const maxAgeMs of [0, -1, CAP + 1, 1.5, Number.NaN, Infinity]) {
      expect(() => openEnvelope(spy, { sender, self: 'b', seen, now: T, maxAgeMs })).toThrow(RangeError)
    }
    expect(reads).toBe(0)
    expect(open(signEnvelope(A, { from: 'a', to: 'b', body: '1ms' }, T), { maxAgeMs: 1 })).toBe('accepted')
  })

  it('a bad id or a body with a lone surrogate is refused at sign', () => {
    expect(reasonOf(() => signEnvelope(A, { from: 'a:b', to: 'b', body: '' }, T))).toBe('shape')
    expect(reasonOf(() => signEnvelope(A, { from: 'a', to: 'B', body: '' }, T))).toBe('shape')
    expect(reasonOf(() => signEnvelope(A, { from: 'a', to: 'b', body: 'x\ud800' }, T))).toBe('shape')
    const g = good()
    expect(open({ ...g, body: 'pay 1\ud800' })).toBe('shape')
  })
})

describe('(g) replay', () => {
  it('second open is a replay, also after close and reopen; a tampered copy first does not block the genuine one; expired rows go', () => {
    const path = join(folder('db'), 'state.db')
    let seen = openReplayStore({ path, now: () => T })
    const sender = { id: 'a', publicKey: A.publicKey }
    const env = signEnvelope(A, { from: 'a', to: 'b', body: 'once' }, T)
    const open = (raw: unknown) => reasonOf(() => openEnvelope(raw, { sender, self: 'b', seen, now: T }))
    expect(open({ ...env, body: 'twice' })).toBe('body')
    expect(open({ ...env, ts: T + 5 })).toBe('signature')
    expect(open(signEnvelope(B, { from: 'a', to: 'b', body: 'once' }, T))).toBe('signature')
    expect(seen.size()).toBe(0)
    expect(open(env)).toBe('accepted')
    expect(open(env)).toBe('replay')
    expect(open(JSON.stringify(env))).toBe('replay')
    seen.close()
    seen = openReplayStore({ path, now: () => T })
    expect(open(env)).toBe('replay')
    expect(seen.size()).toBe(1)
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT from_id, nonce, expires_ms FROM envelope_seen').all()).toEqual([{ from_id: 'a', nonce: env.nonce, expires_ms: T + 300_000 + 300_000 }])
    db.close()
    seen.close()

    let clock = T
    const s2 = openReplayStore({ path, now: () => clock })
    expect(s2.remember('z', 'n1', T + 10)).toBe(true)
    expect(s2.remember('z', 'n1', T + 10)).toBe(false)
    expect(s2.size()).toBe(2)
    clock = T + 600_001
    expect(s2.remember('z', 'n2', clock + 10)).toBe(true)
    expect(s2.size()).toBe(1)
    expect(s2.remember('z', 'n1', clock + 10)).toBe(true)
    s2.close()
  })

  it('a missing folder is made 0700 and the file 0600; a group/world folder or a symlinked file is refused', () => {
    const base = folder('db')
    const path = join(base, 'new', 'state.db')
    openReplayStore({ path }).close()
    expect(mode(join(base, 'new'))).toBe(0o700)
    expect(mode(path)).toBe(0o600)
    chmodSync(join(base, 'new'), 0o750)
    expect(() => openReplayStore({ path })).toThrow(/refused: /)
    chmodSync(join(base, 'new'), 0o700)
    const other = folder('db')
    symlinkSync(path, join(other, 'state.db'))
    expect(() => openReplayStore({ path: join(other, 'state.db') })).toThrow(/refused: /)
  })
})

describe('(h) size', () => {
  it('an envelope over 1,048,576 bytes: sign throws shape; such JSON opened: shape', () => {
    const seen = store()
    const empty = JSON.stringify(signEnvelope(A, { from: 'a', to: 'b', body: '' }, T))
    const room = MAX - Buffer.byteLength(empty)
    const full = signEnvelope(A, { from: 'a', to: 'b', body: 'x'.repeat(room) }, T)
    expect(Buffer.byteLength(JSON.stringify(full))).toBe(MAX)
    expect(reasonOf(() => signEnvelope(A, { from: 'a', to: 'b', body: 'x'.repeat(room + 1) }, T))).toBe('shape')
    const over = { ...full, body: 'x'.repeat(room + 1), body_sha256: sha('x'.repeat(room + 1)) }
    expect(Buffer.byteLength(JSON.stringify(over))).toBe(MAX + 1)
    const sender = { id: 'a', publicKey: A.publicKey }
    expect(reasonOf(() => openEnvelope(JSON.stringify(over), { sender, self: 'b', seen, now: T }))).toBe('shape')
    expect(reasonOf(() => openEnvelope(over, { sender, self: 'b', seen, now: T }))).toBe('shape')
    expect(reasonOf(() => openEnvelope(JSON.stringify(full) + ' ', { sender, self: 'b', seen, now: T }))).toBe('shape')
    expect(seen.size()).toBe(0)
    expect(openEnvelope(JSON.stringify(full), { sender, self: 'b', seen, now: T }).body.length).toBe(room)
    seen.close()
  })
})

describe('(i) state.db shared with the mailbox', () => {
  it('default under TANDEM_HOME, 0600; openMailbox still sends and reads; the mail table untouched', () => {
    const box = openMailbox({ now: () => T })
    const first = box.send({ from: 'owner', to: 'lead', level: 'fyi', text: 'before' })
    const file = join(TH, 'state.db')
    const db = new DatabaseSync(file)
    const mailBefore = db.prepare('SELECT * FROM mail ORDER BY seq').all()
    const schemaBefore = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'mail' ORDER BY name").all()
    const seen = openReplayStore({ now: () => T })
    expect(mode(file)).toBe(0o600)
    expect(mode(TH)).toBe(0o700)
    expect(seen.remember('a', 'n', T + 1)).toBe(true)
    expect(db.prepare('SELECT * FROM mail ORDER BY seq').all()).toEqual(mailBefore)
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'mail' ORDER BY name").all()).toEqual(schemaBefore)
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'envelope_seen'").get()).toEqual({ n: 1 })
    const second = box.send({ from: 'owner', to: 'lead', level: 'fyi', text: 'after' })
    expect(box.read('lead', 50).map((m) => [m.id, m.text])).toEqual([[first.id, 'before'], [second.id, 'after']])
    db.close()
    seen.close()
    box.close()
    expect(mode(file)).toBe(0o600)
  })
})
