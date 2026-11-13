/**
 * U-R1A-44, gate A4.28: one computer with no hub set. Local MCP, sessions, mail, memory, transcript
 * search and `tandem status` all work, and nothing leaves 127.0.0.1.
 *
 * One real src/server.ts bridge with TANDEM_HUB_LINK_URL, TANDEM_HUB_LINK_TOKEN and
 * TANDEM_HUB_LINK_ID unset, a temp HOME and TANDEM_HOME under one /tmp/r1a44-lo- folder, Tandem's own
 * tmux socket there, the memory store on, and a limits file written by test/fixtures/limits.ts.
 * Local MCP is src/stdio-server.ts on the same TANDEM_HOME (the owner's, and one with a session's
 * own caller token). Sessions are the shell harness (`sh`, no agent sign-in) and, for transcript
 * search only, the built-in claude harness pointed at a fake `claude` script that writes one
 * history line and draws an idle prompt box (no real agent ever starts). No hub is started.
 * Skipped only when tmux is missing. afterAll ends the bridge, every tmux server under the folder,
 * and removes it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, rand, repo } from './hub-harness.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const hasTmux = spawnSync('tmux', ['-V']).status === 0
const WAIT = 60_000
const BOX = realpathSync(mkdtempSync('/tmp/r1a44-lo-'))
const HOME = join(BOX, 'home')
const TH = join(BOX, 'tandem')
const WORK = join(BOX, 'work')
const PROJ = join(WORK, 'proj')
const BIN = join(BOX, 'bin')
const SOCK = join(TH, 'tmux', 'tandem')
const MARK = `r1a44${rand(8)}`

let env: NodeJS.ProcessEnv = {}
let bridge: ChildProcess | undefined
let bridgeErr = ''
const clients: Client[] = []
let ownerClient: Client | undefined
/** The owner's local MCP client, one for the whole file: a session is driven by the process that opened it. */
const ownerMcp = async () => (ownerClient ??= await localMcp())

/** A local MCP client: src/stdio-server.ts on this TANDEM_HOME; `token` makes it that session's agent. */
async function localMcp(token?: string): Promise<Client> {
  const childEnv = { ...env } as Record<string, string>
  if (token !== undefined) childEnv.TANDEM_CALLER_TOKEN = token
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', join(repo, 'src', 'stdio-server.ts')],
    cwd: repo,
    env: childEnv,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'r1a44-local', version: '0.0.0' })
  await client.connect(transport)
  clients.push(client)
  return client
}

/** One tool call; the JSON body of its text answer. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: WAIT })) as Json
  const text = result.content?.[0]?.text ?? ''
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

/** Sends `text`, then polls with empty text until the session's output holds `want` (or the time is up). */
async function sendUntil(client: Client, name: string, text: string, want: RegExp): Promise<string> {
  let seen = JSON.stringify(await call(client, 'send_to_session', { name, text }))
  const end = Date.now() + WAIT
  while (!want.test(seen) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300))
    seen += JSON.stringify(await call(client, 'send_to_session', { name, text: '' }))
  }
  return seen
}

