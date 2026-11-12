/**
 * control-socket.ts: the one thing the owner tells a running runtime to do over its own socket
 * (U-R1A-35B): turn the kill switch off, or say how it stands.
 *
 * Copied from the earlier product's bridge/control-socket.ts (synergy 8fc22da, the file the
 * installed 0.1.0 runtime runs): newline-delimited JSON over a unix socket, the socket 0600 in a
 * 0700 folder, an 8 KiB request cap, 16 connections, one answer per connection,
 * sendControlCommand. Changed: the commands (kill_switch_off, kill_switch_status), the path
 * (`<TANDEM_HOME, else ~/.tandem>/run/control.sock`, worked out at each call, no environment
 * override), and start: before anything at the path is removed it is probed, and one that answers
 * (another runtime, such as the installed one) is never taken.
 *
 * Stated limits: every agent is the same OS user as the owner (T23), so a 0600 socket admits every
 * agent too. The runtime tells the owner from an agent by the facts a request carries (caller
 * token, TMUX, the asking pid's ancestry: bridge/kill-switch.ts), and an agent can make those up
 * (an empty token, no TMUX, another process's pid) or detach to parent pid 1 before asking. The
 * switch is a best-effort stop against a hostile same-user agent; isolation = 36A tokens + R3
 * sandboxes.
 */
import { connect, createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Bounds one command. */
const MAX_REQUEST_BYTES = 8 * 1024

/** Bounds how long a connection may hold a slot. */
const CONNECTION_TIMEOUT_MS = 150_000

/** How long start waits for something at the path to accept before it counts as answering. */
const PROBE_MS = 1_000

export type ControlCommand =
  | { readonly op: 'kill_switch_off'; readonly pid: number; readonly caller_token?: string; readonly tmux?: string }
  | { readonly op: 'kill_switch_status' }

export interface ControlResult {
  readonly ok: boolean
  /** A short reason, never a path, a token, or a pid. */
  readonly error?: string
  readonly detail?: unknown
}

export interface ControlServer {
  readonly socketPath: string
  close(): Promise<void>
}

export function controlSocketPath(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'run', 'control.sock')
}

const OFF_KEYS = new Set(['op', 'pid', 'caller_token', 'tmux'])

/**
 * Parses one command. Anything the runtime does not implement is refused by name rather than
 * ignored, so a caller learns that its command did not run; a known command with any other key or
 * type is `malformed`.
 */
export function parseControlCommand(value: unknown): ControlCommand | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'malformed'
  const record = value as Record<string, unknown>
  if (record.op === 'kill_switch_status') return Object.keys(record).length === 1 ? { op: 'kill_switch_status' } : 'malformed'
  if (record.op !== 'kill_switch_off') return 'unknown_command'
  if (Object.keys(record).some((key) => !OFF_KEYS.has(key))) return 'malformed'
  const { pid, caller_token, tmux } = record
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return 'malformed'
  if (caller_token !== undefined && typeof caller_token !== 'string') return 'malformed'
  if (tmux !== undefined && typeof tmux !== 'string') return 'malformed'
  return {
    op: 'kill_switch_off',
    pid,
    ...(caller_token === undefined ? {} : { caller_token }),
    ...(tmux === undefined ? {} : { tmux }),
  }
}

/** 'answers' when something accepts a connection at `path` (or does not refuse within 1 s); else the refusal code. */
function probe(path: string): Promise<'answers' | string> {
  return new Promise((done) => {
    const c = connect(path)
    const timer = setTimeout(() => { c.destroy(); done('answers') }, PROBE_MS)
    c.on('connect', () => { clearTimeout(timer); c.destroy(); done('answers') })
    c.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); done(e.code ?? 'unknown') })
  })
}

export async function startControlServer(options: {
  readonly run: (command: ControlCommand) => Promise<ControlResult>
  readonly socketPath?: string
  readonly log?: (message: string) => void
}): Promise<ControlServer> {
  const socketPath = options.socketPath ?? controlSocketPath()
  const directory = dirname(socketPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('control directory is not owner-only')
  // Never take a socket another runtime answers on: only a stale one (refused) or none is removed.
  const found = await probe(socketPath)
  if (found === 'ECONNREFUSED') rmSync(socketPath, { force: true })
  else if (found !== 'ENOENT') throw new Error('control socket already answered by another runtime')

  const server: Server = createServer((connection) => handle(connection, options.run, options.log))
  // One command at a time is more than this surface needs; the bound exists so
  // a caller cannot hold connections open faster than they are answered.
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  chmodSync(socketPath, 0o600)

  return {
    socketPath,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { rmSync(socketPath, { force: true }); resolve() })
    }),
  }
}

function handle(
  connection: Socket,
  run: (command: ControlCommand) => Promise<ControlResult>,
  log?: (message: string) => void,
): void {
  connection.setTimeout(CONNECTION_TIMEOUT_MS, () => connection.destroy())
  connection.setEncoding('utf8')
  let body = ''
  let answered = false

  const answer = (result: ControlResult) => {
    if (answered) return
    answered = true
    connection.end(`${JSON.stringify(result)}\n`)
  }

  connection.on('error', () => connection.destroy())
  connection.on('data', (chunk) => {
    // Nothing is accumulated once this connection has been answered. Ending
    // closes only the write side, so a caller that keeps sending would
    // otherwise keep this buffer growing after it had been told the request
    // was too large - a bound that bounded nothing.
    if (answered) return
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      body = ''
      answer({ ok: false, error: 'too_large' })
      return
    }
    const newline = body.indexOf('\n')
    if (newline < 0) return
    const line = body.slice(0, newline)
    body = ''

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      answer({ ok: false, error: 'malformed' })
      return
    }
    const command = parseControlCommand(parsed)
    if (typeof command === 'string') {
      answer({ ok: false, error: command })
      return
    }
    void run(command)
      .then(answer)
      .catch(() => {
        // The reason never crosses: it could name a path.
        log?.('[tandem] control command failed')
        answer({ ok: false, error: 'failed' })
      })
  })
}

/**
 * Sends one command to a running runtime. A failure rejects with the socket's error code
 * (ENOENT: no socket file, ECONNREFUSED: nobody listens) or ETIMEDOUT when no answer comes in time.
 */
export async function sendControlCommand(
  socketPath: string,
  command: ControlCommand,
  timeoutMs = 10_000,
): Promise<ControlResult> {
  return new Promise<ControlResult>((resolve, reject) => {
    const connection = connect(socketPath)
    let body = ''
    const fail = (reason: string, code: string) => {
      connection.destroy()
      reject(Object.assign(new Error(reason), { code }))
    }
    const timer = setTimeout(() => fail('control timed out', 'ETIMEDOUT'), timeoutMs)
    timer.unref?.()

    connection.setEncoding('utf8')
    connection.on('connect', () => connection.write(`${JSON.stringify(command)}\n`))
    connection.on('data', (chunk) => { body += chunk })
    connection.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); fail('runtime unavailable', e.code ?? 'unknown') })
    connection.on('end', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(body) as ControlResult)
      } catch {
        reject(Object.assign(new Error('control response malformed'), { code: 'EBADMSG' }))
      }
    })
  })
}
