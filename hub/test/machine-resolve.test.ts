import { describe, it, expect } from 'vitest'
// Pure machine-selection logic lives in src/machine-resolve.ts (no
// cloudflare:workers import) so it runs in the plain-node vitest env — the same
// split as src/frame-size.ts, src/bridge-id.ts and src/tunnel-routing.ts. The
// MCP layer (CloudCodeMcp.rpc) is a thin adapter that fetches the connected list
// from the DO /__status route, calls these, then sets the x-ccm-bridge-id header.
import {
  resolveDefaultMachine,
  formatOfflineMessage,
  formatAmbiguousMessage,
  isOfflineError,
} from '../src/machine-resolve.ts'

describe('resolveDefaultMachine', () => {
  it('1. no machines connected -> none', () => {
    expect(resolveDefaultMachine([], 'mini')).toEqual({ kind: 'none' })
  })

  it('2. single connected wins even when it is not the default', () => {
    expect(resolveDefaultMachine(['macbook'], 'mini')).toEqual({ kind: 'ok', target: 'macbook' })
  })

  it('3. multiple connected, default present -> default', () => {
    expect(resolveDefaultMachine(['mini', 'macbook'], 'mini')).toEqual({ kind: 'ok', target: 'mini' })
  })

  it('4. multiple connected, default absent -> ambiguous (lists connected)', () => {
    expect(resolveDefaultMachine(['mini', 'macbook'], 'studio')).toEqual({
      kind: 'ambiguous',
      connected: ['mini', 'macbook'],
    })
  })

  it('5. single connected equal to default -> ok', () => {
    expect(resolveDefaultMachine(['mini'], 'mini')).toEqual({ kind: 'ok', target: 'mini' })
  })

  it('6. lone old-bridge "default" still resolves', () => {
    expect(resolveDefaultMachine(['default'], 'mini')).toEqual({ kind: 'ok', target: 'default' })
  })
})

describe('formatOfflineMessage', () => {
  it('7. names the requested machine and lists what is connected', () => {
    const msg = formatOfflineMessage('macbook', ['mini'])
    expect(msg).toContain('macbook')
    expect(msg).toContain('mini')
  })

  it('8. handles an empty connected list', () => {
    const msg = formatOfflineMessage('macbook', [])
    expect(msg).toContain('macbook')
    expect(msg.toLowerCase()).toContain('no machines')
  })
})

describe('formatAmbiguousMessage', () => {
  it('9. lists connected machines and notes the default is not among them', () => {
    const msg = formatAmbiguousMessage(['mini', 'macbook'], 'studio')
    expect(msg).toContain('mini')
    expect(msg).toContain('macbook')
    expect(msg).toContain('studio')
  })
})

describe('isOfflineError', () => {
  it('10. recognises the DO bridge_offline body', () => {
    expect(isOfflineError({ error: 'bridge_offline', requested: 'x', connected: [] })).toBe(true)
  })

  it('11. rejects other shapes', () => {
    expect(isOfflineError({ error: 'gateway_timeout' })).toBe(false)
    expect(isOfflineError(null)).toBe(false)
    expect(isOfflineError('bridge_offline')).toBe(false)
    expect(isOfflineError({})).toBe(false)
  })
})
