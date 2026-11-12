/**
 * U-R1A-STATUSREADS: `tandem status` answers in time when one reader hangs, and no control-socket
 * reply can grow past 1 MiB (HOLES Q-19).
 *
 * (a) the runtime's `status` reads each screen for at most 600 ms, so one hung session reads
 * `unknown` and the others keep their states; who_is_up (no rowMs) keeps readInput's 2,000 ms.
 * (b) sendControlCommand caps every reply at MAX_CONTROL_REPLY_BYTES (1 MiB before the newline).
 * (l) statusDocument waits at most 1,500 ms for its local listing (s8's path past it).
 * (r) statusDocument waits at most 1,500 ms for the usage read (accounts null, one ETIMEDOUT line).
 * (k) the document keeps at most 500 accounts and counts the rest in accountsMore.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1astatusreads-: HOME, TANDEM_HOME
 * (HOME/.tandem) and the work folder. Before any import TMUX is deleted and TMUX_TMPDIR is that
 * folder. Sessions are plain registered objects (no tmux, no agent program). Lower time bounds are
 * proven on the code's own timers (fake setTimeout): not settled at bound - 1, settled at bound.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Socket } from 'node:net'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1astatusreads-')))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
mkdirSync(HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })
process.env.HOME = HOME
process.env.TANDEM_HOME = join(HOME, '.tandem')
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
process.env.TANDEM_HUB_LINK_ID = 'r1astatusreads-alpha'
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.CCM_CWD_ALLOWLIST = WORK

const status = await import('../bridge/status.ts')
const cs: Json = await import('../bridge/control-socket.ts')
const { controlSocketPath, sendControlCommand, startControlServer } = cs
const { createPresence } = await import('../bridge/presence.ts')
const { registerLive, unregisterLive } = await import('../bridge/sessions.ts')
const { runKillSwitchCommand } = await import('../bridge/kill-switch.ts')
const { createServer: netServer } = await import('node:net')

vi.setConfig({ testTimeout: 30_000 })

afterAll(() => {
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

const HUNG = 'r1astatusreads-hung'
const IDLE = 'r1astatusreads-idle'
const IDLE_READ = { state: 'idle', screen: '', debounceMs: 0 }
const FIXED = "tandem status: could not read this computer's state\n"
const ETIMEDOUT_LINE = 'tandem status: account usage could not be read (ETIMEDOUT)\n'
const MIB = 1_048_576
const T = 2_000_000_000_000

/** A promise and the function that settles it. */
function signal<T = void>(): { promise: Promise<T>; fire: (v: T) => void } {
  let fire!: (v: T) => void
  const promise = new Promise<T>((r) => { fire = r })
  return { promise, fire }
}

/** A registered-session stand-in; the methods presence never calls throw. */
function fake(id: string, inputState: () => Promise<unknown>): Json {
  const no = () => { throw new Error('not used') }
  return { id, engine: 'shell', cwd: WORK, isAlive: async () => true, attachHint: () => '', inputState, isWorking: no, send: no, read: no, interrupt: no, close: no }
}

/** A session whose screen read never answers by itself; `release` settles it, `called` fires on the first read. */
function hung() {
  const held = signal<unknown>()
  const called = signal()
  const session = fake(HUNG, () => { called.fire(); return held.promise })
  return { session, called: called.promise, release: () => held.fire(IDLE_READ) }
}

const idle = () => fake(IDLE, async () => IDLE_READ)

/** stdout and stderr captured until `restore` (restored in each case's finally). */
function capture(): { out: () => string; err: () => string; restore: () => void } {
  let out = ''
  let err = ''
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Json) => { out += String(chunk); return true })
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Json) => { err += String(chunk); return true })
  return { out: () => out, err: () => err, restore: () => { o.mockRestore(); e.mockRestore() } }
}

/** Tracks whether `p` has settled. */
function watch<T>(p: Promise<T>): { settled: () => boolean; value: Promise<T> } {
  let done = false
  const value = p.finally(() => { done = true })
  value.catch(() => {})
  return { settled: () => done, value }
}

