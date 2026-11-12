/**
 * codex.ts: a Codex account's limits, read from what Codex already writes: the last `rate_limits`
 * entry in the last 256 KiB of the newest (by mtime) `sessions/YYYY/MM/DD/rollout-*.jsonl` of the
 * account folder. Usage is read only: nothing outside `<folder>/sessions/` is opened, so the login
 * file (`auth.json`) never is. Only numbers, times and the plan type leave this file.
 *
 * Windows map by length, not by primary/secondary: 300 min = five_hour, 10080 min = seven_day; any
 * other length is skipped (one stderr line per account per process). A line's time is its
 * `timestamp`, else the file's mtime; a time over a minute ahead of `now` skips the line. A newest
 * file without a usable line gives no reading: the store keeps the earlier one, which ages.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Harness } from '../harness-registry.ts'
import { listedAccounts, nameFromFolder } from './claude.ts'
import type { Reading } from './store.ts'

const TAIL = 256 * 1024
const AHEAD_MS = 60_000
/** At most sessions/YYYY/MM/DD/file. */
const DEPTH = 4
const ROLLOUT = /^rollout-.*\.jsonl$/
const WINDOWS = new Map<unknown, 'five' | 'seven'>([[300, 'five'], [10080, 'seven']])
/** Accounts whose skipped-window line was written this process. */
const skipNoticed = new Set<string>()

type Window = { used: number; resetsMs: number }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const ownFile = (st: { uid: number }) => typeof process.getuid !== 'function' || st.uid === process.getuid()

/** The newest regular `rollout-*.jsonl` of this user's under `dir`; symlinks are never followed. */
function newestRollout(dir: string, depth: number, best?: { path: string; mtimeMs: number }): { path: string; mtimeMs: number } | undefined {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isDirectory() && depth < DEPTH) best = newestRollout(p, depth + 1, best)
    else if (st.isFile() && ROLLOUT.test(name) && ownFile(st) && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs }
  }
  return best
}

/** The last `TAIL` bytes of `path` as whole lines, and its mtime. */
function tailOf(path: string): { lines: string[]; mtimeMs: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || !ownFile(st)) return { lines: [], mtimeMs: st.mtimeMs }
    const start = Math.max(0, st.size - TAIL)
    const buf = Buffer.alloc(st.size - start)
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, start + n)
      if (got === 0) break
      n += got
    }
    let text = buf.subarray(0, n).toString('utf8')
    // Not at the start: the first line is partial.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { lines: text.split('\n'), mtimeMs: st.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

/** The first `rate_limits` object under `v`. */
function findLimits(v: unknown): Record<string, unknown> | undefined {
  if (!isObject(v) && !Array.isArray(v)) return undefined
  if (isObject(v) && isObject(v.rate_limits)) return v.rate_limits
  for (const x of Object.values(v)) {
    const found = findLimits(x)
    if (found) return found
  }
  return undefined
}

function windowOf(v: unknown): Window | undefined {
  if (!isObject(v)) return undefined
  const { used_percent: used, resets_at: resets } = v
  if (!finite(used) || used < 0 || used > 100 || !finite(resets) || resets <= 0 || !Number.isSafeInteger(Math.round(resets * 1000))) return undefined
  return { used, resetsMs: Math.round(resets * 1000) }
}

/** One line's reading, or undefined when it holds no usable `rate_limits` or is ahead of `now`. */
function readingOf(line: string, account: string, mtimeMs: number, now: number): Reading | undefined {
  if (!line.includes('"rate_limits"')) return undefined
  let v: unknown
  try { v = JSON.parse(line) } catch { return undefined }
  if (!isObject(v)) return undefined
  const limits = findLimits(v.payload)
  if (!limits) return undefined
  const out: { five?: Window; seven?: Window } = {}
  for (const w of [limits.primary, limits.secondary]) {
    if (!isObject(w)) continue
    const key = WINDOWS.get(w.window_minutes)
    if (!key) {
      if (!skipNoticed.has(account)) {
        skipNoticed.add(account)
        const m = finite(w.window_minutes) ? String(w.window_minutes) : 'unknown'
        process.stderr.write(`usage: account ${account}: a ${m}-minute window is skipped\n`)
      }
      continue
    }
    const parsed = windowOf(w)
    if (parsed && !out[key]) out[key] = parsed
  }
  if (!out.five && !out.seven) return undefined
  const ts = typeof v.timestamp === 'string' ? Date.parse(v.timestamp) : NaN
  const atMs = Number.isSafeInteger(ts) && ts > 0 ? ts : Math.floor(mtimeMs)
  if (atMs > now + AHEAD_MS) return undefined
  // The plan type is checked again where it is stored (store.ts).
  const plan = typeof limits.plan_type === 'string' ? limits.plan_type : undefined
  return { account, agent: '', atMs, ...out, ...(plan === undefined ? {} : { plan }) }
}

/** One account folder, one pass: the last usable `rate_limits` line of its newest rollout file; `agent` is left empty (codexReadings sets the harness name). */
export function readCodexFolder(folder: string, account: string, now: number): Reading | undefined {
  const sessions = join(folder, 'sessions')
  try {
    if (!lstatSync(sessions).isDirectory()) return undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  const newest = newestRollout(sessions, 1)
  if (!newest) return undefined
  const { lines, mtimeMs } = tailOf(newest.path)
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = readingOf(lines[i]!, account, mtimeMs, now)
    if (r) return r
  }
  return undefined
}

const expand = (p: string) => resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** Every account folder of `harness` (its `account_dir` and usage.toml's accounts for it), each read once. */
export function codexReadings(harness: Harness, now: number): Reading[] {
  const folders = new Map<string, string>()
  for (const a of listedAccounts()) if (a.agent === harness.name && !folders.has(expand(a.folder))) folders.set(expand(a.folder), a.name)
  if (harness.account_dir && !folders.has(expand(harness.account_dir))) folders.set(expand(harness.account_dir), nameFromFolder(expand(harness.account_dir)))
  const out: Reading[] = []
  for (const [folder, account] of folders) {
    try {
      const r = readCodexFolder(folder, account, now)
      if (r) out.push({ ...r, agent: harness.name })
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      process.stderr.write(`usage: ${harness.name} account ${account} not read (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'})\n`)
    }
  }
  return out
}
