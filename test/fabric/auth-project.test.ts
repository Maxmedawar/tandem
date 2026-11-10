import { describe, expect, it } from 'vitest'
import { createCallerContext, FabricAccessError } from '../../src/fabric/capabilities.ts'
import type { FabricCapability } from '../../src/fabric/types.ts'
import { InMemoryFabricClient } from './in-memory-fabric-client.ts'

const all: FabricCapability[] = ['project:create','project:members','project:read','project:archive','room:post','room:read','memory:write','memory:read','memory:delete']
const ctx = (ownerId: string, agentId: string, projectId?: string, caps: readonly FabricCapability[] = all, actorType: 'agent'|'owner' = 'agent') =>
  createCallerContext({ ownerId, deviceId: `device-${ownerId}`, agentId, projectId, capabilities: caps, actorType })

describe('project authorization and archive', () => {
  it('requires trusted owner membership authority to seed anyone besides the creator', async () => {
    const client = new InMemoryFabricClient()
    const creator = ctx('owner-a','agent-a',undefined,['project:create'])
    expect((await client.createProject(creator,{displayName:'Solo'})).memberAgentIds).toEqual(['agent-a'])
    await expect(client.createProject(creator,{displayName:'Injected',memberAgentIds:['agent-b']})).rejects.toThrow()
    const agentWithCapability = ctx('owner-a','agent-a',undefined,['project:create','project:members'])
    await expect(client.createProject(agentWithCapability,{displayName:'Still injected',memberAgentIds:['agent-b']})).rejects.toThrow()
    const owner = ctx('owner-a','agent-a',undefined,['project:create','project:members'],'owner')
    const project = await client.createProject(owner,{displayName:'Team',memberAgentIds:['agent-b']})
    expect((await client.getProject(ctx('owner-a','agent-b',undefined,['project:read']),project.projectId))?.projectId).toBe(project.projectId)
    const raw = { ...owner, capabilities: new Set(['project:create','project:members']) }
    await expect(client.createProject(raw as never,{displayName:'Raw',memberAgentIds:['agent-c']})).rejects.toThrow()
  })

  it('requires exact owner, an existing active project, and membership for scoped operations', async () => {
    const client = new InMemoryFabricClient()
    const project = await client.createProject(ctx('owner-a','agent-a',undefined,all,'owner'), { displayName: 'Alpha', memberAgentIds: ['agent-b'] })
    const invented = ctx('owner-a','agent-a','invented')
    const nonmember = ctx('owner-a','agent-c',project.projectId)
    const crossOwner = ctx('owner-b','agent-a',project.projectId)
    for (const caller of [invented, nonmember, crossOwner]) {
      await expect(client.postRoomEvent(caller, { room:'main', type:'message', body:'x', idempotencyKey:'post-1' })).rejects.toBeInstanceOf(FabricAccessError)
      await expect(client.readRoom(caller, { room:'main' })).rejects.toBeInstanceOf(FabricAccessError)
      await expect(client.remember(caller, { scope:'project', kind:'fact', text:'x', importance:.5 })).rejects.toBeInstanceOf(FabricAccessError)
    }
  })

  it('makes missing and inaccessible direct IDs indistinguishable and identifier-free', async () => {
    const client = new InMemoryFabricClient()
    const project = await client.createProject(ctx('owner-a','agent-a'), { displayName:'Alpha' })
    const writer = ctx('owner-a','agent-a',project.projectId)
    const memory = await client.remember(writer, { scope:'project', kind:'fact', text:'classified content', importance:.5 })
    const attacker = ctx('owner-b','agent-z',project.projectId)
    const messages: string[] = []
    for (const id of [memory.id, 'missing-memory']) {
      try { await client.getMemory(attacker, id) } catch (error) { messages.push(String(error)) }
    }
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe(messages[1])
    expect(messages.join(' ')).not.toMatch(/owner-|project-|agent-|memory-|classified/)
  })

  it('archives with capability and membership, remains metadata-readable, and blocks scoped work', async () => {
    const client = new InMemoryFabricClient()
    const project = await client.createProject(ctx('owner-a','agent-a'), { displayName:'Alpha' })
    const member = ctx('owner-a','agent-a',project.projectId)
    const archived = await client.archiveProject(member, project.projectId)
    expect(archived.project.archivedAt).toBeTruthy()
    expect((await client.getProject(ctx('owner-a','agent-a'), project.projectId))?.archivedAt).toBeTruthy()
    await expect(client.readRoom(member, { room:'main' })).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.archiveProject(ctx('owner-b','agent-a',project.projectId),project.projectId)).rejects.toBeInstanceOf(FabricAccessError)
  })

  it('keeps room-event probing and idempotency isolated across owners', async () => {
    const client=new InMemoryFabricClient()
    const pa=await client.createProject(ctx('owner-a','agent-a'),{displayName:'A'}), pb=await client.createProject(ctx('owner-b','agent-b'),{displayName:'B'})
    const a=ctx('owner-a','agent-a',pa.projectId), b=ctx('owner-b','agent-b',pb.projectId)
    const ea=await client.postRoomEvent(a,{room:'main',type:'decision',body:'A only',idempotencyKey:'shared-key'})
    const eb=await client.postRoomEvent(b,{room:'main',type:'decision',body:'B only',idempotencyKey:'shared-key'})
    expect(eb.id).not.toBe(ea.id)
    const messages:string[]=[]
    for(const id of [ea.id,'missing-event']) try{await client.promoteRoomEvent(b,{roomEventId:id,kind:'decision',importance:.5,idempotencyKey:'promote'})}catch(error){messages.push(String(error))}
    expect(messages).toEqual([messages[0],messages[0]])
    expect(messages[0]).not.toMatch(/owner-|project-|agent-|event-|A only/)
    const first=await client.promoteRoomEvent(a,{roomEventId:ea.id,kind:'decision',importance:.5,idempotencyKey:'same-promotion'})
    const duplicate=await client.promoteRoomEvent(a,{roomEventId:ea.id,kind:'decision',importance:.5,idempotencyKey:'same-promotion'})
    expect(duplicate.id).toBe(first.id)
  })
})
