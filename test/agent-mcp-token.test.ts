/**
 * U-R1A-36C: an agent's caller token reaches Tandem's MCP server even when the agent starts its MCP
 * servers with a filtered environment, and a stdio server started inside a Tandem session with no
 * token is never the owner.
 *
 * A harness file says how its agent hands environment to a stdio MCP server (`mcp_env`). For
 * `config-overrides` Tandem registers its own `tandem` stdio server for that one session through
 * `--config` values naming the variables to pass (`env_vars`), so no token ever sits on a command
 * line. A stdio server with no token refuses to start when one of its parent processes is a pane of
 * a session on Tandem's socket, and one serving an agent re-checks on every tools/call that its
 * session is still there.
 *
 * Every folder is under one mkdtemp folder named r1a36c- in TMPDIR: HOME, TANDEM_HOME (HOME/.tandem,
 * so a stdio server whose environment kept only HOME still finds the same store and socket),
 * an empty CLAUDE_CONFIG_DIR and CODEX_HOME, the work folder and the fake agents. TMUX is deleted
 * before the dynamic imports. afterAll ends every tmux server whose socket is in that folder, the
 * test's own children by their process groups, then removes the folder. No real agent program is
 * ever started: the agents are a node script written here (a filtering agent, as Codex filters) and
 * a recorder shell script. Tokens are compared in code and never printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'smol-toml'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const STDIO = join(repo, 'src', 'stdio-server.ts')
const BUILTIN = join(repo, 'harnesses')
const BOX = mkdtempSync(join(tmpdir(), 'r1a36c-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const HOME = join(BOX, 'home')
const TH = join(HOME, '.tandem')
const WORK = join(BOX, 'work')
const OUT = join(BOX, 'out')
const BIN = join(BOX, 'bin')
const CONFIG = join(BOX, 'claude-config')
const CODEX = join(BOX, 'codex-home')
const OWNER = join(TH, 'harnesses')
for (const d of [HOME, WORK, OUT, BIN, CONFIG, CODEX]) mkdirSync(d)
mkdirSync(OWNER, { recursive: true, mode: 0o700 })
chmodSync(TH, 0o700)
chmodSync(OWNER, 0o700)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.env.CODEX_HOME = CODEX
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_ENABLED_ENGINES = 'shell,r1a36c-codex,r1a36c-plain'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'
delete process.env.TANDEM_ALLOW_BYPASS
delete process.env.TANDEM_CALLER_TOKEN
delete process.env.TANDEM_HUB_LINK_TOKEN

const NO_TOKEN = 'tandem stdio: started inside a Tandem session with no caller token; refusing to start'
const CANNOT_TELL = 'tandem stdio: cannot tell whether this runs inside a Tandem session; refusing to start'
const READY = 'tandem MCP bridge ready on stdio'
const ended = (name: string) => `caller: session ${name} has ended; this server stops`
const stopping = (name: string) => `tandem stdio: caller session:${name} has ended; stopping`

/**
 * The filtering agent: it reads its own `--config mcp_servers.tandem.*` values (smol-toml), starts
 * that command and args with an environment made only of HOME PATH USER SHELL TERM TMPDIR LANG plus
 * the `env_vars` names copied from its own environment (Codex's documented behaviour); with no such
 * values it starts src/stdio-server.ts with the filtered list alone. It speaks MCP initialize and one
 * tools/call mail_send to `w` (text = its label), writes what happened under OUT, and shows an idle
 * screen. Its own token goes to OUT/<label>.tok (0600) so the test can compare it, never print it.
 */
const SMOL = pathToFileURL(createRequire(import.meta.url).resolve('smol-toml')).href
const FAKE = join(BIN, 'fake36c.mjs')
writeFileSync(FAKE, `#!${process.execPath}
import { spawn } from 'node:child_process'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from ${JSON.stringify(SMOL)}
const OUT = ${JSON.stringify(OUT)}
const label = process.argv[2]
const put = (ext, text) => { const f = join(OUT, label + '.' + ext); writeFileSync(f + '.tmp', text, { mode: 0o600 }); renameSync(f + '.tmp', f) }
put('tok', process.env.TANDEM_CALLER_TOKEN ?? '')
const argv = process.argv.slice(3)
const conf = {}
for (let i = 0; i + 1 < argv.length; i++) {
  if (argv[i] === '--config' && argv[i + 1].startsWith('mcp_servers.tandem.')) Object.assign(conf, parse(argv[i + 1]).mcp_servers.tandem)
}
const command = conf.command ?? process.execPath
const args = conf.args ?? ['--experimental-strip-types', ${JSON.stringify(STDIO)}]
const env = {}
for (const n of ['HOME', 'PATH', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'LANG', ...(conf.env_vars ?? [])]) if (process.env[n] !== undefined) env[n] = process.env[n]
put('env', Object.keys(env).sort().join('\\n'))
process.stdout.write('fake36c>')
const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
let err = ''
child.stderr.on('data', (d) => { err += d; put('stderr', err) })
child.on('exit', (code) => { put('stderr', err); put('exit', String(code)) })
child.stdin.on('error', () => {})
let buf = ''
const waiting = new Map()
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    try { const m = JSON.parse(line); waiting.get(m.id)?.(m) } catch {}
  }
})
const req = (id, method, params) => new Promise((done) => { waiting.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n') })
await req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake36c', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n')
const r = await req(2, 'tools/call', { name: 'mail_send', arguments: { to: 'w', level: 'fyi', text: label } })
put('result', JSON.stringify(r))
setInterval(() => {}, 60_000)
`, { mode: 0o755 })

