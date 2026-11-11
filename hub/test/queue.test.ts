/**
 * queue.test.ts — the hub's durable queue per receiving computer.
 *
 * Real SQLite (node:sqlite) on a file in a temp folder, wrapped to the shape of a
 * Durable Object's ctx.storage.sql, and a fake clock. A restart closes the file,
 * reopens it and builds a new HubQueue over it. Writes run in BEGIN/COMMIT, with
 * ROLLBACK on a throw (ctx.storage.transactionSync in the Durable Object); `failOn`
 * makes one chosen statement throw, and `seen` lists every statement run.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { HubQueue, MAX_BYTES, MAX_COPIES, MAX_COPY_BYTES, TTL_MS, type QueuedCopy } from '../src/queue.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-queue-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_700_000_000_000

/** A queue over a fresh database file, plus a way to restart it on the same file. */
function openQueue(file = join(dir, `q${++files}.sqlite`)) {
  const clock = { now: T0 }
  const hooks: { failOn?: (query: string, bindings: unknown[]) => boolean } = {}
  const seen: string[] = []
  let db = new DatabaseSync(file)
  const sqlOf = (d: DatabaseSync) => ({
    exec(query: string, ...bindings: unknown[]) {
      seen.push(query)
      if (hooks.failOn?.(query, bindings)) throw new Error('injected failure')
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
  const q = { queue: new HubQueue(sqlOf(db), () => clock.now, txOf(db)) }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    q.queue = new HubQueue(sqlOf(db), () => clock.now, txOf(db))
  }
  /** Read the file directly, past the hooks. */
  const rows = (query: string, ...bindings: SQLInputValue[]) => db.prepare(query).all(...bindings) as Record<string, unknown>[]
  return { q, clock, restart, hooks, seen, rows }
}

/** UTF-8 bytes of a copy as `take` returns it, keys in QueuedCopy order. */
function copyBytes(c: QueuedCopy): number {
  const { id, from, room, room_seq, seq, kind, body } = c
  return Buffer.byteLength(JSON.stringify({ id, from, room, room_seq, seq, kind, body }), 'utf8')
}

/** copyBytes of the check copy `put` measures: both numbers at their widest. */
function checkBytes(id: string, from: string, room: string | undefined, body: string): number {
  return copyBytes({ id, from, room: room ?? null, room_seq: 2 ** 53 - 1, seq: 2 ** 53 - 1, kind: 'message', body })
}

describe('HubQueue', () => {
  it('limits are the plan values', () => {
    expect(MAX_COPIES).toBe(1000)
    expect(MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(TTL_MS).toBe(7 * 86_400_000)
  })

  it('put: an empty to throws, a name listed twice counts once, an id put again is a new copy', () => {
    const { q } = openQueue()
    expect(() => q.queue.put({ id: 'm0', from: 'S', to: [], body: 'x' })).toThrow()
    expect(q.queue.put({ id: 'm1', from: 'S', to: ['A', 'A'], body: 'x' })).toEqual([{ to: 'A', seq: 1 }])
    expect(q.queue.put({ id: 'm1', from: 'S', to: ['A'], body: 'x' })).toEqual([{ to: 'A', seq: 2 }])
    expect(q.queue.take('A').map((c) => [c.id, c.seq])).toEqual([['m1', 1], ['m1', 2]])
  })

  it('cap by count: 1,000 accepted, the 1,001st refused, another computer unaffected, ack frees it', () => {
    const { q } = openQueue()
    for (let i = 1; i <= MAX_COPIES; i++) {
      expect(q.queue.put({ id: `m${i}`, from: 'S', to: ['A'], body: 'x' })).toEqual([{ to: 'A', seq: i }])
    }
    expect(q.queue.put({ id: 'over', from: 'S', to: ['A', 'B'], body: 'x' })).toEqual([
      { to: 'A', error: 'queue_full' },
      { to: 'B', seq: 1 },
    ])
    expect(q.queue.take('A', MAX_COPIES - 1).map((c) => c.id)).toEqual([`m${MAX_COPIES}`])
    q.queue.ack('A', 1)
    expect(q.queue.put({ id: 'again', from: 'S', to: ['A'], body: 'x' })).toEqual([{ to: 'A', seq: MAX_COPIES + 1 }])
  })

  it('cap by bytes: copies totalling 10 MB (UTF-8) accepted, one more byte refused', () => {
    const { q } = openQueue()
    // Half-MiB bodies: a whole MiB no longer fits one copy (MAX_COPY_BYTES).
    const half = 512 * 1024
    for (let i = 0; i < 19; i++) {
      expect(q.queue.put({ id: `a${i}`, from: 'S', to: ['A'], body: 'a'.repeat(half) })[0]).toHaveProperty('seq')
    }
    // 'é' is 2 UTF-8 bytes: this body is half a MiB of bytes in half as many characters.
    expect(q.queue.put({ id: 'e', from: 'S', to: ['A'], body: 'é'.repeat(half / 2) })[0]).toEqual({ to: 'A', seq: 20 })
    expect(q.queue.put({ id: 'one', from: 'S', to: ['A', 'B'], body: 'x' })).toEqual([
      { to: 'A', error: 'queue_full' },
      { to: 'B', seq: 1 },
    ])
  })

  it('expiry: kept until 7 days, then gone with one expired receipt to the sender; a receipt never expires', () => {
    const { q, clock } = openQueue()
    q.queue.put({ id: 'm1', from: 'S', to: ['A'], room: 'r', body: 'hello' })
    q.queue.put({ id: 'own', from: 'X', to: ['S'], body: 'to S' })

    clock.now = T0 + TTL_MS - 1
    expect(q.queue.take('A').map((c) => c.id)).toEqual(['m1'])

    clock.now = T0 + TTL_MS + 1
    expect(q.queue.take('A')).toEqual([])
    const receipts = q.queue.take('S').filter((c) => c.kind === 'expired')
    expect(receipts).toEqual([
      { id: 'm1', from: 'A', room: null, room_seq: null, seq: 2, kind: 'expired', body: '' },
    ])
    // 'own' (to S, from X) expired too: its receipt went to X, not to S.
    expect(q.queue.take('X')).toEqual([
      { id: 'own', from: 'S', room: null, room_seq: null, seq: 1, kind: 'expired', body: '' },
    ])

    clock.now = T0 + 3 * TTL_MS
    q.queue.put({ id: 'later', from: 'S', to: ['B'], body: 'x' })
    expect(q.queue.take('A')).toEqual([])
    expect(q.queue.take('S')).toEqual(receipts)
  })

  it('restart: copies, the computer seq and the room seq survive a reopen', () => {
    const { q, restart } = openQueue()
    q.queue.put({ id: 'm1', from: 'S', to: ['A'], body: 'one' })
    q.queue.put({ id: 'm2', from: 'S', to: ['A'], body: 'two' })
    q.queue.put({ id: 'm3', from: 'S', to: ['A'], room: 'r', body: 'three' })
    restart()
    expect(q.queue.take('A')).toEqual([
      { id: 'm1', from: 'S', room: null, room_seq: null, seq: 1, kind: 'message', body: 'one' },
      { id: 'm2', from: 'S', room: null, room_seq: null, seq: 2, kind: 'message', body: 'two' },
      { id: 'm3', from: 'S', room: 'r', room_seq: 1, seq: 3, kind: 'message', body: 'three' },
    ])
    expect(q.queue.put({ id: 'm4', from: 'S', to: ['A'], body: 'four' })).toEqual([{ to: 'A', seq: 4 }])
    q.queue.put({ id: 'm5', from: 'S', to: ['A'], room: 'r', body: 'five' })
    expect(q.queue.take('A', 4)).toMatchObject([{ id: 'm5', seq: 5, room: 'r', room_seq: 2 }])
  })

  it('one order: 30 interleaved room messages from 3 senders read the same on every member', () => {
    const { q } = openQueue()
    const members = ['A', 'B', 'C']
    const sent: string[] = []
    for (let i = 0; i < 30; i++) {
      const id = `g${i}`
      sent.push(id)
      q.queue.put({ id, from: `S${i % 3}`, to: members, room: 'g', body: `body ${i}` })
    }
    const want = sent.map((id, i) => [id, i + 1])
    for (const m of members) {
      expect(q.queue.take(m).map((c) => [c.id, c.room_seq])).toEqual(want)
    }
  })

  it('a room seq is assigned once per message even when a copy is refused', () => {
    const { q } = openQueue()
    for (let i = 0; i < MAX_COPIES; i++) q.queue.put({ id: `f${i}`, from: 'S', to: ['A'], body: 'x' })
    expect(q.queue.put({ id: 'r1', from: 'S', to: ['A', 'B'], room: 'g', body: 'x' })).toEqual([
      { to: 'A', error: 'queue_full' },
      { to: 'B', seq: 1 },
    ])
    q.queue.put({ id: 'r2', from: 'S', to: ['B'], room: 'g', body: 'x' })
    expect(q.queue.take('B').map((c) => [c.id, c.room_seq])).toEqual([['r1', 1], ['r2', 2]])
  })

  it('seq is not reused after ack', () => {
    const { q } = openQueue()
    q.queue.put({ id: 'm1', from: 'S', to: ['A'], body: 'x' })
    q.queue.put({ id: 'm2', from: 'S', to: ['A'], body: 'x' })
    q.queue.ack('A', 2)
    expect(q.queue.take('A')).toEqual([])
    expect(q.queue.put({ id: 'm3', from: 'S', to: ['A'], body: 'x' })).toEqual([{ to: 'A', seq: 3 }])
  })

  it('one computer never takes or acks another computer\'s copies; names are bound, never SQL', () => {
    const { q } = openQueue()
    const evil = { id: "x'); DROP TABLE queue_copies;--", from: "S'--", room: "g'); DELETE FROM queue_copies;--" }
    const names = ["A' OR '1'='1", 'a', 'A ', 'A\u0000', 'B']
    q.queue.put({ id: 'a1', from: 'S', to: ['A'], body: 'x' })
    q.queue.put({ ...evil, to: names, body: 'y' })
    for (const other of names) {
      expect(q.queue.take(other).map((c) => [c.id, c.from, c.room, c.room_seq])).toEqual([[evil.id, evil.from, evil.room, 1]])
      q.queue.ack(other, 1e9)
      expect(q.queue.take(other)).toEqual([])
    }
    expect(q.queue.take('A').map((c) => c.id)).toEqual(['a1'])
  })

  it('33A: paging: five copies sized so exactly three fit MAX_COPY_BYTES come back as 3 then 2; maxBytes 1 returns one', () => {
    const { q } = openQueue()
    expect(MAX_COPY_BYTES).toBe(1_048_576 - 65_536)
    // Each copy as taken is exactly a third of MAX_COPY_BYTES: three sum to the limit, four go over.
    const third = Math.floor(MAX_COPY_BYTES / 3)
    for (let seq = 1; seq <= 5; seq++) {
      const id = `p${seq}`
      const empty = copyBytes({ id, from: 'S', room: null, room_seq: null, seq, kind: 'message', body: '' })
      const body = 'x'.repeat(third - empty)
      expect(copyBytes({ id, from: 'S', room: null, room_seq: null, seq, kind: 'message', body })).toBe(third)
      expect(q.queue.put({ id, from: 'S', to: ['A'], body })).toEqual([{ to: 'A', seq }])
    }
    const first = q.queue.take('A')
    expect(first.map((c) => c.seq)).toEqual([1, 2, 3])
    expect(first.reduce((n, c) => n + copyBytes(c), 0)).toBe(3 * third)
    expect(q.queue.take('A', first[2].seq).map((c) => c.seq)).toEqual([4, 5])
    expect(q.queue.take('A', 0, 100, 1).map((c) => c.seq)).toEqual([1])
  })

  it('33A: paging: a body whose check copy is exactly MAX_COPY_BYTES is accepted and taken alone ahead of a small copy', () => {
    const { q } = openQueue()
    const body = 'x'.repeat(MAX_COPY_BYTES - checkBytes('big', 'S', undefined, ''))
    expect(checkBytes('big', 'S', undefined, body)).toBe(MAX_COPY_BYTES)
    expect(q.queue.put({ id: 'big', from: 'S', to: ['A'], body })).toEqual([{ to: 'A', seq: 1 }])
    expect(q.queue.put({ id: 'small', from: 'S', to: ['A'], body: 'x' })).toEqual([{ to: 'A', seq: 2 }])
    const page = q.queue.take('A')
    expect(page.map((c) => c.id)).toEqual(['big'])
    expect(copyBytes(page[0])).toBeLessThanOrEqual(MAX_COPY_BYTES)
    expect(q.queue.take('A', 1).map((c) => c.id)).toEqual(['small'])
  })

  it('33A: copy size: one byte over MAX_COPY_BYTES throws, so do 200,000 \\u0001 (200 KB, 1.2 MB escaped); each next put gets the next unused seq', () => {
    const { q } = openQueue()
    expect(q.queue.put({ id: 'm1', from: 'S', to: ['A'], room: 'room-1', body: 'x' })).toEqual([{ to: 'A', seq: 1 }])

    // A room name longer than `null`: a check copy that left the room out would measure this one under the limit.
    const over = 'x'.repeat(MAX_COPY_BYTES + 1 - checkBytes('over', 'S', 'room-1', ''))
    expect(checkBytes('over', 'S', 'room-1', over)).toBe(MAX_COPY_BYTES + 1)
    expect(() => q.queue.put({ id: 'over', from: 'S', to: ['A'], room: 'room-1', body: over })).toThrow()
    expect(q.queue.take('A').map((c) => c.id)).toEqual(['m1'])
    expect(q.queue.put({ id: 'm2', from: 'S', to: ['A'], room: 'room-1', body: 'x' })).toEqual([{ to: 'A', seq: 2 }])

    const control = '\u0001'.repeat(200_000)
    expect(Buffer.byteLength(control, 'utf8')).toBe(200_000)
    expect(checkBytes('ctl', 'S', 'room-1', control)).toBeGreaterThan(1_200_000)
    expect(() => q.queue.put({ id: 'ctl', from: 'S', to: ['A'], room: 'room-1', body: control })).toThrow()
    expect(q.queue.take('A').map((c) => c.id)).toEqual(['m1', 'm2'])
    expect(q.queue.put({ id: 'm3', from: 'S', to: ['A'], room: 'room-1', body: 'x' })).toEqual([{ to: 'A', seq: 3 }])
    expect(q.queue.take('A').map((c) => [c.id, c.seq, c.room_seq])).toEqual([['m1', 1, 1], ['m2', 2, 2], ['m3', 3, 3]])
  })

  it('33A: well-formed: a lone surrogate in id, from, a to, room or body throws and writes nothing', () => {
    const { q, rows } = openQueue()
    const lone = 'a\uD800b'
    const good = { id: 'm', from: 'S', to: ['A', 'B'], room: 'r', body: 'x' }
    for (const bad of [
      { ...good, id: lone },
      { ...good, from: lone },
      { ...good, to: ['A', lone] },
      { ...good, room: lone },
      { ...good, body: lone },
      { ...good, body: 'x\uDFFF' },
    ]) {
      expect(() => q.queue.put(bad)).toThrow()
    }
    expect(rows('SELECT * FROM queue_copies')).toEqual([])
    expect(rows('SELECT * FROM queue_counters')).toEqual([])
    expect(q.queue.put(good)).toEqual([{ to: 'A', seq: 1 }, { to: 'B', seq: 1 }])
  })

  it('33A: all or nothing: a room put to [A, B] whose second copy INSERT throws leaves nothing; the next gets seq 1 and room_seq 1', () => {
    const { q, hooks, rows } = openQueue()
    let inserts = 0
    hooks.failOn = (query) => query.startsWith('INSERT INTO queue_copies') && ++inserts === 2
    expect(() => q.queue.put({ id: 'g1', from: 'S', to: ['A', 'B'], room: 'g', body: 'x' })).toThrow(/injected/)
    expect(inserts).toBe(2)
    hooks.failOn = undefined
    expect(rows('SELECT * FROM queue_copies')).toEqual([])
    expect(q.queue.put({ id: 'g2', from: 'S', to: ['A', 'B'], room: 'g', body: 'x' })).toEqual([
      { to: 'A', seq: 1 },
      { to: 'B', seq: 1 },
    ])
    for (const m of ['A', 'B']) {
      expect(q.queue.take(m).map((c) => [c.id, c.seq, c.room_seq])).toEqual([['g2', 1, 1]])
    }
  })

  it('33A: all or nothing: a take past TTL_MS whose receipt INSERT throws keeps the old message copy and writes no receipt', () => {
    const { q, clock, hooks, rows } = openQueue()
    q.queue.put({ id: 'm1', from: 'S', to: ['A'], body: 'x' })
    clock.now = T0 + TTL_MS + 1
    hooks.failOn = (query, bindings) => query.startsWith('INSERT INTO queue_copies') && bindings.includes('expired')
    expect(() => q.queue.take('A')).toThrow(/injected/)
    hooks.failOn = undefined
    expect(rows('SELECT to_id, seq, id, kind FROM queue_copies')).toEqual([{ to_id: 'A', seq: 1, id: 'm1', kind: 'message' }])
    // Once the INSERT works, expiry runs in full and the receipt gets S's first number.
    expect(q.queue.take('A')).toEqual([])
    expect(q.queue.take('S')).toEqual([{ id: 'm1', from: 'A', room: null, room_seq: null, seq: 1, kind: 'expired', body: '' }])
  })

  it('33A: index: EXPLAIN QUERY PLAN of the expiry select names the (kind, queued_at) index', () => {
    const { q, seen, rows } = openQueue()
    q.queue.take('A')
    const select = seen.find((s) => s.startsWith('SELECT') && s.includes("WHERE kind = 'message' AND queued_at < ?"))
    expect(select).toBeDefined()
    const plan = rows(`EXPLAIN QUERY PLAN ${select}`, T0).map((r) => String(r.detail))
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX queue_copies_kind_queued_at \(kind=\? AND queued_at<\?\)/)
  })
})
