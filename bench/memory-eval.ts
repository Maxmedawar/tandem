/**
 * Deterministic retrieval-quality evaluation for the Phase 2 local memory
 * engine (spec section 14, Phase 2: "benchmark harness using open memory
 * evaluation concepts").
 *
 * The evaluation *categories* follow the general public concepts used by the
 * Apache-2.0 Mem0 OSS evaluation work — single-hop recall, entity attribution,
 * updates/contradictions, temporal ordering, preferences, and paraphrase
 * (semantic) retrieval. No Mem0 corpus, code, or scoring implementation is
 * copied; every seed sentence, query, and metric below is ours and runs fully
 * offline against the packaged deterministic embedding provider.
 *
 * Metrics are the standard recall@k / MRR definitions. Thresholds in
 * EVAL_THRESHOLDS are a locked product contract: `test/fabric/phase2-memory-eval.test.ts`
 * fails if a ranker change regresses them, and pins their floor so they cannot
 * be quietly weakened.
 */
import { performance } from 'node:perf_hooks'
import { createCallerContext } from '../src/fabric/capabilities.ts'
import type { FabricCapability, MemoryRecord } from '../src/fabric/types.ts'
import { SQLiteFabricClient } from '../bridge/fabric/sqlite-fabric-client.ts'
import type { VectorBackend } from '../bridge/fabric/memory/vector-store.ts'

export type EvalCategory = 'single-hop' | 'entity' | 'update' | 'temporal' | 'semantic' | 'preference' | 'procedure'

export interface EvalSeed {
  readonly key: string
  readonly kind: MemoryRecord['kind']
  readonly text: string
  readonly importance: number
  /** Whole days after the corpus epoch, so recency scoring is reproducible. */
  readonly day: number
  readonly supersedesKey?: string
  readonly agent?: 'agent-a' | 'agent-b'
}

export interface EvalCase {
  readonly id: string
  readonly category: EvalCategory
  readonly query: string
  readonly expectedKeys: readonly string[]
  /** Records that must never be returned, e.g. a superseded predecessor. */
  readonly forbiddenKeys?: readonly string[]
}

export interface EvalCaseResult {
  readonly id: string
  readonly category: EvalCategory
  readonly query: string
  /** 1-based rank of the first expected record, or null when it was not returned. */
  readonly rank: number | null
  readonly forbiddenHits: readonly string[]
}

export interface EvalMetrics {
  readonly cases: number
  readonly recallAt1: number
  readonly recallAt5: number
  readonly mrr: number
  readonly forbiddenHits: number
}

/**
 * Precision side of the ledger. The packaged offline embedding cannot reliably
 * separate "no relevant memory exists" from "weakly related memory", so
 * retrieval favours recall under a bounded semantic-only budget. That budget is
 * measured here rather than assumed.
 */
export interface NoAnswerMetrics {
  readonly queries: number
  readonly maxRecords: number
  readonly totalRecords: number
}

export interface MemoryEvaluationReport {
  readonly corpus: { readonly memories: number, readonly distractors: number, readonly cases: number }
  readonly vectorBackend: VectorBackend
  readonly overall: EvalMetrics
  readonly byCategory: Readonly<Record<string, EvalMetrics>>
  readonly noAnswer: NoAnswerMetrics
  readonly results: readonly EvalCaseResult[]
  readonly failures: readonly EvalCaseResult[]
  readonly searchP95Ms: number
  readonly thresholds: typeof EVAL_THRESHOLDS
  readonly passed: boolean
}

export const EVAL_THRESHOLDS = Object.freeze({
  recallAt1: 0.85,
  recallAt5: 1,
  mrr: 0.9,
  maxForbiddenHits: 0,
  /** Matches the engine's semantic-only admission budget. */
  maxNoAnswerRecords: 5,
})

