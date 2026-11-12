/**
 * U-R1A-36A: a caller token per session. TerminalSession.spawn mints one for the session's exact
 * name (bridge/caller-tokens.ts; state.db keeps only its SHA-256) and hands it to that session
 * alone through tmux `new-session -e TANDEM_CALLER_TOKEN=...`. A stdio server started with it is
 * that agent for its whole life: route() gives it the input gate's agent rules and refuses it the
 * relay, its mail is from `session:<name>`, it reads only its own inbox, and its room posts count
 * as agent posts. An unknown token never falls back to the owner: the stdio server refuses to start.
 *
 * Every folder is under one mkdtemp folder named r1a36a- in TMPDIR: TANDEM_HOME (state.db, the
 * limits file, the owner harness file, Tandem's tmux socket), HOME (the audit log), the work
 * folders and the fabric database (its folder the fabric store makes itself). TMUX is deleted
 * before the dynamic imports. afterAll ends every tmux server whose socket is in that folder,
 * then removes it. Sessions are the pinned shell harness file and test/fixtures/fake-cli.sh as an
 * owner harness file; no real agent starts.
 * Tokens are compared in code and never printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.sh', import.meta.url))
const BOX = mkdtempSync(join(tmpdir(), 'r1a36a-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const OUT = join(BOX, 'out')
const CONFIG = join(BOX, 'claude-config')
const CODEX = join(BOX, 'codex-home')
const OWNER = join(TH, 'harnesses')
for (const d of [HOME, WORK, OUT, CONFIG, CODEX]) mkdirSync(d)
mkdirSync(OWNER, { recursive: true, mode: 0o700 })
chmodSync(TH, 0o700)
chmodSync(OWNER, 0o700)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.env.CODEX_HOME = CODEX
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_ENABLED_ENGINES = 'shell,r1a36a-fake'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'
delete process.env.TANDEM_ALLOW_BYPASS

/** fake-cli.sh's screens (as test/input-gate.test.ts): its prompt, its slow turn, its approval question. */
const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`
writeFileSync(join(OWNER, 'r1a36a-fake.toml'), `name = "r1a36a-fake"\nprogram = "${FAKE}"\nhas_prompts = true\n${RULES}`, { mode: 0o600 })

const tokens = await import('../bridge/caller-tokens.ts')
const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { openMailbox } = await import('../bridge/mailbox.ts')
const { HOP_BUDGET } = await import('../bridge/fabric/sqlite-fabric-client.ts')
const { KILL_SWITCH_ON } = await import('../bridge/kill-switch.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SOCK = join(TH, 'tmux', 'tandem')
const AUDIT = join(HOME, '.tandem', 'bridge.log')
const DB = join(TH, 'state.db')
const FABRIC_DB = join(BOX, 'fabric', 'fabric.sqlite3')
const AGENT = 'r1a36a-agent'
const SENDER = `session:${AGENT}`
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const REFUSED = 'tandem stdio: caller token unknown; refusing to start'
const DEVICE_REFUSED = "device: an agent acts on another computer only through the hub, as that computer's control_from allows"
const OWN_INBOX = `mail_read: an agent reads only its own inbox (session ${AGENT})`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every token value this file sees, and every text a child or a tool gave back: (c6) searches them. */
const SECRETS: string[] = []
const STDERR: { text: string }[] = []
const ANSWERS: string[] = []
const keep = (t: string | undefined) => {
  if (t) SECRETS.push(t)
  return t
}

let BASE_LIMITS: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE_LIMITS, ...extra })
  limits.applyLimits()
}

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })

function tmuxOut(args: string[]): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
/** ccm-<name>'s tmux session environment, as any process of this user can read it. */
const sessionEnv = (name: string) => tmuxOut(['show-environment', '-t', `=ccm-${name}`])
/** The TANDEM_CALLER_TOKEN inside ccm-<name> (a shell session): its shell writes it to a file, which
 *  is read and removed at once (kept in SECRETS, never printed; the screen shows the command only). */
async function tokenOf(name: string): Promise<string | undefined> {
  const file = join(BOX, `tok-${name}`)
  await rq('POST', `/sessions/${name}/send`, { text: `printf %s "$TANDEM_CALLER_TOKEN" > '${file}'` })
  await until(() => existsSync(file) && statSync(file).size > 0, 5_000)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  rmSync(file, { force: true })
  return keep(text || undefined)
}
/** The stored SHA-256 of <name>'s token, or undefined. */
function hashRow(name: string): string | undefined {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    return (db.prepare('SELECT hash FROM caller_tokens WHERE name = ?').get(name) as Json)?.hash
  } finally {
    db.close()
  }
}
const ccm = () => tmuxOut(['list-sessions', '-F', '#{session_name}']).split('\n').filter((n) => n.startsWith('ccm-'))
const screen = (name: string) => tmuxOut(['capture-pane', '-p', '-J', '-S', '-', '-t', `=ccm-${name}:`])
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(100)
  }
  return test()
}
function auditLines(): Json[] {
  if (!existsSync(AUDIT)) return []
  return readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
/** A file's bytes, read by a `cat` child: closing a descriptor of a SQLite file in this process
 *  would drop every lock this process's own connections hold on it (and let a close here delete
 *  the WAL the stdio children still write to). */
const bytesOf = (file: string): Buffer => spawnSync('cat', [file], { maxBuffer: 256 * 1024 * 1024 }).stdout
function mailRows(where: string, ...args: (string | number)[]): Json[] {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    return db.prepare(`SELECT id, from_id, to_name, level, state FROM mail WHERE ${where} ORDER BY seq`).all(...args) as Json[]
  } finally {
    db.close()
  }
}

/** The stdio server's environment: this file's folders, nothing of the caller's TANDEM_* or CCM_*. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  return Object.assign(env, {
    HOME, TANDEM_HOME: TH, TMUX_TMPDIR: BOX, TANDEM_CWD_ALLOWLIST: BOX, TANDEM_ENABLED_ENGINES: 'shell,r1a36a-fake',
    TANDEM_WAIT_MS: '8000', SHELL: '/bin/sh', NODE_NO_WARNINGS: '1',
  }, extra)
}

interface Child { err: { text: string }; call(name: string, args?: Record<string, unknown>): Promise<Json>; close(): Promise<void> }
const CHILDREN: Child[] = []
/** src/stdio-server.ts as its own process (as test/presence.test.ts (f) starts one). */
async function startChild(extra: Record<string, string> = {}): Promise<Child> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, stderr: 'pipe', env: childEnv(extra),
  })
  const err = { text: '' }
  STDERR.push(err)
  transport.stderr?.on('data', (d) => { err.text += d })
  const client = new Client({ name: 'r1a36a', version: '0.0.0' })
  await client.connect(transport)
  const child: Child = {
    err,
    async call(name, args = {}) {
      const text = ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text
      ANSWERS.push(text)
      return JSON.parse(text)
    },
    close: () => client.close(),
  }
  CHILDREN.push(child)
  return child
}
/** A stdio server that should refuse to start: its exit code and output (ended after 20 s if it does not exit). */
function runRefused(token: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', 'src/stdio-server.ts'], {
      cwd: repo, env: childEnv({ TANDEM_CALLER_TOKEN: token }), stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = { stderr: '', stdout: '' }
    p.stdout.on('data', (d) => { out.stdout += d })
    p.stderr.on('data', (d) => { out.stderr += d })
    const timer = setTimeout(() => p.kill('SIGTERM'), 20_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      STDERR.push({ text: out.stderr }, { text: out.stdout })
      resolve({ code, ...out })
    })
  })
}

let AGENT_TOKEN = ''

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  const fake = loadedHarnesses().get('r1a36a-fake')
  if (!sh || !fake) throw new Error('the shell or r1a36a-fake harness file did not load')
  BASE_LIMITS = { folders: [WORK], shell: true, agents: { shell: agentEntry(sh), 'r1a36a-fake': agentEntry(fake) }, interrupt_from: ['owner'] }
  setLimits()
  // The agent: a shell session the owner (this process) opens; its token is the agent's identity.
  const opened = await rq('POST', '/sessions/open', { engine: 'shell', name: AGENT, cwd: WORK })
  if (opened.status !== 200) throw new Error(`open ${AGENT}: ${opened.status}`)
  // A missing token (before the unit) still starts the rows with a well-formed made-up one.
  AGENT_TOKEN = (await tokenOf(AGENT)) ?? 'A'.repeat(43)
})

afterAll(async () => {
  for (const c of CHILDREN) await c.close().catch(() => {})
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

describe('(t1) mint, resolve, revoke', () => {
  it('(36A) (t1) a token is 43 base64url characters and resolves to its exact name', () => {
    const t = keep(tokens.mintCallerToken('r1a36a-t1'))!
    expect(TOKEN_RE.test(t)).toBe(true)
    expect(tokens.resolveCallerToken(t)).toBe('r1a36a-t1')
  })

  it('(36A) (t1) minted twice for one name, the first no longer resolves; revoke leaves none', () => {
    const first = keep(tokens.mintCallerToken('r1a36a-twice'))!
    const second = keep(tokens.mintCallerToken('r1a36a-twice'))!
    expect(second === first).toBe(false)
    expect(tokens.resolveCallerToken(first)).toBeUndefined()
    expect(tokens.resolveCallerToken(second)).toBe('r1a36a-twice')
    tokens.revokeCallerToken('r1a36a-twice')
    expect(tokens.resolveCallerToken(second)).toBeUndefined()
  })

  it('(36A) (t1) AtkCase and atkcase hold separate tokens and neither resolves as the other', () => {
    const upper = keep(tokens.mintCallerToken('AtkCase'))!
    const lower = keep(tokens.mintCallerToken('atkcase'))!
    expect(upper === lower).toBe(false)
    expect(tokens.resolveCallerToken(upper)).toBe('AtkCase')
    expect(tokens.resolveCallerToken(lower)).toBe('atkcase')
    tokens.revokeCallerToken('atkcase')
    expect(tokens.resolveCallerToken(lower)).toBeUndefined()
    expect(tokens.resolveCallerToken(upper)).toBe('AtkCase')
    tokens.revokeCallerToken('ATKCASE')
    expect(tokens.resolveCallerToken(upper)).toBe('AtkCase')
  })

  it('(36A) (t1) 42 or 44 characters, a + or /, an empty string, a number or no string resolve to nothing', () => {
    const t = keep(tokens.mintCallerToken('r1a36a-shape'))!
    expect(tokens.resolveCallerToken(t)).toBe('r1a36a-shape')
    for (const bad of [t.slice(0, 42), `${t}A`, `${t.slice(0, 42)}+`, `/${t.slice(1)}`, '', ` ${t.slice(1)}`, 42, undefined, null, {}, [t]]) {
      expect(tokens.resolveCallerToken(bad)).toBeUndefined()
    }
  })

  it('(36A) (t1) a session name with a space, a control, bidi or tag character, or none, gets no token', () => {
    for (const bad of ['', 'a b', 'a\u0085b', 'a\u202eb', 'a\u{e0041}b', 'a:b', 'x'.repeat(257)]) {
      expect(() => tokens.mintCallerToken(bad)).toThrow()
    }
  })

  it('(36A) (t1) state.db (0600 in a 0700 folder) holds the SHA-256 of a token, never its text', () => {
    const t = keep(tokens.mintCallerToken('r1a36a-bytes'))!
    expect(statSync(DB).mode & 0o777).toBe(0o600)
    expect(statSync(TH).mode & 0o777).toBe(0o700)
    const db = new DatabaseSync(DB, { readOnly: true })
    try {
      const row = db.prepare('SELECT hash FROM caller_tokens WHERE name = ?').get('r1a36a-bytes') as Json
      expect(row.hash === createHash('sha256').update(t).digest('hex')).toBe(true)
    } finally {
      db.close()
    }
    for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
      if (existsSync(file)) expect(bytesOf(file).includes(Buffer.from(t))).toBe(false)
    }
  })
})

describe('(t2) the spawn mints, close revokes', () => {
  let t2 = ''
  it('(36A) (t2) a shell session opened through route() holds its own TANDEM_CALLER_TOKEN, resolving to its name', async () => {
    const opened = await rq('POST', '/sessions/open', { engine: 'shell', name: 'r1a36a-t2', cwd: WORK })
    expect(opened.status).toBe(200)
    t2 = (await tokenOf('r1a36a-t2')) ?? ''
    expect(TOKEN_RE.test(t2)).toBe(true)
    expect(tokens.resolveCallerToken(t2)).toBe('r1a36a-t2')
    expect(TOKEN_RE.test(AGENT_TOKEN) && tokens.resolveCallerToken(AGENT_TOKEN) === AGENT).toBe(true)
    expect(t2 === AGENT_TOKEN).toBe(false)
  })

  it('(36A) (audit a1) the token is in the pane\'s processes only: no session\'s tmux environment holds TANDEM_CALLER_TOKEN', () => {
    for (const name of [AGENT, 'r1a36a-t2']) {
      expect(sessionEnv(name).length > 0).toBe(true)
      expect(sessionEnv(name).includes('TANDEM_CALLER_TOKEN')).toBe(false)
    }
  })

  it('(36A) (t2) the tmux global environment and this process hold no TANDEM_CALLER_TOKEN, and this process has no caller', () => {
    const global = tmuxOut(['show-environment', '-g'])
    expect(global.length > 0).toBe(true)
    expect(global.includes('TANDEM_CALLER_TOKEN')).toBe(false)
    expect(process.env.TANDEM_CALLER_TOKEN === undefined).toBe(true)
    expect(tokens.processCaller()).toBeUndefined()
  })

  it('(36A) (t2) after close_session the token no longer resolves; the owner\'s audit lines carry no caller', async () => {
    expect((await rq('POST', '/sessions/r1a36a-t2/close')).status).toBe(200)
    expect(ccm().includes('ccm-r1a36a-t2')).toBe(false)
    expect(tokens.resolveCallerToken(t2)).toBeUndefined()
    const mine = auditLines().filter((l) => l.name === 'r1a36a-t2')
    expect(mine.length).toBeGreaterThanOrEqual(2)
    expect(mine.filter((l) => 'caller' in l)).toEqual([])
  })
})

let agent: Child

describe('(c1) the stdio server\'s caller', () => {
  it('(36A) (c1) with a resolved token it prints tandem stdio: caller session:r1a36a-agent', async () => {
    agent = await startChild({ TANDEM_CALLER_TOKEN: AGENT_TOKEN })
    expect(await until(() => agent.err.text.includes(`tandem stdio: caller ${SENDER}\n`), 10_000)).toBe(true)
  })

  it('(36A) (c1) a revoked token: exit 1 with exactly the refusal line', async () => {
    const t = keep(tokens.mintCallerToken('r1a36a-gone'))!
    tokens.revokeCallerToken('r1a36a-gone')
    const r = await runRefused(t)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`${REFUSED}\n`)
    expect(r.stdout).toBe('')
  })

  it('(36A) (c1) a made-up token and an empty one: exit 1 with exactly the refusal line', async () => {
    for (const t of [keep(randomBytes(32).toString('base64url'))!, '', 'not-a-token']) {
      const r = await runRefused(t)
      expect(r.code).toBe(1)
      expect(r.stderr).toBe(`${REFUSED}\n`)
    }
  })

  it('(36A) (c1) with no token the stdio server is the owner: mail_send stores owner', async () => {
    const owner = await startChild()
    const sent = await owner.call('mail_send', { to: 'w', level: 'fyi', text: 'from the owner (36A)' })
    expect(mailRows('id = ?', sent.id).map((r) => r.from_id)).toEqual(['owner'])
    expect(owner.err.text.includes('tandem stdio: caller')).toBe(false)
  })
})

describe('(c2) A3.9: the agent opens, messages and closes a session on its computer', () => {
  let from = 0
  let bHash = ''
  beforeAll(() => { from = auditLines().length })

  it('(36A) (c2) open_session of r1a36a-b (fake agent, allowed folder) as the agent: opened, with its own token', async () => {
    const r = await agent.call('open_session', { name: 'r1a36a-b', engine: 'r1a36a-fake', cwd: WORK })
    expect(r.error).toBeUndefined()
    expect(ccm().includes('ccm-r1a36a-b')).toBe(true)
    bHash = hashRow('r1a36a-b') ?? ''
    expect(/^[0-9a-f]{64}$/.test(bHash)).toBe(true)
    expect(bHash === createHash('sha256').update(AGENT_TOKEN).digest('hex')).toBe(false)
  })

  it('(36A) (c2) send_to_session text at the fake agent\'s settled idle is typed', async () => {
    const r = await agent.call('send_to_session', { name: 'r1a36a-b', text: 'hello-r1a36a' })
    expect(r.error).toBeUndefined()
    expect(r.status === 'held').toBe(false)
    expect(await until(() => screen('r1a36a-b').includes('reply: hello-r1a36a'), 10_000)).toBe(true)
  })

  it('(36A) (c2) interrupt_session as the agent: refused, an agent never interrupts', async () => {
    const r = await agent.call('interrupt_session', { name: 'r1a36a-b' })
    expect(r.error).toBe('input gate: an agent may not interrupt a session')
  })

  it('(36A) (c2) close_session as the agent: closed, gone, its token revoked', async () => {
    const r = await agent.call('close_session', { name: 'r1a36a-b' })
    expect(r).toEqual(expect.objectContaining({ ok: true, name: 'r1a36a-b' }))
    expect(ccm().includes('ccm-r1a36a-b')).toBe(false)
    expect(hashRow('r1a36a-b')).toBeUndefined()
  })

  it('(36A) (c2) open_session with a cwd outside the limits file\'s folders: refused with the limits text', async () => {
    const r = await agent.call('open_session', { name: 'r1a36a-out', engine: 'shell', cwd: OUT })
    expect(String(r.error)).toMatch(/^limits: cwd .* is not inside the limits file's folders/)
    expect(ccm().includes('ccm-r1a36a-out')).toBe(false)
  })

  it('(36A) (c2) relay start, enqueue, inject and stop as the agent: relay: an agent may not drive the relay; read still answers', async () => {
    expect((await agent.call('relay', { action: 'start', goal: 'x', cwd: WORK })).error).toBe('relay: an agent may not drive the relay')
    expect((await agent.call('relay', { action: 'enqueue', loopId: 'nope', task: 'x' })).error).toBe('relay: an agent may not drive the relay')
    expect((await agent.call('relay', { action: 'inject', loopId: 'nope', message: 'x' })).error).toBe('relay: an agent may not drive the relay')
    expect((await agent.call('relay', { action: 'stop', loopId: 'nope' })).error).toBe('relay: an agent may not drive the relay')
    expect((await agent.call('relay', { action: 'read', loopId: 'nope' })).error).toBe('unknown loopId: nope')
  })

  it('(36A) (c2) device beta, or a beta:<name> name, as the agent: the exact device refusal', async () => {
    expect((await agent.call('open_session', { engine: 'shell', device: 'beta' })).error).toBe(DEVICE_REFUSED)
    expect((await agent.call('send_to_session', { name: 'beta:x', text: 'hi' })).error).toBe(DEVICE_REFUSED)
    expect((await agent.call('interrupt_session', { name: 'x', device: 'beta' })).error).toBe(DEVICE_REFUSED)
    expect((await agent.call('close_session', { name: 'beta:x' })).error).toBe(DEVICE_REFUSED)
    expect((await agent.call('list_sessions', { device: 'beta' })).error).toBe(DEVICE_REFUSED)
  })

  it('(36A) (c2) the bridge audit lines of these calls carry caller session:r1a36a-agent', () => {
    const lines = auditLines().slice(from).filter((l) => typeof l.route === 'string')
    const routes = lines.map((l) => `${l.route}${l.denied ? ` denied:${l.denied}` : ''}`)
    for (const want of [
      'POST /sessions/open', 'POST /sessions/:name/send', 'POST /sessions/:name/interrupt denied:input-gate',
      'POST /sessions/:name/close', 'POST /sessions/open denied:limits', 'POST /relay/start denied:agent-relay',
    ]) expect(routes).toContain(want)
    expect(lines.filter((l) => l.caller !== SENDER).map((l) => l.route)).toEqual([])
  })
})

describe('(c3) mail as the agent', () => {
  it('(36A) (c3) mail_send to w stores from session:r1a36a-agent', async () => {
    const sent = await agent.call('mail_send', { to: 'w', level: 'fyi', text: 'from the agent (36A)' })
    expect(mailRows('id = ?', String(sent.id)).map((r) => r.from_id)).toEqual([SENDER])
  })

  it('(36A) (c3) with interrupt_from ["owner"] an Interrupt to w is refused naming session:r1a36a-agent', async () => {
    const r = await agent.call('mail_send', { to: 'w', level: 'interrupt', text: 'stop (36A)' })
    expect(r.error).toBe(`interrupt_from: ${SENDER} may not send Interrupt (limits file); nothing was saved`)
  })

  it('(36A) (c3) with interrupt_from ["session:r1a36a-agent"] the Interrupt is sent', async () => {
    setLimits({ interrupt_from: [SENDER] })
    try {
      const allowed = await startChild({ TANDEM_CALLER_TOKEN: AGENT_TOKEN })
      const r = await allowed.call('mail_send', { to: 'w', level: 'interrupt', text: 'stop now (36A)' })
      expect(r.state).toBe('queued')
      expect(mailRows('id = ?', String(r.id)).map((row) => [row.from_id, row.level])).toEqual([[SENDER, 'interrupt']])
    } finally {
      setLimits()
    }
  })
})

describe('(c4) mail_read as the agent: its own inbox only', () => {
  const box = openMailbox()
  afterAll(() => box.close())

  it('(36A) (c4) its own inbox with name omitted: its messages', async () => {
    box.send({ from: 'owner', to: AGENT, level: 'fyi', text: 'for the agent, one' })
    const r = await agent.call('mail_read', {})
    expect(r.error).toBeUndefined()
    expect(r.messages.map((m: Json) => [m.to, m.text])).toEqual([[AGENT, 'for the agent, one']])
  })

  it('(36A) (c4) its own inbox by its exact name: its messages', async () => {
    box.send({ from: 'owner', to: AGENT, level: 'fyi', text: 'for the agent, two' })
    const r = await agent.call('mail_read', { box: 'inbox', name: AGENT })
    expect(r.messages.map((m: Json) => [m.to, m.text])).toEqual([[AGENT, 'for the agent, two']])
  })

  it('(36A) (c4) name w: the own-inbox error, and w\'s mail stays queued', async () => {
    const before = mailRows('to_name = ? AND state = ?', 'w', 'queued').length
    expect(before).toBeGreaterThanOrEqual(2)
    const r = await agent.call('mail_read', { name: 'w' })
    expect(r).toEqual({ error: OWN_INBOX })
    expect(mailRows('to_name = ? AND state = ?', 'w', 'queued').length).toBe(before)
  })

  it('(36A) (c4) name R1A36A-AGENT (its name in another case): the same error', async () => {
    box.send({ from: 'owner', to: 'R1A36A-AGENT', level: 'fyi', text: 'case twin' })
    expect(await agent.call('mail_read', { name: 'R1A36A-AGENT' })).toEqual({ error: OWN_INBOX })
    expect(mailRows('to_name = ? AND state = ?', 'R1A36A-AGENT', 'queued').length).toBe(1)
  })

  it('(36A) (c4) outbox: only its own sent rows, never the owner\'s', async () => {
    const r = await agent.call('mail_read', { box: 'outbox' })
    expect(Array.isArray(r)).toBe(true)
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r.filter((m: Json) => m.from !== SENDER)).toEqual([])
    expect(mailRows('from_id = ?', 'owner').length).toBeGreaterThanOrEqual(3)
  })
})

describe('(c5) rooms: an agent\'s posts count as agent posts', () => {
  let ownerF: Child
  let agentF: Child
  let projectId = ''
  const fabric = { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: FABRIC_DB }
  const wakes = () => mailRows('to_name = ? AND from_id = ?', 'w', 'room:r36').length

  it(`(36A) (c5) five agent posts in a row naming @w leave exactly HOP_BUDGET - 1 = 4 wake lines`, async () => {
    expect(HOP_BUDGET).toBe(5)
    ownerF = await startChild(fabric)
    agentF = await startChild({ ...fabric, TANDEM_CALLER_TOKEN: AGENT_TOKEN })
    projectId = (await ownerF.call('project_create', { displayName: 'R36' })).projectId
    expect(typeof projectId).toBe('string')
    for (let i = 1; i <= 5; i++) {
      const e = await agentF.call('room_post', { projectId, room: 'r36', type: 'message', body: `@w agent post ${i}`, idempotencyKey: `agent-${i}` })
      expect(e.error).toBeUndefined()
    }
    expect(wakes()).toBe(HOP_BUDGET - 1)
  })

  it('(36A) (c5) an owner stdio post then wakes w again', async () => {
    const e = await ownerF.call('room_post', { projectId, room: 'r36', type: 'message', body: '@w owner post', idempotencyKey: 'owner-1' })
    expect(e.error).toBeUndefined()
    expect(wakes()).toBe(HOP_BUDGET)
  })

  it('(36A) (audit a8) memory as the agent: it stores no user memory and finds none of the owner\'s', async () => {
    const kept = await ownerF.call('memory_remember', { scope: 'user', kind: 'fact', text: 'r36a-owner-only-note', importance: 0.5 })
    expect(kept.error).toBeUndefined()
    const mine = await ownerF.call('memory_search', { query: 'r36a-owner-only-note' })
    expect(JSON.stringify(mine)).toContain('r36a-owner-only-note')
    const refused = await agentF.call('memory_remember', { scope: 'user', kind: 'fact', text: 'r36a-agent-user-note', importance: 0.5 })
    expect(typeof refused.error).toBe('string')
    for (const args of [{ query: 'r36a-owner-only-note' }, { query: 'r36a-owner-only-note', scope: 'user' }, { query: 'r36a-agent-user-note' }]) {
      expect(JSON.stringify(await agentF.call('memory_search', args))).not.toContain('-note')
    }
    expect(JSON.stringify(await ownerF.call('memory_search', { query: 'r36a-agent-user-note' }))).not.toContain('r36a-agent-user-note')
  })
})

describe('(audit) U-R1A-36A audit rows', () => {
  it('(36A) (audit a2) a session that ended without close (kill-session, as the kill switch closes one) or never started: its token refuses to start', async () => {
    expect((await rq('POST', '/sessions/open', { engine: 'shell', name: 'r1a36a-dead', cwd: WORK })).status).toBe(200)
    const t = (await tokenOf('r1a36a-dead')) ?? ''
    expect(tokens.resolveCallerToken(t)).toBe('r1a36a-dead')
    tmuxOut(['kill-session', '-t', '=ccm-r1a36a-dead'])
    expect(ccm().includes('ccm-r1a36a-dead')).toBe(false)
    const never = keep(tokens.mintCallerToken('r1a36a-never'))!
    for (const token of [t, never]) {
      const r = await runRefused(token)
      expect(r.code).toBe(1)
      expect(r.stderr).toBe(`${REFUSED}\n`)
      expect(r.stdout).toBe('')
    }
    await rq('POST', '/sessions/r1a36a-dead/close')
  })

  it('(36A) (audit a3) an oversized token, one with a space or a line end after it, one in another case: exit 1 with exactly the refusal line', async () => {
    for (const token of ['A'.repeat(100_000), `${AGENT_TOKEN} `, `${AGENT_TOKEN}\n`, ` ${AGENT_TOKEN}`, `${AGENT_TOKEN}${AGENT_TOKEN}`, AGENT_TOKEN.toUpperCase() === AGENT_TOKEN ? '' : AGENT_TOKEN.toUpperCase()]) {
      const r = await runRefused(token)
      expect(r.code).toBe(1)
      expect(r.stderr).toBe(`${REFUSED}\n`)
      expect(r.stdout).toBe('')
    }
  })

  it('(36A) (audit a4) mail_send with a sender argument as the agent: refused by name, nothing stored as the owner or as another session', async () => {
    const owners = mailRows('from_id = ?', 'owner').length
    for (const extra of [{ from: 'owner' }, { sender: 'owner' }, { caller: 'session:w' }, { from: 'session:w' }]) {
      const r = await agent.call('mail_send', { to: 'w', level: 'fyi', text: 'audit a4', ...extra })
      expect(r.error).toBe(`unknown key: ${Object.keys(extra)[0]}`)
    }
    expect(mailRows('from_id = ?', 'owner').length).toBe(owners)
    expect(mailRows('from_id = ?', 'session:w').length).toBe(0)
  })

  it('(36A) (audit a5) session_cap holds for the agent: its open is refused at the cap, nothing starts', async () => {
    setLimits({ session_cap: 1 })
    try {
      const capped = await startChild({ TANDEM_CALLER_TOKEN: AGENT_TOKEN })
      const r = await capped.call('open_session', { name: 'r1a36a-cap', engine: 'shell', cwd: WORK })
      expect(String(r.error)).toMatch(/^limits: session_cap 1 reached \(\d+ sessions open\); close one first$/)
      expect(ccm().includes('ccm-r1a36a-cap')).toBe(false)
      expect(hashRow('r1a36a-cap')).toBeUndefined()
    } finally {
      setLimits()
    }
  })

  it('(36A) (audit a6) the kill switch holds for the agent: open and send answer the kill switch text', async () => {
    writeFileSync(join(TH, 'kill-switch'), 'on (36A audit)\n', { mode: 0o600 })
    try {
      expect((await agent.call('open_session', { name: 'r1a36a-ks', engine: 'shell', cwd: WORK })).error).toBe(KILL_SWITCH_ON)
      expect((await agent.call('send_to_session', { name: AGENT, text: 'true' })).error).toBe(KILL_SWITCH_ON)
      expect(ccm().includes('ccm-r1a36a-ks')).toBe(false)
      expect(hashRow('r1a36a-ks')).toBeUndefined()
    } finally {
      rmSync(join(TH, 'kill-switch'), { force: true })
    }
  })

  it('(36A) (audit a7) relay stop, inject and enqueue with an empty, a slashed or a dotted loopId as the agent: an error every time, no relay handler runs', async () => {
    const from = auditLines().length
    for (const loopId of ['', 'a/b', '..', 'x/stop', 'start']) {
      for (const [action, extra] of [['stop', {}], ['inject', { message: 'x' }], ['enqueue', { task: 'x' }]] as const) {
        const r = await agent.call('relay', { action, loopId, ...extra })
        expect(typeof r.error).toBe('string')
      }
    }
    const relayLines = auditLines().slice(from).filter((l) => String(l.route).includes('/relay/'))
    expect(relayLines.filter((l) => l.denied !== 'agent-relay')).toEqual([])
  })
})

describe('(c6) the token is never printed', () => {
  it('(36A) (c6) no token appears in any stderr line, audit line, tool answer or file of these rows', () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(10)
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        const st = lstatSync(path)
        if (st.isDirectory()) walk(path)
        else if (st.isFile()) files.push(path)
      }
    }
    walk(BOX)
    expect(files).toContain(AUDIT)
    const texts = [...STDERR.map((s) => s.text), ...ANSWERS, ...files.map((f) => bytesOf(f).toString('latin1'))]
    const found = SECRETS.filter((secret) => texts.some((text) => text.includes(secret)))
    expect(found.length).toBe(0)
  })
})
