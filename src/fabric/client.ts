/**
 * src/fabric/client.ts — the FabricClient seam (spec §15, ADR 0001).
 *
 * This is a boundary, not an implementation. Phase 0 ships zero
 * implementations of it under `src/` — only the interface, so future real
 * adapters (Phase 1 local, Phase 2 SQLite/ICM-backed, Phase 3 embedded
 * NATS-backed) and the Phase-0-only contract adapter in the test tree are
 * all provable against the same contract.
 *
 * Every method takes an explicit `CallerContext` as its first argument.
 * There is no global/ambient caller identity anywhere in this interface —
 * an implementation that reached for one would not satisfy this type.
 */

import type {
  ArchiveProjectResult,
  CallerContext,
  CreateProjectInput,
  MemoryRecord,
  MemorySearchResult,
  Project,
  PromoteRoomEventInput,
  PostRoomEventInput,
  ReadRoomInput,
  RememberInput,
  RoomEvent,
  RoomReadResult,
  SearchMemoryInput,
} from './types.ts'

export interface FabricClient {
  createProject(ctx: CallerContext, input: CreateProjectInput): Promise<Project>
  listProjects(ctx: CallerContext): Promise<Project[]>
  getProject(ctx: CallerContext, projectId: string): Promise<Project | null>
  archiveProject(ctx: CallerContext, projectId: string): Promise<ArchiveProjectResult>

  postRoomEvent(ctx: CallerContext, input: PostRoomEventInput): Promise<RoomEvent>
  readRoom(ctx: CallerContext, input: ReadRoomInput): Promise<RoomReadResult>

  remember(ctx: CallerContext, input: RememberInput): Promise<MemoryRecord>
  searchMemory(ctx: CallerContext, input: SearchMemoryInput): Promise<MemorySearchResult>
  getMemory(ctx: CallerContext, id: string): Promise<MemoryRecord | null>
  forgetMemory(ctx: CallerContext, id: string): Promise<void>
  promoteRoomEvent(ctx: CallerContext, input: PromoteRoomEventInput): Promise<MemoryRecord>
}
