import { randomUUID } from 'node:crypto'
import { assertCapability, FabricAccessError } from '../../src/fabric/capabilities.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import {
  DEFAULT_MEMORY_SEARCH_LIMIT,
  type ArchiveProjectResult, type CallerContext, type CreateProjectInput, type MemoryRecord,
  type MemorySearchResult, type Project, type PromoteRoomEventInput, type PostRoomEventInput,
  type ReadRoomInput, type RememberInput, type RoomEvent, type RoomReadResult, type SearchMemoryInput,
} from '../../src/fabric/types.ts'
import { FabricValidationError, validateCreateProjectInput, validateMemoryId,
  validatePostRoomEventInput, validateProjectId, validatePromoteRoomEventInput,
  validateReadRoomInput, validateRememberInput, validateSearchMemoryInput } from '../../src/fabric/validation.ts'

type Owned<T> = { ownerId: string; value: T }
type IdempotencyRecord = { resultId: string; fingerprint: string; expiresAt: number }
type CursorState = { ownerId:string; projectId:string; room:string; agentId:string; lastSequence:number; expiresAt:number }
type RateWindow = { startedAt:number; count:number }
export const canonicalTupleKey = (values: readonly string[]): string => JSON.stringify(values)

/** Contract fake only. Production code is prevented from importing it by an import-graph test. */
export class InMemoryFabricClient implements FabricClient {
  private sequence = 0
  private readonly projects = new Map<string, Owned<Project>>()
  private readonly roomEvents = new Map<string, Owned<RoomEvent>>()
  private readonly memories = new Map<string, Owned<MemoryRecord>>()
  private readonly deletedMemoryIds = new Set<string>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly cursors = new Map<string, CursorState>()
  private readonly roomSequences = new Map<string, number>()
  private readonly roomExpiresAt = new Map<string, number>()
  private readonly roomReplayFloors = new Map<string, number>()
  private readonly roomBroadcastReplayFloors = new Map<string, number>()
  private readonly roomAgentReplayFloors = new Map<string, number>()
  private readonly rateWindows = new Map<string, RateWindow>()
  private readonly wallNow:()=>number
  private readonly rateMaxEvents:number
  private readonly rateWindowMs:number

  constructor(options:{now?:()=>number;roomRateLimit?:{maxEvents:number;windowMs:number}}={}){
    this.wallNow=options.now??Date.now
    this.rateMaxEvents=options.roomRateLimit?.maxEvents??120
    this.rateWindowMs=options.roomRateLimit?.windowMs??60_000
  }

  snapshot() { return { projects: this.projects.size, roomEvents: this.roomEvents.size, memories: this.memories.size } }

  async createProject(ctx: CallerContext, input: CreateProjectInput): Promise<Project> {
    assertCapability(ctx, 'project:create')
    validateCreateProjectInput(input)
    const addsOtherMember=(input.memberAgentIds??[]).some(id=>id!==ctx.agentId)
    if(addsOtherMember){ if(ctx.actorType!=='owner')throw new FabricAccessError(); assertCapability(ctx,'project:members') }
    const members = [...new Set([ctx.agentId, ...(input.memberAgentIds ?? [])])]
    const projectId = this.id('project')
    const project: Project = Object.freeze({
      projectId, displayName: input.displayName, repoRef: input.repoRef, workspaceRef: input.workspaceRef,
      memberAgentIds: Object.freeze(members), memoryNamespace: `project:${projectId}:memory`,
      roomNamespace: `project:${projectId}:room`, retention: input.retention && Object.freeze({ ...input.retention }),
      createdAt: this.now(),
    })
    this.projects.set(projectId, { ownerId: ctx.ownerId, value: project })
    return project
  }

