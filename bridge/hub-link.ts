/**
 * hub-link.ts: the bridge's one outbound WebSocket to the hub.
 *
 * Dials `<hub>/__tunnel/connect?bridge_id=<id>` with the secret only in an
 * `Authorization: Bearer` header (a URL lands in proxy and request logs; a frame
 * or a log line is no better) and a fresh `tandem-proof` signed by this computer's
 * device key (hub/src/devices.ts: the hub binds the id to the first key that proves
 * it), registers, heartbeats, drops a socket that has gone silent, and redials with backoff. Inbound frames over MAX_FRAME_BYTES close the
 * socket before any handler sees them. Only `wss://` is dialled, except on loopback.
 *
 * Settings: TANDEM_HUB_LINK_URL (hub origin), TANDEM_HUB_LINK_TOKEN (16+ chars,
 * required with the URL), TANDEM_HUB_LINK_ID (optional; else the hostname).
 */
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import WebSocket from 'ws'
import { DeviceKeyError, openDeviceKey, type DeviceKey } from './device-keys.ts'
import {
  CCM_FRAME_TYPES,
  CCM_TUNNEL_SUBPROTOCOL,
  parseAnyFrame,
  serializeFrame,
  type CcmFrame,
  type CcmHttpRequestFrame,
  type CcmHttpResponseFrame,
} from '../hub/src/protocol.ts'
import { DEFAULT_BRIDGE_ID, slugifyBridgeId } from '../hub/src/bridge-id.ts'
import { PROOF_HEADER, proofText } from '../hub/src/devices.ts'

/** Inbound frame ceiling; the hub's WS_MAX_FRAME_BYTES (hub/src/frame-size.ts) is the same number. */
export const MAX_FRAME_BYTES = 1_048_576
/** Hub requests the link runs at once; past this, a request is answered 503 bridge_busy. */
export const MAX_IN_FLIGHT = 64
/** Unsent bytes a socket may hold before the link drops it: the hub has stopped reading. */
export const MAX_BUFFERED_BYTES = 8 * MAX_FRAME_BYTES

/** How often the bridge sends a heartbeat; the hub echoes each one. */
export const HEARTBEAT_MS = 25_000
/** First/reset reconnect delay. */
export const RECONNECT_BASE_MS = 1_000
/** Ceiling the geometric backoff caps at during a sustained outage. */
export const RECONNECT_MAX_MS = 30_000
/** A link that stayed up at least this long counts as a healthy session. */
export const HEALTHY_SESSION_MS = 10_000
/** A dial that has not reached `open` by now is abandoned and retried (a wedged
 *  or half-open TCP connect would otherwise hang the link forever). */
export const DIAL_TIMEOUT_MS = 20_000
/** An open socket with no inbound frame for this long is a zombie: redial. Sits
 *  well above HEARTBEAT_MS so one late echo cannot trip it. */
export const LIVENESS_TIMEOUT_MS = 70_000

/** True if an open socket has gone silent past `timeoutMs`. Pure. */
export function isTunnelStale(
  lastRecvAt: number,
  now: number,
  timeoutMs: number = LIVENESS_TIMEOUT_MS,
): boolean {
  return now - lastRecvAt > timeoutMs
}

export interface SessionOutcome {
  /** Did the socket actually open this attempt? */
  established: boolean
  /** How long the attempt lasted, in ms (dial -> close). */
  upMs: number
}

export interface ReconnectOpts {
  baseMs?: number
  maxMs?: number
  healthyMs?: number
}

export interface ReconnectPlan {
  /** How long to wait before the next dial. */
  delayMs: number
  /** Backoff value to carry into the next loop iteration. */
  nextBackoffMs: number
  /** Whether this outcome reset the backoff (a healthy session). */
  reset: boolean
}

/**
 * Decide how long to wait before reconnecting, and the backoff to carry forward.
 * Any session that opened and stayed up past `healthyMs` resets the backoff,
 * however it ended (an abnormal close after hours of uptime must not wait the
 * full ceiling). Never-opened or short-lived sessions keep growing it. Pure.
 */
export function planReconnect(
  backoffMs: number,
  outcome: SessionOutcome,
  opts: ReconnectOpts = {},
): ReconnectPlan {
  const baseMs = opts.baseMs ?? RECONNECT_BASE_MS
  const maxMs = opts.maxMs ?? RECONNECT_MAX_MS
  const healthyMs = opts.healthyMs ?? HEALTHY_SESSION_MS

  const healthy = outcome.established && outcome.upMs >= healthyMs
  const delayMs = healthy ? baseMs : Math.min(Math.max(backoffMs, baseMs), maxMs)
  const nextBackoffMs = Math.min(delayMs * 2, maxMs)
  return { delayMs, nextBackoffMs, reset: healthy }
}

/**
 * This bridge's id: the configured value if it slugs to something, else the
 * hostname with a trailing ".local" stripped, else DEFAULT_BRIDGE_ID. Never empty.
 */
