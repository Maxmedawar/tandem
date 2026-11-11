/**
 * Memory has one home computer, reached through the hub (U-R1A-23, gate A1.18).
 *
 * One local hub (`wrangler dev --local`) and two real bridges via ./hub-harness.ts: `alpha`, the
 * home (its store on), and `beta` (no store). Two src/stdio-server.ts agents: A on alpha's
 * database with no hub link, and B, beta's local MCP server, with no store and beta's hub link.
 * B's calls go to the hub and on to alpha; with alpha gone they answer memory_home_offline, and
 * with the hub gone, the cannot-reach body. Nothing B does opens a store on beta.
 * Skipped only when wrangler or tmux is missing.
 */
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CCM_FRAME_TYPES, CCM_TUNNEL_SUBPROTOCOL } from '../../hub/src/protocol.ts'
// The hub's WS_MAX_FRAME_BYTES (hub/src/frame-size.ts) is the same number; that file cannot be type-checked from here.
import { MAX_FRAME_BYTES as WS_MAX_FRAME_BYTES } from '../../bridge/hub-link.ts'
import {
  hub, LINK_TOKEN, missing, rand, repo, signIn, startBridge, startHub, stopBridge, stopHub, type Bridge,
} from './hub-harness.ts'

const FABRIC_TOOLS = [
  'project_create', 'project_list', 'project_get', 'project_archive',
  'room_post', 'room_read',
  'memory_remember', 'memory_search', 'memory_get', 'memory_forget', 'memory_promote',
]
const WAIT = 120_000
const OFFLINE = {
  error: 'memory_home_offline',
  message: 'memory home offline: the computer that holds memory is not connected to the hub',
}
const CANNOT_REACH = { error: 'memory_home_offline', message: 'memory home offline: this computer cannot reach the hub' }
const CONFLICT = {
  error: 'memory_home_conflict',
  machines: ['alpha', 'gamma'],
  message: 'more than one computer holds a memory store (alpha, gamma); turn the store off on all but one',
}
type Json = Record<string, any>

