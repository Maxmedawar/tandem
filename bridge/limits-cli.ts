/**
 * limits-cli.ts: `tandem limits init` and `tandem limits apply` (U-R1A-48), the only way a limits
 * file is used. The limits file (bridge/limits.ts) is what the owner edits; what every process uses
 * is its applied copy, limits.applied.toml, written here only, after the owner's own check:
 *
 * - init writes the first file from the owner's answers (or flags, or, with no terminal and no flags
 *   as the installer runs it, the file that allows nothing) and applies it at once: with no file
 *   every process already allows nothing, so a first file needs no `yes`. A file or copy already
 *   there is left alone unless --force, which needs a terminal and a typed `yes`.
 * - apply shows each field that differs from the applied copy and applies limits.toml after a typed
 *   `yes`, only when its bytes are still the ones shown.
 *
 * "At this computer" is a terminal on stdin (the owner's own, or an ssh login of this user; a pipe,
 * a file or a script's stdin is refused) and not inside a Tandem session: offRefusal
 * (bridge/kill-switch.ts), the check `tandem kill-switch off` makes, with no runtime needed. Same
 * user (T23, as that file states): a process of this user can write the copy itself; this keeps an
 * agent's edit to limits.toml from being used, it is not a wall between one user's processes.
 *
 * Exit codes: 0 done, 1 refused or failed (this command's own line is the last stderr line), 2 usage.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'smol-toml'
import { audit } from './audit.ts'
import { offRefusal } from './kill-switch.ts'

type Input = NodeJS.ReadableStream & { isTTY?: boolean; setEncoding?: (e: BufferEncoding) => unknown }
type Limits = typeof import('./limits.ts')

const USAGE = `usage: tandem limits init [--folder <path>]... [--agent <name>]... [--force]
       tandem limits apply
`
const HEADER = 'Tandem limits: what sessions on this computer may do. Nothing is allowed until it is listed here.'
const FOLDERS_Q = 'Folders where sessions may start (absolute or ~/ paths, comma-separated; empty for none): '
const AGENTS_Q = 'Agents to allow (names from the list, comma-separated; empty for none): '
const COMMENT = '# Tandem limits file (written by tandem limits init). A change is used only after: tandem limits apply\n'
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const REFUSED = {
  agent_refused: 'run it from your own terminal, not from inside a Tandem session',
  cannot_tell: 'cannot tell whether this runs inside a Tandem session',
} as const

const say = (line: string) => process.stdout.write(`${line}\n`)
const warn = (line: string) => process.stderr.write(`${line}\n`)
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
/** An entry as typed, with any control or format character shown as `?`. */
const shown = (entry: string) => entry.replace(new RegExp(HIDDEN.source, 'gu'), '?')

/** bridge/limits.ts limitsFile(), the one line copied: the path is needed before that module may be imported. */
const limitsFile = () => join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'limits.toml')

/** realpath of the part of `p` that exists, the rest as written (Tandem's folder may not exist yet). */
function realish(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    const up = dirname(p)
    return up === p ? p : join(realish(up), basename(p))
  }
}
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Lines from `input`, one at a time; undefined at the end. A last line with no line end is not a line. */
function lineReader(input: Input) {
  let buf = ''
  let ended = false
  let attached = false
  let wake: (() => void) | undefined
  const onData = (c: string | Buffer) => { buf += String(c); wake?.() }
  const onEnd = () => { ended = true; wake?.() }
  return {
    async next(): Promise<string | undefined> {
      if (!attached) {
        attached = true
        input.setEncoding?.('utf8')
        input.on('data', onData)
        input.on('end', onEnd)
        input.resume()
      }
      for (;;) {
        const i = buf.indexOf('\n')
        if (i >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          return line
        }
        if (ended) return undefined
        await new Promise<void>((r) => { wake = r })
        wake = undefined
      }
    },
    close() {
      if (!attached) return
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.pause()
    },
  }
}
type Lines = ReturnType<typeof lineReader>