/** The fake's screens. */
const RULES = `[states]
working = ['^fake36c is thinking\\z']
idle = ['fake36c>\\z']
debounce_ms = 300
`
const HOOKED = `delivery = "hook"\nhook = "--config"\nhook_format = "config-overrides"\n`
writeFileSync(join(OWNER, 'r1a36c-codex.toml'),
  `name = "r1a36c-codex"\nprogram = "${FAKE}"\nargs = ["r1a36c-codex"]\nhas_prompts = false\n${HOOKED}mcp_env = "config-overrides"\n${RULES}`, { mode: 0o600 })
writeFileSync(join(OWNER, 'r1a36c-plain.toml'),
  `name = "r1a36c-plain"\nprogram = "${FAKE}"\nargs = ["r1a36c-plain"]\nhas_prompts = false\n${HOOKED}${RULES}`, { mode: 0o600 })

const tokens = await import('../bridge/caller-tokens.ts')
const dh = await import('../bridge/delivery-hooks.ts')
const { HarnessSession } = await import('../bridge/engines/harness-engine.ts')
const { loadHarnesses } = await import('../bridge/harness-registry.ts')
const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const limits = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SOCK = join(TH, 'tmux', 'tandem')
const DB = join(TH, 'state.db')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(100)
  }
  return test()
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
const panePid = (name: string) => Number(tmuxOut(['display-message', '-p', '-t', `=ccm-${name}:`, '#{pane_pid}']).trim())
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
/** Node's own warning lines (a Node that still flags type stripping prints one) are not the server's output. */
const serverLines = (text: string) => text.split('\n').filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l))
function mailRows(text: string): Json[] {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    return db.prepare('SELECT id, from_id, to_name FROM mail WHERE text = ? ORDER BY seq').all(text) as Json[]
  } finally {
    db.close()
  }
}
/** The TANDEM_CALLER_TOKEN inside ccm-<name> (a shell session), through a file read and removed at once. */
async function tokenOf(name: string): Promise<string> {
  const file = join(BOX, `tok-${name}`)
  await rq('POST', `/sessions/${name}/send`, { text: `printf %s "$TANDEM_CALLER_TOKEN" > '${file}'` })
  await until(() => existsSync(file) && statSync(file).size > 0, 5_000)
  const text = read(file)
  rmSync(file, { force: true })
  return text
}
/** Types `text` into the shell session `name` (the shell harness). */
async function typeIn(name: string, text: string): Promise<void> {
  const r = await rq('POST', `/sessions/${name}/send`, { text })
  if (r.status !== 200) throw new Error(`send to ${name}: ${r.status}`)
}
/** Every process's command line, read once: /proc on Linux, ps elsewhere (never printed). */
function commandLines(): string[] {
  if (process.platform === 'linux') {
    const lines: string[] = []
    for (const p of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try { lines.push(readFileSync(`/proc/${p}/cmdline`, 'utf8').replaceAll('\0', ' ')) } catch { /* gone */ }
    }
    return lines
  }
  return execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
}
/** A process's group id: /proc on Linux, ps elsewhere; undefined when it is gone. */
function pgidOf(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
    }
    const n = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    return n > 0 ? n : undefined
  } catch {
    return undefined
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
    HOME, TANDEM_HOME: TH, TMUX_TMPDIR: BOX, TANDEM_CWD_ALLOWLIST: WORK, TANDEM_ENABLED_ENGINES: 'shell', SHELL: '/bin/sh', NODE_NO_WARNINGS: '1',
  }, extra)
}