const folders: string[] = []
/** A database file in its own /tmp/r1a23-db- folder (removed in afterAll). */
function databasePath(): string {
  const folder = mkdtempSync('/tmp/r1a23-db-')
  folders.push(folder)
  return join(folder, 'fabric.sqlite3')
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
const ids = (answer: Json) => ((answer.records ?? []) as { id: string }[]).map((record) => record.id)

/** src/stdio-server.ts as its own process (own HOME, tmux dir, allowlist) with `extra` on top; close() ends that child only. */
async function startStdio(extra: Record<string, string>) {
  const base = mkdtempSync('/tmp/r1a23-stdio-')
  folders.push(base)
  mkdirSync(join(base, 'home'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: join(base, 'home'), TMUX_TMPDIR: base, TANDEM_CWD_ALLOWLIST: base, TANDEM_ENABLED_ENGINES: 'shell',
  }, extra)
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, env, stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'r1a23-stdio', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

async function connect(): Promise<Client> {
  const token = await signIn()
  const next = new Client({ name: 'r1a23-e2e', version: '0.0.0' })
  await next.connect(
    new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return next
}

/** The link route: POST <hub>/__tunnel/fabric-rpc<path>, the link token as bearer unless `init` says otherwise. */
async function route(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`${hub}/__tunnel/fabric-rpc${path}`, {
    method: 'POST',
    ...init,
    headers: { authorization: `Bearer ${LINK_TOKEN}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  })
  return { status: response.status, text: await response.text() }
}
const listBody = JSON.stringify({ input: {} })

/** A stand-in memory home: dials as `id` with memory_home=1; with `answer`, replies 200 with it to each request. */
async function fakeHome(id: string, answer?: unknown) {
  const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/__tunnel/connect?bridge_id=${id}&memory_home=1`, CCM_TUNNEL_SUBPROTOCOL, {
    headers: { Authorization: `Bearer ${LINK_TOKEN}` },
  })
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as { type: string; request_id?: string }
    if (answer === undefined || frame.type !== CCM_FRAME_TYPES.httpRequest) return
    ws.send(JSON.stringify({
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: frame.request_id,
      status_code: 200,
      headers: { 'content-type': ['application/json'] },
      body_base64: Buffer.from(JSON.stringify(answer), 'utf8').toString('base64'),
    }))
  })
  await once(ws, 'open')
  return {
    closed,
    // terminate, not close(): the local hub is slow to answer a client's close frame.
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      ws.terminate()
      await closed
    },
  }
}

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

const title = missing
  ? `memory home across computers (skipped: ${missing} missing)`
  : 'memory home across computers'

describe.skipIf(Boolean(missing))(title, () => {
  const alphaDb = databasePath()
  const bDb = databasePath()
  let alpha: Bridge | undefined
  let beta: Bridge | undefined
  let gamma: Bridge | undefined
  let agentA: Awaited<ReturnType<typeof startStdio>> | undefined
  let agentB: Awaited<ReturnType<typeof startStdio>> | undefined
  let hubClient: Client | undefined
  let routedMarker = ''
  let routedId = ''
  const A = () => agentA!.client
  const B = () => agentB!.client
  const betaStore = () => join(beta!.home, '.tandem', 'fabric', 'fabric.sqlite3')
  const noStoreOnBeta = () => {
    expect(existsSync(betaStore())).toBe(false)
    expect(existsSync(bDb)).toBe(false)
  }

  beforeAll(async () => {
    await startHub('/tmp/r1a23-')
    alpha = await startBridge('alpha', { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: alphaDb })
    beta = await startBridge('beta')
    agentA = await startStdio({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: alphaDb })
    agentB = await startStdio({
      TANDEM_HUB_LINK_URL: hub.replace(/^http/, 'ws'),
      TANDEM_HUB_LINK_TOKEN: LINK_TOKEN,
      TANDEM_HUB_LINK_ID: 'beta',
      CCM_FABRIC_DB_PATH: bDb,
    })
  }, 150_000)

  afterAll(async () => {
    for (const client of [hubClient, agentA?.client, agentB?.client]) await client?.close().catch(() => {})
    try {
      await Promise.all([stopBridge(alpha), stopBridge(beta), stopBridge(gamma)])
    } finally {
      await stopHub()
    }
  }, 30_000)

  it('(1) saved on A, found from B, forgotten on B: gone on A', async () => {
    const text = `r1a23 marker ${rand(12)}`
    const saved = await call(A(), 'memory_remember', { scope: 'user', kind: 'fact', text, importance: 0.5 })
    expect(saved.id).toEqual(expect.any(String))
    expect(ids(await call(B(), 'memory_search', { query: text }))).toContain(saved.id)
    expect((await call(B(), 'memory_forget', { id: saved.id })).error).toBeUndefined()
    const after = await call(A(), 'memory_search', { query: text })
    expect(after.error).toBeUndefined()
    expect(ids(after)).not.toContain(saved.id)
    const got = await call(A(), 'memory_get', { id: saved.id })
    expect(got).toEqual(expect.objectContaining({ error: expect.any(String) }))
  }, WAIT)

  it('(2) a project made from B is listed on A', async () => {
    const made = await call(B(), 'project_create', { displayName: `r1a23 ${rand(6)}` })
    expect(made.projectId).toEqual(expect.any(String))
    expect(await call(A(), 'project_list')).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: made.projectId })]))
  }, WAIT)

  it("(3) B's save lands in alpha's store; nothing is stored on beta", async () => {
    routedMarker = `r1a23 routed ${rand(12)}`
    const saved = await call(B(), 'memory_remember', { scope: 'user', kind: 'fact', text: routedMarker, importance: 0.5 })
    expect(saved.id).toEqual(expect.any(String))
    routedId = saved.id
    expect((await call(A(), 'memory_get', { id: routedId })).text).toBe(routedMarker)
    noStoreOnBeta()
  }, WAIT)

  it('(4) the hub lists the 11 tools and its memory_search finds the routed memory', async () => {
    hubClient = await connect()
    const listed = await names(hubClient)
    for (const name of FABRIC_TOOLS) expect(listed).toContain(name)
    expect(ids(await call(hubClient, 'memory_search', { query: routedMarker }))).toContain(routedId)
  }, WAIT)

  it('(5) a forged caller on the link route is replaced by the one owner', async () => {
    const text = `r1a23 forged ${rand(12)}`
    const forged = await route('/fabric/memory/remember', {
      body: JSON.stringify({
        caller: { ownerId: 'owner-' + '0'.repeat(64), deviceId: 'mcp-device-' + '0'.repeat(64), agentId: 'mcp-owner-' + '0'.repeat(64) },
        input: { scope: 'user', kind: 'fact', text, importance: 0.5 },
      }),
    })
    expect(forged.status).toBe(200)
    expect(forged.text).not.toMatch(/0{64}/)
    const id = (JSON.parse(forged.text) as Json).id
    expect(ids(await call(A(), 'memory_search', { query: text }))).toContain(id)
  }, WAIT)

  describe('(6) the link route answers', () => {
    it.each([
      ['a path outside /fabric/', () => route('/sessions', { body: listBody }), 404, 'not found'],
      ['the bearer plus ?token=x', () => route('/fabric/project/list?token=x', { body: listBody }), 401, 'unauthorized'],
      ['GET', () => route('/fabric/project/list', { method: 'GET' }), 405, 'method not allowed'],
      ['no bearer', () => fetch(`${hub}/__tunnel/fabric-rpc/fabric/project/list`, { method: 'POST', body: listBody }).then(async (r) => ({ status: r.status, text: await r.text() })), 401, 'unauthorized'],
      ['a wrong bearer', () => route('/fabric/project/list', { body: listBody, headers: { authorization: `Bearer ${'w'.repeat(32)}` } }), 401, 'unauthorized'],
      ['a body of WS_MAX_FRAME_BYTES + 1 bytes', () => route('/fabric/project/list', { body: 'x'.repeat(WS_MAX_FRAME_BYTES + 1) }), 413, '{"error":"payload_too_large"}'],
      ['a body that is not JSON', () => route('/fabric/project/list', { body: '{not json' }), 400, '{"error":"fabric_request_invalid"}'],
      ['a body with no input', () => route('/fabric/project/list', { body: '{"caller":{}}' }), 400, '{"error":"fabric_request_invalid"}'],
    ] as const)('%s', async (_label, request, status, text) => {
      expect(await request()).toEqual({ status, text })
    }, WAIT)

    it("project_list: 200 with the projects A lists", async () => {
      const answer = await route('/fabric/project/list', { body: listBody })
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.text)).toEqual(await call(A(), 'project_list'))
    }, WAIT)
  })

  it('(7) a second home (gamma) gives memory_home_conflict everywhere but A; gone again, B answers', async () => {
    gamma = await startBridge('gamma', { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: databasePath() })
    expect(await call(hubClient!, 'memory_search', { query: routedMarker })).toEqual(CONFLICT)
    expect(await call(B(), 'memory_search', { query: routedMarker })).toEqual(CONFLICT)
    expect(await route('/fabric/project/list', { body: listBody })).toEqual({ status: 409, text: JSON.stringify(CONFLICT) })
    expect(ids(await call(A(), 'memory_search', { query: routedMarker }))).toContain(routedId)
    await stopBridge(gamma)
    gamma = undefined
    await vi.waitFor(async () => {
      expect(ids(await call(B(), 'memory_search', { query: routedMarker }))).toContain(routedId)
    }, { timeout: 30_000, interval: 500 })
  }, WAIT)

  it('(8) home offline: B, the link route, the open hub session and a new one say memory home offline', async () => {
    await stopBridge(alpha)
    alpha = undefined
    await vi.waitFor(async () => {
      expect(await call(B(), 'memory_search', { query: routedMarker })).toEqual(OFFLINE)
    }, { timeout: 30_000, interval: 500 })
    expect(OFFLINE.message.startsWith('memory home offline')).toBe(true)
    expect(await route('/fabric/project/list', { body: listBody })).toEqual({ status: 503, text: JSON.stringify(OFFLINE) })
    expect(await call(hubClient!, 'memory_search', { query: routedMarker })).toEqual(OFFLINE)
    const fresh = await connect()
    try {
      const listed = await names(fresh)
      for (const name of FABRIC_TOOLS) expect(listed).toContain(name)
      expect(await call(fresh, 'memory_search', { query: routedMarker })).toEqual(OFFLINE)
    } finally {
      await fresh.close().catch(() => {})
    }
  }, WAIT)

  it('(9) the same home id dialing again replaces the older socket (close 4003), never a conflict', async () => {
    const first = await fakeHome('r1a23-dup', { from: 'first' })
    const second = await fakeHome('r1a23-dup', { from: 'second' })
    try {
      expect(await first.closed).toBe(4003)
      expect(await call(B(), 'memory_search', { query: routedMarker })).toEqual({ from: 'second' })
    } finally {
      await first.close()
      await second.close()
    }
  }, WAIT)

  it('(10) a home that never answers: the link route gives 504 gateway_timeout within 125 s', async () => {
    const slow = await fakeHome('r1a23-slow')
    try {
      const started = Date.now()
      expect(await route('/fabric/project/list', { body: listBody })).toEqual({ status: 504, text: '{"error":"gateway_timeout"}' })
      expect(Date.now() - started).toBeLessThan(125_000)
    } finally {
      await slow.close()
    }
  }, 150_000)

  it('(11) hub stopped: B gets the cannot-reach body; still nothing stored on beta', async () => {
    await stopHub()
    expect(await call(B(), 'memory_search', { query: routedMarker })).toEqual(CANNOT_REACH)
    noStoreOnBeta()
  }, WAIT)
})
