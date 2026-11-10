/**
 * fleet-protocol.ts — the versioned, bounded WebSocket RPC protocol between a
 * device bridge and the hub's PRIVATE fleet listener (spec "Fleet protocol").
 * This module owns frame shapes, size limits, and encode/decode/validation
 * ONLY — it has no socket, registry, or process knowledge, and no side effect
 * at import (binding — Phase 3 correction 7).
 *
 * Every frame is validated with `.strict()` Zod schemas so an unknown
 * operation or an unexpected extra field fails closed on BOTH directions:
 * `parseFrame` validates inbound bytes, and every `encode*Frame` helper
 * validates its own output before returning it — nothing is ever sent that
 * wasn't itself schema-checked. Every encode helper also rejects (via
 * `FrameTooLargeError`) a serialized frame over `MAX_FRAME_BYTES` BEFORE it
 * is handed to a socket, and `parseFrame` rejects an oversize inbound frame
 * before it is ever JSON-parsed.
 *
 * `relay` is deliberately NOT one of the fleet operations (binding — Phase 3
 * correction 1): the autonomous relay stays local-only and is never reachable
 * through the fleet wire.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { EngineId } from './drivable.ts'

export const PROTOCOL_VERSION = 1 as const

/** Hard cap on any single serialized frame, either direction. */
export const MAX_FRAME_BYTES = 1_048_576 // 1 MiB

/** Hard cap on simultaneously in-flight requests to one device — a limit,
 *  never an unbounded queue (binding — Phase 3 correction 3): a device at the
 *  cap rejects the NEXT request immediately. */
export const MAX_IN_FLIGHT_PER_DEVICE = 32

/** Default RPC timeout. `open_session` documents its own longer bound below
 *  because a fresh spawn + engine warmup legitimately takes longer than a
 *  plain send/read/interrupt/close round trip. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
export const OPEN_SESSION_TIMEOUT_MS = 90_000
export const REGISTRATION_TIMEOUT_MS = 10_000
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 45_000

const ENGINE_IDS = ['claude', 'codex', 'shell', 'hermes'] as const satisfies readonly EngineId[]

/** Strict length/character bounds for every identifier this protocol carries. */
const deviceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'invalid device id')
const deviceNameSchema = z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/, 'invalid device name')
/** Cryptographically random per connection, bounded, base64url-charset. This
 *  is a per-connection uniqueness marker only — it is NOT a bearer-token
 *  replay defense (binding — Phase 3 correction 4). Tandem does not track
 *  used nonces or reject a repeated one in this MVP; the actual security
 *  boundary is the exact bearer-token check plus the loopback/tailnet-only
 *  transport. Never logged (see fleet-private-server.ts / fleet-device-client.ts). */
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/, 'invalid nonce')
const requestIdSchema = z.string().regex(/^[A-Za-z0-9]{16,64}$/, 'invalid request id')
const localNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, 'invalid session name')
const textSchema = z.string().max(65_536)
const cursorSchema = z.number().int().nonnegative().max(100_000_000)
const limitSchema = z.number().int().positive().max(1000)
const projectSchema = z.string().max(256)
const cwdSchema = z.string().max(4096)
const modelSchema = z.string().max(128)
const effortSchema = z.string().max(32)
const errorMessageSchema = z.string().max(1024)

export const FLEET_OPS = ['open_session', 'send', 'read', 'interrupt', 'close', 'list_sessions'] as const
export type FleetOp = (typeof FLEET_OPS)[number]

/** Exact, operation-specific strict payload schemas (binding — Phase 3
 *  correction 8). Unknown/extra fields fail closed via `.strict()`. */
const opPayloadSchemas = {
  open_session: z
    .object({
      name: localNameSchema.optional(),
      engine: z.enum(ENGINE_IDS).optional(),
      cwd: cwdSchema.optional(),
      model: modelSchema.optional(),
      effort: effortSchema.optional(),
    })
    .strict(),
  send: z
    .object({
      sessionId: localNameSchema,
      text: textSchema.optional(),
      cursor: cursorSchema.optional(),
      model: modelSchema.optional(),
      effort: effortSchema.optional(),
    })
    .strict(),
  read: z.object({ sessionId: localNameSchema, cursor: cursorSchema.optional() }).strict(),
  interrupt: z.object({ sessionId: localNameSchema }).strict(),
  close: z.object({ sessionId: localNameSchema }).strict(),
  list_sessions: z.object({ limit: limitSchema.optional(), project: projectSchema.optional() }).strict(),
} as const satisfies Record<FleetOp, z.ZodTypeAny>