/** src/stdio-server.ts as this test's own child (its own process group), spoken to as raw JSON-RPC lines. */
interface Raw { req(method: string, params?: unknown): Promise<Json>; notify(method: string): void; init(): Promise<Json>; exit: Promise<number | null>; err: { text: string }; proc: ChildProcess }
const RAWS: Raw[] = []
function startRaw(env: Record<string, string>): Raw {
  const proc = spawn(process.execPath, ['--experimental-strip-types', STDIO], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const err = { text: '' }
  const waiting = new Map<number, (m: Json) => void>()
  let buf = ''
  let id = 0
  proc.stderr!.on('data', (d) => { err.text += d })
  proc.stdout!.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(line)
        waiting.get(m.id)?.(m)
      } catch { /* not a message */ }
    }
  })
  proc.stdin!.on('error', () => {})
  const exit = new Promise<number | null>((done) => proc.on('exit', (code) => done(code)))
  const raw: Raw = {
    err, proc, exit,
    req: (method, params) => new Promise((done, fail) => {
      const n = ++id
      waiting.set(n, done)
      exit.then((code) => setTimeout(() => fail(new Error(`stdio child exited (${code}) before answering ${method}`)), 1000))
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params === undefined ? {} : { params }) })}\n`)
    }),
    notify: (method) => { proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) },
    async init() {
      const r = await raw.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'r1a36c', version: '0.0.0' } })
      raw.notify('notifications/initialized')
      return r
    },
  }
  RAWS.push(raw)
  return raw
}
const toolText = (r: Json): Json => JSON.parse(r.result.content[0].text)

/** A stdio start that should refuse: its exit code and its stderr (ended after 20 s). */
function runOnce(env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', STDIO], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const out = { stderr: '', stdout: '' }
    p.stdout.on('data', (d) => { out.stdout += d })
    p.stderr.on('data', (d) => { out.stderr += d })
    const timer = setTimeout(() => { try { process.kill(-p.pid!, 'SIGTERM') } catch { /* gone */ } }, 20_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, ...out })
    })
  })
}

/** An owner harness object (as test/delivery-codex.test.ts builds one); `program` records its argv. */
function harness(name: string, extra: Record<string, unknown> = {}): Json {
  return {
    name, program: '/usr/bin/true', programPath: '/usr/bin/true', args: [], skip_prompts_args: [], resume: [], fork: [],
    has_prompts: false, delivery: 'hook', hook: '--config', hook_format: 'config-overrides',
    permission_hook: false, reports_context: false, source: 'owner', file: join(OWNER, `${name}.toml`), kind: 'agent', ...extra,
  }
}

const DETACHED_PID = join(OUT, 'detached.pid')
const SH = 'r1a36c-sh'
const HUBTOK = randomBytes(24).toString('base64url')

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  const codex = loadedHarnesses().get('r1a36c-codex')
  const plain = loadedHarnesses().get('r1a36c-plain')
  if (!sh || !plain) throw new Error('the shell or r1a36c-plain harness file did not load')
  const agents: Record<string, unknown> = { shell: agentEntry(sh), 'r1a36c-plain': agentEntry(plain) }
  if (codex) agents['r1a36c-codex'] = agentEntry(codex)
  // A file the loader refused (mcp_env at BASE) is left out, so the other rows still run.
  process.env.TANDEM_ENABLED_ENGINES = Object.keys(agents).join(',')
  writeLimits(TH, { folders: [WORK], shell: true, agents, interrupt_from: ['owner'] })
  limits.applyLimits()
  const opened = await rq('POST', '/sessions/open', { engine: 'shell', name: SH, cwd: WORK })
  if (opened.status !== 200) throw new Error(`open ${SH}: ${opened.status} ${JSON.stringify(opened.body)}`)
})

afterAll(async () => {
  delete process.env.TANDEM_HUB_LINK_TOKEN
  for (const r of RAWS) {
    try { process.kill(-r.proc.pid!, 'SIGTERM') } catch { /* gone */ }
  }
  // The detached server of (h5): by the group its start made (never the group of this process).
  const pid = Number(read(DETACHED_PID).trim())
  const pgid = pid > 1 ? pgidOf(pid) : undefined
  if (pgid !== undefined && pgid > 1 && pgid !== pgidOf(process.pid)) {
    try { process.kill(-pgid, 'SIGTERM') } catch { /* gone */ }
  }
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

describe('(h1) the harness field mcp_env', () => {
  const DIR = join(BOX, 'h1')
  mkdirSync(DIR)
  const base = (name: string) => `name = "${name}"\nprogram = "/usr/bin/true"\nhas_prompts = false\n`
  function load(files: Record<string, string>) {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR)
    for (const [name, extra] of Object.entries(files)) writeFileSync(join(DIR, `${name}.toml`), base(name) + extra)
    return loadHarnesses({ installDir: DIR, ownerDir: join(BOX, 'no-owner'), path: BIN })
  }
  const reasons = (r: ReturnType<typeof load>) => Object.fromEntries(r.errors.map((e) => [e.file.split('/').pop()!.slice(0, -5), e.reason]))

  it('(36C) (h1) "inherit", "config-overrides" (with a config-overrides hook) and "unknown" load with that value', () => {
    const r = load({ a: 'mcp_env = "inherit"\n', b: `${HOOKED}mcp_env = "config-overrides"\n`, c: 'mcp_env = "unknown"\n' })
    expect(r.errors).toEqual([])
    expect(r.harnesses.get('a')!.mcp_env).toBe('inherit')
    expect(r.harnesses.get('b')!.mcp_env).toBe('config-overrides')
    expect(r.harnesses.get('c')!.mcp_env).toBe('unknown')
  })

  it('(36C) (h1) "Inherit", 1 and "none" refuse the file with the exact text', () => {
    const r = load({ a: 'mcp_env = "Inherit"\n', b: 'mcp_env = 1\n', c: 'mcp_env = "none"\n', ok: '' })
    expect(reasons(r)).toEqual({
      a: 'bad mcp_env: "inherit", "config-overrides" or "unknown"',
      b: 'bad mcp_env: "inherit", "config-overrides" or "unknown"',
      c: 'bad mcp_env: "inherit", "config-overrides" or "unknown"',
    })
    expect([...r.harnesses.keys()]).toEqual(['ok'])
  })

  it('(36C) (h1) "config-overrides" with a settings-file hook or no hook refuses with the exact text; absent = no mcp_env key', () => {
    const r = load({
      a: 'delivery = "hook"\nhook = "--settings"\nhook_format = "settings-file"\nmcp_env = "config-overrides"\n',
      b: 'mcp_env = "config-overrides"\n',
      c: 'delivery = "hook"\nhook = "--settings"\nmcp_env = "config-overrides"\n',
      d: HOOKED,
    })
    const text = 'mcp_env "config-overrides" needs hook_format "config-overrides"'
    expect(reasons(r)).toEqual({ a: text, b: text, c: text })
    expect(r.harnesses.get('d')).not.toHaveProperty('mcp_env')
  })

  it('(36C) (h1) the built-in codex file loads config-overrides, claude inherit (V4), every other built-in none', () => {
    const r = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, 'no-owner'), path: BIN })
    expect(r.errors).toEqual([])
    expect(r.harnesses.get('codex')!.mcp_env).toBe('config-overrides')
    expect(r.harnesses.get('claude')!.mcp_env).toBe('inherit')
    for (const [name, h] of r.harnesses) if (name !== 'codex' && name !== 'claude') expect(h, name).not.toHaveProperty('mcp_env')
  })
})

describe('(h2) mcpOverrides', () => {
  it('(36C) (h2) a config-overrides harness: 6 elements, --config at even indexes, TOML values for command, args, env_vars; no secret value', () => {
    const callerValue = randomBytes(32).toString('base64url')
    process.env.TANDEM_CALLER_TOKEN = callerValue
    process.env.TANDEM_HUB_LINK_TOKEN = HUBTOK
    let out: string[]
    try {
      out = dh.mcpOverrides(harness('r1a36c-h2', { mcp_env: 'config-overrides' }))
    } finally {
      delete process.env.TANDEM_CALLER_TOKEN
      delete process.env.TANDEM_HUB_LINK_TOKEN
    }
    expect(out.length).toBe(6)
    expect([out[0], out[2], out[4]]).toEqual(['--config', '--config', '--config'])
    const [command, args, envVars] = [out[1], out[3], out[5]].map((v) => parse(v!) as Json)
    expect(Object.keys(command.mcp_servers.tandem)).toEqual(['command'])
    expect(Object.keys(args.mcp_servers.tandem)).toEqual(['args'])
    expect(Object.keys(envVars.mcp_servers.tandem)).toEqual(['env_vars'])
    expect(command.mcp_servers.tandem.command).toBe(process.execPath)
    const a = args.mcp_servers.tandem.args as string[]
    expect(a.length).toBe(2)
    expect(a[0]).toBe('--experimental-strip-types')
    expect(a[1]!.startsWith('/') && a[1]!.endsWith('src/stdio-server.ts') && existsSync(a[1]!)).toBe(true)
    expect(envVars.mcp_servers.tandem.env_vars).toEqual(dh.MCP_ENV_NAMES)
    expect(dh.MCP_ENV_NAMES).toEqual([...dh.MCP_ENV_NAMES].sort())
    expect(dh.MCP_ENV_NAMES.includes('TANDEM_CALLER_TOKEN')).toBe(true)
    expect(out.some((v) => v.includes(callerValue) || v.includes(HUBTOK))).toBe(false)
  })

  it('(36C) (h2) an inherit, unknown or absent mcp_env gives []', () => {
    expect(dh.mcpOverrides(harness('x', { mcp_env: 'inherit' }))).toEqual([])
    expect(dh.mcpOverrides(harness('x', { mcp_env: 'unknown' }))).toEqual([])
    expect(dh.mcpOverrides(harness('x'))).toEqual([])
  })

  it('(36C) (h2) a stdio-server path holding a quote, or one that does not exist, throws', () => {
    // A copy of delivery-hooks.ts (its one value import stubbed) in a folder whose path holds `'`, then one with no src/stdio-server.ts.
    const copy = (root: string, withStdio: boolean) => {
      mkdirSync(join(root, 'bridge'), { recursive: true })
      writeFileSync(join(root, 'bridge', 'delivery-hooks.ts'), readFileSync(join(repo, 'bridge', 'delivery-hooks.ts')))
      writeFileSync(join(root, 'bridge', 'kill-switch.ts'), 'export const killSwitchOn = () => false\n')
      writeFileSync(join(root, 'bridge', 'tandem-home.ts'), readFileSync(join(repo, 'bridge', 'tandem-home.ts')))
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'legacy-env.ts'), readFileSync(join(repo, 'src', 'legacy-env.ts')))
      if (withStdio) writeFileSync(join(root, 'src', 'stdio-server.ts'), '')
      const code = `const m = await import(${JSON.stringify(pathToFileURL(join(root, 'bridge', 'delivery-hooks.ts')).href)});
try { m.mcpOverrides(${JSON.stringify(harness('x', { mcp_env: 'config-overrides' }))}); console.log('NO THROW') } catch { console.log('THREW') }`
      return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }).stdout.trim()
    }
    expect(copy(join(BOX, "it's"), true)).toBe('THREW')
    expect(copy(join(BOX, 'no-stdio'), false)).toBe('THREW')
    expect(copy(join(BOX, 'fine'), true)).toBe('NO THROW')
  })
})

