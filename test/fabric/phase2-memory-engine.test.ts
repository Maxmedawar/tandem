import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../../src/fabric/capabilities'
import { DEFAULT_MEMORY_SEARCH_LIMIT, MAX_MEMORY_SEARCH_LIMIT, type FabricCapability } from '../../src/fabric/types'
import { DeterministicEmbeddingProvider, type EmbeddingProvider } from '../../bridge/fabric/memory/embedding'
import { sqliteVecAvailable, type VectorBackend } from '../../bridge/fabric/memory/vector-store'
import { SQLiteFabricClient } from '../../bridge/fabric/sqlite-fabric-client'

const capabilities: FabricCapability[] = ['project:create', 'project:members', 'project:read', 'memory:write', 'memory:read', 'memory:delete']
const directories = new Set<string>()
const dbPath = () => { const dir = mkdtempSync(join(tmpdir(), 'fabric-p2-')); chmodSync(dir, 0o700); directories.add(dir); return join(dir, 'fabric.sqlite3') }
afterEach(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); directories.clear(); vi.restoreAllMocks() })

async function fixture(now = () => Date.UTC(2026, 7, 13)) {
  const client = new SQLiteFabricClient({ databasePath: dbPath(), now })
  const root = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
  const project = await client.createProject(root, { displayName: 'Phase 2 corpus', memberAgentIds: ['agent-b'] })
  const ctx = createCallerContext({ ownerId: root.ownerId, deviceId: root.deviceId, agentId: root.agentId, actorType: root.actorType, capabilities, projectId: project.projectId })
  return { client, ctx }
}

