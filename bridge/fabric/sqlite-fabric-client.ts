import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import {
  assertCapability,
  FabricAccessError,
  FabricAuthError,
  isTrustedCallerContext,
} from '../../src/fabric/capabilities.ts'
import {
  FABRICD_MAX_FETCH_BYTES,
  FABRICD_MAX_FETCH_LIMIT,
  FABRICD_MAX_PAYLOAD_BYTES,
  FabricdBusError,
  type BusRetention,
  type RoomBus,
} from '../../src/fabric/bus-contract.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import {
  DEFAULT_MEMORY_SEARCH_LIMIT,
  MAX_MEMORY_SEARCH_LIMIT,
  MAX_TTL_HOPS,
  type ArchiveProjectResult,
  type CallerContext,
  type CreateProjectInput,
  type MemoryRecord,
  type MemorySearchResult,
  type Project,
  type PromoteRoomEventInput,
  type PostRoomEventInput,
  type ReadRoomInput,
  type RememberInput,
  type RoomEvent,
  type RoomReadResult,
  type SearchMemoryInput,
} from '../../src/fabric/types.ts'
import {
  FabricValidationError,
  validateCreateProjectInput,
  validateMemoryId,
  validatePostRoomEventInput,
  validateProjectId,
  validatePromoteRoomEventInput,
  validateReadRoomInput,
  validateRememberInput,
  validateSearchMemoryInput,
} from '../../src/fabric/validation.ts'
import { DeterministicEmbeddingProvider, type EmbeddingProvider } from './memory/embedding.ts'
import { hybridScore, normalizeMemoryText } from './memory/ranker.ts'
import { createLocalVectorStore, type LocalVectorStore, type VectorBackend } from './memory/vector-store.ts'

// Vitest 2 does not know about this Node 22 builtin. Native require preserves
// the real node:sqlite implementation without adding a package dependency.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export const CURRENT_FABRIC_SCHEMA_VERSION = 13
/** The 5th agent post in a row in one room wakes nobody; an owner post starts the count again. */
export const HOP_BUDGET = 5
/** Names one post may wake; the rest are ignored. */
export const MAX_MENTIONS = 10
export const DEFAULT_ROOM_EVENT_TTL_HOPS = 8
export const DEFAULT_ROOM_RETENTION_DAYS = 30
export const DEFAULT_CURSOR_TTL_MS = DEFAULT_ROOM_RETENTION_DAYS * 86_400_000
export const DEFAULT_ROOM_RATE_LIMIT = Object.freeze({ maxEvents: 120, windowMs: 60_000 })
/** One foreground operation performs at most one batch for each cleanup class. */
/**
 * How much longer the bus keeps an event than the bridge's own expiry.
 *
 * The bridge decides visibility; the bus window is a floor under it. Headroom
 * means a clock difference or a slow cleanup pass can never let the durable
 * copy expire while the room still considers the event live.
 */
export const BUS_RETENTION_HEADROOM = 1.25

/**
 * Per-project bus bounds. Section 8.2 requires retention to be bounded, not off.
 *
 * Age is the retention a project feels, and it carries headroom over the
 * bridge's own expiry so the durable copy outlives the visible one. Bytes and
 * messages are backstops under it, and they are the two bounds that can drop an
 * event the projection still considers live. That is survivable rather than
 * silent: reconciliation compares the log's first retained sequence against
 * what it has consumed and fences the room when they disagree.
 *
 * The byte bound cannot simply be made enormous. JetStream reserves it against
 * the store when a project's stream is created rather than as the stream fills,
 * so it divides the store budget into a project count - an 8 GiB choice here
 * allowed five projects per device before enrollment began failing.
 */
export const BUS_MAX_PROJECT_MESSAGES = 1_000_000
export const BUS_MAX_PROJECT_BYTES = 256 * 1024 * 1024
export const BUS_DUPLICATE_WINDOW_SECONDS = 7_200

/** Bounds one reconciliation so a pathological backlog cannot park a read. */
export const FABRIC_RECONCILE_MAX_BATCHES = 1024

export const FABRIC_CLEANUP_BATCH_SIZE = 64
/** Startup is not a public operation, so it may drain several batches, bounded so a corrupt backlog cannot hang init. */
export const FABRIC_STARTUP_CLEANUP_MAX_BATCHES = 1024
/**
 * Cosine similarity from a feature-hash embedding is not comparable across
 * queries: a measured true paraphrase scores ~.23 while an unanswerable query
 * can produce ~.30 against pure filler. A single absolute cutoff is therefore
 * both too strict and too loose, so semantic-only retrieval admits the nearest
 * eligible neighbours under a bounded budget and lets the hybrid score order
 * them. The floor only rejects effectively orthogonal records.
 */
export const SEMANTIC_ORTHOGONAL_FLOOR = .1
/** Upper bound on records admitted by similarity alone when nothing matched lexically. */
export const MAX_SEMANTIC_ONLY_CANDIDATES = 5

export type FabricAuditAction =
  | 'project.create' | 'project.list' | 'project.get' | 'project.archive'
  | 'room.post' | 'room.read'
  | 'memory.remember' | 'memory.search' | 'memory.get' | 'memory.forget' | 'memory.promote'

/** Deliberately metadata-only. Bodies, memory text, queries, refs, and paths have no field here. */
export interface FabricAuditEntry {
  readonly timestamp: string
  readonly action: FabricAuditAction
  readonly status: 'ok' | 'denied' | 'failed'
  readonly ownerId: string
  readonly deviceId: string
  readonly agentId: string
  readonly actorType: 'agent' | 'owner' | 'unknown'
  readonly projectId?: string
  readonly targetId?: string
  readonly byteCount?: number
  readonly resultCount?: number
  readonly correlationId?: string
  /**
   * Set when a `memory.remember` write was absorbed into an existing record
   * rather than creating one. The merge writes into a record another agent may
   * own and raises its importance, so without this the trail cannot separate
   * "stored a new memory" from "absorbed into someone else's".
   */
  readonly merged?: boolean
}

export interface SQLiteFabricClientOptions {
  readonly databasePath: string
  readonly now?: () => number
  readonly busyTimeoutMs?: number
  readonly roomRateLimit?: {
    readonly maxEvents: number
    readonly windowMs: number
  }
  readonly audit?: (entry: FabricAuditEntry) => void
  readonly embeddingProvider?: EmbeddingProvider
  /**
   * Force the local vector backend instead of preferring the native extension
   * when it loads. Requesting `sqlite-vec` fails startup when the pinned
   * optional binary is absent, so a benchmark cannot silently report the
   * packaged fallback's numbers as the native backend's.
   */
  readonly vectorBackend?: VectorBackend
  /**
   * The durable log room events are written to (Phase 3).
   *
   * When present, a room event is not accepted until the bus has stored it,
   * and `room_events` becomes a projection this client rebuilds from the bus
   * rather than the record of what was posted. Absent, room events are durable
   * only in SQLite - the Phase 1 arrangement, still used by the in-process
   * tests that predate the bus.
   */
  readonly bus?: RoomBus
  /**
   * Called once per fresh post that names at least one session to wake, after the post is
   * committed and outside its transaction. A throw is caught: it never fails or undoes the post.
   */
  readonly onWake?: (wake: { names: string[]; room: string; eventId: string; projectId: string }) => void
}

/** `@name` (a session on the memory home's computer) or `@computer:name`; not inside an email or after `@` or `:`. */
const MENTION = /(?<![A-Za-z0-9._@:-])@((?:[a-z0-9._-]{1,64}:)?[A-Za-z0-9._-]{1,256})/g

/** The sessions a room post names: trailing dots dropped (a sentence end), distinct, in order, at most MAX_MENTIONS. */
export function mentionsIn(body: string): string[] {
  const names: string[] = []
  for (const match of body.matchAll(MENTION)) {
    if (names.length === MAX_MENTIONS) break
    const name = match[1].replace(/\.+$/, '')
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * One room event in the form the bus carries it.
 *
 * This is the whole event, not a reference to one: the bus is the durable
 * store, so everything needed to rebuild a projected row has to travel in the
 * payload. `expiresAtMs` is the bridge's logical retention rather than the
 * bus's, so a rebuilt event ages out exactly when the original would have.
 */
interface RoomEventRecord {
  readonly id: string
  readonly ownerId: string
  readonly projectId: string
  readonly room: string
  readonly type: string
  readonly fromAgentId: string
  readonly toAgentId?: string
  readonly replyTo?: string
  readonly correlationId?: string
  readonly body: string
  readonly artifactRefs?: readonly string[]
  readonly createdAt: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly ttlHops: number
  readonly deviceId: string
  readonly sessionId?: string
}

interface FreshRoomPost {
  readonly kind: 'fresh'
  readonly project: Project
  readonly now: number
  readonly fingerprint: string
  readonly record: RoomEventRecord
  readonly idempotencyKey: string
}

type PreparedRoomPost = FreshRoomPost | { readonly kind: 'duplicate'; readonly event: RoomEvent }

type FabricAuditFields = Omit<FabricAuditEntry, 'timestamp' | 'action' | 'status' | 'ownerId' | 'deviceId' | 'agentId' | 'actorType'>

/** Public storage errors never expose a path, statement, identifier, or content. */
export class FabricStorageError extends Error {
  constructor() {
    super('fabric storage is unavailable')
    this.name = 'FabricStorageError'
  }
}

type SqlValue = string | number | bigint | null | Uint8Array
type SqlRow = Record<string, SqlValue>
type SchemaColumnRequirement = readonly [name: string, type: string, notNull: 0 | 1, primaryKeyOrder: number]

const SCHEMA_V1 = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repo_ref TEXT,
  workspace_ref TEXT,
  memory_namespace TEXT NOT NULL,
  room_namespace TEXT NOT NULL,
  retention_ttl_hops INTEGER,
  retention_days INTEGER,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (owner_id, project_id),
  CHECK (retention_ttl_hops IS NULL OR retention_ttl_hops BETWEEN 1 AND 64),
  CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650)
);

CREATE TABLE project_members (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id, agent_id),
  FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, project_id)
);

CREATE TABLE room_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  type TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  reply_to TEXT,
  correlation_id TEXT,
  body TEXT NOT NULL,
  artifact_refs_json TEXT,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  ttl_hops INTEGER NOT NULL CHECK (ttl_hops BETWEEN 1 AND 64),
  provenance_device_id TEXT NOT NULL,
  provenance_session_id TEXT,
  FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, project_id)
);
CREATE INDEX room_events_stream_idx ON room_events(owner_id, project_id, room, sequence);
CREATE INDEX room_events_expiry_idx ON room_events(expires_at_ms);
CREATE INDEX room_events_stream_expiry_idx ON room_events(owner_id, project_id, room, expires_at_ms);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user','project','agent')),
  project_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('preference','fact','decision','constraint','discovery','procedure','handoff','summary')),
  text TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user','agent','room','system')),
  source_agent_id TEXT,
  source_room_event_id TEXT,
  source_session_id TEXT,
  supersedes TEXT,
  deleted_at TEXT,
  CHECK (
    (scope = 'user' AND project_id IS NULL AND agent_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL) OR
    (scope = 'agent' AND agent_id IS NOT NULL)
  )
);
CREATE INDEX memories_scope_idx ON memories(owner_id, scope, project_id, agent_id, deleted_at);
CREATE INDEX memories_supersedes_idx ON memories(owner_id, supersedes);

CREATE TABLE idempotency (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id, agent_id, operation, idempotency_key)
);

CREATE TABLE room_cursors (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX room_cursors_expiry_idx ON room_cursors(expires_at_ms);
CREATE INDEX room_cursors_stream_idx ON room_cursors(owner_id, project_id, room, expires_at_ms);

CREATE TABLE room_rate_windows (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id, agent_id)
);
CREATE INDEX idempotency_cleanup_idx ON idempotency(operation, result_id);
`

const SCHEMA_V2 = `
CREATE INDEX IF NOT EXISTS room_cursors_stream_idx ON room_cursors(owner_id, project_id, room, expires_at_ms);
CREATE INDEX IF NOT EXISTS idempotency_cleanup_idx ON idempotency(operation, result_id);
`

const SCHEMA_V3 = `
CREATE INDEX IF NOT EXISTS room_events_stream_expiry_idx ON room_events(owner_id, project_id, room, expires_at_ms);
`

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS room_stream_state (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  replay_floor_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, project_id, room),
  FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS room_rate_windows_cleanup_idx ON room_rate_windows(window_started_at_ms);

-- Earlier schemas could delete retained events without recording their sequence.
-- Existing cursors therefore cannot be proven gap-free after this migration.
DELETE FROM room_cursors;
`

const SCHEMA_V5_LEGACY = `
UPDATE room_cursors
SET expires_at_ms = max(
  expires_at_ms,
  COALESCE((
    SELECT max(event.expires_at_ms) FROM room_events event
    WHERE event.owner_id = room_cursors.owner_id
      AND event.project_id = room_cursors.project_id
      AND event.room = room_cursors.room
  ), expires_at_ms)
);

ALTER TABLE idempotency ADD COLUMN expires_at_ms INTEGER;
UPDATE idempotency
SET expires_at_ms = COALESCE(
  CASE operation
    WHEN 'room.post' THEN (
      SELECT event.expires_at_ms FROM room_events event
      WHERE event.id = idempotency.result_id
        AND event.owner_id = idempotency.owner_id
        AND event.project_id = idempotency.project_id
    )
    WHEN 'memory.promote' THEN (
      SELECT event.expires_at_ms
      FROM memories memory
      INNER JOIN room_events event
        ON event.id = memory.source_room_event_id
        AND event.owner_id = idempotency.owner_id
        AND event.project_id = idempotency.project_id
      WHERE memory.id = idempotency.result_id
        AND memory.owner_id = idempotency.owner_id
    )
  END,
  created_at_ms + ${DEFAULT_CURSOR_TTL_MS}
);

ALTER TABLE idempotency RENAME TO idempotency_v4;
CREATE TABLE idempotency (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id, agent_id, operation, idempotency_key)
);
INSERT INTO idempotency (
  owner_id, project_id, agent_id, operation, idempotency_key,
  fingerprint, result_id, created_at_ms, expires_at_ms
)
SELECT
  owner_id, project_id, agent_id, operation, idempotency_key,
  fingerprint, result_id, created_at_ms, expires_at_ms
FROM idempotency_v4;
DROP TABLE idempotency_v4;
`

const SCHEMA_V5 = `
CREATE INDEX IF NOT EXISTS idempotency_cleanup_idx ON idempotency(operation, result_id);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency(operation, expires_at_ms);
`

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS room_stream_agent_floor (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  replay_floor_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, project_id, room, agent_id),
  FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, project_id)
);

-- v5 cursors were validated against one global floor. The new scoped floors start
-- empty, so preserving those cursors could revive a checkpoint already stale in v5.
DELETE FROM room_cursors;
`

const SCHEMA_V7 = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
INSERT INTO memory_fts(memory_id, text)
SELECT id, text FROM memories
WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = memories.id);

-- vec_rowid records the native index row id derived from memory_id. It is
-- written for provenance only and must never be selected back into JavaScript:
-- it is a 63-bit value, and node:sqlite throws rather than return an integer
-- above Number.MAX_SAFE_INTEGER. The vector store recomputes it instead.
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  vec_rowid INTEGER
);
`

const SCHEMA_V8 = `
ALTER TABLE memories ADD COLUMN normalized_digest TEXT;
CREATE INDEX memories_normalized_digest_idx
  ON memories(owner_id, scope, project_id, agent_id, normalized_digest, deleted_at);
CREATE TABLE memory_embedding_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0)
);
`

/**
 * Vector rows carry the retrieval partition of their memory so top-k can be
 * restricted before the cutoff without enumerating an entire scope per query.
 * `superseded` is the one derived value here: scope, project, and agent never
 * change for a stored memory, and a predecessor stays obsolete even if its
 * successor is later deleted, so it is written exactly once.
 */
