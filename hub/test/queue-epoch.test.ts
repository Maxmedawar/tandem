/**
 * queue-epoch.test.ts — U-R1A-33B-4: the hub queue's epoch (hub/src/queue.ts).
 *
 * The epoch is 16 random bytes as base64url (22 characters) kept in `queue_meta` beside the queue's
 * counters: it changes only when that storage is new. A take that names the store's epoch acks as
 * before; one that names '' or another epoch deletes nothing and is answered from seq 0 with the
 * store's epoch; one with no epoch answers exactly as before. Real SQLite (node:sqlite) on a file in
 * a temp folder, wrapped to the shape of ctx.storage.sql, a fake clock, and a restart that reopens
 * the same file, as queue.test.ts runs it; q6 runs the real TunnelDO in local workerd.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import * as queueModule from '../src/queue.ts'
import { HubQueue } from '../src/queue.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const q = queueModule as Json

const dir = mkdtempSync(join(tmpdir(), 'r1a33b4-hub-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_700_000_000_000
const EPOCH = /^[A-Za-z0-9_-]{22}$/

function openQueue(file = join(dir, `q${++files}.sqlite`)) {
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
  const h = { queue: new HubQueue(sqlOf(db), () => clock.now, txOf(db)) as Json }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    h.queue = new HubQueue(sqlOf(db), () => clock.now, txOf(db))
  }
  const rows = (query: string) => db.prepare(query).all() as Record<string, unknown>[]
  return { h, restart, rows, file }
}

/** Three copies to A, seq 1..3. */
function three(h: { queue: Json }) {
  for (const id of ['m1', 'm2', 'm3']) h.queue.put({ id, from: 'S', to: ['A'], body: id })
}
const seqs = (copies: { seq: number }[]) => copies.map((c) => c.seq)

