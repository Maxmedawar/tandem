/**
 * U-R1A-35B: a running runtime holds the kill switch on. Once it has seen the switch on it keeps it
 * on in memory, puts a removed switch file back (one `kill_switch.tampered` audit line), and turns
 * it off only when `tandem kill-switch off` asks over the runtime's own control socket from outside
 * every Tandem session. `kill-switch on --close` revokes each ended session's caller token.
 *
 * Everything lives in one r1a35b- folder: TMUX is unset and TMUX_TMPDIR, HOME and TANDEM_HOME are in
 * it before any import. A runtime is a child process running a small script this file writes (the
 * guard with everyMs 100 and the control server, under this file's TANDEM_HOME), in its own process
 * group. Tandem sessions are plain `sh` panes on this folder's Tandem tmux socket. afterAll ends the
 * runtimes, ends every tmux server whose socket is in the folder, then removes it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const KS = join(repo, 'bridge', 'kill-switch.ts')
const BOX = mkdtempSync(join(tmpdir(), 'r1a35b-'))
delete process.env.TMUX
delete process.env.TANDEM_CALLER_TOKEN
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
for (const d of [HOME, WORK]) mkdirSync(d)
mkdirSync(join(TH, 'tmux'), { recursive: true, mode: 0o700 })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.SHELL = '/bin/sh'

const cs = await import('../bridge/control-socket.ts')
const { mintCallerToken, resolveCallerToken } = await import('../bridge/caller-tokens.ts')

const SWITCH = join(TH, 'kill-switch')
const CTL = join(TH, 'run', 'control.sock')
const SOCK = join(TH, 'tmux', 'tandem')
const AUDIT = join(TH, 'bridge.log')
const REFUSED = 'tandem: kill switch off refused: run it from your own terminal, not from inside a Tandem session'
const STDIO_REFUSED = 'tandem stdio: caller token unknown; refusing to start'
const ISO = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
vi.setConfig({ testTimeout: 30_000 })

/** A child's environment: this file's folders, nothing of the caller's TMUX, TANDEM_* or CCM_*. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  return Object.assign(env, { HOME, TANDEM_HOME: TH, TMUX_TMPDIR: BOX, SHELL: '/bin/sh', NODE_NO_WARNINGS: '1' }, extra)
}

async function until(test: () => boolean, ms: number, every = 10): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(every)
  }
  return test()
}

function auditLines(event: string): Json[] {
  if (!existsSync(AUDIT)) return []
  return readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === event)
}

/** The switch on by its file alone, as engage() writes it. */
function switchFile() {
  writeFileSync(SWITCH, `on ${new Date().toISOString()}\n`, { mode: 0o600 })
}

const KIDS = new Set<ChildProcess>()
/** Signals a child this file started, by its own process group only. */
function killGroup(p: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    if (p.pid) process.kill(-p.pid, signal)
  } catch {
    /* gone */
  }
}

/** `node bridge/kill-switch.ts <args>` as its own process (async, so a server in this process can answer). */
function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, ['--experimental-strip-types', KS, ...args], { env: childEnv(extra), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    KIDS.add(p)
    const out = { stdout: '', stderr: '' }
    p.stdout!.on('data', (d) => { out.stdout += d })
    p.stderr!.on('data', (d) => { out.stderr += d })
    const timer = setTimeout(() => killGroup(p, 'SIGKILL'), 25_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      KIDS.delete(p)
      resolve({ code, ...out, ms: Date.now() - t0 })
    })
  })
}
const tandemLines = (text: string) => text.split('\n').filter((l) => l.startsWith('tandem'))