const SCHEMA_V9 = `
ALTER TABLE memory_vectors ADD COLUMN owner_id TEXT;
ALTER TABLE memory_vectors ADD COLUMN scope TEXT;
ALTER TABLE memory_vectors ADD COLUMN project_id TEXT;
ALTER TABLE memory_vectors ADD COLUMN agent_id TEXT;
ALTER TABLE memory_vectors ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS memory_vectors_partition_idx
  ON memory_vectors(owner_id, scope, project_id, agent_id, superseded);
`

const SCHEMA_V9_BACKFILL = `
UPDATE memory_vectors SET
  owner_id = (SELECT m.owner_id FROM memories m WHERE m.id = memory_vectors.memory_id),
  scope = (SELECT m.scope FROM memories m WHERE m.id = memory_vectors.memory_id),
  project_id = (SELECT m.project_id FROM memories m WHERE m.id = memory_vectors.memory_id),
  agent_id = (SELECT m.agent_id FROM memories m WHERE m.id = memory_vectors.memory_id),
  superseded = CASE WHEN EXISTS (
    SELECT 1 FROM memories successor
    INNER JOIN memories m ON m.id = memory_vectors.memory_id
    WHERE successor.owner_id = m.owner_id AND successor.supersedes = m.id
  ) THEN 1 ELSE 0 END;

-- A derived row whose memory is gone can never be retrieved; dropping it keeps
-- the vector index a strict projection of live memory.
DELETE FROM memory_vectors WHERE owner_id IS NULL;
`

/**
 * Phase 3 makes the bus the durable log and `room_events` its projection.
 *
 * `bus_sequence` records where a projected row sits in its room's stream, and
 * the watermark records how far the projection has consumed that stream. The
 * watermark is a separate table on purpose: retention deletes projected rows,
 * and a high-water mark derived from surviving rows would walk backwards and
 * resurrect an event the room had already aged out.
 *
 * The column is nullable and the table is empty for a client opened without a
 * bus, so a Phase 1 database migrates without rewriting a single event.
 */
/**
 * Phase 4 review: reconciliation is per project, because a project is one
 * stream.
 *
 * The v10 watermark was per room, which cannot be compared against the log's
 * retained window: a room's sequences have its siblings' interleaved between
 * them, so a gap between a room's position and the oldest retained sequence
 * says nothing about whether that room lost anything. Existing watermarks are
 * dropped rather than migrated - the safe position for a projection whose
 * bookkeeping changed meaning is the beginning, and reconciliation is
 * idempotent.
 */
/** How many agent posts in a row each room has had since its last owner post (the hop budget). */
const SCHEMA_V13 = `
CREATE TABLE IF NOT EXISTS room_agent_run (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  run INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id, room)
);
`

/**
 * Which owner's fabric this device holds.
 *
 * A device does not know its owner from configuration: the identifier every
 * caller uses is a digest derived from an OAuth subject, and it arrives with
 * the request. So the device records the one it has been used by, and the mesh
 * uses that to decide whether a peer is asking about the fabric this device
 * actually belongs to. A device nobody has used yet has no owner, and refuses
 * peers rather than adopting the first one that asks.
 */
const SCHEMA_V12 = `
CREATE TABLE IF NOT EXISTS fabric_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL
);
`

const SCHEMA_V11 = `
DROP TABLE IF EXISTS room_bus_watermark;
CREATE TABLE room_bus_watermark (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  bus_sequence INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);

CREATE TABLE IF NOT EXISTS room_bus_fence (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  cursor_floor_sequence INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);
`

const SCHEMA_V10 = `
ALTER TABLE room_events ADD COLUMN bus_sequence INTEGER;
CREATE INDEX IF NOT EXISTS room_events_bus_idx
  ON room_events(owner_id, project_id, room, bus_sequence);

CREATE TABLE IF NOT EXISTS room_bus_watermark (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  room TEXT NOT NULL,
  bus_sequence INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_id, room)
);
`

const CURRENT_SCHEMA_COLUMNS: Readonly<Record<string, readonly SchemaColumnRequirement[]>> = Object.freeze({
  projects: [
    ['project_id', 'TEXT', 0, 1], ['owner_id', 'TEXT', 1, 0], ['display_name', 'TEXT', 1, 0],
    ['repo_ref', 'TEXT', 0, 0], ['workspace_ref', 'TEXT', 0, 0], ['memory_namespace', 'TEXT', 1, 0],
    ['room_namespace', 'TEXT', 1, 0], ['retention_ttl_hops', 'INTEGER', 0, 0],
    ['retention_days', 'INTEGER', 0, 0], ['created_at', 'TEXT', 1, 0], ['archived_at', 'TEXT', 0, 0],
  ],
  project_members: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['agent_id', 'TEXT', 1, 3],
  ],
  room_events: [
    ['sequence', 'INTEGER', 0, 1], ['id', 'TEXT', 1, 0], ['owner_id', 'TEXT', 1, 0],
    ['project_id', 'TEXT', 1, 0], ['room', 'TEXT', 1, 0], ['type', 'TEXT', 1, 0],
    ['from_agent_id', 'TEXT', 1, 0], ['to_agent_id', 'TEXT', 0, 0], ['reply_to', 'TEXT', 0, 0],
    ['correlation_id', 'TEXT', 0, 0], ['body', 'TEXT', 1, 0], ['artifact_refs_json', 'TEXT', 0, 0],
    ['created_at', 'TEXT', 1, 0], ['created_at_ms', 'INTEGER', 1, 0], ['expires_at_ms', 'INTEGER', 1, 0],
    ['ttl_hops', 'INTEGER', 1, 0], ['provenance_device_id', 'TEXT', 1, 0],
    ['provenance_session_id', 'TEXT', 0, 0], ['bus_sequence', 'INTEGER', 0, 0],
  ],
  room_bus_watermark: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['bus_sequence', 'INTEGER', 1, 0],
  ],
  room_bus_fence: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['cursor_floor_sequence', 'INTEGER', 1, 0],
  ],
  fabric_owner: [
    ['singleton', 'INTEGER', 0, 1], ['owner_id', 'TEXT', 1, 0], ['first_seen_at_ms', 'INTEGER', 1, 0],
  ],
  room_agent_run: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['room', 'TEXT', 1, 3], ['run', 'INTEGER', 1, 0],
  ],
  memories: [
    ['id', 'TEXT', 0, 1], ['owner_id', 'TEXT', 1, 0], ['scope', 'TEXT', 1, 0],
    ['project_id', 'TEXT', 0, 0], ['agent_id', 'TEXT', 0, 0], ['kind', 'TEXT', 1, 0],
    ['text', 'TEXT', 1, 0], ['importance', 'REAL', 1, 0], ['confidence', 'REAL', 0, 0],
    ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['source_type', 'TEXT', 1, 0],
    ['source_agent_id', 'TEXT', 0, 0], ['source_room_event_id', 'TEXT', 0, 0],
    ['source_session_id', 'TEXT', 0, 0], ['supersedes', 'TEXT', 0, 0], ['deleted_at', 'TEXT', 0, 0],
    ['normalized_digest', 'TEXT', 0, 0],
  ],
  idempotency: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['agent_id', 'TEXT', 1, 3],
    ['operation', 'TEXT', 1, 4], ['idempotency_key', 'TEXT', 1, 5], ['fingerprint', 'TEXT', 1, 0],
    ['result_id', 'TEXT', 1, 0], ['created_at_ms', 'INTEGER', 1, 0], ['expires_at_ms', 'INTEGER', 1, 0],
  ],
  room_cursors: [
    ['token', 'TEXT', 0, 1], ['owner_id', 'TEXT', 1, 0], ['project_id', 'TEXT', 1, 0],
    ['room', 'TEXT', 1, 0], ['agent_id', 'TEXT', 1, 0], ['last_sequence', 'INTEGER', 1, 0],
    ['expires_at_ms', 'INTEGER', 1, 0],
  ],
  room_rate_windows: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['agent_id', 'TEXT', 1, 3],
    ['window_started_at_ms', 'INTEGER', 1, 0], ['event_count', 'INTEGER', 1, 0],
  ],
  room_stream_state: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['room', 'TEXT', 1, 3],
    ['replay_floor_sequence', 'INTEGER', 1, 0], ['broadcast_replay_floor_sequence', 'INTEGER', 1, 0],
  ],
  room_stream_agent_floor: [
    ['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['room', 'TEXT', 1, 3],
    ['agent_id', 'TEXT', 1, 4], ['replay_floor_sequence', 'INTEGER', 1, 0],
  ],
  memory_vectors: [
    ['memory_id', 'TEXT', 0, 1], ['embedding', 'BLOB', 1, 0], ['vec_rowid', 'INTEGER', 0, 0],
    ['owner_id', 'TEXT', 0, 0], ['scope', 'TEXT', 0, 0], ['project_id', 'TEXT', 0, 0],
    ['agent_id', 'TEXT', 0, 0], ['superseded', 'INTEGER', 1, 0],
  ],
  memory_embedding_config: [
    ['singleton', 'INTEGER', 0, 1], ['provider_id', 'TEXT', 1, 0], ['dimensions', 'INTEGER', 1, 0],
  ],
})

const CURRENT_SCHEMA_INDEXES = Object.freeze([
  ['room_events', 'room_events_stream_idx', ['owner_id', 'project_id', 'room', 'sequence']],
  ['room_events', 'room_events_expiry_idx', ['expires_at_ms']],
  ['room_events', 'room_events_stream_expiry_idx', ['owner_id', 'project_id', 'room', 'expires_at_ms']],
  ['room_events', 'room_events_bus_idx', ['owner_id', 'project_id', 'room', 'bus_sequence']],
  ['memories', 'memories_scope_idx', ['owner_id', 'scope', 'project_id', 'agent_id', 'deleted_at']],
  ['memories', 'memories_supersedes_idx', ['owner_id', 'supersedes']],
  ['memories', 'memories_normalized_digest_idx', ['owner_id', 'scope', 'project_id', 'agent_id', 'normalized_digest', 'deleted_at']],
  ['memory_vectors', 'memory_vectors_partition_idx', ['owner_id', 'scope', 'project_id', 'agent_id', 'superseded']],
  ['idempotency', 'idempotency_cleanup_idx', ['operation', 'result_id']],
  ['idempotency', 'idempotency_expiry_idx', ['operation', 'expires_at_ms']],
  ['room_cursors', 'room_cursors_expiry_idx', ['expires_at_ms']],
  ['room_cursors', 'room_cursors_stream_idx', ['owner_id', 'project_id', 'room', 'expires_at_ms']],
  ['room_rate_windows', 'room_rate_windows_cleanup_idx', ['window_started_at_ms']],
] as const)

const CURRENT_SCHEMA_UNIQUE_KEYS = Object.freeze([
  ['projects', ['project_id']],
  ['projects', ['owner_id', 'project_id']],
  ['project_members', ['owner_id', 'project_id', 'agent_id']],
  ['room_events', ['id']],
  ['memories', ['id']],
  ['idempotency', ['owner_id', 'project_id', 'agent_id', 'operation', 'idempotency_key']],
  ['room_cursors', ['token']],
  ['room_rate_windows', ['owner_id', 'project_id', 'agent_id']],
  ['room_stream_state', ['owner_id', 'project_id', 'room']],
  ['room_stream_agent_floor', ['owner_id', 'project_id', 'room', 'agent_id']],
  ['room_bus_watermark', ['owner_id', 'project_id']],
  ['room_bus_fence', ['owner_id', 'project_id']],
  ['room_agent_run', ['owner_id', 'project_id', 'room']],
  ['memory_vectors', ['memory_id']],
] as const)

const CURRENT_SCHEMA_FOREIGN_KEYS: Readonly<Record<string, readonly string[][]>> = Object.freeze({
  projects: [],
  project_members: [['projects', 'owner_id', 'owner_id', 'project_id', 'project_id']],
  room_events: [['projects', 'owner_id', 'owner_id', 'project_id', 'project_id']],
  memories: [],
  idempotency: [],
  room_cursors: [],
  room_rate_windows: [],
  room_stream_state: [['projects', 'owner_id', 'owner_id', 'project_id', 'project_id']],
  room_stream_agent_floor: [['projects', 'owner_id', 'owner_id', 'project_id', 'project_id']],
  room_bus_watermark: [],
  room_bus_fence: [],
  fabric_owner: [],
  room_agent_run: [],
  memory_vectors: [],
  memory_embedding_config: [],
})

const CURRENT_SCHEMA_SQL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  projects: [
    'CHECK (retention_ttl_hops IS NULL OR retention_ttl_hops BETWEEN 1 AND 64)',
    'CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650)',
  ],
  room_events: ['sequence INTEGER PRIMARY KEY AUTOINCREMENT', 'CHECK (ttl_hops BETWEEN 1 AND 64)'],
  memories: [
    "CHECK (scope IN ('user','project','agent'))",
    "CHECK (kind IN ('preference','fact','decision','constraint','discovery','procedure','handoff','summary'))",
    'CHECK (importance BETWEEN 0 AND 1)',
    'CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)',
    "CHECK (source_type IN ('user','agent','room','system'))",
    "(scope = 'user' AND project_id IS NULL AND agent_id IS NULL)",
    "(scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL)",
    "(scope = 'agent' AND agent_id IS NOT NULL)",
  ],
  memory_embedding_config: ['CHECK (singleton = 1)', 'CHECK (dimensions > 0)'],
  room_stream_state: [
    'replay_floor_sequence INTEGER NOT NULL DEFAULT 0',
    'broadcast_replay_floor_sequence INTEGER NOT NULL DEFAULT 0',
  ],
  room_stream_agent_floor: ['replay_floor_sequence INTEGER NOT NULL DEFAULT 0'],
})

function normalizeSchemaSql(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1').trim()
}

function isPublicFabricError(error: unknown): boolean {
  return error instanceof FabricAuthError || error instanceof FabricAccessError ||
    error instanceof FabricValidationError || error instanceof FabricStorageError
}

/**
 * The bus deduplication key for a post.
 *
 * It carries the agent because the idempotency scope does: the local table is
 * keyed by owner, project, agent, operation, and key. A digest that dropped
 * the agent would be coarser than the rule it enforces, and two agents that
 * happened to choose one key would have the second post silently answered with
 * the first agent's event - a message discarded, and its contents handed to
 * someone the room may never have shown it to.
 *
 * It is a digest rather than the values themselves because a message id
 * crosses to the bus in the clear, and a project id or an idempotency key
 * chosen by a caller is owner data the bus is not meant to hold.
 */
/**
 * Whether a record from the log can be written into the projection.
 *
 * The bar is every column the projection's own schema requires, not merely the
 * fields a reader would use: a record that parses but violates a constraint is
 * a record that would fail the transaction it arrives in.
 */
function isProjectableRecord(record: RoomEventRecord, ownerId: string, projectId: string): boolean {
  if (!record || typeof record !== 'object') return false
  if (record.ownerId !== ownerId || record.projectId !== projectId) return false
  for (const value of [record.id, record.room, record.type, record.fromAgentId, record.body, record.createdAt, record.deviceId]) {
    if (typeof value !== 'string' || value.length === 0) return false
  }
  for (const value of [record.createdAtMs, record.expiresAtMs]) {
    if (!Number.isSafeInteger(value)) return false
  }
  if (!Number.isSafeInteger(record.ttlHops) || record.ttlHops < 1 || record.ttlHops > MAX_TTL_HOPS) return false
  for (const value of [record.toAgentId, record.replyTo, record.correlationId, record.sessionId]) {
    if (value !== undefined && typeof value !== 'string') return false
  }
  if (record.artifactRefs !== undefined) {
    if (!Array.isArray(record.artifactRefs)) return false
    if (record.artifactRefs.some(entry => typeof entry !== 'string')) return false
  }
  return true
}