describe('(33B-4) the hub queue epoch', () => {
  it('(33B-4) q1 the epoch is 22 base64url characters; the same after a restart on one file; different on a fresh file', () => {
    const one = openQueue()
    const e1 = one.h.queue.epoch
    expect(e1).toMatch(EPOCH)
    one.restart()
    expect(one.h.queue.epoch).toBe(e1)
    // A second HubQueue over the same file (a Durable Object restart) reads the stored one.
    const twin = openQueue(one.file)
    expect(twin.h.queue.epoch).toBe(e1)
    const other = openQueue()
    expect(other.h.queue.epoch).toMatch(EPOCH)
    expect(other.h.queue.epoch).not.toBe(e1)
    expect(one.rows("SELECT k, v FROM queue_meta")).toEqual([{ k: 'epoch', v: e1 }])
  })

  it('(33B-4) q2 takeFor with the matching epoch deletes up to ack and returns the copies after it with the epoch', () => {
    const { h, rows } = openQueue()
    three(h)
    const E = h.queue.epoch
    expect(h.queue.takeFor('A', 2, E)).toEqual({ copies: [expect.objectContaining({ id: 'm3', seq: 3 })], epoch: E })
    expect(rows('SELECT seq FROM queue_copies ORDER BY seq')).toEqual([{ seq: 3 }])
  })

  it('(33B-4) q3 with \'\' and with another epoch: nothing is deleted and the answer is from seq 0 with the store\'s epoch', () => {
    const { h, rows } = openQueue()
    three(h)
    const E = h.queue.epoch
    const first = h.queue.takeFor('A', 2, '')
    expect(first.epoch).toBe(E)
    expect(seqs(first.copies)).toEqual([1, 2, 3])
    const other = 'x'.repeat(22)
    const second = h.queue.takeFor('A', 3, other)
    expect(second.epoch).toBe(E)
    expect(seqs(second.copies)).toEqual([1, 2, 3])
    expect(rows('SELECT seq FROM queue_copies ORDER BY seq')).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }])
    expect(seqs(h.queue.take('A', 0))).toEqual([1, 2, 3])
  })

  it('(33B-4) q4 (pin) with no epoch: the answer is exactly { copies } and acks as ack then take', () => {
    const { h, rows } = openQueue()
    three(h)
    const twin = openQueue()
    three(twin.h)
    twin.h.queue.ack('A', 1)
    const base = twin.h.queue.take('A', 1)
    const got = h.queue.takeFor('A', 1)
    expect(Object.keys(got)).toEqual(['copies'])
    expect(got).toEqual({ copies: base })
    expect(JSON.stringify(got)).toBe(JSON.stringify({ copies: base }))
    expect(rows('SELECT seq FROM queue_copies ORDER BY seq')).toEqual([{ seq: 2 }, { seq: 3 }])
  })

  it('(33B-4) q5 takeRequest takes { ack } or { ack, epoch } exactly', () => {
    const E = 'A'.repeat(21) + '_'
    expect(q.takeRequest({ ack: 1 })).toEqual({ ack: 1 })
    expect(q.takeRequest({ ack: 0, epoch: '' })).toEqual({ ack: 0, epoch: '' })
    expect(q.takeRequest({ ack: 1, epoch: E })).toEqual({ ack: 1, epoch: E })
    const refused: [string, unknown][] = [
      ['a short epoch', { ack: 1, epoch: 'short' }],
      ['a number epoch', { ack: 1, epoch: 5 }],
      ['an extra key', { ack: 1, epoch: E, x: 1 }],
      ['ack -1', { ack: -1 }],
      ['ack 1.5', { ack: 1.5 }],
      ['ack as text', { ack: '1' }],
      ['no ack', { epoch: '' }],
      ['null', null],
      ['an array', []],
      ['an own __proto__ key', JSON.parse('{"__proto__": 1, "ack": 1}')],
      ['a 23-character epoch', { ack: 1, epoch: E + 'A' }],
      ['an epoch with +', { ack: 1, epoch: 'A'.repeat(21) + '+' }],
    ]
    for (const [what, value] of refused) expect([what, q.takeRequest(value)]).toEqual([what, undefined])
  })

  it('(33B-4) q6 the real TunnelDO in workerd: epoch-less takes answer { copies } only; \'\' returns the epoch; the epoch acks; a wrong one deletes nothing', async () => {
    const { unstable_startWorker } = await import('wrangler')
    const doDir = join(dir, 'workerd')
    mkdirSync(doDir)
    const tunnelDo = fileURLToPath(new URL('../src/tunnel-do.ts', import.meta.url))
    writeFileSync(join(doDir, 'entry.ts'), `import { TunnelDO } from ${JSON.stringify(tunnelDo)}
export { TunnelDO }
export default {
  async fetch(req: Request, env: { TUNNEL: DurableObjectNamespace<TunnelDO> }): Promise<Response> {
    const d = env.TUNNEL.get(env.TUNNEL.idFromName('queue'))
    const b = await req.json() as any
    try {
      const path = new URL(req.url).pathname
      if (path === '/roster') return Response.json(await d.rosterPut(b.id, b.key, 0, b.text))
      if (path === '/put') return Response.json(await d.queuePut(b))
      return Response.json(await d.mailTake(b.id, b.key, b.ack, b.epoch))
    } catch (e) {
      return Response.json({ thrown: String(e) })
    }
  },
}
`)
    writeFileSync(join(doDir, 'wrangler.json'), JSON.stringify({
      name: 'hub-queue-epoch-test', main: 'entry.ts', compatibility_date: '2025-01-01', compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'TUNNEL', class_name: 'TunnelDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['TunnelDO'] }],
    }))
    // A roster of one computer `a`, its root signed by its own key (hub/test/roster-store.test.ts shape).
    const pair = generateKeyPairSync('ed25519')
    const pub = pair.publicKey.export({ format: 'jwk' }).x as string
    const head = { seq: 0, id: 'a', key: pub, signer: pub, ts: T0, prev: '0'.repeat(64) }
    const text = `tandem-roster-v1\n${head.seq}\n${head.prev}\n${head.id}\n${head.key}\n${head.signer}\n${head.ts}`
    const root = { ...head, sig: sign(null, Buffer.from(text, 'utf8'), pair.privateKey).toString('base64url') }
    const worker = await unstable_startWorker({
      config: join(doDir, 'wrangler.json'),
      dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, persist: false },
    })
    try {
      const call = async (path: string, body: unknown) => (await worker.fetch(`http://hub${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<Json>
      expect(await call('/roster', { id: 'a', key: pub, text: JSON.stringify({ v: 1, entries: [root] }) })).toMatchObject({ answer: 'ok', len: 1 })
      for (const id of ['m1', 'm2']) expect(await call('/put', { id, from: 'S', to: ['a'], body: id })).toEqual([{ to: 'a', seq: id === 'm1' ? 1 : 2 }])
      const take = (ack: number, epoch?: string) => call('/take', { id: 'a', key: pub, ack, ...(epoch === undefined ? {} : { epoch }) })
      for (let k = 0; k < 2; k++) {
        const plain = await take(0)
        expect(plain.status).toBe(200)
        expect(Object.keys(plain.body)).toEqual(['copies'])
        expect(seqs(plain.body.copies)).toEqual([1, 2])
      }
      const named = await take(1, '')
      const E = named.body.epoch
      expect(E).toMatch(EPOCH)
      expect(seqs(named.body.copies)).toEqual([1, 2])
      const acked = await take(1, E)
      expect(acked.body).toEqual({ copies: [expect.objectContaining({ id: 'm2', seq: 2 })], epoch: E })
      const wrong = await take(2, E === 'x'.repeat(22) ? 'y'.repeat(22) : 'x'.repeat(22))
      expect(wrong.body.epoch).toBe(E)
      expect(seqs(wrong.body.copies)).toEqual([2])
      expect(seqs((await take(0)).body.copies)).toEqual([2])
    } finally {
      await worker.dispose()
    }
  }, 120_000)
})
