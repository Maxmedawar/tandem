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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CCM_FRAME_TYPES, CCM_TUNNEL_SUBPROTOCOL } from '../../hub/src/protocol.ts'
// The hub's WS_MAX_FRAME_BYTES (hub/src/frame-size.ts) is the same number; that file cannot be type-checked from here.
import { hubProofHeader, MAX_FRAME_BYTES as WS_MAX_FRAME_BYTES } from '../../bridge/hub-link.ts'
import { openDeviceKey, type DeviceKey } from '../../bridge/device-keys.ts'
import { fabricCallerFor } from '../../src/fabric/mcp-tools.ts'
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

/**
 * U-R1A-31B: the hub admits a link request only with a `tandem-proof` by the key bound to its id
 * (the first key to dial under it). `keyIn(home)` is the device key of the computer whose HOME is
 * `home` (<home>/.tandem/keys/device.key, made on first use, as its bridge and stdio server use
 * it); `sameComputer` puts one computer's key in another HOME, as two processes on one computer
 * share it. `linkAs` is who the link-route helpers prove they are: an id already bound on the
 * tunnel, with its key. `standIn` signs every stand-in computer's dial.
 */
const keyIn = (home: string): DeviceKey => openDeviceKey({ path: join(home, '.tandem', 'keys', 'device.key') })
function sameComputer(from: string, to: string): void {
  const keys = join(to, '.tandem', 'keys')
  mkdirSync(keys, { recursive: true, mode: 0o700 })
  copyFileSync(join(from, '.tandem', 'keys', 'device.key'), join(keys, 'device.key'))
  chmodSync(join(keys, 'device.key'), 0o600)
}
const standInHome = mkdtempSync('/tmp/r1a23-key-')
folders.push(standInHome)
const standIn = keyIn(standInHome)
let linkAs: { id: string; key: DeviceKey } | undefined
/** The proof for one link-route request: POST `path` (its query left out) over `body`. */
const linkProof = (path: string, body?: string, method = 'POST') =>
  hubProofHeader(linkAs!.key, { url: hub, method, path: new URL(`${hub}/__tunnel/fabric-rpc${path}`).pathname, id: linkAs!.id, body })

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
  return { client, home: join(base, 'home'), close: () => client.close() }
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
    headers: {
      authorization: `Bearer ${LINK_TOKEN}`,
      'content-type': 'application/json',
      'tandem-proof': linkProof(path, init.body as string | undefined, init.method ?? 'POST'),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  return { status: response.status, text: await response.text() }
}
const listBody = JSON.stringify({ input: {} })

/**
 * A stand-in computer on the hub link: dials as `id`, as the memory home unless `home` is false.
 * With `answer` it replies 200 to each request with it (a function gets the request frame),
 * after `delayMs`; without, it never replies. `requests` is every request frame it was sent.
 */
