/**
 * devices.test.ts — per-computer hub credentials (U-R1A-31B-1): the proof format, its check,
 * and the table that binds each machine id to the first key that proves it.
 *
 * HubDevices runs over real SQLite (node:sqlite) on a file in a temp folder, wrapped to the
 * shape of a Durable Object's ctx.storage.sql, with a fake clock, as queue.test.ts runs HubQueue.
 * Keys come from node:crypto; the raw public key is the JWK `x`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { EMPTY_SHA256, HubDevices, PROOF_HEADER, parseProof, proofText, verifyProof } from '../src/devices.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-devices-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_700_000_000_000

/** A HubDevices over a fresh database file, plus a way to restart it on the same file. */
function openDevices(file = join(dir, `d${++files}.sqlite`)) {
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
  const h = { devices: new HubDevices(sqlOf(db), () => clock.now, txOf(db)) }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    h.devices = new HubDevices(sqlOf(db), () => clock.now, txOf(db))
  }
  const rows = (query: string, ...bindings: SQLInputValue[]) => db.prepare(query).all(...bindings) as Record<string, unknown>[]
  return { h, clock, restart, rows }
}

function newKey(): { publicKey: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ed25519')
  return { publicKey: pair.publicKey.export({ format: 'jwk' }).x as string, privateKey: pair.privateKey }
}

const A = newKey()
const B = newKey()
const sig = (key: KeyObject, text: string) => sign(null, Buffer.from(text, 'utf8'), key).toString('base64url')

const CTX = { host: '127.0.0.1:8787', method: 'GET', path: '/__tunnel/connect', bodySha256: EMPTY_SHA256 }
const NONCE = Buffer.alloc(16, 7).toString('base64url')
const TS = 1_762_000_000_000

/** A header value signed by `signer` over `fields` (each defaults to a good value). */
function header(fields: Partial<{ id: string; key: string; ts: number; nonce: string }> = {}, signer = A.privateKey, ctx = CTX): string {
  const f = { id: 'alpha', key: A.publicKey, ts: TS, nonce: NONCE, ...fields }
  return `v1 ${f.id} ${f.key} ${f.ts} ${f.nonce} ${sig(signer, proofText({ ...ctx, ...f }))}`
}

/** The small-order Ed25519 encodings (bridge/device-keys.ts WEAK_KEYS), as base64url public keys. */
const WEAK_HEX = [
  '00'.repeat(32),
  '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f',
  'ed' + 'ff'.repeat(30) + '7f',
  'ee' + 'ff'.repeat(30) + '7f',
]