describe('(h3) HarnessSession.spawn appends the MCP values after the hook values', () => {
  const REC = join(BIN, 'r1a36c-rec.sh')
  writeFileSync(REC, `#!/bin/sh\nout=$1\nshift\n: > "$out.tmp"\nfor a in "$@"; do printf '%s\\n' "$a" >> "$out.tmp"; done\nmv "$out.tmp" "$out"\nprintf 'fake36c>'\nexec sleep 600\n`, { mode: 0o755 })
  const STATES = { idle: ['fake36c>\\z'], debounce_ms: 200, precedence: ['waiting_for_approval', 'working', 'idle'] }
  async function argvOf(name: string, mcpEnv: string): Promise<{ argv: string[]; h: Json }> {
    const out = join(OUT, `${name}.argv`)
    const h = harness(name, { program: REC, programPath: REC, args: [out], states: STATES, mcp_env: mcpEnv })
    const s = await HarnessSession.spawn(h, { name, cwd: WORK, allowlist: [WORK] })
    try {
      await until(() => existsSync(out), 10_000)
      return { argv: read(out).split('\n').slice(0, -1), h }
    } finally {
      await s.close()
    }
  }

  it('(36C) (h3) config-overrides: the argv ends with the 10 hook values, then the 6 MCP values', async () => {
    const { argv, h } = await argvOf('r1a36c-h3a', 'config-overrides')
    const tail = argv.slice(-16)
    for (let i = 0; i < 16; i += 2) expect(tail[i]).toBe('--config')
    for (let i = 1; i < 10; i += 2) expect(tail[i]!.startsWith('hooks.')).toBe(true)
    expect(tail.slice(10)).toEqual(dh.mcpOverrides(h))
    expect(argv.filter((a) => a.startsWith('mcp_servers.')).length).toBe(3)
  })

  it('(36C) (h3) inherit: no MCP value', async () => {
    const { argv } = await argvOf('r1a36c-h3b', 'inherit')
    expect(argv.slice(-10).filter((a, i) => i % 2 === 1).every((a) => a.startsWith('hooks.'))).toBe(true)
    expect(argv.some((a) => a.includes('mcp_servers'))).toBe(false)
  })
})