export function deriveBridgeId(rawEnv: string | undefined, host: string): string {
  const fromEnv = rawEnv ? slugifyBridgeId(rawEnv) : ''
  if (fromEnv) return fromEnv
  const fromHost = slugifyBridgeId(host.replace(/\.local$/i, ''))
  return fromHost || DEFAULT_BRIDGE_ID
}

export interface HubLinkConfig {
  /** Hub origin, e.g. wss://hub.example.com or ws://127.0.0.1:8787. */
  url: string
  token: string
  bridgeId: string
  /** This computer holds the memory store: the dial adds `memory_home=1` so the hub sends memory calls here. */
  memoryHome?: boolean
  /** The device key that signs each proof (tests); default openDeviceKey() at each dial. */
  key?: DeviceKey
}

/**
 * The `tandem-proof` value for one hub request: `v1 <id> <key> <ts> <nonce> <sig>`, ts = `now`
 * (default this clock), a fresh random nonce on every call, sig over proofText with the host of
 * `url`, METHOD, `path` (no query) and the SHA-256 of `body` (none: zero bytes).
 */
export function hubProofHeader(
  key: Pick<DeviceKey, 'publicKey' | 'sign'>,
  p: { url: string; method: string; path: string; id: string; body?: string | Uint8Array; now?: number },
): string {
  const ts = p.now ?? Date.now()
  const nonce = randomBytes(16).toString('base64url')
  const bodySha256 = createHash('sha256').update(p.body ?? '').digest('hex')
  const text = proofText({ host: new URL(p.url).host, method: p.method.toUpperCase(), path: p.path, id: p.id, key: key.publicKey, ts, nonce, bodySha256 })
  return `v1 ${p.id} ${key.publicKey} ${ts} ${nonce} ${key.sign(text)}`
}