beforeAll(async () => {
  if (!hasTmux) return
  for (const dir of [HOME, TH, PROJ, BIN, join(BOX, 'tmux'), join(BOX, 'oauth'), join(BOX, 'fabric')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The fake `claude`: one history line where Claude Code keeps it (<HOME>/.claude/projects/<slug of
  // its folder>/<id>.jsonl), then the idle prompt box, then it waits. It never reads a model.
  writeFileSync(join(BIN, 'claude'), [
    '#!/bin/sh',
    'dir="$HOME/.claude/projects/$(pwd -P | sed \'s/[^A-Za-z0-9]/-/g\')"',
    'mkdir -p "$dir"',
    `printf '%s\\n' '{"type":"user","message":{"content":"${MARK} seeded transcript line"}}' > "$dir/11111111-2222-3333-4444-555555555555.jsonl"`,
    'rule=$(printf "%040d" 0 | tr 0 "─")',
    'printf "%s\\n❯ \\n%s\\n" "$rule" "$rule"',
    'exec cat >/dev/null',
    '',
  ].join('\n'), { mode: 0o755 })
  env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME,
    PATH: `${BIN}:${process.env.PATH ?? ''}`,
    TMUX_TMPDIR: join(BOX, 'tmux'),
    SHELL: '/bin/sh',
    TANDEM_HOME: TH,
    TANDEM_PORT: String(await freePort()),
    TANDEM_PUBLIC_URL: 'https://r1a44.example/mcp',
    TANDEM_ISSUER_URL: 'https://r1a44.example',
    TANDEM_OWNER_PASSWORD: rand(32),
    TANDEM_OAUTH_STATE_DIR: join(BOX, 'oauth'),
    TANDEM_ENABLED_ENGINES: 'shell,claude',
    TANDEM_CWD_ALLOWLIST: WORK,
    TANDEM_FABRIC_ENABLED: '1',
    TANDEM_FABRIC_DB_PATH: join(BOX, 'fabric', 'fabric.sqlite3'),
    TANDEM_WAIT_MS: '8000',
  })
  for (const key of ['TANDEM_HUB_LINK_URL', 'TANDEM_HUB_LINK_TOKEN', 'TANDEM_HUB_LINK_ID']) expect(env[key]).toBeUndefined()
  // The limits file: the work folder, the shell, and the two pinned programs.
  const { agentEntry, writeLimits } = await import('../fixtures/limits.ts')
  const { loadHarnesses } = await import('../../bridge/harness-registry.ts')
  const loaded = loadHarnesses({ ownerDir: join(TH, 'harnesses'), path: env.PATH ?? '' }).harnesses
  writeLimits(TH, { folders: [WORK], shell: true, agents: { shell: agentEntry(loaded.get('shell')!), claude: agentEntry(loaded.get('claude')!) } })

  bridge = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  bridge.stdout!.on('data', () => {})
  bridge.stderr!.on('data', (chunk: Buffer) => { bridgeErr += chunk.toString() })
  const end = Date.now() + WAIT
  while (!bridgeErr.includes('listening on loopback port') && bridge.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
  if (!bridgeErr.includes('listening on loopback port')) throw new Error(`the bridge did not start:\n${bridgeErr}`)
}, 120_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  if (bridge?.pid !== undefined && bridge.exitCode === null) {
    try {
      process.kill(-bridge.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  spawnSync('chmod', ['-R', 'u+w', BOX])
  rmSync(BOX, { recursive: true, force: true })
}, 60_000)

describe.skipIf(!hasTmux)('(44) A4.28 one computer, no hub set', () => {
  const A = `r1a44-a-${rand(4)}`
  const B = `r1a44-b-${rand(4)}`

  it('(44) L1 a shell session opens through local MCP, takes a line and shows its output', async () => {
    const owner = await ownerMcp()
    const opened = await call(owner, 'open_session', { name: A, engine: 'shell', cwd: WORK })
    expect(opened.name, JSON.stringify(opened)).toBe(A)
    const seen = await sendUntil(owner, A, `echo ${MARK}-$((6*7))`, new RegExp(`${MARK}-42`))
    expect(seen).toContain(`${MARK}-42`)
    const listed = JSON.stringify(await call(owner, 'list_sessions'))
    expect(listed).toContain(A)
  }, 120_000)

  it('(44) L2 mail from one local session to another is in the second inbox, sent by the first', async () => {
    const owner = await ownerMcp()
    expect((await call(owner, 'open_session', { name: B, engine: 'shell', cwd: WORK })).name).toBe(B)
    // A's own caller token, from its own environment (the agent's path to its stdio server).
    const seen = await sendUntil(owner, A, 'echo "tok:${TANDEM_CALLER_TOKEN}:end"', /tok:[A-Za-z0-9_-]{16,}:end/)
    const got = seen.match(/tok:([A-Za-z0-9_-]{16,}):end/)
    expect(got, seen.slice(-2000)).not.toBeNull()
    const token = got![1]!
    const agentA = await localMcp(token)
    const sent = await call(agentA, 'mail_send', { to: B, level: 'fyi', text: `${MARK} mail` })
    expect(sent.to, JSON.stringify(sent)).toBe(B)
    const inbox = await call(owner, 'mail_read', { name: B })
    expect(JSON.stringify(inbox.messages)).toContain(`${MARK} mail`)
    expect(inbox.messages.find((m: Json) => JSON.stringify(m).includes(`${MARK} mail`)).from).toBe(`session:${A}`)
  }, 120_000)

  it('(44) L3 memory: remember, then recall by search', async () => {
    const owner = await ownerMcp()
    const kept = await call(owner, 'memory_remember', { scope: 'user', kind: 'fact', text: `${MARK} remembered fact`, importance: 0.5 })
    expect(JSON.stringify(kept)).not.toMatch(/"error"/)
    const found = JSON.stringify(await call(owner, 'memory_search', { query: `${MARK} remembered`, scope: 'user' }))
    expect(found).toContain(`${MARK} remembered fact`)
  }, 120_000)

  it('(44) L4 transcript search finds a seeded history line of a session Tandem started', async () => {
    const owner = await ownerMcp()
    const C = `r1a44-c-${rand(4)}`
    const opened = await call(owner, 'open_session', { name: C, engine: 'claude', cwd: PROJ })
    expect(opened.name, JSON.stringify(opened)).toBe(C)
    const end = Date.now() + WAIT
    let found: Json = {}
    while (Date.now() < end) {
      found = await call(owner, 'transcript_search', { query: MARK, project: PROJ })
      if (found.results?.length) break
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(found.results?.length, JSON.stringify(found)).toBeGreaterThan(0)
    expect(found.results[0].session).toBe(C)
    expect(JSON.stringify(found.results[0])).toContain(`${MARK} seeded transcript line`)
  }, 120_000)

  it('(44) L5 `tandem status --json` lists the session', () => {
    const inst = join(BOX, 'inst')
    mkdirSync(join(inst, 'bin'), { recursive: true })
    copyFileSync(join(repo, 'packaging', 'tandem'), join(inst, 'bin', 'tandem'))
    if (!existsSync(join(inst, 'runtime'))) symlinkSync(repo, join(inst, 'runtime'))
    const r = spawnSync('sh', [join(inst, 'bin', 'tandem'), 'status', '--json'], { encoding: 'utf8', env: { ...env, TANDEM_NODE: process.execPath }, timeout: 30_000 })
    expect(r.status, r.stderr).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.runtime).toBe('running')
    const mine = doc.computers.find((c: Json) => c.self)
    expect(mine.sessions.map((s: Json) => s.name)).toContain(A)
  }, 60_000)

  it('(44) L6 no connection leaves 127.0.0.1: the bridge never dials a hub', () => {
    expect(bridge?.exitCode).toBeNull()
    expect(bridgeErr).not.toMatch(/hub link/i)
    const pid = bridge!.pid!
    const remote: string[] = []
    if (spawnSync('lsof', ['-v']).error === undefined) {
      const r = spawnSync('lsof', ['-a', '-p', String(pid), '-i', '-n', '-P'], { encoding: 'utf8' })
      for (const line of r.stdout.split('\n').slice(1).filter(Boolean)) {
        const name = line.split(/\s+/).slice(8).join(' ')
        for (const end of name.replace(/\s*\(.*\)$/, '').split('->')) if (!/^(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(end)) remote.push(name)
      }
      expect(r.stdout, 'lsof saw no listener of the bridge').toMatch(/LISTEN/)
    } else {
      // No lsof (a slim Linux image): the bridge's socket inodes against the kernel's TCP tables.
      const inodes = new Set(readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { return '' } })
        .map((l) => l.match(/^socket:\[(\d+)\]$/)?.[1]).filter(Boolean))
      // 127.0.0.1, ::1 and ::ffff:127.0.0.1 as the kernel writes them.
      const loop = (hex: string) => /^(0100007F|0{24}01000000|0{16}FFFF00000100007F):/i.test(hex)
      let rows = 0
      for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        if (!existsSync(table)) continue
        for (const row of readFileSync(table, 'utf8').split('\n').slice(1).filter(Boolean)) {
          const f = row.trim().split(/\s+/)
          if (!inodes.has(f[9]!)) continue
          rows++
          if (!loop(f[1]!) || (f[3] !== '0A' && !loop(f[2]!))) remote.push(row.trim())
        }
      }
      expect(rows, 'no socket of the bridge was found').toBeGreaterThan(0)
    }
    expect(remote).toEqual([])
  })
})
