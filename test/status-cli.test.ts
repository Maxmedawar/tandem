/**
 * U-R1A-40: `tandem status [--json]` (bridge/status.ts) lists this computer and every other roster
 * computer, each with its sessions, their states and how old each reading is. It builds the
 * document in its own process from the readers who_is_up uses (bridge/presence.ts,
 * bridge/hub-presence.ts); the runtime is only probed on its control socket (one
 * kill_switch_status) and nothing under `run/` is ever made, removed or replaced.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a40-: HOME, TANDEM_HOME (Tandem's own
 * tmux socket, the roster, state.db), the work folders and the device keys. Before any import TMUX
 * is deleted and TMUX_TMPDIR is that folder. Sessions are the pinned `sh` of the shell harness file,
 * opened through route(); no agent program is started. afterAll ends every tmux server whose socket
 * is in that folder, then removes it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a40-')))
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const ONE = join(WORK, 'one')
const TWO = join(WORK, 'two')
for (const d of [HOME, ONE, TWO]) mkdirSync(d, { recursive: true })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.TANDEM_HUB_LINK_ID = 'alpha'
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'

const status = await import('../bridge/status.ts')
const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { controlSocketPath, startControlServer } = await import('../bridge/control-socket.ts')
const { killSwitchOn, killSwitchPath } = await import('../bridge/kill-switch.ts')
const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { readRemotePresence } = await import('../bridge/hub-presence.ts')
const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite')

vi.setConfig({ testTimeout: 30_000 })

const VERSION = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version
const DOC_KEYS = ['statusVersion', 'version', 'at', 'runtime', 'killSwitch', 'computers']
const COMPUTER_KEYS = ['computer', 'self', 'at', 'ageMs', 'stale', 'counts', 'sessions', 'more']
const SESSION_KEYS = ['name', 'engine', 'project', 'state', 'stateAt', 'ageMs']
const COUNT_KEYS = ['working', 'idle', 'waiting_for_approval', 'unknown']
const STATES = ['working', 'idle', 'waiting_for_approval', 'unknown']
const FIRST_LINE = /^Tandem (\S+) · runtime (running|not running) · kill switch (on|off)$/
const COMPUTER_LINE = /^(\S+)( \(this computer\))? · (\d+) sessions?: (\d+) working, (\d+) idle, (\d+) waiting, (\d+) unknown · (stale · )?(read (.+) ago|no reading yet)$/

beforeAll(() => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  if (!sh) throw new Error('the shell harness file did not load')
  writeLimits(TH, { folders: [WORK], shell: true, agents: { shell: agentEntry(sh) } })
  limits.applyLimits()
})

afterAll(() => {
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })

/** Runs `run` with stdout and stderr captured; returns what each received. */
async function captured<T>(run: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  let out = ''
  let err = ''
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Json) => { out += String(chunk); return true })
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Json) => { err += String(chunk); return true })
  try {
    return { value: await run(), out, err }
  } finally {
    o.mockRestore()
    e.mockRestore()
  }
}

/** Every key of every object anywhere in `v`. */
function allKeys(v: unknown, into: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, into)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { into.push(k); allKeys(x, into) }
  return into
}

const tally = (sessions: { state: string }[]) => {
  const c: Record<string, number> = { working: 0, idle: 0, waiting_for_approval: 0, unknown: 0 }
  for (const s of sessions) c[COUNT_KEYS.slice(0, 3).includes(s.state) ? s.state : 'unknown']++
  return c
}

describe('(s1) an empty home', () => {
  it('(40) s1 exactly the document keys, runtime not_running, one computer (self, no sessions, counts 0); no state.db or run/ made', async () => {
    const empty = mkdtempSync(join(BOX, 'empty-'))
    process.env.TANDEM_HOME = empty
    try {
      const doc: Json = await status.statusDocument()
      expect(Object.keys(doc)).toEqual(DOC_KEYS)
      expect(doc).toMatchObject({ statusVersion: 2, version: VERSION, runtime: 'not_running', killSwitch: 'off' })
      expect(status.STATUS_VERSION).toBe(2)
      expect(typeof doc.at).toBe('number')
      expect(doc.computers).toHaveLength(1)
      const [c] = doc.computers
      expect(Object.keys(c)).toEqual(COMPUTER_KEYS)
      expect(c).toMatchObject({ computer: 'alpha', self: true, stale: false, sessions: [], more: 0, counts: { working: 0, idle: 0, waiting_for_approval: 0, unknown: 0 } })
      expect(Object.keys(c.counts)).toEqual(COUNT_KEYS)
      expect(typeof c.at).toBe('number')
      expect(typeof c.ageMs).toBe('number')
      expect(existsSync(join(empty, 'state.db'))).toBe(false)
      expect(existsSync(join(empty, 'run'))).toBe(false)
    } finally {
      process.env.TANDEM_HOME = TH
    }
  })
})