// ---- the runtime: guard + control server in a child process ----------------------------------
const RT = join(BOX, 'rt.mjs')
writeFileSync(RT, `
import { createInterface } from 'node:readline'
import { existsSync, rmSync } from 'node:fs'
const ks = await import(${JSON.stringify(pathToFileURL(KS).href)})
const cs = await import(${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'control-socket.ts')).href)})
const { route } = await import(${JSON.stringify(pathToFileURL(join(repo, 'bridge', 'router.ts')).href)})
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let guard, server
try { guard = ks.startKillSwitchGuard({ everyMs: 100 }) } catch (e) { process.stderr.write('guard: ' + e + '\\n') }
try { server = await cs.startControlServer({ run: ks.runKillSwitchCommand }) } catch (e) { process.stderr.write('control: ' + e + '\\n') }
let sampler, samples = 0, falses = 0
process.on('SIGTERM', async () => { guard?.stop(); await server?.close().catch(() => {}); process.exit(0) })
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line === 'watch') { samples = 0; falses = 0; sampler = setInterval(() => { samples++; if (!ks.killSwitchOn()) falses++ }, 10); out({ ok: true }) }
  else if (line === 'unwatch') { clearInterval(sampler); out({ samples, falses }) }
  else if (line === 'gap-open') {
    rmSync(${JSON.stringify(SWITCH)})
    const gone = !existsSync(${JSON.stringify(SWITCH)})
    const r = await route({ method: 'POST', path: '/sessions/open', query: new URLSearchParams(), body: { engine: 'shell', name: 'r35b-gap', cwd: ${JSON.stringify(WORK)} } })
    out({ gone, status: r.status })
  }
  else if (line === 'state') out(guard ? guard.state() : null)
})
out({ ready: true, guard: !!guard, control: !!server })
`)

interface Runtime { proc: ChildProcess; ask(line: string): Promise<Json>; stderr: () => string; stop(): Promise<void> }
const RUNTIMES = new Set<Runtime>()
async function startRuntime(): Promise<Runtime> {
  const proc = spawn(process.execPath, ['--experimental-strip-types', RT], { env: childEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  KIDS.add(proc)
  let err = ''
  let buf = ''
  const waiting: ((v: Json) => void)[] = []
  proc.stderr!.on('data', (d) => { err += d })
  proc.stdout!.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      waiting.shift()?.(JSON.parse(line))
    }
  })
  const exited = new Promise<void>((r) => proc.on('close', () => { KIDS.delete(proc); r() }))
  const next = () => new Promise<Json>((resolve, reject) => {
    waiting.push(resolve)
    setTimeout(() => reject(new Error(`runtime gave no answer: ${err}`)), 15_000)
  })
  const ready = await next()
  expect(ready.ready, err).toBe(true)
  const rt: Runtime = {
    proc,
    async ask(line) {
      const p = next()
      proc.stdin!.write(`${line}\n`)
      return p
    },
    stderr: () => err,
    async stop() {
      RUNTIMES.delete(rt)
      killGroup(proc)
      await Promise.race([exited, sleep(5_000)])
      killGroup(proc, 'SIGKILL')
      await exited
    },
  }
  RUNTIMES.add(rt)
  return rt
}

/** One raw request on the control socket (one line, or the exact bytes given): the parsed answer. */
function ask(request: unknown, path = CTL): Promise<Json> {
  return new Promise((resolve, reject) => {
    const c = connect(path)
    let body = ''
    c.setEncoding('utf8')
    c.on('connect', () => c.write(typeof request === 'string' ? request : `${JSON.stringify(request)}\n`))
    c.on('data', (d) => { body += d })
    c.on('error', reject)
    c.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
  })
}
const status = () => ask({ op: 'kill_switch_status' })

