import { describe, expect, it } from 'vitest'
import {
  configureFabricTools,
  type FabricToolDefinition,
  type FabricToolHandler,
} from '../../src/fabric/mcp-tools'

class FakeToolServer {
  readonly tools = new Map<string, { definition: FabricToolDefinition; handler: FabricToolHandler }>()
  registerTool(name: string, definition: FabricToolDefinition, handler: FabricToolHandler): void {
    this.tools.set(name, { definition, handler })
  }
}

const expectedTools = [
  'memory_forget', 'memory_get', 'memory_promote', 'memory_remember', 'memory_search',
  'project_archive', 'project_create', 'project_get', 'project_list', 'room_post', 'room_read',
]

const healthyBridge = async (path: string) => path === '/fabric/_ready'
  ? { ready: true, protocol: 'tandem-fabric-rpc-v1' }
  : { ok: true }

describe('default-off authenticated Fabric MCP registration', () => {
  it.each([undefined, '', '0', 'false', 'yes', true, 1])('registers zero tools unless the Worker flag is explicitly enabled: %j', async enabled => {
    const server = new FakeToolServer()
    const calls: string[] = []
    const registered = await configureFabricTools(server, {
      enabled,
      oauthSubject: 'authenticated-owner',
      rpc: async path => { calls.push(path); return healthyBridge(path) },
    })
    expect(registered).toBe(false)
    expect(server.tools.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('fails closed when enabled without a trusted OAuth subject or configured fallback', async () => {
    const server = new FakeToolServer()
    const registered = await configureFabricTools(server, {
      enabled: 'true',
      rpc: async () => ({ ok: true }),
    })
    expect(registered).toBe(false)
    expect(server.tools.size).toBe(0)
  })

  it.each([
    ['throws', async () => { throw new Error('PRIVATE_BRIDGE_FAILURE_MUST_NOT_ESCAPE') }],
    ['is unavailable', async () => ({ error: 'fabric_unavailable' })],
    ['returns a malformed response', async () => ({ ready: true })],
    ['returns the wrong protocol', async () => ({ ready: true, protocol: 'tandem-fabric-rpc-v0' })],
  ])('registers zero tools when the private bridge readiness handshake %s', async (_label, rpc) => {
    const server = new FakeToolServer()
    expect(await configureFabricTools(server, {
      enabled: 'true',
      oauthSubject: 'authenticated-owner',
      rpc,
    })).toBe(false)
    expect(server.tools.size).toBe(0)
  })

  it('registers exactly the Phase 1 tools and derives an opaque stable OWNER caller server-side', async () => {
    const first = new FakeToolServer()
    const second = new FakeToolServer()
    const calls: Array<{ path: string; body: unknown; machine?: string }> = []
    const options = {
      enabled: '1',
      oauthSubject: 'authenticated-owner',
      rpc: async (path: string, body: unknown, machine?: string) => {
        calls.push({ path, body, machine })
        return healthyBridge(path)
      },
    }
    expect(await configureFabricTools(first, options)).toBe(true)
    expect(await configureFabricTools(second, options)).toBe(true)
    expect([...first.tools.keys()].sort()).toEqual(expectedTools)
    expect([...second.tools.keys()].sort()).toEqual(expectedTools)

    const forbiddenCallerKeys = ['ownerId', 'deviceId', 'agentId', 'actorType', 'capabilities']
    for (const { definition } of first.tools.values()) {
      expect(Object.keys(definition.inputSchema).filter(key => forbiddenCallerKeys.includes(key))).toEqual([])
    }

    const create = first.tools.get('project_create')!
    await create.handler({
      displayName: 'Trusted project',
      machine: 'mini',
      ownerId: 'attacker-owner',
      deviceId: 'attacker-device',
      agentId: 'attacker-agent',
      actorType: 'agent',
      capabilities: ['shell:execute'],
    } as never)
    await second.tools.get('project_create')!.handler({ displayName: 'Trusted project' })

    expect(calls.filter(call => call.path === '/fabric/_ready')).toHaveLength(2)
    expect(calls[2]).toMatchObject({ path: '/fabric/project/create', machine: 'mini' })
    const firstBody = calls[2].body as { caller: Record<string, string>; input: Record<string, unknown> }
    const secondBody = calls[3].body as { caller: Record<string, string>; input: Record<string, unknown> }
    expect(firstBody.input).toEqual({ displayName: 'Trusted project' })
    expect(firstBody.caller).toEqual(secondBody.caller)
    expect(firstBody.caller).toEqual({
      ownerId: expect.stringMatching(/^owner-[a-f0-9]{64}$/),
      deviceId: expect.stringMatching(/^mcp-device-[a-f0-9]{64}$/),
      agentId: expect.stringMatching(/^mcp-owner-[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(firstBody)).not.toContain('authenticated-owner')
    expect(JSON.stringify(firstBody)).not.toContain('attacker')
  })

  it('derives ownerId, deviceId, and agentId independently so none is obtainable from another by prefix substitution', async () => {
    async function callerFor(oauthSubject: string): Promise<Record<string, string>> {
      const server = new FakeToolServer()
      const calls: Array<{ path: string; body: unknown }> = []
      await configureFabricTools(server, {
        enabled: '1',
        oauthSubject,
        rpc: async (path, body) => { calls.push({ path, body }); return healthyBridge(path) },
      })
      await server.tools.get('project_list')!.handler({})
      const readCall = calls.find(call => call.path === '/fabric/project/list')!
      return (readCall.body as { caller: Record<string, string> }).caller
    }

    const callerA = await callerFor('subject-a')
    const hexOf = (value: string, prefix: string) => value.slice(prefix.length)
    const ownerHex = hexOf(callerA.ownerId, 'owner-')
    const deviceHex = hexOf(callerA.deviceId, 'mcp-device-')
    const agentHex = hexOf(callerA.agentId, 'mcp-owner-')

    // Each identifier's hash suffix must be independent: swapping in another
    // identifier's hex under a different identifier's prefix must not equal
    // the real value, so leaking one identifier never yields the others.
    expect(ownerHex).not.toBe(deviceHex)
    expect(ownerHex).not.toBe(agentHex)
    expect(deviceHex).not.toBe(agentHex)
    expect(`mcp-device-${ownerHex}`).not.toBe(callerA.deviceId)
    expect(`mcp-owner-${ownerHex}`).not.toBe(callerA.agentId)
    expect(`owner-${deviceHex}`).not.toBe(callerA.ownerId)
    expect(`mcp-owner-${deviceHex}`).not.toBe(callerA.agentId)
    expect(`owner-${agentHex}`).not.toBe(callerA.ownerId)
    expect(`mcp-device-${agentHex}`).not.toBe(callerA.deviceId)

    // Deterministic per subject: repeat derivation for the same subject is stable.
    const callerAAgain = await callerFor('subject-a')
    expect(callerAAgain).toEqual(callerA)

    // A different subject derives an entirely different, still-independent triple.
    const callerB = await callerFor('subject-b')
    expect(callerB.ownerId).not.toBe(callerA.ownerId)
    expect(callerB.deviceId).not.toBe(callerA.deviceId)
    expect(callerB.agentId).not.toBe(callerA.agentId)
  })

  it.each([
    ['empty string', ''],
    ['control characters', 'bad\x01subject'],
    ['oversized', 'x'.repeat(257)],
    ['non-string number', 42],
    ['null', null],
    ['non-string object', { sub: 'attacker' }],
  ])('fails closed with zero registrations and no readiness request when the OAuth subject is present but malformed (%s), even with a valid configured fallback', async (_label, oauthSubject) => {
    const server = new FakeToolServer()
    const calls: string[] = []
    const registered = await configureFabricTools(server, {
      enabled: 'true',
      oauthSubject,
      configuredOwnerId: 'personal-fabric-owner',
      rpc: async path => { calls.push(path); return healthyBridge(path) },
    })
    expect(registered).toBe(false)
    expect(server.tools.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('uses an explicit non-secret configured owner identifier only as the enabled fallback', async () => {
    const server = new FakeToolServer()
    const calls: unknown[] = []
    expect(await configureFabricTools(server, {
      enabled: 'true',
      configuredOwnerId: 'personal-fabric-owner',
      rpc: async (path, body) => { calls.push(body); return healthyBridge(path) },
    })).toBe(true)
    await server.tools.get('project_list')!.handler({})
    expect(JSON.stringify(calls)).not.toContain('personal-fabric-owner')
  })

  it('returns a generic content-free result when the private RPC adapter fails', async () => {
    const server = new FakeToolServer()
    expect(await configureFabricTools(server, {
      enabled: 'true',
      oauthSubject: 'RAW_OAUTH_SUBJECT_MUST_NOT_ESCAPE',
      rpc: async path => {
        if (path === '/fabric/_ready') return healthyBridge(path)
        throw new Error('RAW_SECRET_AND_SUBJECT_MUST_NOT_ESCAPE')
      },
    })).toBe(true)

    const result = await server.tools.get('project_list')!.handler({})
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ error: 'fabric_unavailable' }) }] })
    expect(JSON.stringify(result)).not.toContain('RAW_')
  })
})