/** A folder entry as its real path, or why it is not used. */
function folderEntry(entry: string, tandemDir: string): { path: string } | { reason: string } {
  if (!entry.startsWith('/') && !entry.startsWith('~/')) return { reason: 'not an absolute or ~/ path' }
  if (HIDDEN.test(entry)) return { reason: 'has a control character' }
  const abs = entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry
  let path: string
  try {
    if (!statSync(abs).isDirectory()) return { reason: 'not a folder' }
    path = realpathSync.native(abs)
  } catch {
    return { reason: 'not a folder' }
  }
  if (within(path, tandemDir) || within(tandemDir, path)) return { reason: "holds or lies inside Tandem's own folder" }
  return { path }
}

type Pin = { program: string; sha256?: string }
type Offered = Map<string, { pin: Pin; shell: boolean }>
/**
 * The agents found here that have a program (an adapter such as hermes has none): name -> its limits
 * entry (test/fixtures/limits.ts agentEntry: the program's real path, plus its sha256 for an owner file).
 */
async function offeredAgents(): Promise<Offered> {
  const { loadedHarnesses } = await import('./engine-registry.ts')
  const found: Offered = new Map()
  for (const h of [...loadedHarnesses().values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!h.programPath) continue
    try {
      const program = realpathSync(h.programPath)
      found.set(h.name, { pin: h.source === 'owner' ? { program, sha256: sha256(readFileSync(program)) } : { program }, shell: h.kind === 'shell' })
    } catch {
      /* its program went away: not offered */
    }
  }
  return found
}

const split = (answer: string) => [...new Set(answer.split(',').map((s) => s.trim()).filter(Boolean))]

/** Asks `question` until every entry of an answer is used, at most three answers; undefined after three bad ones. */
async function ask<T>(lines: Lines, question: string, check: (entry: string) => { value: T } | { reason: string }): Promise<T[] | undefined> {
  for (let tries = 0; tries < 3; tries++) {
    process.stdout.write(question)
    const entries = split((await lines.next()) ?? '')
    const values: T[] = []
    let bad = false
    for (const entry of entries) {
      const r = check(entry)
      if ('reason' in r) {
        say(`  not used: ${shown(entry)}: ${r.reason}`)
        bad = true
      } else values.push(r.value)
    }
    if (!bad) return values
  }
  return undefined
}

/** The value a field shows in a diff. */
const show = (v: unknown) => (v === undefined ? '(absent)' : JSON.stringify(v))

/** `limits file: <file>`, then one line per field that differs from the applied snapshot. */
function printDiff(file: string, applied: Record<string, unknown>, next: Record<string, unknown>, fields: readonly string[], copy: boolean) {
  say(`limits file: ${file}`)
  if (!copy) say('  (first apply here: no applied copy yet)')
  let changed = false
  for (const field of fields) {
    if (field === 'agents') {
      const was = (applied.agents ?? {}) as Record<string, unknown>
      const now = (next.agents ?? {}) as Record<string, unknown>
      for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
        const a = Object.hasOwn(was, name) ? JSON.stringify(was[name]) : '(none)'
        const b = Object.hasOwn(now, name) ? JSON.stringify(now[name]) : '(none)'
        if (a !== b) {
          say(`  agents.${name}: ${a} -> ${b}`)
          changed = true
        }
      }
    } else if (show(applied[field]) !== show(next[field])) {
      say(`  ${field}: ${show(applied[field])} -> ${show(next[field])}`)
      changed = true
    }
  }
  if (!changed) say("  (no field changed; only the file's text)")
}

/** The applied snapshot's fields, the non-enumerable ones too, as a plain object. */
function appliedFields(limits: Limits): Record<string, unknown> {
  const snap = limits.limitsSnapshot() as unknown as Record<string, unknown>
  return Object.fromEntries(limits.FIELDS.map((f) => [f, snap[f]]))
}

/** Imports bridge/limits.ts. Before init has written its file, that module's start read only says there is none: that line is not shown. */
async function loadLimits(file: string): Promise<Limits> {
  const write = process.stderr.write
  const none = `limits: no limits file at ${file}; nothing is allowed\n`
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    String(chunk) === none ? true : (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest)) as typeof write
  try {
    return await import('./limits.ts')
  } finally {
    process.stderr.write = write
  }
}