  async listProjects(ctx: CallerContext): Promise<Project[]> {
    assertCapability(ctx, 'project:read')
    return [...this.projects.values()].filter(e => e.ownerId === ctx.ownerId && (ctx.actorType === 'owner' || e.value.memberAgentIds.includes(ctx.agentId))).map(e => e.value)
  }
  async getProject(ctx: CallerContext, projectId: string): Promise<Project | null> {
    assertCapability(ctx, 'project:read'); validateProjectId(projectId)
    const entry = this.projects.get(projectId)
    return entry?.ownerId === ctx.ownerId && (ctx.actorType === 'owner' || entry.value.memberAgentIds.includes(ctx.agentId)) ? entry.value : null
  }
  async archiveProject(ctx: CallerContext, projectId: string): Promise<ArchiveProjectResult> {
    assertCapability(ctx, 'project:archive'); validateProjectId(projectId)
    const entry = this.authorizedProject(ctx, projectId, false)
    if (entry.value.archivedAt) return { project: entry.value, alreadyArchived: true }
    const project = Object.freeze({ ...entry.value, archivedAt: this.now() })
    entry.value = project
    return { project, alreadyArchived: false }
  }

  async postRoomEvent(ctx: CallerContext, input: PostRoomEventInput): Promise<RoomEvent> {
    assertCapability(ctx, 'room:post')
    const project = this.currentActiveProject(ctx)
    validatePostRoomEventInput(input)
    this.deleteExpiredRoomState()
    if (input.toAgentId && !project.value.memberAgentIds.includes(input.toAgentId)) throw new FabricAccessError()
    if (input.replyTo) {
      const reply = this.roomEvents.get(input.replyTo)
      if (!reply || reply.ownerId !== ctx.ownerId || reply.value.projectId !== project.value.projectId || reply.value.room !== input.room || (ctx.actorType !== 'owner' && reply.value.toAgentId && reply.value.fromAgentId !== ctx.agentId && reply.value.toAgentId !== ctx.agentId)) throw new FabricAccessError()
    }
    const dedupeKey = canonicalTupleKey([ctx.ownerId,project.value.projectId,ctx.agentId,input.idempotencyKey])
    let ttlHops=input.ttlHops??project.value.retention?.roomEventTtlHops??8
    if(input.replyTo){
      const parent=this.roomEvents.get(input.replyTo)!.value
      const remaining=parent.ttlHops-1
      if(remaining<1||(input.ttlHops!==undefined&&input.ttlHops>remaining))throw new FabricValidationError('ttlHops')
      ttlHops=input.ttlHops??remaining
    }
    const fingerprint=this.fingerprint([input.room,input.type,input.body,input.toAgentId,input.replyTo,input.correlationId,input.artifactRefs??[],ttlHops,ctx.deviceId,input.sessionId])
    const priorRecord = this.idempotency.get(dedupeKey)
    if (priorRecord) { if(priorRecord.fingerprint!==fingerprint)throw new FabricAccessError(); const prior=this.roomEvents.get(priorRecord.resultId);if(!prior)throw new FabricAccessError();return prior.value }
    this.consumeRate(ctx,project.value.projectId)
    const event: RoomEvent = Object.freeze({
      id: this.id('event'), projectId: project.value.projectId, room: input.room, type: input.type,
      fromAgentId: ctx.agentId, toAgentId: input.toAgentId, replyTo: input.replyTo,
      correlationId: input.correlationId, body: input.body,
      artifactRefs: input.artifactRefs && Object.freeze([...input.artifactRefs]), createdAt: this.now(),
      ttlHops,
      provenance: Object.freeze({ deviceId: ctx.deviceId, sessionId: input.sessionId }),
    })
    this.roomEvents.set(event.id, { ownerId: ctx.ownerId, value: event })
    this.roomSequences.set(event.id,this.sequence)
    const retentionMs=(project.value.retention?.roomRetentionDays??30)*86_400_000
    const expiresAt=this.wallNow()+retentionMs
    this.roomExpiresAt.set(event.id,expiresAt)
    for(const cursor of this.cursors.values())if(cursor.ownerId===ctx.ownerId&&cursor.projectId===project.value.projectId&&cursor.room===input.room)cursor.expiresAt=Math.max(cursor.expiresAt,expiresAt)
    this.idempotency.set(dedupeKey, {resultId:event.id,fingerprint,expiresAt})
    return event
  }

