import { describe, it, expect } from 'vitest'
// Pure routing decision logic lives in src/tunnel-routing.ts (no cloudflare:workers
// import) so it can run in the plain-node vitest env — the same split as
// src/frame-size.ts and src/bridge-id.ts. The TunnelDO calls these from thin
// adapters that read socket tags into {bridgeId, isOpen}[] first.
import {
  selectSocketIndex,
  socketsToEvict,
  dedupeConnectedIds,
  type SocketInfo,
} from '../src/tunnel-routing.ts'

const open = (bridgeId: string): SocketInfo => ({ bridgeId, isOpen: true })
const closed = (bridgeId: string): SocketInfo => ({ bridgeId, isOpen: false })

describe('selectSocketIndex', () => {
  it('1. target match -> index of the matching open socket', () => {
    expect(selectSocketIndex([open('laptop'), open('desktop')], 'desktop')).toBe(1)
  })

  it('2. target offline -> -1', () => {
    expect(selectSocketIndex([open('laptop'), closed('desktop')], 'desktop')).toBe(-1)
  })

  it('3. target absent from the set -> -1', () => {
    expect(selectSocketIndex([open('laptop')], 'desktop')).toBe(-1)
  })

  it('4. no-target single open -> 0', () => {
    expect(selectSocketIndex([open('laptop')], undefined)).toBe(0)
  })

  it('5. no-target multiple open -> first open (fallback)', () => {
    expect(selectSocketIndex([open('laptop'), open('desktop')], undefined)).toBe(0)
  })

  it('6. no-target skips a closed leading socket -> first OPEN', () => {
    expect(selectSocketIndex([closed('laptop'), open('desktop')], undefined)).toBe(1)
  })

  it('7. no sockets / none open -> -1', () => {
    expect(selectSocketIndex([], undefined)).toBe(-1)
    expect(selectSocketIndex([closed('laptop')], undefined)).toBe(-1)
  })

  it('8. target picks the OPEN duplicate over an earlier closed same-id', () => {
    expect(selectSocketIndex([closed('laptop'), open('laptop')], 'laptop')).toBe(1)
  })
})

describe('socketsToEvict', () => {
  it('9. same-tag only; other machines stay open', () => {
    const result = socketsToEvict([open('laptop'), open('desktop')], 'laptop')
    expect(result).toEqual([0])
    expect(result).not.toContain(1)
  })

  it('10. a new id evicts nothing', () => {
    expect(socketsToEvict([open('laptop')], 'desktop')).toEqual([])
  })

  it('11. multiple same-tag open -> all evicted', () => {
    expect(socketsToEvict([open('laptop'), open('laptop')], 'laptop')).toEqual([0, 1])
  })

  it('12. a closed same-tag socket is not evicted (already gone)', () => {
    expect(socketsToEvict([closed('laptop')], 'laptop')).toEqual([])
  })

  it('13. old-bridge default self-replace', () => {
    expect(socketsToEvict([open('default')], 'default')).toEqual([0])
  })
})

describe('dedupeConnectedIds', () => {
  it('14. dedupes, order preserved', () => {
    expect(dedupeConnectedIds([open('laptop'), open('laptop'), open('desktop')])).toEqual([
      'laptop',
      'desktop',
    ])
  })

  it('15. excludes closed sockets', () => {
    expect(dedupeConnectedIds([open('laptop'), closed('desktop')])).toEqual(['laptop'])
  })

  it('16. empty -> empty', () => {
    expect(dedupeConnectedIds([])).toEqual([])
  })
})
