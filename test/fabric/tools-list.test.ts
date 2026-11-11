/**
 * The room, memory and project tools are listed and answer in the local MCP server
 * and at the hub when the bridge's fabric store is on; with it off only the session
 * tools are listed.
 *
 * Local half: buildMcpServer with a host on a temporary database, over an in-memory
 * transport. Hub half: one local hub (`wrangler dev --local`) and one real bridge,
 * `alpha`, via ../e2e/hub-harness.ts, and a src/stdio-server.ts child on the same database
 * file (two processes, one SQLite file); skipped when wrangler or tmux is missing.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMcpServer } from '../../src/mcp-server.ts'
import { createLocalFabricHost, type LocalFabricHost } from '../../bridge/fabric/local-fabric-host.ts'
import {
  hub, missing, repo, signIn, startBridge, startHub, stopBridge, stopHub, type Bridge,
} from '../e2e/hub-harness.ts'
import { LINK_TOKEN } from '../e2e/hub-harness.ts'
import { openDeviceKey } from '../../bridge/device-keys.ts'
import { initRoster } from '../../bridge/roster.ts'
import { rosterHub } from '../../bridge/roster-hub.ts'

const SESSION_TOOLS = ['open_session', 'list_sessions', 'send_to_session', 'interrupt_session', 'close_session', 'relay', 'list_devices']
const FABRIC_TOOLS = [
  'project_create', 'project_list', 'project_get', 'project_archive',
  'room_post', 'room_read',
  'memory_remember', 'memory_search', 'memory_get', 'memory_forget', 'memory_promote',
]
const WAIT = 120_000
type Json = Record<string, any>

const folders: string[] = []
/** A database file in its own /tmp/r1a22-db- folder (removed in afterAll). */
function databasePath(): string {
  const folder = mkdtempSync('/tmp/r1a22-db-')
  folders.push(folder)
  return join(folder, 'fabric.sqlite3')
}
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

async function openHost(path: string): Promise<LocalFabricHost> {
  const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: path })
  if (!host) throw new Error('no fabric host')
  return host
}