describe('(h4) the token reaches the server through env_vars (a filtering agent)', () => {
  it('(36C) (h4) mcp_env "config-overrides": the stdio server it starts serves session:r1a36c-codex', async () => {
    process.env.TANDEM_HUB_LINK_TOKEN = HUBTOK // (h8): never on a command line
    const opened = await rq('POST', '/sessions/open', { engine: 'r1a36c-codex', name: 'r1a36c-codex', cwd: WORK })
    expect(opened.status).toBe(200)
    expect(await until(() => existsSync(join(OUT, 'r1a36c-codex.result')), 30_000)).toBe(true)
    expect(read(join(OUT, 'r1a36c-codex.env')).split('\n').includes('TANDEM_CALLER_TOKEN')).toBe(true)
    expect(mailRows('r1a36c-codex').map((r) => [r.from_id, r.to_name])).toEqual([['session:r1a36c-codex', 'w']])
    expect(read(join(OUT, 'r1a36c-codex.stderr')).includes('tandem stdio: caller session:r1a36c-codex\n')).toBe(true)
  })

  it('(36C) (h4) the same fake with no mcp_env: its stdio child, with the filtered list alone, exits 1 with the refusal; nothing stored as owner', async () => {
    const opened = await rq('POST', '/sessions/open', { engine: 'r1a36c-plain', name: 'r1a36c-plain', cwd: WORK })
    expect(opened.status).toBe(200)
    await until(() => existsSync(join(OUT, 'r1a36c-plain.exit')) || existsSync(join(OUT, 'r1a36c-plain.result')), 30_000)
    // At BASE this child starts as the owner and stores the mail from `owner`.
    expect(mailRows('r1a36c-plain').map((r) => r.from_id)).toEqual([])
    expect(read(join(OUT, 'r1a36c-plain.env')).split('\n').includes('TANDEM_CALLER_TOKEN')).toBe(false)
    expect(read(join(OUT, 'r1a36c-plain.exit'))).toBe('1')
    expect(serverLines(read(join(OUT, 'r1a36c-plain.stderr')))).toEqual([NO_TOKEN])
  })
})

