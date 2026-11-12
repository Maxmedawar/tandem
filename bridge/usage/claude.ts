/**
 * claude.ts: which account a session reports under, and the statusLine Tandem gives a harness with
 * `usage = "statusline"` (bridge/delivery-hooks.ts installHook). Usage is read only: this opens an
 * account folder's `settings.json` and `<TANDEM_HOME>/usage.toml`, nothing else; never a login file.
 *
 * Account of a session: the folder its harness's `account_env` variable names (absolute), else the
 * harness's `account_dir` (`~/` is this user's home), its realpath when it exists. Its name is the
 * usage.toml entry for that agent and folder, else the folder's base name (leading dots removed,
 * lowercased, other characters `-`, at most 64, empty = `default`). Two unlisted folders with one
 * base name share a name; listing them in usage.toml tells them apart (docs/USAGE.md).
 */
import { realpathSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { tandemHome } from '../tandem-home.ts'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { readProtectedRegularFileSync, UnsafeRuntimeConfigError } from '../../src/runtime-config.ts'
import type { Harness } from '../harness-registry.ts'

/** An account name: also the drop file's name. */
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,63}$/
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_SETTINGS = 64 * 1024

/** `<TANDEM_HOME>/usage/<harness name>`: the folder of one agent's drop files. */
export const dropDirOf = (agent: string) => join(tandemHome(), 'usage', agent)

const expand = (p: string) => resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const real = (p: string) => { try { return realpathSync(p) } catch { return p } }

/** A folder's base name as an account name. */
export function nameFromFolder(folder: string): string {
  // A leading `-` goes too: a name never starts with one (ACCOUNT).
  const n = basename(folder).replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 64)
  return n === '' ? 'default' : n
}

type Listed = { name: string; agent: string; folder: string }

/** usage.toml's accounts; missing = none; refused = none and one stderr line. */
export function listedAccounts(): Listed[] {
  let bytes: Buffer
  try {
    bytes = readProtectedRegularFileSync(join(tandemHome(), 'usage.toml'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    const reason = e instanceof UnsafeRuntimeConfigError ? e.message.replace('protected file', 'usage.toml') : `usage.toml unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`
    process.stderr.write(`usage: ${reason}; accounts are named after their folders\n`)
    return []
  }
  try {
    return parseAccounts(bytes.toString('utf8'))
  } catch (e) {
    process.stderr.write(`usage: ${(e as Error).message}; accounts are named after their folders\n`)
    return []
  }
}

function parseAccounts(text: string): Listed[] {
  let raw: Record<string, unknown>
  try { raw = parse(text) as Record<string, unknown> } catch { throw new Error('usage.toml is not valid TOML') }
  for (const k of Object.keys(raw)) if (k !== 'accounts') throw new Error('usage.toml: only [[accounts]] tables')
  const rows = raw.accounts ?? []
  if (!Array.isArray(rows)) throw new Error('usage.toml: only [[accounts]] tables')
  const names = new Set<string>()
  return rows.map((t: unknown) => {
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new Error('usage.toml: only [[accounts]] tables')
    const { name, agent, folder, ...rest } = t as Record<string, unknown>
    if (Object.keys(rest).length > 0) throw new Error('usage.toml: an account holds exactly name, agent and folder')
    if (typeof name !== 'string' || !ACCOUNT.test(name)) throw new Error('usage.toml: a bad account name')
    if (names.has(name)) throw new Error('usage.toml: an account name twice')
    names.add(name)
    if (typeof agent !== 'string' || !AGENT.test(agent)) throw new Error('usage.toml: a bad agent name')
    if (typeof folder !== 'string' || !(folder.startsWith('/') || folder.startsWith('~/'))) throw new Error('usage.toml: a folder must start with / or ~/')
    return { name, agent, folder }
  })
}

/** The account a session of `harness` reports under, worked out now. */
export function accountOf(harness: Harness): { folder: string | undefined; name: string } {
  const fromEnv = harness.account_env ? process.env[harness.account_env] : undefined
  const raw = fromEnv && isAbsolute(fromEnv) ? fromEnv : harness.account_dir ? expand(harness.account_dir) : undefined
  if (raw === undefined) return { folder: undefined, name: 'default' }
  const folder = real(resolve(raw))
  const listed = listedAccounts().find((a) => a.agent === harness.name && real(expand(a.folder)) === folder)
  return { folder, name: listed ? listed.name : nameFromFolder(folder) }
}

/** The account folder's own statusLine command (`settings.json`, at most 64 KiB); undefined when it names none or cannot be read. */
export function ownStatusLine(folder: string): { command: string; padding?: number } | undefined {
  try {
    const file = join(folder, 'settings.json')
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_SETTINGS) return undefined
    const sl = (JSON.parse(readFileSync(file, 'utf8')) as { statusLine?: unknown }).statusLine as Record<string, unknown> | undefined
    if (typeof sl !== 'object' || sl === null || sl.type !== 'command' || typeof sl.command !== 'string' || sl.command === '') return undefined
    return { command: sl.command, ...(typeof sl.padding === 'number' && Number.isFinite(sl.padding) ? { padding: sl.padding } : {}) }
  } catch {
    return undefined
  }
}

/** A session's statusLine parts for bridge/delivery-hooks.ts installHook (set as its UsageSource by bridge/harness-registry.ts). */
export function usageSource(harness: Harness): { folder?: string; account: string; script: string; drops: string; own?: { command: string; padding?: number } } {
  const { folder, name } = accountOf(harness)
  const own = folder === undefined ? undefined : ownStatusLine(folder)
  return {
    ...(folder === undefined ? {} : { folder }), account: name,
    script: fileURLToPath(new URL('./statusline-drop.ts', import.meta.url)),
    drops: dropDirOf(harness.name),
    ...(own ? { own } : {}),
  }
}