describe('(s4) runtime: one probe of the control socket', () => {
  it('(40) s4 a control server answering -> running; closed -> not_running; a regular file at the path -> not_running, the file untouched', async () => {
    const server = await startControlServer({ socketPath: controlSocketPath(), run: async () => ({ ok: true }) })
    try {
      expect((await status.statusDocument()).runtime).toBe('running')
    } finally {
      await server.close()
    }
    expect((await status.statusDocument()).runtime).toBe('not_running')
    const path = controlSocketPath()
    writeFileSync(path, 'not a socket\n', { mode: 0o600 })
    const before = statSync(path)
    expect((await status.statusDocument()).runtime).toBe('not_running')
    const after = statSync(path)
    expect([after.ino, after.size, after.mtimeMs, readFileSync(path, 'utf8')]).toEqual([before.ino, before.size, before.mtimeMs, 'not a socket\n'])
    rmSync(path)
  })
})

describe('(s5) kill switch', () => {
  it('(40) s5 killSwitchOn() true -> on; false -> off', async () => {
    writeFileSync(killSwitchPath(), `on ${new Date().toISOString()}\n`, { mode: 0o600 })
    try {
      expect(killSwitchOn()).toBe(true)
      expect((await status.statusDocument()).killSwitch).toBe('on')
    } finally {
      rmSync(killSwitchPath())
    }
    expect(killSwitchOn()).toBe(false)
    expect((await status.statusDocument()).killSwitch).toBe('off')
  })
})

describe('(s2) sessions on this computer', () => {
  it('(40) s2 two shell sessions opened through route(): both listed, a state from the four, counts add up to 2, no cwd and no folder path', async () => {
    for (const [name, cwd] of [['r40-one', ONE], ['r40-two', TWO]]) {
      const res = await rq('POST', '/sessions/open', { engine: 'shell', name, cwd })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    }
    const doc: Json = await status.statusDocument()
    const [self] = doc.computers
    expect(self.self).toBe(true)
    expect(self.sessions.map((s: Json) => [s.name, s.engine, s.project])).toEqual([['r40-one', 'shell', 'one'], ['r40-two', 'shell', 'two']])
    for (const s of self.sessions) {
      expect(Object.keys(s)).toEqual(SESSION_KEYS)
      expect(STATES).toContain(s.state)
      expect(typeof s.stateAt).toBe('number')
      expect(typeof s.ageMs).toBe('number')
    }
    expect(Object.values(self.counts).reduce((a: number, b) => a + (b as number), 0)).toBe(2)
    expect(allKeys(doc)).not.toContain('cwd')
    const text = JSON.stringify(doc)
    for (const p of [ONE, TWO, realpathSync(ONE), realpathSync(TWO), WORK]) expect(text.includes(p), p).toBe(false)
  })
})

/** The time the (s3) readings are measured against. */
let NOW = 0
const fixed = () => NOW

describe('(s3) other computers', () => {
  it('(40) s3 a roster of alpha, beta and delta: beta with its sessions, ageMs and stale as readRemotePresence gives; delta at null, ageMs null, stale', async () => {
    const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
    const A = key('alpha')
    initRoster(A, 'alpha')
    for (const id of ['beta', 'delta']) {
      const k = key(id)
      receiveOffer(JSON.stringify(makeOffer(k, id)))
      trustOffer(A, k.fingerprint)
    }
    NOW = Date.now()
    // The tables as hub-presence makes them (an empty read opens the store), then beta's reading as the carrier keeps it.
    expect(readRemotePresence({ now: fixed, self: 'alpha' }).map((r) => r.computer)).toEqual(['beta', 'delta'])
    const at = NOW - 5000
    const reading = JSON.stringify({
      v: 1, kind: 'presence', at,
      sessions: [
        { name: 'b-two', engine: 'shell', project: 'work', state: 'idle', stateAt: at },
        { name: 'b-one', engine: 'claude', project: 'site', state: 'working', stateAt: at - 1000 },
      ],
      more: 3,
    })
    const db = new DatabaseSync(join(TH, 'state.db'))
    try {
      db.prepare('INSERT INTO presence_remote (computer, reading, at_ms, received_ms) VALUES (?, ?, ?, ?)').run('beta', reading, at, at)
      db.prepare('INSERT INTO presence_hub (k, connected, at_ms) VALUES (1, ?, ?)').run(JSON.stringify(['alpha', 'beta']), NOW - 1000)
    } finally {
      db.close()
    }
    const remote = readRemotePresence({ now: fixed, self: 'alpha' })
    const doc: Json = await status.statusDocument({ now: fixed })
    expect(doc.computers.map((c: Json) => [c.computer, c.self])).toEqual([['alpha', true], ['beta', false], ['delta', false]])
    const [, beta, delta] = doc.computers
    for (const c of doc.computers) expect(Object.keys(c)).toEqual(COMPUTER_KEYS)
    expect(beta).toEqual({
      computer: 'beta', self: false, at: remote[0].at, ageMs: remote[0].ageMs, stale: remote[0].stale, more: 3,
      counts: { working: 1, idle: 1, waiting_for_approval: 0, unknown: 0 },
      sessions: remote[0].sessions,
    })
    expect(beta).toMatchObject({ at, ageMs: 5000, stale: false })
    expect(beta.sessions.map((s: Json) => [s.name, s.ageMs])).toEqual([['b-one', 6000], ['b-two', 5000]])
    expect(delta).toEqual({
      computer: 'delta', self: false, at: null, ageMs: null, stale: true, more: 0,
      counts: { working: 0, idle: 0, waiting_for_approval: 0, unknown: 0 }, sessions: [],
    })
  })
})

