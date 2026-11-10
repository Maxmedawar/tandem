/**
 * The bridge's one outbound WebSocket to the hub (bridge/hub-link.ts).
 *
 * A fake hub (a `ws` server on 127.0.0.1, port 0) stands in for the real one;
 * timings are shortened through `timing` so reconnects take milliseconds.
 */
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveBridgeId,
  HEALTHY_SESSION_MS,
  hubLinkConfigFromEnv,
  isTunnelStale,
  LIVENESS_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  planReconnect,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  startHubLink,
} from '../bridge/hub-link.ts'
import {
  CCM_FRAME_TYPES,
  CCM_TUNNEL_SUBPROTOCOL,
  type CcmHttpRequestFrame,
  type CcmHttpResponseFrame,
} from '../hub/src/protocol.ts'

// Low-entropy on purpose: the value only has to be easy to spot in captured text.
const TOKEN = `hub-link-${'q'.repeat(24)}`
const TIMING = { baseMs: 20, maxMs: 400, healthyMs: 150, dialTimeoutMs: 500, livenessMs: 200, heartbeatMs: 40 }
const WAIT = { timeout: 5_000, interval: 10 }

type Frame = Record<string, unknown>
interface HubConnection {
  socket: WebSocket
  request: IncomingMessage
  at: number
  raw: string[]
  frames: Frame[]
}
type Link = ReturnType<typeof startHubLink>

const hubs: WebSocketServer[] = []
const links: Link[] = []

afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => link.close()))
  for (const server of hubs.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function startHub(options: {
  refuse?: number
  onConnection?: (connection: HubConnection, index: number) => void
} = {}): Promise<{ url: string; conns: HubConnection[]; dials: number[] }> {
  const dials: number[] = []
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, done) => {
      dials.push(Date.now())
      if (options.refuse) done(false, options.refuse)
      else done(true)
    },
  })
  hubs.push(server)
  await once(server, 'listening')
  const conns: HubConnection[] = []
  server.on('connection', (socket, request) => {
    const connection: HubConnection = { socket, request, at: Date.now(), raw: [], frames: [] }
    conns.push(connection)
    socket.on('message', (data) => {
      const text = data.toString()
      connection.raw.push(text)
      connection.frames.push(JSON.parse(text) as Frame)
    })
    options.onConnection?.(connection, conns.length - 1)
  })
  const { port } = server.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}`, conns, dials }
}

function echoHeartbeats(connection: HubConnection): void {
  connection.socket.on('message', (data) => {
    if ((JSON.parse(data.toString()) as Frame).type === CCM_FRAME_TYPES.heartbeat) connection.socket.send(data.toString())
  })
}

function start(url: string, opts: Parameters<typeof startHubLink>[1] = {}, lines: string[] = []): Link {
  const link = startHubLink(
    { url, token: TOKEN, bridgeId: 'probe-one' },
    { log: (line) => lines.push(line), timing: TIMING, ...opts },
  )
  links.push(link)
  return link
}

function delays(lines: string[]): number[] {
  return lines.flatMap((line) => {
    const match = /reconnecting in (\d+)ms/.exec(line)
    return match ? [Number(match[1])] : []
  })
}

function expectNoToken(texts: string[]): void {
  for (const text of texts) expect(text).not.toContain(TOKEN)
}

function requestFrame(requestId: string, extra: Partial<CcmHttpRequestFrame> = {}): CcmHttpRequestFrame {
  return { type: CCM_FRAME_TYPES.httpRequest, request_id: requestId, method: 'GET', path: '/sessions', raw_query: '', headers: {}, ...extra }
}

/** A valid request frame padded to exactly `bytes` bytes. */
function requestFrameOfSize(requestId: string, bytes: number): string {
  const base = JSON.stringify(requestFrame(requestId, { body_base64: '' }))
  const text = JSON.stringify(requestFrame(requestId, { body_base64: 'A'.repeat(bytes - base.length) }))
  expect(Buffer.byteLength(text)).toBe(bytes)
  return text
}

function responseFrames(connection: HubConnection): CcmHttpResponseFrame[] {
  return connection.frames.filter((frame) => frame.type === CCM_FRAME_TYPES.httpResponse) as CcmHttpResponseFrame[]
}

describe('planReconnect', () => {
  it('resets to base after a long healthy session that dropped abnormally (the 30s-stuck bug)', () => {
    const plan = planReconnect(RECONNECT_MAX_MS, { established: true, upMs: 3_600_000 })
    expect(plan.reset).toBe(true)
    expect(plan.delayMs).toBe(RECONNECT_BASE_MS)
    expect(plan.nextBackoffMs).toBe(RECONNECT_BASE_MS * 2)
  })

  it('does NOT reset for a short-lived established blip (avoids reset-thrash in a drop storm)', () => {
    const plan = planReconnect(16_000, { established: true, upMs: 500 })
    expect(plan.reset).toBe(false)
    expect(plan.delayMs).toBe(16_000)
    expect(plan.nextBackoffMs).toBe(RECONNECT_MAX_MS) // 32000 capped to 30000
  })

  it('does NOT reset when the socket never opened (dial failure)', () => {
    const plan = planReconnect(RECONNECT_BASE_MS, { established: false, upMs: 30_000 })
    expect(plan.reset).toBe(false)
    expect(plan.delayMs).toBe(RECONNECT_BASE_MS)
    expect(plan.nextBackoffMs).toBe(RECONNECT_BASE_MS * 2)
  })

  it('climbs geometrically and caps at the ceiling during a sustained outage', () => {
    let backoff = RECONNECT_BASE_MS
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      const plan = planReconnect(backoff, { established: false, upMs: 0 })
      seen.push(plan.delayMs)
      backoff = plan.nextBackoffMs
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })

  it('clamps a below-base backoff up to base', () => {
    const plan = planReconnect(0, { established: false, upMs: 0 })
    expect(plan.delayMs).toBe(RECONNECT_BASE_MS)
    expect(plan.nextBackoffMs).toBe(RECONNECT_BASE_MS * 2)
  })

  it('treats exactly the healthy threshold as healthy (boundary)', () => {
    expect(planReconnect(RECONNECT_MAX_MS, { established: true, upMs: HEALTHY_SESSION_MS }).reset).toBe(true)
    expect(planReconnect(RECONNECT_MAX_MS, { established: true, upMs: HEALTHY_SESSION_MS - 1 }).reset).toBe(false)
  })
})

describe('isTunnelStale', () => {
  const now = 1_000_000_000

  it('is false while frames keep arriving (healthy heartbeat echoes)', () => {
    expect(isTunnelStale(now - 25_000, now)).toBe(false)
  })

  it('is false at exactly the timeout boundary, true just past it', () => {
    expect(isTunnelStale(now - LIVENESS_TIMEOUT_MS, now)).toBe(false)
    expect(isTunnelStale(now - LIVENESS_TIMEOUT_MS - 1, now)).toBe(true)
  })

  it('flags a zombie socket that has been silent well past the window', () => {
    expect(isTunnelStale(now - 120_000, now)).toBe(true)
  })

  it('honors a custom timeout', () => {
    expect(isTunnelStale(now - 6_000, now, 5_000)).toBe(true)
    expect(isTunnelStale(now - 4_000, now, 5_000)).toBe(false)
  })
})

describe('deriveBridgeId (bridge side)', () => {
  it('uses the configured id over the hostname when set', () => {
    expect(deriveBridgeId('mini', 'Whatever.local')).toBe('mini')
  })

  it('falls back to the hostname slug with .local stripped', () => {
    expect(deriveBridgeId(undefined, 'Maxs-MacBook-Pro.local')).toBe('maxs-macbook-pro')
  })

  it('ignores a blank/whitespace configured id and uses the hostname', () => {
    expect(deriveBridgeId('   ', 'host')).toBe('host')
    expect(deriveBridgeId('', 'host')).toBe('host')
  })

  it('applies the slug rule: lowercase, non [a-z0-9._-] -> -, collapse repeats, trim', () => {
    expect(deriveBridgeId('A/B C', 'host')).toBe('a-b-c')
    expect(deriveBridgeId('--Foo__Bar..baz--', 'host')).toBe('foo__bar..baz')
    expect(deriveBridgeId('weird id!', 'host')).toBe('weird-id')
  })

  it('caps the slug length at 64 chars', () => {
    expect(deriveBridgeId('x'.repeat(200), 'host')).toHaveLength(64)
  })

  it('never returns empty -> default', () => {
    expect(deriveBridgeId('', '')).toBe('default')
    expect(deriveBridgeId('!!!', '')).toBe('default')
    expect(deriveBridgeId(undefined, '.local')).toBe('default')
  })
})

describe('the hub link dial', () => {
  it('a) sends the token only in an Authorization: Bearer header, never in the URL, a frame or a log line', async () => {
    const hub = await startHub()
    const lines: string[] = []
    const link = start(hub.url, {}, lines)
    await vi.waitFor(() => expect(hub.conns[0]?.frames.length ?? 0).toBeGreaterThanOrEqual(3), WAIT)

    const request = hub.conns[0].request
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
    const url = new URL(request.url ?? '', 'ws://127.0.0.1')
    expect(url.pathname).toBe('/__tunnel/connect')
    expect([...url.searchParams.keys()]).toEqual(['bridge_id'])
    expect(url.searchParams.get('bridge_id')).toBe('probe-one')
    expect(request.url).not.toContain(TOKEN)
    expect(request.headers['sec-websocket-protocol']).toBe(CCM_TUNNEL_SUBPROTOCOL)
    expect(link.connected()).toBe(true)

    const register = hub.conns[0].frames[0]
    expect(register).toEqual({ type: CCM_FRAME_TYPES.register, bridge_id: 'probe-one' })
    expect('token' in register).toBe(false)
    expect(hub.conns[0].frames.slice(1).every((frame) => frame.type === CCM_FRAME_TYPES.heartbeat)).toBe(true)
    expectNoToken(hub.conns[0].raw)

    // A dropped socket and the redial add more log lines; none of them carries the token either.
    hub.conns[0].socket.terminate()
    await vi.waitFor(() => expect(delays(lines).length).toBeGreaterThanOrEqual(1), WAIT)
    expect(lines.length).toBeGreaterThan(0)
    expectNoToken(lines)
  })

  it('an echoed heartbeat keeps the link up', async () => {
    const hub = await startHub({ onConnection: echoHeartbeats })
    const link = start(hub.url)
    await vi.waitFor(() => expect(link.connected()).toBe(true), WAIT)
    await new Promise((resolve) => setTimeout(resolve, TIMING.livenessMs * 3))
    expect(hub.conns).toHaveLength(1)
    expect(link.connected()).toBe(true)
    const heartbeats = hub.conns[0].frames.filter((frame) => frame.type === CCM_FRAME_TYPES.heartbeat)
    expect(heartbeats.length).toBeGreaterThanOrEqual(5)
  })

  it('a hub silent past the liveness window causes a redial', async () => {
    const hub = await startHub()
    const lines: string[] = []
    start(hub.url, {}, lines)
    await vi.waitFor(() => expect(hub.conns).toHaveLength(2), WAIT)
    expect(hub.conns[1].at - hub.conns[0].at).toBeGreaterThanOrEqual(TIMING.livenessMs)
    expect(lines.some((line) => line.includes('liveness'))).toBe(true)
    expectNoToken(lines)
  })

  it('when the hub closes, the link redials with growing delays that reset after a healthy session', async () => {
    const hub = await startHub({
      onConnection: (connection, index) => {
        if (index < 3) connection.socket.close()
        else if (index === 3) {
          echoHeartbeats(connection)
          setTimeout(() => connection.socket.close(), TIMING.healthyMs + 100)
        } else echoHeartbeats(connection)
      },
    })
    const lines: string[] = []
    start(hub.url, {}, lines)
    await vi.waitFor(() => expect(delays(lines).length).toBeGreaterThanOrEqual(4), WAIT)
    expect(delays(lines).slice(0, 4)).toEqual([20, 40, 80, 20])
    await vi.waitFor(() => expect(hub.conns).toHaveLength(5), WAIT)
    expectNoToken(lines)
  })

  it('a 401 refusal causes redials with growing delays', async () => {
    const hub = await startHub({ refuse: 401 })
    const lines: string[] = []
    const link = start(hub.url, {}, lines)
    await vi.waitFor(() => expect(hub.dials.length).toBeGreaterThanOrEqual(5), WAIT)
    expect(delays(lines).slice(0, 4)).toEqual([20, 40, 80, 160])
    expect(lines.some((line) => line.includes('401'))).toBe(true)
    expect(hub.conns).toHaveLength(0)
    expect(link.connected()).toBe(false)
    expectNoToken(lines)
  })

  it('a frame of MAX_FRAME_BYTES + 1 never reaches the handler, and the link redials', async () => {
    const hub = await startHub()
    const seen: string[] = []
    start(hub.url, {
      handleRequest: async (frame) => {
        seen.push(frame.request_id)
        return { type: CCM_FRAME_TYPES.httpResponse, request_id: frame.request_id, status_code: 204 }
      },
    })
    await vi.waitFor(() => expect(hub.conns[0]?.frames.length ?? 0).toBeGreaterThan(0), WAIT)

    // Exactly at the cap still gets through, so the cap is the number and not lower.
    hub.conns[0].socket.send(requestFrameOfSize('fits', MAX_FRAME_BYTES))
    await vi.waitFor(() => expect(responseFrames(hub.conns[0]).map((frame) => frame.request_id)).toEqual(['fits']), WAIT)

    hub.conns[0].socket.send(requestFrameOfSize('over', MAX_FRAME_BYTES + 1))
    await vi.waitFor(() => expect(hub.conns).toHaveLength(2), WAIT)
    expect(seen).toEqual(['fits'])
  })

  it('a request frame reaches handleRequest, and its response reaches the hub with the same request_id', async () => {
    const hub = await startHub()
    const handled: CcmHttpRequestFrame[] = []
    start(hub.url, {
      handleRequest: async (frame) => {
        handled.push(frame)
        return {
          type: CCM_FRAME_TYPES.httpResponse,
          request_id: frame.request_id,
          status_code: 200,
          headers: { 'content-type': ['application/json'] },
          body_base64: Buffer.from('{"ok":true}').toString('base64'),
        }
      },
    })
    await vi.waitFor(() => expect(hub.conns[0]?.frames.length ?? 0).toBeGreaterThan(0), WAIT)
    hub.conns[0].socket.send(JSON.stringify(requestFrame('r-1', { method: 'POST', path: '/session/open' })))
    await vi.waitFor(() => expect(responseFrames(hub.conns[0])).toHaveLength(1), WAIT)

    expect(handled).toHaveLength(1)
    expect(handled[0]).toMatchObject({ request_id: 'r-1', method: 'POST', path: '/session/open' })
    const [response] = responseFrames(hub.conns[0])
    expect(response.request_id).toBe('r-1')
    expect(response.status_code).toBe(200)
    expect(Buffer.from(response.body_base64 ?? '', 'base64').toString()).toBe('{"ok":true}')
  })

  it('the default handler answers 503 bridge_not_ready', async () => {
    const hub = await startHub()
    start(hub.url)
    await vi.waitFor(() => expect(hub.conns[0]?.frames.length ?? 0).toBeGreaterThan(0), WAIT)
    hub.conns[0].socket.send(JSON.stringify(requestFrame('r-2')))
    await vi.waitFor(() => expect(responseFrames(hub.conns[0])).toHaveLength(1), WAIT)

    const [response] = responseFrames(hub.conns[0])
    expect(response.request_id).toBe('r-2')
    expect(response.status_code).toBe(503)
    expect(response.headers).toEqual({ 'content-type': ['application/json'] })
    expect(JSON.parse(Buffer.from(response.body_base64 ?? '', 'base64').toString())).toEqual({ error: 'bridge_not_ready' })
  })

  it('after close() there are no more dials', async () => {
    const hub = await startHub({ onConnection: echoHeartbeats })
    const link = start(hub.url)
    await vi.waitFor(() => expect(link.connected()).toBe(true), WAIT)
    const closed = once(hub.conns[0].socket, 'close')
    await link.close()
    await closed
    expect(link.connected()).toBe(false)

    const refusing = await startHub({ refuse: 401 })
    const backingOff = start(refusing.url)
    await vi.waitFor(() => expect(refusing.dials.length).toBeGreaterThanOrEqual(2), WAIT)
    await backingOff.close()
    const dialsAtClose = refusing.dials.length

    await new Promise((resolve) => setTimeout(resolve, TIMING.maxMs))
    expect(hub.dials).toHaveLength(1)
    expect(refusing.dials).toHaveLength(dialsAtClose)
  })
})

describe('hubLinkConfigFromEnv', () => {
  const bad = 'hub link: bad configuration'

  it('an unset URL gives undefined', () => {
    expect(hubLinkConfigFromEnv({})).toBeUndefined()
    expect(hubLinkConfigFromEnv({ TANDEM_HUB_LINK_TOKEN: TOKEN })).toBeUndefined()
  })

  it.each([
    ['http scheme', 'http://hub.example.com'],
    ['https scheme', 'https://hub.example.com'],
    ['ftp scheme', 'ftp://hub.example.com'],
    ['ws to a non-loopback host', 'ws://hub.example.com'],
    ['ws to a loopback look-alike', 'ws://127.0.0.1.example.com'],
    ['user and password', 'wss://user:pw-in-url@hub.example.com'],
    ['user only', 'wss://user-in-url@hub.example.com'],
    ['empty user info', 'wss://@hub.example.com'],
    ['a path', 'wss://hub.example.com/path-in-url'],
    ['a query', 'wss://hub.example.com/?q=query-in-url'],
    ['an empty query', 'wss://hub.example.com?'],
    ['a fragment', 'wss://hub.example.com#fragment-in-url'],
    ['not a URL', 'not a url at all'],
  ])('refuses %s without naming the value', (_name, url) => {
    let message = ''
    try {
      hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: url, TANDEM_HUB_LINK_TOKEN: TOKEN })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe(bad)
    expect(message).not.toContain(url)
    expect(message).not.toContain(TOKEN)
  })

  it('refuses a short token without naming it', () => {
    const short = 'short-tok-15chr'
    expect(short).toHaveLength(15)
    expect(() => hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: 'wss://hub.example.com', TANDEM_HUB_LINK_TOKEN: short })).toThrow(bad)
    try {
      hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: 'wss://hub.example.com', TANDEM_HUB_LINK_TOKEN: short })
    } catch (error) {
      expect((error as Error).message).not.toContain(short)
    }
  })

  it('refuses a missing token', () => {
    expect(() => hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: 'wss://hub.example.com' })).toThrow(bad)
    expect(() => hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: 'wss://hub.example.com', TANDEM_HUB_LINK_TOKEN: '' })).toThrow(bad)
  })

  it('accepts wss with an optional port and ws only on loopback', () => {
    const config = (url: string) => hubLinkConfigFromEnv({ TANDEM_HUB_LINK_URL: url, TANDEM_HUB_LINK_TOKEN: TOKEN })
    expect(config('wss://hub.example.com')?.url).toBe('wss://hub.example.com')
    expect(config('wss://hub.example.com:8443/')?.url).toBe('wss://hub.example.com:8443')
    expect(config('ws://127.0.0.1:9000')?.url).toBe('ws://127.0.0.1:9000')
    expect(config('ws://localhost:9000')?.url).toBe('ws://localhost:9000')
    expect(config('ws://[::1]:9000')?.url).toBe('ws://[::1]:9000')
    expect(config('wss://hub.example.com')?.token).toBe(TOKEN)
  })

  it('derives the bridge id from TANDEM_HUB_LINK_ID or the hostname', () => {
    const base = { TANDEM_HUB_LINK_URL: 'wss://hub.example.com', TANDEM_HUB_LINK_TOKEN: TOKEN }
    expect(hubLinkConfigFromEnv({ ...base, TANDEM_HUB_LINK_ID: 'Mini Box' })?.bridgeId).toBe('mini-box')
    expect(hubLinkConfigFromEnv(base)?.bridgeId).toBe(deriveBridgeId(undefined, hostname()))
  })
})

describe('frame cap', () => {
  it("equals the hub's WS_MAX_FRAME_BYTES", () => {
    const text = readFileSync(new URL('../hub/src/frame-size.ts', import.meta.url), 'utf8')
    const match = /export const WS_MAX_FRAME_BYTES = ([\d_]+)/.exec(text)
    expect(match).not.toBeNull()
    expect(Number(match![1].replace(/_/g, ''))).toBe(MAX_FRAME_BYTES)
    expect(MAX_FRAME_BYTES).toBe(1_048_576)
  })
})
