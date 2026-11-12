/**
 * U-R1A-36F: no caller token ever sits in the Tandem tmux server's command line.
 *
 * A tmux server started by `new-session` keeps that client's argv for its whole life, so the first
 * session on a fresh socket used to leave `-e TANDEM_CALLER_TOKEN=<token>` in `ps` for every local
 * user (36C G1). The tmux runner now starts the server first, in its own call with no token
 * (`start-server ; set-option -s exit-empty off`), before every `new-session` that carries `-e`.
 *
 * Every case runs on its own fresh private socket (its own TANDEM_HOME) under one mkdtemp folder
 * named r1a36f- in TMPDIR; HOME is in it too, TMUX is deleted before the dynamic imports. afterAll
 * ends every server on those sockets and removes the folder. Tokens are compared in code only and
 * never printed: every assertion that touches one is a boolean.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BOX = mkdtempSync(join(tmpdir(), 'r1a36f-'))
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
mkdirSync(HOME)
mkdirSync(WORK)
delete process.env.TMUX
delete process.env.TMUX_PANE
delete process.env.TANDEM_CALLER_TOKEN
process.env.TMUX_TMPDIR = BOX
process.env.HOME = HOME
process.env.TANDEM_HOME = join(HOME, '.tandem')
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_WAIT_MS = '8000'

const { TerminalSession, tmux, tmuxSocketPath } = await import('../bridge/terminal-session.ts')
type TmuxExec = import('../bridge/terminal-session.ts').TmuxExec
type EngineDescriptor = import('../bridge/drivable.ts').EngineDescriptor
const { mintCallerToken, resolveCallerToken, revokeCallerToken } = await import('../bridge/caller-tokens.ts')

const START = ['start-server', ';', 'set-option', '-s', 'exit-empty', 'off']
const sockets: string[] = []

/** A fresh private Tandem socket for one case: a new TANDEM_HOME under BOX. */
function freshSocket(): string {
  process.env.TANDEM_HOME = mkdtempSync(join(BOX, 'th-'))
  const sock = tmuxSocketPath()
  sockets.push(sock)
  return sock
}
const raw = (sock: string, args: string[]) => {
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  return spawnSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env })
}
const serverPid = (sock: string): number => {
  const r = raw(sock, ['display', '-p', '#{pid}'])
  if (r.status !== 0) return 0
  return Number(r.stdout.trim())
}
/** The server's argv as elements: /proc/<pid>/cmdline on Linux, `ps -o args=` (split on spaces) on darwin. */
function serverArgv(pid: number): string[] {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
  return r.stdout.trim().split(/\s+/).filter(Boolean)
}
/** True when argv holds no `-e` element and no element holds TANDEM_CALLER_TOKEN or any token. */
const clean = (argv: string[], tokens: string[]): boolean =>
  argv.length > 0 &&
  !argv.some((a) => a === '-e' || a.includes('TANDEM_CALLER_TOKEN') || tokens.some((t) => t.length > 0 && a.includes(t)))

/** A pane that writes its own TANDEM_CALLER_TOKEN to <WORK>/<name>.tok, then echoes (warmup line). */
const tokenWriter = (name: string): EngineDescriptor => ({
  id: 'shell',
  argv: ['/bin/sh', '-c', `printf %s "$TANDEM_CALLER_TOKEN" > '${join(WORK, `${name}.tok`)}'; exec cat`],
  warmupPrompt: 'ready',
  minStableMs: 0,
})
const open = (name: string) =>
  TerminalSession.spawn({ name, cwd: WORK, allowlist: [WORK], descriptor: tokenWriter(name), ownerIdProvider: async () => 'r1a36f-owner' })
/** The token the session's pane received (read from its file; compared, never printed). */
async function paneToken(name: string): Promise<string> {
  const file = join(WORK, `${name}.tok`)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(file) && statSync(file).size > 0) return readFileSync(file, 'utf8')
    await new Promise((r) => setTimeout(r, 50))
  }
  return ''
}

/** An exec spy: records every argv; runs it with the real tmux unless `skipNewSession` and it is new-session. */
function spy(log: string[][], skipNewSession = false): TmuxExec {
  return (argv, opts, cb) => {
    log.push([...argv])
    if (skipNewSession && argv.includes('new-session')) return cb(Object.assign(new Error('skipped by spy'), { code: 1 }), '', 'skipped by spy')
    execFile('tmux', argv, opts, (error, stdout, stderr) => cb(error, String(stdout), String(stderr)))
  }
}

afterAll(() => {
  for (const sock of sockets) if (existsSync(sock)) raw(sock, ['kill-server'])
  rmSync(BOX, { recursive: true, force: true })
})