async function localClient(host?: LocalFabricHost) {
  const server = await buildMcpServer(undefined, host)
  const client = new Client({ name: 'r1a22-local', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/** One tool call: its JSON answer, or what went wrong at the MCP layer. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: WAIT })
    const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ''
    if (result.isError) return { toolError: text }
    return JSON.parse(text) as Json
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort()

/** src/stdio-server.ts as its own process on `path` (own HOME, tmux dir, allowlist); close() ends that child only. */
async function startStdio(path: string) {
  const base = mkdtempSync('/tmp/r1a22-stdio-')
  folders.push(base)
  mkdirSync(join(base, 'home'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: join(base, 'home'), TMUX_TMPDIR: base, TANDEM_CWD_ALLOWLIST: base, TANDEM_ENABLED_ENGINES: 'shell',
    CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: path,
  })
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, env, stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'r1a22-stdio', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

describe('local MCP server', () => {
  it('with a fabric host: the 7 session tools plus the 11 fabric tools; a post reads back', async () => {
    const host = await openHost(databasePath())
    const local = await localClient(host)
    try {
      expect(await names(local.client)).toEqual([...SESSION_TOOLS, ...FABRIC_TOOLS].sort())

      const project = await call(local.client, 'project_create', { displayName: 'r1a22 local' })
      expect(project.projectId).toEqual(expect.any(String))
      const memory = await call(local.client, 'memory_remember', {
        projectId: project.projectId, scope: 'project', kind: 'fact', text: 'local memory', importance: 0.5,
      })
      expect(memory.error).toBeUndefined()
      expect(memory.id).toEqual(expect.any(String))
      const posted = await call(local.client, 'room_post', {
        projectId: project.projectId, room: 'main', type: 'message', body: 'hello from local', idempotencyKey: 'r1a22-local-1',
      })
      expect(posted.error).toBeUndefined()
      const read = await call(local.client, 'room_read', { projectId: project.projectId, room: 'main' })
      expect((read.events as { body: string }[]).map((event) => event.body)).toEqual(['hello from local'])
    } finally {
      await local.close()
      host.close()
    }
  })

  it('with no host: exactly the 7 session tools', async () => {
    const local = await localClient()
    try {
      expect(await names(local.client)).toEqual([...SESSION_TOOLS].sort())
    } finally {
      await local.close()
    }
  })
})

const title = missing
  ? `hub tool list with the fabric store on and off (skipped: ${missing} missing)`
  : 'hub tool list with the fabric store on and off'

describe.skipIf(Boolean(missing))(title, () => {
  const dbPath = databasePath()
  // U-R1A-31B: alpha's TANDEM_HOME (and so its device key) outlives its bridge folder, so the
  // restarted alpha is the same computer to the hub, which binds the id to the first key.
  const alphaHome = mkdtempSync('/tmp/r1a22-alpha-')
  folders.push(alphaHome)
  let alpha: Bridge | undefined
  let client: Client | undefined
  let projectId = ''

  async function connect(): Promise<Client> {
    const token = await signIn()
    const next = new Client({ name: 'r1a22-e2e', version: '0.0.0' })
    await next.connect(
      new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    return next
  }

  beforeAll(async () => {
    await startHub('/tmp/r1a22-')
    alpha = await startBridge('alpha', { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: dbPath, TANDEM_HOME: alphaHome })
    // U-R1A-31C-1: the hub sends memory calls only to a home in the roster it holds: alpha starts it.
    const alphaKey = openDeviceKey({ path: join(alphaHome, 'keys', 'device.key') })
    const savedHome = process.env.TANDEM_HOME
    process.env.TANDEM_HOME = alphaHome
    try {
      initRoster(alphaKey, 'alpha')
    } finally {
      if (savedHome === undefined) delete process.env.TANDEM_HOME
      else process.env.TANDEM_HOME = savedHome
    }
    const roster = readFileSync(join(alphaHome, 'roster', 'roster.json'), 'utf8')
    if (!(await rosterHub({ url: hub, token: LINK_TOKEN, bridgeId: 'alpha' }, alphaKey).put(0, roster)).ok) throw new Error('roster put refused')
    client = await connect()
  }, 150_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    try {
      await stopBridge(alpha)
    } finally {
      await stopHub()
    }
  }, 30_000)

  it('lists the 11 fabric tools beside the session tools', async () => {
    const listed = await names(client!)
    for (const name of FABRIC_TOOLS) expect(listed).toContain(name)
    expect(listed).toContain('list_sessions')
    expect(listed).toContain('open_session')
  }, WAIT)

  it('project_create, memory_remember and room_post answer with no error', async () => {
    const project = await call(client!, 'project_create', { displayName: 'r1a22 hub' })
    expect(project.error).toBeUndefined()
    expect(project.projectId).toEqual(expect.any(String))
    projectId = project.projectId
    const memory = await call(client!, 'memory_remember', {
      projectId, scope: 'project', kind: 'fact', text: 'hub memory', importance: 0.5,
    })
    expect(memory.error).toBeUndefined()
    expect(memory.id).toEqual(expect.any(String))
    const posted = await call(client!, 'room_post', {
      projectId, room: 'main', type: 'message', body: 'hello from the hub', idempotencyKey: 'r1a22-hub-1',
    })
    expect(posted.error).toBeUndefined()
    expect(posted.id).toEqual(expect.any(String))
  }, WAIT)

  it('a stdio server on the same file: both processes write and read, the file stays sound, a write blocked past busy_timeout answers fabric_unavailable', async () => {
    const stdio = await startStdio(dbPath)
    const post = (to: Client, body: string) =>
      call(to, 'room_post', { projectId, room: 'main', type: 'message', body, idempotencyKey: `r1a22-${body.replace(/ /g, '-')}` })
    try {
      expect(await call(stdio.client, 'project_list')).toEqual(expect.arrayContaining([expect.objectContaining({ projectId })]))
      expect((await post(stdio.client, 'hello from stdio')).error).toBeUndefined()
      const read = await call(client!, 'room_read', { projectId, room: 'main' })
      expect((read.events as { body: string }[]).map((event) => event.body)).toEqual(['hello from the hub', 'hello from stdio'])
      const check = new DatabaseSync(dbPath)
      try {
        expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      } finally {
        check.close()
      }

      // A third connection holds the write lock: both entry points wait out busy_timeout (5 s), then answer.
      const blocker = new DatabaseSync(dbPath)
      blocker.exec('BEGIN IMMEDIATE')
      const started = Date.now()
      try {
        const [viaHub, viaStdio] = await Promise.all([post(client!, 'blocked hub'), post(stdio.client, 'blocked stdio')])
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)
        expect(viaHub).toEqual({ error: 'fabric_unavailable' })
        expect(viaStdio).toEqual({ error: 'fabric_unavailable' })
      } finally {
        blocker.exec('ROLLBACK')
        blocker.close()
      }
      expect((await post(stdio.client, 'after the lock')).error).toBeUndefined()
      expect((await post(client!, 'after the lock hub')).error).toBeUndefined()
    } finally {
      await stdio.close()
    }
  }, WAIT)

  it("the local server on the same database lists the hub's project (one owner from both surfaces)", async () => {
    await client?.close().catch(() => {})
    client = undefined
    await stopBridge(alpha)
    alpha = undefined
    const host = await openHost(dbPath)
    const local = await localClient(host)
    try {
      const projects = await call(local.client, 'project_list')
      expect(projects).toEqual(expect.arrayContaining([expect.objectContaining({ projectId })]))
    } finally {
      await local.close()
      host.close()
    }
  }, WAIT)

  it('alpha restarted without the fabric store: a new session still lists the 11 fabric tools and project_list answers memory_home_offline; the session tools stay', async () => {
    alpha = await startBridge('alpha', { TANDEM_HOME: alphaHome })
    client = await connect()
    const listed = await names(client)
    for (const name of FABRIC_TOOLS) expect(listed).toContain(name)
    expect((await call(client, 'project_list')).error).toBe('memory_home_offline')
    for (const name of ['list_sessions', 'open_session', 'send_to_session', 'list_machines']) expect(listed).toContain(name)
  }, WAIT)
})