  async readRoom(ctx: CallerContext, input: ReadRoomInput): Promise<RoomReadResult> {
    assertCapability(ctx, 'room:read'); const project = this.currentActiveProject(ctx)
    validateReadRoomInput(input)
    this.deleteExpiredRoomState()
    const replayFloor = this.effectiveReplayFloor(ctx, project.value.projectId, input.room)
    let lastSequence = replayFloor
    if (input.cursor !== undefined) {
      const cursor = this.cursors.get(input.cursor)
      if (!cursor || cursor.ownerId !== ctx.ownerId || cursor.projectId !== project.value.projectId || cursor.room !== input.room || cursor.agentId!==ctx.agentId || cursor.expiresAt<=this.wallNow()) throw new FabricValidationError('cursor')
      lastSequence = cursor.lastSequence
      if(lastSequence<replayFloor)throw new FabricValidationError('cursor')
    }
    const visible = [...this.roomEvents.values()].filter(({ ownerId, value }) => ownerId === ctx.ownerId && value.projectId === project.value.projectId && value.room === input.room && (this.roomSequences.get(value.id)??0)>lastSequence && this.isRoomEventDeliverable(ctx,value)).map(e => e.value)
    const events = visible.slice(0, input.limit ?? 100)
    if(events.length>0)lastSequence=this.roomSequences.get(events.at(-1)!.id)??lastSequence
    const retentionMs=(project.value.retention?.roomRetentionDays??30)*86_400_000
    const existingCheckpoint=input.cursor!==undefined&&events.length>0?[...this.cursors.entries()].find(([,cursor])=>cursor.ownerId===ctx.ownerId&&cursor.projectId===project.value.projectId&&cursor.room===input.room&&cursor.agentId===ctx.agentId&&cursor.lastSequence===lastSequence&&cursor.expiresAt>this.wallNow())?.[0]:undefined
    const outputCursor=input.cursor===undefined||events.length>0?existingCheckpoint??randomUUID():input.cursor
    if(!this.cursors.has(outputCursor))this.cursors.set(outputCursor,{ownerId:ctx.ownerId,projectId:project.value.projectId,room:input.room,agentId:ctx.agentId,lastSequence,expiresAt:this.wallNow()+retentionMs})
    return { events, cursor:outputCursor }
  }

  async remember(ctx: CallerContext, input: RememberInput): Promise<MemoryRecord> {
    assertCapability(ctx, 'memory:write'); validateRememberInput(input)
    let projectId: string | undefined
    let agentId: string | undefined
    if (input.scope === 'user') {
      if (ctx.projectId !== undefined || input.authorship !== 'owner' || ctx.actorType !== 'owner') throw new FabricAccessError()
      assertCapability(ctx, 'memory:write:user')
    } else if (input.scope === 'project') {
      projectId = this.currentActiveProject(ctx).value.projectId
    } else {
      agentId = ctx.agentId
      if (ctx.projectId !== undefined) projectId = this.currentActiveProject(ctx).value.projectId
    }
    if (input.supersedes) this.validateSupersedes(ctx, input.supersedes, input.scope, projectId, agentId)
    // A repeated write merges into the existing record and raises it; the id
    // returned is the *existing* one. Normalization is reimplemented here rather
    // than imported, so a change to the production rule shows up as a contract
    // failure instead of following the double along silently.
    if (!input.supersedes) {
      const duplicate = this.findDuplicateMemory(ctx, input.scope, projectId, agentId, input.text)
      if (duplicate) {
        const merged: MemoryRecord = Object.freeze({
          ...duplicate.value,
          importance: Math.max(duplicate.value.importance, input.importance),
          ...(input.confidence === undefined ? {} : { confidence: Math.max(duplicate.value.confidence ?? input.confidence, input.confidence) }),
          updatedAt: this.now(),
        })
        this.memories.set(merged.id, { ownerId: ctx.ownerId, value: merged })
        return merged
      }
    }
    const source = input.scope === 'user'
      ? Object.freeze({ type: 'user' as const })
      : Object.freeze({ type: 'agent' as const, agentId: ctx.agentId, sessionId: input.sessionId })
    const record: MemoryRecord = Object.freeze({
      id: this.id('memory'), scope: input.scope, projectId, agentId, kind: input.kind, text: input.text,
      importance: input.importance, confidence: input.confidence, createdAt: this.now(), updatedAt: this.now(),
      source, supersedes: input.supersedes,
    })
    this.memories.set(record.id, { ownerId: ctx.ownerId, value: record })
    return record
  }

