/**
 * limits.ts: the limits file, the ceiling on what sessions may start on this computer for the
 * fields `folders`, `agents`, `shell` and `permission_skip` (plan section 3), who may send mail at
 * the Interrupt level, `interrupt_from` (bridge/mailbox.ts; absent means nobody), and the most
 * sessions at once, `session_cap` (bridge/kill-switch.ts reserveSessions; absent means 12), and
 * which other computers may open, type into and close sessions here or send Ask mail, `control_from`
 * (bridge/remote-command.ts, bridge/mailbox.ts; absent means none: they send only FYI), and how far
 * an agent's memory and transcript search reach, `memory_scope` ("project" or "all") and
 * `transcript_scope` ("project" or "computer"; src/mcp-server.ts; absent, missing or refused means
 * "project"). The bridge is the only place limits are enforced, and nothing remote can widen them.
 *
 * What the hub may do here for MCP clients (U-R1A-17B), checked in bridge/hub-rpc.ts on hub frames
 * only (local MCP calls never pass there): `hub_commands` (true or false: typing and every other
 * command) and `hub_reads`, a table `{ screens, transcripts, memory }` of true or false. An absent
 * field or key means off, and so does a missing or refused file or copy (`tandem limits init` writes both on).
 *
 * Rights of another computer (U-R1A-36E): `open`, `send` (typing text), `close`, `read` (a poll:
 * send with empty text) and `ask` (Ask mail), each listed on its own in `control_from_open`,
 * `control_from_send`, `control_from_close`, `control_from_read` and `control_from_ask` (each an
 * array of computer ids, as `control_from`; absent means []). The lists only add: a computer holds
 * a right when `control_from` lists it OR that right's own list does, so `control_from` alone
 * grants all five and an absent or empty per-right list leaves `control_from` in force for that
 * right. rightsOf() is the only place they are combined.
 *
 * The file is `$TANDEM_HOME/limits.toml` when TANDEM_HOME is set, else `~/.tandem/limits.toml`,
 * worked out at each read. What is used is the APPLIED COPY beside it, `limits.applied.toml` (0600,
 * the exact bytes of the limits.toml that was applied), written only by commitLimits(), which only
 * `tandem limits init` and `tandem limits apply` call (bridge/limits-cli.ts: a terminal of this
 * user, not inside a Tandem session, and a typed `yes` for every change). No route, MCP tool, hub
 * frame, control op or fleet op writes it. A folder with no copy (a file from before U-R1A-48) is
 * read from limits.toml as before.
 *
 * Every process that imports this module (the runtime, each agent's stdio MCP server, hooks) reads
 * the copy once at import into a snapshot plus the sha256 digest of the bytes read (`missing` when
 * there is no file), and at each limitsSnapshot() and limitsGate() call looks at the copy again
 * (one lstat in the folder of its last read): a new copy is read at that call, so one apply
 * reaches every running process and every one started later, with no signal, socket or restart. A
 * copy that disappears keeps the snapshot (no fall back while running). A missing or refused file
 * or copy allows nothing and writes one stderr line. applyLimits() reads again exactly as at start.
 *
 * Same user (T23, as bridge/kill-switch.ts states for its file): a process of this user can write
 * limits.applied.toml itself, or delete it so that a process started later reads limits.toml. The
 * copy keeps an agent's edit to limits.toml from being used; it is not a wall between one user's
 * processes.
 *
 * At each open and relay start the router takes limitsGate(), which reads the bytes of limits.toml
 * on disk: when their digest differs from the snapshot's, every refusal ends with a notice and
 * stderr gets one line the first time each new digest is seen. The snapshot is not touched.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { tandemHome } from './tandem-home.ts'
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
  /** Computer ids whose signed commands run here and whose Ask mail is stored here; [] when absent, missing or refused. */
  control_from: string[]
  /** Computer ids holding one right each on top of control_from (U-R1A-36E); [] when absent, missing or refused. */
  control_from_open: string[]
  control_from_send: string[]
  control_from_close: string[]
  control_from_read: string[]
  control_from_ask: string[]
  /** How far an agent's memory calls reach: its own project folder, or every project; "project" when absent, missing or refused. */
  memory_scope: 'project' | 'all'
  /** How far an agent's transcript search reaches: its own session's folder, or this computer; "project" when absent, missing or refused. */
  transcript_scope: 'project' | 'computer'
  /** Accept typing and other commands passed on by the hub from MCP clients; false when absent and when the file is missing or refused. */
  hub_commands: boolean
  /** What the hub may read here for MCP clients; each false when absent; all false when the file is missing or refused. */
  hub_reads: { screens: boolean; transcripts: boolean; memory: boolean }
  /** Why nothing is allowed (missing or refused file). */
  problem?: string
}