/** A socket at the control path; `onLine` gets each connection after its first request line. */
async function fakeSocket(onLine: (c: Socket) => void): Promise<{ closed: Promise<void>; close(): Promise<void> }> {
  const open = new Set<Socket>()
  const gone = signal()
  const server = netServer((c) => {
    open.add(c)
    c.on('error', () => {})
    c.on('close', () => { open.delete(c); gone.fire() })
    c.setEncoding('utf8')
    let body = ''
    let seen = false
    c.on('data', (chunk) => {
      body += chunk
      if (seen || !body.includes('\n')) return
      seen = true
      onLine(c)
    })
  })
  mkdirSync(join(process.env.TANDEM_HOME!, 'run'), { recursive: true, mode: 0o700 })
  await new Promise<void>((r) => server.listen(controlSocketPath(), r))
  return { closed: gone.promise, close: () => new Promise<void>((r) => { server.close(() => r()); for (const c of open) c.destroy() }) }
}

const answering = (reply: string) => fakeSocket((c) => c.end(reply))

/** `{"ok":true,"detail":"xxx..."}` of exactly `bytes` bytes. */
function padded(bytes: number): string {
  const shell = JSON.stringify({ ok: true, detail: '' })
  return JSON.stringify({ ok: true, detail: 'x'.repeat(bytes - shell.length) })
}

const noRows: Json = { whoIsUp: async () => ({ computer: 'r1astatusreads-alpha', at: Date.now(), ageMs: 0, sessions: [] }), names: async () => [] }
const notRunning = async () => ({ runtime: 'not_running' as const })
const emptyUsage: Json = { read: async () => ({ accounts: [] }) }

describe('(a) one hung screen read', () => {
  it('(STATUSREADS) a1 the runtime\'s status answers ok within 1.5 s: the hung row unknown, the other idle', async () => {
    const h = hung()
    registerLive(h.session)
    registerLive(idle())
    const server = await startControlServer({ run: runKillSwitchCommand, status: status.runtimeStatus() })
    try {
      const r: Json = await sendControlCommand(controlSocketPath(), { op: 'status' }, 1500)
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
      const rows = Object.fromEntries(r.detail.sessions.map((s: Json) => [s.name, s.state]))
      expect(rows).toEqual({ [HUNG]: 'unknown', [IDLE]: 'idle' })
    } finally {
      h.release()
      await new Promise((r) => setImmediate(r))
      await server.close()
      unregisterLive(HUNG)
      unregisterLive(IDLE)
    }
  })

  it('(STATUSREADS) a2 tandem status (a separate process, default probe and listing) reads the runtime: running, hung unknown, other idle', async () => {
    const h = hung()
    registerLive(h.session)
    registerLive(idle())
    const server = await startControlServer({ run: runKillSwitchCommand, status: status.runtimeStatus() })
    try {
      const url = pathToFileURL(join(repo, 'bridge', 'status.ts')).href
      const script = `const s = await import(${JSON.stringify(url)}); const d = await s.statusDocument({ usage: { read: async () => ({ accounts: [] }) } }); process.stdout.write(JSON.stringify(d), () => process.exit(0))`
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      const code = await new Promise<number | null>((r) => child.on('close', r))
      expect(code, stderr).toBe(0)
      const doc: Json = JSON.parse(stdout)
      expect(doc.runtime).toBe('running')
      const self = doc.computers.find((c: Json) => c.self)
      expect(Object.fromEntries(self.sessions.map((s: Json) => [s.name, s.state]))).toEqual({ [HUNG]: 'unknown', [IDLE]: 'idle' })
    } finally {
      h.release()
      await new Promise((r) => setImmediate(r))
      await server.close()
      unregisterLive(HUNG)
      unregisterLive(IDLE)
    }
  }, 30_000)

  it('(STATUSREADS) a3 lower bounds: no rowMs waits readInput\'s 2,000 ms; rowMs 600 answers unknown at 600 ms', async () => {
    const info = { id: HUNG, engine: 'shell', project: 'work', cwd: WORK, live: true, updatedAt: 0, attachHint: '' }
    for (const [rowMs, bound] of [[undefined, 2000], [600, 600]] as const) {
      const h = hung()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const presence = createPresence({ list: async () => [info] as Json, live: () => h.session, remote: { read: () => [] }, ...(rowMs === undefined ? {} : { rowMs }) } as Json)
        const w = watch(presence.whoIsUp({ refresh: true }))
        await h.called
        await vi.advanceTimersByTimeAsync(bound - 1)
        expect(w.settled(), `rowMs ${rowMs} at ${bound - 1} ms`).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(w.settled(), `rowMs ${rowMs} at ${bound} ms`).toBe(true)
        expect((await w.value).sessions.map((s) => [s.name, s.state])).toEqual([[HUNG, 'unknown']])
      } finally {
        vi.useRealTimers()
        h.release()
      }
    }
  })
})

