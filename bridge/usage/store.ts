/**
 * store.ts: account usage readings in `<TANDEM_HOME>/state.db` (opened as bridge/mailbox.ts opens
 * it: folder 0700, file 0600), table `usage_readings`, one row per account and agent. Numbers and
 * times only: no text from any session reaches this table. A reading replaces a row only when it
 * is newer. readUsage marks a reading over 30 minutes old stale, and reads a window's share as
 * unknown (null) once its reset time has passed, never the old number. The plan type (Codex) is kept
 * only when it matches PLAN, else NULL. Table `usage_tokens` holds each account's last ccusage run
 * (bridge/usage/ccusage.ts): tokens and cost (today and total) as numbers, or NULLs and the reason.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { ensureDbFile } from '../sqlite-file.ts'
import { tandemHome } from './claude.ts'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export const STALE_MS = 30 * 60_000
const PLAN = /^[a-z0-9_-]{1,32}$/

/** One drop file's content, as numbers: share 0-100, times in ms. */
export interface Reading {
  account: string
  agent: string
  atMs: number
  five?: { used: number; resetsMs: number }
  seven?: { used: number; resetsMs: number }
  plan?: string
}

export interface WindowUsage { used: number | null; resetsAt: number | null }
export interface AccountUsage { account: string; agent: string; at: number; ageMs: number; stale: boolean; five_hour: WindowUsage; seven_day: WindowUsage; plan: string | null }

type Row = { account: string; agent: string; at_ms: number; five_used: number | null; five_resets_ms: number | null; seven_used: number | null; seven_resets_ms: number | null; plan: string | null }

const dbFile = () => join(tandemHome(), 'state.db')

function open(): NodeDatabaseSync {
  const path = dbFile()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  ensureDbFile(path)
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_readings (account TEXT, agent TEXT, at_ms INTEGER, five_used REAL, five_resets_ms INTEGER,
        seven_used REAL, seven_resets_ms INTEGER, read_ms INTEGER, plan TEXT, PRIMARY KEY (account, agent))`)
    // A table from before the plan column gains it; its rows read NULL.
    if (!(db.prepare('PRAGMA table_info(usage_readings)').all() as { name: string }[]).some((c) => c.name === 'plan')) {
      try {
        db.exec('ALTER TABLE usage_readings ADD COLUMN plan TEXT')
      } catch (e) {
        // Another process added it between the check and this ALTER: done, not a failure.
        if (!String((e as Error)?.message).includes('duplicate column name: plan')) throw e
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS usage_tokens (account TEXT, agent TEXT, read_ms INTEGER, tokens_today INTEGER, cost_today REAL,
      tokens_total INTEGER, cost_total REAL, reason TEXT, PRIMARY KEY (account, agent))`)
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

/** Records readings (each replaces its row only when newer); `now` is the read time. */
export function recordReadings(readings: Reading[], now = Date.now()): void {
  if (readings.length === 0) return
  const db = open()
  try {
    const put = db.prepare(`INSERT INTO usage_readings (account, agent, at_ms, five_used, five_resets_ms, seven_used, seven_resets_ms, read_ms, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account, agent) DO UPDATE SET at_ms = excluded.at_ms, five_used = excluded.five_used,
      five_resets_ms = excluded.five_resets_ms, seven_used = excluded.seven_used, seven_resets_ms = excluded.seven_resets_ms,
      read_ms = excluded.read_ms, plan = excluded.plan WHERE excluded.at_ms > usage_readings.at_ms`)
    for (const r of readings) {
      put.run(r.account, r.agent, r.atMs, r.five?.used ?? null, r.five?.resetsMs ?? null, r.seven?.used ?? null, r.seven?.resetsMs ?? null, now,
        typeof r.plan === 'string' && PLAN.test(r.plan) ? r.plan : null)
    }
  } finally {
    db.close()
  }
}

const windowOf = (used: number | null, resetsAt: number | null, now: number): WindowUsage =>
  ({ used: used === null || resetsAt === null || resetsAt <= now ? null : used, resetsAt })

/** Every account's last reading as of `now`; none when there is no state.db yet. */
export function readUsage(now = Date.now()): AccountUsage[] {
  if (!existsSync(dbFile())) return []
  const db = open()
  try {
    const rows = db.prepare('SELECT * FROM usage_readings ORDER BY agent, account').all() as unknown as Row[]
    return rows.map((r) => {
      const ageMs = now - r.at_ms
      return {
        account: r.account, agent: r.agent, at: r.at_ms, ageMs, stale: ageMs > STALE_MS,
        five_hour: windowOf(r.five_used, r.five_resets_ms, now),
        seven_day: windowOf(r.seven_used, r.seven_resets_ms, now),
        plan: r.plan ?? null,
      }
    })
  } finally {
    db.close()
  }
}

/** One ccusage run for one account: its numbers, or (failed) its reason and no numbers. */
export interface TokenRun {
  account: string
  agent: string
  today?: { tokens: number; cost: number }
  total?: { tokens: number; cost: number }
  reason?: string
}
export interface TokenRow { account: string; agent: string; read_ms: number; tokens_today: number | null; cost_today: number | null; tokens_total: number | null; cost_total: number | null; reason: string | null }

/** Records runs (each replaces its row); `now` is the read time. No runs: nothing written, no state.db made. */
export function recordTokens(runs: TokenRun[], now: number): void {
  if (runs.length === 0) return
  const db = open()
  try {
    const put = db.prepare(`INSERT OR REPLACE INTO usage_tokens (account, agent, read_ms, tokens_today, cost_today, tokens_total, cost_total, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of runs) {
      const ok = r.reason === undefined && r.today !== undefined && r.total !== undefined
      put.run(r.account, r.agent, now, ok ? r.today!.tokens : null, ok ? r.today!.cost : null, ok ? r.total!.tokens : null, ok ? r.total!.cost : null,
        ok ? null : r.reason ?? 'output not readable')
    }
  } finally {
    db.close()
  }
}

/** Every account's last ccusage run; none when there is no state.db yet. */
export function tokenRows(): TokenRow[] {
  if (!existsSync(dbFile())) return []
  const db = open()
  try {
    return db.prepare('SELECT * FROM usage_tokens ORDER BY agent, account').all() as unknown as TokenRow[]
  } finally {
    db.close()
  }
}