export const FIELDS = [
  'folders', 'shell', 'permission_skip', 'agents', 'interrupt_from', 'session_cap', 'control_from',
  'control_from_open', 'control_from_send', 'control_from_close', 'control_from_read', 'control_from_ask', 'memory_scope', 'transcript_scope',
  'hub_commands', 'hub_reads',
]
/** What another computer may do here, in this order (U-R1A-36E). */
export const RIGHTS = ['open', 'send', 'close', 'read', 'ask'] as const
export type Right = (typeof RIGHTS)[number]
/** The per-right lists, by right. */
const RIGHT_LISTS = ['control_from_open', 'control_from_send', 'control_from_close', 'control_from_read', 'control_from_ask'] as const
type RightList = (typeof RIGHT_LISTS)[number]
/** A computer id (bridge/envelope.ts ID). */
const COMPUTER_ID = /^[a-z0-9._-]{1,64}$/
const DEFAULT_SESSION_CAP = 12
const AGENT_FIELDS = ['program', 'sha256']
/** A harness name (harness-registry.ts). */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
/** What `tandem limits init` writes for every field but `folders` and `agents`. */
export const INIT_DEFAULTS = {
  shell: false, permission_skip: [], session_cap: 12, interrupt_from: [], control_from: [],
  control_from_open: [], control_from_send: [], control_from_close: [], control_from_read: [], control_from_ask: [],
  memory_scope: 'project', transcript_scope: 'project',
  hub_commands: true, hub_reads: { screens: true, transcripts: true, memory: true },
} as const
export type LimitsFields = Omit<LimitsSnapshot, 'digest' | 'problem'>
const APPLIED = 'limits.applied.toml'
const NOTICE = ' (notice: the limits file changed on disk and is not applied; apply it at this computer)'
/** What the hub may ask for here, by the limits field that allows it. */
export type HubRight = 'commands' | 'screens' | 'transcripts' | 'memory'
const HUB_READS = ['screens', 'transcripts', 'memory'] as const
/** The answer to a hub request its limits field turns off (U-R1A-17B). */
export const HUB_REFUSALS: Readonly<Record<HubRight, string>> = Object.freeze({
  commands: 'hub_commands: this computer does not take commands passed on by the hub (limits file)',
  screens: 'hub_reads.screens: this computer does not let the hub read its sessions (limits file)',
  transcripts: 'hub_reads.transcripts: this computer does not let the hub read its transcripts (limits file)',
  memory: 'hub_reads.memory: this computer does not let the hub read its memory, rooms or projects (limits file)',
})

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
  return join(tandemHome(), 'limits.toml')
}

/** The applied copy beside the limits file. */
export function appliedFile(): string {
  return join(dirname(limitsFile()), APPLIED)
}

