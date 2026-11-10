import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVAL_CASES, EVAL_SEEDS, EVAL_THRESHOLDS, runMemoryEvaluation } from '../../bench/memory-eval.ts'
import { sqliteVecAvailable } from '../../bridge/fabric/memory/vector-store.ts'

const directories = new Set<string>()
const dbPath = () => { const dir = mkdtempSync(join(tmpdir(), 'fabric-eval-')); chmodSync(dir, 0o700); directories.add(dir); return join(dir, 'fabric.sqlite3') }
afterEach(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); directories.clear(); vi.restoreAllMocks() })

describe('Phase 2 retrieval quality regression', () => {
  it('keeps the locked quality thresholds at or above the Phase 2 floor', () => {
    // The thresholds are the contract. Weakening them to make a ranker change
    // pass must break this test, not silently lower product quality.
    expect(EVAL_THRESHOLDS.recallAt1).toBeGreaterThanOrEqual(0.8)
    expect(EVAL_THRESHOLDS.recallAt5).toBeGreaterThanOrEqual(0.95)
    expect(EVAL_THRESHOLDS.mrr).toBeGreaterThanOrEqual(0.85)
    expect(EVAL_THRESHOLDS.maxForbiddenHits).toBe(0)
    expect(EVAL_THRESHOLDS.maxNoAnswerRecords).toBeLessThanOrEqual(5)
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(12)
    expect(new Set(EVAL_CASES.map(value => value.category)).size).toBeGreaterThanOrEqual(5)
  })

  it('meets the locked thresholds on the deterministic evaluation corpus', async () => {
    const report = await runMemoryEvaluation({ databasePath: dbPath() })
    expect(report.failures).toEqual([])
    expect(report.overall.recallAt1).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.recallAt1)
    expect(report.overall.recallAt5).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.recallAt5)
    expect(report.overall.mrr).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.mrr)
    expect(report.overall.forbiddenHits).toBe(0)
    expect(report.passed).toBe(true)
    expect(report.corpus.cases).toBe(EVAL_CASES.length)
    expect(report.corpus.memories).toBeGreaterThanOrEqual(EVAL_SEEDS.length)
  })

  it('keeps unanswerable queries inside the measured semantic-only budget', async () => {
    // Recall is bought with a bounded amount of noise. Measure the price.
    const report = await runMemoryEvaluation({ databasePath: dbPath(), distractors: 500 })
    expect(report.noAnswer.queries).toBeGreaterThanOrEqual(4)
    expect(report.noAnswer.maxRecords).toBeLessThanOrEqual(EVAL_THRESHOLDS.maxNoAnswerRecords)
  }, 60_000)

  it('never surfaces a superseded or contradicted record in any evaluation case', async () => {
    const report = await runMemoryEvaluation({ databasePath: dbPath() })
    expect(EVAL_CASES.some(value => (value.forbiddenKeys?.length ?? 0) > 0)).toBe(true)
    for (const result of report.results) expect(result.forbiddenHits).toEqual([])
  })

  it('holds retrieval quality when the corpus is padded with distractors', async () => {
    const report = await runMemoryEvaluation({ databasePath: dbPath(), distractors: 2_000 })
    expect(report.corpus.distractors).toBe(2_000)
    expect(report.overall.recallAt1).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.recallAt1)
    expect(report.overall.recallAt5).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.recallAt5)
    expect(report.overall.forbiddenHits).toBe(0)
  }, 120_000)

  it.runIf(sqliteVecAvailable())('grades identically on both local vector backends', async () => {
    // The backends differ in latency and memory residency, never in what a
    // caller can retrieve. Recording that as a test stops a change to one of
    // them from quietly becoming a quality change for whoever selected it.
    const fallback = await runMemoryEvaluation({ databasePath: dbPath(), vectorBackend: 'sqlite-blob-fallback' })
    const native = await runMemoryEvaluation({ databasePath: dbPath(), vectorBackend: 'sqlite-vec' })
    expect(native.vectorBackend).toBe('sqlite-vec')
    expect(fallback.vectorBackend).toBe('sqlite-blob-fallback')
    expect(JSON.stringify(native.overall)).toBe(JSON.stringify(fallback.overall))
    expect(JSON.stringify(native.byCategory)).toBe(JSON.stringify(fallback.byCategory))
    expect(native.results.map(value => value.rank)).toEqual(fallback.results.map(value => value.rank))
    expect(native.noAnswer.totalRecords).toBe(fallback.noAnswer.totalRecords)
  }, 60_000)

  it('produces byte-identical metrics across runs and performs no network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const first = await runMemoryEvaluation({ databasePath: dbPath() })
    const second = await runMemoryEvaluation({ databasePath: dbPath() })
    expect(JSON.stringify(second.overall)).toBe(JSON.stringify(first.overall))
    expect(JSON.stringify(second.byCategory)).toBe(JSON.stringify(first.byCategory))
    expect(second.results.map(value => value.rank)).toEqual(first.results.map(value => value.rank))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