export type OpenSessionPayload = z.infer<typeof opPayloadSchemas.open_session>
export type SendPayload = z.infer<typeof opPayloadSchemas.send>
export type ReadPayload = z.infer<typeof opPayloadSchemas.read>
export type SessionRefPayload = z.infer<typeof opPayloadSchemas.interrupt>
export type ListSessionsPayload = z.infer<typeof opPayloadSchemas.list_sessions>

export const registerFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('register'),
    deviceId: deviceIdSchema,
    name: deviceNameSchema,
    engines: z.array(z.enum(ENGINE_IDS)).max(ENGINE_IDS.length).refine((items) => new Set(items).size === items.length, 'duplicate engine'),
    nonce: nonceSchema,
  })
  .strict()
export type RegisterFrame = z.infer<typeof registerFrameSchema>

export const registerAckFrameSchema = z
  .object({ v: z.literal(1), type: z.literal('register_ack'), ok: z.boolean(), error: errorMessageSchema.optional() })
  .strict()
export type RegisterAckFrame = z.infer<typeof registerAckFrameSchema>

const requestVariants = FLEET_OPS.map((op) =>
  z
    .object({
      v: z.literal(1),
      type: z.literal('request'),
      id: requestIdSchema,
      op: z.literal(op),
      payload: opPayloadSchemas[op],
    })
    .strict(),
) as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]

export const requestFrameSchema = z.discriminatedUnion('op', requestVariants as never)
/** Explicit mapped union preserves the op-to-payload correlation for
 * TypeScript. The runtime schema above is built dynamically from the same
 * table, but its necessary tuple cast would otherwise erase this variant. */
export type RequestFrame = {
  [K in FleetOp]: {
    v: 1
    type: 'request'
    id: string
    op: K
    payload: z.infer<(typeof opPayloadSchemas)[K]>
  }
}[FleetOp]

/** `body` is bounded to a plain JSON object (never a bare string/array/number)
 *  — the exact per-op shape is owned and already tested by bridge/router.ts;
 *  the wire layer's job is bounding TYPE and total SIZE (the 1 MiB frame cap
 *  below), not re-declaring router.ts's evolving ad-hoc response fields. */
const responseSuccessFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('response'),
    id: requestIdSchema,
    ok: z.literal(true),
    status: z.number().int().min(100).max(599),
    body: z.record(z.string(), z.unknown()),
  })
  .strict()

const responseFailureFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('response'),
    id: requestIdSchema,
    ok: z.literal(false),
    error: errorMessageSchema,
  })
  .strict()

export const responseFrameSchema = z.discriminatedUnion('ok', [responseSuccessFrameSchema, responseFailureFrameSchema])
export type ResponseFrame = z.infer<typeof responseFrameSchema>

const pingSchema = z.object({ v: z.literal(1), type: z.literal('ping') }).strict()
const pongSchema = z.object({ v: z.literal(1), type: z.literal('pong') }).strict()
export type PingFrame = z.infer<typeof pingSchema>
export type PongFrame = z.infer<typeof pongSchema>

export const capabilityRefreshFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('capabilities'),
    engines: z.array(z.enum(ENGINE_IDS)).max(ENGINE_IDS.length).refine((items) => new Set(items).size === items.length, 'duplicate engine'),
  })
  .strict()
export type CapabilityRefreshFrame = z.infer<typeof capabilityRefreshFrameSchema>

export type Frame =
  | RegisterFrame
  | RegisterAckFrame
  | RequestFrame
  | ResponseFrame
  | PingFrame
  | PongFrame
  | CapabilityRefreshFrame

export class FrameTooLargeError extends Error {}
export class FrameInvalidError extends Error {}

