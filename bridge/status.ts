/**
 * status.ts: `tandem status [--json]` (U-R1A-40). One document: this computer and every other
 * computer of its roster, each with its sessions, their states and how old each reading is, plus
 * whether the runtime answers and whether the kill switch is on. The owner's terminal and the menu
 * bar list read the same document.
 *
 * It is built in this command's own process from the readers who_is_up uses (bridge/presence.ts,
 * which reads bridge/hub-presence.ts's state.db for the other computers); no runtime has to run.
 * The runtime is only probed: one `kill_switch_status` over its control socket
 * (bridge/control-socket.ts). Nothing under `run/` is ever made, removed or replaced here.
 *
 * No folder path, screen text, transcript, attach command, token or key is in any field: each
 * session row is picked field by field.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { controlSocketPath, sendControlCommand } from './control-socket.ts'
import type { Presence } from './presence.ts'

export const STATUS_VERSION = 2
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const PROBE_MS = 1500

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
  runtime: 'running' | 'not_running'
  killSwitch: 'on' | 'off'
  computers: StatusComputer[]
}
export type StatusOptions = { presence?: Presence; probe?: () => Promise<boolean>; now?: () => number }

/** True when the runtime's control socket answers `kill_switch_status` with anything parsed. */
async function runtimeAnswers(): Promise<boolean> {
  try {
    await sendControlCommand(controlSocketPath(), { op: 'kill_switch_status' }, PROBE_MS)
    return true
  } catch {
    return false
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
  const [up, running] = await Promise.all([presence.whoIsUp({ refresh: true }), (opts.probe ?? runtimeAnswers)()])
  return {
    statusVersion: STATUS_VERSION,
    version: VERSION,
    at: now(),
    runtime: running ? 'running' : 'not_running',
    killSwitch: killSwitchOn() ? 'on' : 'off',
    computers: [
      computer({ computer: up.computer, self: true, at: up.at, ageMs: up.ageMs, stale: false, more: 0 }, up.sessions),
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
  const lines = [`Tandem ${doc.version} · runtime ${doc.runtime === 'running' ? 'running' : 'not running'} · kill switch ${doc.killSwitch}`]
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
