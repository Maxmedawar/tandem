/**
 * presence.ts: who is up on this computer (plan section 2, Presence). Every session Tandem runs
 * here, its agent, project, folder and state (working, idle, waiting_for_approval, unknown), with
 * the time that state was read and how old the reading is. The tool who_is_up (src/mcp-server.ts)
 * answers from it.
 *
 * Each state is one read through the input gate's readInput (one screen capture read by the
 * harness rules, no debounce; no inputState, a read that throws or no answer in 2000 ms is
 * `unknown`). Rows are read in parallel, so one reading waits about 2 s at most. It reads
 * screens and types nothing; no screen text, transcript or attach command is in any field.
 * With `rowMs` (the runtime's status: 600 ms), a row whose read gives no answer in that time
 * reads `unknown` and the late read is left to finish.
 *
 * Heartbeat: a reading younger than HEARTBEAT_MS is answered again (only ageMs grows); at
 * HEARTBEAT_MS or older, or with refresh, it reads first. Calls that arrive while a reading is
 * under way share it. No timer runs between calls.
 *
 * Other computers (U-R1A-33B-3): with a roster holding another computer, the answer also has
 * `others`, what this computer last received from each of them through the hub
 * (bridge/hub-presence.ts readRemotePresence), read at each call, never cached by the heartbeat;
 * their rows carry no folder. With no roster, or a roster of this computer alone, the answer is
 * as before. A remote read that throws gives `others: []` and one stderr line, never a failed call.
 */
import { hostname } from 'node:os'
import { readInput } from './input-gate.ts'
import { deriveBridgeId } from './hub-link.ts'
import { getLive, listSessions, type SessionInfo } from './sessions.ts'
import { readRemotePresence, type RemoteReading } from './hub-presence.ts'

export type { SessionInfo }
export const HEARTBEAT_MS = 10_000

export type PresenceState = 'working' | 'idle' | 'waiting_for_approval' | 'unknown'
export interface PresenceRow { name: string; engine: string; project: string; cwd: string; state: PresenceState; stateAt: number; ageMs: number }
/** Times are ms since the epoch; `at` is the reading's time and each ageMs is now minus it. */
export interface PresenceAnswer { computer: string; at: number; ageMs: number; sessions: PresenceRow[]; others?: RemoteReading[] }
export interface Presence {
  whoIsUp(opts?: { refresh?: boolean }): Promise<PresenceAnswer>
  /** The session names, sorted, from one list (no screen read): the hub carrier pushes when they change. */
  names(): Promise<string[]>
}

const STATES: ReadonlySet<string> = new Set(['working', 'idle', 'waiting_for_approval'])
type Reading = { at: number; rows: Omit<PresenceRow, 'ageMs'>[] }

export function createPresence(options: {
  now?: () => number
  list?: () => Promise<SessionInfo[]>
  live?: (name: string) => object | undefined
  computer?: string
  /** Test seam: the other computers' readings (default readRemotePresence on state.db). */
  remote?: { read(): RemoteReading[] }
  /** The longest one session's screen read may take before that row reads `unknown`; unset: readInput's own 2,000 ms. */
  rowMs?: number
} = {}): Presence {
  const now = options.now ?? Date.now
  const list = options.list ?? (async () => (await listSessions({ limit: Number.MAX_SAFE_INTEGER })).sessions)
  const live = options.live ?? getLive
  const computer = options.computer ?? deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname())
  const remote = options.remote ?? { read: () => readRemotePresence({ now, self: computer }) }
  let last: Reading | undefined
  let under: Promise<Reading> | undefined

  async function stateOf(name: string): Promise<PresenceState> {
    try {
      const session = live(name)
      if (session === undefined) return 'unknown'
      const read = readInput(session).then((r) => r.state)
      let timer: ReturnType<typeof setTimeout> | undefined
      const state = options.rowMs === undefined
        ? await read
        : await Promise.race([read, new Promise<string>((done) => { timer = setTimeout(() => done('unknown'), options.rowMs) })]).finally(() => clearTimeout(timer))
      return STATES.has(state) ? (state as PresenceState) : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async function read(): Promise<Reading> {
    const sessions = await list()
    const rows = await Promise.all(sessions.map(async (s) => {
      const state = await stateOf(s.id)
      return { name: s.id, engine: s.engine, project: s.project, cwd: s.cwd, state, stateAt: now() }
    }))
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { at: now(), rows }
  }

  return {
    async whoIsUp(opts = {}) {
      if (opts.refresh || last === undefined || now() - last.at >= HEARTBEAT_MS) {
        under ??= read().finally(() => { under = undefined })
        last = await under
      }
      const t = now()
      const { at, rows } = last
      const answer: PresenceAnswer = { computer, at, ageMs: t - at, sessions: rows.map((r) => ({ ...r, ageMs: t - r.stateAt })) }
      let others: RemoteReading[]
      try {
        others = remote.read()
      } catch {
        process.stderr.write('who_is_up: the other computers could not be read\n')
        others = []
        answer.others = others
      }
      if (others.length > 0) answer.others = others
      return answer
    },
    async names() {
      return (await list()).map((s) => s.id).sort()
    },
  }
}
