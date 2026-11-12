/**
 * kill-switch.ts: one switch that stops every agent on this computer, and the cross-process count
 * behind the limits file's `session_cap` (plan row U-R1A-35).
 *
 * The switch is the file `<TANDEM_HOME, else ~/.tandem>/kill-switch`, worked out at each call.
 * Anything at that path (a file, a folder, a symlink) reads on, and so does a check that fails for
 * any reason but ENOENT: the switch fails closed. While it is on, route() refuses opens, sends with
 * text and relay starts (423, bridge/router.ts), TerminalSession types nothing and starts nothing
 * (bridge/terminal-session.ts) and the delivery hook hands nothing over (bridge/delivery-hooks.ts).
 * Only `tandem kill-switch off` at this computer removes the file: no route, tool or frame calls
 * release().
 *
 * A running runtime holds the switch on (U-R1A-35B, startKillSwitchGuard): once it has seen the
 * switch on it keeps it on in memory, puts the file back when it disappears without `off` (one
 * `kill_switch.tampered` audit line) and turns it off only when `tandem kill-switch off` asks over
 * the runtime's control socket (bridge/control-socket.ts) from outside every Tandem session: no
 * caller token, no TMUX naming Tandem's socket, no Tandem pane among the asking process's parents.
 * The CLI makes the same check on itself first, so an agent is refused with no runtime running.
 *
 * Stated limits: every agent is the same OS user as the owner (T23). It can kill or stop the
 * runtime (then remove the file), connect to the control socket itself with made-up facts (an empty
 * token, no TMUX, another process's pid), or detach to parent pid 1 before asking; a runtime
 * restarted by launchd/systemd starts unlatched if the file is gone by then. The switch is a
 * best-effort stop against a hostile same-user agent; isolation = 36A tokens + R3 sandboxes. Other
 * processes read the file, so they see a removed file for up to one guard tick (1 s) before it is
 * back; the runtime itself never does.
 *
 * engage() writes the file first, then presses each `ccm-` session's own interrupt key on Tandem's
 * own tmux socket (or ends it with `close`). It never signals a process and never stops the tmux
 * server. The tmux and harness modules are imported when needed, so the hook and the router load
 * only this file's node: imports.
 *
 * The cap counts, across every process, the distinct names of the `ccm-` sessions on Tandem's
 * socket plus the live reservations: files `<TANDEM_HOME>/opening/<name>` younger than 120 s,
 * written under the lock `<TANDEM_HOME>/opening/.lock`.
 */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { insideTandemSession, parentPidOf } from './caller-tokens.ts'
import type { ControlCommand, ControlResult } from './control-socket.ts'

export const KILL_SWITCH_ON =
  'kill switch on: nothing may start or be typed into on this computer until the owner runs tandem kill-switch off here'

export class KillSwitchError extends Error {
  constructor() {
    super(KILL_SWITCH_ON)
    this.name = 'KillSwitchError'
  }
}

const PREFIX = 'ccm-'
const RESERVATION_MS = 120_000
const STALE_LOCK_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 25
/** A session name (bridge/router.ts NAME_RE) that is also a plain file name in `opening/`. */
const RESERVABLE = /^[A-Za-z0-9._-]{1,200}$/
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

const tandemHome = () => resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code

export function killSwitchPath(): string {
  return join(tandemHome(), 'kill-switch')
}

/** This process's guard (a running runtime), or none. */
type Guard = { latched: boolean; tampered: number; lastTamperedAt?: number; failing?: boolean }
let guard: Guard | undefined

/**
 * True when anything is at the path or the check fails with anything but ENOENT; in a process that
 * runs a guard, also while the guard is latched.
 */
export function killSwitchOn(): boolean {
  return guard?.latched === true || switchFileOn()
}

function switchFileOn(): boolean {
  try {
    lstatSync(killSwitchPath())
    return true
  } catch (e) {
    return codeOf(e) !== 'ENOENT'
  }
}

/** Why the switch reads on though no `tandem kill-switch on` file is there; undefined for a plain file or none. */
function oddSwitch(): string | undefined {
  const path = killSwitchPath()
  try {
    return lstatSync(path).isFile() ? undefined : `tandem: ${path} is not a regular file; the switch stays on until you remove it yourself`
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? undefined : `tandem: cannot read the kill switch at ${path} (${codeOf(e) ?? reasonOf(e)}); it reads on`
  }
}

