import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'

export type VectorBackend = 'sqlite-vec' | 'sqlite-blob-fallback'

export type VectorScope = 'user' | 'project' | 'agent'

/** Retrieval partition of the memory a vector was derived from, stored beside it. */
export interface VectorRowTag {
  readonly ownerId: string
  readonly scope: VectorScope
  readonly projectId: string | null
  readonly agentId: string | null
}

/**
 * Mirrors the authorization and current-record predicate the memory authority
 * applies in SQL. Retrieval must partition *before* the top-k cutoff, or hidden
 * rows crowd out visible ones; carrying the partition on the vector row keeps
 * that exact without enumerating the corpus on every query. The SQL predicate
 * remains the authority — this is a retrieval filter, not the access decision.
 */
export interface VectorPartitionFilter {
  readonly ownerId: string
  readonly scope?: VectorScope
  readonly projectId?: string | undefined
  readonly agentId: string
  readonly canReadUser: boolean
}

export interface LocalVectorStore {
  readonly backend: VectorBackend
  upsert(id: string, vector: readonly number[], tag: VectorRowTag): void
  markSuperseded(id: string): void
  remove(id: string): void
  read(ids: readonly string[]): ReadonlyMap<string, ArrayLike<number>>
  /**
   * `minScore` is the caller's admission floor. Candidates below it are dropped
   * rather than returned, because a caller that discards them anyway should not
   * pay to have ties among them resolved: on a sparse embedding most of a corpus
   * scores exactly zero against a given query, and that block is both the largest
   * tie there is and the one that can never be admitted.
   */
  nearest(vector: readonly number[], limit: number, partition?: VectorPartitionFilter, minScore?: number): ReadonlyMap<string, number>
}

export interface LocalVectorStoreOptions {
  /**
   * Force a backend. An explicit `sqlite-vec` request throws when the native
   * extension cannot load, so a benchmark or test can never quietly report the
   * packaged fallback's numbers as the native backend's.
   */
  readonly backend?: VectorBackend
}

interface StoredPartition {
  readonly ownerId: string
  readonly scope: string
  readonly projectId: string | null
  readonly agentId: string | null
  superseded: boolean
}

function admits(partition: StoredPartition, filter: VectorPartitionFilter): boolean {
  if (partition.superseded || partition.ownerId !== filter.ownerId) return false
  if (filter.scope !== undefined && partition.scope !== filter.scope) return false
  if (partition.scope === 'user') return filter.canReadUser
  // A caller outside a project matches no project-scoped row, exactly as
  // `m.project_id = NULL` yields no rows in SQL.
  if (partition.scope === 'project') return filter.projectId !== undefined && partition.projectId === filter.projectId
  return partition.agentId === filter.agentId && partition.projectId === (filter.projectId ?? null)
}

function partitionFrom(row: { owner_id?: string | null; scope?: string | null; project_id?: string | null; agent_id?: string | null; superseded?: number | null }): StoredPartition | undefined {
  // Derived rows predating the partition columns are unusable for retrieval and
  // are rebuilt by migration; refusing them fails closed rather than leaking.
  if (typeof row.owner_id !== 'string' || typeof row.scope !== 'string') return undefined
  return {
    ownerId: row.owner_id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    agentId: row.agent_id ?? null,
    superseded: Number(row.superseded ?? 0) !== 0,
  }
}

/**
 * `admits` as a conjunction per scope, which is what vec0 metadata filtering can
 * express. The union of each eligible scope's top-k contains the global top-k
 * over their union, so merging per-scope queries stays exact.
 */
function eligiblePartitions(filter: VectorPartitionFilter): { scope: VectorScope; projectId?: string; agentId?: string }[] {
  const all: { scope: VectorScope; projectId?: string; agentId?: string }[] = []
  if (filter.canReadUser) all.push({ scope: 'user' })
  if (filter.projectId !== undefined) all.push({ scope: 'project', projectId: filter.projectId })
  all.push({ scope: 'agent', agentId: filter.agentId, projectId: filter.projectId ?? NULL_SENTINEL })
  return filter.scope === undefined ? all : all.filter(entry => entry.scope === filter.scope)
}

