import { describe, expect, it } from 'vitest'
import { routeFabricRpc, FABRIC_MCP_TRUST } from '../../bridge/fabric/rpc-router'
import type { FabricClient } from '../../src/fabric/client'
import { MAX_DISPLAY_NAME_BYTES } from '../../src/fabric/types'
import { InMemoryFabricClient } from './in-memory-fabric-client'

const caller = Object.freeze({
  ownerId: `owner-${'a'.repeat(64)}`,
  deviceId: `mcp-device-${'b'.repeat(64)}`,
  agentId: `mcp-owner-${'c'.repeat(64)}`,
})

const invoke = (
  client: FabricClient | undefined,
  path: string,
  input: Record<string, unknown>,
  trust: string | undefined = FABRIC_MCP_TRUST,
) => routeFabricRpc({
  trust,
  client,
  method: 'POST',
  path,
  body: { caller, input },
})

describe('tunnel-only bridge Fabric RPC boundary', () => {
  it('rejects Fabric calls without the authenticated MCP tunnel marker before touching the client', async () => {
    const client = new InMemoryFabricClient()
    const result = await routeFabricRpc({
      client,
      method: 'POST',
      path: '/fabric/project/create',
      body: { caller, input: { displayName: 'must not run' } },
    })
    expect(result).toEqual({ status: 403, body: { error: 'fabric_operation_denied' } })
    expect(client.snapshot().projects).toBe(0)
  })

  it('returns a generic unavailable error when the bridge-local feature host is disabled', async () => {
    expect(await invoke(undefined, '/fabric/project/list', {})).toEqual({
      status: 503,
      body: { error: 'fabric_unavailable' },
    })
  })

  it('rejects forged caller authority and extra envelope fields generically', async () => {
    const client = new InMemoryFabricClient()
    const result = await routeFabricRpc({
      trust: FABRIC_MCP_TRUST,
      client,
      method: 'POST',
      path: '/fabric/project/create',
      body: {
        caller: { ...caller, actorType: 'agent', capabilities: ['shell:execute'] },
        input: { displayName: 'must not run' },
      },
    })
    expect(result).toEqual({ status: 403, body: { error: 'fabric_operation_denied' } })
    expect(client.snapshot().projects).toBe(0)
  })

  it('keeps bridge UTF-8 byte validators authoritative over Worker character-count schemas', async () => {
    const client = new InMemoryFabricClient()
    const multiByteName = '\u{1f4a5}'.repeat(MAX_DISPLAY_NAME_BYTES)
    expect([...multiByteName]).toHaveLength(MAX_DISPLAY_NAME_BYTES)
    expect(Buffer.byteLength(multiByteName, 'utf8')).toBeGreaterThan(MAX_DISPLAY_NAME_BYTES)
    expect(await invoke(client, '/fabric/project/create', { displayName: multiByteName })).toEqual({
      status: 400,
      body: { error: 'fabric_request_invalid' },
    })
    expect(client.snapshot().projects).toBe(0)
  })

  it('routes every implemented Phase 1 operation with a bridge-created OWNER context', async () => {
    const client = new InMemoryFabricClient()
    const created = await invoke(client, '/fabric/project/create', { displayName: 'Owner project' })
    expect(created.status).toBe(200)
    const projectId = (created.body as { projectId: string }).projectId
    expect((await invoke(client, '/fabric/project/list', {})).body).toEqual([
      expect.objectContaining({ projectId, displayName: 'Owner project' }),
    ])
    expect((await invoke(client, '/fabric/project/get', { projectId })).body).toEqual(expect.objectContaining({ projectId }))

    const posted = await invoke(client, '/fabric/room/post', {
      projectId, room: 'main', type: 'decision', body: 'Keep SQLite local', idempotencyKey: 'rpc-post',
    })
    const roomEventId = (posted.body as { id: string }).id
    expect(((await invoke(client, '/fabric/room/read', { projectId, room: 'main' })).body as { events: Array<{ id: string }> }).events[0].id).toBe(roomEventId)

    const remembered = await invoke(client, '/fabric/memory/remember', {
      projectId, scope: 'project', kind: 'fact', text: 'Shared fact', importance: 0.7,
    })
    const memoryId = (remembered.body as { id: string }).id
    expect(((await invoke(client, '/fabric/memory/search', { projectId, query: 'Shared' })).body as { records: Array<{ id: string }> }).records[0].id).toBe(memoryId)
    expect((await invoke(client, '/fabric/memory/get', { projectId, id: memoryId })).body).toEqual(expect.objectContaining({ id: memoryId }))

    const promoted = await invoke(client, '/fabric/memory/promote', {
      projectId, roomEventId, kind: 'decision', importance: 0.9, idempotencyKey: 'rpc-promote',
    })
    const promotedId = (promoted.body as { id: string }).id
    expect(await invoke(client, '/fabric/memory/forget', { projectId, id: promotedId })).toEqual({ status: 200, body: { ok: true } })
    expect((await invoke(client, '/fabric/project/archive', { projectId })).body).toEqual(expect.objectContaining({ alreadyArchived: false }))
  })
})