describe('(h8) no token on any command line', () => {
  it('(36C) (h8) while the fake runs, no command line holds its session token or the hub-link token', () => {
    const tok = read(join(OUT, 'r1a36c-codex.tok'))
    expect(/^[A-Za-z0-9_-]{43}$/.test(tok)).toBe(true)
    expect(tokens.resolveCallerToken(tok) === 'r1a36c-codex').toBe(true)
    const lines = commandLines()
    expect(lines.some((l) => l.includes('mcp_servers.tandem.env_vars'))).toBe(true)
    expect(lines.some((l) => l.includes(tok))).toBe(false)
    expect(lines.some((l) => l.includes(HUBTOK))).toBe(false)
    delete process.env.TANDEM_HUB_LINK_TOKEN
  })
})

let ownerChild: Raw

describe('(h5) ancestry: a stdio server started inside a session with no token', () => {
  it('(36C) (h5) typed in a Tandem shell session with the token removed: exactly the no-token refusal line, exit 1', async () => {
    const err = join(OUT, 'h5.err')
    const rc = join(OUT, 'h5.rc')
    await typeIn(SH, `env -u TANDEM_CALLER_TOKEN NODE_NO_WARNINGS=1 ${process.execPath} --experimental-strip-types ${STDIO} </dev/null 2>${err}; echo $? >${rc}`)
    expect(await until(() => read(rc).trim() !== '', 30_000)).toBe(true)
    expect(read(rc).trim()).toBe('1')
    expect(read(err)).toBe(`${NO_TOKEN}\n`)
  })

  it('(36C) (h5) the test process starting the same server, outside any session: the owner, as at BASE', async () => {
    ownerChild = startRaw(childEnv())
    await ownerChild.init()
    const sent = toolText(await ownerChild.req('tools/call', { name: 'mail_send', arguments: { to: 'w', level: 'fyi', text: 'r1a36c-h5-owner' } }))
    expect(mailRows('r1a36c-h5-owner').map((r) => r.id === sent.id && r.from_id)).toEqual(['owner'])
    expect(ownerChild.err.text.includes('tandem stdio: caller')).toBe(false)
  })

  it('(36C) (h5) the stated limit: a start detached from the session (parent pid 1) is the owner', async () => {
    const err = join(OUT, 'detached.err')
    await typeIn(SH, `nohup sh -c "sleep 600 | env -u TANDEM_CALLER_TOKEN NODE_NO_WARNINGS=1 ${process.execPath} --experimental-strip-types ${STDIO} >/dev/null 2>${err} & echo \\$! >${DETACHED_PID}" >/dev/null 2>&1`)
    expect(await until(() => read(err).includes(READY), 30_000)).toBe(true)
    expect(read(err).includes(NO_TOKEN)).toBe(false)
    const pid = Number(read(DETACHED_PID).trim())
    expect(pid > 1).toBe(true)
    expect(await tokens.parentPidOf(pid)).toBe(1)
    expect(await tokens.insideTandemSession(pid)).toBeUndefined()
  })
})