function busMessageId(ownerId: string, projectId: string, agentId: string, idempotencyKey: string): string {
  return `post-${createHash('sha256').update(canonicalTuple([ownerId, projectId, agentId, 'room.post', idempotencyKey])).digest('hex')}`
}

function canonicalTuple(values: readonly unknown[]): string {
  return JSON.stringify(values)
}

function memoryDigest(text: string): string {
  return createHash('sha256').update(normalizeMemoryText(text), 'utf8').digest('hex')
}

function optional<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

function safeAuditIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256 && !/[\x00-\x1f\x7f/\\]/.test(value)
    ? value
    : undefined
}

function safeAuditTarget(value: unknown): string | undefined {
  const identifier = safeAuditIdentifier(value)
  return identifier !== undefined && /^(?:event|memory|project)-[0-9a-f-]{36}$/i.test(identifier)
    ? identifier
    : undefined
}

function safeAuditActor(value: string): string {
  return safeAuditIdentifier(value) ?? 'unknown'
}

function opaqueAuditCorrelation(value: unknown): string | undefined {
  const correlationId = safeAuditIdentifier(value)
  if (correlationId === undefined) return undefined
  const digest = createHash('sha256')
    .update('tandem:fabric:audit-correlation:v1\0', 'utf8')
    .update(correlationId, 'utf8')
    .digest('hex')
  return `correlation-${digest}`
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new FabricStorageError()
  return value
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new FabricStorageError()
  return value
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new FabricStorageError()
  return value
}

function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new FabricStorageError()
  return value
}

function stringArray(value: SqlValue | undefined): readonly string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new FabricStorageError()
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new FabricStorageError()
    return Object.freeze([...parsed])
  } catch (error) {
    if (error instanceof FabricStorageError) throw error
    throw new FabricStorageError()
  }
}

export class SQLiteFabricClient implements FabricClient {
  readonly #database!: NodeDatabaseSync
  readonly #embeddingProvider: EmbeddingProvider
  readonly #vectorStore!: LocalVectorStore
  readonly #now: () => number
  readonly #busyTimeoutMs: number
  readonly #rateMaxEvents: number
  readonly #rateWindowMs: number
  readonly #auditSink?: (entry: FabricAuditEntry) => void
  readonly #bus?: RoomBus
  readonly #onWake?: SQLiteFabricClientOptions['onWake']
  #closed = false

  get vectorBackend(): VectorBackend { return this.#vectorStore.backend }

  constructor(options: SQLiteFabricClientOptions) {
    if (!options || typeof options.databasePath !== 'string' || options.databasePath.trim().length === 0 || options.databasePath === ':memory:') throw new FabricStorageError()
    this.#now = options.now ?? Date.now
    this.#busyTimeoutMs = options.busyTimeoutMs ?? 5_000
    this.#rateMaxEvents = options.roomRateLimit?.maxEvents ?? DEFAULT_ROOM_RATE_LIMIT.maxEvents
    this.#rateWindowMs = options.roomRateLimit?.windowMs ?? DEFAULT_ROOM_RATE_LIMIT.windowMs
    this.#auditSink = options.audit
    this.#bus = options.bus
    this.#onWake = options.onWake
    this.#embeddingProvider = options.embeddingProvider ?? new DeterministicEmbeddingProvider()
    if (!this.#embeddingProvider.offline || !Number.isSafeInteger(this.#embeddingProvider.dimensions) || this.#embeddingProvider.dimensions < 8) throw new FabricStorageError()
    if (!Number.isSafeInteger(this.#busyTimeoutMs) || this.#busyTimeoutMs < 1 || this.#busyTimeoutMs > 60_000 ||
      !Number.isSafeInteger(this.#rateMaxEvents) || this.#rateMaxEvents < 1 ||
      !Number.isSafeInteger(this.#rateWindowMs) || this.#rateWindowMs < 1) throw new FabricStorageError()

    const databasePath = resolve(options.databasePath)
    let database: NodeDatabaseSync | undefined
    try {
      const databaseDirectory = dirname(databasePath)
      mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 })
      if ((statSync(databaseDirectory).mode & 0o077) !== 0) throw new FabricStorageError()
      // Never let SQLite create a new authority file under the process umask.
      // Pre-create it privately, or validate/tighten an existing regular file,
      // before DatabaseSync is allowed to open it.
      try {
        const fd = openSync(databasePath, 'wx', 0o600)
        closeSync(fd)
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error
        if (!lstatSync(databasePath).isFile()) throw new FabricStorageError()
      }
      chmodSync(databasePath, 0o600)
      database = new DatabaseSync(databasePath, { allowExtension: true })
      this.#database = database
      this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${this.#busyTimeoutMs}; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;`)
      this.migrate()
      this.ensureEmbeddingConfiguration()
      this.#vectorStore = createLocalVectorStore(this.#database, this.#embeddingProvider.dimensions, { backend: options.vectorBackend })
      this.backfillDefaultEmbeddings()
      // Startup precedes any public operation, so it may drain multiple batches - bounded, so a
      // pathological backlog cannot hang initialization - instead of leaving overflow rows with
      // plaintext bodies until some future write happens to trigger another single-batch pass.
      for (let batch = 0; batch < FABRIC_STARTUP_CLEANUP_MAX_BATCHES; batch++) {
        if (this.transaction(() => this.deleteExpiredRoomState(this.nowMs())) === 0) break
      }
    } catch {
      try { database?.close() } catch { /* best effort */ }
      throw new FabricStorageError()
    }
  }

  /**
   * The owner this device's fabric belongs to, if it has been used yet.
   *
   * Undefined is a real answer, not a missing one: a device that has been
   * installed and enrolled but never asked to do anything has no owner to
   * compare a peer against, and guessing one would be inventing an authority.
   */
  ownerId(): string | undefined {
    if (this.#closed) return undefined
    try {
      const row = this.#database.prepare('SELECT owner_id FROM fabric_owner WHERE singleton = 1')
        .get() as SqlRow | undefined
      return row === undefined ? undefined : requiredString(row, 'owner_id')
    } catch {
      return undefined
    }
  }

  /**
   * Records the owner the first time this device does authorized work.
   *
   * Only the first is kept. A device serves one owner's fabric, and a second
   * owner appearing is a question about which one this device belongs to
   * rather than an update to the answer.
   */
  private rememberOwner(ownerId: string): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO fabric_owner (singleton, owner_id, first_seen_at_ms) VALUES (1, ?, ?)
    `).run(ownerId, this.nowMs())
  }

  close(): void {
    if (this.#closed) return
    try {
      this.#database.close()
      this.#closed = true
    } catch {
      throw new FabricStorageError()
    }
  }

  async createProject(ctx: CallerContext, input: CreateProjectInput): Promise<Project> {
    return this.audited(ctx, 'project.create', () => {
      assertCapability(ctx, 'project:create')
      validateCreateProjectInput(input)
      const addsOtherMember = (input.memberAgentIds ?? []).some(agentId => agentId !== ctx.agentId)
      if (addsOtherMember) {
        if (ctx.actorType !== 'owner') throw new FabricAccessError()
        assertCapability(ctx, 'project:members')
      }
      const members = [...new Set([ctx.agentId, ...(input.memberAgentIds ?? [])])]
      return this.storage(() => this.transaction(() => {
        const projectId = `project-${randomUUID()}`
        const createdAt = this.nowIso()
        this.#database.prepare(`
          INSERT INTO projects (
            project_id, owner_id, display_name, repo_ref, workspace_ref,
            memory_namespace, room_namespace, retention_ttl_hops, retention_days, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId, ctx.ownerId, input.displayName, optional(input.repoRef), optional(input.workspaceRef),
          `project:${projectId}:memory`, `project:${projectId}:room`,
          optional(input.retention?.roomEventTtlHops), optional(input.retention?.roomRetentionDays), createdAt,
        )
        const insertMember = this.#database.prepare('INSERT INTO project_members (owner_id, project_id, agent_id) VALUES (?, ?, ?)')
        for (const agentId of members) insertMember.run(ctx.ownerId, projectId, agentId)
        return this.projectById(ctx.ownerId, projectId, ctx.agentId, ctx.actorType === 'owner', false) ?? (() => { throw new FabricStorageError() })()
      }))
    }, project => ({ projectId: project.projectId, targetId: project.projectId }))
  }

