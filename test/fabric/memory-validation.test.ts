import { describe, expect, it } from 'vitest'
import { createCallerContext, FabricAccessError } from '../../src/fabric/capabilities'
import type { FabricCapability } from '../../src/fabric/types'
import { FabricValidationError } from '../../src/fabric/validation'
import { InMemoryFabricClient } from './in-memory-fabric-client'

const context=(caps: readonly FabricCapability[], projectId?:string, agentId='agent-a', ownerId='owner-a', actorType:'agent'|'owner'='agent')=>createCallerContext({ownerId,deviceId:'device-a',agentId,projectId,capabilities:caps,actorType})
const caps: FabricCapability[]=['project:create','project:read','room:post','room:read','memory:write','memory:read','memory:delete']

describe('memory provenance, scope, and validation',()=>{
  it('derives agent provenance and requires separate authority for owner-authored user memory',async()=>{
    const client=new InMemoryFabricClient(), agent=context(caps)
    const record=await client.remember(agent,{scope:'agent',kind:'fact',text:'agent note',importance:.5})
    expect(record.source).toEqual({type:'agent',agentId:'agent-a'})
    await expect(client.remember(agent,{scope:'user',kind:'preference',text:'owner preference',importance:.5,authorship:'owner'})).rejects.toBeInstanceOf(FabricAccessError)
    const owner=context([...caps,'memory:write:user'],undefined,'agent-a','owner-a','owner')
    expect((await client.remember(owner,{scope:'user',kind:'preference',text:'owner preference',importance:.5,authorship:'owner'})).source.type).toBe('user')
    await expect(client.remember(agent,{scope:'agent',kind:'fact',text:'bad authorship',importance:.5,authorship:'owner'})).rejects.toThrow(FabricValidationError)
    await expect(client.remember(agent,{scope:'agent',kind:'fact',text:'bad enum',importance:.5,authorship:'bogus' as never})).rejects.toThrow(FabricValidationError)
  })

  it('preserves stored room session provenance during promotion',async()=>{
    const client=new InMemoryFabricClient(), root=context(caps), p=await client.createProject(root,{displayName:'Alpha'}), scoped=context(caps,p.projectId)
    const event=await client.postRoomEvent(scoped,{room:'main',type:'decision',body:'ship it',sessionId:'session-source',idempotencyKey:'event'})
    const memory=await client.promoteRoomEvent(scoped,{roomEventId:event.id,kind:'decision',importance:.8,idempotencyKey:'promotion'})
    expect(memory.source).toEqual({type:'room',agentId:'agent-a',roomEventId:event.id,sessionId:'session-source'})
  })

  it.each([
    ['project type',{room:'main',type:'bogus',body:'x',idempotencyKey:'x'}],
    ['memory scope',{scope:'bogus',kind:'fact',text:'x',importance:.5}],
    ['memory kind',{scope:'agent',kind:'bogus',text:'x',importance:.5}],
    ['search scope',{scope:'bogus',query:'x'}],
    ['retention shape',{displayName:'x',retention:[]}],
    ['retention ttl',{displayName:'x',retention:{roomEventTtlHops:1.5}}],
  ] as const)('fails closed for malformed runtime %s',async(_label,input)=>{
    const client=new InMemoryFabricClient(), root=context(caps)
    if('displayName' in input) await expect(client.createProject(root,input as never)).rejects.toThrow(FabricValidationError)
    else { const p=await client.createProject(root,{displayName:'Alpha'}), scoped=context(caps,p.projectId)
      if('room' in input) await expect(client.postRoomEvent(scoped,input as never)).rejects.toThrow(FabricValidationError)
      else if('query' in input) await expect(client.searchMemory(scoped,input as never)).rejects.toThrow(FabricValidationError)
      else await expect(client.remember(scoped,input as never)).rejects.toThrow(FabricValidationError)
    }
  })

  it('enforces exact scope bindings and explicit authority for global reads',async()=>{
    const client=new InMemoryFabricClient(), owner=context([...caps,'memory:write:user','memory:read:user'],undefined,'agent-a','owner-a','owner')
    const user=await client.remember(owner,{scope:'user',kind:'fact',text:'global secret',importance:.5,authorship:'owner'})
    expect(user.projectId).toBeUndefined(); expect(user.agentId).toBeUndefined()
    expect((await client.searchMemory(context(caps),{query:'global'})).records).toEqual([])
    expect((await client.searchMemory(owner,{query:'global'})).records).toHaveLength(1)
  })

  it('validates supersession compatibility and omits superseded records from retrieval',async()=>{
    const client=new InMemoryFabricClient(), agent=context(caps)
    const old=await client.remember(agent,{scope:'agent',kind:'fact',text:'old value',importance:.5})
    const current=await client.remember(agent,{scope:'agent',kind:'fact',text:'new value',importance:.5,supersedes:old.id})
    expect((await client.searchMemory(agent,{query:'value'})).records.map(r=>r.id)).toEqual([current.id])
    await expect(client.remember(agent,{scope:'user',kind:'fact',text:'bad',importance:.5,supersedes:old.id,authorship:'owner'})).rejects.toBeInstanceOf(FabricAccessError)
  })

  it('keeps a superseded memory obsolete after its correction is forgotten',async()=>{
    const client=new InMemoryFabricClient(), agent=context(caps)
    const unrelated=await client.remember(agent,{scope:'agent',kind:'fact',text:'value unrelated',importance:.5})
    const a=await client.remember(agent,{scope:'agent',kind:'fact',text:'value A',importance:.5})
    const b=await client.remember(agent,{scope:'agent',kind:'fact',text:'value B',importance:.5,supersedes:a.id})
    await client.forgetMemory(agent,b.id)
    expect((await client.searchMemory(agent,{query:'value'})).records.map(r=>r.id)).toEqual([unrelated.id])
    const correctedAgain=await client.remember(agent,{scope:'agent',kind:'fact',text:'value C',importance:.7,supersedes:a.id})
    expect((await client.searchMemory(agent,{query:'value'})).records.map(r=>r.id)).toEqual([unrelated.id,correctedAgain.id])
  })

  it('never revives obsolete records while a supersession chain is forgotten',async()=>{
    const client=new InMemoryFabricClient(), agent=context(caps)
    const a=await client.remember(agent,{scope:'agent',kind:'fact',text:'chain A',importance:.5})
    const b=await client.remember(agent,{scope:'agent',kind:'fact',text:'chain B',importance:.5,supersedes:a.id})
    const c=await client.remember(agent,{scope:'agent',kind:'fact',text:'chain C',importance:.5,supersedes:b.id})
    await client.forgetMemory(agent,c.id)
    expect((await client.searchMemory(agent,{query:'chain'})).records.map(r=>r.id)).toEqual([])
    await client.forgetMemory(agent,b.id)
    expect((await client.searchMemory(agent,{query:'chain'})).records.map(r=>r.id)).toEqual([])
  })

  it.each([
    ['displayName',''],['repoRef',''],['room',''],['idempotencyKey',''],['query','x'.repeat(4097)],['importance',Number.NaN],['importance',1.1],['confidence',-0.1],['ttlHops',0],['ttlHops',65],['artifactRefs',Array(33).fill('a')],
  ] as const)('rejects invalid %s',async(field,value)=>{
    const client=new InMemoryFabricClient(), root=context(caps)
    if(field==='displayName'||field==='repoRef') await expect(client.createProject(root,{displayName:field==='displayName'?String(value):'Alpha',repoRef:field==='repoRef'?String(value):undefined})).rejects.toThrow(FabricValidationError)
    else { const p=await client.createProject(root,{displayName:'Alpha'}), scoped=context(caps,p.projectId)
      if(field==='query') await expect(client.searchMemory(scoped,{query:String(value)})).rejects.toThrow(FabricValidationError)
      else if(field==='importance'||field==='confidence') await expect(client.remember(scoped,{scope:'project',kind:'fact',text:'x',importance:field==='importance'?Number(value):.5,confidence:field==='confidence'?Number(value):undefined})).rejects.toThrow(FabricValidationError)
      else await expect(client.postRoomEvent(scoped,{room:field==='room'?String(value):'main',type:'message',body:'x',idempotencyKey:field==='idempotencyKey'?String(value):'key',ttlHops:field==='ttlHops'?Number(value):undefined,artifactRefs:field==='artifactRefs'?value as readonly string[]:undefined})).rejects.toThrow(FabricValidationError)
    }
  })

  it('rejects hostile proxy and accessor inputs without invoking or exposing them',async()=>{
    const client=new InMemoryFabricClient(), root=context(caps), p=await client.createProject(root,{displayName:'Alpha'}), scoped=context(caps,p.projectId)
    let trapCalls=0
    const proxy=new Proxy({}, {ownKeys(){trapCalls++;throw new Error('SECRET_PROXY_BODY')}})
    let proxyError=''
    try{await client.postRoomEvent(scoped,proxy as never)}catch(error){proxyError=String(error);expect(error).toBeInstanceOf(FabricValidationError)}
    expect(trapCalls).toBe(0)
    expect(proxyError).not.toContain('SECRET_PROXY_BODY')

    let getterCalls=0
    const accessor=Object.defineProperty({scope:'project',kind:'fact',importance:.5},'text',{enumerable:true,get(){getterCalls++;throw new Error('SECRET_ACCESSOR_TEXT')}})
    let accessorError=''
    try{await client.remember(scoped,accessor as never)}catch(error){accessorError=String(error);expect(error).toBeInstanceOf(FabricValidationError)}
    expect(getterCalls).toBe(0)
    expect(accessorError).not.toContain('SECRET_ACCESSOR_TEXT')
  })
})