describe('(s6) the text form', () => {
  it('(40) s6 first line, one line per computer with its counts, a line per session, stale and no reading yet', async () => {
    const doc: Json = await status.statusDocument({ now: fixed })
    const lines = status.renderStatus(doc).split('\n')
    expect(lines[0]).toBe(`Tandem ${VERSION} · runtime not running · kill switch off`)
    expect(lines).toContain('alpha (this computer) · 2 sessions: ' + `${doc.computers[0].counts.working} working, ${doc.computers[0].counts.idle} idle, ${doc.computers[0].counts.waiting_for_approval} waiting, ${doc.computers[0].counts.unknown} unknown · read 0 s ago`)
    expect(lines).toContain('beta · 2 sessions: 1 working, 1 idle, 0 waiting, 0 unknown · read 5 s ago')
    expect(lines).toContain('delta · 0 sessions: 0 working, 0 idle, 0 waiting, 0 unknown · stale · no reading yet')
    for (const s of doc.computers[0].sessions) expect(lines).toContain(`  ${s.name}  ${s.engine}  ${s.state}`)
    expect(lines).toContain('  b-one  claude  working')
    expect(lines).toContain('  b-two  shell  idle')
    expect(lines).toContain('  ... and 3 more')
    // order: each computer line, then its sessions
    const at = (l: string) => lines.indexOf(l)
    expect(at('  b-one  claude  working')).toBeGreaterThan(lines.findIndex((l) => l.startsWith('beta · ')))
    expect(lines.findIndex((l) => l.startsWith('delta · '))).toBeGreaterThan(at('  ... and 3 more'))
  })

  it('(40) s6 ages: 59 s, 60 s, 59 min, 60 min, 47 h, 48 h; a missing or future age is unknown; stale before read; running and on', () => {
    const one = (ageMs: number | null, stale = false, n = 1) => ({
      computer: 'gamma', self: false, at: ageMs === null ? null : 1, ageMs, stale, more: 0,
      counts: { working: 0, idle: 0, waiting_for_approval: 0, unknown: n },
      sessions: Array.from({ length: n }, (_, i) => ({ name: `g-${i}`, engine: 'shell', project: 'p', state: 'unknown', stateAt: 1, ageMs: 1 })),
    })
    const text = (c: Json) => status.renderStatus({ statusVersion: 2, version: '9.9.9', at: 1, runtime: 'running', killSwitch: 'on', computers: [c] } as Json).split('\n')
    expect(text(one(0))[0]).toBe('Tandem 9.9.9 · runtime running · kill switch on')
    const tail = (ms: number | null, stale = false) => text(one(ms, stale))[1].split(' · ').slice(2).join(' · ')
    expect(tail(59_999)).toBe('read 59 s ago')
    expect(tail(60_000)).toBe('read 1 min ago')
    expect(tail(59 * 60_000 + 59_999)).toBe('read 59 min ago')
    expect(tail(60 * 60_000)).toBe('read 1 h ago')
    expect(tail(47 * 3_600_000 + 3_599_999)).toBe('read 47 h ago')
    expect(tail(48 * 3_600_000)).toBe('read 2 d ago')
    expect(tail(-1)).toBe('read unknown ago')
    expect(tail(5000, true)).toBe('stale · read 5 s ago')
    expect(text({ ...one(5000), ageMs: null })[1]).toMatch(/· read unknown ago$/)
    expect(text(one(5000, false, 1))[1]).toBe('gamma · 1 session: 0 working, 0 idle, 0 waiting, 1 unknown · read 5 s ago')
    expect(text(one(5000, false, 0))[1]).toBe('gamma · 0 sessions: 0 working, 0 idle, 0 waiting, 0 unknown · read 5 s ago')
  })
})

