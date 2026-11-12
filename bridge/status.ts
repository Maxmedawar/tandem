/**
 * status.ts: `tandem status [--json]` (U-R1A-40). One document: this computer and every other
 * computer of its roster, each with its sessions, their states and how old each reading is, plus
 * whether the runtime answers and whether the kill switch is on. The owner's terminal and the menu
 * bar list read the same document.
 *
 * It is built in this command's own process from the readers who_is_up uses (bridge/presence.ts,
 * which reads bridge/hub-presence.ts's state.db for the other computers); no runtime has to run.
 * Only the runtime can read its sessions' states (it holds them), so this computer's sessions and
 * the kill switch come from one read-only `status` over its control socket
 * (bridge/control-socket.ts; runtimeStatus below is the runtime's answer, src/server.ts wires it).
 * A runtime that is down (`not_running`) or answers `unknown_command` (an older one:
 * `old_runtime`) leaves the local readers' rows, states `unknown`, and the switch file. Nothing
 * under `run/` is ever made, removed or replaced here.
 *
 * No folder path, screen text, transcript, attach command, token or key is in any field: each
 * session row is picked field by field.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { controlSocketPath, sendControlCommand, type ControlResult } from './control-socket.ts'
import type { Presence } from './presence.ts'

export const STATUS_VERSION = 2
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const PROBE_MS = 1500
/** The runtime answers within this, so the caller's PROBE_MS never takes a slow screen read for a dead runtime. */
const ANSWER_MS = 1000
const STATES: ReadonlySet<string> = new Set(['working', 'idle', 'waiting_for_approval', 'unknown'])
/** A session name or engine as this product makes them (bridge/sessions.ts, bridge/hub-presence.ts): the text form prints them raw. */
const NAME = /^[A-Za-z0-9._-]{1,300}$/

export type StatusCounts = { working: number; idle: number; waiting_for_approval: number; unknown: number }
export type StatusSession = { name: string; engine: string; project: string; state: string; stateAt: number; ageMs: number }
export type StatusComputer = {
  computer: string
  self: boolean
  at: number | null
  ageMs: number | null
  stale: boolean
  counts: StatusCounts
  sessions: StatusSession[]
  more: number
}
/** Times are ms since the epoch, ages in ms. */
export type TandemStatus = {
  statusVersion: typeof STATUS_VERSION
  version: string
  at: number
  runtime: 'running' | 'not_running' | 'old_runtime'
  killSwitch: 'on' | 'off'
  computers: StatusComputer[]
}
/** The runtime's `status` answer: its own session rows and its kill switch guard. */
export type RuntimeReply = {
  sessions: { name: string; engine: string; state: string; ageMs: number }[]
  killSwitch: { on: boolean; latched: boolean; tampered: number }
}
export type RuntimeProbe = { runtime: TandemStatus['runtime']; reply?: RuntimeReply }
export type StatusOptions = { presence?: Presence; probe?: () => Promise<RuntimeProbe>; now?: () => number }

/** The reply picked field by field; anything off shape is no reply (the local readers are used). */
function replyOf(detail: unknown): RuntimeReply | undefined {
  const d = detail as { sessions?: unknown; killSwitch?: { on?: unknown; latched?: unknown; tampered?: unknown } } | null
  if (!d || !Array.isArray(d.sessions) || !d.killSwitch) return undefined
  const { on, latched, tampered } = d.killSwitch
  if (typeof on !== 'boolean' || typeof latched !== 'boolean' || typeof tampered !== 'number') return undefined
  const sessions: RuntimeReply['sessions'] = []
  for (const s of d.sessions as { name?: unknown; engine?: unknown; state?: unknown; ageMs?: unknown }[]) {
    if (typeof s?.name !== 'string' || typeof s.engine !== 'string' || typeof s.state !== 'string' || typeof s.ageMs !== 'number' || !Number.isFinite(s.ageMs)) return undefined
    if (!NAME.test(s.name) || !NAME.test(s.engine)) return undefined
    sessions.push({ name: s.name, engine: s.engine, state: STATES.has(s.state) ? s.state : 'unknown', ageMs: s.ageMs })
  }
  return { sessions, killSwitch: { on, latched, tampered } }
}

/** One `status` to the runtime: no answer `not_running`, `unknown_command` `old_runtime`, else `running`. */
async function askRuntime(): Promise<RuntimeProbe> {
  let answer: ControlResult
  try {
    answer = await sendControlCommand(controlSocketPath(), { op: 'status' }, PROBE_MS)
  } catch {
    return { runtime: 'not_running' }
  }
  if (answer?.ok === false && answer.error === 'unknown_command') return { runtime: 'old_runtime' }
  const reply = answer?.ok === true ? replyOf(answer.detail) : undefined
  return reply ? { runtime: 'running', reply } : { runtime: 'running' }
}

/**
 * The runtime's answer to `status` (src/server.ts passes it to startControlServer): who_is_up's
 * rows for this computer from this process's own sessions (name, engine, state, age; no folder,
 * screen or text) and the kill switch guard's on/latched/tampered. Read-only. A reading that takes
 * over ANSWER_MS answers `timed_out`, so the caller still sees a running runtime.
 */