describe('proof format', () => {
  it('the header name and the empty-body hash', () => {
    expect(PROOF_HEADER).toBe('tandem-proof')
    expect(EMPTY_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('(a) proofText of one fixed input is the golden text', () => {
    expect(proofText({
      host: '127.0.0.1:8787', method: 'GET', path: '/__tunnel/connect', id: 'alpha',
      key: 'k'.repeat(43), ts: 1762000000000, nonce: 'n'.repeat(22), bodySha256: EMPTY_SHA256,
    })).toBe(
      'tandem-hub-proof-v1\n127.0.0.1:8787\nGET\n/__tunnel/connect\nalpha\n' + 'k'.repeat(43) +
      '\n1762000000000\n' + 'n'.repeat(22) + '\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('parseProof reads a good header', () => {
    expect(parseProof(header())).toEqual({
      id: 'alpha', key: A.publicKey, ts: TS, nonce: NONCE, sig: header().split(' ')[5],
    })
  })

  describe('(b) parseProof refuses', () => {
    const good = header().split(' ')
    const swap = (i: number, value: string) => good.map((part, j) => (j === i ? value : part)).join(' ')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    // The same 32 bytes with one of the two unused low bits of the last character set.
    const last = alphabet.indexOf(A.publicKey[42])
    const nonCanonical = A.publicKey.slice(0, 42) + alphabet[last | 1]

    it.each([
      ['5 fields', good.slice(0, 5).join(' ')],
      ['7 fields', [...good, 'x'].join(' ')],
      ['a double space', good.join('  ')],
      ['v2', swap(0, 'v2')],
      ['an uppercase id', swap(1, 'Alpha')],
      ['an id with /', swap(1, 'al/pha')],
      ['a 65-char id', swap(1, 'a'.repeat(65))],
      // The tunnel tags a socket with sanitizeBridgeId(bridge_id): an id that is not its own slug would land on another id's socket.
      ['an id with a leading -', swap(1, '-alpha')],
      ['an id with --', swap(1, 'al--pha')],
      ['a 42-char key', swap(2, A.publicKey.slice(0, 42))],
      ['a 44-char key', swap(2, A.publicKey + 'A')],
      ['a non-canonical key', swap(2, nonCanonical)],
      ['a 12-digit ts', swap(3, '176200000000')],
      ['a 21-char nonce', swap(4, NONCE.slice(0, 21))],
      ['an 85-char sig', swap(5, good[5].slice(0, 85))],
    ])('%s', (_label, value) => {
      expect(parseProof(value)).toBeUndefined()
    })

    it.each(WEAK_HEX)('the weak key %s', (hex) => {
      expect(parseProof(swap(2, Buffer.from(hex, 'hex').toString('base64url')))).toBeUndefined()
    })

    it('a missing header', () => {
      expect(parseProof(null)).toBeUndefined()
      expect(parseProof(undefined)).toBeUndefined()
      expect(parseProof('')).toBeUndefined()
    })

    it('the non-canonical key is the same bytes as the good one', () => {
      expect(nonCanonical).not.toBe(A.publicKey)
      expect(Buffer.from(nonCanonical, 'base64url')).toEqual(Buffer.from(A.publicKey, 'base64url'))
    })
  })
})

describe('(c) verifyProof', () => {
  it('true for a good proof', async () => {
    expect(await verifyProof(parseProof(header())!, CTX)).toBe(true)
  })

  it.each([
    ['host', { ...CTX, host: '127.0.0.1:8788' }],
    ['method', { ...CTX, method: 'POST' }],
    ['path', { ...CTX, path: '/__tunnel/fabric-rpc/fabric/project/list' }],
    ['bodySha256', { ...CTX, bodySha256: 'f'.repeat(64) }],
  ])('false when the %s differs', async (_label, ctx) => {
    expect(await verifyProof(parseProof(header())!, ctx)).toBe(false)
  })

  it.each([
    ['id', { id: 'beta' }],
    ['key', { key: B.publicKey }],
    ['ts', { ts: TS + 1 }],
    ['nonce', { nonce: Buffer.alloc(16, 8).toString('base64url') }],
  ])('false when the %s differs', async (_label, change) => {
    expect(await verifyProof({ ...parseProof(header())!, ...change }, CTX)).toBe(false)
  })

  it.each(['tandem-envelope-v1', 'tandem-roster-v1'])('false for a signature by the same key over %s text from the same fields', async (tag) => {
    const text = proofText({ ...CTX, id: 'alpha', key: A.publicKey, ts: TS, nonce: NONCE }).replace(/^tandem-hub-proof-v1\n/, `${tag}\n`)
    const parsed = parseProof(header())!
    expect(await verifyProof({ ...parsed, sig: sig(A.privateKey, text) }, CTX)).toBe(false)
  })

  it('false, never a throw, for a signature by another key', async () => {
    expect(await verifyProof(parseProof(header({}, B.privateKey))!, CTX)).toBe(false)
  })
})

describe('(d) HubDevices.admit', () => {
  const n = (i: number) => Buffer.alloc(16, i).toString('base64url')

  it('bound, ok, replay, taken (row unchanged), unknown', () => {
    const { h, rows } = openDevices()
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('bound')
    expect(h.devices.admit('alpha', A.publicKey, n(2), true)).toBe('ok')
    expect(h.devices.admit('alpha', A.publicKey, n(2), true)).toBe('replay')
    const before = rows('SELECT id, key, bound_at FROM hub_devices')
    expect(h.devices.admit('alpha', B.publicKey, n(3), true)).toBe('taken')
    expect(rows('SELECT id, key, bound_at FROM hub_devices')).toEqual(before)
    expect(before).toEqual([{ id: 'alpha', key: A.publicKey, bound_at: T0 }])
    expect(rows('SELECT nonce FROM hub_device_nonces WHERE nonce = ?', n(3))).toEqual([])
    expect(h.devices.admit('beta', B.publicKey, n(4), false)).toBe('unknown')
    expect(rows('SELECT id FROM hub_devices WHERE id = ?', 'beta')).toEqual([])
  })

  it('the 101st id is full', () => {
    const { h, rows } = openDevices()
    for (let i = 0; i < 100; i++) expect(h.devices.admit(`m${i}`, A.publicKey, n(1), true)).toBe('bound')
    expect(h.devices.admit('m100', A.publicKey, n(1), true)).toBe('full')
    expect(rows('SELECT COUNT(*) AS c FROM hub_devices')).toEqual([{ c: 100 }])
    expect(h.devices.admit('m5', A.publicKey, n(2), true)).toBe('ok')
  })

  it('a nonce older than 600 s is pruned', () => {
    const { h, clock, rows } = openDevices()
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('bound')
    clock.now = T0 + 600_000
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('replay')
    clock.now = T0 + 600_001
    expect(h.devices.admit('alpha', A.publicKey, n(2), true)).toBe('ok')
    expect(rows('SELECT nonce FROM hub_device_nonces WHERE nonce = ?', n(1))).toEqual([])
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('ok')
  })

  it('bindings survive a restart on the same database file', () => {
    const { h, restart } = openDevices()
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('bound')
    restart()
    expect(h.devices.admit('alpha', B.publicKey, n(2), true)).toBe('taken')
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('replay')
    expect(h.devices.admit('alpha', A.publicKey, n(3), false)).toBe('ok')
  })
})

describe('audit rows (U-R1A-31B-1)', () => {
  const good = header().split(' ')
  const swap = (i: number, value: string) => good.map((part, j) => (j === i ? value : part)).join(' ')
  const n = (i: number) => Buffer.alloc(16, i).toString('base64url')
  // The same bytes with an unused low bit of the last character set (22 and 86 chars both leave some).
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const loose = (text: string) => text.slice(0, -1) + alphabet[alphabet.indexOf(text.at(-1)!) | 1]

  it.each([
    ['a 1 MB header', 'v1 ' + 'a'.repeat(1_048_576)],
    ['1 MB of spaces', ' '.repeat(1_048_576)],
    ['a tab between fields', good.join('\t')],
    ['a leading space', ' ' + good.join(' ')],
    ['a trailing space', good.join(' ') + ' '],
    ['a trailing newline', good.join(' ') + '\n'],
    ['an id ending in a newline', swap(1, 'alpha\n')],
    ['a full-width id', swap(1, 'ａlpha')],
    ['an id with a NUL', swap(1, 'al\u0000pha')],
    ['an id with a trailing -', swap(1, 'alpha-')],
    ['an id of dashes only', swap(1, '---')],
    ['a ts with a sign', swap(3, '+176200000000')],
    ['a ts in hex', swap(3, '0x19a3f1a2c00')],
    ['a nonce with padding', swap(4, NONCE.slice(0, 21) + '=')],
    ['a nonce in plain base64', swap(4, '+'.repeat(22))],
    ['a non-canonical nonce', swap(4, loose(Buffer.alloc(16, 0).toString('base64url')))],
    ['a non-canonical sig', swap(5, loose(Buffer.alloc(64, 0).toString('base64url')))],
  ])('parseProof refuses %s', (_label, value) => {
    expect(parseProof(value)).toBeUndefined()
  })

  it.each(WEAK_HEX)('parseProof refuses the weak key %s with its sign bit set', (hex) => {
    const bytes = Buffer.from(hex, 'hex')
    bytes[31] |= 0x80
    expect(parseProof(swap(2, bytes.toString('base64url')))).toBeUndefined()
  })

  it.each(['a'.repeat(64), 'a.', 'a..b', '_a', '.', 'default'])('parseProof keeps the id %s as it is (no folding into another id)', (id) => {
    expect(parseProof(header({ id }))?.id).toBe(id)
  })

  it('verifyProof is false for a signature over tandem-roster-offer-v1 text, and for a host that differs only in case', async () => {
    const parsed = parseProof(header())!
    const text = proofText({ ...CTX, id: 'alpha', key: A.publicKey, ts: TS, nonce: NONCE }).replace(/^tandem-hub-proof-v1\n/, 'tandem-roster-offer-v1\n')
    expect(await verifyProof({ ...parsed, sig: sig(A.privateKey, text) }, CTX)).toBe(false)
    const named = { ...CTX, host: 'hub.example' }
    expect(await verifyProof(parseProof(header({}, A.privateKey, named))!, named)).toBe(true)
    expect(await verifyProof(parseProof(header({}, A.privateKey, named))!, { ...named, host: 'HUB.example' })).toBe(false)
  })

  it('verifyProof never throws on fields parseProof would refuse', async () => {
    const parsed = parseProof(header())!
    expect(await verifyProof({ ...parsed, key: 'x' }, CTX)).toBe(false)
    expect(await verifyProof({ ...parsed, sig: '' }, CTX)).toBe(false)
    expect(await verifyProof({ ...parsed, key: Buffer.alloc(32, 0).toString('base64url') }, CTX)).toBe(false)
  })

  it('admit: ids that differ by a dot are separate; a nonce is per id; one key may hold two ids', () => {
    const { h, rows } = openDevices()
    expect(h.devices.admit('a', A.publicKey, n(1), true)).toBe('bound')
    expect(h.devices.admit('a.', B.publicKey, n(1), true)).toBe('bound')
    expect(h.devices.admit('a', B.publicKey, n(2), true)).toBe('taken')
    expect(h.devices.admit('a.', A.publicKey, n(2), true)).toBe('taken')
    expect(h.devices.admit('b', A.publicKey, n(1), true)).toBe('bound')
    expect(rows('SELECT id, key FROM hub_devices ORDER BY id')).toEqual([
      { id: 'a', key: A.publicKey }, { id: 'a.', key: B.publicKey }, { id: 'b', key: A.publicKey },
    ])
  })

  it('admit: refusals write nothing (taken, unknown, full, replay), so only the bound key grows the nonce table', () => {
    const { h, rows } = openDevices()
    for (let i = 0; i < 100; i++) h.devices.admit(`m${i}`, A.publicKey, n(1), true)
    const count = () => Number(rows('SELECT COUNT(*) AS c FROM hub_device_nonces')[0].c)
    expect(count()).toBe(100)
    for (let i = 2; i < 50; i++) {
      expect(h.devices.admit('m1', B.publicKey, n(i), true)).toBe('taken')
      expect(h.devices.admit('new', B.publicKey, n(i), true)).toBe('full')
      expect(h.devices.admit('new', B.publicKey, n(i), false)).toBe('unknown')
      expect(h.devices.admit('m1', A.publicKey, n(1), true)).toBe('replay')
    }
    expect(count()).toBe(100)
    expect(rows('SELECT COUNT(*) AS c FROM hub_devices')).toEqual([{ c: 100 }])
  })

  it('admit: a nonce is still refused at every instant its proof can still pass the ±300 s window', () => {
    // Worst case: ts = hub now + 300 s at first use, so the proof passes the window until first use + 600 s.
    const { h, clock } = openDevices()
    expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('bound')
    for (const later of [1, 299_999, 300_000, 599_999, 600_000]) {
      clock.now = T0 + later
      expect(h.devices.admit('alpha', A.publicKey, n(1), true)).toBe('replay')
    }
  })
})

describe('(31C-2) per-id proof limit', () => {
  // 1,201 distinct nonces: the (d) helper has only 256.
  const nn = (i: number) => {
    const b = Buffer.alloc(16, 9)
    b.writeUInt32BE(i, 0)
    return b.toString('base64url')
  }
  const LIMIT = 1200
  // Thousands of commits: no fsync per commit on these files, so a slow disk (a small Linux VM
  // right after npm ci) cannot stall a row; what is read back is the same.
  const fast = (rows: (query: string) => unknown) => rows('PRAGMA synchronous = OFF')

  it('1,200 admits of one id at one instant: ok; the 1,201st: slow, no row; another id ok; at +600,001 ms ok again', async () => {
    const mod = await import('../src/devices.ts')
    expect((mod as Record<string, unknown>).MAX_PROOFS_PER_ID).toBe(LIMIT)
    const { h, clock, rows } = openDevices()
    fast(rows)
    const count = (id: string) => Number(rows('SELECT COUNT(*) AS c FROM hub_device_nonces WHERE id = ?', id)[0].c)
    expect(h.devices.admit('alpha', A.publicKey, nn(0), true)).toBe('bound')
    for (let i = 1; i < LIMIT; i++) expect([i, h.devices.admit('alpha', A.publicKey, nn(i), true)]).toEqual([i, 'ok'])
    expect(count('alpha')).toBe(LIMIT)
    expect(h.devices.admit('alpha', A.publicKey, nn(LIMIT), true)).toBe('slow')
    expect(count('alpha')).toBe(LIMIT)
    expect(rows('SELECT nonce FROM hub_device_nonces WHERE nonce = ?', nn(LIMIT))).toEqual([])
    expect(h.devices.admit('beta', B.publicKey, nn(0), true)).toBe('bound')
    expect(h.devices.admit('beta', B.publicKey, nn(1), true)).toBe('ok')
    clock.now = T0 + 600_000
    expect(h.devices.admit('alpha', A.publicKey, nn(LIMIT + 1), true)).toBe('slow')
    clock.now = T0 + 600_001
    expect(h.devices.admit('alpha', A.publicKey, nn(LIMIT + 2), true)).toBe('ok')
    expect(count('alpha')).toBe(1)
  })

  it('with 1,200 rows a used nonce is still replay and another key still taken; a slow writes no row; the count survives a restart', () => {
    const file = join(dir, `d${++files}.sqlite`)
    const { h, restart, rows } = openDevices(file)
    fast(rows)
    const all = () => Number(rows('SELECT COUNT(*) AS c FROM hub_device_nonces')[0].c)
    for (let i = 0; i < LIMIT; i++) h.devices.admit('alpha', A.publicKey, nn(i), true)
    expect(all()).toBe(LIMIT)
    expect(h.devices.admit('alpha', A.publicKey, nn(5), true)).toBe('replay')
    expect(h.devices.admit('alpha', B.publicKey, nn(LIMIT + 5), true)).toBe('taken')
    for (let i = 0; i < 20; i++) expect(h.devices.admit('alpha', A.publicKey, nn(LIMIT + 10 + i), true)).toBe('slow')
    expect(all()).toBe(LIMIT)
    restart()
    expect(h.devices.admit('alpha', A.publicKey, nn(LIMIT + 50), true)).toBe('slow')
    expect(h.devices.admit('alpha', A.publicKey, nn(3), true)).toBe('replay')
    expect(all()).toBe(LIMIT)
  })
})
