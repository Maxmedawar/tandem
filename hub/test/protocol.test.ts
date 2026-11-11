import { describe, it, expect } from 'vitest'
import {
  CCM_FRAME_TYPES,
  parseAnyFrame,
  parseBridgeFrame,
  serializeFrame,
  type CcmBridgeToRelayFrame,
  type CcmFrame,
} from '../src/protocol.ts'

describe('protocol frame round-trip', () => {
  const frames: CcmFrame[] = [
    { type: CCM_FRAME_TYPES.register, token: 'secret', bridge_id: 'mac-1' },
    {
      type: CCM_FRAME_TYPES.httpRequest,
      request_id: 'r1',
      method: 'POST',
      path: '/sessions/open',
      raw_query: 'limit=5',
      headers: { 'content-type': ['application/json'] },
      body_base64: Buffer.from('{"cwd":"/tmp"}').toString('base64'),
    },
    {
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: 'r1',
      status_code: 200,
      headers: { 'content-type': ['application/json'] },
      body_base64: Buffer.from('{"ok":true}').toString('base64'),
    },
    { type: CCM_FRAME_TYPES.heartbeat },
  ]

  for (const frame of frames) {
    it(`round-trips ${frame.type}`, () => {
      const wire = serializeFrame(frame)
      const parsed = parseAnyFrame(wire)
      expect(parsed).toEqual(frame)
    })
  }

  it('round-trips through an ArrayBuffer payload', () => {
    const frame: CcmFrame = { type: CCM_FRAME_TYPES.heartbeat }
    const bytes = new TextEncoder().encode(serializeFrame(frame))
    expect(parseAnyFrame(bytes.buffer)).toEqual(frame)
  })

  it('returns undefined for malformed input', () => {
    expect(parseAnyFrame('not json')).toBeUndefined()
    expect(parseAnyFrame(JSON.stringify({ type: 'bogus' }))).toBeUndefined()
  })

  it('keeps bridge_id on a register frame through serialize -> parse', () => {
    const frame: CcmFrame = {
      type: CCM_FRAME_TYPES.register,
      token: 'secret',
      bridge_id: 'laptop',
    }
    const parsed = parseAnyFrame(serializeFrame(frame))
    expect(parsed).toEqual(frame)
    expect(parsed && 'bridge_id' in parsed ? parsed.bridge_id : undefined).toBe('laptop')
  })
})

describe('parseBridgeFrame round-trip (relay-receivable frames)', () => {
  const frames: CcmBridgeToRelayFrame[] = [
    { type: CCM_FRAME_TYPES.register, token: 'secret', bridge_id: 'mac-1' },
    {
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: 'r1',
      status_code: 200,
      headers: { 'content-type': ['application/json'] },
      body_base64: Buffer.from('{"ok":true}').toString('base64'),
    },
    { type: CCM_FRAME_TYPES.heartbeat },
  ]

  for (const frame of frames) {
    it(`round-trips ${frame.type}`, () => {
      expect(parseBridgeFrame(serializeFrame(frame))).toEqual(frame)
    })
  }

  it('round-trips a response frame through an ArrayBuffer payload', () => {
    const frame: CcmBridgeToRelayFrame = {
      type: CCM_FRAME_TYPES.httpResponse,
      request_id: 'buf-1',
      status_code: 204,
      headers: {},
    }
    const bytes = new TextEncoder().encode(serializeFrame(frame))
    expect(parseBridgeFrame(bytes.buffer)).toEqual(frame)
  })

  it('rejects an http_request frame (bridge must not send requests to relay)', () => {
    const wire = serializeFrame({
      type: CCM_FRAME_TYPES.httpRequest,
      request_id: 'r1',
      method: 'GET',
      path: '/',
      headers: {},
    })
    expect(parseBridgeFrame(wire)).toBeUndefined()
  })

  it('returns undefined for malformed input', () => {
    expect(parseBridgeFrame('not json')).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ type: 'bogus' }))).toBeUndefined()
  })
})
