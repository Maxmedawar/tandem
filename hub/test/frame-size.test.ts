import { describe, it, expect } from 'vitest'
import {
  classifyInboundFrame,
  extractResponseRequestId,
} from '../src/frame-size.ts'
import { CCM_FRAME_TYPES, serializeFrame } from '../src/protocol.ts'

const LIMIT = 1_048_576

/** Build a serialized response frame whose base64 body inflates it past a
 *  target wire size, so classifyInboundFrame sees it as oversize. */
function oversizeResponseFrame(requestId: string): string {
  // ~1.4MB of body bytes -> well over the 1MB frame limit once serialized.
  const big = 'x'.repeat(1_400_000)
  return serializeFrame({
    type: CCM_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: 200,
    headers: { 'content-type': ['application/json'] },
    body_base64: Buffer.from(big).toString('base64'),
  })
}

describe('classifyInboundFrame oversize policy', () => {
  it('passes a normal-sized response frame (not oversize)', () => {
    const wire = serializeFrame({
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: 'small-1',
      status_code: 200,
      headers: {},
      body_base64: Buffer.from('{"ok":true}').toString('base64'),
    })
    const verdict = classifyInboundFrame(wire, LIMIT)
    expect(verdict.oversize).toBe(false)
    expect(verdict.responseRequestId).toBeUndefined()
  })

  it('flags an oversize RESPONSE frame and recovers its request_id (no close needed)', () => {
    const wire = oversizeResponseFrame('rpc-42')
    const verdict = classifyInboundFrame(wire, LIMIT)
    expect(verdict.oversize).toBe(true)
    // request_id present => caller answers that ONE rpc with 413, socket stays open
    expect(verdict.responseRequestId).toBe('rpc-42')
  })

  it('does not throw on an oversize ArrayBuffer payload', () => {
    const wire = oversizeResponseFrame('rpc-buf')
    const bytes = new TextEncoder().encode(wire)
    const buf = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer
    let verdict!: ReturnType<typeof classifyInboundFrame>
    expect(() => { verdict = classifyInboundFrame(buf, LIMIT) }).not.toThrow()
    expect(verdict.oversize).toBe(true)
    expect(verdict.responseRequestId).toBe('rpc-buf')
  })

  it('oversize non-response frame yields no request_id (caller may close as last resort)', () => {
    // A giant frame that is not a tunnel_http_response.
    const wire = '{"type":"tunnel_register","token":"' + 'z'.repeat(1_300_000) + '"}'
    const verdict = classifyInboundFrame(wire, LIMIT)
    expect(verdict.oversize).toBe(true)
    expect(verdict.responseRequestId).toBeUndefined()
  })
})

describe('extractResponseRequestId', () => {
  it('reads request_id from the head without parsing the whole body', () => {
    expect(extractResponseRequestId(oversizeResponseFrame('abc123'))).toBe('abc123')
  })

  it('handles an escaped request_id', () => {
    const wire = serializeFrame({
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: 'a"b\\c',
      status_code: 200,
      headers: {},
    })
    expect(extractResponseRequestId(wire)).toBe('a"b\\c')
  })

  it('returns undefined for a non-response frame', () => {
    const wire = serializeFrame({ type: CCM_FRAME_TYPES.heartbeat })
    expect(extractResponseRequestId(wire)).toBeUndefined()
  })

  it('returns undefined when request_id is absent', () => {
    expect(extractResponseRequestId('{"type":"tunnel_http_response"}')).toBeUndefined()
  })
})