/** Creates `path` 0600 with `text` (never through a link); false when something is already there. */
function createFile(path: string, text: string): boolean {
  let fd: number
  try {
    fd = openSync(path, CREATE, 0o600)
  } catch (e) {
    if (codeOf(e) === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}

/** The `ccm-` session names on Tandem's socket; no server is no sessions. */
async function tandemSessions(): Promise<string[]> {
  const { tmux, tmuxFailureKind } = await import('./terminal-session.ts')
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}'])
    return out.split('\n').filter((n) => n.startsWith(PREFIX))
  } catch (e) {
    // U-R1A-19B's one classifier: a call that failed or timed out is never "nothing running". Nor is
    // no tmux program to ask (the classifier's no_server): it throws here, as before 19B.
    const kind = tmuxFailureKind(e)
    if ((e as { code?: unknown }).code !== 'ENOENT' && (kind === 'no_server' || kind === 'no_session')) return []
    throw e
  }
}

/** The session's own interrupt keys (its harness file's `keys.interrupt`), else Escape then C-c. */
async function interruptKeys(name: string): Promise<string[]> {
  const { TerminalSession } = await import('./terminal-session.ts')
  const { loadedHarnesses } = await import('./engine-registry.ts')
  const tag = await TerminalSession.engineTagOf(name)
  const keys = tag === undefined ? undefined : loadedHarnesses().get(tag)?.keys?.interrupt
  if (typeof keys === 'string') return [keys]
  return keys?.length ? [...keys] : ['Escape', 'C-c']
}

/**
 * Turns the switch on (the file first, so every refusal holds before any key is pressed), then
 * stops every `ccm-` session on Tandem's socket: its interrupt keys 150 ms apart, as
 * TerminalSession.interrupt presses them, or kill-session with `close`. Names are reported without
 * the prefix; one that fails goes to `failed` and the rest go on.
 */
export async function engage(opts: { close?: boolean } = {}): Promise<{ stopped: string[]; closed: string[]; failed: string[] }> {
  const home = tandemHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  createFile(killSwitchPath(), `on ${new Date().toISOString()}\n`)
  if (!killSwitchOn()) throw new Error(`tandem: the kill switch did not turn on at ${killSwitchPath()}`)

  const { tmux } = await import('./terminal-session.ts')
  const { clearTurn } = await import('./delivery-hooks.ts')
  const stopped: string[] = []
  const closed: string[] = []
  const failed: string[] = []
  let sessions: string[]
  try {
    sessions = await tandemSessions()
  } catch (e) {
    throw new Error(`tandem: the kill switch is on, but the sessions could not be listed, so none was stopped (${reasonOf(e)})`)
  }
  await Promise.all(
    sessions.map(async (full) => {
      const name = full.slice(PREFIX.length)
      try {
        if (opts.close) {
          await tmux(['kill-session', '-t', `=${full}`])
          closed.push(name)
          // The ended session's caller token goes too (36A audit G2). A failure is ignored: a stdio
          // server already refuses a token whose session is gone (36A F2), so a left row is harmless.
          try {
            ;(await import('./caller-tokens.ts')).revokeCallerToken(name)
          } catch {
            /* harmless, as above */
          }
          return
        }
        for (const [i, key] of (await interruptKeys(name)).entries()) {
          if (i > 0) await sleep(150)
          await tmux(['send-keys', '-t', `=${full}:`, key])
        }
        stopped.push(name)
      } catch {
        failed.push(name)
      } finally {
        // As HarnessSession.interrupt does: a hook agent's turn file would read working for 15 minutes more.
        clearTurn(name)
      }
    }),
  )
  return { stopped, closed, failed }
}

/** Turns the switch off: removes a regular file (true); nothing there is false; anything else throws and stays on. */
export function release(): boolean {
  const path = killSwitchPath()
  let isFile: boolean
  try {
    isFile = lstatSync(path).isFile()
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return false
    throw new Error(`tandem: cannot read the kill switch at ${path} (${codeOf(e) ?? reasonOf(e)}); it stays on`)
  }
  if (!isFile) throw new Error(`tandem: ${path} is not a regular file; it stays on until you remove it yourself`)
  unlinkSync(path)
  return true
}

