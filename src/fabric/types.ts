/** Framework-independent Phase 0 Agent Fabric contracts. */

export type FabricCapability =
  | 'project:create' | 'project:members' | 'project:read' | 'project:archive'
  | 'memory:read' | 'memory:read:user' | 'memory:write' | 'memory:write:user' | 'memory:delete'
  | 'room:read' | 'room:post' | 'task:claim'
  | 'session:control' | 'session:open' | 'shell:execute' | 'device:add' | 'device:revoke'

export interface CallerContext {
  readonly ownerId: string
  readonly deviceId: string
  readonly agentId: string
  readonly projectId?: string
  readonly actorType: 'agent' | 'owner'
  readonly capabilities: ReadonlySet<FabricCapability>
}

export interface RetentionPolicy {
  readonly roomEventTtlHops?: number
  readonly roomRetentionDays?: number
}

export interface Project {
  readonly projectId: string
  readonly displayName: string
  readonly repoRef?: string
  readonly workspaceRef?: string
  readonly memberAgentIds: readonly string[]
  readonly memoryNamespace: string
  readonly roomNamespace: string
  readonly retention?: RetentionPolicy
  readonly createdAt: string
  readonly archivedAt?: string
}

export type RoomEventType = 'message' | 'question' | 'answer' | 'decision' | 'discovery' | 'task' | 'claim' | 'progress' | 'blocked' | 'handoff' | 'artifact' | 'system'
export interface RoomEventProvenance { readonly deviceId: string; readonly sessionId?: string }
export interface RoomEvent {
  readonly id: string
  readonly projectId: string
  readonly room: string
  readonly type: RoomEventType
  readonly fromAgentId: string
  readonly toAgentId?: string
  readonly replyTo?: string
  readonly correlationId?: string
  readonly body: string
  readonly artifactRefs?: readonly string[]
  readonly createdAt: string
  readonly ttlHops: number
  readonly provenance: RoomEventProvenance
}

export type MemoryScope = 'user' | 'project' | 'agent'
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'constraint' | 'discovery' | 'procedure' | 'handoff' | 'summary'
export interface MemorySource { readonly type: 'user' | 'agent' | 'room' | 'system'; readonly agentId?: string; readonly roomEventId?: string; readonly sessionId?: string }
export interface MemoryRecord {
  readonly id: string
  readonly scope: MemoryScope
  readonly projectId?: string
  readonly agentId?: string
  readonly kind: MemoryKind
  readonly text: string
  readonly importance: number
  readonly confidence?: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly source: MemorySource
  readonly supersedes?: string
  readonly deletedAt?: string
}

export interface CreateProjectInput {
  readonly displayName: string
  readonly repoRef?: string
  readonly workspaceRef?: string
  readonly memberAgentIds?: readonly string[]
  readonly retention?: RetentionPolicy
}
export interface ArchiveProjectResult { readonly project: Project; readonly alreadyArchived: boolean }
export interface PostRoomEventInput {
  readonly room: string
  readonly type: RoomEventType
  readonly body: string
  readonly idempotencyKey: string
  readonly toAgentId?: string
  readonly replyTo?: string
  readonly correlationId?: string
  readonly artifactRefs?: readonly string[]
  readonly ttlHops?: number
  readonly sessionId?: string
}
/** A supplied cursor is an immutable acknowledged checkpoint. Reads never
 * mutate it; callers advance only by adopting the cursor returned with a
 * successfully delivered result. */
export interface ReadRoomInput { readonly room: string; readonly cursor?: string; readonly limit?: number }
export interface RoomReadResult { readonly events: readonly RoomEvent[]; readonly cursor?: string }
export interface RememberInput {
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly text: string
  readonly importance: number
  readonly confidence?: number
  /** Only a trusted owner context may request owner authorship. */
  readonly authorship?: 'agent' | 'owner'
  readonly sessionId?: string
  readonly supersedes?: string
}
export interface SearchMemoryInput { readonly scope?: MemoryScope; readonly query: string; readonly limit?: number }
export interface MemorySearchResult { readonly records: readonly MemoryRecord[] }
export interface PromoteRoomEventInput { readonly roomEventId: string; readonly kind: MemoryKind; readonly importance: number; readonly confidence?: number; readonly idempotencyKey: string }

export const MAX_IDENTIFIER_BYTES = 256
export const MAX_DISPLAY_NAME_BYTES = 256
export const MAX_REFERENCE_BYTES = 2_048
export const MAX_QUERY_BYTES = 4_096
export const MAX_ROOM_EVENT_BODY_BYTES = 16_384
export const MAX_MEMORY_TEXT_BYTES = 16_384
export const MAX_ARTIFACT_REFS = 32
export const MAX_PROJECT_MEMBER_AGENT_IDS = 128
export const MAX_ROOM_READ_LIMIT = 500
export const MAX_MEMORY_SEARCH_LIMIT = 100
/**
 * Applied when a caller names no limit. A caller that does name one is honoured
 * up to `MAX_MEMORY_SEARCH_LIMIT`: the advertised bound, the validated bound,
 * and the bound the engine enforces are one number, because a result set
 * truncated below what was asked carries nothing to say so. Compactness is
 * bounded by the serialized-response budget, not by a second hidden cap.
 */
export const DEFAULT_MEMORY_SEARCH_LIMIT = 20
export const MAX_TTL_HOPS = 64
export const MAX_RETENTION_DAYS = 3_650
