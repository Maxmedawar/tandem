import { types as nodeUtilTypes } from 'node:util'
import {
  MAX_ARTIFACT_REFS, MAX_DISPLAY_NAME_BYTES, MAX_IDENTIFIER_BYTES, MAX_MEMORY_SEARCH_LIMIT,
  MAX_MEMORY_TEXT_BYTES, MAX_PROJECT_MEMBER_AGENT_IDS, MAX_QUERY_BYTES, MAX_REFERENCE_BYTES,
  MAX_RETENTION_DAYS, MAX_ROOM_EVENT_BODY_BYTES, MAX_ROOM_READ_LIMIT, MAX_TTL_HOPS,
  type CreateProjectInput, type MemoryKind, type MemoryScope, type PostRoomEventInput,
  type PromoteRoomEventInput, type ReadRoomInput, type RememberInput, type RoomEventType,
  type SearchMemoryInput,
} from './types.ts'

export class FabricValidationError extends Error {
  readonly field: string
  constructor(field: string) { super(`invalid ${field}`); this.name = 'FabricValidationError'; this.field = field }
}

const ROOM_TYPES = new Set<RoomEventType>(['message','question','answer','decision','discovery','task','claim','progress','blocked','handoff','artifact','system'])
const MEMORY_SCOPES = new Set<MemoryScope>(['user','project','agent'])
const MEMORY_KINDS = new Set<MemoryKind>(['preference','fact','decision','constraint','discovery','procedure','handoff','summary'])
const bytes = (value: string) => new TextEncoder().encode(value).length

function assertObject(field: string, value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) throw new FabricValidationError(field)
  try {
    const prototype=Object.getPrototypeOf(value)
    if(prototype!==Object.prototype&&prototype!==null)throw new FabricValidationError(field)
    const descriptors=Object.getOwnPropertyDescriptors(value)
    if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!keys.includes(key)))throw new FabricValidationError(field)
    if(Object.values(descriptors).some(descriptor=>!('value' in descriptor)))throw new FabricValidationError(field)
  } catch(error) {
    if(error instanceof FabricValidationError)throw error
    throw new FabricValidationError(field)
  }
}
function assertEnum<T extends string>(field: string, value: unknown, values: ReadonlySet<T>): asserts value is T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new FabricValidationError(field)
}
export function assertString(field: string, value: unknown, maxBytes: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || bytes(value) > maxBytes) throw new FabricValidationError(field)
}
export function assertIdentifier(field: string, value: unknown): asserts value is string {
  assertString(field, value, MAX_IDENTIFIER_BYTES)
  if (/[\x00-\x1f\x7f]/.test(value)) throw new FabricValidationError(field)
}
export function assertOptionalIdentifier(field: string, value: unknown): void { if (value !== undefined) assertIdentifier(field, value) }
export function assertFiniteRange(field: string, value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new FabricValidationError(field)
}
export function assertOptionalFiniteRange(field: string, value: unknown, min: number, max: number): void { if (value !== undefined) assertFiniteRange(field, value, min, max) }
export function assertPositiveBoundedInteger(field: string, value: unknown, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new FabricValidationError(field)
}
export function assertOptionalPositiveBoundedInteger(field: string, value: unknown, max: number): void { if (value !== undefined) assertPositiveBoundedInteger(field, value, max) }
export function assertStringCollection(field: string, value: unknown, maxCount: number, maxElementBytes: number): void {
  if (value === undefined) return
  for (const element of arrayValues(field,value,maxCount)) assertString(field, element, maxElementBytes)
}
function assertIdentifierCollection(field:string,value:unknown,maxCount:number):void{
  if(value===undefined)return
  for(const element of arrayValues(field,value,maxCount))assertIdentifier(field,element)
}

function arrayValues(field:string,value:unknown,maxCount:number):unknown[]{
  if(!Array.isArray(value)||nodeUtilTypes.isProxy(value))throw new FabricValidationError(field)
  try{
    const length=value.length
    if(!Number.isSafeInteger(length)||length<0||length>maxCount)throw new FabricValidationError(field)
    const descriptors=Object.getOwnPropertyDescriptors(value) as Record<string,PropertyDescriptor>
    if(descriptors.length?.value!==length||Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||(key!=='length'&&!/^(0|[1-9]\d*)$/.test(key)))||Object.values(descriptors).some(descriptor=>!('value' in descriptor)))throw new FabricValidationError(field)
    const result:unknown[]=[]
    for(let index=0;index<length;index++){
      const descriptor=descriptors[String(index)]
      if(!descriptor||!('value' in descriptor))throw new FabricValidationError(field)
      result.push(descriptor.value)
    }
    return result
  }catch(error){
    if(error instanceof FabricValidationError)throw error
    throw new FabricValidationError(field)
  }
}

