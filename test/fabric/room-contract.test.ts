import { describe, expect, it } from 'vitest'
import { createCallerContext } from '../../src/fabric/capabilities.ts'
import type { FabricCapability } from '../../src/fabric/types.ts'
import { FabricValidationError } from '../../src/fabric/validation.ts'
import { canonicalTupleKey, InMemoryFabricClient } from './in-memory-fabric-client.ts'

const caps: FabricCapability[] = ['project:create','project:members','project:read','room:post','room:read','memory:write','memory:read']
const base = (agentId='agent-a', projectId?: string, actorType:'agent'|'owner'='agent') => createCallerContext({ ownerId:'owner-a', deviceId:`device-${agentId}`, agentId, projectId, capabilities:caps, actorType })

describe('room contract', () => {
  it('encodes composite scope keys without delimiter collisions', () => {
    expect(canonicalTupleKey(['owner','project\0agent','key'])).not.toBe(canonicalTupleKey(['owner','project','agent\0key']))
  })

  it('rejects controls in project members, idempotency keys, cursors, and direct IDs', async () => {
    const client=new InMemoryFabricClient(), root=base()
    await expect(client.createProject(root,{displayName:'Alpha',memberAgentIds:['agent\0b']})).rejects.toThrow(FabricValidationError)
    const p=await client.createProject(root,{displayName:'Alpha'}), scoped=base('agent-a',p.projectId)
    await expect(client.postRoomEvent(scoped,{room:'main\0other',type:'message',body:'x',idempotencyKey:'key'})).rejects.toThrow(FabricValidationError)
    await expect(client.postRoomEvent(scoped,{room:'main',type:'message',body:'x',idempotencyKey:'key\u001f'})).rejects.toThrow(FabricValidationError)
    await expect(client.readRoom(scoped,{room:'main',cursor:'cursor\n'})).rejects.toThrow(FabricValidationError)
    await expect(client.getMemory(scoped,'memory\0id')).rejects.toThrow(FabricValidationError)
    await expect(client.getProject(scoped,'project\rid')).rejects.toThrow(FabricValidationError)
  })

  it('shows directed events only to sender/recipient and broadcasts to all members', async () => {
    const client = new InMemoryFabricClient()
    const p = await client.createProject(base('agent-a',undefined,'owner'), { displayName:'Alpha', memberAgentIds:['agent-b','agent-c'] })
    const a=base('agent-a',p.projectId), b=base('agent-b',p.projectId), c=base('agent-c',p.projectId)
    await client.postRoomEvent(a,{room:'main',type:'message',body:'private',toAgentId:'agent-b',idempotencyKey:'private-1'})
    await client.postRoomEvent(a,{room:'main',type:'message',body:'broadcast',idempotencyKey:'broadcast-1'})
    expect((await client.readRoom(a,{room:'main'})).events.map(e=>e.body)).toEqual(['private','broadcast'])
    expect((await client.readRoom(b,{room:'main'})).events.map(e=>e.body)).toEqual(['private','broadcast'])
    expect((await client.readRoom(c,{room:'main'})).events.map(e=>e.body)).toEqual(['broadcast'])
  })

  it('deduplicates idempotent posts and binds opaque cursors to room/project', async () => {
    const client = new InMemoryFabricClient()
    const p=await client.createProject(base(),{displayName:'Alpha'}), a=base('agent-a',p.projectId)
    const first=await client.postRoomEvent(a,{room:'main',type:'message',body:'once',idempotencyKey:'same'})
    const duplicate=await client.postRoomEvent(a,{room:'main',type:'message',body:'once',idempotencyKey:'same'})
    expect(duplicate.id).toBe(first.id)
    expect((await client.readRoom(a,{room:'main'})).events).toHaveLength(1)
    const cursor=(await client.readRoom(a,{room:'main'})).cursor!
    expect(cursor).not.toContain(p.projectId)
    await expect(client.readRoom(a,{room:'other',cursor})).rejects.toThrow(FabricValidationError)
    await expect(client.readRoom(a,{room:'main',cursor:'invalid'})).rejects.toThrow(FabricValidationError)
    await expect(client.postRoomEvent(a,{room:'main',type:'message',body:'changed',idempotencyKey:'same'})).rejects.toThrow()
  })

  it('compares the complete room and promotion semantics for idempotency', async () => {
    const client=new InMemoryFabricClient(), p=await client.createProject(base(),{displayName:'Alpha'}), a=base('agent-a',p.projectId)
    const post={room:'main',type:'decision' as const,body:'once',artifactRefs:['a','b'],ttlHops:4,sessionId:'session-a',idempotencyKey:'room-key'}
    const first=await client.postRoomEvent(a,post)
    expect((await client.postRoomEvent(a,{...post})).id).toBe(first.id)
    for(const changed of [
      {...post,artifactRefs:['b','a']}, {...post,ttlHops:5}, {...post,sessionId:'session-b'},
    ]) await expect(client.postRoomEvent(a,changed)).rejects.toThrow()
    const otherDevice=createCallerContext({ownerId:'owner-a',deviceId:'device-other',agentId:'agent-a',projectId:p.projectId,capabilities:caps})
    await expect(client.postRoomEvent(otherDevice,{...post})).rejects.toThrow()
    const second=await client.postRoomEvent(a,{...post,idempotencyKey:'room-key-2',body:'second'})
    const promotion={roomEventId:first.id,kind:'decision' as const,importance:.5,confidence:.8,idempotencyKey:'promotion-key'}
    const memory=await client.promoteRoomEvent(a,promotion)
    expect((await client.promoteRoomEvent(a,{...promotion})).id).toBe(memory.id)
    for(const changed of [
      {...promotion,roomEventId:second.id}, {...promotion,kind:'fact' as const},
      {...promotion,importance:.6}, {...promotion,confidence:.7},
    ]) await expect(client.promoteRoomEvent(a,changed)).rejects.toThrow()
  })

  it('uses retention-bound unguessable cursors bound to the reading visibility identity', async () => {
    let wall=1_000
    const client=new InMemoryFabricClient({now:()=>wall})
    const p=await client.createProject(base('agent-a',undefined,'owner'),{displayName:'Alpha',memberAgentIds:['agent-b'],retention:{roomRetentionDays:1}}), a=base('agent-a',p.projectId), b=base('agent-b',p.projectId)
    await client.postRoomEvent(a,{room:'main',type:'message',body:'one',idempotencyKey:'one'})
    const cursor=(await client.readRoom(a,{room:'main'})).cursor!
    expect(cursor).toMatch(/^[0-9a-f-]{36}$/i)
    expect(cursor).not.toMatch(/cursor|token|project|agent/i)
    await expect(client.readRoom(b,{room:'main',cursor})).rejects.toThrow(FabricValidationError)
    await expect(client.readRoom(a,{room:'other',cursor})).rejects.toThrow(FabricValidationError)
    const other=await client.createProject(base(),{displayName:'Other'})
    await expect(client.readRoom(base('agent-a',other.projectId),{room:'main',cursor})).rejects.toThrow(FabricValidationError)
    await client.postRoomEvent(a,{room:'main',type:'message',body:'two',idempotencyKey:'two'})
    const advanced=await client.readRoom(a,{room:'main',cursor})
    expect(advanced.events.map(e=>e.body)).toEqual(['two'])
    wall+=10*60_000
    expect((await client.readRoom(a,{room:'main',cursor})).events.map(e=>e.body)).toEqual(['two'])
    expect((await client.readRoom(a,{room:'main',cursor:advanced.cursor})).events).toEqual([])
    wall+=86_400_001
    await expect(client.readRoom(a,{room:'main',cursor})).rejects.toThrow(FabricValidationError)
  })

  it.each([0,-1,1.2,Number.NaN,Number.POSITIVE_INFINITY,501])('rejects invalid limit %s', async (limit) => {
    const client=new InMemoryFabricClient(), p=await client.createProject(base(),{displayName:'Alpha'})
    await expect(client.readRoom(base('agent-a',p.projectId),{room:'main',limit})).rejects.toThrow(FabricValidationError)
  })
})
