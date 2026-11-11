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
 *   /__tunnel/connect   -> bridge WebSocket upgrade (token and device proof already checked by
 *                          the Worker through checkDevice, so the id is bound to this key)
 *   /__rpc/<path>       -> forward to the bridge as an HTTP request frame
 *   /__fabric-rpc/fabric/<path> -> the same, marked with trusted_surface, always to the
 *                          memory home (the one socket tagged memory-home whose id and proven key
 *                          are an entry of the roster the hub holds, checked here by
 *                          ./roster-verify; any other path under it is 404, nothing sent).
 *                          Callers: TandemMcp's fabric tools and the hub link route for fabric
 *                          calls (index.ts).
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
import { HubQueue, type PutResult, type QueuedCopy, type QueueMessage } from './queue'
import { HubDevices, PROOF_HEADER, PROOF_WINDOW_MS, parseProof, verifyProof, type ProofContext } from './devices'
import { RosterStore, type OfferAnswer, type PutAnswer } from './roster-store'
import { verifyRosterText } from './roster-verify'
import type { Env } from './types'
import { FABRIC_MCP_TRUST } from '../../src/fabric/rpc-contract.ts'

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
/** Hibernation tag of a socket whose bridge holds the memory store (dialled with memory_home=1). */
const MEMORY_HOME_TAG = 'memory-home'
/** Hibernation tag prefix carrying the device key the socket's connect proof was signed by. */
const KEY_TAG_PREFIX = 'dk:'
const MEMORY_HOME_OFFLINE = {
  error: 'memory_home_offline',
  message: 'memory home offline: the computer that holds memory is not connected to the hub',
}
const NOT_IN_ROSTER = {
  error: 'memory_home_not_in_roster',
  message: 'memory home not in roster: the computer that holds memory is not in the roster the hub holds; trust it from a computer in the roster',
}