export function validateCreateProjectInput(value: unknown): asserts value is CreateProjectInput {
  assertObject('createProject',value,['displayName','repoRef','workspaceRef','memberAgentIds','retention'])
  assertString('displayName',value.displayName,MAX_DISPLAY_NAME_BYTES)
  if(value.repoRef!==undefined)assertString('repoRef',value.repoRef,MAX_REFERENCE_BYTES)
  if(value.workspaceRef!==undefined)assertString('workspaceRef',value.workspaceRef,MAX_REFERENCE_BYTES)
  assertIdentifierCollection('memberAgentIds',value.memberAgentIds,MAX_PROJECT_MEMBER_AGENT_IDS)
  if(value.retention!==undefined){
    assertObject('retention',value.retention,['roomEventTtlHops','roomRetentionDays'])
    assertOptionalPositiveBoundedInteger('roomEventTtlHops',value.retention.roomEventTtlHops,MAX_TTL_HOPS)
    assertOptionalPositiveBoundedInteger('roomRetentionDays',value.retention.roomRetentionDays,MAX_RETENTION_DAYS)
  }
}
export function validatePostRoomEventInput(value: unknown): asserts value is PostRoomEventInput {
  assertObject('postRoomEvent',value,['room','type','body','idempotencyKey','toAgentId','replyTo','correlationId','artifactRefs','ttlHops','sessionId'])
  assertIdentifier('room',value.room); assertEnum('type',value.type,ROOM_TYPES)
  assertString('body',value.body,MAX_ROOM_EVENT_BODY_BYTES); assertIdentifier('idempotencyKey',value.idempotencyKey)
  assertOptionalIdentifier('toAgentId',value.toAgentId); assertOptionalIdentifier('replyTo',value.replyTo)
  assertOptionalIdentifier('correlationId',value.correlationId); assertOptionalIdentifier('sessionId',value.sessionId)
  assertStringCollection('artifactRefs',value.artifactRefs,MAX_ARTIFACT_REFS,MAX_REFERENCE_BYTES)
  assertOptionalPositiveBoundedInteger('ttlHops',value.ttlHops,MAX_TTL_HOPS)
}
export function validateReadRoomInput(value: unknown): asserts value is ReadRoomInput {
  assertObject('readRoom',value,['room','cursor','limit']); assertIdentifier('room',value.room)
  assertOptionalIdentifier('cursor',value.cursor); assertOptionalPositiveBoundedInteger('limit',value.limit,MAX_ROOM_READ_LIMIT)
}
export function validateRememberInput(value: unknown): asserts value is RememberInput {
  assertObject('remember',value,['scope','kind','text','importance','confidence','authorship','sessionId','supersedes'])
  assertEnum('scope',value.scope,MEMORY_SCOPES); assertEnum('kind',value.kind,MEMORY_KINDS)
  assertString('text',value.text,MAX_MEMORY_TEXT_BYTES); assertFiniteRange('importance',value.importance,0,1)
  assertOptionalFiniteRange('confidence',value.confidence,0,1); assertOptionalIdentifier('sessionId',value.sessionId); assertOptionalIdentifier('supersedes',value.supersedes)
  if(value.scope==='user'){ if(value.authorship!=='owner')throw new FabricValidationError('authorship') }
  else if(value.authorship!==undefined&&value.authorship!=='agent')throw new FabricValidationError('authorship')
}
export function validateSearchMemoryInput(value: unknown): asserts value is SearchMemoryInput {
  assertObject('searchMemory',value,['scope','query','limit']); if(value.scope!==undefined)assertEnum('scope',value.scope,MEMORY_SCOPES)
  assertString('query',value.query,MAX_QUERY_BYTES,true); assertOptionalPositiveBoundedInteger('limit',value.limit,MAX_MEMORY_SEARCH_LIMIT)
}
export function validatePromoteRoomEventInput(value: unknown): asserts value is PromoteRoomEventInput {
  assertObject('promoteRoomEvent',value,['roomEventId','kind','importance','confidence','idempotencyKey'])
  assertIdentifier('roomEventId',value.roomEventId); assertEnum('kind',value.kind,MEMORY_KINDS)
  assertFiniteRange('importance',value.importance,0,1); assertOptionalFiniteRange('confidence',value.confidence,0,1); assertIdentifier('idempotencyKey',value.idempotencyKey)
}
export function validateProjectId(value: unknown): asserts value is string { assertIdentifier('projectId',value) }
export function validateMemoryId(value: unknown): asserts value is string { assertIdentifier('memoryId',value) }

// Compatibility aliases for adapters using the initial Phase 0 names.
export const validateProjectInput=validateCreateProjectInput
export const validateRoomPost=validatePostRoomEventInput
export function validateRead(room:string,limit?:number,cursor?:string):void{validateReadRoomInput({room,limit,cursor})}
export function validateMemory(text:string,importance:number,confidence?:number,supersedes?:string,sessionId?:string):void{assertString('text',text,MAX_MEMORY_TEXT_BYTES);assertFiniteRange('importance',importance,0,1);assertOptionalFiniteRange('confidence',confidence,0,1);assertOptionalIdentifier('supersedes',supersedes);assertOptionalIdentifier('sessionId',sessionId)}
export function validateSearch(query:string,limit?:number):void{validateSearchMemoryInput({query,limit})}
export function assertNonEmpty(field:string,value:string):void{assertString(field,value,Number.MAX_SAFE_INTEGER)}
export function assertWithinByteBound(field:string,value:string,maxBytes:number):void{assertString(field,value,maxBytes,true)}
