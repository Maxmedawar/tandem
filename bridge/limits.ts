/**
 * limits.ts: the limits file, the ceiling on what sessions may start on this computer for the
 * fields `folders`, `agents`, `shell` and `permission_skip` (plan section 3), who may send mail at
 * the Interrupt level, `interrupt_from` (bridge/mailbox.ts; absent means nobody), and the most
 * sessions at once, `session_cap` (bridge/kill-switch.ts reserveSessions; absent means 12). The
 * bridge is the only place limits are enforced, and nothing remote can widen them.
 *
 * The file is `$TANDEM_HOME/limits.toml` when TANDEM_HOME is set, else `~/.tandem/limits.toml`,
 * worked out at each read. It is read once when this module is first imported (the bridge imports
 * the router at start) and kept as a snapshot plus the sha256 digest of the bytes read (`missing`
 * when there is no file). applyLimits() reads it again the same way; nothing else changes the
 * snapshot, and no route, MCP tool, hub frame or fleet op calls it (U-R1A-48 wires `tandem limits
 * apply` to it). A missing or refused file allows nothing and writes one stderr line.
 *
 * At each open and relay start the router takes limitsGate(), which reads the bytes on disk: when
 * their digest differs from the snapshot's, every refusal ends with a notice and stderr gets one
 * line the first time each new digest is seen. The snapshot is not touched.
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parse } from 'smol-toml'
import { readProtectedRegularFileSync } from '../src/runtime-config.ts'
import type { Harness } from './harness-registry.ts'
// U-R1A-33B-2: the mailbox checks a remote `to` against the roster through this module (its own import list is pinned).
export { thisId, trustedKey } from './roster.ts'
import { safeResolve } from './sessions.ts'

export interface AgentPin {
  program: string
  sha256?: string
}

export interface LimitsSnapshot {
  /** Real paths (real(): safeResolve plus the volume's own spelling), checked when the file was read. */
  folders: string[]
  shell: boolean
  permission_skip: string[]
  /** As written: each `program` is resolved at check time. */
  agents: Record<string, AgentPin>
  /** sha256 of the bytes read; `missing` for no file; `refused: <reason>` when no bytes could be read. */
  digest: string
  /** Mail senders (`owner`, `session:<name>`, `machine:<id>/owner`, `machine:<id>/session:<name>`) who may send Interrupt; present only when the file has it. */
  interrupt_from?: string[]
  /** The most sessions open at once on this computer, 1 to 100; 12 when absent, and when the file is missing or refused. */
  session_cap: number
  /** Why nothing is allowed (missing or refused file). */
  problem?: string
}

const FIELDS = ['folders', 'shell', 'permission_skip', 'agents', 'interrupt_from', 'session_cap']
const DEFAULT_SESSION_CAP = 12
const AGENT_FIELDS = ['program', 'sha256']
/** A harness name (harness-registry.ts). */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const NOTICE = ' (notice: the limits file changed on disk and is not applied; apply it at this computer)'

type Table = Record<string, unknown>
const fail = (reason: string): never => { throw new Error(reason) }
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A mail sender: `owner`, or `session:` and a session name (the mail recipient pattern, bridge/mailbox.ts). */
export function isMailSender(v: unknown): v is string {
  return typeof v === 'string' && (v === 'owner' || /^session:[A-Za-z0-9._-]{1,256}$/.test(v))
}

/**
 * A sender on another computer: `machine:<computer id>/owner` or `machine:<computer id>/session:<name>`.
 * Only the carrier (bridge/hub-mail.ts) stores one, from a signed envelope; no local caller can.
 */
export function isRemoteSender(v: unknown): v is string {
  return typeof v === 'string' && /^machine:[a-z0-9._-]{1,64}\/(owner|session:[A-Za-z0-9._-]{1,256})$/.test(v)
}

/** A sender `interrupt_from` may list: a local one or one on another computer. */
export function isInterruptSender(v: unknown): v is string {
  return isMailSender(v) || isRemoteSender(v)
}

export function limitsFile(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'limits.toml')
}

/**
 * safeResolve, then the spelling the volume itself holds for the part that exists (realpath(3)).
 * Node's own realpath keeps the caller's case, so on a case-insensitive volume (macOS) /users/x/work
 * and /Users/x/Work, one folder, would compare unequal: a case variant of the limits file's folder
 * would pass the "not in an allowed folder" rule. A part that does not exist keeps its spelling.
 */
