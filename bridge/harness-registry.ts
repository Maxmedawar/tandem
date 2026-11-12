/**
 * harness-registry.ts: loads harness files, the TOML files that each describe one CLI
 * agent (format: harnesses/SCHEMA.md).
 *
 * A harness file is data that names a program, so it is treated as a program: it loads
 * only from the built-in folder (core `harnesses/`) and the owner folder
 * (`$TANDEM_HOME/harnesses`, else `~/.tandem/harnesses`, mode 0700), it cannot replace a
 * built-in, a key field holds only named keys, a shell or interpreter is marked
 * `kind = 'shell'` whatever the file calls itself, and loading reads files only: it
 * starts no process. A bad file never throws; it lands in `errors` and the rest load.
 *
 * An agent that is not a terminal program runs through a small code adapter instead of a
 * program: a built-in file names it with `adapter`, and ADAPTERS below is the table of them.
 */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { tandemHome } from './tandem-home.ts'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { RE2JS } from 're2js'
import { HOOK_OPTION, setUsageSource } from './delivery-hooks.ts'
import type { DrivableSession, EngineDescriptor } from './drivable.ts'
import { openHermes } from './engines/hermes.ts'
import { usageSource } from './usage/claude.ts'

// installHook gives a `usage = "statusline"` harness its statusLine through this (bridge/usage/claude.ts).
setUsageSource(usageSource)

export type StateName = 'working' | 'idle' | 'waiting_for_approval'
export type KeySpec = string | string[]
/** One `[[dialogs]]` row: a first-run dialog and the one answer warmup may give (bridge/terminal-session.ts). */
export type Dialog = NonNullable<EngineDescriptor['dialogs']>[number]

export interface Harness {
  name: string
  /** Absent in an adapter file (`adapter`): such an agent has no program. */
  program?: string
  args: string[]
  skip_prompts_args: string[]
  resume: string[]
  fork: string[]
  has_prompts: boolean
  account_env?: string
  history?: string
  states?: { working?: string[]; idle?: string[]; waiting_for_approval?: string[]; empty_prompt?: string[]; debounce_ms: number; precedence: StateName[] }
  keys?: { approve?: KeySpec; deny?: KeySpec; interrupt?: KeySpec }
  dialogs?: Dialog[]
  delivery: 'hook' | 'notice'
  hook?: string
  /** How `hook` is used: one settings file (absent = this) or Codex-style `--config` values (U-R1A-26). */
  hook_format?: 'settings-file' | 'config-overrides'
  /** How the agent hands environment to a stdio MCP server it starts (U-R1A-36C); absent = unknown. */
  mcp_env?: 'inherit' | 'config-overrides' | 'unknown'
  /** How the agent reports its account's limits (U-R1A-49): `statusline` = a statusLine command in its settings file. */
  usage?: 'statusline' | 'rollout'
  /** The agent's default account folder when its `account_env` variable is unset (`/` or `~/`). */
  account_dir?: string
  permission_hook: boolean
  reports_context: boolean
  adapter?: string
  logo?: string
  source: 'builtin' | 'owner'
  file: string
  kind: 'agent' | 'shell'
  programPath?: string
}

export interface HarnessError { file: string; reason: string }

/** An adapter's open: a session to register, or a refusal (HTTP status, error text, the audit line's `denied`). */
export type AdapterOpenResult = { session: DrivableSession } | { status: number; error: string; denied: string }

/** The built-in adapters by name, the values an `adapter` field may hold. The router opens an
 *  adapter agent through `ADAPTERS[harness.adapter]`; nothing else names one. */
export const ADAPTERS: Readonly<Record<string, (name: string) => Promise<AdapterOpenResult>>> = Object.freeze({ hermes: openHermes })

