/**
 * TunnelDO — singleton Durable Object that owns the Mac bridge's outbound
 * WebSocket and forwards MCP->bridge RPC as HTTP-style frames.
 *
 * Derived (simplified, single-user) from a mobile-bridge relay/tunnel-do.ts.
 * Responsibilities: accept the bridge WS via the Hibernation API; on each
 * forwarded RPC request assign a request_id, frame it as tunnel_http_request,
 * await the matching tunnel_http_response (timeout), return it. On bridge
 * disconnect, fail all in-flight requests.
 *
 * Routes (Worker forwards here via a stub):
 *   /__tunnel/connect   -> bridge WebSocket upgrade (token already checked by Worker)
 *   /__rpc/<path>       -> forward to the bridge as an HTTP request frame
 */

import { DurableObject } from 'cloudflare:workers'
import {
  CCM_FRAME_TYPES,
  CCM_TUNNEL_SUBPROTOCOL,
  parseBridgeFrame,
  serializeFrame,
  type CcmHeaders,
  type CcmHttpRequestFrame,
  type CcmHttpResponseFrame,
  type CcmRegisterFrame,
} from './protocol'
import {
  classifyInboundFrame,
  extractResponseRequestId,
  WS_MAX_FRAME_BYTES,
  type FrameSizeVerdict,
} from './frame-size'
import { sanitizeBridgeId, DEFAULT_BRIDGE_ID } from './bridge-id'
import {
  selectSocketIndex,
  socketsToEvict,
  dedupeConnectedIds,
  type SocketInfo,
} from './tunnel-routing'
import type { Env } from './types'

// Re-exported so tests and other modules can reach the pure size policy via the
// tunnel module too (the canonical home is ./frame-size).
export { classifyInboundFrame, extractResponseRequestId }
export type { FrameSizeVerdict }

// Re-exported so callers can reach the pure id policy via the tunnel module too
// (the canonical home is ./bridge-id).
export { sanitizeBridgeId }

/** RPC turns can be long (a Claude Code turn). Allow up to 110s — below
 *  Cloudflare's request ceiling, above a typical short turn. Long autonomous
 *  work is handled by the bridge returning {status:"running"} quickly. */
const RPC_TIMEOUT_MS = 110_000
const POLICY_CLOSE_OVERSIZE = 1009
const POLICY_CLOSE_BAD_FRAME = 4002
const POLICY_CLOSE_REPLACED = 4003
const REQUEST_ID_BYTES = 16
const WS_READY_STATE_OPEN = 1

/** Hibernation tag prefix carrying a socket's bridge_id (survives hibernation). */
const BRIDGE_TAG_PREFIX = 'bid:'

