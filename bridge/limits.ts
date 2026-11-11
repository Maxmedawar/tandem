/**
 * limits.ts: the limits file, the ceiling on what sessions may start on this computer for the
 * fields `folders`, `agents`, `shell` and `permission_skip` (plan section 3). The bridge is the
 * only place limits are enforced, and nothing remote can widen them.
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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { readProtectedRegularFileSync } from '../src/runtime-config.ts'
import type { Harness } from './harness-registry.ts'
import { isCwdAllowed, safeResolve } from './sessions.ts'

export interface AgentPin {
  program: string
  sha256?: string
}

export interface LimitsSnapshot {
  /** Real paths (safeResolve), checked when the file was read. */
  folders: string[]
  shell: boolean
  permission_skip: string[]
  /** As written: each `program` is resolved at check time. */
  agents: Record<string, AgentPin>
  /** sha256 of the bytes read; `missing` for no file; `refused: <reason>` when no bytes could be read. */
  digest: string
  /** Why nothing is allowed (missing or refused file). */
  problem?: string
}

const FIELDS = ['folders', 'shell', 'permission_skip', 'agents']
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

export function limitsFile(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'limits.toml')
}

/** The bytes on disk and their digest, or the marker for no file or a refused one. */
function readOnDisk(file: string): { bytes?: Buffer; digest: string; problem?: string } {
  try {
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
    const real = safeResolve(pathText(p, field))
    if (isCwdAllowed(real, [fileDir]) || isCwdAllowed(fileDir, [real])) {
      fail(`${field} entry ${real} equals, holds or lies inside the limits file's folder ${fileDir}`)
    }
    return real
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
  return { folders, shell: shell as boolean, permission_skip, agents }
}

/** Reads and checks the file; a missing or refused one allows nothing and says so on stderr. */
function readLimits(): LimitsSnapshot {
  const file = limitsFile()
  const disk = readOnDisk(file)
  let problem = disk.problem
  if (disk.bytes) {
    try {
      return { ...parseLimits(disk.bytes, safeResolve(dirname(file))), digest: disk.digest }
    } catch (e) {
      problem = `${file}: ${reasonOf(e)}`
    }
  }
  process.stderr.write(`limits: ${problem}; nothing is allowed\n`)
  return { folders: [], shell: false, permission_skip: [], agents: {}, digest: disk.digest, problem }
}

let snapshot = readLimits()
const noticed = new Set<string>()

/** Reads the file again exactly as at start and replaces the snapshot. Called only at this computer (U-R1A-48). */
export function applyLimits(): void {
  snapshot = readLimits()
}

/** A copy of the applied snapshot. */
export function limitsSnapshot(): LimitsSnapshot {
  return structuredClone(snapshot)
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
      const pin = applied.agents[h.name]
      if (!pin) return no(`agent "${h.name}" is not in the limits file's agents`)
      const found = h.programPath === undefined ? undefined : safeResolve(h.programPath)
      const pinned = safeResolve(pin.program)
      if (found !== pinned) return no(`agent "${h.name}" runs ${found ?? 'no program'} but the limits file pins ${pinned}`)
      // ponytail: hashed on every open; cache by device, inode, size and mtime if opens get slow.
      if (h.source === 'owner') {
        if (pin.sha256 === undefined) return no(`agent "${h.name}" is an owner harness file and the limits file pins no sha256 for its program`)
        if (sha256Of(pinned) !== pin.sha256) return no(`agent "${h.name}" is an owner harness file and its program's sha256 is not the one the limits file pins`)
      }
      if (h.kind === 'shell' && !applied.shell) return no(`agent "${h.name}" runs a shell or interpreter and the limits file has shell = false`)
      return undefined
    },
    folder(cwd: string): string | undefined {
      return isCwdAllowed(cwd, applied.folders) ? undefined : no(`cwd ${safeResolve(cwd)} is not inside the limits file's folders`)
    },
    /** The relay starts its agents with their prompts off, so its cwd must be in `permission_skip`. */
    permissionSkip(cwd: string): string | undefined {
      return isCwdAllowed(cwd, applied.permission_skip)
        ? undefined
        : no(`cwd ${safeResolve(cwd)} is not inside the limits file's permission_skip (the relay starts agents with their prompts off)`)
    },
    /** Start with the harness file's skip_prompts_args exactly when the real cwd is in `permission_skip`. */
    skipPrompts(cwd: string): boolean {
      return isCwdAllowed(cwd, applied.permission_skip)
    },
  }
}
