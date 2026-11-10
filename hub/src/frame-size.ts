/**
 * Pure frame-size policy helpers for the tunnel.
 *
 * Split out of tunnel-do.ts so they carry NO `cloudflare:workers` import and
 * can be unit-tested in plain Node/vitest. tunnel-do.ts re-exports these.
 *
 * Why this matters: an oversize bridge->Worker RESPONSE frame must NOT trip the
 * 1009 oversize WebSocket close (that close kills the tunnel for EVERY session).
 * Instead the relay identifies which RPC the oversize frame answers and fails
 * just that one request with a clean 413, leaving the socket open.
 */

import { CCM_FRAME_TYPES } from './protocol'

/** Shared tunnel frame ceiling. Exported so bridge-path regressions exercise the
 * exact relay policy rather than duplicating a magic number that can drift. */
export const WS_MAX_FRAME_BYTES = 1_048_576

/** Verdict for an inbound WS frame's size. Pure so the oversize policy is
 *  unit-testable without spinning up a Durable Object / socket. */
export interface FrameSizeVerdict {
  /** True when the serialized frame exceeds the WS frame limit. */
  oversize: boolean
  /** When oversize, the request_id to fail with 413 if this is a parseable
   *  response frame — letting us answer the MCP caller WITHOUT closing the
   *  whole tunnel. undefined => not a recoverable response (caller may close). */
  responseRequestId?: string
}

/** Conservative byte length of a WS payload (string measured as UTF-16 *4 to
 *  stay an upper bound vs the actual UTF-8 encoding). */
export function byteLengthOf(message: string | ArrayBuffer): number {
  return typeof message === 'string' ? message.length * 4 : message.byteLength
}

/** Decode at most `maxChars` leading characters of a frame for cheap header
 *  scanning, without materializing a huge oversize body. */
export function headOf(message: string | ArrayBuffer, maxChars: number): string {
  if (typeof message === 'string') return message.slice(0, maxChars)
  const view = new Uint8Array(message, 0, Math.min(message.byteLength, maxChars))
  return new TextDecoder('utf-8').decode(view)
}

/** Decide what to do with an inbound bridge frame purely from its raw payload
 *  and the byte limit. Does NOT close sockets or touch state. */
export function classifyInboundFrame(
  message: string | ArrayBuffer,
  limitBytes: number,
): FrameSizeVerdict {
  if (byteLengthOf(message) <= limitBytes) return { oversize: false }
  return { oversize: true, responseRequestId: extractResponseRequestId(message) }
}

/** Best-effort request_id extraction from a (possibly oversize) response frame
 *  without JSON-parsing the entire blob. Returns undefined if the frame is not
 *  a tunnel_http_response or no request_id can be read. The bridge serializes
 *  request_id ahead of the (large) body_base64 field, so a short head scan
 *  finds it. */
export function extractResponseRequestId(message: string | ArrayBuffer): string | undefined {
  const head = headOf(message, 4096)
  if (!head.includes(`"${CCM_FRAME_TYPES.httpResponse}"`)) return undefined
  const match = head.match(/"request_id"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return undefined
  }
}