  async listProjects(ctx: CallerContext): Promise<Project[]> {
    return this.audited(ctx, 'project.list', () => {
      assertCapability(ctx, 'project:read')
      return this.storage(() => {
        this.ensureOpen()
        const rows = ctx.actorType === 'owner'
          ? this.#database.prepare(`
              SELECT p.* FROM projects p
              WHERE p.owner_id = ? ORDER BY p.created_at, p.project_id
            `).all(ctx.ownerId) as SqlRow[]
          : this.#database.prepare(`
              SELECT p.* FROM projects p
              INNER JOIN project_members m ON m.owner_id = p.owner_id AND m.project_id = p.project_id
              WHERE p.owner_id = ? AND m.agent_id = ? ORDER BY p.created_at, p.project_id
            `).all(ctx.ownerId, ctx.agentId) as SqlRow[]
        return rows.map(row => this.projectFromRow(row))
      })
    }, projects => ({ resultCount: projects.length }))
  }

  async getProject(ctx: CallerContext, projectId: string): Promise<Project | null> {
    return this.audited(ctx, 'project.get', () => {
      assertCapability(ctx, 'project:read')
      validateProjectId(projectId)
      return this.storage(() => this.projectById(ctx.ownerId, projectId, ctx.agentId, ctx.actorType === 'owner', false))
    }, project => ({ resultCount: project ? 1 : 0 }), {
      targetId: safeAuditTarget(projectId), projectId: safeAuditTarget(projectId),
    })
  }

  async archiveProject(ctx: CallerContext, projectId: string): Promise<ArchiveProjectResult> {
    return this.audited(ctx, 'project.archive', () => {
      assertCapability(ctx, 'project:archive')
      validateProjectId(projectId)
      return this.storage(() => this.transaction(() => {
        const current = this.authorizedProject(ctx, projectId, false)
        if (current.archivedAt) return { project: current, alreadyArchived: true }
        const archivedAt = this.nowIso()
        const changed = this.#database.prepare('UPDATE projects SET archived_at = ? WHERE owner_id = ? AND project_id = ? AND archived_at IS NULL').run(archivedAt, ctx.ownerId, projectId)
        if (Number(changed.changes) !== 1) throw new FabricStorageError()
        const project = this.authorizedProject(ctx, projectId, false)
        return { project, alreadyArchived: false }
      }))
    }, () => ({}), { targetId: safeAuditTarget(projectId), projectId: safeAuditTarget(projectId) })
  }

  async postRoomEvent(ctx: CallerContext, input: PostRoomEventInput): Promise<RoomEvent> {
    // Set only inside the transaction that stores a fresh post; a duplicate or a failure leaves it empty.
    let wake: string[] = []
    const event = await this.audited(ctx, 'room.post', async () => {
      assertCapability(ctx, 'room:post')
      const project = this.currentActiveProject(ctx)
      validatePostRoomEventInput(input)
      if (!this.#bus) {
        return this.storage(() => this.transaction(() => {
          const prepared = this.prepareRoomPost(ctx, project, input)
          if (prepared.kind === 'duplicate') return prepared.event
          const stored = this.commitRoomPost(ctx, prepared)
          wake = this.advanceAgentRun(ctx, stored)
          return stored
        }))
      }
      return this.postRoomEventThroughBus(ctx, project, input, names => { wake = names })
    }, event => ({
      projectId: event.projectId,
      targetId: event.id,
      byteCount: Buffer.byteLength(input.body, 'utf8'),
      correlationId: opaqueAuditCorrelation(event.correlationId),
    }))
    if (wake.length > 0 && this.#onWake) {
      try {
        const result: unknown = this.#onWake({ names: wake, room: event.room, eventId: event.id, projectId: event.projectId })
        if (result instanceof Promise) result.catch(() => undefined)
      } catch { /* a wake never fails or undoes a stored post */ }
    }
    return event
  }

  /**
   * Counts a fresh post into its room's run, in the transaction that stores it, and returns the
   * names it wakes: an owner post sets the run to 0 and wakes its mentions; any other post adds 1
   * and wakes its mentions only while the run is below HOP_BUDGET.
   *
   * Known limit: until U-R1A-36A gives agent callers their own identity, bridge/fabric/rpc-router.ts
   * gives every MCP tool call actorType 'owner', so in production every post resets the run. A post
   * forwarded through the hub from another computer stays 'owner' even after 36A (36B or later).
   */
  private advanceAgentRun(ctx: CallerContext, event: RoomEvent): string[] {
    const owner = ctx.actorType === 'owner'
    const row = this.#database.prepare(`
      INSERT INTO room_agent_run (owner_id, project_id, room, run) VALUES (?, ?, ?, ?)
      ON CONFLICT (owner_id, project_id, room) DO UPDATE SET run = CASE WHEN ? THEN 0 ELSE run + 1 END
      RETURNING run
    `).get(ctx.ownerId, event.projectId, event.room, owner ? 0 : 1, owner ? 1 : 0) as SqlRow | undefined
    if (!row) throw new FabricStorageError()
    return owner || requiredNumber(row, 'run') < HOP_BUDGET ? mentionsIn(event.body) : []
  }

  /**
   * Everything a post decides before it is durable: authority, reply-derived
   * hop budget, idempotency, and the rate window.
   *
   * It is separated from the write because the bus-backed path has to publish
   * between the two, and publishing is asynchronous while a SQLite transaction
   * is not. Both paths run this identically, so the rules a post is judged by
   * do not depend on where the event ends up being stored.
   */
  private prepareRoomPost(ctx: CallerContext, project: Project, input: PostRoomEventInput): PreparedRoomPost {
        const activeProject = this.authorizedProject(ctx, project.projectId, true)
        const now = this.nowMs()
        this.deleteExpiredRoomState(now)
        if (input.toAgentId && !this.isProjectMember(ctx.ownerId, activeProject.projectId, input.toAgentId)) throw new FabricAccessError()

        const operation = 'room.post'
        const dedupe = this.idempotency(ctx, activeProject.projectId, operation, input.idempotencyKey, now)
        if (dedupe) {
          const prior = this.roomEventRow(ctx.ownerId, activeProject.projectId, requiredString(dedupe, 'result_id'), now)
          if (!prior) throw new FabricAccessError()
          // Mirrors the fresh-post ttlHops resolution below so a genuine change - explicit
          // or reply-derived - is still caught. Only falls back to the persisted ttl_hops
          // when the reply parent has since expired and can no longer be re-resolved, so a
          // retry still dedupes after that.
          let retryTtlHops: number
          if (input.ttlHops !== undefined) {
            retryTtlHops = input.ttlHops
          } else if (input.replyTo) {
            const retryParentRow = this.roomEventRow(ctx.ownerId, activeProject.projectId, input.replyTo, now)
            retryTtlHops = retryParentRow ? requiredNumber(retryParentRow, 'ttl_hops') - 1 : requiredNumber(prior, 'ttl_hops')
          } else {
            retryTtlHops = activeProject.retention?.roomEventTtlHops ?? DEFAULT_ROOM_EVENT_TTL_HOPS
          }
          const fingerprint = canonicalTuple([
            input.room, input.type, input.body, input.toAgentId, input.replyTo, input.correlationId,
            input.artifactRefs ?? [], retryTtlHops, ctx.deviceId, input.sessionId,
          ])
          if (requiredString(dedupe, 'fingerprint') !== fingerprint) throw new FabricAccessError()
          return { kind: 'duplicate', event: this.roomEventFromRow(prior) }
        }

        const rootTtl = input.ttlHops ?? activeProject.retention?.roomEventTtlHops ?? DEFAULT_ROOM_EVENT_TTL_HOPS
        let ttlHops = rootTtl
        if (input.replyTo) {
          const parentRow = this.roomEventRow(ctx.ownerId, activeProject.projectId, input.replyTo, now)
          if (!parentRow || requiredString(parentRow, 'room') !== input.room || !this.canSeeRoomRow(ctx, parentRow)) throw new FabricAccessError()
          const remaining = requiredNumber(parentRow, 'ttl_hops') - 1
          if (remaining < 1 || (input.ttlHops !== undefined && input.ttlHops > remaining)) throw new FabricValidationError('ttlHops')
          ttlHops = input.ttlHops ?? remaining
        }
        const fingerprint = canonicalTuple([
          input.room, input.type, input.body, input.toAgentId, input.replyTo, input.correlationId,
          input.artifactRefs ?? [], ttlHops, ctx.deviceId, input.sessionId,
        ])

        this.consumeRoomRate(ctx, activeProject.projectId, now)
        const retentionDays = activeProject.retention?.roomRetentionDays ?? DEFAULT_ROOM_RETENTION_DAYS
        return {
          kind: 'fresh',
          project: activeProject,
          now,
          fingerprint,
          record: {
            id: `event-${randomUUID()}`,
            ownerId: ctx.ownerId,
            projectId: activeProject.projectId,
            room: input.room,
            type: input.type,
            fromAgentId: ctx.agentId,
            toAgentId: input.toAgentId,
            replyTo: input.replyTo,
            correlationId: input.correlationId,
            body: input.body,
            artifactRefs: input.artifactRefs,
            createdAt: new Date(now).toISOString(),
            createdAtMs: now,
            expiresAtMs: now + retentionDays * 86_400_000,
            ttlHops,
            deviceId: ctx.deviceId,
            sessionId: input.sessionId,
          },
          idempotencyKey: input.idempotencyKey,
        }
  }

  /**
   * Writes a prepared event into the projection and closes out its post.
   *
   * `busSequence` is where the bus stored it, and is absent only for a client
   * running without one. A projected row records that position so a later
   * reconciliation knows the event is already present and does not deliver it
   * to the room a second time.
   */
  private commitRoomPost(ctx: CallerContext, prepared: FreshRoomPost, busSequence?: number): RoomEvent {
    const { record, now, project } = prepared
    // OR IGNORE, because a concurrent read of this room can reconcile the
    // event out of the log and project it under this same id while the
    // acknowledgement is still in flight. That is the projection doing its job,
    // not a collision, and failing the poster for it would report a write that
    // every reader can already see as lost.
    this.#database.prepare(`
      INSERT OR IGNORE INTO room_events (
        id, owner_id, project_id, room, type, from_agent_id, to_agent_id, reply_to,
        correlation_id, body, artifact_refs_json, created_at, created_at_ms, expires_at_ms,
        ttl_hops, provenance_device_id, provenance_session_id, bus_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.ownerId, record.projectId, record.room, record.type, record.fromAgentId,
      optional(record.toAgentId), optional(record.replyTo), optional(record.correlationId), record.body,
      record.artifactRefs === undefined ? null : JSON.stringify(record.artifactRefs), record.createdAt,
      record.createdAtMs, record.expiresAtMs, record.ttlHops, record.deviceId, optional(record.sessionId),
      busSequence === undefined ? null : busSequence,
    )
    // The watermark is deliberately not advanced here. It is a statement about
    // how much of the log has been consumed in order, and this event's sequence
    // says nothing about the ones below it: a concurrent post that landed
    // earlier but has not been projected yet would be stepped over and become
    // permanently unreachable. Only reconciliation, which walks the log
    // forwards, is allowed to move it.
    this.#database.prepare(`
      UPDATE room_cursors SET expires_at_ms = max(expires_at_ms, ?)
      WHERE owner_id = ? AND project_id = ? AND room = ?
        AND last_sequence >= COALESCE((
          SELECT replay_floor_sequence FROM room_stream_state
          WHERE owner_id = ? AND project_id = ? AND room = ?
        ), 0)
    `).run(
      record.expiresAtMs, record.ownerId, record.projectId, record.room,
      record.ownerId, record.projectId, record.room,
    )
    this.insertIdempotency(
      ctx, project.projectId, 'room.post', prepared.idempotencyKey,
      prepared.fingerprint, record.id, now, record.expiresAtMs,
    )
    const inserted = this.roomEventRow(record.ownerId, project.projectId, record.id, now)
    if (!inserted) throw new FabricStorageError()
    return this.roomEventFromRow(inserted)
  }

  /**
   * The fingerprint a retry of this event would produce.
   *
   * It is rebuilt from the stored row rather than from the request in hand, so
   * the recovered post is protected by what was actually stored - a later
   * attempt under the same key with a different body is refused, exactly as it
   * would have been had the first attempt not been interrupted.
   */
  private roomEventFingerprint(ctx: CallerContext, row: SqlRow): string {
    return canonicalTuple([
      requiredString(row, 'room'), requiredString(row, 'type'), requiredString(row, 'body'),
      optionalString(row, 'to_agent_id'), optionalString(row, 'reply_to'), optionalString(row, 'correlation_id'),
      stringArray(row['artifact_refs_json']) ?? [], requiredNumber(row, 'ttl_hops'),
      ctx.deviceId, optionalString(row, 'provenance_session_id'),
    ])
  }

  /**
   * Posts through the bus, which is the durable store when one is configured.
   *
   * The order is the point: nothing is projected until the bus has accepted
   * the event, so a room can never show a caller an event that would vanish on
   * restart. The reverse gap - accepted by the bus, not yet projected, because
   * the process died in between - is repaired by reconciliation on the next
   * read, which is why the projection is allowed to lag but never to lead.
   */
  private async postRoomEventThroughBus(
    ctx: CallerContext,
    project: Project,
    input: PostRoomEventInput,
    onFresh: (wake: string[]) => void,
  ): Promise<RoomEvent> {
    const bus = this.#bus
    if (!bus) throw new FabricStorageError()

    // A reply resolves its parent's hop budget, and a retry compares against a
    // stored fingerprint. Both read the projection, so it has to be caught up
    // with the durable log before the decision is made.
    await this.reconcileProject(ctx.ownerId, project.projectId)

    // The rate window is consumed here rather than after publishing. Checking
    // it here and consuming it later would let concurrent posts all read the
    // same count and all pass, and would leave the consumption able to refuse a
    // post whose event is already durable - telling an author its message was
    // rate limited while every reader is about to receive it. A post the bus
    // then refuses has spent budget it did not use, which is the safe direction
    // for a bound that exists to stop runaway agents.
    const prepared = this.storage(() => this.transaction(() => this.prepareRoomPost(ctx, project, input)))
    if (prepared.kind === 'duplicate') return prepared.event

    const published = await this.publishRoomEvent(bus, prepared)

    // The event is projected by reconciliation and by nothing else, including
    // the call that published it. Writing it here instead would put it in the
    // projection in the order this device happened to finish its posts, and a
    // post that acknowledged first would sit ahead of one the log had already
    // placed before it. Reading the log back is what makes the room's order the
    // log's order, on every device.
    //
    // The post's own bookkeeping rides in the same transaction as that
    // projection, so a durable room post costs one sync rather than three.
    let event: RoomEvent | undefined
    await this.reconcileProject(ctx.ownerId, project.projectId, {
      untilSequence: published.sequence,
      finalize: () => {
        // Counted only by the close-out that records the key: a second publish the bus answered
        // with the same sequence (a retry while the first was in flight) is a duplicate and wakes nobody.
        const fresh = !this.idempotency(ctx, project.projectId, 'room.post', prepared.idempotencyKey, prepared.now)
        event = this.finishRoomPost(ctx, project, prepared, published.sequence)
        if (fresh) onFresh(this.advanceAgentRun(ctx, event))
      },
    })
    if (!event) throw new FabricStorageError()
    return event
  }

  /**
   * Closes out a post whose event is now durable and projected.
   *
   * A duplicate acknowledgement and a fresh one arrive here identically, which
   * is deliberate: after a crash between publishing and recording, the retry
   * has nothing to distinguish it from the original except that the event is
   * already in the log, and the correct outcome is the same either way.
   *
   * The deduplication key carries the owner, project, agent, and idempotency
   * key, so the event found here is by construction this caller's own. That is
   * asserted rather than assumed - returning an event authored by someone else
   * would hand over a row the room might never have shown this caller.
   */
  private finishRoomPost(
    ctx: CallerContext,
    project: Project,
    prepared: FreshRoomPost,
    busSequence: number,
  ): RoomEvent {
    const now = prepared.now
    const row = this.roomEventRowByBusSequence(ctx.ownerId, project.projectId, prepared.record.room, busSequence, now)
    if (!row) throw new FabricStorageError()
    if (requiredString(row, 'from_agent_id') !== ctx.agentId) throw new FabricAccessError()

    const expiresAt = requiredNumber(row, 'expires_at_ms')
    this.#database.prepare(`
      UPDATE room_cursors SET expires_at_ms = max(expires_at_ms, ?)
      WHERE owner_id = ? AND project_id = ? AND room = ?
        AND last_sequence >= COALESCE((
          SELECT replay_floor_sequence FROM room_stream_state
          WHERE owner_id = ? AND project_id = ? AND room = ?
        ), 0)
    `).run(
      expiresAt, ctx.ownerId, project.projectId, prepared.record.room,
      ctx.ownerId, project.projectId, prepared.record.room,
    )

    // Recorded from the stored row rather than the request in hand, so a later
    // attempt under the same key with a different body is refused against what
    // was actually stored. Without this the post would be protected only for as
    // long as the bus remembers the message id, where the contract protects it
    // for the event's retention.
    if (!this.idempotency(ctx, project.projectId, 'room.post', prepared.idempotencyKey, now)) {
      this.insertIdempotency(
        ctx, project.projectId, 'room.post', prepared.idempotencyKey,
        this.roomEventFingerprint(ctx, row), requiredString(row, 'id'), now, expiresAt,
      )
    }
    return this.roomEventFromRow(row)
  }

  private async publishRoomEvent(bus: RoomBus, prepared: FreshRoomPost) {
    const { record } = prepared
    const payload = Buffer.from(JSON.stringify(record), 'utf8')
    if (payload.byteLength > FABRICD_MAX_PAYLOAD_BYTES) throw new FabricValidationError('body')
    try {
      return await bus.publish({
        owner: record.ownerId,
        project: record.projectId,
        room: record.room,
        // Derived from the idempotency key rather than from the event id, so a
        // retry after a crash between publish and projection presents the same
        // key and is deduplicated by the bus instead of storing a second copy
        // under a fresh random id.
        messageId: busMessageId(record.ownerId, record.projectId, record.fromAgentId, prepared.idempotencyKey),
        payload: payload.toString('base64'),
        retention: this.roomRetention(prepared.project),
      })
    } catch (error) {
      // The bus refusing an event is a storage failure, not a caller error, and
      // its code is content-free by contract. Nothing is projected either way.
      if (error instanceof FabricdBusError) throw new FabricStorageError()
      throw error
    }
  }

  /**
   * The bus-side retention window for a project's rooms.
   *
   * It is deliberately looser than the bridge's own expiry: the bridge decides
   * when an event stops being visible, and a bus window that closed first would
   * silently shorten retention the project asked for. Every field is positive,
   * so a room can never be given an unbounded stream.
   */
  private roomRetention(project: Project): BusRetention {
    const retentionDays = project.retention?.roomRetentionDays ?? DEFAULT_ROOM_RETENTION_DAYS
    return Object.freeze({
      maxAgeSeconds: Math.ceil(retentionDays * 86_400 * BUS_RETENTION_HEADROOM),
      maxMessages: BUS_MAX_PROJECT_MESSAGES,
      maxBytes: BUS_MAX_PROJECT_BYTES,
      duplicateWindowSeconds: BUS_DUPLICATE_WINDOW_SECONDS,
    })
  }

  /**
   * Brings the projection up to the durable log for one room.
   *
   * Everything the room contract does - visibility, replay floors, cursors,
   * promotion - reads the projection, so this is where the bus being the
   * authority becomes observable: a projection that was lost, truncated, or
   * never written because a post died mid-flight is rebuilt from the events
   * the bus actually holds.
   *
   * The watermark, not the projected rows, is what advances. Retention deletes
   * rows, and a position derived from surviving rows would walk backwards and
   * redeliver events the room had already aged out.
   */
  private async reconcileProject(
    ownerId: string,
    projectId: string,
    caller?: { readonly untilSequence: number; readonly finalize: () => void },
  ): Promise<void> {
    const bus = this.#bus
    if (!bus) return
    let finalized = false
    for (let batch = 0; batch < FABRIC_RECONCILE_MAX_BATCHES; batch += 1) {
      const watermark = this.storage(() => this.readTransaction(() => this.busWatermark(ownerId, projectId)))

      let info
      let fetched
      try {
        info = await bus.projectInfo({ owner: ownerId, project: projectId })
        if (info.lastSequence <= watermark) break
        fetched = await bus.projectFetch({
          owner: ownerId, project: projectId,
          afterSequence: watermark,
          limit: FABRICD_MAX_FETCH_LIMIT,
          maxBytes: FABRICD_MAX_FETCH_BYTES,
          maxWaitMs: 0,
        })
      } catch (error) {
        if (error instanceof FabricdBusError) throw new FabricStorageError()
        throw error
      }

      // Exact, because a project is one stream: every sequence between what
      // this projection consumed and the oldest the log still holds belonged to
      // this project and is gone. Nothing can recover them, so every room of
      // the project is fenced - a cursor issued before the loss is refused
      // rather than answered with the suffix that happened to survive.
      if (info.firstSequence > watermark + 1) {
        this.storage(() => this.transaction(() => this.fenceProjectAfterLoss(ownerId, projectId)))
      }

      if (fetched.events.length === 0) {
        // The log reports events this fetch did not return, which means they
        // are no longer retained. Adopting the reported position is what keeps
        // an aged-out prefix from being requested forever.
        const advanced = Math.max(fetched.lastSequence, info.firstSequence - 1)
        if (advanced <= watermark) break
        this.storage(() => this.transaction(() => this.raiseBusWatermark(ownerId, projectId, advanced)))
        continue
      }

      this.storage(() => this.transaction(() => {
        for (const event of fetched.events) this.projectBusEvent(ownerId, projectId, event.sequence, event.payload)
        this.raiseBusWatermark(ownerId, projectId, fetched.lastSequence)
        if (caller && !finalized && fetched.lastSequence >= caller.untilSequence) {
          caller.finalize()
          finalized = true
        }
      }))

      // A short batch does not mean a caught-up projection: the bus admits its
      // first event unconditionally and budgets the rest against a byte bound,
      // so a fetch of ordinary events ends well below the count limit. The loop
      // condition is the watermark against the log, and nothing else.
      if (fetched.lastSequence <= watermark) break
    }
    // A caller whose own event was already projected by an earlier pass still
    // needs its bookkeeping written, so this runs in a transaction of its own
    // rather than being skipped.
    if (caller && !finalized) this.storage(() => this.transaction(() => caller.finalize()))
  }

  /**
   * Fences a project whose durable log has lost events it never consumed.
   *
   * The floor is a cursor floor rather than a replay floor, and the difference
   * matters. A replay floor is where a read starts, and is raised when events
   * are deleted - nothing live sits below it. Here the projection's rows are
   * all still live; what is missing never had a row at all. Raising the replay
   * floor would hide those live rows from every new reader, which is a room
   * that quietly reports itself empty.
   *
   * What has to happen instead is narrower: a cursor issued before the loss is
   * refused, because resuming it would step over the hole in silence.
   *
   * The boundary is the highest local sequence ever issued, not the highest one
   * this project currently holds. A projection that was rebuilt from a suffix
   * holds no row from before the loss, so a boundary drawn from its own rows
   * would sit below every cursor it needs to refuse. Reaching for the global
   * high-water is safe precisely because this is a cursor fence: it is recorded
   * per project and consulted only when validating a supplied checkpoint, so it
   * can neither reach another project's cursors nor hide a live row from a
   * reader that has none.
   */
  private fenceProjectAfterLoss(ownerId: string, projectId: string): void {
    const row = this.#database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'room_events'`).get() as SqlRow | undefined
    const boundary = row === undefined ? 0 : requiredNumber(row, 'seq')
    this.#database.prepare(`
      INSERT INTO room_bus_fence (owner_id, project_id, cursor_floor_sequence)
      VALUES (?, ?, ?)
      ON CONFLICT (owner_id, project_id)
        DO UPDATE SET cursor_floor_sequence = max(cursor_floor_sequence, excluded.cursor_floor_sequence)
    `).run(ownerId, projectId, boundary)
  }

  /** The sequence at or below which a cursor can no longer be trusted. */
  private cursorFence(ownerId: string, projectId: string): number {
    const row = this.#database.prepare(`
      SELECT cursor_floor_sequence FROM room_bus_fence WHERE owner_id = ? AND project_id = ?
    `).get(ownerId, projectId) as SqlRow | undefined
    return row === undefined ? 0 : requiredNumber(row, 'cursor_floor_sequence')
  }

  /**
   * Writes one event from the log into the projection.
   *
   * `INSERT OR IGNORE` on the event id is what makes reconciliation safe to run
   * at any time: an event this client posted itself is already present, and a
   * second projection of it would be a duplicate delivery rather than a repair.
   * A payload the bus holds but this build cannot use is skipped rather than
   * failing the room, because one unreadable event must not make every later
   * event in the room unreachable. That is why the check below covers every
   * column this insert writes, including the ones a constraint would reject:
   * a record refused by SQLite would throw inside the reconcile transaction
   * and take down every later read and post of the room, which is the opposite
   * of skipping it.
   */
  private projectBusEvent(ownerId: string, projectId: string, sequence: number, payload: string): void {
    let record: RoomEventRecord
    try {
      record = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as RoomEventRecord
    } catch {
      return
    }
    // The room comes from the record. A project pass carries every room, and
    // the author of the payload is the one able to say which room it was for.
    if (!isProjectableRecord(record, ownerId, projectId)) return
    const room = record.room

    this.#database.prepare(`
      INSERT OR IGNORE INTO room_events (
        id, owner_id, project_id, room, type, from_agent_id, to_agent_id, reply_to,
        correlation_id, body, artifact_refs_json, created_at, created_at_ms, expires_at_ms,
        ttl_hops, provenance_device_id, provenance_session_id, bus_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, ownerId, projectId, room, record.type, record.fromAgentId,
      optional(record.toAgentId), optional(record.replyTo), optional(record.correlationId), record.body,
      record.artifactRefs === undefined ? null : JSON.stringify(record.artifactRefs), record.createdAt,
      record.createdAtMs, record.expiresAtMs, record.ttlHops, record.deviceId, optional(record.sessionId),
      sequence,
    )
  }

  private busWatermark(ownerId: string, projectId: string): number {
    const row = this.#database.prepare(`
      SELECT bus_sequence FROM room_bus_watermark WHERE owner_id = ? AND project_id = ?
    `).get(ownerId, projectId) as SqlRow | undefined
    return row === undefined ? 0 : requiredNumber(row, 'bus_sequence')
  }

  private raiseBusWatermark(ownerId: string, projectId: string, sequence: number): void {
    this.#database.prepare(`
      INSERT INTO room_bus_watermark (owner_id, project_id, bus_sequence)
      VALUES (?, ?, ?)
      ON CONFLICT (owner_id, project_id)
        DO UPDATE SET bus_sequence = max(bus_sequence, excluded.bus_sequence)
    `).run(ownerId, projectId, sequence)
  }

  private roomEventRowByBusSequence(ownerId: string, projectId: string, room: string, sequence: number, now: number): SqlRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM room_events
      WHERE owner_id = ? AND project_id = ? AND room = ? AND bus_sequence = ? AND expires_at_ms > ?
    `).get(ownerId, projectId, room, sequence, now) as SqlRow | undefined
  }

  async readRoom(ctx: CallerContext, input: ReadRoomInput): Promise<RoomReadResult> {
    return this.audited(ctx, 'room.read', async () => {
      assertCapability(ctx, 'room:read')
      const project = this.currentActiveProject(ctx)
      validateReadRoomInput(input)
      // The durable log leads the projection whenever a post died between the
      // two, or the projection was lost entirely. Catching up before the read
      // is what makes a room recoverable from the bus rather than from SQLite.
      await this.reconcileProject(ctx.ownerId, project.projectId)
      if (input.cursor !== undefined) {
        const emptyPoll = this.storage(() => this.readTransaction(() => {
          const activeProject = this.authorizedProject(ctx, project.projectId, true)
          const now = this.nowMs()
          const snapshot = this.roomReadSnapshot(ctx, activeProject, input, now)
          if (snapshot.rows.length > 0) return undefined
          this.assertReplayFloor(ctx, activeProject.projectId, input.room, now, snapshot.lastSequence)
          return { events: snapshot.events, cursor: input.cursor }
        }))
        if (emptyPoll !== undefined) return emptyPoll
      }

      return this.storage(() => this.transaction(() => {
        const activeProject = this.authorizedProject(ctx, project.projectId, true)
        const now = this.nowMs()
        const snapshot = this.roomReadSnapshot(ctx, activeProject, input, now)
        this.assertReplayFloor(ctx, activeProject.projectId, input.room, now, snapshot.lastSequence)
        let outputCursor = input.cursor
        if (input.cursor === undefined || snapshot.rows.length > 0) {
          this.deleteExpiredRoomCursors(now)
          const existingCheckpoint = this.#database.prepare(`
            SELECT token FROM room_cursors
            WHERE owner_id = ? AND project_id = ? AND room = ? AND agent_id = ?
              AND last_sequence = ? AND expires_at_ms > ?
            ORDER BY rowid LIMIT 1
          `).get(
            ctx.ownerId, activeProject.projectId, input.room, ctx.agentId, snapshot.lastSequence, now,
          ) as SqlRow | undefined
          if (existingCheckpoint) {
            outputCursor = requiredString(existingCheckpoint, 'token')
          } else {
            outputCursor = randomUUID()
            const cursorExpiresAt = this.cursorExpiration(ctx.ownerId, activeProject, input.room, now)
            this.#database.prepare(`
              INSERT INTO room_cursors (token, owner_id, project_id, room, agent_id, last_sequence, expires_at_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(outputCursor, ctx.ownerId, activeProject.projectId, input.room, ctx.agentId, snapshot.lastSequence, cursorExpiresAt)
          }
        }
        return { events: snapshot.events, cursor: outputCursor }
      }))
    }, result => ({
      projectId: isTrustedCallerContext(ctx) ? ctx.projectId : undefined,
      resultCount: result.events.length,
      byteCount: result.events.reduce((sum, event) => sum + Buffer.byteLength(event.body, 'utf8'), 0),
    }))
  }

  async remember(ctx: CallerContext, input: RememberInput): Promise<MemoryRecord> {
    let merged = false
    return this.audited(ctx, 'memory.remember', async () => {
      assertCapability(ctx, 'memory:write')
      validateRememberInput(input)
      let projectId: string | undefined
      let agentId: string | undefined
      if (input.scope === 'user') {
        if (ctx.projectId !== undefined || input.authorship !== 'owner' || ctx.actorType !== 'owner') throw new FabricAccessError()
        assertCapability(ctx, 'memory:write:user')
      } else if (input.scope === 'project') {
        projectId = this.currentActiveProject(ctx).projectId
      } else {
        agentId = ctx.agentId
        if (ctx.projectId !== undefined) projectId = this.currentActiveProject(ctx).projectId
      }

      const [embedding] = await this.#embeddingProvider.embed([input.text])
      if (!embedding || embedding.length !== this.#embeddingProvider.dimensions) throw new FabricStorageError()
      return this.storage(() => this.transaction(() => {
        if (projectId !== undefined) this.authorizedProject(ctx, projectId, true)
        if (input.supersedes) this.validateSupersedes(ctx, input.supersedes, input.scope, projectId, agentId)
        if (!input.supersedes) {
          const duplicate = this.findDuplicateMemory(ctx.ownerId, input.scope, projectId, agentId, input.text)
          if (duplicate) {
            this.raiseMemoryStrength(requiredString(duplicate, 'id'), input.importance, input.confidence, this.nowIso())
            const current = this.memoryRow(ctx.ownerId, requiredString(duplicate, 'id'))
            if (!current) throw new FabricStorageError()
            // Only read on the success path, so a write that fails after this
            // point is audited as failed rather than as a merge.
            merged = true
            return this.memoryFromRow(current)
          }
        }
        const id = `memory-${randomUUID()}`
        const timestamp = this.nowIso()
        const sourceType = input.scope === 'user' ? 'user' : 'agent'
        this.#database.prepare(`
          INSERT INTO memories (
            id, owner_id, scope, project_id, agent_id, kind, text, importance, confidence,
            created_at, updated_at, source_type, source_agent_id, source_session_id, supersedes, normalized_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, ctx.ownerId, input.scope, optional(projectId), optional(agentId), input.kind, input.text,
          input.importance, optional(input.confidence), timestamp, timestamp, sourceType,
          input.scope === 'user' ? null : ctx.agentId,
          input.scope === 'user' ? null : optional(input.sessionId), optional(input.supersedes), memoryDigest(input.text),
        )
        this.#database.prepare('INSERT INTO memory_fts(memory_id, text) VALUES (?, ?)').run(id, input.text)
        this.#vectorStore.upsert(id, embedding, {
          ownerId: ctx.ownerId, scope: input.scope, projectId: projectId ?? null, agentId: agentId ?? null,
        })
        // The predecessor stops being a retrieval candidate the moment its
        // correction lands, in the same transaction as the memory row.
        if (input.supersedes) this.#vectorStore.markSuperseded(input.supersedes)
        const inserted = this.memoryRow(ctx.ownerId, id)
        if (!inserted) throw new FabricStorageError()
        return this.memoryFromRow(inserted)
      }))
    }, record => ({
      projectId: record.projectId,
      targetId: record.id,
      byteCount: Buffer.byteLength(input.text, 'utf8'),
      ...(merged ? { merged: true } : {}),
    }))
  }

  async searchMemory(ctx: CallerContext, input: SearchMemoryInput): Promise<MemorySearchResult> {
    return this.audited(ctx, 'memory.search', async () => {
      assertCapability(ctx, 'memory:read')
      validateSearchMemoryInput(input)
      if (ctx.projectId !== undefined) this.currentActiveProject(ctx)
      const canReadUser = ctx.actorType === 'owner' && ctx.capabilities.has('memory:read:user') && ctx.projectId === undefined
      const [queryVector] = await this.#embeddingProvider.embed([input.query])
      if (!queryVector || queryVector.length !== this.#embeddingProvider.dimensions) throw new FabricStorageError()
      const records = this.storage(() => {
        const lexical = this.lexicalScores(input.query, ctx, input.scope, canReadUser)
        // The admission floor travels with the query: `semanticOnlyAdmissions`
        // rejects everything below it anyway, so retrieving those rows only buys
        // the store the cost of ordering a tie that can never be admitted.
        const semantic = this.#vectorStore.nearest(queryVector, 200, {
          ownerId: ctx.ownerId, agentId: ctx.agentId, canReadUser,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
        }, SEMANTIC_ORTHOGONAL_FLOOR)
        const candidateIds = [...new Set([...lexical.keys(), ...this.semanticOnlyAdmissions(semantic, lexical)])]
        const rows = this.visibleCurrentMemoryRowsByIds(ctx, input.scope, canReadUser, candidateIds)
        const vectors = this.#vectorStore.read(rows.map(row => requiredString(row, 'id')))
        const ranked = rows.map(row => {
          const record = this.memoryFromRow(row)
          const score = hybridScore({ id: record.id, text: record.text, importance: record.importance,
            updatedAt: record.updatedAt, lexical: lexical.get(record.id) ?? 0, vector: vectors.get(record.id) },
          input.query, queryVector, this.nowMs())
          return { record, score }
        }).sort((a, b) => b.score - a.score || b.record.importance - a.record.importance || a.record.id.localeCompare(b.record.id))
          // Validation already bounds the limit; clamping to the same advertised
          // constant keeps the engine from being the only surface that disagrees.
          .slice(0, Math.min(input.limit ?? DEFAULT_MEMORY_SEARCH_LIMIT, MAX_MEMORY_SEARCH_LIMIT)).map(value => value.record)
        const compact: MemoryRecord[] = []
        let bytes = 14
        for (const record of ranked) {
          const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
          // The top match is exempt from the budget. `text` is validated in raw
          // bytes while this cap is measured on the serialized record, and JSON
          // escaping expands control characters sixfold, so a memory remember()
          // accepts can outweigh the whole budget alone. Budgeting it away made
          // search answer "nothing matched" for a stored, authorized, top-ranked
          // record. One record is not a dump: the floor stays bounded by
          // MAX_MEMORY_TEXT_BYTES, and everything after it is budgeted normally.
          if (compact.length > 0 && bytes + recordBytes > 32_768) break
          compact.push(record); bytes += recordBytes
        }
        return compact
      })
      return { records }
    }, result => ({ projectId: isTrustedCallerContext(ctx) ? ctx.projectId : undefined, resultCount: result.records.length }))
  }