/** Refused for an agent or from inside a Tandem session, as `tandem kill-switch off` is; audited. */
async function refusal(cmd: 'init' | 'apply'): Promise<boolean> {
  const token = process.env.TANDEM_CALLER_TOKEN
  const tmux = process.env.TMUX
  const refused = await offRefusal({ pid: process.pid, ...(token ? { caller_token: token } : {}), ...(tmux ? { tmux } : {}) })
  if (!refused) return false
  audit({ event: `limits.${cmd}`, refused })
  warn(`tandem: limits ${cmd} refused: ${REFUSED[refused]}`)
  return true
}

async function init(rest: string[], input: Input, lines: Lines): Promise<number> {
  const folderArgs: string[] = []
  const agentArgs: string[] = []
  let force = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--force') force = true
    else if ((a === '--folder' || a === '--agent') && i + 1 < rest.length) (a === '--folder' ? folderArgs : agentArgs).push(rest[++i]!)
    else return usage()
  }
  if (await refusal('init')) return 1
  const file = limitsFile()
  const dir = dirname(file)
  const copyFile = join(dir, 'limits.applied.toml')
  if (!force) {
    for (const f of [file, copyFile]) {
      if (existsSync(f)) {
        warn(`tandem: ${f} already exists; nothing was written (edit it and run tandem limits apply)`)
        return 1
      }
    }
  }
  const tty = input.isTTY === true
  if (force && !tty) {
    warn('tandem: limits init --force needs you at this computer: run it in a terminal, not from a pipe or a script')
    return 1
  }
  const tandemDir = realish(dir)
  const checkFolder = (e: string): { value: string } | { reason: string } => {
    const r = folderEntry(e, tandemDir)
    return 'path' in r ? { value: r.path } : r
  }
  let folders: string[] = []
  let chosen: string[] = []
  let offered: Offered = new Map()
  if (tty && folderArgs.length === 0 && agentArgs.length === 0) {
    say(HEADER)
    const f = await ask(lines, FOLDERS_Q, checkFolder)
    if (!f) return noAnswer()
    folders = f
    offered = await offeredAgents()
    say(`Agents found here: ${offered.size === 0 ? 'none' : [...offered].map(([n, o]) => `${n} (${o.pin.program})`).join(', ')}`)
    const a = await ask<string>(lines, AGENTS_Q, (e) => (offered.has(e) ? { value: e } : { reason: 'not an agent found here' }))
    if (!a) return noAnswer()
    chosen = a
  } else {
    for (const e of [...new Set(folderArgs)]) {
      const r = checkFolder(e)
      if ('reason' in r) return badEntry(e, r.reason)
      folders.push(r.value)
    }
    if (agentArgs.length > 0) offered = await offeredAgents()
    for (const e of [...new Set(agentArgs)]) {
      if (!offered.has(e)) return badEntry(e, 'not an agent found here')
      chosen.push(e)
    }
  }
  folders = [...new Set(folders)]
  const agents: Record<string, Pin> = {}
  for (const name of chosen) {
    agents[name] = offered.get(name)!.pin
    if (offered.get(name)!.shell) say(`tandem: note: ${name} runs a shell; it starts only after shell = true is set and applied`)
  }

  const limits = await loadLimits(file)
  const fields = { folders, agents, ...limits.INIT_DEFAULTS }
  const text = COMMENT + stringify(fields)
  try {
    const st = statSync(dir, { throwIfNoEntry: false })
    if (!st) mkdirSync(dir, { recursive: true, mode: 0o700 })
    else if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`the folder ${dir} has the wrong owner`)
    else if ((st.mode & 0o022) !== 0) throw new Error(`the folder ${dir} is writable by group or others`)
  } catch (e) {
    warn(`tandem: limits init: ${(e as Error).message}; nothing was written`)
    return 1
  }
  let created = false
  if (!force) {
    try {
      writeAll(file, text, 'wx')
      created = true
    } catch (e) {
      warn(`tandem: limits init: ${(e as Error).message}; nothing was written`)
      return 1
    }
  } else {
    const copy = existsSync(copyFile)
    printDiff(file, appliedFields(limits), fields, limits.FIELDS, copy)
    process.stdout.write('Type yes to replace the limits file and apply it: ')
    if ((await lines.next()) !== 'yes') {
      warn('tandem: not replaced')
      return 1
    }
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeAll(tmp, text, 'wx')
      renameSync(tmp, file)
    } catch (e) {
      rmSync(tmp, { force: true })
      warn(`tandem: limits init: ${(e as Error).message}; nothing was written`)
      return 1
    }
  }
  const digest = sha256(text)
  const why = limits.commitLimits(digest)
  if (why !== undefined) {
    if (created) rmSync(file, { force: true })
    warn(`tandem: limits init: ${why}; nothing was applied`)
    return 1
  }
  say(`tandem: wrote ${file} and applied it`)
  if (folders.length === 0 && Object.keys(agents).length === 0) say(`tandem: nothing is allowed yet: edit ${file}, then run tandem limits apply`)
  audit({ event: 'limits.init', digest })
  return 0
}