/** Which copy is on disk: device, inode, size and times; `none` for no copy; `error: <code>` when lstat fails otherwise. */
function copyKey(copy: string): string {
  try {
    const st = lstatSync(copy, { throwIfNoEntry: false })
    return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : 'none'
  } catch (e) {
    return `error: ${(e as NodeJS.ErrnoException).code ?? reasonOf(e)}`
  }
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
  const ids = (field: string): string[] => {
    const v = raw[field] ?? []
    if (!Array.isArray(v) || !v.every((id) => typeof id === 'string' && COMPUTER_ID.test(id)) || new Set(v).size !== v.length) {
      fail(`wrong type for ${field}: expected an array of computer ids`)
    }
    return v as string[]
  }
  const control_from = ids('control_from')
  const lists = Object.fromEntries(RIGHT_LISTS.map((f) => [f, ids(f)])) as Record<RightList, string[]>
  const memory_scope = raw.memory_scope ?? 'project'
  if (memory_scope !== 'project' && memory_scope !== 'all') fail('wrong type for memory_scope: expected "project" or "all"')
  const transcript_scope = raw.transcript_scope ?? 'project'
  if (transcript_scope !== 'project' && transcript_scope !== 'computer') {
    fail('wrong type for transcript_scope: expected "project" or "computer" ("all" needs search across computers, which is not built)')
  }
  const hub_commands = raw.hub_commands ?? false
  if (typeof hub_commands !== 'boolean') fail('wrong type for hub_commands: expected true or false')
  const reads = raw.hub_reads ?? {}
  if (!isTable(reads)) return fail('wrong type for hub_reads: expected a table { screens, transcripts, memory } of true or false')
  for (const [k, v] of Object.entries(reads)) {
    if (!(HUB_READS as readonly string[]).includes(k)) fail(`unknown field hub_reads.${k}`)
    if (typeof v !== 'boolean') fail(`wrong type for hub_reads.${k}: expected true or false`)
  }
  const on = (k: (typeof HUB_READS)[number]) => (reads[k] ?? false) as boolean
  const hub_reads = { screens: on('screens'), transcripts: on('transcripts'), memory: on('memory') }
  const from = raw.interrupt_from
  const base = {
    folders, shell: shell as boolean, permission_skip, agents, session_cap: session_cap as number, control_from, ...lists,
    memory_scope: memory_scope as LimitsSnapshot['memory_scope'], transcript_scope: transcript_scope as LimitsSnapshot['transcript_scope'],
    hub_commands: hub_commands as boolean, hub_reads,
  }
  if (from === undefined) return base
  if (!Array.isArray(from) || !from.every(isInterruptSender)) {
    fail('wrong type for interrupt_from: expected an array of "owner", "session:<name>", "machine:<id>/owner" or "machine:<id>/session:<name>"')
  }
  return { ...base, interrupt_from: from as string[] }
}

/** The folder of the last read and the copy's key then: fresh() looks there, never at a TANDEM_HOME changed since. */
let readDir = ''
let readKey = 'none'

/**
 * Reads and checks the applied copy in `dir`, or limits.toml there when no copy exists; a missing or
 * refused one allows nothing and says so on stderr. A refused copy never falls back to limits.toml.
 */
function readLimits(dir = dirname(limitsFile())): LimitsSnapshot {
  const copy = join(dir, APPLIED)
  // The key before the bytes: a copy replaced in between is read again at the next call.
  const key = copyKey(copy)
  readDir = dir
  readKey = key
  const file = key === 'none' ? join(dir, 'limits.toml') : copy
  const disk: { bytes?: Buffer; digest: string; problem?: string } = key.startsWith('error: ')
    ? { digest: `refused: ${key.slice(7)}`, problem: `${copy}: ${key.slice(7)}` }
    : readOnDisk(file)
  let problem = disk.problem
  if (disk.bytes) {
    try {
      return { ...parseLimits(disk.bytes, real(dir)), digest: disk.digest }
    } catch (e) {
      problem = `${file}: ${reasonOf(e)}`
    }
  }
  process.stderr.write(`limits: ${problem}; nothing is allowed\n`)
  return {
    folders: [], shell: false, permission_skip: [], agents: {}, digest: disk.digest, problem, session_cap: DEFAULT_SESSION_CAP, control_from: [],
    control_from_open: [], control_from_send: [], control_from_close: [], control_from_read: [], control_from_ask: [], memory_scope: 'project', transcript_scope: 'project',
    hub_commands: false, hub_reads: { screens: false, transcripts: false, memory: false },
  }
}

let snapshot = readLimits()
const noticed = new Set<string>()

/** Reads again exactly as at start (the applied copy, else limits.toml) and replaces the snapshot. */
export function applyLimits(): void {
  snapshot = readLimits()
}

/** A new applied copy since the last read is read now. A copy that disappears keeps the snapshot. */
function fresh(): void {
  // ponytail: one lstat per call; cache by tick if calls get hot.
  const key = copyKey(join(readDir, APPLIED))
  if (key !== 'none' && key !== readKey) snapshot = readLimits(readDir)
}