  async getMemory(ctx: CallerContext, id: string): Promise<MemoryRecord | null> {
    return this.audited(ctx, 'memory.get', () => {
      assertCapability(ctx, 'memory:read')
      validateMemoryId(id)
      return this.storage(() => {
        const row = this.memoryRow(ctx.ownerId, id)
        if (!row || optionalString(row, 'deleted_at')) throw new FabricAccessError()
        const value = this.memoryFromRow(row)
        if (!this.canReadMemory(ctx, value)) throw new FabricAccessError()
        return value
      })
    }, record => ({ projectId: record?.projectId, resultCount: record ? 1 : 0 }), { targetId: safeAuditTarget(id) })
  }

  async forgetMemory(ctx: CallerContext, id: string): Promise<void> {
    await this.audited(ctx, 'memory.forget', () => {
      assertCapability(ctx, 'memory:delete')
      validateMemoryId(id)
      return this.storage(() => this.transaction(() => {
        const row = this.memoryRow(ctx.ownerId, id)
        if (!row || optionalString(row, 'deleted_at')) throw new FabricAccessError()
        const record = this.memoryFromRow(row)
        if (!this.canReadMemory(ctx, record)) throw new FabricAccessError()
        const timestamp = this.nowIso()
        const changed = this.#database.prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND deleted_at IS NULL').run(timestamp, timestamp, ctx.ownerId, id)
        if (Number(changed.changes) !== 1) throw new FabricAccessError()
        this.#database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id)
        this.#vectorStore.remove(id)
        this.deleteExpiredRoomState(this.nowMs())
        return record.projectId
      }))
    }, projectId => ({ projectId }), { targetId: safeAuditTarget(id) })
  }