/** vec0 metadata columns reject NULL, so absent project/agent bindings take a sentinel no real id can equal. */
const NULL_SENTINEL = ''

let cachedAvailability: boolean | undefined

function loadSqliteVec(database: DatabaseSync): void {
  const require = createRequire(import.meta.url)
  const sqliteVec = require('sqlite-vec') as { load?: (database: DatabaseSync) => void }
  if (typeof sqliteVec.load !== 'function') throw new Error('sqlite-vec is unavailable')
  sqliteVec.load(database)
}

/**
 * Whether the pinned optional native extension can actually load on this host.
 * Probed once against a throwaway database so callers can branch without
 * guessing from the mere presence of the package.
 */
export function sqliteVecAvailable(): boolean {
  if (cachedAvailability !== undefined) return cachedAvailability
  let probe: DatabaseSync | undefined
  try {
    const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    probe = new Database(':memory:', { allowExtension: true })
    loadSqliteVec(probe)
    probe.exec('CREATE VIRTUAL TABLE probe USING vec0(embedding float[4] distance_metric=cosine)')
    cachedAvailability = true
  } catch {
    cachedAvailability = false
  } finally {
    try { probe?.close() } catch { /* best effort */ }
  }
  return cachedAvailability
}

/**
 * The packaged RAM-resident scan is the default. sqlite-vec 0.1.x has no
 * approximate index — vec0 is an exhaustive scan over SQLite pages — so at the
 * benchmarked 100k corpus it measured ~10x slower for search than scanning
 * float32 vectors already in memory, and it cannot be selected by accident
 * merely because the optional native package happens to be installed. It stays
 * available by name for hosts that would rather not hold the corpus in the JS
 * heap; see docs/adr/0003-phase-2-local-hybrid-memory.md.
 */
export function createLocalVectorStore(database: DatabaseSync, dimensions: number, options?: LocalVectorStoreOptions): LocalVectorStore {
  if (options?.backend !== 'sqlite-vec') return new BlobVectorStore(database)
  // sqlite-vec stays entirely inside this private bridge module. An explicit
  // request never degrades silently, so a benchmark cannot report the packaged
  // store's numbers under the native backend's name.
  loadSqliteVec(database)
  return new SqliteVecStore(database, dimensions)
}

interface CachedVector { readonly vector: Float32Array; readonly norm: number; readonly partition: StoredPartition }

const VECTOR_ROW_COLUMNS = 'SELECT memory_id, embedding, owner_id, scope, project_id, agent_id, superseded FROM memory_vectors'

// A type literal, not an interface: `all()` returns an index-signature row type
// that only a literal is assignable from without a double cast.
type VectorRow = {
  memory_id: string
  embedding: Uint8Array
  owner_id: string | null
  scope: string | null
  project_id: string | null
  agent_id: string | null
  superseded: number | null
}

/** Ids re-read per statement when settling this connection's own committed writes. */
const SETTLE_BATCH_SIZE = 256
/** Beyond this, re-reading the affected ids one batch at a time costs more than one full reload. */
const SETTLE_RELOAD_THRESHOLD = 2_048

/**
 * `memory_vectors` is the durable authority; the resident scan holds a copy of
 * it. That copy is therefore never the record of what was written: it is
 * populated from committed rows only, and re-derived whenever it can no longer
 * prove it matches the mirror. See docs/adr/0003-phase-2-local-hybrid-memory.md.
 */