const HOP_BY_HOP = new Set<string>([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

interface PendingRequest {
  resolve: (response: Response) => void
  timeoutTimer: ReturnType<typeof setTimeout>
  settled: boolean
}

export class TunnelDO extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    for (const ws of this.ctx.getWebSockets()) void ws
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__tunnel/connect') return this.handleTunnelUpgrade(request, url)
    if (url.pathname.startsWith('/__rpc/')) return this.handleRpc(request, url, '/__rpc')
    // Read-only: which machines are connected. Backs MCP default resolution +
    // the list_machines tool. Only reachable via the DO stub (never forwarded by
    // the public Worker), so no auth needed.
    if (url.pathname === '/__status') return json({ connected: this.listConnectedBridgeIds() }, 200)
    return new Response('not found', { status: 404 })
  }

  /* ---- Mac side: accept the bridge's outbound WebSocket ---- */

  private handleTunnelUpgrade(request: Request, url: URL): Response {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    // Capture which Mac this socket belongs to from the upgrade URL, before any
    // frame arrives. Missing/garbage (e.g. an old bridge) -> DEFAULT_BRIDGE_ID.
    const bridgeId = sanitizeBridgeId(url.searchParams.get('bridge_id'))

    // Replace ONLY this machine's existing open socket(s) — the same machine
    // reconnecting supersedes itself. Sockets for OTHER bridge_ids stay open so
    // multiple Macs can be connected at once. Eviction runs BEFORE acceptWebSocket
    // so the incoming socket is not yet in getWebSockets() and can't evict itself.
    const { wsList, infos } = this.listSockets()
    for (const idx of socketsToEvict(infos, bridgeId)) {
      try { wsList[idx].close(POLICY_CLOSE_REPLACED, 'tunnel replaced') } catch { /* best effort */ }
    }

    // Tag the socket with its bridge_id so the id survives hibernation; RPCs are
    // routed by reading this tag back (getSocketFor / listConnectedBridgeIds).
    this.ctx.acceptWebSocket(server, [CCM_TUNNEL_SUBPROTOCOL, `${BRIDGE_TAG_PREFIX}${bridgeId}`])

    const ack: CcmRegisterFrame = { type: CCM_FRAME_TYPES.register }
    try { server.send(serializeFrame(ack)) } catch { /* close handler cleans up */ }

    // Echo the negotiated subprotocol back in the handshake. Cloudflare's
    // acceptWebSocket(ws, tags) second arg is hibernation TAGS, not the WS
    // subprotocol — so we must set Sec-WebSocket-Protocol ourselves or a client
    // that requested a subprotocol rejects with "did not respond with sent protocols".
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': CCM_TUNNEL_SUBPROTOCOL },
    })
  }

  /* ---- Hibernation hooks ---- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const verdict = classifyInboundFrame(message, WS_MAX_FRAME_BYTES)
    if (verdict.oversize) {
      // An oversize bridge->Worker RESPONSE must not kill the tunnel. If we can
      // identify which RPC it answers, fail just that one with a clean 413 and
      // leave the socket open for every other session. Only close as a last
      // resort when the oversize frame isn't a recoverable response.
      if (verdict.responseRequestId !== undefined) {
        this.failPending(verdict.responseRequestId, 413, 'payload_too_large')
        return
      }
      try { ws.close(POLICY_CLOSE_OVERSIZE, 'frame too large') } catch { /* ignore */ }
      return
    }
    const frame = parseBridgeFrame(message)
    if (!frame) {
      try { ws.close(POLICY_CLOSE_BAD_FRAME, 'malformed frame') } catch { /* ignore */ }
      return
    }
    switch (frame.type) {
      case CCM_FRAME_TYPES.register:
        return
      case CCM_FRAME_TYPES.heartbeat:
        try { ws.send(serializeFrame({ type: CCM_FRAME_TYPES.heartbeat })) } catch { /* ignore */ }
        return
      case CCM_FRAME_TYPES.httpResponse:
        this.completePending(frame)
        return
      default:
        return
    }
  }

  async webSocketClose(): Promise<void> {
    this.failAllPending(503, 'bridge_offline')
  }

  async webSocketError(): Promise<void> {
    this.failAllPending(503, 'bridge_offline')
  }

  /* ---- MCP side: forward an RPC to the bridge ---- */

  private async handleRpc(
    request: Request,
    url: URL,
    prefix: '/__rpc',
  ): Promise<Response> {
    const path = url.pathname.slice(prefix.length) || '/'

    // Optional target machine. Header absent -> undefined -> unchanged single-socket
    // behavior (first open socket). Present -> sanitize so it matches the stored
    // (sanitized) bid: tag.
    const rawTarget = request.headers.get('x-ccm-bridge-id')
    const target = rawTarget ? sanitizeBridgeId(rawTarget) : undefined

    const socket = this.getSocketFor(target)
    if (!socket) {
      // Only name the requested machine (and who IS connected) when a specific
      // target was asked for; otherwise stay byte-for-byte identical to today.
      if (target) {
        return json(
          { error: 'bridge_offline', requested: target, connected: this.listConnectedBridgeIds() },
          503,
        )
      }
      return json({ error: 'bridge_offline' }, 503)
    }
    const requestId = randomRequestId()
    const buf = await request.arrayBuffer()
    if (buf.byteLength > WS_MAX_FRAME_BYTES) return json({ error: 'payload_too_large' }, 413)
    const body = buf.byteLength > 0 ? base64Encode(buf) : undefined

    const frame: CcmHttpRequestFrame = {
      type: CCM_FRAME_TYPES.httpRequest,
      request_id: requestId,
      method: request.method,
      path,
      raw_query: url.search ? url.search.replace(/^\?/, '') : undefined,
      headers: headersToTunnel(request.headers),
      ...(body !== undefined ? { body_base64: body } : {}),
    }

    const responsePromise = this.awaitResponse(requestId)
    try {
      socket.send(serializeFrame(frame))
    } catch {
      this.failPending(requestId, 503, 'bridge_send_failed')
    }
    return responsePromise
  }

  /** Read the bid: hibernation tag back off a live socket. */
  private bridgeIdOf(ws: WebSocket): string {
    for (const tag of this.ctx.getTags(ws)) {
      if (tag.startsWith(BRIDGE_TAG_PREFIX)) return tag.slice(BRIDGE_TAG_PREFIX.length)
    }
    return DEFAULT_BRIDGE_ID // socket somehow untagged -> treat as default
  }

  /** Snapshot the live sockets alongside the plain {bridgeId, isOpen} view the
   *  pure routing functions consume. The two arrays are index-parallel. */
  private listSockets(): { wsList: WebSocket[]; infos: SocketInfo[] } {
    const wsList = this.ctx.getWebSockets()
    const infos = wsList.map((ws) => ({
      bridgeId: this.bridgeIdOf(ws),
      isOpen: ws.readyState === WS_READY_STATE_OPEN,
    }))
    return { wsList, infos }
  }

  /** Resolve which bridge socket an RPC should go to. No target -> first open
   *  socket (identical to the old getActiveSocket). Target -> the open socket
   *  whose bid: tag matches, or null if that machine is offline. */
  private getSocketFor(targetBridgeId?: string): WebSocket | null {
    const { wsList, infos } = this.listSockets()
    const idx = selectSocketIndex(infos, targetBridgeId)
    return idx >= 0 ? wsList[idx] : null
  }

  /** Deduped bridge_ids of all currently-open sockets. Backs the bridge_offline
   *  error body and a Phase 3 status/list tool. */
  private listConnectedBridgeIds(): string[] {
    return dedupeConnectedIds(this.listSockets().infos)
  }

  private awaitResponse(requestId: string): Promise<Response> {
    return new Promise<Response>((resolve) => {
      const timeoutTimer = setTimeout(() => {
        const p = this.pending.get(requestId)
        if (!p || p.settled) return
        p.settled = true
        this.pending.delete(requestId)
        resolve(json({ error: 'gateway_timeout' }, 504))
      }, RPC_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timeoutTimer, settled: false })
    })
  }

  private completePending(frame: CcmHttpResponseFrame): void {
    const p = this.pending.get(frame.request_id)
    if (!p || p.settled) return
    p.settled = true
    clearTimeout(p.timeoutTimer)
    this.pending.delete(frame.request_id)
    const headers = tunnelHeadersToFetch(frame.headers ?? {})
    const body = frame.body_base64 ? base64Decode(frame.body_base64) : undefined
    p.resolve(new Response(body, { status: frame.status_code, headers }))
  }

  private failPending(requestId: string, status: number, code: string): void {
    const p = this.pending.get(requestId)
    if (!p || p.settled) return
    p.settled = true
    clearTimeout(p.timeoutTimer)
    this.pending.delete(requestId)
    p.resolve(json({ error: code }, status))
  }

  private failAllPending(status: number, code: string): void {
    for (const [id, p] of this.pending) {
      if (p.settled) continue
      p.settled = true
      clearTimeout(p.timeoutTimer)
      p.resolve(json({ error: code }, status))
      this.pending.delete(id)
    }
  }
}

/* ---- helpers ---- */

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function randomRequestId(): string {
  const bytes = new Uint8Array(REQUEST_ID_BYTES)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function headersToTunnel(headers: Headers): CcmHeaders {
  const out: CcmHeaders = {}
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (!out[lower]) out[lower] = []
    out[lower].push(value)
  }
  return out
}

function tunnelHeadersToFetch(headers: CcmHeaders): Headers {
  const out = new Headers()
  for (const [name, values] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    for (const v of values) out.append(name, v)
  }
  return out
}

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
