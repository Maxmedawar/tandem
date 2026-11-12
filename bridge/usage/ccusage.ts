/**
 * ccusage.ts: tokens and cost per account, from the pinned ccusage helper (MIT;
 * packaging/helpers/ccusage/PIN.md), shipped in the release as `libexec/ccusage`. One run per
 * account folder, one at a time:
 *
 *   ccusage <agent> daily --json --offline        (cwd /, its own process group)
 *
 * with an environment built from a short allow-list (HELPER_ENV: PATH, HOME, locale, TZ, TMPDIR) plus
 * only that agent's folder variable: nothing else of the bridge's environment (no token, password,
 * proxy or other setting) reaches this third-party program. `--offline` makes ccusage use its embedded price table: no price fetch, no network.
 * A run is killed with its whole process group after KILL_MS, or once its stdout passes 8 MiB; its
 * stderr is drained and dropped, never stored or logged (it may hold paths). Only numbers leave
 * parseDaily: tokens and cost of today (the row of `now`'s local date) and in total. A failed run
 * keeps one reason from a closed list and no numbers. A Claude Code folder with no `projects/` yet
 * reads zero and is not run (ccusage exits 1 there). This file opens nothing in an account folder:
 * ccusage reads the usage files the agent writes, and no login file is named, opened or listed here.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarnesses, type Harness } from '../harness-registry.ts'
import { accountFolders } from './codex.ts'
import { recordTokens, tokenRows, type TokenRun } from './store.ts'

export const KILL_MS = 60_000
export const TOKENS_EVERY_MS = 600_000
export const REFRESH_MIN_MS = 60_000
const MAX_STDOUT = 8 * 1024 * 1024
/** Release layout: `<tree>/runtime/bridge/usage/ccusage.ts` -> `<tree>/libexec/ccusage`. */
const DEFAULT_BIN = fileURLToPath(new URL('../../../libexec/ccusage', import.meta.url))

const expand = (p: string) => resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const exists = (p: string) => { try { lstatSync(p); return true } catch { return false } }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type AgentRow = {
  /** The folder variable ccusage reads for this agent. */
  env: string
  /** A limit source exists (bridge/usage/claude.ts, codex.ts); else `limit: not available` (H23). */
  limit: boolean
  /** Unlisted folders are named after their realpath's base name (as claude.ts accountOf names them). */
  nameByRealpath?: boolean
  /** The folder ccusage reads inside the account folder. Not there yet: no usage, so zero totals and no run (ccusage exits 1 on it). */
  usageDir?: string
  /** The agent's default account folder (run only when it exists). */
  defaultFolder?: (h: Harness, agent: string) => string
  /** No single default folder: when one of these exists under HOME, one run with the variable unset (ccusage's own roots), named after the agent. */
  defaultRoots?: string[]
}
const accountDir = (h: Harness) => (h.account_dir ? expand(h.account_dir) : undefined)
const xdgData = () => { const x = process.env.XDG_DATA_HOME; return x && isAbsolute(x) ? x : join(homedir(), '.local', 'share') }
/** The ccusage sources Tandem runs, by harness name (the same word is ccusage's command): only these five. */
export const CCUSAGE_AGENTS: Readonly<Record<string, AgentRow>> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', limit: true, nameByRealpath: true, usageDir: 'projects', defaultFolder: (h) => accountDir(h) ?? join(homedir(), '.claude') },
  codex: { env: 'CODEX_HOME', limit: true, defaultFolder: (h) => accountDir(h) ?? join(homedir(), '.codex') },
  grok: { env: 'GROK_HOME', limit: false, defaultFolder: () => join(homedir(), '.grok') },
  // $XDG_DATA_HOME/opencode, else ~/.local/share/opencode.
  opencode: { env: 'OPENCODE_DATA_DIR', limit: false, defaultFolder: (_h, agent) => join(xdgData(), agent) },
  antigravity: {
    env: 'ANTIGRAVITY_DATA_DIR', limit: false,
    defaultRoots: ['.gemini/antigravity', '.gemini/antigravity-cli', '.gemini/antigravity-ide', '.gemini/antigravity-backup', '.gemini/antigravity-acp', '.config/antigravity'],
  },
}
const FOLDER_VARS = Object.values(CCUSAGE_AGENTS).map((a) => a.env)
/** All the helper gets from the bridge's environment; its agent's folder variable is added per run. */
export const HELPER_ENV: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR']