class BlobVectorStore implements LocalVectorStore {
  readonly backend = 'sqlite-blob-fallback' as const
  private readonly database: DatabaseSync
  private vectors = new Map<string, CachedVector>()
  private observedVersion = -1
  /** Ids this connection wrote whose durable state the cache has not read back yet. */
  private readonly unsettled = new Set<string>()
  /** The cache was filled while a transaction was open, so it may hold rows COMMIT never accepted. */
  private provisional = false
  constructor(database: DatabaseSync) {
    this.database = database
    // Loaded at construction rather than on first search, so the corpus
    // residency this backend trades latency for is paid — and benchmarked — at
    // open instead of inside one search sample.
    this.reload()
  }
  upsert(id: string, vector: readonly number[], tag: VectorRowTag): void {
    this.database.prepare('INSERT OR REPLACE INTO memory_vectors(memory_id, embedding, owner_id, scope, project_id, agent_id, superseded) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(id, encode(vector), tag.ownerId, tag.scope, tag.projectId, tag.agentId)
    this.wrote(id)
  }
  markSuperseded(id: string): void {
    this.database.prepare('UPDATE memory_vectors SET superseded = 1 WHERE memory_id = ?').run(id)
    this.wrote(id)
  }
  remove(id: string): void { this.database.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id); this.wrote(id) }
  read(ids: readonly string[]): ReadonlyMap<string, ArrayLike<number>> {
    if (ids.length === 0) return new Map()
    const rows = this.database.prepare(`SELECT memory_id, embedding FROM memory_vectors WHERE memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { memory_id: string; embedding: Uint8Array }[]
    return new Map(rows.map(row => [row.memory_id, decode(row.embedding)]))
  }

  /**
   * A write becomes visible to retrieval only once COMMIT has made it durable,
   * and what becomes visible is what the mirror holds rather than what the
   * caller passed. A rolled-back transaction therefore restores the previous
   * state instead of leaving the cache diverged for the life of the process.
   */
  private wrote(id: string): void {
    this.unsettled.add(id)
    this.settle()
  }

  private settle(): void {
    const vectors = this.vectors
    if (this.unsettled.size === 0 || this.database.isTransaction) return
    if (this.unsettled.size > SETTLE_RELOAD_THRESHOLD) { this.reload(); return }
    const ids = [...this.unsettled]
    this.unsettled.clear()
    for (let at = 0; at < ids.length; at += SETTLE_BATCH_SIZE) {
      const batch = ids.slice(at, at + SETTLE_BATCH_SIZE)
      const rows = this.database.prepare(`${VECTOR_ROW_COLUMNS} WHERE memory_id IN (${batch.map(() => '?').join(',')})`).all(...batch) as VectorRow[]
      // Absent from the mirror, or present without a usable partition, both mean
      // the row is not a retrieval candidate.
      for (const id of batch) vectors.delete(id)
      for (const row of rows) this.admit(vectors, row)
    }
  }

  private admit(vectors: Map<string, CachedVector>, row: VectorRow): void {
    const partition = partitionFrom(row)
    if (!partition) return
    const vector = decode(row.embedding)
    vectors.set(row.memory_id, { vector, norm: magnitude(vector), partition })
  }

  private reload(): void {
    // Read the version *before* the rows: a foreign commit landing between the
    // two then shows up as a version the cache has not seen, which reloads
    // again. Reading it afterwards would record a version the rows predate and
    // lose that commit permanently.
    const version = this.dataVersion()
    const vectors = new Map<string, CachedVector>()
    for (const row of this.database.prepare(VECTOR_ROW_COLUMNS).iterate() as Iterable<VectorRow>) this.admit(vectors, row)
    this.vectors = vectors
    this.observedVersion = version
    this.unsettled.clear()
    // Inside an open transaction this read can see rows COMMIT has not accepted,
    // so the snapshot is retaken once that transaction has ended.
    this.provisional = this.database.isTransaction
  }

  /**
   * SQLite bumps `data_version` when *another* connection commits to this file
   * and leaves it alone for this connection's own writes — exactly the case a
   * construction-time snapshot could never notice. A second bridge process, or
   * an overlapping restart, would otherwise be permanently invisible here.
   */
  private dataVersion(): number {
    return Number((this.database.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  }

  private current(): ReadonlyMap<string, CachedVector> {
    if (this.dataVersion() !== this.observedVersion || (this.provisional && !this.database.isTransaction)) this.reload()
    else this.settle()
    return this.vectors
  }

  nearest(vector: readonly number[], limit: number, partition?: VectorPartitionFilter, minScore?: number): ReadonlyMap<string, number> {
    // Cosine, not raw dot product: a provider is only required to be offline and
    // deterministic, so an unnormalized vector must not score itself up by its
    // own magnitude against the engine's cosine-calibrated admission floor.
    const queryNorm = magnitude(vector)
    const floor = minScore ?? -Infinity
    const ranked: Ranked[] = []
    for (const [id, entry] of this.current()) {
      if (partition && !admits(entry.partition, partition)) continue
      const stored = entry.vector
      let dot = 0
      for (let i = 0; i < stored.length; i++) dot += vector[i]! * stored[i]!
      const value = { id, score: queryNorm && entry.norm ? dot / (queryNorm * entry.norm) : 0 }
      if (value.score < floor) continue
      if (ranked.length < limit) {
        ranked.push(value)
        siftUp(ranked, ranked.length - 1)
      } else if (better(value, ranked[0]!)) {
        ranked[0] = value
        siftDown(ranked, 0)
      }
    }
    ranked.sort((a, b) => better(a, b) ? -1 : 1)
    return new Map(ranked.slice(0, limit).map(value => [value.id, value.score]))
  }
}

interface Ranked { readonly id: string; readonly score: number }

/**
 * The total order retrieval is ranked by: stronger similarity first, ties broken
 * toward the lexicographically smaller id. Score alone is not a total order, and
 * a heap that compares score alone leaves an arbitrary one of the tied elements
 * at its root — so which candidate was evicted at the top-k boundary depended on
 * the order rows happened to enter the resident copy. That order differs between
 * a full reload and incremental settling, which made the same corpus answer the
 * same query differently after a restart or after another connection committed.
 * Ids are unique, so this is a strict order and every comparison below is exact.
 */
function better(a: Ranked, b: Ranked): boolean {
  return a.score > b.score || (a.score === b.score && a.id < b.id)
}

/** Min-heap under `better`: the root is the weakest candidate held so far. */
function siftUp(heap: Ranked[], index: number): void {
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!better(heap[parent]!, heap[index]!)) return
    ;[heap[parent], heap[index]] = [heap[index]!, heap[parent]!]
    index = parent
  }
}

function siftDown(heap: Ranked[], index: number): void {
  for (;;) {
    const left = index * 2 + 1
    if (left >= heap.length) return
    const right = left + 1
    const child = right < heap.length && better(heap[left]!, heap[right]!) ? right : left
    if (!better(heap[index]!, heap[child]!)) return
    ;[heap[index], heap[child]] = [heap[child]!, heap[index]!]
    index = child
  }
}

/**
 * Native backend. The retrieval partition lives on the vec0 row as a partition
 * key plus metadata columns, so authorization and current-record filtering are
 * applied by the extension *before* its top-k cutoff rather than by enumerating
 * the corpus in JavaScript afterwards. `memory_vectors` remains the durable
 * mirror used to rebuild the index and to hydrate stored vectors.
 */
class SqliteVecStore implements LocalVectorStore {
  readonly backend = 'sqlite-vec' as const
  private readonly database: DatabaseSync
  constructor(database: DatabaseSync, dimensions: number) {
    this.database = database
    this.ensureIndex(dimensions)
  }

  private ensureIndex(dimensions: number): void {
    const definition = vecTableDefinition(dimensions)
    const existing = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vec'").get() as { sql?: string } | undefined
    // An index built for different dimensions or by an older layout cannot be
    // queried correctly, so it is rebuilt from the durable mirror rather than
    // read as if it matched.
    const usable = existing?.sql !== undefined && normalizeSql(existing.sql) === normalizeSql(definition)
    if (usable && this.indexMatchesMirror()) return
    // A savepoint keeps the whole rebuild atomic and, far more importantly, out
    // of one-fsync-per-row territory: under `synchronous = FULL` an unbatched
    // 100k-row rebuild took minutes.
    this.database.exec('SAVEPOINT vector_index_rebuild')
    try {
      if (existing !== undefined) this.database.exec('DROP TABLE memory_vec')
      this.database.exec(definition)
      const insert = this.database.prepare('INSERT INTO memory_vec(rowid, owner_id, embedding, memory_id, scope, project_id, agent_id, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      const rows = this.database.prepare('SELECT memory_id, embedding, owner_id, scope, project_id, agent_id, superseded FROM memory_vectors')
        .iterate() as Iterable<{ memory_id: string; embedding: Uint8Array; owner_id: string | null; scope: string | null; project_id: string | null; agent_id: string | null; superseded: number | null }>
      for (const row of rows) {
        const partition = partitionFrom(row)
        if (!partition) continue
        // The table was just created, so no pre-delete is needed per row.
        insert.run(stableRowId(row.memory_id), partition.ownerId, row.embedding, row.memory_id, partition.scope,
          partition.projectId ?? NULL_SENTINEL, partition.agentId ?? NULL_SENTINEL, partition.superseded ? 1n : 0n)
      }
      this.database.exec('RELEASE vector_index_rebuild')
    } catch (error) {
      this.database.exec('ROLLBACK TO vector_index_rebuild')
      this.database.exec('RELEASE vector_index_rebuild')
      throw error
    }
  }

  /**
   * `memory_vectors` is the durable authority; the vec0 index is derived. If the
   * two ever disagree the index would silently answer with a stale or partial
   * corpus, so a mismatch rebuilds instead of being trusted.
   */
  private indexMatchesMirror(): boolean {
    try {
      const indexed = this.database.prepare('SELECT count(*) AS n FROM memory_vec').get() as { n: number }
      const mirrored = this.database.prepare('SELECT count(*) AS n FROM memory_vectors WHERE owner_id IS NOT NULL AND scope IS NOT NULL').get() as { n: number }
      return Number(indexed.n) === Number(mirrored.n)
    } catch {
      return false
    }
  }

  private insertVectorRow(id: string, embedding: Uint8Array, partition: { ownerId: string; scope: string; projectId: string | null; agentId: string | null }, superseded: boolean): void {
    const rowid = stableRowId(id)
    this.database.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(rowid)
    this.database.prepare('INSERT INTO memory_vec(rowid, owner_id, embedding, memory_id, scope, project_id, agent_id, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rowid, partition.ownerId, embedding, id, partition.scope, partition.projectId ?? NULL_SENTINEL, partition.agentId ?? NULL_SENTINEL, superseded ? 1n : 0n)
  }

  upsert(id: string, vector: readonly number[], tag: VectorRowTag): void {
    const embedding = encode(vector)
    this.database.prepare('INSERT OR REPLACE INTO memory_vectors(memory_id, embedding, vec_rowid, owner_id, scope, project_id, agent_id, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(id, embedding, stableRowId(id), tag.ownerId, tag.scope, tag.projectId, tag.agentId)
    this.insertVectorRow(id, embedding, tag, false)
  }

  markSuperseded(id: string): void {
    this.database.prepare('UPDATE memory_vectors SET superseded = 1 WHERE memory_id = ?').run(id)
    this.database.prepare('UPDATE memory_vec SET superseded = 1 WHERE rowid = ?').run(stableRowId(id))
  }

  remove(id: string): void {
    // The row id is derived from the memory id, so it is recomputed rather than
    // read back: node:sqlite refuses to return a 63-bit integer as a JavaScript
    // number, which would make every delete fail.
    this.database.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(stableRowId(id))
    this.database.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
  }

  read(ids: readonly string[]): ReadonlyMap<string, ArrayLike<number>> {
    if (ids.length === 0) return new Map()
    const rows = this.database.prepare(`SELECT memory_id, embedding FROM memory_vectors WHERE memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { memory_id: string; embedding: Uint8Array }[]
    return new Map(rows.map(row => [row.memory_id, decode(row.embedding)]))
  }

  nearest(vector: readonly number[], limit: number, partition?: VectorPartitionFilter, minScore?: number): ReadonlyMap<string, number> {
    if (limit <= 0) return new Map()
    const embedding = encode(vector)
    // vec0 ranks on cosine *distance*, so the caller's similarity floor is the
    // distance ceiling past which nothing can be admitted.
    const maxDistance = minScore === undefined ? Infinity : 1 - minScore
    const ranked = new Map<string, number>()
    for (const eligible of partition ? eligiblePartitions(partition) : [undefined]) {
      const where = ['superseded = 0']
      const bindings: (string | Uint8Array | bigint)[] = []
      if (partition) {
        where.unshift('owner_id = ?')
        bindings.push(partition.ownerId)
        where.push('scope = ?')
        bindings.push(eligible!.scope)
        if (eligible!.projectId !== undefined) { where.push('project_id = ?'); bindings.push(eligible!.projectId) }
        if (eligible!.agentId !== undefined) { where.push('agent_id = ?'); bindings.push(eligible!.agentId) }
      }
      const statement = this.database.prepare(`
        SELECT memory_id, distance FROM memory_vec
        WHERE ${where.join(' AND ')} AND embedding MATCH ? AND k = ?
      `)
      const query = (k: number) => statement.all(...bindings, embedding, BigInt(k)) as { memory_id: string; distance: number }[]
      // One row past the cutoff is the tie sentinel: it costs nothing on a scan
      // that was already running and proves whether the k-th distance continues
      // past the boundary. While it does, unreturned rows may tie with the
      // boundary too, and which of those vec0 hands back follows its own chunk
      // layout — which insertion order and an index rebuild both change. Widening
      // until the boundary distance is exhausted captures every tied candidate,
      // so the identifier rule below, not the physical layout, decides.
      let k = limit + 1
      let rows = query(k)
      // Widening stops once the boundary falls past the admission ceiling: a tie
      // nobody can be admitted from is not worth resolving, and on a sparse
      // embedding the block of exactly-orthogonal rows is most of the corpus.
      while (rows.length === k && k < MAX_TIE_WIDENING
        && rows[limit - 1]!.distance <= maxDistance
        && rows[k - 1]!.distance <= rows[limit - 1]!.distance) {
        k = Math.min(k * 2, MAX_TIE_WIDENING)
        rows = query(k)
      }
      // vec0 reports cosine *distance*; the engine ranks on similarity.
      for (const row of rows) if (row.distance <= maxDistance) ranked.set(row.memory_id, 1 - row.distance)
    }
    return new Map([...ranked]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => better(a, b) ? -1 : 1)
      .slice(0, limit)
      .map(value => [value.id, value.score]))
  }
}