describe('Phase 2 production memory engine', () => {
  it('always merges semantic candidates even when visible lexical results fill the requested limit', async () => {
    const path = dbPath()
    const provider = new TestEmbeddingProvider('hybrid-regression-v1', 8, text =>
      text.includes('semantic-target') || text.includes('vehicle fuel') ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])
    const client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider })
    const root = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    for (let i = 0; i < 5; i++) await client.remember(root, { scope: 'agent', kind: 'fact', text: `vehicle lexical decoy ${i}`, importance: 0 })
    const target = await client.remember(root, { scope: 'agent', kind: 'fact', text: 'semantic-target', importance: 1 })
    const result = await client.searchMemory(root, { query: 'vehicle fuel', limit: 5 })
    expect(result.records.map(record => record.id)).toContain(target.id)
    client.close()
  })

  it('admits the nearest semantic neighbour even when its absolute cosine is modest', async () => {
    // Absolute cosine is not comparable across queries on a feature-hash
    // embedding: a measured true paraphrase scores .23 while pure noise can
    // score .30. A fixed cutoff therefore drops real answers. The nearest
    // eligible neighbour must survive as a candidate.
    const provider = new TestEmbeddingProvider('modest-cosine-v1', 8, text =>
      text === 'car fuel' ? [1, 0, 0, 0, 0, 0, 0, 0]
        : text.includes('gasoline') ? unit(.23) : unit(.05))
    const client = new SQLiteFabricClient({ databasePath: dbPath(), embeddingProvider: provider })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    for (let i = 0; i < 40; i++) await client.remember(ctx, { scope: 'agent', kind: 'fact', text: `unrelated ledger entry ${i}`, importance: .5 })
    const target = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'The service van requires premium gasoline', importance: .3 })
    const result = await client.searchMemory(ctx, { query: 'car fuel', limit: 5 })
    expect(result.records.map(record => record.id)).toContain(target.id)
    client.close()
  })

  it('bounds semantic-only admissions so an unanswerable query cannot return a page of noise', async () => {
    const provider = new TestEmbeddingProvider('noise-budget-v1', 8, text => text === 'xylophone repair' ? [1, 0, 0, 0, 0, 0, 0, 0] : unit(.5))
    const client = new SQLiteFabricClient({ databasePath: dbPath(), embeddingProvider: provider })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    for (let i = 0; i < 30; i++) await client.remember(ctx, { scope: 'agent', kind: 'fact', text: `archive shard entry ${i}`, importance: .5 })
    expect((await client.searchMemory(ctx, { query: 'xylophone repair', limit: 20 })).records.length).toBeLessThanOrEqual(5)
    client.close()
  })

  it('excludes effectively orthogonal records from semantic-only admission', async () => {
    const provider = new TestEmbeddingProvider('orthogonal-v1', 8, text => text === 'helicopter rotor' ? [1, 0, 0, 0, 0, 0, 0, 0] : unit(.02))
    const client = new SQLiteFabricClient({ databasePath: dbPath(), embeddingProvider: provider })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    for (let i = 0; i < 10; i++) await client.remember(ctx, { scope: 'agent', kind: 'fact', text: `archive shard entry ${i}`, importance: .5 })
    expect((await client.searchMemory(ctx, { query: 'helicopter rotor' })).records).toEqual([])
    client.close()
  })

  it('applies visibility and current-record constraints before lexical and vector top-k cutoffs', async () => {
    const path = dbPath()
    const provider = new TestEmbeddingProvider('partitioned-top-k-v1', 8, () => [1, 0, 0, 0, 0, 0, 0, 0])
    let client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider })
    const ownerA = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    const visible = await client.remember(ownerA, { scope: 'agent', kind: 'fact', text: `crowding sentinel ${'padding '.repeat(80)}`, importance: 1 })
    client.close()

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(path)
    const insertMemory = db.prepare(`INSERT INTO memories
      (id, owner_id, scope, project_id, agent_id, kind, text, importance, created_at, updated_at, source_type)
      VALUES (?, 'owner-b', 'agent', NULL, 'agent-b', 'fact', ?, 1, ?, ?, 'agent')`)
    const insertFts = db.prepare('INSERT INTO memory_fts(memory_id, text) VALUES (?, ?)')
    // Tagged as real writes would be, so the hidden rows genuinely compete for
    // top-k instead of being discarded as unpartitioned derived rows.
    const insertVector = db.prepare(`INSERT INTO memory_vectors(memory_id, embedding, owner_id, scope, project_id, agent_id, superseded)
      VALUES (?, ?, 'owner-b', 'agent', NULL, 'agent-b', 0)`)
    const vector = new Uint8Array(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]).buffer)
    const timestamp = new Date(Date.UTC(2026, 7, 13)).toISOString()
    for (let i = 0; i < 520; i++) {
      const id = `hidden-${i}`
      const text = `crowding crowding crowding sentinel sentinel ${i}`
      insertMemory.run(id, text, timestamp, timestamp)
      insertFts.run(id, text)
      insertVector.run(id, vector)
    }
    db.close()

    client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider })
    expect((await client.searchMemory(ownerA, { query: 'crowding sentinel', limit: 5 })).records.map(record => record.id)).toContain(visible.id)
    client.close()
  })

  it('orders stronger FTS5 BM25 matches ahead of weaker lexical matches', async () => {
    const path = dbPath()
    const provider = new TestEmbeddingProvider('bm25-ranking-v1', 8, () => [1, 0, 0, 0, 0, 0, 0, 0])
    const client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    const strong = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'atlas atlas atlas migration', importance: .5 })
    await client.remember(ctx, { scope: 'agent', kind: 'fact', text: `atlas ${'filler '.repeat(80)}migration`, importance: .5 })
    expect((await client.searchMemory(ctx, { query: 'atlas migration', limit: 2 })).records[0]?.id).toBe(strong.id)
    client.close()
  })

  it('fails closed when persisted vectors belong to a different embedding provider or dimensions', async () => {
    const path = dbPath()
    const providerA = new TestEmbeddingProvider('provider-a-v1', 8, () => [1, 0, 0, 0, 0, 0, 0, 0])
    const client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: providerA })
    client.close()
    expect(() => new SQLiteFabricClient({
      databasePath: path,
      embeddingProvider: new TestEmbeddingProvider('provider-b-v1', 8, () => [1, 0, 0, 0, 0, 0, 0, 0]),
    })).toThrow('fabric storage is unavailable')
    expect(() => new SQLiteFabricClient({
      databasePath: path,
      embeddingProvider: new TestEmbeddingProvider('provider-a-v1', 9, () => [1, 0, 0, 0, 0, 0, 0, 0, 0]),
    })).toThrow('fabric storage is unavailable')
  })

  it('deduplicates normalized text across the complete scope, beyond the former 256-row window', async () => {
    let clock = Date.UTC(2026, 7, 13)
    const { client, ctx } = await fixture(() => clock++)
    const original = await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'Complete dedup sentinel.', importance: .2 })
    for (let i = 0; i < 300; i++) await client.remember(ctx, { scope: 'project', kind: 'fact', text: `newer distinct memory ${i}`, importance: .5 })
    const duplicate = await client.remember(ctx, { scope: 'project', kind: 'fact', text: ' complete  DEDUP sentinel ', importance: .9 })
    expect(duplicate.id).toBe(original.id)
    client.close()
  })

  it('uses deterministic offline embeddings with semantic neighborhood and no I/O', async () => {
    const provider = new DeterministicEmbeddingProvider()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const [a, b, c] = await provider.embed(['The automobile needs fuel', 'A car requires gasoline', 'Bake sourdough bread'])
    expect(provider.id).toBe('tandem-hash-embedding-v1')
    expect(a).toEqual((await provider.embed(['The automobile needs fuel']))[0])
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ranks lexical, vector, and hybrid signals deterministically', async () => {
    const { client, ctx } = await fixture()
    await client.remember(ctx, { scope: 'project', kind: 'procedure', text: 'Rotate the database encryption key every Friday', importance: .7 })
    await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'The automobile requires premium gasoline', importance: .8 })
    await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'The bakery closes at six', importance: .9 })
    expect((await client.searchMemory(ctx, { query: 'encryption key' })).records[0]?.text).toContain('encryption key')
    expect((await client.searchMemory(ctx, { query: 'car fuel' })).records[0]?.text).toContain('automobile')
    expect((await client.searchMemory(ctx, { query: 'Friday key rotation' })).records[0]?.text).toContain('Rotate')
    client.close()
  })

  it('retrieves a semantic-only match outside the importance fallback pool', async () => {
    const { client, ctx } = await fixture()
    for (let i = 0; i < 2_050; i++) {
      await client.remember(ctx, { scope: 'project', kind: 'fact', text: `Bakery inventory ledger ${i}`, importance: 1 })
    }
    const target = await client.remember(ctx, {
      scope: 'project', kind: 'fact', text: 'The automobile requires gasoline', importance: 0,
    })
    const result = await client.searchMemory(ctx, { query: 'car fuel', limit: 5 })
    expect(result.records.map(record => record.id)).toContain(target.id)
    client.close()
  })

  it('deduplicates equivalent writes and keeps corrections current', async () => {
    const { client, ctx } = await fixture()
    const first = await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'Deploy region is us-west-2.', importance: .5 })
    const duplicate = await client.remember(ctx, { scope: 'project', kind: 'fact', text: '  deploy region is US-WEST-2  ', importance: .8 })
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.importance).toBe(.8)
    const correction = await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'Deploy region is eu-central-1', importance: .9, supersedes: first.id })
    expect((await client.searchMemory(ctx, { query: 'deploy region' })).records.map(record => record.id)).toEqual([correction.id])
    client.close()
  })

  it('combines recency, importance, and entity overlap', async () => {
    let clock = Date.UTC(2026, 0, 1)
    const { client, ctx } = await fixture(() => clock)
    await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'Mara owns the Atlas migration checklist', importance: .4 })
    clock += 180 * 86_400_000
    await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'Jon owns a generic migration checklist', importance: .4 })
    expect((await client.searchMemory(ctx, { query: 'Mara Atlas checklist' })).records[0]?.text).toContain('Mara')
    await client.remember(ctx, { scope: 'project', kind: 'constraint', text: 'Atlas migration requires a signed backup', importance: 1 })
    expect((await client.searchMemory(ctx, { query: 'Atlas migration' })).records[0]?.importance).toBe(1)
    client.close()
  })

  it('bounds compact output and exposes an explicit local vector backend', async () => {
    const { client, ctx } = await fixture()
    for (let i = 0; i < 60; i++) await client.remember(ctx, { scope: 'project', kind: 'fact', text: `compact token record ${i} ${'x'.repeat(2_000)}`, importance: .5 })
    const result = await client.searchMemory(ctx, { query: 'compact token', limit: MAX_MEMORY_SEARCH_LIMIT })
    // The byte budget is the bound on a compact response, not the record count:
    // sixty records of this size cannot fit, so the budget must truncate.
    expect(result.records.length).toBeLessThan(60)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32_768)
    expect(['sqlite-vec', 'sqlite-blob-fallback']).toContain(client.vectorBackend)
    expect(client.vectorBackend).not.toBe('network')
    client.close()
  })

  it('honours a requested limit up to the advertised MAX_MEMORY_SEARCH_LIMIT', async () => {
    // The constant, `validateSearchMemoryInput`, and the `memory_search` MCP
    // schema all advertise MAX_MEMORY_SEARCH_LIMIT. An engine cap below it
    // returns fewer records than asked with nothing in the result saying so.
    const { client, ctx } = await fixture()
    for (let i = 0; i < 40; i++) {
      await client.remember(ctx, { scope: 'project', kind: 'fact', text: `alpha beta ledger ${i}`, importance: .5 })
    }
    expect((await client.searchMemory(ctx, { query: 'alpha beta', limit: MAX_MEMORY_SEARCH_LIMIT })).records).toHaveLength(40)
    expect((await client.searchMemory(ctx, { query: 'alpha beta', limit: 25 })).records).toHaveLength(25)
    expect((await client.searchMemory(ctx, { query: 'alpha beta' })).records).toHaveLength(DEFAULT_MEMORY_SEARCH_LIMIT)
    client.close()
  })

  it('keeps semantic recall current for a memory another process committed', async () => {
    // `memory_vectors` is the durable authority and any in-process index is
    // derived from it. A second bridge process or an overlapping restart shares
    // the file, so a snapshot taken at construction silently loses exactly the
    // paraphrase retrieval the ADR calls the product promise.
    const path = dbPath()
    const provider = () => new TestEmbeddingProvider('cross-process-v1', 8, text =>
      text === 'car fuel' ? [1, 0, 0, 0, 0, 0, 0, 0] : text.includes('gasoline') ? unit(.5) : unit(.02))
    const writer = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider() })
    const reader = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider() })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })

    const target = await writer.remember(ctx, { scope: 'agent', kind: 'fact', text: 'The automobile requires gasoline', importance: .5 })
    // No lexical term is shared with the query, so this is semantic-only recall.
    expect((await writer.searchMemory(ctx, { query: 'car fuel' })).records.map(record => record.id)).toContain(target.id)
    expect((await reader.searchMemory(ctx, { query: 'car fuel' })).records.map(record => record.id)).toContain(target.id)
    writer.close()
    reader.close()
  })

  it('does not admit vectors from a write whose transaction never committed', async () => {
    const path = dbPath()
    const provider = new TestEmbeddingProvider('rollback-v1', 8, text =>
      text === 'car fuel' ? [1, 0, 0, 0, 0, 0, 0, 0] : text.includes('gasoline') ? unit(.5) : unit(.02))
    const client = new SQLiteFabricClient({ databasePath: path, embeddingProvider: provider })
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    // The insert lands, then the transaction fails after it: the memory row is
    // rolled back, so its vector must not survive in any derived index either.
    const failure = vi.spyOn(client as unknown as { memoryRow: () => unknown }, 'memoryRow').mockImplementationOnce(() => undefined)
    await expect(client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'The automobile requires gasoline', importance: .5 }))
      .rejects.toThrow('fabric storage is unavailable')
    failure.mockRestore()

    expect((await client.searchMemory(ctx, { query: 'car fuel' })).records).toEqual([])
    client.close()
  })

  it('still returns the top match when that single record alone exceeds the compact byte budget', async () => {
    // `text` is validated in raw bytes but the budget is measured on the
    // serialized record, and JSON escaping expands control characters sixfold.
    // A record can therefore be accepted by remember() and still outweigh the
    // whole budget on its own. Dropping it leaves search answering "nothing
    // matched" for a stored, authorized, top-ranked memory.
    const { client, ctx } = await fixture()
    const text = `oversized retrieval sentinel ${'\u0001'.repeat(6_000)}`
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16_384)
    const memory = await client.remember(ctx, { scope: 'project', kind: 'fact', text, importance: .9 })
    expect(Buffer.byteLength(JSON.stringify(memory), 'utf8')).toBeGreaterThan(32_768)

    const result = await client.searchMemory(ctx, { query: 'oversized retrieval sentinel' })
    expect(result.records.map(record => record.id)).toContain(memory.id)
    // The guarantee is exactly one record, not an unbounded dump: the response
    // stays bounded by the validated size of a single memory.
    expect(result.records).toHaveLength(1)
    client.close()
  })

  it('keeps admitting smaller records after the budget-exempt top match', async () => {
    const { client, ctx } = await fixture()
    for (let i = 0; i < 3; i++) await client.remember(ctx, { scope: 'project', kind: 'fact', text: `budget sentinel companion ${i}`, importance: .5 })
    const result = await client.searchMemory(ctx, { query: 'budget sentinel companion' })
    expect(result.records.length).toBe(3)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32_768)
    client.close()
  })

  it('migrates and removes derived FTS/vector data predictably', async () => {
    const path = dbPath()
    const client = new SQLiteFabricClient({ databasePath: path })
    const root = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })
    const memory = await client.remember(root, { scope: 'agent', kind: 'fact', text: 'derived index sentinel', importance: .5 })
    client.close()
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    let db = new DatabaseSync(path)
    expect((db.prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_id = ?').get(memory.id) as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT count(*) AS n FROM memory_vectors WHERE memory_id = ?').get(memory.id) as { n: number }).n).toBe(1)
    db.close()
    const reopened = new SQLiteFabricClient({ databasePath: path })
    await reopened.forgetMemory(root, memory.id)
    reopened.close()
    db = new DatabaseSync(path)
    expect((db.prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_id = ?').get(memory.id) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT count(*) AS n FROM memory_vectors WHERE memory_id = ?').get(memory.id) as { n: number }).n).toBe(0)
    db.close()
  })

  it('never calls the network on memory write, read, search, or delete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const { client, ctx } = await fixture()
    const memory = await client.remember(ctx, { scope: 'project', kind: 'fact', text: 'offline-only sentinel', importance: .7 })
    expect((await client.getMemory(ctx, memory.id))?.id).toBe(memory.id)
    expect((await client.searchMemory(ctx, { query: 'offline sentinel' })).records[0]?.id).toBe(memory.id)
    await client.forgetMemory(ctx, memory.id)
    expect(fetchSpy).not.toHaveBeenCalled()
    client.close()
  })

  // The native backend is an optional dependency, so whether it is installed
  // decides which code path every other case above exercises. Pinning the whole
  // lifecycle to each available backend stops one of them from rotting unseen.
  describe.each(['sqlite-blob-fallback', ...(sqliteVecAvailable() ? ['sqlite-vec' as const] : [])] as VectorBackend[])('on %s', backend => {
    it('remembers, retrieves, corrects, and forgets against the requested backend', async () => {
      const client = new SQLiteFabricClient({ databasePath: dbPath(), vectorBackend: backend })
      expect(client.vectorBackend).toBe(backend)
      const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', actorType: 'owner', capabilities })

      const original = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'the deploy region is us-east-1', importance: .6 })
      expect((await client.searchMemory(ctx, { query: 'deploy region' })).records.map(record => record.id)).toContain(original.id)

      const corrected = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'the deploy region is eu-west-2', importance: .6, supersedes: original.id })
      const afterCorrection = (await client.searchMemory(ctx, { query: 'deploy region' })).records.map(record => record.id)
      expect(afterCorrection).toContain(corrected.id)
      expect(afterCorrection).not.toContain(original.id)

      await client.forgetMemory(ctx, corrected.id)
      expect((await client.searchMemory(ctx, { query: 'deploy region' })).records.map(record => record.id)).not.toContain(corrected.id)
      client.close()
    })
  })
})

class TestEmbeddingProvider implements EmbeddingProvider {
  readonly offline = true as const
  constructor(readonly id: string, readonly dimensions: number, private readonly vectorFor: (text: string) => readonly number[]) {}
  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> { return texts.map(text => this.vectorFor(text)) }
}

/** A unit vector whose cosine against [1,0,...] is exactly `similarity`. */
function unit(similarity: number): readonly number[] {
  return [similarity, Math.sqrt(1 - similarity ** 2), 0, 0, 0, 0, 0, 0]
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2 }
  return dot / Math.sqrt(aa * bb)
}