const restoredText = () => `on ${new Date().toISOString()} restored\n`

/**
 * The runtime's hold on the switch. At start it latches when the switch reads on; each tick a file
 * that reads on latches it, and while latched a missing file (ENOENT) is written back exactly as
 * engage() writes it, with one `kill_switch.tampered` audit line. A folder or symlink at the path
 * reads on and is left alone. While it runs, killSwitchOn() in this process answers latched or the
 * file; only the control socket's kill_switch_off (runKillSwitchCommand) unlatches it.
 */
export function startKillSwitchGuard(opts: { everyMs?: number } = {}): {
  stop(): void
  state(): { latched: boolean; tampered: number; lastTamperedAt?: number }
} {
  if (guard) throw new Error('tandem: a kill switch guard already runs in this process')
  const g: Guard = { latched: switchFileOn(), tampered: 0 }
  guard = g
  const tick = () => {
    if (guard !== g) return
    if (switchFileOn()) {
      g.latched = true
      g.failing = false
      return
    }
    if (!g.latched) return
    let restored = false
    try {
      mkdirSync(tandemHome(), { recursive: true, mode: 0o700 })
      createFile(killSwitchPath(), restoredText())
      restored = switchFileOn()
    } catch {
      restored = false
    }
    // One record per removal; a restore that failed is tried again each tick without another record.
    if (!g.failing) {
      g.tampered++
      g.lastTamperedAt = Date.now()
      void import('./audit.ts').then(({ audit }) => audit({ event: 'kill_switch.tampered', restored }))
      // The latch keeps this process refusing either way.
      if (!restored) process.stderr.write('tandem: the kill switch file was removed without off and could not be restored; this runtime still refuses\n')
    }
    g.failing = !restored
  }
  const timer = setInterval(tick, opts.everyMs ?? 1_000)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      if (guard === g) guard = undefined
    },
    state: () => ({ latched: g.latched, tampered: g.tampered, ...(g.lastTamperedAt === undefined ? {} : { lastTamperedAt: g.lastTamperedAt }) }),
  }
}

/** The facts an `off` carries about who asks. */
type OffFacts = { pid: number; caller_token?: string; tmux?: string }

/**
 * Why `off` with these facts is refused, or undefined for the owner: `agent_refused` for a caller
 * token, a TMUX naming Tandem's socket, or a pid inside a Tandem session; `cannot_tell` when that
 * cannot be worked out.
 */
export async function offRefusal(facts: OffFacts): Promise<'agent_refused' | 'cannot_tell' | undefined> {
  if (typeof facts.caller_token === 'string' && facts.caller_token !== '') return 'agent_refused'
  try {
    const { tmuxSocketPath } = await import('./terminal-session.ts')
    const sock = tmuxSocketPath()
    let real = sock
    try {
      real = realpathSync(sock)
    } catch {
      /* no socket yet */
    }
    if (typeof facts.tmux === 'string' && (facts.tmux.startsWith(`${sock},`) || facts.tmux.startsWith(`${real},`))) return 'agent_refused'
    return (await insideTandemSession(facts.pid)) === undefined ? undefined : 'agent_refused'
  } catch {
    return 'cannot_tell'
  }
}

/** The runtime's answer to a control command (src/server.ts passes this to startControlServer). */
export async function runKillSwitchCommand(command: ControlCommand): Promise<ControlResult> {
  if (command.op === 'kill_switch_status') {
    return {
      ok: true,
      detail: {
        on: killSwitchOn(),
        latched: guard?.latched ?? false,
        tampered: guard?.tampered ?? 0,
        last_tampered_at: guard?.lastTamperedAt === undefined ? null : new Date(guard.lastTamperedAt).toISOString(),
      },
    }
  }
  const { audit } = await import('./audit.ts')
  const refused = await offRefusal(command)
  if (refused) {
    // A refused ask is recorded too. The pid is what the asker said (the socket gives no peer pid).
    audit({
      event: 'kill_switch.off_refused',
      by: 'control',
      why: refused,
      pid: command.pid,
      had_token: typeof command.caller_token === 'string' && command.caller_token !== '',
      had_tmux: typeof command.tmux === 'string' && command.tmux !== '',
    })
    return { ok: false, error: refused }
  }
  // Unlatch and remove in one synchronous step: no tick can run between them and latch again.
  const wasLatched = guard?.latched === true
  let removed: boolean
  try {
    if (guard) guard.latched = false
    removed = release()
  } catch {
    // Not a regular file: it reads on, so the next tick latches again.
    return { ok: false, error: 'stays_on' }
  }
  let ppid: number | null = null
  try {
    ppid = await parentPidOf(command.pid)
  } catch {
    /* recorded as unknown */
  }
  audit({ event: 'kill_switch.off', by: 'control', pid: command.pid, ppid })
  return { ok: true, detail: { was_on: wasLatched || removed } }
}