describe('(h6) insideTandemSession', () => {
  it('(36C) (h6) a pane process gives its session name; so does a grandchild of it', async () => {
    const pane = panePid(SH)
    expect(pane > 1).toBe(true)
    expect(await tokens.insideTandemSession(pane)).toBe(SH)
    const gp = join(OUT, 'h6.gpid')
    await typeIn(SH, `sh -c 'sh -c "echo \\$\\$ >${gp}; exec sleep 120"; :' &`)
    expect(await until(() => read(gp).trim() !== '', 10_000)).toBe(true)
    const grandchild = Number(read(gp).trim())
    expect(await tokens.parentPidOf(await tokens.parentPidOf(grandchild))).toBe(pane)
    expect(await tokens.insideTandemSession(grandchild)).toBe(SH)
  })

  it('(36C) (h6) the test process: undefined; no tmux server on Tandem\'s socket: undefined', async () => {
    expect(await tokens.insideTandemSession(process.pid)).toBeUndefined()
    process.env.TANDEM_HOME = join(BOX, 'no-server')
    try {
      expect(await tokens.insideTandemSession(process.pid)).toBeUndefined()
    } finally {
      process.env.TANDEM_HOME = TH
    }
  })

  it('(36C) (h6) a parent id that cannot be read throws (a gone process; on macOS also a PATH with no ps)', async () => {
    const gone = spawnSync('true').pid!
    await expect(tokens.parentPidOf(gone)).rejects.toThrow()
    await expect(tokens.insideTandemSession(gone)).rejects.toThrow()
    if (process.platform === 'darwin') {
      const path = process.env.PATH
      const dirs = [dirname(execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()), dirname(process.execPath)]
      expect(dirs.some((d) => existsSync(join(d, 'ps')))).toBe(false)
      process.env.PATH = dirs.join(':')
      try {
        await expect(tokens.insideTandemSession(process.pid)).rejects.toThrow()
      } finally {
        process.env.PATH = path
      }
    }
  })

  it('(36C) (h6) a stdio start that cannot tell (tmux refused; on macOS also no ps): the "cannot tell" line, exit 1', async () => {
    const bad = join(BOX, 'bad-th')
    mkdirSync(join(bad, 'tmux'), { recursive: true })
    chmodSync(bad, 0o700)
    chmodSync(join(bad, 'tmux'), 0o755)
    const starts = [childEnv({ TANDEM_HOME: bad })]
    if (process.platform === 'darwin') {
      const dirs = [dirname(execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()), dirname(process.execPath)]
      starts.push(childEnv({ PATH: dirs.join(':') }))
    }
    for (const env of starts) {
      const r = await runOnce(env)
      expect(r.code).toBe(1)
      expect(serverLines(r.stderr)).toEqual([CANNOT_TELL])
      expect(r.stdout).toBe('')
    }
  })
})

describe('(audit) the ancestry rule fails closed', () => {
  it('(36C) (audit) typed in a Tandem shell session with the token removed and a PATH with no tmux: the "cannot tell" line, exit 1, never the owner', async () => {
    // An agent that starts its MCP servers with a bare environment (no token, no PATH to tmux) must not be the owner.
    const none = join(BOX, 'no-tmux-bin')
    mkdirSync(none)
    // macOS reads parent ids with ps: its folder, checked to hold no tmux. Linux reads /proc: an empty folder.
    const path = process.platform === 'linux' ? none : dirname(execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim())
    expect(existsSync(join(path, 'tmux'))).toBe(false)
    const err = join(OUT, 'audit-notmux.err')
    const rc = join(OUT, 'audit-notmux.rc')
    await typeIn(SH, `env -u TANDEM_CALLER_TOKEN PATH=${path} NODE_NO_WARNINGS=1 ${process.execPath} --experimental-strip-types ${STDIO} </dev/null 2>${err}; echo $? >${rc}`)
    expect(await until(() => read(rc).trim() !== '', 30_000)).toBe(true)
    expect(read(rc).trim()).toBe('1')
    expect(read(err)).toBe(`${CANNOT_TELL}\n`)
  })

  it('(36C) (audit) a process more than 64 parents below its pane cannot be told: throws, never undefined', async () => {
    const deep = join(BIN, 'deep.sh')
    writeFileSync(deep, `#!/bin/sh\nif [ "$1" -gt 0 ]; then "$0" $(($1 - 1)) "$2"; else echo $$ >"$2"; exec sleep 120; fi\n`, { mode: 0o755 })
    const file = join(OUT, 'audit-deep.pid')
    await typeIn(SH, `${deep} 70 ${file} &`)
    expect(await until(() => read(file).trim() !== '', 20_000)).toBe(true)
    await expect(tokens.insideTandemSession(Number(read(file).trim()))).rejects.toThrow()
  })
})

