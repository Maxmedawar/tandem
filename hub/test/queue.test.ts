/**
 * queue.test.ts — the hub's durable queue per receiving computer.
 *
 * Real SQLite (node:sqlite) on a file in a temp folder, wrapped to the shape of a
 * Durable Object's ctx.storage.sql, and a fake clock. A restart closes the file,
 * reopens it and builds a new HubQueue over it.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { HubQueue, MAX_BYTES, MAX_COPIES, TTL_MS } from '../src/queue.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-queue-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_700_000_000_000

/** A queue over a fresh database file, plus a way to restart it on the same file. */
function openQueue(file = join(dir, `q${++files}.sqlite`)) {
  const clock = { now: T0 }
  let db = new DatabaseSync(file)
  const sqlOf = (d: DatabaseSync) => ({
    exec(query: string, ...bindings: unknown[]) {
      const rows = d.prepare(query).all(...(bindings as SQLInputValue[]))
      return { toArray: () => rows as Record<string, unknown>[] }
    },
  })
  const q = { queue: new HubQueue(sqlOf(db), () => clock.now) }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    q.queue = new HubQueue(sqlOf(db), () => clock.now)
  }
  return { q, clock, restart }
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
    const mib = 1024 * 1024
    for (let i = 0; i < 9; i++) {
      expect(q.queue.put({ id: `a${i}`, from: 'S', to: ['A'], body: 'a'.repeat(mib) })[0]).toHaveProperty('seq')
    }
    // 'é' is 2 UTF-8 bytes: this body is 1 MiB of bytes in half as many characters.
    expect(q.queue.put({ id: 'e', from: 'S', to: ['A'], body: 'é'.repeat(mib / 2) })[0]).toEqual({ to: 'A', seq: 10 })
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
})