const OFF_REFUSED = {
  agent_refused: 'tandem: kill switch off refused: run it from your own terminal, not from inside a Tandem session',
  cannot_tell: 'tandem: kill switch off refused: cannot tell whether this runs inside a Tandem session',
} as const

/** Longer than one guard tick (1 s): a runtime that still holds the switch has put the file back by then. */
const CONFIRM_MS = 1_200
const CAME_BACK =
  'tandem: the kill switch came back on: a running runtime put its file back; stop that runtime, then run tandem kill-switch off again'

/** `tandem kill-switch off`: the owner check here, then the runtime's control socket, else the file. */
async function off(say: (line: string) => void): Promise<number> {
  const warn = (line: string) => process.stderr.write(`${line}\n`)
  // Off is only said once it has held for a tick: a latched runtime this ask did not reach (its
  // socket gone, or a second runtime on this home) puts the file back, and then it is not off.
  const done = async (wasOn: boolean): Promise<number> => {
    if (!wasOn) {
      say('tandem: kill switch was already off')
      return 0
    }
    await sleep(CONFIRM_MS)
    if (switchFileOn()) {
      warn(CAME_BACK)
      return 1
    }
    say('tandem: kill switch off')
    return 0
  }
  const token = process.env.TANDEM_CALLER_TOKEN
  const tmuxEnv = process.env.TMUX
  const facts: OffFacts = {
    pid: process.pid,
    ...(token === undefined ? {} : { caller_token: token }),
    ...(tmuxEnv === undefined ? {} : { tmux: tmuxEnv }),
  }
  const own = await offRefusal(facts)
  if (own) {
    warn(OFF_REFUSED[own])
    return 1
  }
  const { controlSocketPath, sendControlCommand } = await import('./control-socket.ts')
  let answer: ControlResult
  try {
    answer = await sendControlCommand(controlSocketPath(), { op: 'kill_switch_off', ...facts })
  } catch (e) {
    if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ECONNREFUSED') {
      // No runtime: the file alone, as before.
      return done(release())
    }
    warn('tandem: the runtime did not answer; the switch stays on')
    return 1
  }
  if (answer.ok) {
    return done((answer.detail as { was_on?: unknown } | undefined)?.was_on !== false)
  }
  if (answer.error === 'agent_refused' || answer.error === 'cannot_tell') {
    warn(OFF_REFUSED[answer.error])
    return 1
  }
  if (answer.error === 'unknown_command') {
    const removed = release()
    warn('tandem: the running runtime is older and keeps no switch record')
    return done(removed)
  }
  warn(`tandem: kill switch off failed (${String(answer.error)}); the switch stays on`)
  return 1
}

/** The runtime's restore count line for `status`, when a runtime answers and has restored the file. */
async function restoredLine(): Promise<string | undefined> {
  try {
    const { controlSocketPath, sendControlCommand } = await import('./control-socket.ts')
    const answer = await sendControlCommand(controlSocketPath(), { op: 'kill_switch_status' })
    const d = answer.detail as { tampered?: unknown; last_tampered_at?: unknown } | undefined
    if (answer.ok && typeof d?.tampered === 'number' && d.tampered > 0) {
      return `tandem: the runtime restored the switch ${d.tampered} times after it was removed without off (last ${String(d.last_tampered_at)})`
    }
  } catch {
    /* no runtime: nothing more to say */
  }
  return undefined
}

