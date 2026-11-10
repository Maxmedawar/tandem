import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalVectorStore, sqliteVecAvailable, type VectorBackend } from '../../bridge/fabric/memory/vector-store'
import { SQLiteFabricClient } from '../../bridge/fabric/sqlite-fabric-client'

const directories = new Set<string>()
const dbPath = () => { const dir = mkdtempSync(join(tmpdir(), 'fabric-vec-')); chmodSync(dir, 0o700); directories.add(dir); return join(dir, 'fabric.sqlite3') }
afterEach(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); directories.clear() })

/** A schema-current database with no memories, so only the store under test writes vectors. */
function database(path = dbPath()) {
  new SQLiteFabricClient({ databasePath: path }).close()
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  // Extension loading must be permitted here exactly as the production client
  // permits it, or every backend-parameterized case silently tests the fallback.
  return new DatabaseSync(path, { allowExtension: true })
}

const vector = [1, 0, 0, 0, 0, 0, 0, 0]
const tieFilter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: false }

// The packaged fallback and the native backend are one contract with two
// implementations; every partition and scoring case runs against both so they
// cannot drift. `sqlite-vec` is an optional dependency, so it is skipped rather
// than failed when the native binary is absent on the host.
const backends: VectorBackend[] = ['sqlite-blob-fallback', ...(sqliteVecAvailable() ? ['sqlite-vec' as const] : [])]