function real(p: string): string {
  let abs = safeResolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(abs), ...tail.reverse())
    } catch {
      const parent = dirname(abs)
      if (parent === abs) return join(abs, ...tail.reverse())
      tail.push(basename(abs))
      abs = parent
    }
  }
}

/** True when `candidate` is one of the real paths `roots` or lies inside one ("/work" never holds "/work-evil"). */
function inside(candidate: string, roots: string[]): boolean {
  const path = real(candidate)
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

/** The file's folder must be yours and closed to group and others, or anyone there could put another file in its place. */
function checkFolder(dir: string): void {
  const info = statSync(dir)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail(`the folder ${dir} has the wrong owner`)
  if ((info.mode & 0o022) !== 0) fail(`the folder ${dir} is writable by group or others`)
}

/** The bytes on disk and their digest, or the marker for no file or a refused one. */
function readOnDisk(file: string): { bytes?: Buffer; digest: string; problem?: string } {
  try {
    checkFolder(dirname(file))
    const bytes = readProtectedRegularFileSync(file)
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { digest: 'missing', problem: `no limits file at ${file}` }
    return { digest: `refused: ${reasonOf(e)}`, problem: `${file}: ${reasonOf(e)}` }
  }
}

/** An absolute or `~/` path, no control character. */
function pathText(v: unknown, where: string): string {
  if (typeof v !== 'string') return fail(`wrong type for ${where}: expected a string`)
  if (HIDDEN.test(v)) fail(`control character in ${where}`)
  if (!v.startsWith('/') && !v.startsWith('~/')) fail(`relative path in ${where}: ${v}`)
  return v
}

/** A folder list as real paths; an entry that equals, holds or lies inside `fileDir` refuses the file. */
function folderList(raw: Table, field: string, fileDir: string): string[] {
  const v = raw[field] ?? []
  if (!Array.isArray(v)) fail(`wrong type for ${field}: expected an array of absolute or ~/ paths`)
  return (v as unknown[]).map((p) => {
    const path = real(pathText(p, field))
    if (inside(path, [fileDir]) || inside(fileDir, [path])) {
      fail(`${field} entry ${path} equals, holds or lies inside the limits file's folder ${fileDir}`)
    }
    return path
  })
}

function parseLimits(bytes: Buffer, fileDir: string): Omit<LimitsSnapshot, 'digest' | 'problem'> {
  let text = ''
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('not UTF-8 text') }
  let raw: Table = {}
  try { raw = parse(text) as Table } catch (e) { fail(`TOML syntax error at line ${(e as { line?: number }).line ?? '?'}`) }
  for (const k of Object.keys(raw)) if (!FIELDS.includes(k)) fail(`unknown field ${k}`)
  const shell = raw.shell ?? false
  if (typeof shell !== 'boolean') fail('wrong type for shell: expected true or false')
  const folders = folderList(raw, 'folders', fileDir)
  const permission_skip = folderList(raw, 'permission_skip', fileDir)
  const table = raw.agents ?? {}
  if (!isTable(table)) return fail('wrong type for agents: expected a table')
  const agents: Record<string, AgentPin> = {}
  for (const [name, v] of Object.entries(table)) {
    if (!AGENT_NAME.test(name)) fail(`bad agent name: ${JSON.stringify(name)}`)
    const where = `agents.${name}`
    if (!isTable(v)) return fail(`wrong type for ${where}: expected { program = "<absolute path>", sha256 = "<64 lowercase hex>" }`)
    for (const k of Object.keys(v)) if (!AGENT_FIELDS.includes(k)) fail(`unknown field ${where}.${k}`)
    if (v.program === undefined) fail(`missing ${where}.program`)
    const program = pathText(v.program, `${where}.program`)
    if (v.sha256 !== undefined && !(typeof v.sha256 === 'string' && SHA256.test(v.sha256))) fail(`bad sha256 in ${where}: 64 lowercase hex characters`)
    agents[name] = v.sha256 === undefined ? { program } : { program, sha256: v.sha256 as string }
  }
  const session_cap = raw.session_cap ?? DEFAULT_SESSION_CAP
  if (typeof session_cap !== 'number' || !Number.isInteger(session_cap) || session_cap < 1 || session_cap > 100) {
    fail('wrong type for session_cap: expected a whole number 1 to 100')
  }
  const from = raw.interrupt_from
  if (from === undefined) return { folders, shell: shell as boolean, permission_skip, agents, session_cap: session_cap as number }
  if (!Array.isArray(from) || !from.every(isInterruptSender)) {
    fail('wrong type for interrupt_from: expected an array of "owner", "session:<name>", "machine:<id>/owner" or "machine:<id>/session:<name>"')
  }
  return { folders, shell: shell as boolean, permission_skip, agents, interrupt_from: from as string[], session_cap: session_cap as number }
}