/** Takes `<dir>/.lock`, removing one older than 30 s; undefined when still busy after 5 s. */
async function takeLock(lock: string): Promise<boolean> {
  const end = Date.now() + LOCK_WAIT_MS
  for (;;) {
    if (createFile(lock, `${process.pid}\n`)) return true
    try {
      // ponytail: two waiters can both see one stale lock; the second removes the first's new one.
      // A lock is held for milliseconds, so a stale one means a crashed holder; rename-and-check if it matters.
      if (Date.now() - lstatSync(lock).mtimeMs > STALE_LOCK_MS) {
        rmSync(lock, { force: true })
        continue
      }
    } catch (e) {
      if (codeOf(e) === 'ENOENT') continue
      throw e
    }
    if (Date.now() >= end) return false
    await sleep(LOCK_POLL_MS)
  }
}

/**
 * Reserves a slot under the cap for each name not already counted, or refuses with the text the
 * router answers. `release()` removes this call's reservations (the sessions, once they exist,
 * count on the socket instead).
 */
export async function reserveSessions(names: string[], cap: number): Promise<{ release(): void } | { refused: string }> {
  // A cap lost on the way here (not a whole number of 1 or more) must never read as no cap.
  if (!Number.isInteger(cap) || cap < 1) throw new Error('tandem: session_cap is not a whole number of 1 or more')
  for (const n of names) {
    if (!RESERVABLE.test(n) || n === '.' || n === '..' || n === '.lock') throw new Error(`tandem: cannot reserve the session name ${JSON.stringify(n)}`)
  }
  const dir = join(tandemHome(), 'opening')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error(`tandem: ${dir} is not a folder`)
  const lock = join(dir, '.lock')
  if (!(await takeLock(lock))) return { refused: 'limits: session_cap check busy; try again' }
  try {
    const counted = new Set((await tandemSessions()).map((n) => n.slice(PREFIX.length)))
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      if (f === '.lock') continue
      try {
        const st = lstatSync(join(dir, f))
        if (st.isFile() && now - st.mtimeMs < RESERVATION_MS) counted.add(f)
        else if (st.isFile()) rmSync(join(dir, f), { force: true })
      } catch {
        /* gone meanwhile */
      }
    }
    const fresh = [...new Set(names)].filter((n) => !counted.has(n))
    if (counted.size + fresh.length > cap) {
      return { refused: `limits: session_cap ${cap} reached (${counted.size} sessions open); close one first` }
    }
    const written: string[] = []
    try {
      for (const n of fresh) {
        const path = join(dir, n)
        rmSync(path, { force: true })
        if (!createFile(path, `${process.pid}\n`)) throw new Error(`tandem: ${path} appeared while the lock was held`)
        written.push(path)
      }
    } catch (e) {
      for (const p of written) rmSync(p, { force: true })
      throw e
    }
    return {
      release() {
        for (const p of written) rmSync(p, { force: true })
      },
    }
  } finally {
    rmSync(lock, { force: true })
  }
}

const USAGE = [
  'usage: tandem kill-switch on [--close]   stop every agent here: interrupt each session, or end them with --close;',
  '                                         nothing starts or is typed until tandem kill-switch off',
  '       tandem kill-switch off|status',
  '',
].join('\n')

/** `tandem kill-switch on [--close] | off | status`; 0 done, 1 an error or a session not stopped, 2 usage. */
export async function main(args: string[]): Promise<number> {
  const say = (line: string) => process.stdout.write(`${line}\n`)
  try {
    const [command, ...rest] = args
    if (command === 'on' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--close'))) {
      const close = rest[0] === '--close'
      const { stopped, closed, failed } = await engage({ close })
      say(`tandem: kill switch on; ${close ? `${closed.length} sessions ended` : `${stopped.length} sessions stopped`}`)
      for (const name of failed) say(`tandem: not stopped: ${name}`)
      return failed.length ? 1 : 0
    }
    if (command === 'off' && rest.length === 0) return await off(say)
    if (command === 'status' && rest.length === 0) {
      say(`tandem: kill switch ${killSwitchOn() ? 'on' : 'off'}`)
      const odd = oddSwitch()
      if (odd) process.stderr.write(`${odd}\n`)
      const restored = await restoredLine()
      if (restored) say(restored)
      return 0
    }
    process.stderr.write(USAGE)
    return 2
  } catch (e) {
    const reason = reasonOf(e)
    process.stderr.write(`${reason.startsWith('tandem: ') ? reason : `tandem: ${reason}`}\n`)
    return 1
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
