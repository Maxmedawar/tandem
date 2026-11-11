/**
 * tandem tunnel wire protocol.
 *
 * Derived from a mobile-bridge relay protocol (MIT, Vellum-pattern),
 * simplified to the only thing this MVP needs: HTTP-style request/response
 * forwarding between the Cloudflare Worker and the single Mac bridge, plus
 * register + heartbeat. No phone/websocket-tunneling frames.
 *
 * Direction conventions:
 *   Worker (TunnelDO) -> bridge:  tunnel_register (ack), tunnel_http_request, tunnel_heartbeat
 *   bridge -> Worker (TunnelDO):  tunnel_register (initial, carries token), tunnel_http_response, tunnel_heartbeat
 *
 * Wire format: JSON text frames over WebSocket. Binary bodies ride as base64.
 */

import { z } from 'zod'
import { FABRIC_MCP_TRUST } from '../../src/fabric/rpc-contract.ts'

/** WebSocket subprotocol negotiated on connect. */
export const CCM_TUNNEL_SUBPROTOCOL = 'tandem-tunnel-v1'

export const CCM_FRAME_TYPES = {
  register: 'tunnel_register',
  httpRequest: 'tunnel_http_request',
  httpResponse: 'tunnel_http_response',
  heartbeat: 'tunnel_heartbeat',
} as const

/** HTTP-style multi-valued headers carried on the wire. */
export type CcmHeaders = Record<string, string[]>

const headersSchema = z.record(z.string(), z.array(z.string()))

const registerFrameSchema = z.object({
  type: z.literal(CCM_FRAME_TYPES.register),
  token: z.string().optional(),
  bridge_id: z.string().optional(),
})

const httpRequestFrameSchema = z.object({
  type: z.literal(CCM_FRAME_TYPES.httpRequest),
  request_id: z.string(),
  method: z.string(),
  path: z.string(),
  raw_query: z.string().optional(),
  headers: headersSchema,
  body_base64: z.string().optional(),
  /** Set only by TunnelDO on its /__fabric-rpc route; the bridge's fabric router requires it. */
  trusted_surface: z.literal(FABRIC_MCP_TRUST).optional(),
})

const httpResponseFrameSchema = z.object({
  type: z.literal(CCM_FRAME_TYPES.httpResponse),
  request_id: z.string(),
  status_code: z.number().int().nonnegative(),
  headers: headersSchema.optional(),
  body_base64: z.string().optional(),
})

const heartbeatFrameSchema = z.object({
  type: z.literal(CCM_FRAME_TYPES.heartbeat),
})

/** Frames the relay (TunnelDO) expects to receive from the bridge. */
const bridgeToRelayFrameSchema = z.discriminatedUnion('type', [
  registerFrameSchema,
  httpResponseFrameSchema,
  heartbeatFrameSchema,
])

const anyFrameSchema = z.discriminatedUnion('type', [
  registerFrameSchema,
  httpRequestFrameSchema,
  httpResponseFrameSchema,
  heartbeatFrameSchema,
])

export type CcmRegisterFrame = z.infer<typeof registerFrameSchema>
export type CcmHttpRequestFrame = z.infer<typeof httpRequestFrameSchema>
export type CcmHttpResponseFrame = z.infer<typeof httpResponseFrameSchema>
export type CcmHeartbeatFrame = z.infer<typeof heartbeatFrameSchema>
export type CcmBridgeToRelayFrame = z.infer<typeof bridgeToRelayFrameSchema>
export type CcmFrame = z.infer<typeof anyFrameSchema>

/** Parse a raw WS payload into a frame the relay can legitimately receive.
 *  Returns undefined for malformed input — caller treats as a soft drop. */
export function parseBridgeFrame(data: unknown): CcmBridgeToRelayFrame | undefined {
  const raw = decodeWebSocketData(data)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = bridgeToRelayFrameSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/** Parse any frame (used by the bridge side, which receives http_request). */
export function parseAnyFrame(data: unknown): CcmFrame | undefined {
  const raw = decodeWebSocketData(data)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = anyFrameSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

export function serializeFrame(frame: CcmFrame): string {
  return JSON.stringify(frame)
}

function decodeWebSocketData(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder('utf-8').decode(data)
  return undefined
}