describe.each(backends)('local vector store retrieval partition (%s)', backend => {
  const store = (db: import('node:sqlite').DatabaseSync) => createLocalVectorStore(db, 8, { backend })

  it('reports the backend it was explicitly asked for', () => {
    const db = database()
    expect(store(db).backend).toBe(backend)
    db.close()
  })

  it('applies owner, scope, and supersession partitioning inside top-k rather than after it', () => {
    // Every row is equally near the query, so anything the partition fails to
    // exclude will crowd out the one record the caller may actually see.
    const db = database()
    const subject = store(db)
    subject.upsert('m-visible', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-1', agentId: null })
    subject.upsert('m-other-project', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-2', agentId: null })
    subject.upsert('m-other-owner', vector, { ownerId: 'owner-b', scope: 'project', projectId: 'project-1', agentId: null })
    subject.upsert('m-other-agent', vector, { ownerId: 'owner-a', scope: 'agent', projectId: 'project-1', agentId: 'agent-b' })
    subject.upsert('m-user', vector, { ownerId: 'owner-a', scope: 'user', projectId: null, agentId: null })
    subject.upsert('m-superseded', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-1', agentId: null })
    subject.markSuperseded('m-superseded')

    const filter = { ownerId: 'owner-a', projectId: 'project-1', agentId: 'agent-a', canReadUser: false }
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual(['m-visible'])
    expect([...subject.nearest(vector, 1, filter).keys()]).toEqual(['m-visible'])
    db.close()
  })

  it('breaks a top-k tie on identifier, whatever order the corpus was written in', () => {
    // Similarity alone does not order candidates. When more rows tie at the
    // top-k boundary than the cutoff admits, the survivors must be chosen by
    // one rule every time — otherwise the same corpus answers the same query
    // differently in another process, and differently from itself once the
    // corpus is re-derived. Both backends had that defect and neither expressed
    // it in SQL: the packaged store kept an arbitrary tied element at its heap
    // root, and vec0 returns whichever tied rows its chunk layout reaches first.
    const ids = ['v-0', 'v-1', 'v-2', 'v-3', 'v-4', 'v-5', 'v-6', 'v-7']
    const topThree = (order: readonly string[]) => {
      const db = database()
      const subject = store(db)
      for (const id of order) subject.upsert(id, vector, { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
      const nearest = [...subject.nearest(vector, 3, tieFilter).keys()]
      db.close()
      return nearest
    }
    expect(topThree(ids)).toEqual(['v-0', 'v-1', 'v-2'])
    expect(topThree([...ids].reverse())).toEqual(['v-0', 'v-1', 'v-2'])
  })

  it('drops candidates below the caller admission floor instead of ranking them', () => {
    // The engine rejects everything under its orthogonality floor, so retrieving
    // those rows only buys the cost of ordering them — and on a sparse embedding
    // the exactly-orthogonal block is most of a corpus and the largest tie in it.
    const db = database()
    const subject = store(db)
    subject.upsert('m-aligned', vector, { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
    for (let i = 0; i < 6; i++) {
      subject.upsert(`m-orthogonal-${i}`, [0, 1, 0, 0, 0, 0, 0, 0], { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
    }
    expect([...subject.nearest(vector, 10, tieFilter).keys()]).toHaveLength(7)
    expect([...subject.nearest(vector, 10, tieFilter, .1).keys()]).toEqual(['m-aligned'])
    db.close()
  })

  it('answers a tie the same way after the corpus is re-derived from the durable mirror', () => {
    const path = dbPath()
    const db = database(path)
    const writer = store(db)
    for (const id of ['v-7', 'v-6', 'v-5', 'v-4', 'v-3', 'v-2', 'v-1', 'v-0']) {
      writer.upsert(id, vector, { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
    }
    const settled = [...writer.nearest(vector, 3, tieFilter).keys()]
    db.close()

    const reopened = database(path)
    const reloaded = [...store(reopened).nearest(vector, 3, tieFilter).keys()]
    reopened.close()
    expect(reloaded).toEqual(settled)
  })

  it('includes owner-readable user memory only when the caller may read it', () => {
    const db = database()
    const subject = store(db)
    subject.upsert('m-user', vector, { ownerId: 'owner-a', scope: 'user', projectId: null, agentId: null })
    expect([...subject.nearest(vector, 10, { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: false }).keys()]).toEqual([])
    expect([...subject.nearest(vector, 10, { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }).keys()]).toEqual(['m-user'])
    db.close()
  })

  it('honours an explicit scope filter and agent/project binding', () => {
    const db = database()
    const subject = store(db)
    subject.upsert('m-project', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-1', agentId: null })
    subject.upsert('m-agent', vector, { ownerId: 'owner-a', scope: 'agent', projectId: 'project-1', agentId: 'agent-a' })
    subject.upsert('m-agent-global', vector, { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
    const inProject = { ownerId: 'owner-a', projectId: 'project-1', agentId: 'agent-a', canReadUser: false }
    expect([...subject.nearest(vector, 10, { ...inProject, scope: 'agent' }).keys()]).toEqual(['m-agent'])
    expect([...subject.nearest(vector, 10, { ...inProject, scope: 'project' }).keys()]).toEqual(['m-project'])
    expect([...subject.nearest(vector, 10, { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: false }).keys()]).toEqual(['m-agent-global'])
    db.close()
  })

  it('reloads partitioning from durable rows after reopening the database', () => {
    const path = dbPath()
    let db = database(path)
    let subject = store(db)
    subject.upsert('m-visible', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-1', agentId: null })
    subject.upsert('m-superseded', vector, { ownerId: 'owner-a', scope: 'project', projectId: 'project-1', agentId: null })
    subject.markSuperseded('m-superseded')
    db.close()

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    db = new DatabaseSync(path, { allowExtension: true })
    subject = store(db)
    expect([...subject.nearest(vector, 10, { ownerId: 'owner-a', projectId: 'project-1', agentId: 'agent-a', canReadUser: false }).keys()]).toEqual(['m-visible'])
    db.close()
  })

  it('answers from the durable mirror after another connection commits', () => {
    // `memory_vectors` is the durable authority and any index over it is
    // derived. A second bridge process, or an overlapping restart, writes
    // through its own connection; a construction-time snapshot that is never
    // revisited loses those rows silently and permanently.
    const path = dbPath()
    const db = database(path)
    const subject = store(db)
    const filter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual([])

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const otherConnection = new DatabaseSync(path, { allowExtension: true })
    store(otherConnection).upsert('m-elsewhere', vector, { ownerId: 'owner-a', scope: 'user', projectId: null, agentId: null })
    otherConnection.close()

    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual(['m-elsewhere'])
    db.close()
  })

  it('keeps its view consistent with the mirror when a write transaction rolls back', () => {
    // Derived rows are written inside the memory transaction. A COMMIT that
    // never happens must not leave the retrieval view diverged from the
    // authority for the rest of the process lifetime.
    const db = database()
    const subject = store(db)
    const tag = { ownerId: 'owner-a', scope: 'user' as const, projectId: null, agentId: null }
    const filter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }
    subject.upsert('m-kept', vector, tag)

    db.exec('BEGIN IMMEDIATE')
    subject.upsert('m-rolled-back', vector, tag)
    subject.markSuperseded('m-kept')
    db.exec('ROLLBACK')
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual(['m-kept'])

    db.exec('BEGIN IMMEDIATE')
    subject.remove('m-kept')
    db.exec('ROLLBACK')
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual(['m-kept'])
    db.close()
  })

  it('removes a vector without reading its row id back out of the database', () => {
    // The native backend keys its vector rows by a 63-bit derived row id. Any
    // implementation that reads that id back as a JavaScript number throws
    // above Number.MAX_SAFE_INTEGER, which would fail every delete.
    const db = database()
    const subject = store(db)
    const filter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }
    subject.upsert('m-doomed', vector, { ownerId: 'owner-a', scope: 'user', projectId: null, agentId: null })
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual(['m-doomed'])
    subject.remove('m-doomed')
    expect([...subject.nearest(vector, 10, filter).keys()]).toEqual([])
    expect(subject.read(['m-doomed']).size).toBe(0)
    db.close()
  })

  it('scores by cosine similarity rather than raw dot product', () => {
    // A provider is only required to be deterministic and offline, not to emit
    // unit vectors. Scoring an unnormalized vector by dot product inflates it
    // with its own magnitude, which is not comparable against the engine's
    // cosine-calibrated admission floor.
    const db = database()
    const subject = store(db)
    const filter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }
    const tag = { ownerId: 'owner-a', scope: 'user' as const, projectId: null, agentId: null }
    subject.upsert('m-aligned-small', [1, 0, 0, 0, 0, 0, 0, 0], tag)
    subject.upsert('m-askew-large', [6, 8, 0, 0, 0, 0, 0, 0], tag)

    const scores = subject.nearest([2, 0, 0, 0, 0, 0, 0, 0], 10, filter)
    // Perfectly aligned regardless of magnitude.
    expect(scores.get('m-aligned-small')).toBeCloseTo(1, 5)
    // cos = 6/10 — a dot product would have scored this 12 and ranked it first.
    expect(scores.get('m-askew-large')).toBeCloseTo(.6, 5)
    expect([...scores.keys()]).toEqual(['m-aligned-small', 'm-askew-large'])
    db.close()
  })
})

describe('local vector store backend equivalence', () => {
  it.runIf(sqliteVecAvailable())('ranks an unnormalized corpus identically on both backends', () => {
    const corpus = Array.from({ length: 40 }, (_, i) => ({
      id: `m-${String(i).padStart(2, '0')}`,
      // Deliberately unnormalized and varied in magnitude, so any dot-product
      // scoring diverges from cosine scoring.
      vector: [Math.sin(i) * (i + 1), Math.cos(i) * (i + 1), (i % 7) - 3, i % 5, 0, 0, 0, 0],
    }))
    const query = [1, .5, -.25, .75, 0, 0, 0, 0]
    const filter = { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }

    const ranked = (backend: VectorBackend) => {
      const db = database()
      const subject = createLocalVectorStore(db, 8, { backend })
      for (const entry of corpus) subject.upsert(entry.id, entry.vector, { ownerId: 'owner-a', scope: 'user', projectId: null, agentId: null })
      const result = [...subject.nearest(query, 10, filter)].map(([id, score]) => [id, Number(score.toFixed(5))])
      db.close()
      return result
    }

    expect(ranked('sqlite-vec')).toEqual(ranked('sqlite-blob-fallback'))
  })

  it.runIf(sqliteVecAvailable())('selects the same members of a tied block on both backends', () => {
    // A tie straddling the cutoff is where the two backends were free to select
    // different records at identical scores — the one divergence the shared
    // contract could not see, because every other case has a unique answer.
    const corpus = Array.from({ length: 24 }, (_, i) => `v-${String(i).padStart(2, '0')}`)
    const selected = (backend: VectorBackend) => {
      const db = database()
      const subject = createLocalVectorStore(db, 8, { backend })
      for (const id of [...corpus].reverse()) subject.upsert(id, vector, { ownerId: 'owner-a', scope: 'agent', projectId: null, agentId: 'agent-a' })
      const result = [...subject.nearest(vector, 5, tieFilter).keys()]
      db.close()
      return result
    }
    expect(selected('sqlite-vec')).toEqual(selected('sqlite-blob-fallback'))
    expect(selected('sqlite-blob-fallback')).toEqual(['v-00', 'v-01', 'v-02', 'v-03', 'v-04'])
  })

  it.runIf(sqliteVecAvailable())('rebuilds a native index that has drifted from the durable mirror', () => {
    // `memory_vectors` is the authority and the vec0 index is derived from it.
    // An index that is present but stale would answer from a partial corpus,
    // which reads as "no such memory" rather than as an error.
    const path = dbPath()
    let db = database(path)
    createLocalVectorStore(db, 8, { backend: 'sqlite-vec' })
    db.prepare('INSERT INTO memory_vectors(memory_id, embedding, owner_id, scope, project_id, agent_id, superseded) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run('m-direct', new Uint8Array(new Float32Array(vector).buffer), 'owner-a', 'user', null, null)
    db.close()

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    db = new DatabaseSync(path, { allowExtension: true })
    const reopened = createLocalVectorStore(db, 8, { backend: 'sqlite-vec' })
    expect([...reopened.nearest(vector, 10, { ownerId: 'owner-a', agentId: 'agent-a', canReadUser: true }).keys()]).toEqual(['m-direct'])
    db.close()
  })

  it('refuses an explicit sqlite-vec request when the native extension cannot load', () => {
    // Silently degrading would let a benchmark or a test claim it measured the
    // native backend while actually measuring the packaged fallback.
    const db = database()
    if (sqliteVecAvailable()) expect(createLocalVectorStore(db, 8, { backend: 'sqlite-vec' }).backend).toBe('sqlite-vec')
    else expect(() => createLocalVectorStore(db, 8, { backend: 'sqlite-vec' })).toThrow()
    db.close()
  })
})