/** A unix socket file nobody listens on: a node child listens, then exits without closing. */
function staleSocket(path: string) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`])
  expect(lstatSync(path).isSocket()).toBe(true)
}

// ---- Tandem sessions: plain sh panes on this folder's Tandem socket ---------------------------
function paneSession(name: string): number {
  const full = `ccm-${name}`
  const has = spawnSync('tmux', ['-S', SOCK, 'has-session', '-t', `=${full}`], { env: childEnv() }).status === 0
  if (!has) execFileSync('tmux', ['-S', SOCK, 'new-session', '-d', '-s', full, '-x', '200', '-y', '50', '/bin/sh'], { env: childEnv(), stdio: 'ignore' })
  return Number(execFileSync('tmux', ['-S', SOCK, 'display-message', '-p', '-t', `=${full}:`, '#{pane_pid}'], { encoding: 'utf8' }).trim())
}
/** Types `line` into a pane and waits for the file it writes to end with an rc line. */
async function typeIn(name: string, line: string, outFile: string): Promise<string> {
  rmSync(outFile, { force: true })
  execFileSync('tmux', ['-S', SOCK, 'send-keys', '-t', `=ccm-${name}:`, '-l', line])
  execFileSync('tmux', ['-S', SOCK, 'send-keys', '-t', `=ccm-${name}:`, 'Enter'])
  await until(() => existsSync(outFile) && /rc=\d+\n$/.test(readFileSync(outFile, 'utf8')), 20_000, 100)
  return existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

afterEach(async () => {
  for (const rt of [...RUNTIMES]) await rt.stop()
  rmSync(SWITCH, { recursive: true, force: true })
  rmSync(CTL, { force: true })
})

afterAll(async () => {
  for (const rt of [...RUNTIMES]) await rt.stop()
  for (const p of [...KIDS]) killGroup(p, 'SIGKILL')
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

describe('(t1) a removed switch file comes back', () => {
  it('(35B) t1 RED AT BASE: runtime running, kill-switch on, the file removed with rm: back within 300 ms, `on <ISO> restored`, 0600, one kill_switch.tampered line (restored true)', async () => {
    const rt = await startRuntime()
    const before = auditLines('kill_switch.tampered').length
    expect((await cli(['on'])).code).toBe(0)
    await sleep(300) // the guard's next tick latches
    expect(spawnSync('rm', [SWITCH]).status).toBe(0)
    const back = await until(() => existsSync(SWITCH), 300)
    expect(back, 'a removed switch file stays removed while the runtime runs').toBe(true)
    expect(readFileSync(SWITCH, 'utf8')).toMatch(new RegExp(`^on ${ISO} restored\\n$`))
    expect(statSync(SWITCH).mode & 0o777).toBe(0o600)
    await sleep(300)
    expect(auditLines('kill_switch.tampered').slice(before).map(({ ts, ...rest }) => rest)).toEqual([{ event: 'kill_switch.tampered', restored: true }])
    expect((await rt.ask('state')).tampered).toBe(1)
  })

  it('(35B) t1 killSwitchOn() in the runtime, sampled every 10 ms across the gap, never reads false', async () => {
    const rt = await startRuntime()
    switchFile()
    await sleep(300)
    await rt.ask('watch')
    await sleep(100)
    rmSync(SWITCH)
    expect(await until(() => existsSync(SWITCH), 300)).toBe(true)
    await sleep(100)
    const { samples, falses } = await rt.ask('unwatch')
    expect(samples).toBeGreaterThan(10)
    expect(falses).toBe(0)
  })

  it('(35B) t1 a route() open in the runtime during the gap answers 423', async () => {
    const rt = await startRuntime()
    switchFile()
    await sleep(300)
    expect(await rt.ask('gap-open')).toEqual({ gone: true, status: 423 })
    expect(await until(() => existsSync(SWITCH), 300)).toBe(true)
  })
})

describe('(t2) an odd thing at the path', () => {
  for (const [label, make] of [
    ['folder', () => mkdirSync(SWITCH)],
    ['symlink', () => symlinkSync(join(BOX, 't2-nowhere'), SWITCH)],
  ] as const) {
    it(`(35B) t2 a ${label} at the path reads on in the runtime; the guard leaves it alone and records no tamper`, async () => {
      const before = auditLines('kill_switch.tampered').length
      make()
      const rt = await startRuntime()
      await sleep(400)
      const st = await status()
      expect(st).toMatchObject({ ok: true, detail: { on: true, latched: true, tampered: 0, last_tampered_at: null } })
      expect(label === 'folder' ? lstatSync(SWITCH).isDirectory() : lstatSync(SWITCH).isSymbolicLink()).toBe(true)
      expect(auditLines('kill_switch.tampered').length).toBe(before)
      expect((await rt.ask('state')).tampered).toBe(0)
    })
  }
})

describe('(t3) the owner turns it off', () => {
  it('(35B) t3 CLI off with no token, no TMUX, outside any session: exactly `tandem: kill switch off`, exit 0, the file gone and not restored over 1 s, one kill_switch.off line; again: already off', async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    expect((await status()).detail.latched).toBe(true)
    const offs = auditLines('kill_switch.off').length
    const r = await cli(['off'])
    expect([r.stdout, r.code]).toEqual(['tandem: kill switch off\n', 0])
    expect(existsSync(SWITCH)).toBe(false)
    await sleep(1_000)
    expect(existsSync(SWITCH)).toBe(false)
    expect((await status()).detail).toMatchObject({ on: false, latched: false, tampered: 0 })
    expect(auditLines('kill_switch.off').slice(offs).map(({ ts, ...rest }) => rest)).toEqual([{ event: 'kill_switch.off', by: 'control', pid: expect.any(Number), ppid: expect.any(Number) }])
    const again = await cli(['off'])
    expect([again.stdout, again.code]).toEqual(['tandem: kill switch was already off\n', 0])
  })
})

describe('(t4) an agent is refused at the CLI', () => {
  async function expectRefused(extra: Record<string, string>) {
    const r = await cli(['off'], extra)
    expect([tandemLines(r.stderr), r.stdout, r.code]).toEqual([[REFUSED], '', 1])
    expect(existsSync(SWITCH)).toBe(true)
    expect((await status()).detail).toMatchObject({ on: true, latched: true })
  }

  it('(35B) t4 TANDEM_CALLER_TOKEN of a live session: refused, exit 1, file and latch unchanged', async () => {
    await startRuntime()
    switchFile()
    paneSession('r35b-agent')
    const token = mintCallerToken('r35b-agent')
    expect(resolveCallerToken(token)).toBe('r35b-agent')
    await sleep(300)
    await expectRefused({ TANDEM_CALLER_TOKEN: token })
  })

  it('(35B) t4 a made-up TANDEM_CALLER_TOKEN: refused', async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    await expectRefused({ TANDEM_CALLER_TOKEN: 'made-up' })
  })

  it("(35B) t4 TMUX set to `<Tandem's socket>,1,0`: refused", async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    await expectRefused({ TMUX: `${SOCK},1,0` })
  })

  it('(35B) t4 the CLI typed inside a Tandem shell session: refused (the line in a file the session writes)', async () => {
    await startRuntime()
    switchFile()
    paneSession('r35b-sh')
    await sleep(300)
    const outFile = join(BOX, 't4-pane.txt')
    const text = await typeIn('r35b-sh', `${q(process.execPath)} --experimental-strip-types ${q(KS)} off > ${q(outFile)} 2>&1; echo "rc=$?" >> ${q(outFile)}`, outFile)
    expect(tandemLines(text)).toEqual([REFUSED])
    expect(text).toMatch(/rc=1\n$/)
    expect(existsSync(SWITCH)).toBe(true)
    expect((await status()).detail.latched).toBe(true)
  })

  it('(35B) t4 the CLI inside a Tandem shell session with TMUX and TANDEM_CALLER_TOKEN dropped (pane ancestry alone): refused', async () => {
    await startRuntime()
    switchFile()
    paneSession('r35b-sh')
    await sleep(300)
    const outFile = join(BOX, 't4-anc.txt')
    const text = await typeIn('r35b-sh', `env -u TMUX -u TANDEM_CALLER_TOKEN ${q(process.execPath)} --experimental-strip-types ${q(KS)} off > ${q(outFile)} 2>&1; echo "rc=$?" >> ${q(outFile)}`, outFile)
    expect(tandemLines(text)).toEqual([REFUSED])
    expect(text).toMatch(/rc=1\n$/)
    expect(existsSync(SWITCH)).toBe(true)
  })
})