describe('(b) the reply cap', () => {
  it('(STATUSREADS) b1 MAX_CONTROL_REPLY_BYTES is 1 MiB', () => {
    expect(cs.MAX_CONTROL_REPLY_BYTES).toBe(1_048_576)
  })

  it('(STATUSREADS) b2 a 2 MiB reply rejects EMSGSIZE, also with maxReplyBytes 4 MiB', async () => {
    const s = await answering(`${JSON.stringify({ ok: true, detail: 'x'.repeat(2 * 1024 * 1024) })}\n`)
    try {
      await expect(sendControlCommand(controlSocketPath(), { op: 'status' })).rejects.toMatchObject({ code: 'EMSGSIZE' })
      await expect(sendControlCommand(controlSocketPath(), { op: 'status' }, 10_000, 4 * 1024 * 1024)).rejects.toMatchObject({ code: 'EMSGSIZE' })
    } finally {
      await s.close()
    }
  })

  it('(STATUSREADS) b3 the edge: 1,048,576 bytes and a newline resolve; 1,048,577 bytes and a newline reject EMSGSIZE', async () => {
    const exact = padded(MIB)
    expect(Buffer.byteLength(exact)).toBe(MIB)
    let s = await answering(`${exact}\n`)
    try {
      const r: Json = await sendControlCommand(controlSocketPath(), { op: 'status' })
      expect(r.ok).toBe(true)
      expect(r.detail.length).toBe(MIB - JSON.stringify({ ok: true, detail: '' }).length)
    } finally {
      await s.close()
    }
    const over = padded(MIB + 1)
    expect(Buffer.byteLength(over)).toBe(MIB + 1)
    s = await answering(`${over}\n`)
    try {
      await expect(sendControlCommand(controlSocketPath(), { op: 'status' })).rejects.toMatchObject({ code: 'EMSGSIZE' })
    } finally {
      await s.close()
    }
  })

  it('(STATUSREADS) b4 a smaller maxReplyBytes still applies: 1,024 and a 2,000-byte reply reject EMSGSIZE', async () => {
    const s = await answering(`${padded(2000)}\n`)
    try {
      await expect(sendControlCommand(controlSocketPath(), { op: 'status' }, 10_000, 1024)).rejects.toMatchObject({ code: 'EMSGSIZE' })
    } finally {
      await s.close()
    }
  })

  it('(STATUSREADS) b5 a runtime answering 2 MiB reads not_running in the status document', async () => {
    const s = await answering(`${JSON.stringify({ ok: true, detail: 'x'.repeat(2 * 1024 * 1024) })}\n`)
    try {
      const doc: Json = await status.statusDocument({ presence: noRows, usage: emptyUsage })
      expect(doc.runtime).toBe('not_running')
    } finally {
      await s.close()
    }
  })

  it('(STATUSREADS) b6 a socket that keeps writing: EMSGSIZE (not a 5 s ETIMEDOUT) and the connection is closed', async () => {
    const chunk = 'x'.repeat(64 * 1024)
    // ponytail: stops at 64 MiB (a safety ceiling so the base code's unlimited read stays bounded);
    // the connection then stays open, so only the cap or the timeout ends the call.
    const s = await fakeSocket((c) => {
      let sent = 0
      const pump = () => {
        while (!c.destroyed && sent < 1024) {
          sent++
          if (!c.write(chunk)) { c.once('drain', pump); return }
        }
      }
      pump()
    })
    try {
      await expect(sendControlCommand(controlSocketPath(), { op: 'status' }, 5_000)).rejects.toMatchObject({ code: 'EMSGSIZE' })
      await s.closed
    } finally {
      await s.close()
    }
  })
})

describe('(l) the local listing limit', () => {
  it('(STATUSREADS) l1 a listing that never answers: main returns 1 at 1,500 ms (not at 1,499) with s8\'s line, stdout empty', async () => {
    const called = signal()
    const presence: Json = { whoIsUp: () => { called.fire(); return new Promise(() => {}) }, names: async () => [] }
    const cap = capture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = watch(status.main(['--json'], { presence, probe: notRunning, usage: emptyUsage }))
      await called.promise
      await vi.advanceTimersByTimeAsync(1499)
      expect(w.settled()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(w.settled()).toBe(true)
      expect({ value: await w.value, out: cap.out(), err: cap.err() }).toEqual({ value: 1, out: '', err: FIXED })
    } finally {
      vi.useRealTimers()
      cap.restore()
    }
  })
})

