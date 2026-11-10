/**
 * Phase 2 scale benchmark for the local memory engine (spec section 13).
 *
 *   npm run bench:fabric-memory
 *
 * `searchMemory` is a single hybrid path: every call runs lexical BM25 *and*
 * the local vector stage. The spec's separate lexical target is therefore
 * measured at the lexical retrieval stage — the exact FTS5/BM25 statement the
 * engine issues — while the end-to-end product number is measured against the
 * hybrid target. The corpus is seeded with vectors present, so the run measures
 * steady-state retrieval rather than the one-time migration backfill.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { createCallerContext } from '../src/fabric/capabilities.ts'
import type { FabricCapability } from '../src/fabric/types.ts'
import { SQLiteFabricClient } from '../bridge/fabric/sqlite-fabric-client.ts'
import { DeterministicEmbeddingProvider } from '../bridge/fabric/memory/embedding.ts'
import type { VectorBackend } from '../bridge/fabric/memory/vector-store.ts'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
// Both local backends are benchmarked at scale. Naming one explicitly makes the
// run fail rather than silently report the packaged fallback's numbers when the
// pinned optional native extension is missing.
const requested = process.env.FABRIC_VECTOR_BACKEND as VectorBackend | undefined
if (requested !== undefined && requested !== 'sqlite-vec' && requested !== 'sqlite-blob-fallback') throw new Error(`unknown FABRIC_VECTOR_BACKEND: ${requested}`)
const count = 100_000
const directory = mkdtempSync(join(tmpdir(), 'fabric-memory-bench-'))
chmodSync(directory, 0o700)
const databasePath = join(directory, 'fabric.sqlite3')
const caps: FabricCapability[] = ['project:create', 'project:read', 'memory:read', 'memory:write']
const SEMANTIC_TARGET = 'The automobile requires gasoline'

try {
  const root = createCallerContext({ ownerId: 'bench-owner', deviceId: 'bench-device', agentId: 'bench-agent', actorType: 'owner', capabilities: caps })
  const bootstrap = new SQLiteFabricClient({ databasePath, vectorBackend: requested })
  const project = await bootstrap.createProject(root, { displayName: '100k benchmark' })
  bootstrap.close()

  const embedding = new DeterministicEmbeddingProvider()
  const db = new DatabaseSync(databasePath)
  const insertMemory = db.prepare(`INSERT INTO memories(id,owner_id,scope,project_id,kind,text,importance,created_at,updated_at,source_type,source_agent_id,normalized_digest)
    VALUES (?, 'bench-owner', 'project', ?, 'fact', ?, ?, ?, ?, 'agent', 'bench-agent', ?)`)
  const insertFts = db.prepare('INSERT INTO memory_fts(memory_id,text) VALUES (?, ?)')
  const insertVector = db.prepare(`INSERT INTO memory_vectors(memory_id,embedding,owner_id,scope,project_id,agent_id,superseded)
    VALUES (?, ?, 'bench-owner', 'project', ?, NULL, 0)`)
  const started = performance.now()
  db.exec('BEGIN IMMEDIATE')
  const timestamp = new Date(Date.UTC(2026, 7, 13)).toISOString()
  for (let i = 0; i < count; i++) {
    const id = `bench-${i.toString().padStart(6, '0')}`
    const text = i === 91_337 ? SEMANTIC_TARGET : `deterministic memory record ${i} shard ${i % 997}`
    const importance = i === 91_337 ? 0 : (i % 10) / 20
    insertMemory.run(id, project.projectId, text, importance, timestamp, timestamp, digest(text))
    insertFts.run(id, text)
    insertVector.run(id, new Uint8Array(new Float32Array(embedding.embedOne(text)).buffer), project.projectId)
  }
  db.exec('COMMIT')
  const loadMs = performance.now() - started

  // The engine's lexical stage, verbatim, so the stage number is not a proxy.
  const lexicalStage = db.prepare(`
    SELECT f.memory_id, bm25(memory_fts) AS rank
    FROM memory_fts f JOIN memories m ON m.id = f.memory_id
    WHERE memory_fts MATCH ? AND m.owner_id = ? AND m.deleted_at IS NULL
      AND (m.scope = 'project' AND m.project_id = ?)
      AND NOT EXISTS (SELECT 1 FROM memories successor WHERE successor.owner_id = m.owner_id AND successor.supersedes = m.id)
    ORDER BY rank, f.memory_id LIMIT 500`)

  // Opening the authority is also when a native vector index missing from the
  // durable mirror is rebuilt, so that startup cost is measured, not hidden.
  const openedAt = performance.now()
  const client = new SQLiteFabricClient({ databasePath, now: () => Date.UTC(2026, 7, 13), vectorBackend: requested })
  const openMs = performance.now() - openedAt
  const ctx = createCallerContext({ ...root, capabilities: caps, projectId: project.projectId })
  const lexicalStageMs: number[] = [], exactMs: number[] = [], hybridMs: number[] = [], storeMs: number[] = []
  for (let i = 0; i < 30; i++) {
    let at = performance.now()
    if ((lexicalStage.all('"automobile" OR "gasoline"', 'bench-owner', project.projectId) as unknown[]).length === 0) throw new Error('lexical stage returned nothing')
    lexicalStageMs.push(performance.now() - at)

    at = performance.now(); const exact = await client.searchMemory(ctx, { query: 'automobile gasoline', limit: 1 }); exactMs.push(performance.now() - at)
    if (exact.records[0]?.text !== SEMANTIC_TARGET) throw new Error('lexical quality regression')

    at = performance.now(); const semantic = await client.searchMemory(ctx, { query: 'car fuel', limit: 5 }); hybridMs.push(performance.now() - at)
    if (!semantic.records.some(record => record.text === SEMANTIC_TARGET)) throw new Error('hybrid quality regression')

    at = performance.now()
    await client.remember(ctx, { scope: 'project', kind: 'fact', text: `benchmark acknowledgement probe ${i}`, importance: .5 })
    storeMs.push(performance.now() - at)
  }
  db.close()

  const thresholds = { lexicalStageP95Ms: 100, hybridSearchP95Ms: 500, storeAckP95Ms: 100 }
  const measured = {
    lexicalStageP95Ms: round(p95(lexicalStageMs)),
    hybridSearchP95Ms: round(p95(hybridMs)),
    exactMatchSearchP95Ms: round(p95(exactMs)),
    storeAckP95Ms: round(p95(storeMs)),
  }
  const output = {
    records: count, vectorBackend: client.vectorBackend, loadMs: round(loadMs), openMs: round(openMs),
    ...measured,
    thresholds,
    passed: measured.lexicalStageP95Ms < thresholds.lexicalStageP95Ms &&
      measured.hybridSearchP95Ms < thresholds.hybridSearchP95Ms &&
      measured.storeAckP95Ms < thresholds.storeAckP95Ms,
  }
  client.close()
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (!output.passed) process.exitCode = 1
} finally { rmSync(directory, { recursive: true, force: true }) }

function digest(text: string): string {
  const { createHash } = createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(text.normalize('NFKC').trim().replace(/[.?!]+$/u, '').replace(/\s+/g, ' ').toLocaleLowerCase('en-US'), 'utf8').digest('hex')
}
function p95(values: readonly number[]): number { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] ?? Infinity }
function round(value: number): number { return Math.round(value * 100) / 100 }