describe('(t5) an agent is refused at the runtime (raw socket requests)', () => {
  async function onAndRunning() {
    await startRuntime()
    switchFile()
    await sleep(300)
  }
  const stillOn = async () => {
    expect(existsSync(SWITCH)).toBe(true)
    expect((await status()).detail).toMatchObject({ on: true, latched: true })
  }

  it('(35B) t5 caller_token present (empty facts otherwise): agent_refused', async () => {
    await onAndRunning()
    expect(await ask({ op: 'kill_switch_off', pid: process.pid, caller_token: 'x' })).toEqual({ ok: false, error: 'agent_refused' })
    await stillOn()
  })

  it("(35B) t5 tmux naming Tandem's socket: agent_refused", async () => {
    await onAndRunning()
    expect(await ask({ op: 'kill_switch_off', pid: process.pid, tmux: `${SOCK},4242,0` })).toEqual({ ok: false, error: 'agent_refused' })
    await stillOn()
  })

  it("(35B) t5 pid = a Tandem pane's process: agent_refused", async () => {
    await onAndRunning()
    const pane = paneSession('r35b-sh')
    expect(await ask({ op: 'kill_switch_off', pid: pane })).toEqual({ ok: false, error: 'agent_refused' })
    await stillOn()
  })

  it('(35B) t5 pid 0, 1, -5, "12", none, or extra keys: malformed; the switch stays on', async () => {
    await onAndRunning()
    for (const bad of [
      { op: 'kill_switch_off', pid: 0 },
      { op: 'kill_switch_off', pid: 1 },
      { op: 'kill_switch_off', pid: -5 },
      { op: 'kill_switch_off', pid: '12' },
      { op: 'kill_switch_off', pid: 1.5 },
      { op: 'kill_switch_off' },
      { op: 'kill_switch_off', pid: process.pid, extra: 1 },
      { op: 'kill_switch_off', pid: process.pid, caller_token: 5 },
      { op: 'kill_switch_off', pid: process.pid, tmux: null },
      { op: 'kill_switch_status', pid: process.pid },
    ]) {
      expect(await ask(bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'malformed' })
    }
    await stillOn()
  })
})