/** `text` to a new file `path` (0600), flushed to disk. */
function writeAll(path: string, text: string, flag: 'wx') {
  const fd = openSync(path, flag, 0o600)
  try {
    const bytes = Buffer.from(text, 'utf8')
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function usage(): number {
  process.stderr.write(USAGE)
  return 2
}
function noAnswer(): number {
  warn('tandem: limits init: no usable answer; nothing was written')
  return 1
}
function badEntry(entry: string, reason: string): number {
  warn(`tandem: limits init: ${shown(entry)}: ${reason}; nothing was written`)
  return 1
}

async function apply(input: Input, lines: Lines): Promise<number> {
  if (await refusal('apply')) return 1
  if (input.isTTY !== true) {
    warn('tandem: limits apply needs you at this computer: run it in a terminal, not from a pipe or a script')
    return 1
  }
  const file = limitsFile()
  if (!existsSync(file)) {
    warn(`tandem: no limits file at ${file}; run tandem limits init`)
    return 1
  }
  const limits = await import('./limits.ts')
  const d = limits.limitsOnDisk()
  if (d.problem !== undefined || !d.fields) {
    warn(`tandem: the limits file is refused (${d.problem}); nothing was applied`)
    return 1
  }
  if (d.copy && d.digest === limits.limitsSnapshot().digest) {
    say('tandem: the limits file is already applied')
    return 0
  }
  printDiff(file, appliedFields(limits), d.fields as unknown as Record<string, unknown>, limits.FIELDS, d.copy)
  process.stdout.write('Type yes to apply these limits on this computer: ')
  if ((await lines.next()) !== 'yes') {
    warn('tandem: not applied')
    return 1
  }
  const why = limits.commitLimits(d.digest)
  if (why === 'changed') {
    warn('tandem: the limits file changed after it was shown; nothing was applied; run tandem limits apply again')
    return 1
  }
  if (why !== undefined) {
    warn(`tandem: the limits file is refused (${why}); nothing was applied`)
    return 1
  }
  say('tandem: limits applied')
  audit({ event: 'limits.apply', digest: d.digest })
  return 0
}

/** `tandem limits init|apply`: 0 done, 1 refused or failed, 2 usage. */
export async function main(args: string[], opts: { input?: NodeJS.ReadableStream & { isTTY?: boolean } } = {}): Promise<number> {
  const input = (opts.input ?? process.stdin) as Input
  const lines = lineReader(input)
  const [sub, ...rest] = args
  try {
    if (sub === 'init') return await init(rest, input, lines)
    if (sub === 'apply' && rest.length === 0) return await apply(input, lines)
    return usage()
  } catch (e) {
    warn(`tandem: limits ${sub}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    lines.close()
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) void main(process.argv.slice(2)).then((code) => { process.exitCode = code })