describe('(s9) A5.2 shape', () => {
  it('(40) s9 the counts per computer equal its sessions by state, and the text form\'s numbers equal the JSON\'s', async () => {
    const doc: Json = await status.statusDocument({ now: fixed })
    expect(doc.computers.length).toBe(3)
    const lines = status.renderStatus(doc).split('\n').filter((l) => COMPUTER_LINE.test(l))
    expect(lines).toHaveLength(doc.computers.length)
    doc.computers.forEach((c: Json, i: number) => {
      expect(c.counts).toEqual(tally(c.sessions))
      const m = COMPUTER_LINE.exec(lines[i])!
      expect([m[1], Boolean(m[2])]).toEqual([c.computer, c.self])
      expect(m.slice(3, 8).map(Number)).toEqual([c.sessions.length, c.counts.working, c.counts.idle, c.counts.waiting_for_approval, c.counts.unknown])
      expect(Boolean(m[8])).toBe(c.stale)
      expect(m[9] === 'no reading yet').toBe(c.at === null)
    })
    expect(doc.computers[0].sessions.length + doc.computers[1].sessions.length).toBe(4)
  })
})

describe('(s10) no secret or path', () => {
  it('(40) s10 with TANDEM_HUB_LINK_TOKEN set, neither form holds it or TANDEM_HOME\'s path', async () => {
    const token = 'r1a40-known-token-6f1d2c9a8b7e'
    process.env.TANDEM_HUB_LINK_TOKEN = token
    try {
      const json = await captured(() => status.main(['--json']))
      const text = await captured(() => status.main([]))
      expect([json.value, text.value]).toEqual([0, 0])
      expect(JSON.parse(json.out).computers).toHaveLength(3)
      expect(text.out.split('\n')[0]).toMatch(FIRST_LINE)
      for (const out of [json.out, text.out, json.err, text.err]) {
        for (const secret of [token, TH, realpathSync(TH), BOX, HOME]) expect(out.includes(secret)).toBe(false)
      }
    } finally {
      delete process.env.TANDEM_HUB_LINK_TOKEN
    }
  })
})

describe('(s7) the launcher', () => {
  it('(40) s7 `tandem status --json` exit 0 and parses; `tandem status` exit 0; --bogus exit 2 with the usage line; help lists status', () => {
    const inst = join(BOX, 'inst')
    mkdirSync(join(inst, 'bin'), { recursive: true })
    copyFileSync(join(repo, 'packaging', 'tandem'), join(inst, 'bin', 'tandem'))
    if (!existsSync(join(inst, 'runtime'))) symlinkSync(repo, join(inst, 'runtime'))
    const tandem = (...args: string[]) =>
      spawnSync('sh', [join(inst, 'bin', 'tandem'), ...args], { encoding: 'utf8', env: { ...process.env, TANDEM_NODE: process.execPath }, timeout: 30_000 })
    const json = tandem('status', '--json')
    expect(json.status, json.stderr).toBe(0)
    const doc = JSON.parse(json.stdout)
    expect(Object.keys(doc)).toEqual(DOC_KEYS)
    expect(doc.computers[0]).toMatchObject({ computer: 'alpha', self: true })
    expect(doc.computers.map((c: Json) => c.computer)).toEqual(['alpha', 'beta', 'delta'])
    const text = tandem('status')
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout.split('\n')[0]).toBe(`Tandem ${VERSION} · runtime not running · kill switch off`)
    const bogus = tandem('status', '--bogus')
    expect([bogus.status, bogus.stdout, bogus.stderr]).toEqual([2, '', 'usage: tandem status [--json]\n'])
    const help = tandem('help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('  tandem status [--json]      computers, sessions, their states and how old each reading is\n')
    expect(help.stdout.indexOf('tandem status [--json]')).toBeLessThan(help.stdout.indexOf('tandem kill-switch on'))
  })
})

describe('(s8) a reader that throws', () => {
  it('(40) s8 whoIsUp rejects -> main([\'--json\']) returns 1, stderr exactly the fixed line, stdout empty', async () => {
    const presence = {
      whoIsUp: async () => { throw new Error(`cannot read ${TH}/tmux/tandem`) },
      names: async () => [],
    }
    const r = await captured(() => status.main(['--json'], { presence }))
    expect(r).toEqual({ value: 1, out: '', err: 'tandem status: could not read this computer\'s state\n' })
    await expect(status.statusDocument({ presence })).rejects.toThrow()
  })
})