const HOP_BY_HOP = new Set<string>([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

interface PendingRequest {
  resolve: (response: Response) => void
  timeoutTimer: ReturnType<typeof setTimeout>
  settled: boolean
  /** The socket the request was sent on: only a frame from it answers (or fails) the call. */
  socket: WebSocket
  /** A fabric call: the home socket it was sent on. Losing that one (closed, send failed)
   *  answers memory_home_offline; another computer's socket closing leaves the call waiting. */
  home?: WebSocket
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
    if (url.pathname.startsWith('/__fabric-rpc/')) {
      if (!url.pathname.startsWith('/__fabric-rpc/fabric/')) return new Response('not found', { status: 404 })
      return this.handleFabricRpc(request, url)
    }
    if (url.pathname.startsWith('/__rpc/')) return this.handleRpc(request, url, '/__rpc')
    // Read-only: which machines are connected. Backs MCP default resolution +
    // the list_machines tool. Only reachable via the DO stub (never forwarded by
    // the public Worker), so no auth needed.
    if (url.pathname === '/__status') return json({ connected: this.listConnectedBridgeIds() }, 200)
    return new Response('not found', { status: 404 })
  }

  /* ---- Durable queue per receiving computer (./queue) ---- */
  // ponytail: no caller until U-R1A-33 (mail across computers). Durable Object RPC
  // only: no route, frame type or MCP tool reaches these.

  private queue?: HubQueue

  private hubQueue(): HubQueue {
    return (this.queue ??= new HubQueue(this.ctx.storage.sql, Date.now, (fn) => this.ctx.storage.transactionSync(fn)))
  }

  queuePut(msg: QueueMessage): PutResult[] {
    return this.hubQueue().put(msg)
  }

  queueTake(to: string, afterSeq?: number, limit?: number, maxBytes?: number): QueuedCopy[] {
    return this.hubQueue().take(to, afterSeq, limit, maxBytes)
  }

  queueAck(to: string, uptoSeq: number): void {
    this.hubQueue().ack(to, uptoSeq)
  }

  /* ---- Per-computer hub credentials (./devices) ---- */

  private devices?: HubDevices

  private hubDevices(): HubDevices {
    return (this.devices ??= new HubDevices(this.ctx.storage.sql, Date.now, (fn) => this.ctx.storage.transactionSync(fn)))
  }

  /**
   * The one check of a `tandem-proof` header for both link routes (index.ts), in this order:
   * no header or a malformed one, a `queryId` that is not exactly the proof's id, a ts more than
   * PROOF_WINDOW_MS from the hub's clock, or a bad signature: 401. Then, synchronously after the
   * signature check so a check-and-bind never interleaves with another: admit. 'ok'/'bound' 200
   * (with the proof's id and key: the roster routes act for that computer), 'replay'/'unknown'
   * 401, 'taken' 409, 'slow' 429 (MAX_PROOFS_PER_ID, ./devices), 'full' 503.
   */
  async checkDevice(
    value: string | null,
    ctx: ProofContext & { queryId?: string; mayBind: boolean },
  ): Promise<{ status: 200; id: string; key: string } | { status: 401 | 409 | 429 | 503 }> {
    const proof = parseProof(value)
    if (!proof) return { status: 401 }
    if (ctx.queryId !== undefined && ctx.queryId !== proof.id) return { status: 401 }
    if (Math.abs(Date.now() - proof.ts) > PROOF_WINDOW_MS) return { status: 401 }
    const { host, method, path, bodySha256 } = ctx
    if (!(await verifyProof(proof, { host, method, path, bodySha256 }))) return { status: 401 }
    switch (this.hubDevices().admit(proof.id, proof.key, proof.nonce, ctx.mayBind)) {
      case 'ok':
      case 'bound':
        return { status: 200, id: proof.id, key: proof.key }
      case 'taken':
        return { status: 409 }
      case 'slow':
        return { status: 429 }
      case 'full':
        return { status: 503 }
      default:
        return { status: 401 }
    }
  }

  /* ---- The owner's roster and the pairing offers (./roster-store; routes in index.ts) ---- */

  private rosters?: RosterStore

  private rosterStore(): RosterStore {
    return (this.rosters ??= new RosterStore(this.ctx.storage.sql, Date.now, (fn) => this.ctx.storage.transactionSync(fn)))
  }

  rosterGet(): { len: number; roster: string } | undefined {
    return this.rosterStore().get()
  }

  /** The last roster text checked and its entries (undefined when refused), kept until another text is checked. */
  private members?: { text: string; entries: { id: string; key: string }[] | undefined }

  /** verifyRosterText (./roster-verify) of `text`, cached by its exact bytes. */
  private async verified(text: string): Promise<{ id: string; key: string }[] | undefined> {
    if (this.members?.text !== text) this.members = { text, entries: await verifyRosterText(text) }
    return this.members.entries
  }

  /** The entries of the stored roster when its whole chain checks out (./roster-verify), else none. */
  private async rosterMembers(): Promise<{ id: string; key: string }[]> {
    const text = this.rosterGet()?.roster
    return text === undefined ? [] : ((await this.verified(text)) ?? [])
  }

  /**
   * The store's answer and the length it holds after it (0 when none). The store keeps only an
   * upload whose whole chain checks out (putChecked, through the same cache as rosterMembers: an
   * accepted upload is then the stored text, checked once).
   */
  async rosterPut(senderId: string, senderKey: string, base: number, rosterText: string): Promise<{ answer: PutAnswer; len: number }> {
    const answer = await this.rosterStore().putChecked(senderId, senderKey, base, rosterText, (text) => this.verified(text))
    return { answer, len: this.rosterStore().get()?.len ?? 0 }
  }

  rosterPostOffer(senderId: string, senderKey: string, offerText: string): OfferAnswer {
    return this.rosterStore().postOffer(senderId, senderKey, offerText)
  }

  rosterOffers(): string[] {
    return this.rosterStore().offers()
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
    // routed by reading this tag back (getSocketFor / listConnectedBridgeIds). The key of the
    // proof the Worker accepted (over this very path and query) is kept beside it. A bridge
    // with the memory store also gets the memory-home tag (handleFabricRpc).
    const tags = [CCM_TUNNEL_SUBPROTOCOL, `${BRIDGE_TAG_PREFIX}${bridgeId}`]
    const proof = parseProof(request.headers.get(PROOF_HEADER))
    if (proof) tags.push(`${KEY_TAG_PREFIX}${proof.key}`)
    if (url.searchParams.get('memory_home') === '1') tags.push(MEMORY_HOME_TAG)
    this.ctx.acceptWebSocket(server, tags)

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
        this.failPending(verdict.responseRequestId, 413, 'payload_too_large', ws)
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
        this.completePending(frame, ws)
        return
      default:
        return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.failAllPending(503, 'bridge_offline', ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.failAllPending(503, 'bridge_offline', ws)
  }

  /* ---- MCP side: forward an RPC to the bridge ---- */

  /**
   * A fabric call goes to the memory home whatever machine header it carries: the one
   * bridge id among the open memory-home sockets whose id and proven key are one entry of
   * the roster the hub holds (its chain checked here, at each call). No memory-home socket:
   * 503 memory_home_offline; some, none in the roster: 503 memory_home_not_in_roster. Two or
   * more ids in the roster: 409 memory_home_conflict and nothing is sent. A socket not in the
   * roster is never sent a frame. Same id twice cannot happen for long (a redial evicts the
   * older socket); the newest open one is used.
   */
  private async handleFabricRpc(request: Request, url: URL): Promise<Response> {
    const open = this.ctx.getWebSockets(MEMORY_HOME_TAG).filter((ws) => ws.readyState === WS_READY_STATE_OPEN)
    if (open.length === 0) return json(MEMORY_HOME_OFFLINE, 503)
    const members = await this.rosterMembers()
    const homes = open.filter((ws) => {
      const id = this.bridgeIdOf(ws)
      const key = this.keyOf(ws)
      return members.some((m) => m.id === id && m.key === key)
    })
    const ids = [...new Set(homes.map((ws) => this.bridgeIdOf(ws)))].sort()
    if (ids.length === 0) return json(NOT_IN_ROSTER, 503)
    if (ids.length > 1) {
      return json({
        error: 'memory_home_conflict',
        machines: ids,
        message: `more than one computer holds a memory store (${ids.join(', ')}); turn the store off on all but one`,
      }, 409)
    }
    return this.forward(request, url, '/__fabric-rpc', homes[homes.length - 1], FABRIC_MCP_TRUST)
  }

  private async handleRpc(request: Request, url: URL, prefix: '/__rpc'): Promise<Response> {
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
    return this.forward(request, url, prefix, socket)
  }

  /** Frame the request as tunnel_http_request, send it on `socket`, await the answer. */
  private async forward(
    request: Request,
    url: URL,
    prefix: '/__rpc' | '/__fabric-rpc',
    socket: WebSocket,
    trustedSurface?: typeof FABRIC_MCP_TRUST,
  ): Promise<Response> {
    const path = url.pathname.slice(prefix.length) || '/'
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
      ...(trustedSurface === undefined ? {} : { trusted_surface: trustedSurface }),
    }
    // Measured after base64 and serialization: a frame over the bridge's cap would
    // drop the bridge's socket and every session on it.
    const serialized = serializeFrame(frame)
    if (new TextEncoder().encode(serialized).byteLength > WS_MAX_FRAME_BYTES) {
      return json({ error: 'payload_too_large' }, 413)
    }

    const responsePromise = this.awaitResponse(requestId, socket, trustedSurface !== undefined)
    try {
      socket.send(serialized)
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

  /** Read the dk: hibernation tag back off a live socket (undefined when untagged). */
  private keyOf(ws: WebSocket): string | undefined {
    for (const tag of this.ctx.getTags(ws)) {
      if (tag.startsWith(KEY_TAG_PREFIX)) return tag.slice(KEY_TAG_PREFIX.length)
    }
    return undefined
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

  /** A call sent on `socket`; a fabric call (`fabric`) also has it as its home. */
  private awaitResponse(requestId: string, socket: WebSocket, fabric: boolean): Promise<Response> {
    return new Promise<Response>((resolve) => {
      const timeoutTimer = setTimeout(() => {
        const p = this.pending.get(requestId)
        if (!p || p.settled) return
        p.settled = true
        this.pending.delete(requestId)
        resolve(json({ error: 'gateway_timeout' }, 504))
      }, RPC_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timeoutTimer, settled: false, socket, home: fabric ? socket : undefined })
    })
  }

  /** `frame` answers its call only when it came on the socket the call was sent on. */
  private completePending(frame: CcmHttpResponseFrame, from: WebSocket): void {
    const p = this.pending.get(frame.request_id)
    if (!p || p.settled || p.socket !== from) return
    p.settled = true
    clearTimeout(p.timeoutTimer)
    this.pending.delete(frame.request_id)
    const headers = tunnelHeadersToFetch(frame.headers ?? {})
    const body = frame.body_base64 ? base64Decode(frame.body_base64) : undefined
    p.resolve(new Response(body, { status: frame.status_code, headers }))
  }

  /** Fail one call; with `from` (a frame that came in), only when it came on the call's own socket. */
  private failPending(requestId: string, status: number, code: string, from?: WebSocket): void {
    const p = this.pending.get(requestId)
    if (!p || p.settled || (from !== undefined && p.socket !== from)) return
    p.settled = true
    clearTimeout(p.timeoutTimer)
    this.pending.delete(requestId)
    p.resolve(failure(p, status, code))
  }

  /** `closed` went away: every /__rpc call fails as before (U-R1A-33 owns that), a fabric call only if `closed` was its home. */
  private failAllPending(status: number, code: string, closed: WebSocket): void {
    for (const [id, p] of this.pending) {
      if (p.settled || (p.home && p.home !== closed)) continue
      p.settled = true
      clearTimeout(p.timeoutTimer)
      p.resolve(failure(p, status, code))
      this.pending.delete(id)
    }
  }
}

/* ---- helpers ---- */

/** A fabric call that lost its home (503) says so; every other failure keeps its code. */
function failure(p: PendingRequest, status: number, code: string): Response {
  return p.home && status === 503 ? json(MEMORY_HOME_OFFLINE, 503) : json({ error: code }, status)
}

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