/** Validate public registration metadata before a socket is opened. */
export function validateDeviceId(value: string): string {
  const valid = parseOrThrow(deviceIdSchema, value)
  if (valid === 'local') throw new FrameInvalidError('device id "local" is reserved for the hub')
  return valid
}

export function validateDeviceName(value: string): string {
  return parseOrThrow(deviceNameSchema, value)
}

function byteLength(raw: string | Buffer): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new FrameInvalidError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
  }
  return result.data
}

/** Validates a serialized frame is within `MAX_FRAME_BYTES` BEFORE returning
 *  it — every encode* helper below routes through this. */
function sizeBounded(json: string): string {
  if (Buffer.byteLength(json, 'utf8') > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(`frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }
  return json
}

/** Parses + validates an INBOUND frame: size check first (never JSON.parse an
 *  oversize payload), then JSON parse, then exact shape validation dispatched
 *  on `.type`. Unknown types and malformed JSON both fail closed. */
export function parseFrame(raw: string | Buffer): Frame {
  if (byteLength(raw) > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(`frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }
  let json: unknown
  try {
    json = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    throw new FrameInvalidError('malformed JSON frame')
  }
  if (typeof json !== 'object' || json === null || !('type' in json)) {
    throw new FrameInvalidError('frame missing type')
  }
  const type = (json as { type?: unknown }).type
  switch (type) {
    case 'register':
      return parseOrThrow(registerFrameSchema, json)
    case 'register_ack':
      return parseOrThrow(registerAckFrameSchema, json)
    case 'request':
      return parseOrThrow(requestFrameSchema, json) as RequestFrame
    case 'response':
      return parseOrThrow(responseFrameSchema, json)
    case 'ping':
      return parseOrThrow(pingSchema, json)
    case 'pong':
      return parseOrThrow(pongSchema, json)
    case 'capabilities':
      return parseOrThrow(capabilityRefreshFrameSchema, json)
    default:
      throw new FrameInvalidError(`unknown frame type: ${String(type)}`)
  }
}

export function encodeRegisterFrame(deviceId: string, name: string, engines: EngineId[], nonce: string): string {
  const frame = parseOrThrow(registerFrameSchema, { v: 1, type: 'register', deviceId, name, engines, nonce })
  return sizeBounded(JSON.stringify(frame))
}

export function encodeRegisterAckFrame(ok: boolean, error?: string): string {
  const frame = parseOrThrow(registerAckFrameSchema, { v: 1, type: 'register_ack', ok, ...(error !== undefined ? { error } : {}) })
  return sizeBounded(JSON.stringify(frame))
}

const payloadSchemaByOp: Record<FleetOp, z.ZodTypeAny> = opPayloadSchemas

export function encodeRequestFrame(id: string, op: FleetOp, payload: unknown): string {
  const validId = parseOrThrow(requestIdSchema, id)
  const validPayload = parseOrThrow(payloadSchemaByOp[op], payload)
  const frame = { v: 1 as const, type: 'request' as const, id: validId, op, payload: validPayload }
  return sizeBounded(JSON.stringify(frame))
}

export function encodeResponseFrame(id: string, ok: boolean, status?: number, body?: unknown, error?: string): string {
  const frame = ok
    ? parseOrThrow(responseFrameSchema, { v: 1, type: 'response', id, ok: true, status, body })
    : parseOrThrow(responseFrameSchema, { v: 1, type: 'response', id, ok: false, error })
  return sizeBounded(JSON.stringify(frame))
}

export function encodePingFrame(): string {
  return sizeBounded(JSON.stringify(parseOrThrow(pingSchema, { v: 1, type: 'ping' })))
}

export function encodePongFrame(): string {
  return sizeBounded(JSON.stringify(parseOrThrow(pongSchema, { v: 1, type: 'pong' })))
}

export function encodeCapabilitiesFrame(engines: EngineId[]): string {
  const frame = parseOrThrow(capabilityRefreshFrameSchema, { v: 1, type: 'capabilities', engines })
  return sizeBounded(JSON.stringify(frame))
}

/** Cryptographically random, bounded nonce for a single connection attempt. */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url')
}

/** Cryptographically random, bounded RPC request id. */
export function generateRequestId(): string {
  return randomBytes(12).toString('hex')
}
