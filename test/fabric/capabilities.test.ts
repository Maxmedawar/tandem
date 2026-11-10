import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CAPABILITY_COUNT,
  FabricAuthError,
  assertCapability,
  createCallerContext,
  hasCapability,
  isFabricEnabled,
} from '../../src/fabric/capabilities'
import { FabricValidationError } from '../../src/fabric/validation'

describe('trusted caller snapshots', () => {
  it('fails closed for feature flags', () => {
    expect(isFabricEnabled({})).toBe(false)
    expect(isFabricEnabled({ CCM_FABRIC_ENABLED: 'yes' })).toBe(false)
    expect(isFabricEnabled({ CCM_FABRIC_ENABLED: ' TRUE ' })).toBe(true)
  })

  it('copies capabilities and cannot gain authority through aliases', () => {
    const caps = new Set(['project:read'] as const)
    const ctx = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities: caps })
    ;(caps as Set<string>).add('room:post')
    expect(hasCapability(ctx, 'room:post')).toBe(false)
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.capabilities)).toBe(true)
  })

  it('rejects oversized sparse capability arrays before copying', () => {
    const capabilities: string[] = []
    capabilities.length = MAX_CAPABILITY_COUNT + 100
    const arrayFrom = vi.spyOn(Array, 'from').mockImplementation(() => { throw new RangeError('copy path reached') })
    try {
      expect(() => createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities } as never)).toThrow(FabricValidationError)
      expect(arrayFrom).not.toHaveBeenCalled()
    } finally {
      arrayFrom.mockRestore()
    }
  })

  it('rejects oversized capability arrays before collecting property descriptors', () => {
    const capabilities = Array.from({ length: MAX_CAPABILITY_COUNT + 100 }, (_, index) => `unknown:${index}`)
    const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
    let oversizedArrayInspections = 0
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation(value => {
      if (value === capabilities) {
        oversizedArrayInspections++
        throw new RangeError('descriptor collection reached')
      }
      return getOwnPropertyDescriptors(value)
    })
    try {
      expect(() => createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities } as never)).toThrow(FabricValidationError)
      expect(oversizedArrayInspections).toBe(0)
    } finally {
      descriptors.mockRestore()
    }
  })

  it('rejects oversized native capability sets before iteration', () => {
    const capabilities = new Set(Array.from({ length: MAX_CAPABILITY_COUNT + 1 }, (_, index) => `unknown:${index}`))
    const setValues = vi.spyOn(Set.prototype, 'values').mockImplementation(() => { throw new TypeError('iteration path reached') })
    try {
      expect(() => createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities } as never)).toThrow(FabricValidationError)
      expect(setValues).not.toHaveBeenCalled()
    } finally {
      setValues.mockRestore()
    }
  })

  it('accepts normal bounded capability arrays and sets', () => {
    const arrayContext = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities: ['project:read', 'room:read'] })
    const setContext = createCallerContext({ ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a', capabilities: new Set(['memory:read', 'room:post'] as const) })
    expect([...arrayContext.capabilities]).toEqual(['project:read', 'room:read'])
    expect([...setContext.capabilities]).toEqual(['memory:read', 'room:post'])
  })

  it('recognizes explicit project membership authority',()=>{
    const ctx=createCallerContext({ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a',actorType:'owner',capabilities:['project:members']})
    expect(hasCapability(ctx,'project:members')).toBe(true)
  })

  it('rejects raw fabricated contexts and keeps identifiers out of errors', () => {
    const raw = { ownerId: 'secret-owner', deviceId: 'secret-device', agentId: 'secret-agent', capabilities: new Set(['room:post'] as const) }
    expect(() => assertCapability(raw as never, 'room:post')).toThrow(FabricAuthError)
    try { assertCapability(raw as never, 'room:post') } catch (error) {
      expect(String(error)).not.toMatch(/secret-owner|secret-device|secret-agent/)
    }
  })

  it.each([
    null,
    [],
    {},
    { ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a',capabilities:[],extra:true },
    { ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a' },
    { ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a',capabilities:'project:read' },
    { ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a',capabilities:[1] },
    { ownerId:'owner-a',deviceId:'device-a',agentId:'agent-a',capabilities:[],actorType:'admin' },
  ])('rejects malformed caller context data without native errors', input => {
    expect(() => createCallerContext(input as never)).toThrow(FabricValidationError)
  })

  it('rejects accessor-backed and hostile proxy contexts without invoking them', () => {
    let getterCalls=0
    const accessor=Object.defineProperty({deviceId:'device-a',agentId:'agent-a',capabilities:[]},'ownerId',{enumerable:true,get(){getterCalls++;return 'owner-a'}})
    expect(() => createCallerContext(accessor as never)).toThrow(FabricValidationError)
    expect(getterCalls).toBe(0)

    let trapCalls=0
    const throwingProxy=new Proxy({}, { ownKeys(){trapCalls++;throw new Error('hostile trap')} })
    expect(() => createCallerContext(throwingProxy as never)).toThrow(FabricValidationError)
    expect(trapCalls).toBe(0)
  })

  it.each(['owner\0a','device\u001fa','agent\na'])('rejects control characters in caller identifiers generically', value => {
    expect(() => createCallerContext({ownerId:value,deviceId:'device-a',agentId:'agent-a',capabilities:[]} as never)).toThrow(FabricValidationError)
    try { createCallerContext({ownerId:value,deviceId:'device-a',agentId:'agent-a',capabilities:[]} as never) } catch(error) {
      expect(String(error)).not.toContain(value)
    }
  })
})