describe('U-R1A-36F the Tandem tmux server starts without a caller token', () => {
  it('(a) the runner\'s start-server call alone keeps a server with no sessions alive 3 s', async () => {
    const sock = freshSocket()
    const log: string[][] = []
    await expect(tmux(['new-session', '-d', '-s', 'ccm-a36f', '-e', 'R1A36F_PROBE=1', 'cat'], spy(log, true))).rejects.toThrow(/skipped by spy/)
    expect(log.some((argv) => argv.join(' ') === ['-S', sock, ...START].join(' '))).toBe(true)
    await new Promise((r) => setTimeout(r, 3_000))
    expect(serverPid(sock)).toBeGreaterThan(0)
    const ls = raw(sock, ['list-sessions', '-F', '#{session_name}'])
    expect(/no server running|error connecting/.test(ls.stderr)).toBe(false)
    expect(ls.stdout.trim()).toBe('')
  }, 20_000)

  it('(b) first open with a token: the server argv holds neither the token, -e, nor TANDEM_CALLER_TOKEN', async () => {
    const sock = freshSocket()
    expect(serverPid(sock)).toBe(0)
    await open('b36f')
    const token = await paneToken('b36f')
    expect(resolveCallerToken(token)).toBe('b36f')
    const pid = serverPid(sock)
    expect(pid).toBeGreaterThan(0)
    expect(clean(serverArgv(pid), [token])).toBe(true)
  }, 30_000)

  it('(c) the session\'s pane still gets its own token; the tmux session environment keeps it unset (36A F1)', async () => {
    const sock = freshSocket()
    await open('c36f')
    const token = await paneToken('c36f')
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true)
    expect(resolveCallerToken(token)).toBe('c36f')
    const env = raw(sock, ['show-environment', '-t', '=ccm-c36f', 'TANDEM_CALLER_TOKEN'])
    // tmux answers "unknown variable" (or `-NAME` on a server that lists removed ones): never a value.
    expect(env.stdout.includes('TANDEM_CALLER_TOKEN=') || env.stdout.includes(token)).toBe(false)
  }, 30_000)

  it('(d) two racing first opens give exactly one server pid and two sessions', async () => {
    const sock = freshSocket()
    expect(serverPid(sock)).toBe(0)
    await Promise.all([open('d36f-1'), open('d36f-2')])
    const pids = ['d36f-1', 'd36f-2'].map((n) => Number(raw(sock, ['display', '-p', '-t', `=ccm-${n}:`, '#{pid}']).stdout.trim()))
    expect(pids[0]).toBeGreaterThan(0)
    expect(pids[1]).toBe(pids[0])
    expect(serverPid(sock)).toBe(pids[0])
    expect(raw(sock, ['list-sessions', '-F', '#{session_name}']).stdout.trim().split('\n').sort()).toEqual(['ccm-d36f-1', 'ccm-d36f-2'])
    const tokens = [await paneToken('d36f-1'), await paneToken('d36f-2')]
    expect(clean(serverArgv(pids[0]), tokens)).toBe(true)
  }, 40_000)

  it('(e) a second open on the running server works and the server pid is unchanged', async () => {
    const sock = freshSocket()
    await open('e36f-1')
    const pid = serverPid(sock)
    expect(pid).toBeGreaterThan(0)
    await open('e36f-2')
    expect(serverPid(sock)).toBe(pid)
    expect(raw(sock, ['has-session', '-t', '=ccm-e36f-2']).status).toBe(0)
    const tokens = [await paneToken('e36f-1'), await paneToken('e36f-2')]
    expect(resolveCallerToken(tokens[1])).toBe('e36f-2')
    expect(clean(serverArgv(pid), tokens)).toBe(true)
  }, 40_000)

  it('(f) the start-server argv recorded by an exec spy carries no -e and no token', async () => {
    const sock = freshSocket()
    const token = mintCallerToken('f36f', WORK)
    try {
      const log: string[][] = []
      await tmux(['new-session', '-d', '-s', 'ccm-f36f', '-e', `TANDEM_CALLER_TOKEN=${token}`, '-c', WORK, 'cat'], spy(log))
      expect(log.length).toBe(2)
      expect(log[0].join(' ') === ['-S', sock, ...START].join(' ')).toBe(true)
      expect(clean(log[0], [token])).toBe(true)
      expect(log[1].includes('new-session')).toBe(true)
      expect(clean(serverArgv(serverPid(sock)), [token])).toBe(true)
    } finally {
      revokeCallerToken('f36f')
    }
  }, 20_000)
})