/** Reads and checks the file; a missing or refused one allows nothing and says so on stderr. */
function readLimits(): LimitsSnapshot {
  const file = limitsFile()
  const disk = readOnDisk(file)
  let problem = disk.problem
  if (disk.bytes) {
    try {
      return { ...parseLimits(disk.bytes, real(dirname(file))), digest: disk.digest }
    } catch (e) {
      problem = `${file}: ${reasonOf(e)}`
    }
  }
  process.stderr.write(`limits: ${problem}; nothing is allowed\n`)
  return { folders: [], shell: false, permission_skip: [], agents: {}, digest: disk.digest, problem, session_cap: DEFAULT_SESSION_CAP }
}

let snapshot = readLimits()
const noticed = new Set<string>()

/** Reads the file again exactly as at start and replaces the snapshot. Called only at this computer (U-R1A-48). */
export function applyLimits(): void {
  snapshot = readLimits()
}

/** A copy of the applied snapshot. `session_cap` is on it but not enumerable, so the snapshot's
 *  listed fields (and every reader comparing or printing them) stay as they were before the cap. */
export function limitsSnapshot(): LimitsSnapshot {
  const copy = structuredClone(snapshot)
  Object.defineProperty(copy, 'session_cap', { value: snapshot.session_cap, enumerable: false, writable: true, configurable: true })
  return copy
}

function sha256Of(file: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return undefined }
}

/**
 * The checks for one open or relay start, against the applied snapshot. Reads the bytes on disk
 * once, for the notice. Each check returns the refusal text (starting `limits: `) or undefined.
 */
export function limitsGate() {
  const applied = snapshot
  const { digest } = readOnDisk(limitsFile())
  const stale = digest !== applied.digest
  if (stale && !noticed.has(digest)) {
    noticed.add(digest)
    process.stderr.write('limits: the limits file changed on disk and is not applied; apply it at this computer\n')
  }
  const no = (why: string) => `limits: ${applied.problem ? `${applied.problem}; nothing is allowed` : why}${stale ? NOTICE : ''}`
  return {
    /** Listed in `agents`, its program's real path the pinned one, an owner file's sha256 pinned, a shell only with `shell = true`. */
    agent(h: Harness | undefined): string | undefined {
      if (!h) return no('the agent has no harness file to check against the limits file')
      const pin = Object.hasOwn(applied.agents, h.name) ? applied.agents[h.name] : undefined
      if (!pin) return no(`agent "${h.name}" is not in the limits file's agents`)
      const found = h.programPath === undefined ? undefined : real(h.programPath)
      const pinned = real(pin.program)
      if (found !== pinned) return no(`agent "${h.name}" runs ${found ?? 'no program'} but the limits file pins ${pinned}`)
      // ponytail: hashed on every open; cache by device, inode, size and mtime if opens get slow.
      // An owner harness file needs a pinned sha256; one pinned for a built-in file holds too.
      const owner = h.source === 'owner' ? ' is an owner harness file and' : ':'
      if (h.source === 'owner' && pin.sha256 === undefined) return no(`agent "${h.name}"${owner} the limits file pins no sha256 for its program`)
      if (pin.sha256 !== undefined && sha256Of(pinned) !== pin.sha256) return no(`agent "${h.name}"${owner} its program's sha256 is not the one the limits file pins`)
      if (h.kind === 'shell' && !applied.shell) return no(`agent "${h.name}" runs a shell or interpreter and the limits file has shell = false`)
      return undefined
    },
    folder(cwd: string): string | undefined {
      return inside(cwd, applied.folders) ? undefined : no(`cwd ${real(cwd)} is not inside the limits file's folders`)
    },
    /** The relay starts its agents with their prompts off, so its cwd must be in `permission_skip`. */
    permissionSkip(cwd: string): string | undefined {
      return inside(cwd, applied.permission_skip)
        ? undefined
        : no(`cwd ${real(cwd)} is not inside the limits file's permission_skip (the relay starts agents with their prompts off)`)
    },
    /** Start with the harness file's skip_prompts_args exactly when the real cwd is in `permission_skip`. */
    skipPrompts(cwd: string): boolean {
      return inside(cwd, applied.permission_skip)
    },
  }
}