/** statusDocument with a usage read that never ends, run on fake timers to its 1,500 ms limit. */
async function slowReport(): Promise<{ doc: Json; err: string }> {
  const called = signal()
  const usage: Json = { read: () => { called.fire(); return new Promise(() => {}) } }
  const cap = capture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const w = watch(status.statusDocument({ presence: noRows, probe: notRunning, usage }))
    await called.promise
    await vi.advanceTimersByTimeAsync(1499)
    expect(w.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.settled()).toBe(true)
    return { doc: await w.value, err: cap.err() }
  } finally {
    vi.useRealTimers()
    cap.restore()
  }
}

describe('(r) the usage read limit', () => {
  it('(STATUSREADS) r1 a report whose read never ends: a document at 1,500 ms (not at 1,499) with accounts null and the one ETIMEDOUT line', async () => {
    const { doc, err } = await slowReport()
    expect(doc.accounts).toBeNull()
    expect(err).toBe(ETIMEDOUT_LINE)
  })

  it('(STATUSREADS) r2 that document\'s keys, in order; statusVersion 2', async () => {
    const { doc } = await slowReport()
    expect(Object.keys(doc)).toEqual(['statusVersion', 'version', 'at', 'runtime', 'killSwitch', 'computers', 'accounts', 'accountsMore'])
    expect(doc.statusVersion).toBe(2)
  })
})

/** N accounts acct-0.. of agent claude on alpha, every numeric field set. */
function accounts(n: number): Json[] {
  return Array.from({ length: n }, (_, i) => ({
    agent: 'claude', account: `acct-${i}`, computer: 'alpha', at: T - 1, ageMs: 1, stale: false,
    five_hour: { used: 4, resets_at: T + 3_600_000 }, seven_day: { used: 7, resets_at: T + 86_400_000 }, plan: 'max', room: 6,
    tokens: { today: 1, total: 2 }, cost_usd: { today: 1, total: 2 }, tokens_at: T - 1, tokens_age_ms: 1,
    tokens_computers: ['alpha'], tokens_note: null, limit_note: null,
  }))
}

async function withAccounts(n: number): Promise<{ doc: Json; out: string; list: Json[] }> {
  const list = accounts(n)
  const cap = capture()
  try {
    const value = await status.main(['--json'], { presence: noRows, probe: notRunning, now: () => T, usage: { read: async () => ({ accounts: list }) } as Json })
    expect([value, cap.err()]).toEqual([0, ''])
    return { doc: JSON.parse(cap.out()), out: cap.out(), list }
  } finally {
    cap.restore()
  }
}

describe('(k) the account list cap', () => {
  it('(STATUSREADS) k1 2,600 accounts: the first 500 kept, accountsMore 2100, the whole JSON under 1 MiB', async () => {
    const { doc, out, list } = await withAccounts(2600)
    for (const a of list) expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThanOrEqual(400)
    expect(doc.accounts.length).toBe(500)
    expect(doc.accounts.map((a: Json) => a.account)).toEqual(list.slice(0, 500).map((a) => a.account))
    expect(doc.accountsMore).toBe(2100)
    expect(Object.keys(doc).slice(-2)).toEqual(['accounts', 'accountsMore'])
    expect(Buffer.byteLength(out)).toBeLessThan(MIB)
  })

  it('(STATUSREADS) k2 10 accounts: all kept, accountsMore 0, no "more accounts" line', async () => {
    const { doc } = await withAccounts(10)
    expect(doc.accounts.length).toBe(10)
    expect(doc.accountsMore).toBe(0)
    expect(status.renderStatus(doc)).not.toContain('more accounts')
  })

  it('(STATUSREADS) k3 the text form of 2,600 accounts ends its accounts block with "  ... and 2100 more accounts"', async () => {
    const { doc } = await withAccounts(2600)
    const lines = status.renderStatus(doc).split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.at(-2)).toBe('  ... and 2100 more accounts')
    expect(lines.filter((l) => l.startsWith('  claude/acct-')).length).toBe(500)
  })
})