async function fakeHome(id: string, answer?: unknown, { home = true, key = standIn }: { home?: boolean; key?: DeviceKey } = {}) {
  const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/__tunnel/connect?bridge_id=${id}${home ? '&memory_home=1' : ''}`, CCM_TUNNEL_SUBPROTOCOL, {
    headers: { Authorization: `Bearer ${LINK_TOKEN}`, 'tandem-proof': hubProofHeader(key, { url: hub, method: 'GET', path: '/__tunnel/connect', id }) },
  })
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  const stand = {
    requests: [] as Json[],
    delayMs: 0,
    closed,
    /** A clean close frame, not waited for: the hub sees this computer leave. */
    drop: () => ws.close(1000),
    // terminate, not close(): the local hub is slow to answer a client's close frame.
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      ws.terminate()
      await closed
    },
  }
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as Json
    if (frame.type !== CCM_FRAME_TYPES.httpRequest) return
    stand.requests.push(frame)
    if (answer === undefined) return
    const reply = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        type: CCM_FRAME_TYPES.httpResponse,
        request_id: frame.request_id,
        status_code: 200,
        headers: { 'content-type': ['application/json'] },
        body_base64: Buffer.from(JSON.stringify(typeof answer === 'function' ? answer(frame) : answer), 'utf8').toString('base64'),
      }))
    }
    if (stand.delayMs > 0) setTimeout(reply, stand.delayMs)
    else reply()
  })
  await once(ws, 'open')
  return stand
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
    linkAs = { id: 'beta', key: keyIn(beta.home) }
    agentA = await startStdio({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: alphaDb })
    agentB = await startStdio({
      TANDEM_HUB_LINK_URL: hub.replace(/^http/, 'ws'),
      TANDEM_HUB_LINK_TOKEN: LINK_TOKEN,
      TANDEM_HUB_LINK_ID: 'beta',
      CCM_FABRIC_DB_PATH: bDb,
    })
    sameComputer(beta.home, agentB.home)
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

/* ---- U-R1A-23-R1 (audit): the link route, the caller and the home rules, against stand-in homes ---- */

const CAP = WS_MAX_FRAME_BYTES
const bearer = { authorization: `Bearer ${LINK_TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What a stand-in home saw of one call, sent back as its answer. */
const echo = (frame: Json) => ({
  path: frame.path,
  query: frame.raw_query ?? null,
  headers: Object.keys(frame.headers ?? {}).sort(),
  trust: frame.trusted_surface ?? null,
  body: JSON.parse(Buffer.from(frame.body_base64 ?? '', 'base64').toString('utf8')) as Json,
})

/** One raw POST to the link route whose body `send` writes (a write before end() sends it chunked, with no length): the hub's answer, or 'no answer' after 10 s. */
function raw(path: string, headers: Record<string, string>, send: (request: ClientRequest) => void) {
  return new Promise<{ status: number; text: string } | 'no answer'>((resolve) => {
    const request = httpRequest(`${hub}/__tunnel/fabric-rpc${path}`, { method: 'POST', headers }, (response) => {
      let text = ''
      response.on('data', (chunk: Buffer) => { text += chunk.toString() })
      response.on('end', () => {
        clearTimeout(timer)
        request.destroy()
        resolve({ status: response.statusCode ?? 0, text })
      })
    })
    const timer = setTimeout(() => { request.destroy(); resolve('no answer') }, 10_000)
    request.on('error', () => {})
    send(request)
  })
}

/** One valid input per fabric tool, with the path its call takes. */
const ELEVEN: [string, string, Record<string, unknown>][] = [
  ['project_create', '/fabric/project/create', { displayName: 'r1a23 audit' }],
  ['project_list', '/fabric/project/list', {}],
  ['project_get', '/fabric/project/get', { projectId: 'p1' }],
  ['project_archive', '/fabric/project/archive', { projectId: 'p1' }],
  ['room_post', '/fabric/room/post', { projectId: 'p1', room: 'r1', type: 'message', body: 'hello', idempotencyKey: 'k1' }],
  ['room_read', '/fabric/room/read', { projectId: 'p1', room: 'r1' }],
  ['memory_remember', '/fabric/memory/remember', { scope: 'user', kind: 'fact', text: 'r1a23 audit', importance: 0.5 }],
  ['memory_search', '/fabric/memory/search', { query: 'r1a23 audit' }],
  ['memory_get', '/fabric/memory/get', { id: 'm1' }],
  ['memory_forget', '/fabric/memory/forget', { id: 'm1' }],
  ['memory_promote', '/fabric/memory/promote', { projectId: 'p1', roomEventId: 'e1', kind: 'fact', importance: 0.5, idempotencyKey: 'k2' }],
]

const ZEROS = '0'.repeat(64)
const FORGED = { ownerId: `owner-${ZEROS}`, deviceId: `mcp-device-${ZEROS}`, agentId: `mcp-owner-${ZEROS}` }

describe.skipIf(Boolean(missing))('U-R1A-23-R1 audit: the link route, the caller and the home rules', () => {
  const bDb = databasePath()
  let agent: Awaited<ReturnType<typeof startStdio>> | undefined
  let session: Client | undefined
  let owner: Json = {}
  const homes: Awaited<ReturnType<typeof fakeHome>>[] = []
  const dial = async (...args: Parameters<typeof fakeHome>) => {
    const next = await fakeHome(...args)
    homes.push(next)
    return next
  }
  const list = () => route('/fabric/project/list', { body: listBody })
  const noStoreHere = () => {
    expect(existsSync(bDb)).toBe(false)
    expect(existsSync(join(agent!.home, '.tandem', 'fabric'))).toBe(false)
  }

  beforeAll(async () => {
    await startHub('/tmp/r1a23-')
    agent = await startStdio({
      TANDEM_HUB_LINK_URL: hub.replace(/^http/, 'ws'),
      TANDEM_HUB_LINK_TOKEN: LINK_TOKEN,
      TANDEM_HUB_LINK_ID: 'r1a23-beta',
      CCM_FABRIC_DB_PATH: bDb,
    })
    // This computer's id is bound on the tunnel by its own key, as its bridge would bind it.
    linkAs = { id: 'r1a23-beta', key: keyIn(agent.home) }
    await (await fakeHome('r1a23-beta', undefined, { home: false, key: linkAs.key })).close()
    session = await connect()
    owner = await fabricCallerFor('owner')
  }, 150_000)

  afterAll(async () => {
    for (const client of [session, agent?.client]) await client?.close().catch(() => {})
    for (const home of homes) await home.close()
    await stopHub()
  }, 30_000)

  describe('no home connected: each refusal in the order the route checks', () => {
    it.each([
      ['404 comes first: /sessions with GET, ?token=x and no bearer', () => fetch(`${hub}/__tunnel/fabric-rpc/sessions?token=x`).then(async (r) => ({ status: r.status, text: await r.text() })), 404, 'not found'],
      ['404: /fabric with no call name', () => route('/fabric', { body: listBody }), 404, 'not found'],
      ['404: dot segments that leave /fabric/', () => route('/fabric/%2e%2e/%2e%2e/__rpc/sessions', { body: listBody }), 404, 'not found'],
      ['401 for ?token=x before the method and the bearer', () => fetch(`${hub}/__tunnel/fabric-rpc/fabric/project/list?token=x`).then(async (r) => ({ status: r.status, text: await r.text() })), 401, 'unauthorized'],
      ['405 before the bearer: GET with no bearer', () => fetch(`${hub}/__tunnel/fabric-rpc/fabric/project/list`).then(async (r) => ({ status: r.status, text: await r.text() })), 405, 'method not allowed'],
      ['405: PUT with the bearer', () => route('/fabric/project/list', { method: 'PUT', body: listBody }), 405, 'method not allowed'],
      ['401: the token under the Basic scheme', () => route('/fabric/project/list', { body: listBody, headers: { authorization: `Basic ${LINK_TOKEN}` } }), 401, 'unauthorized'],
      ['401: the token plus one character', () => route('/fabric/project/list', { body: listBody, headers: { authorization: `Bearer ${LINK_TOKEN}x` } }), 401, 'unauthorized'],
      ['401 before 413: a wrong bearer with CAP + 1 bytes', () => route('/fabric/project/list', { body: 'x'.repeat(CAP + 1), headers: { authorization: `Bearer ${'w'.repeat(32)}` } }), 401, 'unauthorized'],
      ['413: CAP + 1 bytes with a declared length', () => route('/fabric/project/list', { body: 'x'.repeat(CAP + 1) }), 413, '{"error":"payload_too_large"}'],
      ['413: twice CAP streamed with no declared length', () => raw('/fabric/project/list', bearer, (r) => { r.write(Buffer.alloc(2 * CAP, 0x78)); r.end() }), 413, '{"error":"payload_too_large"}'],
      ['503: the call after that refusal is answered, its body streamed with no declared length', () => raw('/fabric/project/list', { ...bearer, 'tandem-proof': linkProof('/fabric/project/list', '{"input":{}}') }, (r) => { r.write('{"inp'); r.write('ut":{}}'); r.end() }), 503, JSON.stringify(OFFLINE)],
      ['400, not 413: exactly CAP bytes that are not JSON', () => route('/fabric/project/list', { body: 'x'.repeat(CAP) }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: an empty body', () => route('/fabric/project/list', { body: '' }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: a JSON array', () => route('/fabric/project/list', { body: '[]' }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: JSON null', () => route('/fabric/project/list', { body: 'null' }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: input is an array', () => route('/fabric/project/list', { body: '{"input":[]}' }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: input is null', () => route('/fabric/project/list', { body: '{"input":null}' }), 400, '{"error":"fabric_request_invalid"}'],
      ['400: input is a string', () => route('/fabric/project/list', { body: '{"input":"x"}' }), 400, '{"error":"fabric_request_invalid"}'],
      ['503: a valid call with no home, its length declared', list, 503, JSON.stringify(OFFLINE)],
    ] as const)('%s', async (_label, request, status, text) => {
      expect(await request()).toEqual({ status, text })
    }, 30_000)
  })

  describe('one home (r1a23-echo) and one other computer (r1a23-other)', () => {
    let home: Awaited<ReturnType<typeof fakeHome>>
    let other: Awaited<ReturnType<typeof fakeHome>>
    const input = { query: 'r1a23 who' }

    beforeAll(async () => {
      home = await dial('r1a23-echo', echo)
      other = await dial('r1a23-other', { from: 'other' }, { home: false })
    })

    it.each([
      ['a forged caller in the body', '', {}, { caller: FORGED }],
      ['owner and agent ids beside input', '', {}, { ...FORGED, owner: FORGED.ownerId, oauthSubject: 'someone', trusted_surface: 'x', machine: 'r1a23-other' }],
      ['identity and machine headers', '', { 'x-ccm-bridge-id': 'r1a23-other', 'x-tandem-owner': FORGED.ownerId, 'x-forwarded-user': 'someone', cookie: 'owner=someone' }, {}],
      ['identity and machine in the query', `?caller=${FORGED.ownerId}&owner=${FORGED.ownerId}&bridge_id=r1a23-other&machine=r1a23-other&memory_home=1`, {}, {}],
    ] as const)('%s: the home gets the one owner, the input and nothing else', async (_label, query, headers, extra) => {
      const before = other.requests.length
      const answer = await route(`/fabric/memory/search${query}`, { headers, body: JSON.stringify({ ...extra, input }) })
      expect(answer.status).toBe(200)
      expect(answer.text).not.toMatch(/0{64}/)
      expect(JSON.parse(answer.text)).toEqual({
        path: '/fabric/memory/search', query: null, headers: ['content-length', 'content-type'], trust: 'oauth-mcp-fabric-v1', body: { caller: owner, input },
      })
      expect(other.requests.length).toBe(before)
    }, 30_000)

    it('a stdio agent without a store and a claude.ai session are the same one owner', async () => {
      expect((await call(agent!.client, 'memory_search', input)).body).toEqual({ caller: owner, input })
      expect((await call(session!, 'memory_search', input)).body).toEqual({ caller: owner, input })
    }, 30_000)

    it('each of the 11 calls from the computer without a store reaches the home, and no store appears there', async () => {
      for (const [name, path, args] of ELEVEN) {
        expect(await call(agent!.client, name, args), name).toEqual(expect.objectContaining({ path, body: { caller: owner, input: args } }))
      }
      noStoreHere()
    }, 60_000)

    it('another computer dropping its socket does not fail a call waiting on the home', async () => {
      home.delayMs = 3_000
      try {
        const waiting = list()
        await sleep(500)
        other.drop()
        expect((await waiting).status).toBe(200)
      } finally {
        home.delayMs = 0
      }
    }, 30_000)

    it('the home redialing: its older socket closing (4003) does not fail a call sent on the newer one', async () => {
      const older = home
      home = await dial('r1a23-echo', echo)
      home.delayMs = 3_000
      try {
        const waiting = list()
        expect(await older.closed).toBe(4003)
        expect((await waiting).status).toBe(200)
        expect(older.requests.some((frame) => frame.path === '/fabric/project/list' && home.requests.includes(frame))).toBe(false)
      } finally {
        home.delayMs = 0
      }
    }, 30_000)

    it('a second home is refused, never split: 409 for the route, the agent and the session, and neither home is sent the call', async () => {
      const second = await dial('r1a23-two', { from: 'second' })
      const conflict = {
        error: 'memory_home_conflict',
        machines: ['r1a23-echo', 'r1a23-two'],
        message: 'more than one computer holds a memory store (r1a23-echo, r1a23-two); turn the store off on all but one',
      }
      const seen = [home.requests.length, second.requests.length]
      expect(await list()).toEqual({ status: 409, text: JSON.stringify(conflict) })
      expect(await call(agent!.client, 'memory_remember', ELEVEN[6][2])).toEqual(conflict)
      expect(await call(session!, 'memory_remember', ELEVEN[6][2])).toEqual(conflict)
      expect([home.requests.length, second.requests.length]).toEqual(seen)
      await second.close()
      await vi.waitFor(async () => expect((await list()).status).toBe(200), { timeout: 30_000, interval: 500 })
    }, 60_000)

    it('the home dropping while a call waits on it: memory_home_offline', async () => {
      home.delayMs = 60_000
      const waiting = list()
      await sleep(500)
      await home.close()
      expect(await waiting).toEqual({ status: 503, text: JSON.stringify(OFFLINE) })
    }, 60_000)

    it('the home id dialing again with its store off: the older socket is closed (4003) and there is no home', async () => {
      const on = await dial('r1a23-echo', echo)
      expect((await list()).status).toBe(200)
      const off = await dial('r1a23-echo', echo, { home: false })
      expect(await on.closed).toBe(4003)
      expect(await list()).toEqual({ status: 503, text: JSON.stringify(OFFLINE) })
      expect(off.requests.length).toBe(0)
    }, 30_000)

    it('with no home each of the 11 calls answers memory_home_offline, and still no store appears', async () => {
      for (const [name, , args] of ELEVEN) expect(await call(agent!.client, name, args), name).toEqual(OFFLINE)
      noStoreHere()
    }, 60_000)
  })
})