export function runtimeStatus(opts: { presence?: Presence } = {}): () => Promise<ControlResult> {
  let presence = opts.presence
  return async () => {
    const [{ createPresence }, { runKillSwitchCommand }] = await Promise.all([import('./presence.ts'), import('./kill-switch.ts')])
    // Only this computer: the other computers are read by the caller from state.db.
    presence ??= createPresence({ remote: { read: () => [] } })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), ANSWER_MS) })
    const up = await Promise.race([presence.whoIsUp({ refresh: true }), late]).finally(() => clearTimeout(timer))
    if (!up) return { ok: false, error: 'timed_out' }
    const guard = (await runKillSwitchCommand({ op: 'kill_switch_status' })).detail as RuntimeReply['killSwitch']
    return {
      ok: true,
      detail: {
        sessions: up.sessions.map(({ name, engine, state, ageMs }) => ({ name, engine, state, ageMs })),
        killSwitch: { on: guard.on, latched: guard.latched, tampered: guard.tampered },
      },
    }
  }
}

const row = ({ name, engine, project, state, stateAt, ageMs }: StatusSession): StatusSession => ({ name, engine, project, state, stateAt, ageMs })

function counted(sessions: StatusSession[]): StatusCounts {
  const counts: StatusCounts = { working: 0, idle: 0, waiting_for_approval: 0, unknown: 0 }
  for (const { state } of sessions) {
    counts[state === 'working' || state === 'idle' || state === 'waiting_for_approval' ? state : 'unknown']++
  }
  return counts
}

function computer(c: Omit<StatusComputer, 'counts' | 'sessions'>, rows: StatusSession[]): StatusComputer {
  const sessions = rows.map(row)
  return { computer: c.computer, self: c.self, at: c.at, ageMs: c.ageMs, stale: c.stale, counts: counted(sessions), sessions, more: c.more }
}

export async function statusDocument(opts: StatusOptions = {}): Promise<TandemStatus> {
  // Loaded here, not at the top: the readers open node:sqlite, whose ExperimentalWarning (Node 22)
  // would otherwise reach stderr ahead of the usage line.
  const [{ createPresence }, { killSwitchOn }] = await Promise.all([import('./presence.ts'), import('./kill-switch.ts')])
  const now = opts.now ?? Date.now
  const presence = opts.presence ?? createPresence({ now })
  const [up, { runtime, reply }] = await Promise.all([presence.whoIsUp({ refresh: true }), (opts.probe ?? askRuntime)()])
  const at = now()
  // The runtime's rows when it answered (it holds the states); the project from the local listing.
  const project = new Map(up.sessions.map((s) => [s.name, s.project]))
  const mine = reply
    ? reply.sessions.map((s) => ({ ...s, project: project.get(s.name) ?? '', stateAt: at - s.ageMs }))
    : up.sessions
  return {
    statusVersion: STATUS_VERSION,
    version: VERSION,
    at,
    runtime,
    killSwitch: (reply ? reply.killSwitch.on || reply.killSwitch.latched : killSwitchOn()) ? 'on' : 'off',
    computers: [
      computer({ computer: up.computer, self: true, at: up.at, ageMs: up.ageMs, stale: false, more: 0 }, mine),
      ...(up.others ?? []).map((o) => computer({ ...o, self: false }, o.sessions)),
    ],
  }
}

/** `<s> s` under a minute, `<m> min` under an hour, `<h> h` under 48 hours, else `<d> d` (each floored); missing or future: `unknown`. */
function age(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'unknown'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86_400)} d`
}

export function renderStatus(doc: TandemStatus): string {
  const lines = [`Tandem ${doc.version} · runtime ${doc.runtime.replace('_', ' ')} · kill switch ${doc.killSwitch}`]
  for (const c of doc.computers) {
    const n = c.sessions.length
    const { working, idle, waiting_for_approval, unknown } = c.counts
    const read = c.at === null ? 'no reading yet' : `read ${age(c.ageMs)} ago`
    lines.push(`${c.computer}${c.self ? ' (this computer)' : ''} · ${n} session${n === 1 ? '' : 's'}: ${working} working, ${idle} idle, ${waiting_for_approval} waiting, ${unknown} unknown · ${c.stale ? 'stale · ' : ''}${read}`)
    for (const s of c.sessions) lines.push(`  ${s.name}  ${s.engine}  ${s.state}`)
    if (c.more > 0) lines.push(`  ... and ${c.more} more`)
  }
  return `${lines.join('\n')}\n`
}

/** `tandem status [--json]`: 0 printed, 1 the document could not be built, 2 usage. */
export async function main(args: string[], opts: StatusOptions = {}): Promise<number> {
  const json = args.length === 1 && args[0] === '--json'
  if (args.length > 0 && !json) {
    process.stderr.write('usage: tandem status [--json]\n')
    return 2
  }
  let doc: TandemStatus
  try {
    doc = await statusDocument(opts)
  } catch {
    // The reason never crosses: it could name a path.
    process.stderr.write("tandem status: could not read this computer's state\n")
    return 1
  }
  process.stdout.write(json ? `${JSON.stringify(doc, null, 2)}\n` : renderStatus(doc))
  return 0
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) void main(process.argv.slice(2)).then((code) => { process.exitCode = code })