const BAD_CONFIG = 'hub link: bad configuration'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The hub origin, or a throw that never names the value. */
function hubOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(BAD_CONFIG)
  }
  const tlsOrLoopback = url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname))
  // '@', '?' and '#' are checked on the raw text: the parsed URL hides an empty user, query or fragment.
  if (!tlsOrLoopback || /[@?#]/.test(raw) || url.pathname !== '/') throw new Error(BAD_CONFIG)
  return url.origin
}

/**
 * The link settings, or undefined when TANDEM_HUB_LINK_URL is unset. Any bad
 * value throws Error('hub link: bad configuration'), never naming the value.
 */
export function hubLinkConfigFromEnv(env: Record<string, string | undefined>): HubLinkConfig | undefined {
  const raw = (env.TANDEM_HUB_LINK_URL ?? '').trim()
  if (!raw) return undefined
  const url = hubOrigin(raw)
  const token = (env.TANDEM_HUB_LINK_TOKEN ?? '').trim()
  // Visible ASCII only: anything else cannot ride in a header.
  if (!/^[\x21-\x7e]{16,}$/.test(token)) throw new Error(BAD_CONFIG)
  return { url, token, bridgeId: deriveBridgeId(env.TANDEM_HUB_LINK_ID, hostname()) }
}

export type HubRequestHandler = (frame: CcmHttpRequestFrame) => Promise<CcmHttpResponseFrame>

export interface HubLinkTiming {
  baseMs: number
  maxMs: number
  healthyMs: number
  dialTimeoutMs: number
  livenessMs: number
  heartbeatMs: number
}

export interface HubLinkOptions {
  handleRequest?: HubRequestHandler
  /** One line per call; defaults to stderr. Never given the token. */
  log?: (line: string) => void
  timing?: Partial<HubLinkTiming>
}

export interface HubLink {
  close(): Promise<void>
  connected(): boolean
}

function jsonResponse(requestId: string, status: number, body: unknown): CcmHttpResponseFrame {
  return {
    type: CCM_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: status,
    headers: { 'content-type': ['application/json'] },
    body_base64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  }
}

/** Until hub requests are routed, every request is answered 503 bridge_not_ready. */
const notReady: HubRequestHandler = async (frame) => jsonResponse(frame.request_id, 503, { error: 'bridge_not_ready' })

function describeError(ev: unknown): string {
  if (ev instanceof Error) return ev.message
  if (ev && typeof ev === 'object' && 'message' in ev) return String((ev as { message: unknown }).message)
  return String(ev)
}

/** Opens the link and keeps it open until close(). */
export function startHubLink(config: HubLinkConfig, opts: HubLinkOptions = {}): HubLink {
  const origin = hubOrigin(config.url)
  const handleRequest = opts.handleRequest ?? notReady
  const writeLog = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  // The token never reaches a log line, whatever a handler or library error says.
  const log = (line: string) => writeLog(config.token ? line.split(config.token).join('[redacted]') : line)
  let inFlight = 0
  const t: HubLinkTiming = {
    baseMs: RECONNECT_BASE_MS,
    maxMs: RECONNECT_MAX_MS,
    healthyMs: HEALTHY_SESSION_MS,
    dialTimeoutMs: DIAL_TIMEOUT_MS,
    livenessMs: LIVENESS_TIMEOUT_MS,
    heartbeatMs: HEARTBEAT_MS,
    ...opts.timing,
  }
  const dialUrl = `${origin}/__tunnel/connect?bridge_id=${encodeURIComponent(config.bridgeId)}${config.memoryHome ? '&memory_home=1' : ''}`

  let stopped = false
  let isConnected = false
  let endSession: (() => void) | undefined
  let wake: (() => void) | undefined

  // Resolves when the socket is gone, with whether it ever opened. Every exit
  // path goes through settle(), which clears the timers once.
  const connectOnce = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let proof: string
      try {
        proof = hubProofHeader(config.key ?? openDeviceKey(), { url: origin, method: 'GET', path: '/__tunnel/connect', id: config.bridgeId })
      } catch (error) {
        if (!(error instanceof DeviceKeyError)) throw error
        // A failed dial: backoff as for any other.
        log(`hub link: device key: ${error.message}`)
        resolve(false)
        return
      }
      const ws = new WebSocket(dialUrl, CCM_TUNNEL_SUBPROTOCOL, {
        headers: { Authorization: `Bearer ${config.token}`, [PROOF_HEADER]: proof },
        maxPayload: MAX_FRAME_BYTES,
      })
      log(`hub link: dialing ${origin} as ${config.bridgeId}`)
      let dialTimer: ReturnType<typeof setTimeout> | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let liveness: ReturnType<typeof setInterval> | undefined
      let established = false
      let settled = false
      let lastRecvAt = Date.now()

      const send = (frame: CcmFrame) => {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          log('hub link: hub is not reading; reconnecting')
          settle()
          return
        }
        try {
          ws.send(serializeFrame(frame))
        } catch {
          /* socket gone; the close path redials */
        }
      }
      const settle = () => {
        if (settled) return
        settled = true
        isConnected = false
        clearTimeout(dialTimer)
        clearInterval(heartbeat)
        clearInterval(liveness)
        ws.terminate()
        resolve(established)
      }
      endSession = settle

      dialTimer = setTimeout(() => {
        log('hub link: dial timed out before open; retrying')
        settle()
      }, t.dialTimeoutMs)

      ws.on('open', () => {
        established = true
        isConnected = true
        lastRecvAt = Date.now()
        clearTimeout(dialTimer)
        log('hub link: connected; registering')
        send({ type: CCM_FRAME_TYPES.register, bridge_id: config.bridgeId })
        heartbeat = setInterval(() => send({ type: CCM_FRAME_TYPES.heartbeat }), t.heartbeatMs)
        liveness = setInterval(() => {
          if (!isTunnelStale(lastRecvAt, Date.now(), t.livenessMs)) return
          log('hub link: silent past the liveness window; reconnecting')
          settle()
        }, t.heartbeatMs)
      })
      ws.on('message', (data) => {
        lastRecvAt = Date.now()
        const frame = parseAnyFrame(data)
        if (frame?.type !== CCM_FRAME_TYPES.httpRequest) return
        if (inFlight >= MAX_IN_FLIGHT) {
          send(jsonResponse(frame.request_id, 503, { error: 'bridge_busy' }))
          return
        }
        inFlight++
        // Called inside then(): a handler that throws synchronously, or returns a
        // plain value, cannot escape into the socket's event loop and crash the process.
        Promise.resolve()
          .then(() => handleRequest(frame))
          .then(
            (response) => send({ ...response, request_id: frame.request_id }),
            (error: unknown) => {
              log(`hub link: request handler failed: ${describeError(error)}`)
              send(jsonResponse(frame.request_id, 500, { error: 'internal_error' }))
            },
          )
          .finally(() => {
            inFlight--
          })
      })
      ws.on('close', () => {
        if (!settled) log('hub link: closed')
        settle()
      })
      // A listener here means ws leaves the refused handshake to us: settle() aborts it.
      ws.on('unexpected-response', (_request, response) => {
        if (settled) return
        if (response.statusCode === 409) {
          log(`hub link: the hub holds another key for ${config.bridgeId}; this computer cannot connect as ${config.bridgeId}`)
        } else {
          log(`hub link: error: Unexpected server response: ${response.statusCode}`)
        }
        settle()
      })
      ws.on('error', (error) => {
        if (!settled) log(`hub link: error: ${describeError(error)}`)
        settle()
      })
    })

  const loop = (async () => {
    let backoffMs = t.baseMs
    while (!stopped) {
      const startedAt = Date.now()
      let established = false
      try {
        established = await connectOnce()
      } catch (error) {
        log(`hub link: error: ${describeError(error)}`)
      }
      if (stopped) break
      const { delayMs, nextBackoffMs } = planReconnect(backoffMs, { established, upMs: Date.now() - startedAt }, t)
      // Up to 20% off the planned wait, never above it, so bridges dropped together do not redial together.
      const waitMs = Math.round(delayMs * (1 - 0.2 * Math.random()))
      log(`hub link: reconnecting in ${waitMs}ms`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = undefined
      backoffMs = nextBackoffMs
    }
  })()

  return {
    connected: () => isConnected,
    async close() {
      stopped = true
      endSession?.()
      wake?.()
      await loop
    },
  }
}
