/**
 * Mail and presence carried by the hub between the owner's computers (U-R1A-33B-1).
 *
 * One local hub (`wrangler dev --local`) through ./hub-harness.ts. A roster of root, alpha and beta
 * is uploaded as root; gamma is bound to the hub (one roster GET) but is not in the roster. Every
 * call to the three link routes carries a device proof over its exact path and body
 * (hubProofHeader); the sender is always the computer the proof names. Raw fake bridges dial the
 * tunnel as memory-home.test.ts's fakeHome does. (e1) checks a closing socket fails only the calls
 * sent on it, through the signed-in MCP path. Skipped only when wrangler or tmux is missing.
 */
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CCM_FRAME_TYPES, CCM_TUNNEL_SUBPROTOCOL } from '../../hub/src/protocol.ts'
import { hubProofHeader } from '../../bridge/hub-link.ts'
import { openDeviceKey, type DeviceKey } from '../../bridge/device-keys.ts'
import { initRoster, makeOffer, receiveOffer, trustOffer } from '../../bridge/roster.ts'
import { rosterHub } from '../../bridge/roster-hub.ts'
import { hub, LINK_TOKEN, missing, signIn, startHub, stopHub } from './hub-harness.ts'

const PREFIX = '/tmp/r1a33b1-e2e-'
const WAIT = 60_000
const CAP = 1_048_576
type Json = Record<string, any>
type Computer = { id: string; key: DeviceKey }

const folders: string[] = []
const folder = (name: string) => {
  const made = mkdtempSync(`${PREFIX}${name}-`)
  folders.push(made)
  return made
}
const removeFolders = () => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
afterAll(removeFolders)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let keysHome = ''
const computer = (id: string): Computer => ({ id, key: openDeviceKey({ path: join(keysHome, id, 'keys', 'device.key') }) })

/** One link-route call as `as`: the bearer, a proof over `path` (no query) and the exact body, unless `opts` says otherwise. */
async function link(
  as: Computer,
  path: string,
  body: string,
  opts: { method?: string; query?: string; bearer?: boolean; proofBody?: string } = {},
): Promise<{ status: number; text: string }> {
  const method = opts.method ?? 'POST'
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'tandem-proof': hubProofHeader(as.key, { url: hub, method, path, id: as.id, body: opts.proofBody ?? (method === 'GET' ? undefined : body) }),
  }
  if (opts.bearer !== false) headers.authorization = `Bearer ${LINK_TOKEN}`
  const response = await fetch(`${hub}${path}${opts.query ?? ''}`, { method, headers, body: method === 'GET' ? undefined : body })
  return { status: response.status, text: await response.text() }
}
const PUT = '/__tunnel/mail/put'
const TAKE = '/__tunnel/mail/take'
const PRESENCE = '/__tunnel/presence'
const put = (as: Computer, body: Json) => link(as, PUT, JSON.stringify(body))
const take = (as: Computer, ack: number) => link(as, TAKE, JSON.stringify({ ack }))
const presence = (as: Computer, items: Json[]) => link(as, PRESENCE, JSON.stringify({ presence: items }))
const copiesOf = (answer: { status: number; text: string }) => {
  expect(answer.status).toBe(200)
  return (JSON.parse(answer.text) as { copies: Json[] }).copies
}