/** Retrieval depth used for recall@5 / MRR. */
export const EVAL_SEARCH_LIMIT = 5
const EPOCH_MS = Date.UTC(2026, 0, 1)
const SEARCH_AT_MS = EPOCH_MS + 365 * 86_400_000

export const EVAL_SEEDS: readonly EvalSeed[] = Object.freeze([
  { key: 'deploy-region-old', kind: 'fact', text: 'The trading-bot deploy region is us-west-2', importance: .5, day: 0 },
  { key: 'live-orders', kind: 'constraint', text: 'The trading bot must never send live orders without explicit owner approval', importance: 1, day: 5 },
  { key: 'atlas-backup', kind: 'constraint', text: 'Atlas migration requires a signed backup before any schema change', importance: 1, day: 10, agent: 'agent-b' },
  { key: 'mara-atlas', kind: 'fact', text: 'Mara owns the Atlas migration checklist', importance: .6, day: 12 },
  { key: 'jon-billing', kind: 'fact', text: 'Jon owns the billing reconciliation checklist', importance: .6, day: 12, agent: 'agent-b' },
  { key: 'standup-old', kind: 'fact', text: 'The team standup starts at 09:00 on Tuesdays', importance: .4, day: 20 },
  { key: 'key-rotation', kind: 'procedure', text: 'Rotate the database encryption key every Friday before the nightly build', importance: .7, day: 25 },
  { key: 'van-fuel', kind: 'fact', text: 'The service van requires premium gasoline', importance: .3, day: 30, agent: 'agent-b' },
  { key: 'terse-answers', kind: 'preference', text: 'The owner prefers terse answers with no preamble', importance: .8, day: 32 },
  { key: 'index-handoff', kind: 'handoff', text: 'The database agent handed the index rebuild to the deploy agent', importance: .5, day: 40, agent: 'agent-b' },
  { key: 'tmux-flake', kind: 'discovery', text: 'The nightly integration suite fails when tmux sessions are reused across test files', importance: .7, day: 45 },
  { key: 'bakery', kind: 'fact', text: 'The bakery on Third Street closes at six', importance: .2, day: 50 },
  { key: 'ledger-cutoff', kind: 'decision', text: 'The ledger cutoff moves to the first business day of each month', importance: .8, day: 60, agent: 'agent-b' },
  { key: 'signing-keys', kind: 'fact', text: 'Release signing keys stay in the owner keychain and never in the repository', importance: .9, day: 65 },
  { key: 'deploy-region-new', kind: 'fact', text: 'The trading-bot deploy region is eu-central-1', importance: .9, day: 120, supersedesKey: 'deploy-region-old' },
  { key: 'standup-new', kind: 'fact', text: 'The team standup starts at 10:30 on Tuesdays', importance: .6, day: 200, supersedesKey: 'standup-old' },
])