const MAX_BYTES = 64 * 1024
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
/** The session list filter reads `all` (every agent) and `terminal` (the shell). */
const RESERVED_NAMES = new Set(['all', 'terminal'])
/** No leading `-` (a launcher such as tmux would read it as an option, `--` hands it the next argument). */
const BARE_PROGRAM = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/
/** Each part of an absolute path in the bare-name characters: no space, quote, glob or backslash that sh -c would turn into another program. */
const ABS_PROGRAM = /^(\/[A-Za-z0-9._+-]+)+$/
const ACCOUNT_ENV = /^[A-Z][A-Z0-9_]{0,63}$/
const LOGO = /^[a-z0-9-]+\.(svg|png)$/
const NAMED_KEY = /^(Enter|Escape|Tab|BTab|Space|BSpace|Up|Down|Left|Right|Home|End|PageUp|PageDown|C-[a-z]|F[1-9]|F1[0-2]|[a-z0-9])$/
/** Command text: no control, format (bidi, zero-width) or line-separator character, no shell character, no brace once `{id}` is removed. */
const BAD_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`$;|&<>{}]/u
const FIELDS = ['name', 'program', 'args', 'skip_prompts_args', 'resume', 'fork', 'has_prompts', 'account_env', 'history',
  'states', 'keys', 'dialogs', 'delivery', 'hook', 'hook_format', 'mcp_env', 'usage', 'account_dir', 'permission_hook', 'reports_context', 'adapter', 'logo']
const STATE_NAMES: StateName[] = ['working', 'idle', 'waiting_for_approval']
const KEY_NAMES = ['approve', 'deny', 'interrupt'] as const
/** Text that is never typed as a dialog answer, and a screen showing it is never answered (sign-in, purchase). */
export const NEVER = /sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|login|purchase|buy|subscri|payment|billing|credit card/i
/** Update text. No answer holds it, and a screen showing it is answered only by an `update` dialog that skips. */
export const UPDATE_TEXT = /updat|install|upgrad/i
/** The answers an `update` dialog may give: it is only ever skipped. */
export const SKIPS_UPDATE = /^(?:skip|not now|later|no|dismiss|remind)\b/i
const DIALOG_FIELDS = ['name', 'kind', 'match', 'answer', 'highlight', 'key']
const DIALOG_KINDS = ['trust', 'update', 'bypass']
/** Select-mode markers; key mode's start form `[k] ` may follow one of them too. */
export const HIGHLIGHTS = ['❯', '›', '>', '●', '▶']
/** A trust answer naming a wider scope than this folder. */
const WIDE_TRUST = /parent|\ball\b|always|every/i
const DIALOG_KEY = /^[a-z0-9]$/
const SHELLS = new Set(('sh bash zsh dash ksh mksh yash csh tcsh fish nu xonsh elvish pwsh powershell cmd busybox env sudo doas ' +
  'su nohup nice timeout xargs script expect python pypy perl ruby php node nodejs bun deno lua luajit tclsh wish osascript ' +
  'awk gawk mawk').split(' '))

type Table = Record<string, unknown>

const fail = (reason: string): never => { throw new Error(reason) }
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
const compact = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

function only(t: Table, allowed: readonly string[], prefix: string): void {
  for (const k of Object.keys(t)) if (!allowed.includes(k)) fail(`unknown field ${prefix}${k}`)
}
function str(t: Table, k: string, prefix = ''): string | undefined {
  const v = t[k]
  if (v !== undefined && typeof v !== 'string') fail(`wrong type for ${prefix}${k}: expected a string`)
  return v as string | undefined
}
function strs(t: Table, k: string, prefix = ''): string[] | undefined {
  const v = t[k]
  if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) fail(`wrong type for ${prefix}${k}: expected an array of strings`)
  return v as string[] | undefined
}
function bool(t: Table, k: string): boolean | undefined {
  const v = t[k]
  if (v !== undefined && typeof v !== 'boolean') fail(`wrong type for ${k}: expected true or false`)
  return v as boolean | undefined
}
function table(t: Table, k: string): Table | undefined {
  const v = t[k]
  if (v !== undefined && !isTable(v)) fail(`wrong type for ${k}: expected a table`)
  return v as Table | undefined
}

/** `[[dialogs]]`: 0 to 8 tables. `match` and `highlight` are screen text, exempt from the command text rules; `answer` is command text. */
function dialogsOf(raw: Table): Dialog[] | undefined {
  const v = raw.dialogs
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every(isTable)) fail('wrong type for dialogs: expected [[dialogs]] tables')
  const rows = v as Table[]
  if (rows.length > 8) fail('dialogs: at most 8')
  const names = new Set<string>()
  return rows.map((t, i) => {
    const at = `dialogs[${i}].`
    only(t, DIALOG_FIELDS, at)
    const name = str(t, 'name', at) ?? fail(`missing ${at}name`)
    if (!NAME.test(name)) fail(`bad ${at}name`)
    if (names.has(name)) fail(`duplicate ${at}name: each dialog name once in a file`)
    names.add(name)
    const kind = str(t, 'kind', at) ?? fail(`missing ${at}kind`)
    if (!DIALOG_KINDS.includes(kind)) fail(`bad ${at}kind: "trust", "update" or "bypass"`)
    const match = strs(t, 'match', at) ?? fail(`missing ${at}match`)
    if (match.length < 1 || match.length > 4) fail(`${at}match: 1 to 4 patterns`)
    for (const p of match) {
      try { RE2JS.compile(p) } catch { fail(`bad pattern in ${at}match`) }
    }
    const answer = str(t, 'answer', at) ?? fail(`missing ${at}answer`)
    if ([...answer].length < 1 || [...answer].length > 80) fail(`${at}answer: 1 to 80 characters`)
    checkText(answer, `${at}answer`)
    if (NEVER.test(answer)) fail(`${at}answer: a sign-in or purchase answer is never typed`)
    if (UPDATE_TEXT.test(answer)) fail(`${at}answer: an update is never started (an update dialog may only be skipped)`)
    if (kind === 'update' && !SKIPS_UPDATE.test(answer)) fail(`${at}answer: an update dialog may only be skipped (Skip, Not now, Later, No, Dismiss, Remind)`)
    if (kind === 'trust' && WIDE_TRUST.test(answer)) fail(`${at}answer: a trust answer trusts this folder only (never parent, all, always or every)`)
    const highlight = str(t, 'highlight', at)
    const key = str(t, 'key', at)
    if ((highlight === undefined) === (key === undefined)) fail(`${at}highlight or ${at}key: exactly one of them`)
    if (highlight !== undefined && !HIGHLIGHTS.includes(highlight)) fail(`bad ${at}highlight: one of ${HIGHLIGHTS.join(' ')}`)
    if (key !== undefined && !DIALOG_KEY.test(key)) fail(`bad ${at}key: one character a-z or 0-9`)
    return compact({ name, kind: kind as Dialog['kind'], match, answer, highlight: highlight as Dialog['highlight'], key })
  })
}

/** Every string outside `states` and `dialogs` is command text. */
function checkText(v: unknown, where: string): void {
  if (typeof v === 'string') { if (BAD_TEXT.test(v.replaceAll('{id}', ''))) fail(`forbidden character in ${where}`) }
  else if (Array.isArray(v)) for (const x of v) checkText(x, where)
  else if (isTable(v)) for (const [k, x] of Object.entries(v)) checkText(x, `${where}.${k}`)
}

function validate(raw: Table, stem: string, source: Harness['source']): Omit<Harness, 'source' | 'file' | 'kind' | 'programPath'> {
  only(raw, FIELDS, '')
  const name = str(raw, 'name') ?? fail('missing name')
  if (name !== stem) fail('name does not match the file name')
  const adapter = str(raw, 'adapter')
  if (adapter !== undefined && source !== 'builtin') fail('adapter is allowed only in a built-in file')
  if (adapter !== undefined && !Object.hasOwn(ADAPTERS, adapter)) fail(`bad adapter: one of ${Object.keys(ADAPTERS).join(', ')}`)
  const program = str(raw, 'program')
  if (adapter !== undefined && program !== undefined) fail('an adapter file names no program')
  if (adapter === undefined && program === undefined) fail('missing program')
  if (program !== undefined) {
    const bare = BARE_PROGRAM.test(program) && program !== '.' && program !== '..'
    if (!bare && !(ABS_PROGRAM.test(program) && !program.includes('..'))) fail('bad program: a bare name or an absolute path without .. (letters, digits and . _ + - only)')
  }
  const has_prompts = bool(raw, 'has_prompts') ?? fail('missing has_prompts')
  const account_env = str(raw, 'account_env')
  if (account_env !== undefined && !ACCOUNT_ENV.test(account_env)) fail('bad account_env')
  const history = str(raw, 'history')
  if (history !== undefined && !history.startsWith('/') && !history.startsWith('~/')) fail('bad history: must start with / or ~/')

  let states: Harness['states']
  const st = table(raw, 'states')
  if (st) {
    only(st, [...STATE_NAMES, 'empty_prompt', 'debounce_ms', 'precedence'], 'states.')
    const pats: Partial<Record<StateName, string[]>> = {}
    for (const s of STATE_NAMES) {
      pats[s] = strs(st, s, 'states.')
      for (const p of pats[s] ?? []) {
        try { RE2JS.compile(p) } catch { fail(`bad pattern in states.${s}`) }
      }
    }
    const empty_prompt = strs(st, 'empty_prompt', 'states.')
    if (empty_prompt !== undefined && (empty_prompt.length < 1 || empty_prompt.length > 8)) fail('bad states.empty_prompt: 1 to 8 patterns')
    for (const p of empty_prompt ?? []) {
      try { RE2JS.compile(p) } catch { fail('bad pattern in states.empty_prompt') }
    }
    const d = st.debounce_ms ?? 1500n
    if (typeof d !== 'bigint') fail('wrong type for states.debounce_ms: expected an integer')
    if ((d as bigint) < 0n || (d as bigint) > 10000n) fail('bad states.debounce_ms: 0 to 10000')
    const precedence = strs(st, 'precedence', 'states.') ?? ['waiting_for_approval', 'working', 'idle']
    if (precedence.length !== 3 || STATE_NAMES.some((s) => !precedence.includes(s))) fail('bad states.precedence: all three state names, each once')
    states = compact({ ...pats, empty_prompt, debounce_ms: Number(d), precedence: precedence as StateName[] })
  }

  let keys: Harness['keys']
  const kt = table(raw, 'keys')
  if (kt) {
    only(kt, KEY_NAMES, 'keys.')
    keys = {}
    for (const k of KEY_NAMES) {
      const v = kt[k]
      if (v === undefined) continue
      const list = typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : fail(`wrong type for keys.${k}: expected a key or an array of keys`)
      if (list.length > 4) fail(`keys.${k}: at most 4 keys`)
      if (list.length === 0 || !list.every((x) => NAMED_KEY.test(x))) fail(`bad key in keys.${k}`)
      keys[k] = v as KeySpec
    }
  }

  const dialogs = dialogsOf(raw)

  const delivery = str(raw, 'delivery') ?? 'notice'
  if (delivery !== 'hook' && delivery !== 'notice') fail('bad delivery: "hook" or "notice"')
  const hook = str(raw, 'hook')
  if (delivery === 'hook' && !hook) fail('delivery = "hook" needs hook')
  if (hook !== undefined && !HOOK_OPTION.test(hook)) fail('bad hook: the option that loads a settings file, such as --settings')
  const hook_format = str(raw, 'hook_format')
  if (hook_format !== undefined && !hook) fail('hook_format needs hook')
  if (hook_format !== undefined && hook_format !== 'settings-file' && hook_format !== 'config-overrides') fail('bad hook_format: "settings-file" or "config-overrides"')
  const mcp_env = raw.mcp_env
  if (mcp_env !== undefined && mcp_env !== 'inherit' && mcp_env !== 'config-overrides' && mcp_env !== 'unknown') fail('bad mcp_env: "inherit", "config-overrides" or "unknown"')
  // Tandem's own MCP server rides on the hook's --config values (bridge/delivery-hooks.ts mcpOverrides).
  if (mcp_env === 'config-overrides' && hook_format !== 'config-overrides') fail('mcp_env "config-overrides" needs hook_format "config-overrides"')
  const usage = raw.usage
  if (usage !== undefined && usage !== 'statusline' && usage !== 'rollout') fail('bad usage: "statusline"')
  // The statusLine rides in the per-session settings file (bridge/delivery-hooks.ts installHook).
  if (usage === 'statusline' && (delivery !== 'hook' || hook_format === 'config-overrides')) fail('usage "statusline" needs a settings-file hook')
  const account_dir = str(raw, 'account_dir')
  if (account_dir !== undefined && !account_dir.startsWith('/') && !account_dir.startsWith('~/')) fail('bad account_dir: must start with / or ~/')
  // The rollout reader reads the default account folder and usage.toml's (bridge/usage/codex.ts).
  if (usage === 'rollout' && account_dir === undefined) fail('usage "rollout" needs account_dir')
  const logo = str(raw, 'logo')
  if (logo !== undefined && !LOGO.test(logo)) fail('bad logo')

  const out = compact({
    name, program,
    args: strs(raw, 'args') ?? [],
    skip_prompts_args: strs(raw, 'skip_prompts_args') ?? [],
    resume: strs(raw, 'resume') ?? [],
    fork: strs(raw, 'fork') ?? [],
    has_prompts, account_env, history, states, keys, dialogs,
    delivery: delivery as Harness['delivery'], hook, hook_format: hook_format as Harness['hook_format'],
    mcp_env: mcp_env as Harness['mcp_env'],
    usage: usage as Harness['usage'], account_dir,
    permission_hook: bool(raw, 'permission_hook') ?? false,
    reports_context: bool(raw, 'reports_context') ?? false,
    adapter, logo,
  })
  for (const [k, v] of Object.entries(raw)) if (k !== 'states' && k !== 'dialogs') checkText(v, k)
  return out
}

/** Reads one `*.toml` entry without following a symlink or blocking on a FIFO. */
function readToml(file: string, stem: string, owner: boolean): Table {
  if (!NAME.test(stem)) fail('bad file name: must be <name>.toml with a valid name')
  if (RESERVED_NAMES.has(stem)) fail('reserved name: the session list filter uses "all" and "terminal"')
  const st = lstatSync(file)
  if (st.isSymbolicLink()) fail('symlink: a harness file must be a regular file')
  if (!st.isFile()) fail('not a regular file')
  if (st.size > MAX_BYTES) fail('over 64 KiB')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let buf: Buffer
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile()) fail('not a regular file')
    if (owner && process.getuid !== undefined && fst.uid !== process.getuid()) fail('owner file is not owned by the current user')
    if (owner && (fst.mode & 0o022) !== 0) fail('owner file must not be writable by group or others')
    buf = readFileSync(fd)
  } finally { closeSync(fd) }
  if (buf.length > MAX_BYTES) fail('over 64 KiB')
  let text = ''
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { fail('not UTF-8 text') }
  try { return parse(text, { integersAsBigInt: true }) as Table } catch (e) {
    return fail(`TOML syntax error at line ${(e as { line?: number }).line ?? '?'}`)
  }
}

function isProgramFile(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false }
}

/** `program` itself when absolute, else the first PATH entry holding it. fs only, never a lookup process. */
function findProgram(program: string, searchPath: string): string | undefined {
  if (program.startsWith('/')) return isProgramFile(program) ? program : undefined
  for (const dir of searchPath.split(delimiter)) {
    if (isAbsolute(dir) && isProgramFile(join(dir, program))) return join(dir, program)
  }
  return undefined
}

function isShell(p: string): boolean {
  return SHELLS.has(basename(p).toLowerCase().replace(/\.exe$/, '').replace(/[0-9.-]+$/, ''))
}

function kindOf(program: string, programPath: string | undefined): Harness['kind'] {
  if (isShell(program)) return 'shell'
  if (programPath === undefined) return 'agent'
  try { return isShell(realpathSync(programPath)) ? 'shell' : 'agent' } catch { return 'shell' }
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The `*.toml` entry names directly inside `dir`; a missing folder has none. */
function listToml(dir: string, errors: HarnessError[]): string[] {
  try { return readdirSync(dir).filter((n) => n.endsWith('.toml')).sort() } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ file: dir, reason: `folder unreadable: ${(e as NodeJS.ErrnoException).code}` })
    return []
  }
}

/** The owner folder loads only when it is a real folder, mode 0700, owned by the current user. */
function ownerFolderOk(dir: string, errors: HarnessError[]): boolean {
  let st
  try { st = lstatSync(dir) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ file: dir, reason: `owner folder unreadable: ${(e as NodeJS.ErrnoException).code}` })
    return false
  }
  const reason = !st.isDirectory() ? 'owner folder is not a folder'
    : (st.mode & 0o777) !== 0o700 ? 'owner folder must be mode 0700'
    : process.getuid !== undefined && st.uid !== process.getuid() ? 'owner folder is not owned by the current user'
    : undefined
  if (reason) errors.push({ file: dir, reason })
  return reason === undefined
}

export function loadHarnesses(opts: { installDir?: string; ownerDir?: string; path?: string } = {}): {
  harnesses: Map<string, Harness>
  errors: HarnessError[]
} {
  const installDir = opts.installDir ?? fileURLToPath(new URL('../harnesses/', import.meta.url))
  const ownerDir = opts.ownerDir ?? join(tandemHome(), 'harnesses')
  const searchPath = opts.path ?? process.env.PATH ?? ''
  const harnesses = new Map<string, Harness>()
  const errors: HarnessError[] = []

  const add = (raw: Table, stem: string, source: Harness['source'], file: string) => {
    const h = validate(raw, stem, source)
    // An adapter file has no program: no PATH lookup, and it is an agent.
    const programPath = h.program === undefined ? undefined : findProgram(h.program, searchPath)
    const kind = h.program === undefined ? 'agent' : kindOf(h.program, programPath)
    harnesses.set(h.name, compact({ ...h, source, file, kind, programPath }))
  }

  // Built-in names are reserved even when that built-in file is itself refused.
  const builtinNames = new Set<string>()
  for (const entry of listToml(installDir, errors)) {
    const file = join(installDir, entry)
    builtinNames.add(entry.slice(0, -5))
    try { add(readToml(file, entry.slice(0, -5), false), entry.slice(0, -5), 'builtin', file) } catch (e) { errors.push({ file, reason: reasonOf(e) }) }
  }

  const owned: { file: string; stem: string; raw: Table }[] = []
  for (const entry of ownerFolderOk(ownerDir, errors) ? listToml(ownerDir, errors) : []) {
    const file = join(ownerDir, entry)
    try { owned.push({ file, stem: entry.slice(0, -5), raw: readToml(file, entry.slice(0, -5), true) }) } catch (e) { errors.push({ file, reason: reasonOf(e) }) }
  }
  const claims = new Map<unknown, number>()
  for (const o of owned) if (typeof o.raw.name === 'string') claims.set(o.raw.name, (claims.get(o.raw.name) ?? 0) + 1)
  for (const { file, stem, raw } of owned) {
    try {
      if (builtinNames.has(stem) || builtinNames.has(raw.name as string)) fail('built-in name: an owner file cannot replace a built-in')
      if ((claims.get(raw.name) ?? 0) > 1) fail('duplicate owner name: two owner files claim this name')
      add(raw, stem, 'owner', file)
    } catch (e) { errors.push({ file, reason: reasonOf(e) }) }
  }
  return { harnesses, errors }
}