/** One daily row's (or the totals') numbers; undefined when they are not whole non-negative tokens and a finite non-negative cost. */
function numbers(v: unknown): { tokens: number; cost: number } | undefined {
  if (!isObject(v)) return undefined
  const tokens = v.totalTokens
  const cost = v.totalCost ?? v.costUSD
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0 || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined
  return { tokens, cost: cost + 0 }
}
const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `ccusage <agent> daily --json` output as numbers: today (the row dated `now`'s local date, else 0) and total (`totals`, else the rows' sum). */
export function parseDaily(stdout: string, now: number): { today: { tokens: number; cost: number }; total: { tokens: number; cost: number } } | undefined {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { return undefined }
  if (!isObject(v) || !Array.isArray(v.daily)) return undefined
  const day = localDate(now)
  const today = { tokens: 0, cost: 0 }
  const sum = { tokens: 0, cost: 0 }
  for (const row of v.daily) {
    const n = numbers(row)
    if (!n) return undefined
    sum.tokens += n.tokens
    sum.cost += n.cost
    if ((row as Record<string, unknown>).date === day) {
      today.tokens += n.tokens
      today.cost += n.cost
    }
  }
  const total = v.totals === undefined ? sum : numbers(v.totals)
  if (!total || !Number.isSafeInteger(sum.tokens)) return undefined
  return { today, total }
}

export interface TokenOptions {
  bin?: string
  timeoutMs?: number
  harnesses?: Iterable<Harness>
  /** Tests only (a logging proxy): more variables for the helper. A folder variable here is dropped. */
  extraEnv?: Readonly<Record<string, string>>
}
type Job = { agent: string; row: AgentRow; name: string; folder: string | undefined; listed: boolean }
type Result = Omit<TokenRun, 'account' | 'agent'>

/** Every account of every loaded agent ccusage reads: usage.toml's and the default folder (codex.ts accountFolders). */
function jobs(harnesses: Harness[]): Job[] {
  const out: Job[] = []
  for (const [agent, row] of Object.entries(CCUSAGE_AGENTS)) {
    const h = harnesses.find((x) => x.name === agent)
    if (!h) continue
    for (const a of accountFolders(agent, row.defaultFolder?.(h, agent), row.nameByRealpath)) out.push({ agent, row, name: a.name, folder: a.folder, listed: a.listed })
    // ponytail: a listed folder equal to one of these roots is counted twice; realpath-check the roots if anyone lists one.
    if (row.defaultRoots?.some((r) => exists(join(homedir(), r)))) out.push({ agent, row, name: agent, folder: undefined, listed: false })
  }
  return out
}

const isHelper = (bin: string) => {
  try {
    if (!statSync(bin).isFile()) return false
    accessSync(bin, constants.X_OK)
    return true
  } catch { return false }
}
const spawnReason = (e: unknown) => {
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? `spawn ${code}` : 'spawn error'
}

/** The run in flight (one at a time), killed by its process group on stop. */
let running: ChildProcess | undefined
const killGroup = (pid: number | undefined) => { if (pid) try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }

function runOnce(bin: string, job: Job, timeoutMs: number, now: number, extraEnv: TokenOptions['extraEnv']): Promise<Result> {
  return new Promise((done) => {
    const env: Record<string, string> = {}
    for (const v of HELPER_ENV) if (process.env[v] !== undefined) env[v] = process.env[v]!
    Object.assign(env, extraEnv)
    for (const v of FOLDER_VARS) delete env[v]
    if (job.folder !== undefined) env[job.row.env] = job.folder
    let child: ChildProcess
    try {
      child = spawn(bin, [job.agent, 'daily', '--json', '--offline'], { cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (e) {
      done({ reason: spawnReason(e) })
      return
    }
    running = child
    let settled = false
    let reason: string | undefined
    const finish = (r: Result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (running === child) running = undefined
      done(r)
    }
    const kill = (why: string) => {
      reason ??= why
      killGroup(child.pid)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const timer = setTimeout(() => kill('timed out'), timeoutMs)
    const chunks: Buffer[] = []
    let size = 0
    child.stdout!.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_STDOUT) kill('output not readable')
      else chunks.push(c)
    })
    // Drained and dropped: never stored, never logged.
    child.stderr!.on('data', () => {})
    child.on('error', (e) => { if (child.pid === undefined) finish({ reason: spawnReason(e) }) })
    child.on('close', (code, signal) => {
      if (reason) return finish({ reason })
      if (signal) return finish({ reason: `signal ${signal}` })
      if (code !== 0) return finish({ reason: `exit ${code}` })
      const parsed = parseDaily(Buffer.concat(chunks).toString('utf8'), now)
      finish(parsed ?? { reason: 'output not readable' })
    })
  })
}

function runJob(job: Job, bin: string, helper: boolean, opts: TokenOptions, now: number): Promise<Result> | Result {
  // ccusage splits CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_DATA_DIR and ANTIGRAVITY_DATA_DIR on `,`.
  if (job.folder?.includes(',')) return { reason: 'folder name has a comma' }
  if (job.folder !== undefined && job.listed && !exists(job.folder)) return { reason: 'folder missing' }
  if (!helper) return { reason: 'helper missing' }
  // ccusage also takes the usage folder itself as the account folder, so a folder of that name is left to it.
  if (job.folder !== undefined && job.row.usageDir && basename(job.folder) !== job.row.usageDir && !exists(join(job.folder, job.row.usageDir))) {
    return { today: { tokens: 0, cost: 0 }, total: { tokens: 0, cost: 0 } }
  }
  return runOnce(bin, job, opts.timeoutMs ?? KILL_MS, now, opts.extraEnv)
}

/** Bumped by stopTokens: a pass started before it records nothing more. */
let generation = 0
let flight: Promise<boolean> | undefined
let lastStart: number | undefined

async function pass(now: number, opts: TokenOptions, gen: number): Promise<void> {
  // Always a path: a bare name would be looked up on PATH by spawn.
  const bin = resolve(opts.bin ?? DEFAULT_BIN)
  const helper = isHelper(bin)
  for (const job of jobs([...(opts.harnesses ?? loadHarnesses().harnesses.values())])) {
    if (gen !== generation) return
    const result = await runJob(job, bin, helper, opts, now)
    if (gen !== generation) return
    recordTokens([{ account: job.name, agent: job.agent, ...result }], now)
  }
}

/** One token pass over every account; while one is in flight, that one (its promise) instead. */
export function collectTokens(now: number, opts: TokenOptions = {}): Promise<boolean> {
  if (flight) return flight
  lastStart = now
  const p = pass(now, opts, generation).catch((e) => {
    const code = (e as { code?: unknown } | undefined)?.code
    process.stderr.write(`usage: token pass failed (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'})\n`)
  }).then(() => {
    if (flight === p) flight = undefined
    return true
  })
  flight = p
  return p
}

/** On demand: the pass in flight; false (nothing run) when the last pass started under REFRESH_MIN_MS before `now`; else a new pass (true). */
export function refreshTokens(now: number, opts: TokenOptions = {}): Promise<boolean> {
  if (flight) return flight
  if (lastStart !== undefined && now >= lastStart && now - lastStart < REFRESH_MIN_MS) return Promise.resolve(false)
  return collectTokens(now, opts)
}

/** Ends the pass in flight: its run is killed by its process group and nothing more is recorded. */
export function stopTokens(): void {
  generation++
  if (running) killGroup(running.pid)
}

export interface TokenUsage {
  account: string
  agent: string
  at: number
  ageMs: number
  tokens: { today: number; total: number } | null
  cost_usd: { today: number; total: number } | null
  tokens_note: string | null
  limit_note: string | null
}

/** Every account's last run as of `now`. */
export function readTokens(now: number): TokenUsage[] {
  return tokenRows().map((r) => {
    const ok = r.reason === null && r.tokens_today !== null && r.tokens_total !== null && r.cost_today !== null && r.cost_total !== null
    return {
      account: r.account, agent: r.agent, at: r.read_ms, ageMs: now - r.read_ms,
      tokens: ok ? { today: r.tokens_today!, total: r.tokens_total! } : null,
      cost_usd: ok ? { today: r.cost_today!, total: r.cost_total! } : null,
      tokens_note: r.reason === null ? null : `tokens: not available (${r.reason})`,
      limit_note: CCUSAGE_AGENTS[r.agent]?.limit === false ? 'limit: not available' : null,
    }
  })
}