/**
 * Ceiling on tie widening. Reached only when this many rows share one distance
 * at the cutoff, where the surviving order is still the identifier rule applied
 * to everything retrieved — bounded, rather than an unbounded scan of a corpus
 * of identical vectors.
 */
const MAX_TIE_WIDENING = 4_096

function vecTableDefinition(dimensions: number): string {
  return `CREATE VIRTUAL TABLE memory_vec USING vec0(owner_id text partition key, embedding float[${dimensions}] distance_metric=cosine, memory_id text, scope text, project_id text, agent_id text, superseded integer)`
}

function normalizeSql(sql: string): string { return sql.replace(/\s+/g, ' ').trim().toLowerCase() }

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, aa = 0, bb = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

function magnitude(vector: ArrayLike<number>): number {
  let total = 0
  for (let i = 0; i < vector.length; i++) total += vector[i]! ** 2
  return Math.sqrt(total)
}

function encode(vector: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(vector).buffer) }
function decode(bytes: Uint8Array): Float32Array {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Float32Array(copy)
}

/**
 * vec0 keys rows by integer row id, so the memory id is hashed to a stable
 * 63-bit value. Deriving it means deletes and updates never have to read it
 * back. Collision odds at the benchmarked 100k corpus are on the order of
 * 1e-10; the durable mirror in `memory_vectors` remains the authority.
 */
function stableRowId(id: string): bigint {
  const digest = createHash('sha256').update(id).digest()
  return BigInt.asUintN(63, digest.readBigUInt64LE(0)) || 1n
}
