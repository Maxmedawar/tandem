/**
 * presence-store.test.ts — the hub's latest presence envelope per (sender, receiver).
 *
 * Real SQLite (node:sqlite) on a file in a temp folder, wrapped to the shape of a Durable
 * Object's ctx.storage.sql, and a fake clock, as queue.test.ts does. Writes run in
 * BEGIN/COMMIT with ROLLBACK on a throw (ctx.storage.transactionSync in the Durable Object);
 * `failOn` makes one chosen statement throw. A restart closes the file and reopens it.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { PresenceStore, PRESENCE_TTL_MS, MAX_PRESENCE_BYTES } from '../src/presence-store.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-presence-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const T0 = 1_700_000_000_000

function openStore(file = join(dir, `p${++files}.sqlite`)) {
  const clock = { now: T0 }
  const hooks: { failOn?: (query: string, bindings: unknown[]) => boolean } = {}
  let db = new DatabaseSync(file)
  const sqlOf = (d: DatabaseSync) => ({
    exec(query: string, ...bindings: unknown[]) {
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
  const s = { store: new PresenceStore(sqlOf(db), () => clock.now, txOf(db)) }
  const restart = () => {
    db.close()
    db = new DatabaseSync(file)
    s.store = new PresenceStore(sqlOf(db), () => clock.now, txOf(db))
  }
  const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM hub_presence').get() as { n: number }).n)
  return { s, clock, hooks, restart, count }
}

describe('(33B-1) PresenceStore', () => {
  it('(33B-1) limits are the brief values', () => {
    expect(PRESENCE_TTL_MS).toBe(86_400_000)
    expect(MAX_PRESENCE_BYTES).toBe(16_384)
  })

  it('(33B-1) (p1) a->b A1 then A2: one row A2 with the second at', () => {
    const { s, clock } = openStore()
    s.store.put('a', [{ to: 'b', envelope: 'A1' }])
    clock.now = T0 + 5
    s.store.put('a', [{ to: 'b', envelope: 'A2' }])
    expect(s.store.for('b')).toEqual([{ from: 'a', envelope: 'A2', at: T0 + 5 }])
  })

  it('(33B-1) (p2) rows to c stay out of for(b); three senders come back sorted by from', () => {
    const { s } = openStore()
    s.store.put('z', [{ to: 'b', envelope: 'Z' }, { to: 'c', envelope: 'Zc' }])
    s.store.put('a', [{ to: 'b', envelope: 'A' }])
    s.store.put('m', [{ to: 'c', envelope: 'Mc' }, { to: 'b', envelope: 'M' }])
    expect(s.store.for('b')).toEqual([
      { from: 'a', envelope: 'A', at: T0 },
      { from: 'm', envelope: 'M', at: T0 },
      { from: 'z', envelope: 'Z', at: T0 },
    ])
    expect(s.store.for('c').map((r) => r.from)).toEqual(['m', 'z'])
  })

  it('(33B-1) (p3) a row older than PRESENCE_TTL_MS is gone after the next put, a younger one stays', () => {
    const { s, clock } = openStore()
    s.store.put('old', [{ to: 'b', envelope: 'O' }])
    clock.now = T0 + 10
    s.store.put('young', [{ to: 'b', envelope: 'Y' }])
    clock.now = T0 + PRESENCE_TTL_MS + 5
    s.store.put('x', [{ to: 'q', envelope: 'X' }])
    expect(s.store.for('b')).toEqual([{ from: 'young', envelope: 'Y', at: T0 + 10 }])
  })

  it('(33B-1) (p4) all or nothing: a throw on the second item INSERT leaves the rows from before', () => {
    const { s, hooks } = openStore()
    s.store.put('a', [{ to: 'b', envelope: 'A1' }])
    let inserts = 0
    hooks.failOn = (query) => /^\s*INSERT/i.test(query) && ++inserts === 2
    expect(() => s.store.put('c', [{ to: 'b', envelope: 'C1' }, { to: 'd', envelope: 'C2' }])).toThrow()
    hooks.failOn = undefined
    expect(s.store.for('b')).toEqual([{ from: 'a', envelope: 'A1', at: T0 }])
    expect(s.store.for('d')).toEqual([])
  })

  it('(33B-1) (p5) a reopen of the same file keeps the rows', () => {
    const { s, restart } = openStore()
    s.store.put('a', [{ to: 'b', envelope: 'A1' }])
    restart()
    expect(s.store.for('b')).toEqual([{ from: 'a', envelope: 'A1', at: T0 }])
  })

  it('(33B-1) (p6) put(from, []) writes nothing', () => {
    const { s, count } = openStore()
    s.store.put('a', [])
    expect(count()).toBe(0)
    expect(s.store.for('a')).toEqual([])
  })
})
