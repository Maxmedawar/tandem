/**
 * Wire contract for the embedded project bus (Phase 3).
 *
 * fabricd is the durable authority for room events; this file is the only
 * place the two implementations agree on shapes and bounds. Every constant
 * here has a counterpart in `fabricd/internal/control` and
 * `fabricd/internal/bus`, and the fabricd contract suite pins them against the
 * Go source so the pair cannot drift silently.
 *
 * The bus is content-agnostic by design: a room event crosses as an opaque
 * base64 payload. Room semantics - hop TTL, visibility, rate limits, cursors,
 * idempotency fingerprints, promotion - stay in `FabricClient`, which owns the
 * public contract this phase must not change.
 */

/** Bumped when a request or response shape changes incompatibly. */
export const FABRICD_PROTOCOL_VERSION = 2

/** Bounds one request line and one response line. */
export const FABRICD_MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Matches `MAX_ROOM_READ_LIMIT`; the two surfaces advertise one number. */
export const FABRICD_MAX_FETCH_LIMIT = 500

/** Payload bytes one fetch may return. */
export const FABRICD_MAX_FETCH_BYTES = 1024 * 1024

/** Longest bounded long poll. A wait is never an open-ended parked request. */
export const FABRICD_MAX_WAIT_MS = 60_000

/** Largest single stored event. */
export const FABRICD_MAX_PAYLOAD_BYTES = 1024 * 1024

/** Bounds every identifier: owner, project, room, task, message id, holder. */
export const FABRICD_MAX_NAME_BYTES = 256

/** Concurrent in-flight requests fabricd will handle. */
export const FABRICD_MAX_IN_FLIGHT = 32

export const FABRICD_OPS = Object.freeze([
  'health', 'room.publish', 'room.fetch', 'room.info',
  'project.info', 'project.fetch',
  'task.claim', 'task.complete', 'task.get',
  'mesh.status', 'mesh.enroll', 'mesh.leave',
  'mesh.accept', 'mesh.respond', 'mesh.request',
] as const)

export type FabricdOp = (typeof FABRICD_OPS)[number]

/**
 * Every failure crosses back as one of these codes and nothing else. fabricd
 * never returns a room name, a payload, or native JetStream error text, which
 * can quote the message that failed.
 */
export type FabricdErrorCode =
  | 'invalid'
  | 'too_large'
  | 'not_found'
  | 'conflict'
  | 'closed'
  | 'unavailable'
  | 'name_collision'
  | 'task_claimed'
  | 'task_complete'
  | 'task_not_holder'
  | 'not_enrolled'
  | 'busy'
  | `peer_${string}`

export const FABRICD_ERROR_CODES: readonly FabricdErrorCode[] = Object.freeze([
  'invalid', 'too_large', 'not_found', 'conflict', 'closed', 'unavailable',
  'name_collision', 'task_claimed', 'task_complete', 'task_not_holder',
  'not_enrolled', 'busy',
])

/**
 * A refusal that came from the answering device rather than from the path to
 * it.
 *
 * The peer's own code is carried through with this prefix because the two are
 * different answers and a caller retries only one of them: an unreachable
 * device may come back, a device that said no will say no again. The code
 * itself stays content-free - it crosses the fabric, and a message is where a
 * room name would end up.
 */
const PEER_ERROR_CODE = /^peer_[a-z_]{1,32}$/

export function isFabricdErrorCode(value: unknown): value is FabricdErrorCode {
  if (typeof value !== 'string') return false
  return (FABRICD_ERROR_CODES as readonly string[]).includes(value) || PEER_ERROR_CODE.test(value)
}

export function isPeerRefusal(code: FabricdErrorCode): boolean {
  return PEER_ERROR_CODE.test(code)
}

/** A failed bus operation. The code is the whole diagnostic, by design. */
export class FabricdBusError extends Error {
  readonly code: FabricdErrorCode
  constructor(code: FabricdErrorCode) {
    super(`fabricd: ${code}`)
    this.name = 'FabricdBusError'
    this.code = code
  }
}

/** A bounded retention window. Every field must be positive. */
export interface BusRetention {
  readonly maxAgeSeconds: number
  readonly maxMessages: number
  readonly maxBytes: number
  readonly duplicateWindowSeconds: number
}

export interface BusPublishInput {
  readonly owner: string
  readonly project: string
  readonly room: string
  /** Deduplicates within the stream's duplicate window. */
  readonly messageId: string
  /** Base64 of the opaque event bytes. */
  readonly payload: string
  readonly retention: BusRetention
}

export interface BusPublishResult {
  readonly sequence: number
  /** True when the message id was already stored; sequence is the original's. */
  readonly duplicate: boolean
}

export interface BusFetchInput {
  readonly owner: string
  readonly project: string
  readonly room: string
  readonly afterSequence: number
  readonly limit: number
  readonly maxBytes: number
  readonly maxWaitMs: number
}

export interface BusEvent {
  readonly sequence: number
  /** Base64 of the opaque event bytes. */
  readonly payload: string
  readonly publishedAtMs: number
}