  async promoteRoomEvent(ctx: CallerContext, input: PromoteRoomEventInput): Promise<MemoryRecord> {
    let merged = false
    return this.audited(ctx, 'memory.promote', async () => {
      assertCapability(ctx, 'room:read')
      assertCapability(ctx, 'memory:write')
      const project = this.currentActiveProject(ctx)
      validatePromoteRoomEventInput(input)
      await this.reconcileProject(ctx.ownerId, project.projectId)
      const preview = this.storage(() => this.roomEventRow(ctx.ownerId, project.projectId, input.roomEventId, this.nowMs()))
      if (!preview || !this.canSeeRoomRow(ctx, preview)) throw new FabricAccessError()
      const [embedding] = await this.#embeddingProvider.embed([requiredString(preview, 'body')])
      if (!embedding || embedding.length !== this.#embeddingProvider.dimensions) throw new FabricStorageError()
      return this.storage(() => this.transaction(() => {
        const activeProject = this.authorizedProject(ctx, project.projectId, true)
        const now = this.nowMs()
        this.deleteExpiredRoomState(now)
        const eventRow = this.roomEventRow(ctx.ownerId, activeProject.projectId, input.roomEventId, now)
        if (!eventRow || !this.canSeeRoomRow(ctx, eventRow)) throw new FabricAccessError()
        const operation = 'memory.promote'
        const fingerprint = canonicalTuple([input.roomEventId, input.kind, input.importance, input.confidence])
        const dedupe = this.idempotency(ctx, activeProject.projectId, operation, input.idempotencyKey, now)
        if (dedupe) {
          if (requiredString(dedupe, 'fingerprint') !== fingerprint) throw new FabricAccessError()
          const prior = this.memoryRow(ctx.ownerId, requiredString(dedupe, 'result_id'))
          if (!prior || optionalString(prior, 'deleted_at')) throw new FabricAccessError()
          return this.memoryFromRow(prior)
        }
        // An idempotency key is per caller and per attempt, so it cannot stop a
        // second member — or the same agent retrying under a fresh key — from
        // promoting one decision again. Consolidation therefore keys on the
        // source room event: the survivor was promoted from that very event, so
        // the room event id section 7.3 requires is preserved by construction.
        // Merging on normalized text instead would let a promotion be absorbed
        // into a record that carries no room event id at all.
        const existing = this.currentPromotedMemory(ctx.ownerId, activeProject.projectId, requiredString(eventRow, 'id'))
        if (existing) {
          const existingId = requiredString(existing, 'id')
          this.raiseMemoryStrength(existingId, input.importance, input.confidence, new Date(now).toISOString())
          this.insertIdempotency(
            ctx, activeProject.projectId, operation, input.idempotencyKey, fingerprint, existingId, now,
            requiredNumber(eventRow, 'expires_at_ms'),
          )
          const current = this.memoryRow(ctx.ownerId, existingId)
          if (!current) throw new FabricStorageError()
          // Only set on the success path, so a promotion that fails after this
          // point is audited as failed rather than as a merge.
          merged = true
          return this.memoryFromRow(current)
        }
        const id = `memory-${randomUUID()}`
        const timestamp = new Date(now).toISOString()
        this.#database.prepare(`
          INSERT INTO memories (
            id, owner_id, scope, project_id, kind, text, importance, confidence,
            created_at, updated_at, source_type, source_agent_id, source_room_event_id, source_session_id,
            normalized_digest
          ) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, 'room', ?, ?, ?, ?)
        `).run(
          id, ctx.ownerId, activeProject.projectId, input.kind, requiredString(eventRow, 'body'),
          input.importance, optional(input.confidence), timestamp, timestamp,
          requiredString(eventRow, 'from_agent_id'), requiredString(eventRow, 'id'), optionalString(eventRow, 'provenance_session_id') ?? null,
          memoryDigest(requiredString(eventRow, 'body')),
        )
        this.#database.prepare('INSERT INTO memory_fts(memory_id, text) VALUES (?, ?)').run(id, requiredString(eventRow, 'body'))
        this.#vectorStore.upsert(id, embedding, {
          ownerId: ctx.ownerId, scope: 'project', projectId: activeProject.projectId, agentId: null,
        })
        this.insertIdempotency(
          ctx, activeProject.projectId, operation, input.idempotencyKey, fingerprint, id, now,
          requiredNumber(eventRow, 'expires_at_ms'),
        )
        const inserted = this.memoryRow(ctx.ownerId, id)
        if (!inserted) throw new FabricStorageError()
        return this.memoryFromRow(inserted)
      }))
    }, record => ({
      projectId: record.projectId,
      targetId: record.id,
      byteCount: Buffer.byteLength(record.text, 'utf8'),
      ...(merged ? { merged: true } : {}),
    }))
  }

  private migrate(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('PRAGMA user_version').get() as SqlRow | undefined
      const version = row ? requiredNumber(row, 'user_version') : -1
      if (!Number.isInteger(version) || version < 0 || version > CURRENT_FABRIC_SCHEMA_VERSION) throw new FabricStorageError()
      if (version === 0) this.#database.exec(SCHEMA_V1)
      if (version < 2) this.#database.exec(SCHEMA_V2)
      if (version < 3) this.#database.exec(SCHEMA_V3)
      if (version < 4) this.#database.exec(SCHEMA_V4)
      if (version > 0 && version < 5) this.#database.exec(SCHEMA_V5_LEGACY)
      if (version < 5) this.#database.exec(SCHEMA_V5)
      if (version < 6) {
        // A test-only downgrade path (declaring an older user_version against tables already
        // shaped by a prior run) can leave this column present ahead of its migration step.
        const roomStreamStateColumns = this.#database.prepare(`PRAGMA table_info('room_stream_state')`).all() as SqlRow[]
        const hasBroadcastFloor = roomStreamStateColumns.some(column => requiredString(column, 'name') === 'broadcast_replay_floor_sequence')
        if (!hasBroadcastFloor) this.#database.exec('ALTER TABLE room_stream_state ADD COLUMN broadcast_replay_floor_sequence INTEGER NOT NULL DEFAULT 0')
        this.#database.exec(SCHEMA_V6)
      }
      if (version < 7) this.#database.exec(SCHEMA_V7)
      if (version < 8) {
        const memoryColumns = this.#database.prepare(`PRAGMA table_info('memories')`).all() as SqlRow[]
        if (!memoryColumns.some(column => requiredString(column, 'name') === 'normalized_digest')) this.#database.exec(SCHEMA_V8)
        else this.#database.exec(`
          CREATE INDEX IF NOT EXISTS memories_normalized_digest_idx
            ON memories(owner_id, scope, project_id, agent_id, normalized_digest, deleted_at);
          CREATE TABLE IF NOT EXISTS memory_embedding_config (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            provider_id TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK (dimensions > 0)
          );
        `)
        const memories = this.#database.prepare('SELECT id, text FROM memories WHERE normalized_digest IS NULL').all() as SqlRow[]
        const updateDigest = this.#database.prepare('UPDATE memories SET normalized_digest = ? WHERE id = ?')
        for (const memory of memories) updateDigest.run(memoryDigest(requiredString(memory, 'text')), requiredString(memory, 'id'))
      }
      if (version < 9) {
        // A test-only downgrade can present tables already shaped by a later run.
        const vectorColumns = this.#database.prepare(`PRAGMA table_info('memory_vectors')`).all() as SqlRow[]
        if (!vectorColumns.some(column => requiredString(column, 'name') === 'owner_id')) this.#database.exec(SCHEMA_V9)
        else this.#database.exec(`
          CREATE INDEX IF NOT EXISTS memory_vectors_partition_idx
            ON memory_vectors(owner_id, scope, project_id, agent_id, superseded);
        `)
        this.#database.exec(SCHEMA_V9_BACKFILL)
      }
      if (version < 10) {
        // A test-only downgrade can present tables already shaped by a later run.
        const eventColumns = this.#database.prepare(`PRAGMA table_info('room_events')`).all() as SqlRow[]
        if (!eventColumns.some(column => requiredString(column, 'name') === 'bus_sequence')) this.#database.exec(SCHEMA_V10)
        else this.#database.exec(`
          CREATE INDEX IF NOT EXISTS room_events_bus_idx
            ON room_events(owner_id, project_id, room, bus_sequence);
          CREATE TABLE IF NOT EXISTS room_bus_watermark (
            owner_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            room TEXT NOT NULL,
            bus_sequence INTEGER NOT NULL,
            PRIMARY KEY (owner_id, project_id, room)
          );
        `)
      }
      if (version < 11) {
        const watermarkColumns = this.#database.prepare(`PRAGMA table_info('room_bus_watermark')`).all() as SqlRow[]
        const perRoom = watermarkColumns.some(column => requiredString(column, 'name') === 'room')
        if (perRoom || watermarkColumns.length === 0) this.#database.exec(SCHEMA_V11)
        else this.#database.exec(`
          CREATE TABLE IF NOT EXISTS room_bus_fence (
            owner_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            cursor_floor_sequence INTEGER NOT NULL,
            PRIMARY KEY (owner_id, project_id)
          );
        `)
      }
      if (version < 12) this.#database.exec(SCHEMA_V12)
      if (version < 13) this.#database.exec(SCHEMA_V13)
      this.validateCurrentSchema()
      this.#database.exec(`PRAGMA user_version = ${CURRENT_FABRIC_SCHEMA_VERSION}`)
      this.#database.exec('COMMIT')
    } catch {
      try { this.#database.exec('ROLLBACK') } catch { /* original failure wins */ }
      throw new FabricStorageError()
    }
  }

  private validateCurrentSchema(): void {
    const quickCheck = this.#database.prepare('PRAGMA quick_check(1)').get() as SqlRow | undefined
    if (!quickCheck || requiredString(quickCheck, 'quick_check') !== 'ok') throw new FabricStorageError()

    const tableIndexes = new Map<string, SqlRow[]>()
    for (const [table, requirements] of Object.entries(CURRENT_SCHEMA_COLUMNS)) {
      const tableRow = this.#database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
      `).get(table) as SqlRow | undefined
      if (!tableRow) throw new FabricStorageError()

      const columns = this.#database.prepare(`PRAGMA table_info('${table}')`).all() as SqlRow[]
      if (columns.length !== requirements.length) throw new FabricStorageError()
      for (let index = 0; index < requirements.length; index++) {
        const [name, type, notNull, primaryKeyOrder] = requirements[index]
        const column = columns[index]
        if (!column || requiredNumber(column, 'cid') !== index || requiredString(column, 'name') !== name ||
          requiredString(column, 'type').toUpperCase() !== type || requiredNumber(column, 'notnull') !== notNull ||
          requiredNumber(column, 'pk') !== primaryKeyOrder) throw new FabricStorageError()
      }

      const normalizedSql = normalizeSchemaSql(requiredString(tableRow, 'sql'))
      for (const requirement of CURRENT_SCHEMA_SQL_REQUIREMENTS[table] ?? []) {
        if (!normalizedSql.includes(normalizeSchemaSql(requirement))) throw new FabricStorageError()
      }

      const indexes = this.#database.prepare(`PRAGMA index_list('${table}')`).all() as SqlRow[]
      tableIndexes.set(table, indexes)
      const expectedForeignKeys = CURRENT_SCHEMA_FOREIGN_KEYS[table] ?? []
      const foreignKeyRows = this.#database.prepare(`PRAGMA foreign_key_list('${table}')`).all() as SqlRow[]
      const foreignKeyGroups = new Map<number, SqlRow[]>()
      for (const row of foreignKeyRows) {
        const id = requiredNumber(row, 'id')
        const group = foreignKeyGroups.get(id) ?? []
        group.push(row)
        foreignKeyGroups.set(id, group)
      }
      const actualForeignKeys = [...foreignKeyGroups.values()].map(rows => {
        rows.sort((left, right) => requiredNumber(left, 'seq') - requiredNumber(right, 'seq'))
        const first = rows[0]
        if (!first || rows.some(row => requiredString(row, 'table') !== requiredString(first, 'table') ||
          requiredString(row, 'on_update') !== 'NO ACTION' || requiredString(row, 'on_delete') !== 'NO ACTION' ||
          requiredString(row, 'match') !== 'NONE')) throw new FabricStorageError()
        return [
          requiredString(first, 'table'),
          ...rows.flatMap(row => [requiredString(row, 'from'), requiredString(row, 'to')]),
        ]
      })
      const serializedActual = actualForeignKeys.map(value => JSON.stringify(value)).sort()
      const serializedExpected = expectedForeignKeys.map(value => JSON.stringify(value)).sort()
      if (JSON.stringify(serializedActual) !== JSON.stringify(serializedExpected)) throw new FabricStorageError()
    }

    for (const [table, indexName, expectedColumns] of CURRENT_SCHEMA_INDEXES) {
      const index = tableIndexes.get(table)?.find(row => requiredString(row, 'name') === indexName)
      if (!index || requiredNumber(index, 'unique') !== 0 || requiredNumber(index, 'partial') !== 0 ||
        JSON.stringify(this.schemaIndexColumns(indexName)) !== JSON.stringify(expectedColumns)) {
        throw new FabricStorageError()
      }
    }

    for (const [table, expectedColumns] of CURRENT_SCHEMA_UNIQUE_KEYS) {
      const hasUniqueKey = tableIndexes.get(table)?.some(index =>
        requiredNumber(index, 'unique') === 1 && requiredNumber(index, 'partial') === 0 &&
        JSON.stringify(this.schemaIndexColumns(requiredString(index, 'name'))) === JSON.stringify(expectedColumns),
      ) ?? false
      if (!hasUniqueKey) throw new FabricStorageError()
    }

    if (this.#database.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new FabricStorageError()
  }

  private schemaIndexColumns(indexName: string): string[] {
    return (this.#database.prepare(`PRAGMA index_info('${indexName}')`).all() as SqlRow[])
      .sort((left, right) => requiredNumber(left, 'seqno') - requiredNumber(right, 'seqno'))
      .map(row => requiredString(row, 'name'))
  }

  private storage<T>(operation: () => T): T {
    try {
      this.ensureOpen()
      return operation()
    } catch (error) {
      if (isPublicFabricError(error)) throw error
      throw new FabricStorageError()
    }
  }

  private transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch { /* original failure wins */ }
      throw error
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch { /* original failure wins */ }
      throw error
    }
  }

  private ensureOpen(): void {
    if (this.#closed) throw new FabricStorageError()
  }

  private nowMs(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new FabricStorageError()
    return value
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString()
  }

  private projectById(
    ownerId: string,
    projectId: string,
    agentId: string,
    ownerActor: boolean,
    active: boolean,
  ): Project | null {
    this.ensureOpen()
    const row = this.#database.prepare(`
      SELECT p.* FROM projects p
      WHERE p.owner_id = ? AND p.project_id = ?
        AND (? = 1 OR EXISTS (
          SELECT 1 FROM project_members m
          WHERE m.owner_id = p.owner_id AND m.project_id = p.project_id AND m.agent_id = ?
        ))
        AND (? = 0 OR p.archived_at IS NULL)
    `).get(ownerId, projectId, ownerActor ? 1 : 0, agentId, active ? 1 : 0) as SqlRow | undefined
    return row ? this.projectFromRow(row) : null
  }

  private projectFromRow(row: SqlRow): Project {
    const ownerId = requiredString(row, 'owner_id')
    const projectId = requiredString(row, 'project_id')
    const members = (this.#database.prepare(`
      SELECT agent_id FROM project_members WHERE owner_id = ? AND project_id = ? ORDER BY rowid
    `).all(ownerId, projectId) as SqlRow[]).map(member => requiredString(member, 'agent_id'))
    const ttl = optionalNumber(row, 'retention_ttl_hops')
    const days = optionalNumber(row, 'retention_days')
    const retention = ttl === undefined && days === undefined ? undefined : Object.freeze({
      ...(ttl === undefined ? {} : { roomEventTtlHops: ttl }),
      ...(days === undefined ? {} : { roomRetentionDays: days }),
    })
    return Object.freeze({
      projectId,
      displayName: requiredString(row, 'display_name'),
      ...(optionalString(row, 'repo_ref') === undefined ? {} : { repoRef: optionalString(row, 'repo_ref') }),
      ...(optionalString(row, 'workspace_ref') === undefined ? {} : { workspaceRef: optionalString(row, 'workspace_ref') }),
      memberAgentIds: Object.freeze(members),
      memoryNamespace: requiredString(row, 'memory_namespace'),
      roomNamespace: requiredString(row, 'room_namespace'),
      ...(retention === undefined ? {} : { retention }),
      createdAt: requiredString(row, 'created_at'),
      ...(optionalString(row, 'archived_at') === undefined ? {} : { archivedAt: optionalString(row, 'archived_at') }),
    })
  }

  private authorizedProject(ctx: CallerContext, projectId: string, active: boolean): Project {
    return this.storage(() => {
      const project = this.projectById(ctx.ownerId, projectId, ctx.agentId, ctx.actorType === 'owner', active)
      if (!project) throw new FabricAccessError()
      return project
    })
  }

  private currentActiveProject(ctx: CallerContext): Project {
    if (!ctx.projectId) throw new FabricAccessError()
    return this.authorizedProject(ctx, ctx.projectId, true)
  }

  private isProjectMember(ownerId: string, projectId: string, agentId: string): boolean {
    const row = this.#database.prepare('SELECT 1 AS present FROM project_members WHERE owner_id = ? AND project_id = ? AND agent_id = ?').get(ownerId, projectId, agentId) as SqlRow | undefined
    return row !== undefined
  }

  private roomEventRow(ownerId: string, projectId: string, id: string, now: number): SqlRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM room_events WHERE owner_id = ? AND project_id = ? AND id = ? AND expires_at_ms > ?
    `).get(ownerId, projectId, id, now) as SqlRow | undefined
  }

  private cursorExpiration(ownerId: string, project: Project, room: string, now: number): number {
    const retentionMs = project.retention?.roomRetentionDays === undefined
      ? DEFAULT_CURSOR_TTL_MS
      : project.retention.roomRetentionDays * 86_400_000
    const row = this.#database.prepare(`
      SELECT max(expires_at_ms) AS latest_expiry FROM room_events
      WHERE owner_id = ? AND project_id = ? AND room = ? AND expires_at_ms > ?
    `).get(ownerId, project.projectId, room, now) as SqlRow | undefined
    const latestExpiry = row === undefined ? undefined : optionalNumber(row, 'latest_expiry')
    return Math.max(now + retentionMs, latestExpiry ?? 0)
  }

  /**
   * The durable floor covers deleted events. The max-expired query covers rows
   * waiting behind the bounded cleanup batch, so a read never mistakes cleanup
   * backlog for a gap-free stream. An owner sees every event, so its floor is
   * room-global. A non-owner reader only ever saw broadcast events plus events
   * they can receive, so its floor is scoped the same way - including the rule
   * that replies authored by that reader are not delivered back to it.
   */
  private replayFloor(ctx: CallerContext, projectId: string, room: string, now: number): number {
    const state = this.#database.prepare(`
      SELECT replay_floor_sequence, broadcast_replay_floor_sequence FROM room_stream_state
      WHERE owner_id = ? AND project_id = ? AND room = ?
    `).get(ctx.ownerId, projectId, room) as SqlRow | undefined

    if (ctx.actorType === 'owner') {
      const expired = this.#database.prepare(`
        SELECT max(sequence) AS expired_floor FROM room_events
        WHERE owner_id = ? AND project_id = ? AND room = ? AND expires_at_ms <= ?
      `).get(ctx.ownerId, projectId, room, now) as SqlRow | undefined
      return Math.max(
        state === undefined ? 0 : requiredNumber(state, 'replay_floor_sequence'),
        expired === undefined ? 0 : optionalNumber(expired, 'expired_floor') ?? 0,
      )
    }

    const agentFloor = this.#database.prepare(`
      SELECT replay_floor_sequence FROM room_stream_agent_floor
      WHERE owner_id = ? AND project_id = ? AND room = ? AND agent_id = ?
    `).get(ctx.ownerId, projectId, room, ctx.agentId) as SqlRow | undefined
    const expiredVisible = this.#database.prepare(`
      SELECT max(sequence) AS expired_floor FROM room_events
      WHERE owner_id = ? AND project_id = ? AND room = ? AND expires_at_ms <= ?
        AND (to_agent_id IS NULL OR from_agent_id = ? OR to_agent_id = ?)
        AND (from_agent_id <> ? OR reply_to IS NULL)
    `).get(ctx.ownerId, projectId, room, now, ctx.agentId, ctx.agentId, ctx.agentId) as SqlRow | undefined
    return Math.max(
      state === undefined ? 0 : requiredNumber(state, 'broadcast_replay_floor_sequence'),
      agentFloor === undefined ? 0 : requiredNumber(agentFloor, 'replay_floor_sequence'),
      expiredVisible === undefined ? 0 : optionalNumber(expiredVisible, 'expired_floor') ?? 0,
    )
  }

  private roomReadSnapshot(
    ctx: CallerContext,
    project: Project,
    input: ReadRoomInput,
    now: number,
  ): { rows: SqlRow[]; events: RoomEvent[]; lastSequence: number } {
    const replayFloor = this.replayFloor(ctx, project.projectId, input.room, now)
    let lastSequence = replayFloor
    if (input.cursor !== undefined) {
      const cursorRow = this.#database.prepare('SELECT * FROM room_cursors WHERE token = ?').get(input.cursor) as SqlRow | undefined
      if (!cursorRow || requiredString(cursorRow, 'owner_id') !== ctx.ownerId ||
        requiredString(cursorRow, 'project_id') !== project.projectId || requiredString(cursorRow, 'room') !== input.room ||
        requiredString(cursorRow, 'agent_id') !== ctx.agentId || requiredNumber(cursorRow, 'expires_at_ms') <= now) {
        throw new FabricValidationError('cursor')
      }
      lastSequence = requiredNumber(cursorRow, 'last_sequence')
      if (lastSequence < replayFloor) throw new FabricValidationError('cursor')
      // A checkpoint from before the durable log lost events this projection
      // never consumed cannot be resumed: the events between it and what
      // survived have no row to deliver, and continuing would step over them
      // in silence. An unfenced project records nothing here, and a fence of
      // zero is the absence of one rather than a bound every checkpoint sits at
      // or below - a cursorless first read of an empty room checkpoints at zero.
      const fence = this.cursorFence(ctx.ownerId, project.projectId)
      if (fence > 0 && lastSequence <= fence) throw new FabricValidationError('cursor')
    }
    const rows = this.#database.prepare(`
      SELECT * FROM room_events
      WHERE owner_id = ? AND project_id = ? AND room = ? AND sequence > ? AND expires_at_ms > ?
        AND (? = 1 OR to_agent_id IS NULL OR from_agent_id = ? OR to_agent_id = ?)
        AND (? = 1 OR from_agent_id <> ? OR reply_to IS NULL)
      ORDER BY sequence LIMIT ?
    `).all(
      ctx.ownerId, project.projectId, input.room, lastSequence, now,
      ctx.actorType === 'owner' ? 1 : 0, ctx.agentId, ctx.agentId,
      ctx.actorType === 'owner' ? 1 : 0, ctx.agentId, input.limit ?? 100,
    ) as SqlRow[]
    const events = rows.map(row => this.roomEventFromRow(row))
    if (rows.length > 0) lastSequence = requiredNumber(rows[rows.length - 1], 'sequence')
    return { rows, events, lastSequence }
  }

  private assertReplayFloor(ctx: CallerContext, projectId: string, room: string, now: number, lastSequence: number): void {
    if (lastSequence < this.replayFloor(ctx, projectId, room, now)) throw new FabricValidationError('cursor')
  }

  private roomEventFromRow(row: SqlRow): RoomEvent {
    const sessionId = optionalString(row, 'provenance_session_id')
    return Object.freeze({
      id: requiredString(row, 'id'),
      projectId: requiredString(row, 'project_id'),
      room: requiredString(row, 'room'),
      type: requiredString(row, 'type') as RoomEvent['type'],
      fromAgentId: requiredString(row, 'from_agent_id'),
      ...(optionalString(row, 'to_agent_id') === undefined ? {} : { toAgentId: optionalString(row, 'to_agent_id') }),
      ...(optionalString(row, 'reply_to') === undefined ? {} : { replyTo: optionalString(row, 'reply_to') }),
      ...(optionalString(row, 'correlation_id') === undefined ? {} : { correlationId: optionalString(row, 'correlation_id') }),
      body: requiredString(row, 'body'),
      ...(stringArray(row['artifact_refs_json']) === undefined ? {} : { artifactRefs: stringArray(row['artifact_refs_json']) }),
      createdAt: requiredString(row, 'created_at'),
      ttlHops: requiredNumber(row, 'ttl_hops'),
      provenance: Object.freeze({
        deviceId: requiredString(row, 'provenance_device_id'),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    })
  }

  private canSeeRoomRow(ctx: CallerContext, row: SqlRow): boolean {
    if (ctx.actorType === 'owner') return true
    const recipient = optionalString(row, 'to_agent_id')
    return recipient === undefined || requiredString(row, 'from_agent_id') === ctx.agentId || recipient === ctx.agentId
  }

  /** Authorization and current-record predicate shared by every retrieval stage. */
  private static readonly VISIBLE_CURRENT_MEMORY_PREDICATE = `
      m.owner_id = ? AND m.deleted_at IS NULL
        AND (? IS NULL OR m.scope = ?)
        AND (
          (m.scope = 'user' AND ? = 1)
          OR (m.scope = 'project' AND m.project_id = ?)
          OR (m.scope = 'agent' AND m.agent_id = ? AND m.project_id IS ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM memories successor
          WHERE successor.owner_id = m.owner_id AND successor.supersedes = m.id
        )`

  private visibleCurrentMemoryParameters(ctx: CallerContext, scope: MemoryRecord['scope'] | undefined, canReadUser: boolean): unknown[] {
    return [
      ctx.ownerId, optional(scope), optional(scope), canReadUser ? 1 : 0,
      optional(ctx.projectId), ctx.agentId, optional(ctx.projectId),
    ]
  }

  /**
   * Re-applies the same predicate in SQL when hydrating candidates, so the
   * authorization boundary never depends on an in-process identifier set.
   */
  private visibleCurrentMemoryRowsByIds(
    ctx: CallerContext,
    scope: MemoryRecord['scope'] | undefined,
    canReadUser: boolean,
    ids: readonly string[],
  ): SqlRow[] {
    if (ids.length === 0) return []
    return this.#database.prepare(`
      SELECT m.* FROM memories m
      WHERE ${SQLiteFabricClient.VISIBLE_CURRENT_MEMORY_PREDICATE}
        AND m.id IN (${ids.map(() => '?').join(',')})
    `).all(...this.visibleCurrentMemoryParameters(ctx, scope, canReadUser) as never[], ...ids) as SqlRow[]
  }

  /**
   * The nearest eligible neighbours that no lexical term reached, strongest
   * first, capped so an unanswerable query cannot fill a result page with
   * weakly related records. Ties break on identifier so retrieval stays
   * deterministic for the same corpus and query.
   */
  private semanticOnlyAdmissions(semantic: ReadonlyMap<string, number>, lexical: ReadonlyMap<string, number>): string[] {
    return [...semantic]
      .filter(([id, similarity]) => !lexical.has(id) && similarity >= SEMANTIC_ORTHOGONAL_FLOOR)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SEMANTIC_ONLY_CANDIDATES)
      .map(([id]) => id)
  }

  private lexicalScores(
    query: string,
    ctx: CallerContext,
    scope: MemoryRecord['scope'] | undefined,
    canReadUser: boolean,
  ): ReadonlyMap<string, number> {
    const terms = [...new Set(query.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])]
    if (terms.length === 0) return new Map()
    const expression = terms.slice(0, 24).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const rows = this.#database.prepare(`
      SELECT f.memory_id, bm25(memory_fts) AS rank
      FROM memory_fts f JOIN memories m ON m.id = f.memory_id
      WHERE memory_fts MATCH ? AND m.owner_id = ? AND m.deleted_at IS NULL
        AND (? IS NULL OR m.scope = ?)
        AND (
          (m.scope = 'user' AND ? = 1)
          OR (m.scope = 'project' AND m.project_id = ?)
          OR (m.scope = 'agent' AND m.agent_id = ? AND m.project_id IS ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM memories successor
          WHERE successor.owner_id = m.owner_id AND successor.supersedes = m.id
        )
      ORDER BY rank, f.memory_id LIMIT 500
    `).all(
      expression, ctx.ownerId, optional(scope), optional(scope), canReadUser ? 1 : 0,
      optional(ctx.projectId), ctx.agentId, optional(ctx.projectId),
    ) as SqlRow[]
    const output = new Map<string, number>()
    if (rows.length === 0) return output
    const ranks = rows.map(row => requiredNumber(row, 'rank'))
    const strongest = Math.min(...ranks)
    const weakest = Math.max(...ranks)
    for (const row of rows) {
      const rank = requiredNumber(row, 'rank')
      output.set(requiredString(row, 'memory_id'), strongest === weakest ? 1 : (weakest - rank) / (weakest - strongest))
    }
    return output
  }

  private ensureEmbeddingConfiguration(): void {
    this.transaction(() => {
      const configured = this.#database.prepare('SELECT provider_id, dimensions FROM memory_embedding_config WHERE singleton = 1').get() as SqlRow | undefined
      if (configured) {
        if (requiredString(configured, 'provider_id') !== this.#embeddingProvider.id ||
          requiredNumber(configured, 'dimensions') !== this.#embeddingProvider.dimensions) throw new FabricStorageError()
        return
      }
      const count = this.#database.prepare('SELECT count(*) AS count FROM memory_vectors').get() as SqlRow
      if (requiredNumber(count, 'count') > 0 &&
        (this.#embeddingProvider.id !== 'tandem-hash-embedding-v1' || this.#embeddingProvider.dimensions !== 96)) {
        throw new FabricStorageError()
      }
      this.#database.prepare('INSERT INTO memory_embedding_config(singleton, provider_id, dimensions) VALUES (1, ?, ?)')
        .run(this.#embeddingProvider.id, this.#embeddingProvider.dimensions)
    })
  }

  private backfillDefaultEmbeddings(): void {
    const provider = this.#embeddingProvider
    if (!(provider instanceof DeterministicEmbeddingProvider)) return
    const rows = this.#database.prepare(`
      SELECT m.id, m.text, m.owner_id, m.scope, m.project_id, m.agent_id,
        EXISTS (SELECT 1 FROM memories s WHERE s.owner_id = m.owner_id AND s.supersedes = m.id) AS superseded
      FROM memories m LEFT JOIN memory_vectors v ON v.memory_id = m.id
      WHERE m.deleted_at IS NULL AND v.memory_id IS NULL
    `).all() as SqlRow[]
    if (rows.length === 0) return
    this.transaction(() => {
      for (const row of rows) {
        const id = requiredString(row, 'id')
        this.#vectorStore.upsert(id, provider.embedOne(requiredString(row, 'text')), {
          ownerId: requiredString(row, 'owner_id'),
          scope: requiredString(row, 'scope') as MemoryRecord['scope'],
          projectId: optionalString(row, 'project_id') ?? null,
          agentId: optionalString(row, 'agent_id') ?? null,
        })
        if (requiredNumber(row, 'superseded') !== 0) this.#vectorStore.markSuperseded(id)
      }
    })
  }

  private findDuplicateMemory(ownerId: string, scope: MemoryRecord['scope'], projectId: string | undefined, agentId: string | undefined, text: string): SqlRow | undefined {
    return this.#database.prepare(`
      SELECT duplicate.* FROM memories duplicate
      WHERE duplicate.owner_id = ? AND duplicate.scope = ? AND duplicate.project_id IS ? AND duplicate.agent_id IS ? AND duplicate.deleted_at IS NULL
        AND duplicate.normalized_digest = ?
        AND NOT EXISTS (SELECT 1 FROM memories successor WHERE successor.owner_id = duplicate.owner_id AND successor.supersedes = duplicate.id)
      ORDER BY duplicate.updated_at DESC, duplicate.id LIMIT 1
    `).get(ownerId, scope, optional(projectId), optional(agentId), memoryDigest(text)) as SqlRow | undefined
  }

  /**
   * The live memory an earlier promotion of this room event produced, if one is
   * still current. Deleted and superseded rows are excluded on the same grounds
   * as `findDuplicateMemory`: a merge must never resurrect a memory the owner
   * forgot, nor reinstate a record a correction has already replaced.
   */
  private currentPromotedMemory(ownerId: string, projectId: string, roomEventId: string): SqlRow | undefined {
    return this.#database.prepare(`
      SELECT promoted.* FROM memories promoted
      WHERE promoted.owner_id = ? AND promoted.scope = 'project' AND promoted.project_id = ?
        AND promoted.source_type = 'room' AND promoted.source_room_event_id = ?
        AND promoted.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM memories successor WHERE successor.owner_id = promoted.owner_id AND successor.supersedes = promoted.id)
      ORDER BY promoted.created_at, promoted.id LIMIT 1
    `).get(ownerId, projectId, roomEventId) as SqlRow | undefined
  }

  /** A merge raises the surviving record's strength; it never lowers it. */
  private raiseMemoryStrength(id: string, importance: number, confidence: number | undefined, updatedAt: string): void {
    this.#database.prepare(`UPDATE memories SET importance = max(importance, ?),
      confidence = CASE WHEN ? IS NULL THEN confidence WHEN confidence IS NULL THEN ? ELSE max(confidence, ?) END,
      updated_at = ? WHERE id = ?`)
      .run(importance, optional(confidence), optional(confidence), optional(confidence), updatedAt, id)
  }

  private memoryRow(ownerId: string, id: string): SqlRow | undefined {
    return this.#database.prepare('SELECT * FROM memories WHERE owner_id = ? AND id = ?').get(ownerId, id) as SqlRow | undefined
  }

  private memoryFromRow(row: SqlRow): MemoryRecord {
    const sourceType = requiredString(row, 'source_type') as MemoryRecord['source']['type']
    const source = Object.freeze({
      type: sourceType,
      ...(optionalString(row, 'source_agent_id') === undefined ? {} : { agentId: optionalString(row, 'source_agent_id') }),
      ...(optionalString(row, 'source_room_event_id') === undefined ? {} : { roomEventId: optionalString(row, 'source_room_event_id') }),
      ...(optionalString(row, 'source_session_id') === undefined ? {} : { sessionId: optionalString(row, 'source_session_id') }),
    })
    return Object.freeze({
      id: requiredString(row, 'id'),
      scope: requiredString(row, 'scope') as MemoryRecord['scope'],
      ...(optionalString(row, 'project_id') === undefined ? {} : { projectId: optionalString(row, 'project_id') }),
      ...(optionalString(row, 'agent_id') === undefined ? {} : { agentId: optionalString(row, 'agent_id') }),
      kind: requiredString(row, 'kind') as MemoryRecord['kind'],
      text: requiredString(row, 'text'),
      importance: requiredNumber(row, 'importance'),
      ...(optionalNumber(row, 'confidence') === undefined ? {} : { confidence: optionalNumber(row, 'confidence') }),
      createdAt: requiredString(row, 'created_at'),
      updatedAt: requiredString(row, 'updated_at'),
      source,
      ...(optionalString(row, 'supersedes') === undefined ? {} : { supersedes: optionalString(row, 'supersedes') }),
      ...(optionalString(row, 'deleted_at') === undefined ? {} : { deletedAt: optionalString(row, 'deleted_at') }),
    })
  }

  private canReadMemory(ctx: CallerContext, record: MemoryRecord): boolean {
    if (ctx.projectId !== undefined && !this.projectById(ctx.ownerId, ctx.projectId, ctx.agentId, ctx.actorType === 'owner', true)) return false
    if (record.scope === 'user') return ctx.actorType === 'owner' && ctx.capabilities.has('memory:read:user') && ctx.projectId === undefined
    if (record.scope === 'project') return record.projectId === ctx.projectId
    return record.agentId === ctx.agentId && record.projectId === ctx.projectId
  }

  private validateSupersedes(ctx: CallerContext, id: string, scope: MemoryRecord['scope'], projectId?: string, agentId?: string): void {
    const row = this.memoryRow(ctx.ownerId, id)
    if (!row || optionalString(row, 'deleted_at')) throw new FabricAccessError()
    const record = this.memoryFromRow(row)
    const successor = this.#database.prepare('SELECT 1 AS present FROM memories WHERE owner_id = ? AND supersedes = ? AND deleted_at IS NULL LIMIT 1').get(ctx.ownerId, id)
    if (!this.canReadMemory(ctx, record) || record.scope !== scope || record.projectId !== projectId || record.agentId !== agentId || successor) throw new FabricAccessError()
  }

  private idempotency(ctx: CallerContext, projectId: string, operation: string, key: string, now: number): SqlRow | undefined {
    this.#database.prepare(`
      DELETE FROM idempotency
      WHERE owner_id = ? AND project_id = ? AND agent_id = ? AND operation = ?
        AND idempotency_key = ? AND expires_at_ms <= ?
    `).run(ctx.ownerId, projectId, ctx.agentId, operation, key, now)
    return this.#database.prepare(`
      SELECT fingerprint, result_id FROM idempotency
      WHERE owner_id = ? AND project_id = ? AND agent_id = ? AND operation = ?
        AND idempotency_key = ? AND expires_at_ms > ?
    `).get(ctx.ownerId, projectId, ctx.agentId, operation, key, now) as SqlRow | undefined
  }

  private insertIdempotency(
    ctx: CallerContext,
    projectId: string,
    operation: string,
    key: string,
    fingerprint: string,
    resultId: string,
    now: number,
    expiresAt: number,
  ): void {
    this.#database.prepare(`
      INSERT INTO idempotency (
        owner_id, project_id, agent_id, operation, idempotency_key,
        fingerprint, result_id, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ctx.ownerId, projectId, ctx.agentId, operation, key, fingerprint, resultId, now, expiresAt)
  }

  private consumeRoomRate(ctx: CallerContext, projectId: string, now: number): void {
    const row = this.#database.prepare(`
      SELECT window_started_at_ms, event_count FROM room_rate_windows
      WHERE owner_id = ? AND project_id = ? AND agent_id = ?
    `).get(ctx.ownerId, projectId, ctx.agentId) as SqlRow | undefined
    if (!row || now - requiredNumber(row, 'window_started_at_ms') >= this.#rateWindowMs) {
      this.#database.prepare(`
        INSERT INTO room_rate_windows (owner_id, project_id, agent_id, window_started_at_ms, event_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(owner_id, project_id, agent_id)
        DO UPDATE SET window_started_at_ms = excluded.window_started_at_ms, event_count = 1
      `).run(ctx.ownerId, projectId, ctx.agentId, now)
      return
    }
    if (requiredNumber(row, 'event_count') >= this.#rateMaxEvents) throw new FabricValidationError('rateLimit')
    this.#database.prepare(`
      UPDATE room_rate_windows SET event_count = event_count + 1
      WHERE owner_id = ? AND project_id = ? AND agent_id = ?
    `).run(ctx.ownerId, projectId, ctx.agentId)
  }

  /** Returns the total rows deleted across every cleanup class, so a caller can detect remaining backlog. */
  private deleteExpiredRoomState(now: number): number {
    let deleted = this.deleteExpiredRoomCursors(now)

    const rateResult = this.#database.prepare(`
      DELETE FROM room_rate_windows WHERE rowid IN (
        SELECT rowid FROM room_rate_windows
        WHERE window_started_at_ms <= ? ORDER BY window_started_at_ms, rowid LIMIT ?
      )
    `).run(now - this.#rateWindowMs, FABRIC_CLEANUP_BATCH_SIZE)
    deleted += Number(rateResult.changes)

    const expiredEvents = this.#database.prepare(`
      SELECT sequence, owner_id, project_id, room, to_agent_id, from_agent_id, reply_to FROM room_events
      WHERE expires_at_ms <= ? ORDER BY expires_at_ms, sequence LIMIT ?
    `).all(now, FABRIC_CLEANUP_BATCH_SIZE) as SqlRow[]
    const streamFloors = new Map<string, { ownerId: string; projectId: string; room: string; sequence: number }>()
    const broadcastFloors = new Map<string, { ownerId: string; projectId: string; room: string; sequence: number }>()
    const agentFloors = new Map<string, { ownerId: string; projectId: string; room: string; agentId: string; sequence: number }>()
    for (const row of expiredEvents) {
      const ownerId = requiredString(row, 'owner_id')
      const projectId = requiredString(row, 'project_id')
      const room = requiredString(row, 'room')
      const sequence = requiredNumber(row, 'sequence')
      const toAgentId = optionalString(row, 'to_agent_id')
      const fromAgentId = requiredString(row, 'from_agent_id')
      const isReply = optionalString(row, 'reply_to') !== undefined
      const streamKey = canonicalTuple([ownerId, projectId, room])
      const currentStream = streamFloors.get(streamKey)
      if (!currentStream || sequence > currentStream.sequence) streamFloors.set(streamKey, { ownerId, projectId, room, sequence })
      if (toAgentId === undefined && !isReply) {
        const currentBroadcast = broadcastFloors.get(streamKey)
        if (!currentBroadcast || sequence > currentBroadcast.sequence) broadcastFloors.set(streamKey, { ownerId, projectId, room, sequence })
      } else {
        const deliveredAgents = toAgentId === undefined
          ? (this.#database.prepare(`
              SELECT agent_id FROM project_members WHERE owner_id = ? AND project_id = ? AND agent_id <> ?
            `).all(ownerId, projectId, fromAgentId) as SqlRow[]).map(member => requiredString(member, 'agent_id'))
          : [toAgentId, ...(isReply ? [] : [fromAgentId])]
        for (const agentId of new Set(deliveredAgents)) {
          if (isReply && agentId === fromAgentId) continue
          const agentKey = canonicalTuple([ownerId, projectId, room, agentId])
          const currentAgent = agentFloors.get(agentKey)
          if (!currentAgent || sequence > currentAgent.sequence) agentFloors.set(agentKey, { ownerId, projectId, room, agentId, sequence })
        }
      }
    }
    const updateFloor = this.#database.prepare(`
      INSERT INTO room_stream_state (owner_id, project_id, room, replay_floor_sequence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, project_id, room)
      DO UPDATE SET replay_floor_sequence = max(replay_floor_sequence, excluded.replay_floor_sequence)
    `)
    for (const floor of streamFloors.values()) {
      updateFloor.run(floor.ownerId, floor.projectId, floor.room, floor.sequence)
    }
    // Runs after updateFloor: every broadcastFloors key is also a streamFloors key, so the row
    // already exists and this always takes the DO UPDATE branch instead of the zeroed insert.
    const updateBroadcastFloor = this.#database.prepare(`
      INSERT INTO room_stream_state (owner_id, project_id, room, replay_floor_sequence, broadcast_replay_floor_sequence)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(owner_id, project_id, room)
      DO UPDATE SET broadcast_replay_floor_sequence = max(broadcast_replay_floor_sequence, excluded.broadcast_replay_floor_sequence)
    `)
    for (const floor of broadcastFloors.values()) {
      updateBroadcastFloor.run(floor.ownerId, floor.projectId, floor.room, floor.sequence)
    }
    const updateAgentFloor = this.#database.prepare(`
      INSERT INTO room_stream_agent_floor (owner_id, project_id, room, agent_id, replay_floor_sequence)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, project_id, room, agent_id)
      DO UPDATE SET replay_floor_sequence = max(replay_floor_sequence, excluded.replay_floor_sequence)
    `)
    for (const floor of agentFloors.values()) {
      updateAgentFloor.run(floor.ownerId, floor.projectId, floor.room, floor.agentId, floor.sequence)
    }
    if (expiredEvents.length > 0) {
      const placeholders = expiredEvents.map(() => '?').join(', ')
      const eventsResult = this.#database.prepare(`DELETE FROM room_events WHERE sequence IN (${placeholders})`)
        .run(...expiredEvents.map(row => requiredNumber(row, 'sequence')))
      deleted += Number(eventsResult.changes)
    }

    const postIdempotencyResult = this.#database.prepare(`
      DELETE FROM idempotency WHERE rowid IN (
        SELECT rowid FROM idempotency
        WHERE operation = 'room.post' AND expires_at_ms <= ?
        ORDER BY expires_at_ms, rowid LIMIT ?
      )
    `).run(now, FABRIC_CLEANUP_BATCH_SIZE)
    deleted += Number(postIdempotencyResult.changes)
    const promotionIdempotencyResult = this.#database.prepare(`
      DELETE FROM idempotency WHERE rowid IN (
        SELECT rowid FROM idempotency
        WHERE operation = 'memory.promote' AND expires_at_ms <= ?
        ORDER BY expires_at_ms, rowid LIMIT ?
      )
    `).run(now, FABRIC_CLEANUP_BATCH_SIZE)
    deleted += Number(promotionIdempotencyResult.changes)

    return deleted
  }

  private deleteExpiredRoomCursors(now: number): number {
    const result = this.#database.prepare(`
      DELETE FROM room_cursors WHERE rowid IN (
        SELECT rowid FROM room_cursors
        WHERE expires_at_ms <= ? ORDER BY expires_at_ms, rowid LIMIT ?
      )
    `).run(now, FABRIC_CLEANUP_BATCH_SIZE)
    return Number(result.changes)
  }

  private async audited<T>(
    ctx: CallerContext,
    action: FabricAuditAction,
    operation: () => T | Promise<T>,
    successFields: (result: T) => FabricAuditFields = () => ({}),
    requestFields: FabricAuditFields = {},
  ): Promise<T> {
    try {
      const result = await operation()
      // Recorded on success only: an operation that was refused says nothing
      // about whose fabric this is.
      // A single statement, deliberately outside a transaction of its own: it
      // runs after operations that may still hold one, and it is atomic by
      // itself.
      try { this.rememberOwner(ctx.ownerId) } catch { /* must never change an outcome */ }
      let fields: FabricAuditFields = {}
      try { fields = successFields(result) } catch { /* metadata must not change the operation outcome */ }
      this.audit(ctx, action, 'ok', { ...requestFields, ...fields })
      return result
    } catch (error) {
      const status = error instanceof FabricAuthError || error instanceof FabricAccessError || error instanceof FabricValidationError
        ? 'denied'
        : 'failed'
      this.audit(ctx, action, status, requestFields)
      throw error
    }
  }

  private audit(ctx: CallerContext, action: FabricAuditAction, status: FabricAuditEntry['status'], fields: FabricAuditFields = {}): void {
    if (!this.#auditSink) return
    try {
      const trusted = isTrustedCallerContext(ctx)
      let timestamp: string
      try {
        const now = this.#now()
        timestamp = Number.isSafeInteger(now) && now >= 0 ? new Date(now).toISOString() : new Date().toISOString()
      } catch {
        timestamp = new Date().toISOString()
      }
      const entry: FabricAuditEntry = Object.freeze({
        timestamp,
        action,
        status,
        ownerId: trusted ? safeAuditActor(ctx.ownerId) : 'unknown',
        deviceId: trusted ? safeAuditActor(ctx.deviceId) : 'unknown',
        agentId: trusted ? safeAuditActor(ctx.agentId) : 'unknown',
        actorType: trusted ? ctx.actorType : 'unknown',
        ...(trusted && ctx.projectId !== undefined && safeAuditTarget(ctx.projectId) !== undefined ? { projectId: ctx.projectId } : {}),
        ...fields,
      })
      this.#auditSink(entry)
    } catch {
      // The sink is observational. Never echo its possibly content-bearing error.
      process.stderr.write('[fabric] audit sink failed\n')
    }
  }
}
