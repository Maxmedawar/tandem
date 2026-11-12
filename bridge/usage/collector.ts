/**
 * collector.ts: reads the drop files each `usage = "statusline"` agent's sessions write
 * (bridge/usage/statusline-drop.ts) into state.db (bridge/usage/store.ts), at start and every 60
 * seconds. Only regular files of this user's, not open to group or world, at most 64 KiB, named
 * `<account>.json`, holding exactly `{ at, rate_limits: { five_hour?, seven_day? } }` with numbers;
 * anything else is skipped, and so is a file whose time is not a whole number of ms or is over a
 * minute ahead of this computer's clock (it would never turn stale and no later reading would
 * replace it). An account that turns stale (no reading for over 30 minutes) gets one
 * stderr line, and again only after it was fresh in between.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readProtectedRegularFileSync } from '../../src/runtime-config.ts'
import { loadHarnesses, type Harness } from '../harness-registry.ts'
import { ACCOUNT, dropDirOf } from './claude.ts'
import { readUsage, recordReadings, type Reading } from './store.ts'

const EVERY_MS = 60_000
/** How far ahead of the clock a drop file's time may be (the same computer wrote it). */
const AHEAD_MS = 60_000
/** `<agent>/<account>` of the accounts whose stale notice was written and that have not been fresh since. */
const noticed = new Set<string>()

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const keysAre = (o: Record<string, unknown>, allowed: string[], required: string[]) =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(o, k))

/** One window as numbers (share, reset in ms); undefined when it breaks the shape. */
function windowOf(v: unknown): { used: number; resetsMs: number } | undefined {
  if (!isObject(v) || !keysAre(v, ['used_percentage', 'resets_at'], ['used_percentage', 'resets_at'])) return undefined
  const { used_percentage: used, resets_at: resets } = v
  if (!finite(used) || used < 0 || used > 100 || !finite(resets) || resets <= 0 || !Number.isSafeInteger(Math.round(resets * 1000))) return undefined
  return { used, resetsMs: Math.round(resets * 1000) }
}

/** A drop file's reading, or undefined when it does not parse or breaks the shape. */
function readingOf(bytes: Buffer, account: string, agent: string, now: number): Reading | undefined {
  let v: unknown
  try { v = JSON.parse(bytes.toString('utf8')) } catch { return undefined }
  if (!isObject(v) || !keysAre(v, ['at', 'rate_limits'], ['at', 'rate_limits']) || !Number.isSafeInteger(v.at) || (v.at as number) <= 0 || (v.at as number) > now + AHEAD_MS) return undefined
  const limits = v.rate_limits
  if (!isObject(limits) || !keysAre(limits, ['five_hour', 'seven_day'], [])) return undefined
  const five = limits.five_hour === undefined ? undefined : windowOf(limits.five_hour)
  const seven = limits.seven_day === undefined ? undefined : windowOf(limits.seven_day)
  if ((limits.five_hour !== undefined && !five) || (limits.seven_day !== undefined && !seven) || (!five && !seven)) return undefined
  return { account, agent, atMs: v.at as number, ...(five ? { five } : {}), ...(seven ? { seven } : {}) }
}

function readDrops(agent: string, now: number): Reading[] {
  const dir = dropDirOf(agent)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Reading[] = []
  for (const n of names) {
    const account = n.endsWith('.json') ? n.slice(0, -5) : ''
    if (!ACCOUNT.test(account)) continue
    try {
      // No symlink, a regular file of this user's, not open to group or world, at most 64 KiB.
      const r = readingOf(readProtectedRegularFileSync(join(dir, n)), account, agent, now)
      if (r) out.push(r)
    } catch { /* skipped */ }
  }
  return out
}

/** One pass: every drop file of `harnesses` (default: the loaded harness files) into state.db, then the stale notices. */
export function collectUsage(now = Date.now(), harnesses?: Iterable<Harness>): void {
  const agents = [...(harnesses ?? loadHarnesses().harnesses.values())].filter((h) => h.usage === 'statusline').map((h) => h.name)
  recordReadings(agents.flatMap((a) => readDrops(a, now)), now)
  for (const u of readUsage(now)) {
    const key = `${u.agent}/${u.account}`
    if (!u.stale) noticed.delete(key)
    else if (!noticed.has(key)) {
      noticed.add(key)
      process.stderr.write(`usage: ${u.agent} account ${u.account} has not reported for ${Math.floor(u.ageMs / 60_000)} min\n`)
    }
  }
}

/** Collects at start and every `everyMs` (60 s); returns the stop. A failed pass writes one stderr line and the next pass runs. */
export function startUsageCollector(opts: { everyMs?: number; now?: () => number } = {}): () => void {
  const now = opts.now ?? Date.now
  const pass = () => {
    try {
      collectUsage(now())
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      process.stderr.write(`usage: collector pass failed (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'})\n`)
    }
  }
  pass()
  const timer = setInterval(pass, opts.everyMs ?? EVERY_MS)
  timer.unref()
  return () => clearInterval(timer)
}