export interface BusFetchResult {
  readonly events: readonly BusEvent[]
  /** Equals the request's `afterSequence` when nothing was delivered. */
  readonly lastSequence: number
}

export interface BusProjectInput {
  readonly owner: string
  readonly project: string
}

export interface BusProjectFetchInput extends BusProjectInput {
  readonly afterSequence: number
  readonly limit: number
  readonly maxBytes: number
  readonly maxWaitMs: number
}

export interface BusRoomInput {
  readonly owner: string
  readonly project: string
  readonly room: string
}

/**
 * The retained window of a stream, reported for a project or for one room.
 *
 * `firstSequence` is load-bearing, and only meaningful for a project. JetStream
 * silently starts a reader at the oldest retained message when the requested
 * sequence has aged out, which would hand a stale reader a partial suffix.
 * Compared against a project's consumed position it is exact: a project is one
 * stream, so anything between the two was discarded. Compared against a room's
 * it is not, because the sequences between them may have belonged to a sibling
 * room that was never lost at all.
 */
export interface BusRoomInfo {
  readonly firstSequence: number
  readonly lastSequence: number
  readonly messages: number
}

export interface BusTaskInput {
  readonly owner: string
  readonly project: string
  readonly taskId: string
}

export interface BusTaskHolderInput extends BusTaskInput {
  readonly holder: string
}

export type BusTaskState = 'claimed' | 'complete'

export interface BusTaskRecord {
  readonly taskId: string
  readonly holder: string
  readonly state: BusTaskState
  readonly claimedAtMs: number
  readonly completedAtMs?: number
  readonly revision: number
}

export interface BusHealth {
  readonly protocol: number
  readonly ready: boolean
  /** Must always be empty: the embedded server binds no socket. */
  readonly listeners: readonly string[]
}

/**
 * The slice of the bus the room authority uses.
 *
 * `SQLiteFabricClient` depends on this rather than on `FabricdBus` so the
 * durable store it talks to is a contract rather than a process: a test double
 * and the real child satisfy the same three operations, and nothing in the
 * room path can reach for a transport detail that only one of them has.
 */
export interface RoomBus {
  publish(input: BusPublishInput): Promise<BusPublishResult>
  /**
   * Reads a project's events across every room in one pass.
   *
   * Reconciliation is per project rather than per room because a project is
   * one stream: its sequences are contiguous, so a position in them is an
   * exact statement about what has been consumed. A per-room position is not -
   * a room's sequences have its siblings' interleaved between them, and a gap
   * cannot be told apart from another room's events.
   */
  projectFetch(input: BusProjectFetchInput): Promise<BusFetchResult>
  /** The retained window of a project's whole stream. */
  projectInfo(input: BusProjectInput): Promise<BusRoomInfo>
}

/**
 * Bounds one payload crossing to or from a peer device.
 *
 * It matches `FABRICD_MAX_PAYLOAD_BYTES` because the same check guards every
 * payload written to the control channel. A larger bound here would create a
 * window where a response passed the caller's check, failed the channel's, and
 * was never sent - the peer waiting out its whole timeout for a refusal.
 */
export const FABRICD_MAX_MESH_PAYLOAD_BYTES = FABRICD_MAX_PAYLOAD_BYTES

/** Bounds the long poll for inbound peer requests. */
export const FABRICD_MAX_MESH_WAIT_MS = 60_000

export interface MeshPeer {
  readonly deviceId: string
  readonly hostname: string
  readonly addresses: readonly string[]
  readonly online: boolean
  /** The relay carrying this peer, empty when the connection is direct. */
  readonly relay?: string
}

export interface MeshStatus {
  readonly enrolled: boolean
  readonly deviceId?: string
  readonly hostname?: string
  readonly addresses: readonly string[]
  readonly online: boolean
  readonly peers: readonly MeshPeer[]
}

export interface MeshEnrollInput {
  readonly controlUrl: string
  readonly hostname: string
  readonly authKey: string
}

export interface MeshInboundRequest {
  readonly id: string
  /**
   * The mesh identity of the device that sent this, taken from the connection
   * rather than the payload. Authority decisions are made against it, so a
   * peer that could assert its own name could assert another device's.
   */
  readonly fromDeviceId: string
  /** Base64 of the opaque request bytes. */
  readonly payload: string
}

/** Bounds checked before a request is written, so fabricd never sees one. */
export function isValidBusName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (new TextEncoder().encode(value).length > FABRICD_MAX_NAME_BYTES) return false
  // Control characters are refused for every name, matching fabricd: a message
  // id carrying CR/LF would otherwise forge NATS headers, and a newline in
  // any field would split the request frame itself.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export function isValidRetention(value: BusRetention | undefined): value is BusRetention {
  if (!value) return false
  return [value.maxAgeSeconds, value.maxMessages, value.maxBytes, value.duplicateWindowSeconds]
    .every(field => Number.isSafeInteger(field) && field > 0)
}