export const EVAL_CASES: readonly EvalCase[] = Object.freeze([
  { id: 'update-deploy-region', category: 'update', query: 'trading-bot deploy region', expectedKeys: ['deploy-region-new'], forbiddenKeys: ['deploy-region-old'] },
  { id: 'update-standup-time', category: 'update', query: 'what time does the team standup start', expectedKeys: ['standup-new'], forbiddenKeys: ['standup-old'] },
  { id: 'temporal-latest-region', category: 'temporal', query: 'current deploy region for the trading bot', expectedKeys: ['deploy-region-new'], forbiddenKeys: ['deploy-region-old'] },
  { id: 'temporal-standup-tuesday', category: 'temporal', query: 'Tuesdays standup schedule', expectedKeys: ['standup-new'], forbiddenKeys: ['standup-old'] },
  { id: 'entity-atlas-owner', category: 'entity', query: 'who owns the Atlas migration checklist', expectedKeys: ['mara-atlas'] },
  { id: 'entity-billing-owner', category: 'entity', query: 'who owns billing reconciliation', expectedKeys: ['jon-billing'] },
  { id: 'entity-index-rebuild', category: 'entity', query: 'index rebuild handed to which agent', expectedKeys: ['index-handoff'] },
  { id: 'single-hop-backup', category: 'single-hop', query: 'signed backup before a schema change', expectedKeys: ['atlas-backup'] },
  { id: 'single-hop-live-orders', category: 'single-hop', query: 'approval before live orders', expectedKeys: ['live-orders'] },
  { id: 'single-hop-signing-keys', category: 'single-hop', query: 'where do release signing keys stay', expectedKeys: ['signing-keys'] },
  { id: 'single-hop-ledger', category: 'single-hop', query: 'ledger cutoff', expectedKeys: ['ledger-cutoff'] },
  { id: 'procedure-key-rotation', category: 'procedure', query: 'encryption key rotation before the nightly build', expectedKeys: ['key-rotation'] },
  { id: 'preference-answer-style', category: 'preference', query: 'owner prefers answers written how', expectedKeys: ['terse-answers'] },
  { id: 'semantic-car-fuel', category: 'semantic', query: 'car fuel', expectedKeys: ['van-fuel'] },
  { id: 'semantic-flaky-suite', category: 'semantic', query: 'nightly suite flakes on reused sessions', expectedKeys: ['tmux-flake'] },
  { id: 'semantic-bakery-hours', category: 'semantic', query: 'bakery closing time', expectedKeys: ['bakery'] },
])

/** Nothing in the corpus answers these, so every returned record is noise. */
export const EVAL_NO_ANSWER_QUERIES: readonly string[] = Object.freeze([
  'helicopter rotor maintenance manifest',
  'xylophone repair',
  'quarterly tax filing deadline in Portugal',
  'stadium seating chart for the away fixture',
])

const CAPABILITIES: FabricCapability[] = ['project:create', 'project:members', 'project:read', 'memory:read', 'memory:write']

export interface MemoryEvaluationOptions {
  readonly databasePath: string
  /** Unrelated filler memories written before the graded corpus. */
  readonly distractors?: number
  /** Grade a specific local vector backend. Both must score identically. */
  readonly vectorBackend?: VectorBackend
}