/** A raw fake bridge dialled as `id` (not a memory home): answers each request with `{ from: id }` after `delayMs`. */
async function fakeBridge(c: Computer) {
  const path = `/__tunnel/connect?bridge_id=${c.id}`
  const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}${path}`, CCM_TUNNEL_SUBPROTOCOL, {
    headers: { Authorization: `Bearer ${LINK_TOKEN}`, 'tandem-proof': hubProofHeader(c.key, { url: hub, method: 'GET', path, id: c.id }) },
  })
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  const stand = {
    requests: [] as Json[],
    delayMs: 0,
    closed,
    drop: () => ws.close(1000),
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
    const reply = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        type: CCM_FRAME_TYPES.httpResponse,
        request_id: frame.request_id,
        status_code: 200,
        headers: { 'content-type': ['application/json'] },
        body_base64: Buffer.from(JSON.stringify({ from: c.id }), 'utf8').toString('base64'),
      }))
    }
    if (stand.delayMs > 0) setTimeout(reply, stand.delayMs)
    else reply()
  })
  await once(ws, 'open')
  return stand
}

/** The owner's roster of root, alpha and beta, made in `rootHome` (a TANDEM_HOME) and PUT to the hub as root. */
async function ownerRoster(rootHome: string, root: Computer, others: Computer[]) {
  const before = process.env.TANDEM_HOME
  process.env.TANDEM_HOME = rootHome
  try {
    initRoster(root.key, root.id)
    for (const c of others) {
      receiveOffer(JSON.stringify(makeOffer(c.key, c.id)))
      trustOffer(root.key, c.key.fingerprint)
    }
  } finally {
    if (before === undefined) delete process.env.TANDEM_HOME
    else process.env.TANDEM_HOME = before
  }
  const text = readFileSync(join(rootHome, 'roster', 'roster.json'), 'utf8')
  const answer = await rosterHub({ url: hub, token: LINK_TOKEN, bridgeId: root.id }, root.key).put(0, text)
  if (!answer.ok) throw new Error(`roster put: ${answer.len}`)
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: WAIT })
  const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ''
  return JSON.parse(text) as Json
}

const title = missing ? `(33B-1) hub mail and presence (skipped: ${missing} missing)` : '(33B-1) hub mail and presence'

describe.skipIf(Boolean(missing))(title, () => {
  let root: Computer, alpha: Computer, beta: Computer, gamma: Computer, never: Computer
  let session: Client | undefined
  const bridges: Awaited<ReturnType<typeof fakeBridge>>[] = []
  const dial = async (c: Computer) => {
    const next = await fakeBridge(c)
    bridges.push(next)
    return next
  }
  let fakeAlpha: Awaited<ReturnType<typeof fakeBridge>>
  let fakeBeta: Awaited<ReturnType<typeof fakeBridge>>

  beforeAll(async () => {
    keysHome = folder('keys')
    root = computer('root')
    alpha = computer('alpha')
    beta = computer('beta')
    gamma = computer('gamma')
    never = computer('never')
    await startHub(PREFIX)
    const rootHome = folder('root')
    mkdirSync(join(rootHome, 'roster'), { mode: 0o700 })
    chmodSync(rootHome, 0o700)
    await ownerRoster(rootHome, root, [alpha, beta])
    // alpha and beta are bound by their tunnel dial; gamma by one roster GET.
    fakeAlpha = await dial(alpha)
    fakeBeta = await dial(beta)
    expect((await link(gamma, '/__tunnel/roster', '', { method: 'GET' })).status).toBe(200)
    const token = await signIn()
    session = new Client({ name: 'r1a33b1-e2e', version: '0.0.0' })
    await session.connect(new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  }, 150_000)

  afterAll(async () => {
    try {
      await session?.close().catch(() => {})
      for (const b of bridges) await b.close()
    } finally {
      try {
        await stopHub()
      } finally {
        removeFolders()
      }
    }
  }, 30_000)

  it('(33B-1) (e1) a closing socket fails only the calls sent on it', async () => {
    const S = () => session!
    // beta drops while alpha's call waits: alpha's answer comes back.
    fakeAlpha.delayMs = 3_000
    let seen = fakeAlpha.requests.length
    let waiting = call(S(), 'list_sessions', { machine: 'alpha' })
    await vi.waitFor(() => expect(fakeAlpha.requests.length).toBe(seen + 1), { timeout: 10_000, interval: 50 })
    await sleep(500)
    fakeBeta.drop()
    expect(await waiting).toEqual({ from: 'alpha' })
    await fakeBeta.closed
    fakeBeta = await dial(beta)

    // alpha itself drops while its call waits: bridge_offline.
    seen = fakeAlpha.requests.length
    waiting = call(S(), 'list_sessions', { machine: 'alpha' })
    await vi.waitFor(() => expect(fakeAlpha.requests.length).toBe(seen + 1), { timeout: 10_000, interval: 50 })
    await sleep(500)
    fakeAlpha.drop()
    const lost = await waiting
    expect(lost.error).toBe('bridge_offline')
    expect(lost.from).toBeUndefined()
    await fakeAlpha.closed
    fakeAlpha = await dial(alpha)

    // beta's own call while alpha's socket closes: beta's answer comes back.
    fakeBeta.delayMs = 3_000
    seen = fakeBeta.requests.length
    waiting = call(S(), 'list_sessions', { machine: 'beta' })
    await vi.waitFor(() => expect(fakeBeta.requests.length).toBe(seen + 1), { timeout: 10_000, interval: 50 })
    await sleep(500)
    fakeAlpha.drop()
    expect(await waiting).toEqual({ from: 'beta' })
    await fakeAlpha.closed
    fakeAlpha = await dial(alpha)
    fakeAlpha.delayMs = 0
    fakeBeta.delayMs = 0
  }, WAIT)

  it('(33B-1) (e2) round trip: alpha puts, beta takes, acks; acked copies are gone; alpha sees none of them', async () => {
    expect(await put(alpha, { id: 'm1', to: ['beta'], body: 'x1' })).toEqual({ status: 200, text: '{"results":[{"to":"beta","seq":1}]}' })
    expect(await take(beta, 0)).toEqual({
      status: 200,
      text: '{"copies":[{"id":"m1","from":"alpha","room":null,"room_seq":null,"seq":1,"kind":"message","body":"x1"}]}',
    })
    expect(await take(beta, 1)).toEqual({ status: 200, text: '{"copies":[]}' })
    expect(await take(beta, 0)).toEqual({ status: 200, text: '{"copies":[]}' })
    expect(await take(alpha, 0)).toEqual({ status: 200, text: '{"copies":[]}' })
  }, WAIT)

  it('(33B-1) (e3) the sender is the proof: a from or room key in the put body is 400, nothing queued', async () => {
    for (const extra of [{ from: 'beta' }, { from: 'alpha' }, { room: 'r1' }]) {
      expect(await put(alpha, { id: 'm3', to: ['beta'], body: 'x3', ...extra })).toEqual({ status: 400, text: '{"error":"mail_invalid"}' })
    }
    expect(copiesOf(await take(beta, 0))).toEqual([])
  }, WAIT)

  describe('(33B-1) (e4) refusals in route order', () => {
    const ROUTES = [
      [PUT, { id: 'm4', to: ['beta'], body: 'x4' }],
      [TAKE, { ack: 0 }],
      [PRESENCE, { presence: [{ to: 'beta', envelope: 'E4' }] }],
    ] as const
    const valid = (path: string) => JSON.stringify(ROUTES.find(([p]) => p === path)![1])

    it.each(ROUTES.map(([p]) => [p]))('(33B-1) %s: ?token=x 401, GET 405, no bearer 401', async (path) => {
      expect(await link(root, path, valid(path), { query: '?token=x' })).toEqual({ status: 401, text: 'unauthorized' })
      expect(await link(root, path, '', { method: 'GET' })).toEqual({ status: 405, text: 'method not allowed' })
      expect(await link(root, path, valid(path), { bearer: false })).toEqual({ status: 401, text: 'unauthorized' })
    }, WAIT)

    it.each([[PUT, CAP], [TAKE, 1024], [PRESENCE, CAP]] as const)('(33B-1) %s: a body over %i bytes with a declared length 413', async (path, cap) => {
      expect(await link(root, path, 'x'.repeat(cap + 1))).toEqual({ status: 413, text: '{"error":"payload_too_large"}' })
    }, WAIT)

    it.each(ROUTES.map(([p]) => [p]))('(33B-1) %s: a proof over other bytes 401, an id never bound 401', async (path) => {
      expect(await link(root, path, valid(path), { proofBody: valid(path) + ' ' })).toEqual({ status: 401, text: 'unauthorized' })
      expect(await link(never, path, valid(path))).toEqual({ status: 401, text: 'unauthorized' })
    }, WAIT)

    it.each(ROUTES.map(([p]) => [p]))('(33B-1) %s: an id bound but not in the roster 403 not_in_roster', async (path) => {
      expect(await link(gamma, path, valid(path))).toEqual({ status: 403, text: '{"error":"not_in_roster"}' })
    }, WAIT)

    it('(33B-1) a to that is not a member: 403 not_in_roster, nothing queued or stored', async () => {
      const refused = { status: 403, text: '{"error":"not_in_roster"}' }
      expect(await put(alpha, { id: 'm4', to: ['beta', 'gamma'], body: 'x4' })).toEqual(refused)
      expect(await put(alpha, { id: 'm4', to: ['nobody'], body: 'x4' })).toEqual(refused)
      expect(await presence(alpha, [{ to: 'beta', envelope: 'P4' }, { to: 'gamma', envelope: 'P4' }])).toEqual(refused)
      expect(copiesOf(await take(beta, 0))).toEqual([])
      expect(JSON.parse((await presence(beta, [])).text).presence).toEqual([])
    }, WAIT)

    const MAIL_400 = [
      ['to empty', { id: 'm', to: [], body: 'x' }],
      ['to repeated', { id: 'm', to: ['beta', 'beta'], body: 'x' }],
      ['to equal to the sender', { id: 'm', to: ['root'], body: 'x' }],
      ['101 to entries', { id: 'm', to: Array.from({ length: 101 }, (_, i) => `c${i}`), body: 'x' }],
      ['a bad to id', { id: 'm', to: ['Beta!'], body: 'x' }],
      ['a to that is not a string', { id: 'm', to: [7], body: 'x' }],
      ['a bad message id', { id: 'm 1', to: ['beta'], body: 'x' }],
      ['a message id of 129 characters', { id: 'm'.repeat(129), to: ['beta'], body: 'x' }],
      ['an empty body', { id: 'm', to: ['beta'], body: '' }],
      ['an extra key', { id: 'm', to: ['beta'], body: 'x', extra: 1 }],
      ['a missing key', { id: 'm', to: ['beta'] }],
      ['a lone surrogate in the body', { id: 'm', to: ['beta'], body: '\ud800' }],
      ['a copy over MAX_COPY_BYTES', { id: 'm', to: ['beta'], body: 'x'.repeat(1_000_000) }],
    ] as const
    it.each(MAIL_400)('(33B-1) put 400 mail_invalid: %s, nothing queued', async (_label, body) => {
      expect(await put(root, body)).toEqual({ status: 400, text: '{"error":"mail_invalid"}' })
      expect(copiesOf(await take(beta, 0))).toEqual([])
    }, WAIT)

    it.each([
      ['ack -1', '{"ack":-1}'],
      ['ack 1.5', '{"ack":1.5}'],
      ['ack a string', '{"ack":"0"}'],
      ['an extra key', '{"ack":0,"to":"beta"}'],
      ['not JSON', '{ack'],
      ['an array', '[0]'],
    ] as const)('(33B-1) take 400 mail_invalid: %s', async (_label, body) => {
      expect(await link(root, TAKE, body)).toEqual({ status: 400, text: '{"error":"mail_invalid"}' })
    }, WAIT)

    it.each([
      ['101 items', { presence: Array.from({ length: 101 }, (_, i) => ({ to: `c${i}`, envelope: 'E' })) }],
      ['an envelope of 16,385 bytes', { presence: [{ to: 'beta', envelope: 'e'.repeat(16_385) }] }],
      ['an envelope of 16,385 UTF-8 bytes in fewer characters', { presence: [{ to: 'beta', envelope: 'é'.repeat(8192) + 'e' }] }],
      ['an empty envelope', { presence: [{ to: 'beta', envelope: '' }] }],
      ['a lone surrogate in the envelope', { presence: [{ to: 'beta', envelope: '\udc00' }] }],
      ['to repeated', { presence: [{ to: 'beta', envelope: 'E' }, { to: 'beta', envelope: 'F' }] }],
      ['to equal to the sender', { presence: [{ to: 'root', envelope: 'E' }] }],
      ['a bad to id', { presence: [{ to: 'BETA', envelope: 'E' }] }],
      ['an item with an extra key', { presence: [{ to: 'beta', envelope: 'E', from: 'alpha' }] }],
      ['an extra key', { presence: [], from: 'alpha' }],
      ['presence not an array', { presence: {} }],
    ] as const)('(33B-1) presence 400 presence_invalid: %s, nothing stored', async (_label, body) => {
      expect(await link(root, PRESENCE, JSON.stringify(body))).toEqual({ status: 400, text: '{"error":"presence_invalid"}' })
      expect(JSON.parse((await presence(beta, [])).text).presence).toEqual([])
    }, WAIT)
  })

  it('(33B-1) (e5) queue_full: 1,000 copies to beta, the 1,001st refused; beta takes and acks all, then a seq again', async () => {
    const started = Date.now()
    for (let i = 0; i < 1000; i += 10) {
      const answers = await Promise.all(Array.from({ length: 10 }, (_, j) => put(alpha, { id: `f${i + j}`, to: ['beta'], body: 'f' })))
      for (const a of answers) expect(a.status, a.text).toBe(200)
      for (const a of answers) expect(JSON.parse(a.text).results[0].seq).toEqual(expect.any(Number))
    }
    expect(await put(alpha, { id: 'f1000', to: ['beta'], body: 'f' })).toEqual({ status: 200, text: '{"results":[{"to":"beta","error":"queue_full"}]}' })
    let ack = 0
    let taken = 0
    for (;;) {
      const copies = copiesOf(await take(beta, ack))
      if (copies.length === 0) break
      taken += copies.length
      ack = copies[copies.length - 1].seq
    }
    expect(taken).toBe(1000)
    const again = await put(alpha, { id: 'f1001', to: ['beta'], body: 'f' })
    expect(again.status).toBe(200)
    expect(JSON.parse(again.text)).toEqual({ results: [{ to: 'beta', seq: ack + 1 }] })
    // The row's time goes into the evidence.
    console.error(`(33B-1) (e5) took ${Date.now() - started} ms`)
  }, 180_000)

  it('(33B-1) (e6) presence: the latest envelope per sender reaches its receiver; gamma never appears', async () => {
    const fakeGamma = await dial(gamma)
    const first = await presence(alpha, [{ to: 'beta', envelope: 'A1' }])
    expect(first.status).toBe(200)
    const a = JSON.parse(first.text)
    expect(a.presence).toEqual([])
    expect([...a.connected].sort()).toEqual(['alpha', 'beta', 'gamma'])
    const read = JSON.parse((await presence(beta, [])).text)
    expect(read.presence).toEqual([{ from: 'alpha', envelope: 'A1', at: expect.any(Number) }])
    expect(await presence(alpha, [{ to: 'beta', envelope: 'A2' }])).toEqual(expect.objectContaining({ status: 200 }))
    expect(await presence(gamma, [{ to: 'beta', envelope: 'G1' }])).toEqual({ status: 403, text: '{"error":"not_in_roster"}' })
    const after = await presence(beta, [])
    expect(after.status).toBe(200)
    expect(JSON.parse(after.text).presence).toEqual([{ from: 'alpha', envelope: 'A2', at: expect.any(Number) }])
    expect(JSON.parse(after.text).presence.some((r: Json) => r.from === 'gamma')).toBe(false)
    expect(await presence(alpha, Array.from({ length: 101 }, (_, i) => ({ to: `c${i}`, envelope: 'E' })))).toEqual({
      status: 400,
      text: '{"error":"presence_invalid"}',
    })
    await fakeGamma.close()
  }, WAIT)
})