/**
 * limits.toml read and checked as readLimits() would, with nothing written to stderr and the
 * snapshot untouched; `copy` says whether the applied copy exists.
 */
export function limitsOnDisk(): { digest: string; fields?: LimitsFields; problem?: string; copy: boolean } {
  const file = limitsFile()
  const copy = copyKey(appliedFile()) !== 'none'
  const disk = readOnDisk(file)
  if (!disk.bytes) return { digest: disk.digest, problem: disk.problem, copy }
  try {
    return { digest: disk.digest, fields: parseLimits(disk.bytes, real(dirname(file))), copy }
  } catch (e) {
    return { digest: disk.digest, problem: `${file}: ${reasonOf(e)}`, copy }
  }
}

/**
 * Applies limits.toml when its bytes are still the ones shown (`expected`, their sha256): writes
 * them as the applied copy (a 0600 temporary file, fsync, rename) and reads the copy into this
 * process's snapshot. Returns undefined, or why nothing was written: `missing`, `changed`, or the
 * reason the file is refused. Called only by bridge/limits-cli.ts at this computer.
 */
export function commitLimits(expected: string): string | undefined {
  const file = limitsFile()
  const dir = dirname(file)
  const disk = readOnDisk(file)
  if (disk.digest === 'missing') return 'missing'
  if (!disk.bytes) return disk.problem
  if (disk.digest !== expected) return 'changed'
  try {
    parseLimits(disk.bytes, real(dir))
  } catch (e) {
    return `${file}: ${reasonOf(e)}`
  }
  const tmp = join(dir, `${APPLIED}.${process.pid}.tmp`)
  let made = false
  try {
    const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    made = true
    try {
      for (let at = 0; at < disk.bytes.length; ) at += writeSync(fd, disk.bytes, at)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, join(dir, APPLIED))
  } catch (e) {
    if (made) rmSync(tmp, { force: true })
    return reasonOf(e)
  }
  snapshot = readLimits(dir)
  return undefined
}

/** A copy of the applied snapshot. `session_cap`, `control_from`, the five per-right lists, `memory_scope`, `transcript_scope`, `hub_commands`
 *  and `hub_reads` are on it but not enumerable, so the snapshot's listed fields (and every reader comparing or printing them) stay as they were before them. */
export function limitsSnapshot(): LimitsSnapshot {
  fresh()
  const copy = structuredClone(snapshot)
  Object.defineProperty(copy, 'session_cap', { value: snapshot.session_cap, enumerable: false, writable: true, configurable: true })
  for (const field of ['control_from', ...RIGHT_LISTS] as const) {
    Object.defineProperty(copy, field, { value: [...snapshot[field]], enumerable: false, writable: true, configurable: true })
  }
  for (const field of ['memory_scope', 'transcript_scope'] as const) {
    Object.defineProperty(copy, field, { value: snapshot[field], enumerable: false, writable: true, configurable: true })
  }
  Object.defineProperty(copy, 'hub_commands', { value: snapshot.hub_commands, enumerable: false, writable: true, configurable: true })
  Object.defineProperty(copy, 'hub_reads', { value: { ...snapshot.hub_reads }, enumerable: false, writable: true, configurable: true })
  return copy
}

/**
 * The rights computer `id` holds here, in RIGHTS order, from the applied snapshot: right r when
 * `control_from` or `control_from_<r>` lists it (U-R1A-36E). The only place they are combined.
 */
export function rightsOf(id: string): Right[] {
  const snap = limitsSnapshot()
  return RIGHTS.filter((r, i) => snap.control_from.includes(id) || snap[RIGHT_LISTS[i]].includes(id))
}

function sha256Of(file: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return undefined }
}

/**
 * The checks for one open or relay start, against the applied snapshot. Reads the bytes on disk
 * once, for the notice. Each check returns the refusal text (starting `limits: `) or undefined.
 */
export function limitsGate() {
  fresh()
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
    /** A hub request needing `what` (bridge/hub-rpc.ts only): undefined when allowed, else its HUB_REFUSALS text. */
    hub(what: HubRight): string | undefined {
      const allowed = what === 'commands' ? applied.hub_commands : applied.hub_reads[what]
      return allowed ? undefined : HUB_REFUSALS[what] + (stale ? NOTICE : '')
    },
  }
}