describe('(t6) the CLI against other runtimes', () => {
  let fake: Server | undefined
  const conns = new Set<import('node:net').Socket>()
  afterEach(async () => {
    for (const c of conns) c.destroy()
    conns.clear()
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()))
    fake = undefined
  })
  async function fakeRuntime(onConnection: (c: import('node:net').Socket) => void) {
    mkdirSync(join(TH, 'run'), { recursive: true, mode: 0o700 })
    fake = createServer((c) => {
      conns.add(c)
      onConnection(c)
    })
    await new Promise<void>((r) => fake!.listen(CTL, () => r()))
  }

  it('(35B) t6 an older runtime (answers unknown_command): the file removed + the exact older-runtime line', async () => {
    await fakeRuntime((c) => c.on('data', () => c.end(`${JSON.stringify({ ok: false, error: 'unknown_command' })}\n`)))
    switchFile()
    const r = await cli(['off'])
    expect([r.stdout, tandemLines(r.stderr), r.code]).toEqual(['tandem: kill switch off\n', ['tandem: the running runtime is older and keeps no switch record'], 0])
    expect(existsSync(SWITCH)).toBe(false)
  })

  it('(35B) t6 a socket that never answers: after 10 s the exact did-not-answer line, exit 1, the file stays', async () => {
    await fakeRuntime(() => {})
    switchFile()
    const r = await cli(['off'])
    expect([r.stdout, tandemLines(r.stderr), r.code]).toEqual(['', ['tandem: the runtime did not answer; the switch stays on'], 1])
    expect(r.ms).toBeGreaterThanOrEqual(9_500)
    expect(existsSync(SWITCH)).toBe(true)
  })

  it('(35B) t6 no runtime (no socket file, then a stale socket file): BASE behaviour', async () => {
    switchFile()
    let r = await cli(['off'])
    expect([r.stdout, r.stderr, r.code]).toEqual(['tandem: kill switch off\n', '', 0])
    staleSocket(CTL)
    switchFile()
    r = await cli(['off'])
    expect([r.stdout, r.stderr, r.code]).toEqual(['tandem: kill switch off\n', '', 0])
    expect(existsSync(SWITCH)).toBe(false)
  })
})