describe('(audit) the stated limit of another TANDEM_HOME', () => {
  it('(36C) (audit) typed in a session with the token removed and another TANDEM_HOME: the owner of that other home only (asserted, so the limit is visible)', async () => {
    const other = join(BOX, 'other-home')
    const err = join(OUT, 'audit-other.err')
    const rc = join(OUT, 'audit-other.rc')
    await typeIn(SH, `env -u TANDEM_CALLER_TOKEN TANDEM_HOME=${other} TANDEM_ENABLED_ENGINES=shell NODE_NO_WARNINGS=1 ${process.execPath} --experimental-strip-types ${STDIO} </dev/null 2>${err}; echo $? >${rc}`)
    expect(await until(() => read(rc).trim() !== '', 30_000)).toBe(true)
    expect(read(err)).toContain(READY)
    expect(read(err).includes('refusing to start')).toBe(false)
    // Its store is the other home's, never this one's.
    expect(existsSync(join(other, 'state.db'))).toBe(true)
  })
})

describe('(h7) the per-call recheck', () => {
  async function agentChild(name: string): Promise<Raw> {
    const opened = await rq('POST', '/sessions/open', { engine: 'shell', name, cwd: WORK })
    expect(opened.status).toBe(200)
    const tok = await tokenOf(name)
    expect(tokens.resolveCallerToken(tok) === name).toBe(true)
    const c = startRaw(childEnv({ TANDEM_CALLER_TOKEN: tok }))
    await c.init()
    const r = await c.req('tools/call', { name: 'list_sessions', arguments: {} })
    expect(r.error).toBeUndefined()
    expect(r.result.isError).toBeFalsy()
    return c
  }
  async function refused(c: Raw, name: string) {
    // initialize, tools/list and ping are not checked.
    expect((await c.req('tools/list')).result.tools.length > 0).toBe(true)
    expect((await c.req('ping')).result).toEqual({})
    const r = await c.req('tools/call', { name: 'list_sessions', arguments: {} })
    expect(r.error).toEqual({ code: -32001, message: ended(name) })
    expect(await c.exit).toBe(1)
    expect(serverLines(c.err.text).includes(stopping(name))).toBe(true)
  }

  it('(36C) (h7) closed through route(): the next tools/call is refused with the exact error, the line, exit 1', async () => {
    const c = await agentChild('r1a36c-h7a')
    expect((await rq('POST', '/sessions/r1a36c-h7a/close')).status).toBe(200)
    await refused(c, 'r1a36c-h7a')
  })

  it('(36C) (h7) ended by a plain kill-session on Tandem\'s socket (its row left): the same', async () => {
    const c = await agentChild('r1a36c-h7b')
    tmuxOut(['kill-session', '-t', '=ccm-r1a36c-h7b'])
    await refused(c, 'r1a36c-h7b')
  })

  it('(36C) (h7) its token row replaced by a new spawn of that name: the same', async () => {
    const c = await agentChild('r1a36c-h7c')
    // A new spawn of the name (close, then open): the session is there again, with a new token row.
    expect((await rq('POST', '/sessions/r1a36c-h7c/close')).status).toBe(200)
    const again = await rq('POST', '/sessions/open', { engine: 'shell', name: 'r1a36c-h7c', cwd: WORK })
    expect(again.status).toBe(200)
    expect(tmuxOut(['list-sessions', '-F', '#{session_name}']).split('\n').includes('ccm-r1a36c-h7c')).toBe(true)
    await refused(c, 'r1a36c-h7c')
  })

  it('(36C) (h7) an owner child keeps answering after an unrelated close', async () => {
    const opened = await rq('POST', '/sessions/open', { engine: 'shell', name: 'r1a36c-h7d', cwd: WORK })
    expect(opened.status).toBe(200)
    expect((await rq('POST', '/sessions/r1a36c-h7d/close')).status).toBe(200)
    const r = await ownerChild.req('tools/call', { name: 'list_sessions', arguments: {} })
    expect(r.error).toBeUndefined()
    expect(r.result.isError).toBeFalsy()
  })
})

describe('(h9) conformance: every harness file\'s mcp_env is on its line in SCHEMA.md', () => {
  it('(36C) (h9) the loaded mcp_env (absent = unknown) equals the value SCHEMA.md\'s section gives that file', () => {
    const schema = readFileSync(join(BUILTIN, 'SCHEMA.md'), 'utf8')
    const start = schema.indexOf("## How an agent's caller token reaches Tandem's MCP server")
    expect(start >= 0).toBe(true)
    const next = schema.indexOf('\n## ', start + 3)
    const section = schema.slice(start, next < 0 ? undefined : next)
    const listed: Record<string, string> = {}
    for (const m of section.matchAll(/^- `([a-z0-9-]+)\.toml`: `(inherit|config-overrides|unknown)`/gm)) listed[m[1]!] = m[2]!
    const files = readdirSync(BUILTIN).filter((f) => f.endsWith('.toml')).map((f) => f.slice(0, -5)).sort()
    expect(Object.keys(listed).sort()).toEqual(files)
    const r = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, 'no-owner'), path: BIN })
    for (const f of files) expect(r.harnesses.get(f)?.mcp_env ?? 'unknown', f).toBe(listed[f])
  })
})