export async function runMemoryEvaluation(options: MemoryEvaluationOptions): Promise<MemoryEvaluationReport> {
  const distractors = options.distractors ?? 0
  let clock = EPOCH_MS
  const client = new SQLiteFabricClient({ databasePath: options.databasePath, now: () => clock, vectorBackend: options.vectorBackend })
  try {
    const owner = createCallerContext({ ownerId: 'eval-owner', deviceId: 'eval-device', agentId: 'agent-a', actorType: 'owner', capabilities: CAPABILITIES })
    const project = await client.createProject(owner, { displayName: 'Phase 2 evaluation corpus', memberAgentIds: ['agent-b'] })
    const context = (agentId: string) => createCallerContext({
      ownerId: owner.ownerId, deviceId: owner.deviceId, agentId, actorType: agentId === 'agent-a' ? 'owner' : 'agent',
      capabilities: CAPABILITIES, projectId: project.projectId,
    })
    const agents = { 'agent-a': context('agent-a'), 'agent-b': context('agent-b') } as const

    for (let i = 0; i < distractors; i++) {
      clock = EPOCH_MS + (i % 90) * 86_400_000
      await client.remember(agents['agent-a'], {
        scope: 'project', kind: 'fact', importance: (i % 10) / 20,
        text: `Archive shard ${i % 991} holds unrelated filler entry ${i} with no graded content`,
      })
    }

    const ids = new Map<string, string>()
    for (const seed of EVAL_SEEDS) {
      clock = EPOCH_MS + seed.day * 86_400_000
      const supersedes = seed.supersedesKey === undefined ? undefined : ids.get(seed.supersedesKey)
      if (seed.supersedesKey !== undefined && supersedes === undefined) throw new Error(`eval corpus references an unseeded key: ${seed.supersedesKey}`)
      const record = await client.remember(agents[seed.agent ?? 'agent-a'], {
        scope: 'project', kind: seed.kind, text: seed.text, importance: seed.importance,
        ...(supersedes === undefined ? {} : { supersedes }),
      })
      ids.set(seed.key, record.id)
    }

    clock = SEARCH_AT_MS
    const latencies: number[] = []
    const results: EvalCaseResult[] = []
    for (const value of EVAL_CASES) {
      const expected = value.expectedKeys.map(key => resolveKey(ids, key))
      const forbidden = (value.forbiddenKeys ?? []).map(key => resolveKey(ids, key))
      const startedAt = performance.now()
      const found = await client.searchMemory(agents['agent-a'], { query: value.query, limit: EVAL_SEARCH_LIMIT })
      latencies.push(performance.now() - startedAt)
      const returned = found.records.map(record => record.id)
      const position = returned.findIndex(id => expected.includes(id))
      results.push({
        id: value.id, category: value.category, query: value.query,
        rank: position === -1 ? null : position + 1,
        forbiddenHits: returned.filter(id => forbidden.includes(id)),
      })
    }

    const noAnswerCounts: number[] = []
    for (const query of EVAL_NO_ANSWER_QUERIES) {
      const startedAt = performance.now()
      const found = await client.searchMemory(agents['agent-a'], { query, limit: EVAL_SEARCH_LIMIT })
      latencies.push(performance.now() - startedAt)
      noAnswerCounts.push(found.records.length)
    }
    const noAnswer: NoAnswerMetrics = {
      queries: EVAL_NO_ANSWER_QUERIES.length,
      maxRecords: noAnswerCounts.reduce((max, value) => Math.max(max, value), 0),
      totalRecords: noAnswerCounts.reduce((sum, value) => sum + value, 0),
    }

    const overall = metrics(results)
    const byCategory: Record<string, EvalMetrics> = {}
    for (const category of [...new Set(EVAL_CASES.map(value => value.category))].sort()) {
      byCategory[category] = metrics(results.filter(result => result.category === category))
    }
    const failures = results.filter(result => result.rank === null || result.rank > EVAL_SEARCH_LIMIT || result.forbiddenHits.length > 0)
    return {
      corpus: { memories: EVAL_SEEDS.length + distractors, distractors, cases: EVAL_CASES.length },
      vectorBackend: client.vectorBackend,
      overall,
      byCategory,
      noAnswer,
      results,
      failures,
      searchP95Ms: round(percentile(latencies, .95)),
      thresholds: EVAL_THRESHOLDS,
      passed: overall.recallAt1 >= EVAL_THRESHOLDS.recallAt1 && overall.recallAt5 >= EVAL_THRESHOLDS.recallAt5 &&
        overall.mrr >= EVAL_THRESHOLDS.mrr && overall.forbiddenHits <= EVAL_THRESHOLDS.maxForbiddenHits &&
        noAnswer.maxRecords <= EVAL_THRESHOLDS.maxNoAnswerRecords,
    }
  } finally {
    client.close()
  }
}

function resolveKey(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key)
  if (id === undefined) throw new Error(`eval case references an unknown seed key: ${key}`)
  return id
}

function metrics(results: readonly EvalCaseResult[]): EvalMetrics {
  const cases = results.length
  if (cases === 0) return { cases, recallAt1: 0, recallAt5: 0, mrr: 0, forbiddenHits: 0 }
  const at = (depth: number) => results.filter(result => result.rank !== null && result.rank <= depth).length / cases
  return {
    cases,
    recallAt1: round(at(1)),
    recallAt5: round(at(EVAL_SEARCH_LIMIT)),
    mrr: round(results.reduce((sum, result) => sum + (result.rank === null ? 0 : 1 / result.rank), 0) / cases),
    forbiddenHits: results.reduce((sum, result) => sum + result.forbiddenHits.length, 0),
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0
}

function round(value: number): number { return Math.round(value * 10_000) / 10_000 }