describe('(t7) the control socket', () => {
  const okRun = async () => ({ ok: true, detail: 'first' })

  it('(35B) t7 path under TANDEM_HOME; folder 0700, socket 0600; 9,000 bytes too_large; bad JSON malformed; {op:"enroll"} unknown_command', async () => {
    expect(cs.controlSocketPath()).toBe(CTL)
    const server = await cs.startControlServer({ run: okRun })
    try {
      expect(statSync(join(TH, 'run')).mode & 0o777).toBe(0o700)
      expect(statSync(CTL).mode & 0o777).toBe(0o600)
      expect(lstatSync(CTL).isSocket()).toBe(true)
      expect(await ask('x'.repeat(9_000))).toEqual({ ok: false, error: 'too_large' })
      expect(await ask('{not json\n')).toEqual({ ok: false, error: 'malformed' })
      expect(await ask({ op: 'enroll' })).toEqual({ ok: false, error: 'unknown_command' })
      expect(await ask({ op: 'kill_switch_status' })).toEqual({ ok: true, detail: 'first' })
    } finally {
      await server.close()
    }
  })

  it('(35B) t7 a second startControlServer on the same path while the first answers throws the exact text; the first keeps answering', async () => {
    const first = await cs.startControlServer({ run: okRun })
    try {
      await expect(cs.startControlServer({ run: okRun })).rejects.toThrow(/^control socket already answered by another runtime$/)
      expect(lstatSync(CTL).isSocket()).toBe(true)
      expect(await cs.sendControlCommand(CTL, { op: 'kill_switch_status' })).toEqual({ ok: true, detail: 'first' })
    } finally {
      await first.close()
    }
  })

  it('(35B) t7 a stale socket file (no listener) is replaced', async () => {
    staleSocket(CTL)
    const server = await cs.startControlServer({ run: okRun })
    try {
      expect(await ask({ op: 'kill_switch_status' })).toEqual({ ok: true, detail: 'first' })
    } finally {
      await server.close()
    }
  })
})