  async searchMemory(ctx: CallerContext, input: SearchMemoryInput): Promise<MemorySearchResult> {
    assertCapability(ctx, 'memory:read'); validateSearchMemoryInput(input)
    if (ctx.projectId !== undefined) this.currentActiveProject(ctx)
    const query = input.query.toLocaleLowerCase()
    const records = [...this.memories.values()].filter(e => e.ownerId === ctx.ownerId && !this.deletedMemoryIds.has(e.value.id) && this.canReadMemory(ctx, e.value))
      .map(e => e.value).filter(r => !this.isSuperseded(ctx, r.id) && (!input.scope || r.scope === input.scope) && r.text.toLocaleLowerCase().includes(query)).slice(0, input.limit ?? DEFAULT_MEMORY_SEARCH_LIMIT)
    return { records }
  }

  /** Exact-duplicate normalization: whitespace, case, and terminal punctuation only. */
  private normalizedMemoryText(text: string): string {
    return text.normalize('NFKC').trim().replace(/[.?!]+$/u, '').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  }

  private isSuperseded(ctx: CallerContext, id: string): boolean {
    return [...this.memories.values()].some(candidate => candidate.ownerId === ctx.ownerId && candidate.value.supersedes === id)
  }

  private currentPromotedMemory(ctx: CallerContext, projectId: string, roomEventId: string): Owned<MemoryRecord> | undefined {
    return [...this.memories.values()]
      .filter(entry => entry.ownerId === ctx.ownerId && !this.deletedMemoryIds.has(entry.value.id)
        && entry.value.scope === 'project' && entry.value.projectId === projectId
        && entry.value.source.type === 'room' && entry.value.source.roomEventId === roomEventId
        && !this.isSuperseded(ctx, entry.value.id))
      .sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt) || a.value.id.localeCompare(b.value.id))[0]
  }

  private findDuplicateMemory(ctx: CallerContext, scope: RememberInput['scope'], projectId: string | undefined, agentId: string | undefined, text: string): Owned<MemoryRecord> | undefined {
    const digest = this.normalizedMemoryText(text)
    return [...this.memories.values()]
      .filter(entry => entry.ownerId === ctx.ownerId && !this.deletedMemoryIds.has(entry.value.id)
        && entry.value.scope === scope && entry.value.projectId === projectId && entry.value.agentId === agentId
        && this.normalizedMemoryText(entry.value.text) === digest && !this.isSuperseded(ctx, entry.value.id))
      .sort((a, b) => b.value.updatedAt.localeCompare(a.value.updatedAt) || a.value.id.localeCompare(b.value.id))[0]
  }
  async getMemory(ctx: CallerContext, id: string): Promise<MemoryRecord | null> {
    assertCapability(ctx, 'memory:read'); validateMemoryId(id)
    const entry = this.memories.get(id)
    if (!entry || this.deletedMemoryIds.has(id) || entry.ownerId !== ctx.ownerId || !this.canReadMemory(ctx, entry.value)) throw new FabricAccessError()
    return entry.value
  }
  async forgetMemory(ctx: CallerContext, id: string): Promise<void> {
    assertCapability(ctx, 'memory:delete'); validateMemoryId(id)
    const entry = this.memories.get(id)
    if (!entry || this.deletedMemoryIds.has(id) || entry.ownerId !== ctx.ownerId || !this.canReadMemory(ctx, entry.value)) throw new FabricAccessError()
    this.deletedMemoryIds.add(id)
  }
  async promoteRoomEvent(ctx: CallerContext, input: PromoteRoomEventInput): Promise<MemoryRecord> {
    assertCapability(ctx, 'room:read'); assertCapability(ctx, 'memory:write'); const project = this.currentActiveProject(ctx)
    validatePromoteRoomEventInput(input)
    this.deleteExpiredRoomState()
    const entry = this.roomEvents.get(input.roomEventId)
    if (!entry || entry.ownerId !== ctx.ownerId || entry.value.projectId !== project.value.projectId || (ctx.actorType !== 'owner' && entry.value.toAgentId && entry.value.fromAgentId !== ctx.agentId && entry.value.toAgentId !== ctx.agentId)) throw new FabricAccessError()
    const dedupeKey = canonicalTupleKey([ctx.ownerId,project.value.projectId,ctx.agentId,'promotion',input.idempotencyKey])
    const fingerprint=this.fingerprint([input.roomEventId,input.kind,input.importance,input.confidence])
    const priorRecord = this.idempotency.get(dedupeKey)
    if (priorRecord) { if(priorRecord.fingerprint!==fingerprint)throw new FabricAccessError();const prior = this.memories.get(priorRecord.resultId); if (!prior || this.deletedMemoryIds.has(priorRecord.resultId)) throw new FabricAccessError(); return prior.value }
    const expiresAtMs=this.roomExpiresAt.get(entry.value.id)
    if(expiresAtMs===undefined)throw new FabricAccessError()
    // Restated rather than imported, for the same reason as the remember merge:
    // an idempotency key is per caller and per attempt, so consolidation on this
    // path keys on the source room event the survivor was promoted from.
    const promoted = this.currentPromotedMemory(ctx, project.value.projectId, entry.value.id)
    if (promoted) {
      const merged: MemoryRecord = Object.freeze({
        ...promoted.value,
        importance: Math.max(promoted.value.importance, input.importance),
        ...(input.confidence === undefined ? {} : { confidence: Math.max(promoted.value.confidence ?? input.confidence, input.confidence) }),
        updatedAt: this.now(),
      })
      this.memories.set(merged.id, { ownerId: ctx.ownerId, value: merged })
      this.idempotency.set(dedupeKey,{resultId:merged.id,fingerprint,expiresAt:expiresAtMs})
      return merged
    }
    const record: MemoryRecord = Object.freeze({
      id: this.id('memory'), scope: 'project', projectId: project.value.projectId, kind: input.kind,
      text: entry.value.body, importance: input.importance, confidence: input.confidence, createdAt: this.now(), updatedAt: this.now(),
      source: Object.freeze({ type: 'room', agentId: entry.value.fromAgentId, roomEventId: entry.value.id, sessionId:entry.value.provenance.sessionId }),
    })
    this.memories.set(record.id, { ownerId: ctx.ownerId, value: record }); this.idempotency.set(dedupeKey,{resultId:record.id,fingerprint,expiresAt:expiresAtMs}); return record
  }

  private authorizedProject(ctx: CallerContext, projectId: string, active: boolean): Owned<Project> {
    const entry = this.projects.get(projectId)
    if (!entry || entry.ownerId !== ctx.ownerId || (ctx.actorType !== 'owner' && !entry.value.memberAgentIds.includes(ctx.agentId)) || (active && entry.value.archivedAt)) throw new FabricAccessError()
    return entry
  }
  private currentActiveProject(ctx: CallerContext): Owned<Project> {
    if (!ctx.projectId) throw new FabricAccessError()
    return this.authorizedProject(ctx, ctx.projectId, true)
  }
  private canReadMemory(ctx: CallerContext, record: MemoryRecord): boolean {
    if (record.scope === 'user') return ctx.actorType === 'owner' && ctx.capabilities.has('memory:read:user') && ctx.projectId === undefined
    if (ctx.projectId !== undefined) { try { this.currentActiveProject(ctx) } catch { return false } }
    if (record.scope === 'agent') return record.agentId === ctx.agentId && record.projectId === ctx.projectId
    return record.projectId === ctx.projectId
  }
  private validateSupersedes(ctx: CallerContext, id: string, scope: string, projectId?: string, agentId?: string): void {
    const entry = this.memories.get(id)
    const successor=[...this.memories.values()].some(candidate=>candidate.ownerId===ctx.ownerId&&!this.deletedMemoryIds.has(candidate.value.id)&&candidate.value.supersedes===id)
    if (!entry || this.deletedMemoryIds.has(id) || entry.ownerId !== ctx.ownerId || !this.canReadMemory(ctx, entry.value) || entry.value.scope !== scope || entry.value.projectId !== projectId || entry.value.agentId !== agentId || successor) throw new FabricAccessError()
  }
  private consumeRate(ctx:CallerContext,projectId:string):void{
    const key=canonicalTupleKey([ctx.ownerId,projectId,ctx.agentId]),now=this.wallNow(),window=this.rateWindows.get(key)
    if(!window||now-window.startedAt>=this.rateWindowMs){this.rateWindows.set(key,{startedAt:now,count:1});return}
    if(window.count>=this.rateMaxEvents)throw new FabricValidationError('rateLimit')
    window.count++
  }
  /**
   * An owner sees every event, so its floor is room-global (roomReplayFloors). A non-owner
   * reader only receives broadcast events plus events it sent or received, excluding its own
   * replies, so its floor is scoped by that exact predicate.
   */
  private effectiveReplayFloor(ctx:CallerContext,projectId:string,room:string):number{
    const key=this.streamKey(ctx.ownerId,projectId,room)
    if(ctx.actorType==='owner')return this.roomReplayFloors.get(key)??0
    return Math.max(
      this.roomBroadcastReplayFloors.get(key)??0,
      this.roomAgentReplayFloors.get(canonicalTupleKey([key,ctx.agentId]))??0,
    )
  }
  private isRoomEventDeliverable(ctx:CallerContext,event:RoomEvent):boolean{
    return ctx.actorType==='owner'||((!event.toAgentId||event.fromAgentId===ctx.agentId||event.toAgentId===ctx.agentId)&&!(event.fromAgentId===ctx.agentId&&event.replyTo!==undefined))
  }
  private deleteExpiredRoomState():void{
    const now=this.wallNow()
    for(const [token,cursor]of this.cursors)if(cursor.expiresAt<=now)this.cursors.delete(token)
    for(const [key,record]of this.idempotency)if(record.expiresAt<=now)this.idempotency.delete(key)
    for(const [id,expiresAt]of this.roomExpiresAt)if(expiresAt<=now){
      const event=this.roomEvents.get(id)
      const sequence=this.roomSequences.get(id)??0
      if(event){
        const key=this.streamKey(event.ownerId,event.value.projectId,event.value.room)
        this.roomReplayFloors.set(key,Math.max(this.roomReplayFloors.get(key)??0,sequence))
        if(!event.value.toAgentId&&!event.value.replyTo){
          this.roomBroadcastReplayFloors.set(key,Math.max(this.roomBroadcastReplayFloors.get(key)??0,sequence))
        }else{
          const project=this.projects.get(event.value.projectId)?.value
          const deliveredAgents=!event.value.toAgentId
            ? (project?.memberAgentIds??[]).filter(agentId=>agentId!==event.value.fromAgentId)
            : [event.value.toAgentId,...(event.value.replyTo?[]:[event.value.fromAgentId])]
          for(const agentId of new Set(deliveredAgents))if(!event.value.replyTo||agentId!==event.value.fromAgentId){
            const agentKey=canonicalTupleKey([key,agentId])
            this.roomAgentReplayFloors.set(agentKey,Math.max(this.roomAgentReplayFloors.get(agentKey)??0,sequence))
          }
        }
      }
      this.roomExpiresAt.delete(id);this.roomSequences.delete(id);this.roomEvents.delete(id)
    }
  }
  private streamKey(ownerId:string,projectId:string,room:string):string{return canonicalTupleKey([ownerId,projectId,room])}
  private fingerprint(value:unknown):string{return JSON.stringify(value)}
  private id(prefix: string): string { return `${prefix}-${++this.sequence}` }
  private now(): string { return new Date(this.sequence * 1_000).toISOString() }
}
