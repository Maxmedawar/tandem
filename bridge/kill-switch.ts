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
 * engage() writes the file first, then presses each `ccm-` session's own interrupt key on Tandem's
 * own tmux socket (or ends it with `close`). It never signals a process and never stops the tmux
 * server. The tmux and harness modules are imported when needed, so the hook and the router load
 * only this file's node: imports.
 *
 * The cap counts, across every process, the distinct names of the `ccm-` sessions on Tandem's
 * socket plus the live reservations: files `<TANDEM_HOME>/opening/<name>` younger than 120 s,
 * written under the lock `<TANDEM_HOME>/opening/.lock`.
 */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** True when anything is at the path or the check fails with anything but ENOENT. */
export function killSwitchOn(): boolean {
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
  const { tmux } = await import('./terminal-session.ts')
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}'])
    return out.split('\n').filter((n) => n.startsWith(PREFIX))
  } catch (e) {
    if (/no server running|error connecting to/.test(String(e))) return []
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
    if (command === 'off' && rest.length === 0) {
      say(release() ? 'tandem: kill switch off' : 'tandem: kill switch was already off')
      return 0
    }
    if (command === 'status' && rest.length === 0) {
      say(`tandem: kill switch ${killSwitchOn() ? 'on' : 'off'}`)
      const odd = oddSwitch()
      if (odd) process.stderr.write(`${odd}\n`)
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