describe('(t8) status', () => {
  it('(35B) t8 after one tamper, CLI status prints `tandem: kill switch on` then exactly the restored line with n=1', async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    rmSync(SWITCH)
    expect(await until(() => existsSync(SWITCH), 300)).toBe(true)
    const r = await cli(['status'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(new RegExp(`^tandem: kill switch on\\ntandem: the runtime restored the switch 1 times after it was removed without off \\(last ${ISO}\\)\\n$`))
  })

  it('(35B) t8 with no runtime, BASE output only', async () => {
    switchFile()
    expect([(await cli(['status'])).stdout]).toEqual(['tandem: kill switch on\n'])
    rmSync(SWITCH)
    expect([(await cli(['status'])).stdout]).toEqual(['tandem: kill switch off\n'])
  })
})

describe('(t9) runtime start', () => {
  it('(35B) t9 with the file present: latched; removing the file then restores it', async () => {
    switchFile()
    await startRuntime()
    expect((await status()).detail).toMatchObject({ on: true, latched: true, tampered: 0, last_tampered_at: null })
    rmSync(SWITCH)
    expect(await until(() => existsSync(SWITCH), 300)).toBe(true)
    expect((await status()).detail).toMatchObject({ on: true, latched: true, tampered: 1 })
  })

  it('(35B) t9 with no file: unlatched, nothing created', async () => {
    await startRuntime()
    await sleep(400)
    expect((await status()).detail).toEqual({ on: false, latched: false, tampered: 0, last_tampered_at: null })
    expect(existsSync(SWITCH)).toBe(false)
  })
})

describe('(t10) on --close revokes the ended sessions\' tokens', () => {
  it('(35B) t10 each ended session\'s token no longer resolves; a stdio start with that old token is refused with 36A\'s exact line', async () => {
    const names = ['r35b-c1', 'r35b-c2']
    const tokens = names.map((n) => {
      paneSession(n)
      return mintCallerToken(n)
    })
    expect(tokens.map((t) => resolveCallerToken(t))).toEqual(names)
    const r = await cli(['on', '--close'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^tandem: kill switch on; \d+ sessions ended\n$/)
    expect(tokens.map((t) => resolveCallerToken(t))).toEqual([undefined, undefined])
    const stdio = spawnSync(process.execPath, ['--experimental-strip-types', 'src/stdio-server.ts'], {
      cwd: repo, encoding: 'utf8', input: '', timeout: 20_000, env: childEnv({ TANDEM_CALLER_TOKEN: tokens[0], TANDEM_CWD_ALLOWLIST: WORK }),
    })
    expect([stdio.status, stdio.stderr.trim()]).toEqual([1, STDIO_REFUSED])
  })
})

// ---- audit rows (U-R1A-35B audit) --------------------------------------------------------------
describe('(a) audit rows', () => {
  const CAME_BACK = 'tandem: the kill switch came back on: a running runtime put its file back; stop that runtime, then run tandem kill-switch off again'
  const run = async () => ({ ok: true })

  it('(35B) a1 off is recorded with the asking pid and its parent; a refused off is recorded too (kill_switch.off_refused, why, pid) and the switch stays on', async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    const refusedBefore = auditLines('kill_switch.off_refused').length
    const offBefore = auditLines('kill_switch.off').length
    expect(await ask({ op: 'kill_switch_off', pid: process.pid, caller_token: 'made-up-token-value' })).toEqual({ ok: false, error: 'agent_refused' })
    expect(existsSync(SWITCH)).toBe(true)
    await sleep(100)
    expect(auditLines('kill_switch.off_refused').slice(refusedBefore).map(({ ts, ...rest }) => rest)).toEqual([
      { event: 'kill_switch.off_refused', by: 'control', why: 'agent_refused', pid: process.pid, had_token: true, had_tmux: false },
    ])
    expect(readFileSync(AUDIT, 'utf8')).not.toContain('made-up-token-value')
    expect(await ask({ op: 'kill_switch_off', pid: process.pid })).toEqual({ ok: true, detail: { was_on: true } })
    await sleep(100)
    expect(auditLines('kill_switch.off').slice(offBefore).map(({ ts, ...rest }) => rest)).toEqual([
      { event: 'kill_switch.off', by: 'control', pid: process.pid, ppid: process.ppid },
    ])
  })

  it('(35B) a2 a latched runtime whose control socket file is gone: CLI off does not claim off; exit 1, the came-back line, the switch on', async () => {
    await startRuntime()
    switchFile()
    await sleep(300)
    rmSync(CTL)
    const r = await cli(['off'])
    expect([r.stdout, tandemLines(r.stderr), r.code]).toEqual(['', [CAME_BACK], 1])
    expect(existsSync(SWITCH)).toBe(true)
  })

  it('(35B) a3 two runtime processes on one home: the second never takes the first\'s socket; off through the first is put back by the second, and the CLI says so', async () => {
    const first = await startRuntime()
    const ino = lstatSync(CTL).ino
    const second = await startRuntime()
    expect(second.stderr()).toContain('control socket already answered by another runtime')
    expect(lstatSync(CTL).ino).toBe(ino)
    expect((await status()).ok).toBe(true)
    switchFile()
    await sleep(300)
    const r = await cli(['off'])
    expect([r.stdout, tandemLines(r.stderr), r.code]).toEqual(['', [CAME_BACK], 1])
    expect(existsSync(SWITCH)).toBe(true)
    // The second runtime's shutdown leaves the first's socket alone.
    await second.stop()
    expect(lstatSync(CTL).ino).toBe(ino)
    expect((await status()).ok).toBe(true)
    await sleep(300)
    const again = await cli(['off'])
    expect([again.stdout, again.code]).toEqual(['tandem: kill switch off\n', 0])
    void first
  })

  it('(35B) a4 close() ends within 1 s though a connection sits open and silent', async () => {
    const server = await cs.startControlServer({ run })
    const idle = connect(CTL)
    await new Promise<void>((r) => idle.on('connect', () => r()))
    idle.on('error', () => {})
    const t0 = Date.now()
    await Promise.race([server.close(), sleep(3_000)])
    const took = Date.now() - t0
    idle.destroy()
    expect(took).toBeLessThan(1_000)
    expect(existsSync(CTL)).toBe(false)
  })

  it('(35B) a5 a symlink (to a live socket, to nothing) or a plain file at the socket path: start throws and removes nothing', async () => {
    const elsewhere = join(BOX, 'a5', 'c.sock')
    const live = await cs.startControlServer({ run: async () => ({ ok: true, detail: 'live' }), socketPath: elsewhere })
    try {
      mkdirSync(join(TH, 'run'), { recursive: true, mode: 0o700 })
      symlinkSync(elsewhere, CTL)
      await expect(cs.startControlServer({ run })).rejects.toThrow('control socket path is not a socket')
      expect(lstatSync(CTL).isSymbolicLink()).toBe(true)
      expect(await ask({ op: 'kill_switch_status' }, elsewhere)).toEqual({ ok: true, detail: 'live' })
      rmSync(CTL)
      symlinkSync(join(BOX, 'a5', 'nowhere'), CTL)
      await expect(cs.startControlServer({ run })).rejects.toThrow('control socket path is not a socket')
      expect(lstatSync(CTL).isSymbolicLink()).toBe(true)
      expect(existsSync(join(BOX, 'a5', 'nowhere')), 'a socket was made where the link points').toBe(false)
      rmSync(CTL)
      writeFileSync(CTL, 'not a socket')
      await expect(cs.startControlServer({ run })).rejects.toThrow('control socket path is not a socket')
      expect(readFileSync(CTL, 'utf8')).toBe('not a socket')
    } finally {
      await live.close()
    }
  })

  it('(35B) a6 the file renamed away: restored, one tamper; chmod 000 or truncated: still on, no tamper', async () => {
    const rt = await startRuntime()
    switchFile()
    await sleep(300)
    const before = auditLines('kill_switch.tampered').length
    renameSync(SWITCH, join(BOX, 'a6-moved'))
    expect(await until(() => existsSync(SWITCH), 300)).toBe(true)
    await sleep(500)
    expect(auditLines('kill_switch.tampered').length).toBe(before + 1)
    truncateSync(SWITCH, 0)
    chmodSync(SWITCH, 0)
    await sleep(500)
    expect((await status()).detail).toMatchObject({ on: true, latched: true, tampered: 1 })
    expect(auditLines('kill_switch.tampered').length).toBe(before + 1)
    expect((await rt.ask('state')).tampered).toBe(1)
  })
})
