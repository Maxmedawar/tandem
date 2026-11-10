import { describe, it, expect } from 'vitest'
// sanitizeBridgeId lives in the pure src/bridge-id.ts module (and is re-exported
// from src/tunnel-do.ts). Tests import the pure module directly because
// tunnel-do.ts pulls in `cloudflare:workers`, which the node test env can't load
// — the same pattern test/frame-size.test.ts uses for src/frame-size.ts.
import { sanitizeBridgeId } from '../src/bridge-id.ts'

describe('sanitizeBridgeId (DO side)', () => {
  it('returns default for missing/empty input (old bridge, no bridge_id)', () => {
    expect(sanitizeBridgeId(null)).toBe('default')
    expect(sanitizeBridgeId(undefined)).toBe('default')
    expect(sanitizeBridgeId('')).toBe('default')
    expect(sanitizeBridgeId('   ')).toBe('default')
  })

  it('passes through an already-clean id', () => {
    expect(sanitizeBridgeId('mini')).toBe('mini')
    expect(sanitizeBridgeId('macbook')).toBe('macbook')
  })

  it('applies the same slug rule as the bridge', () => {
    expect(sanitizeBridgeId('weird id!')).toBe('weird-id')
    expect(sanitizeBridgeId('A/B C')).toBe('a-b-c')
  })

  it('caps the slug length at 64 chars', () => {
    expect(sanitizeBridgeId('y'.repeat(200))).toHaveLength(64)
  })

  it('returns default when the input slugs to empty', () => {
    expect(sanitizeBridgeId('!!!')).toBe('default')
  })
})
