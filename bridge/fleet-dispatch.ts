/**
 * fleet-dispatch.ts — the HUB side of session routing (binding — Phase 3
 * correction 2): resolves a caller-supplied `device`/session name into either
 * the existing LOCAL path (bridge/router.ts, unchanged) or a REMOTE fleet RPC,
 * and returns the identical bounded `{status, body}` shape either way.
 *
 * ROUTING RULES:
 *   - A bare name with no `device` is ALWAYS local — preserved exactly as
 *     before, and never re-resolved to a remote device.
 *   - A composite "device:localName" name and/or an explicit `device` field
 *     route exactly there; the two must agree or the call fails 400.
 *   - `open_session` with no device/composite name picks a configured
 *     default device, or the single device (local counts as a candidate)
 *     uniquely capable of the requested engine; otherwise a deterministic
 *     ambiguity error. An open with no engine goes to the explicit device,
 *     else local, carrying no engine: that device's router answers 400.
 *   - Every remote (or explicitly device-scoped) response that carries a
 *     `name` field has that field rewritten to the globally routable
 *     "<deviceId>:<localName>" form, with additive `device`/`localName`
 *     fields — a bare name is never returned for a remote session. Once a
 *     caller has that composite name, later calls parse the device out of it
 *     directly and never re-run selection — routing never drifts as fleet
 *     membership changes later.
 */
import type { EngineId } from './drivable.ts'
import { isBuiltinEngine } from './engine-registry.ts'
import { executeLocalOp, type DispatchResult } from './fleet-op-table.ts'
import { DeviceOfflineError, InFlightLimitError, BackpressureError, RpcTimeoutError, RpcRejectedError } from './fleet-broker.ts'
import { OPEN_SESSION_TIMEOUT_MS, type FleetOp } from './fleet-protocol.ts'
import type { FleetRuntime } from './fleet-runtime.ts'
import { filterSessionsByEngine } from './router.ts'

export class DeviceConflictError extends Error {}
export class DeviceNotFoundError extends Error {}
export class DeviceAmbiguousError extends Error {
  readonly candidates: string[]

  constructor(
    message: string,
    candidates: string[],
  ) {
    super(message)
    this.candidates = candidates
  }
}

interface ResolvedTarget {
  /** undefined ⇒ local. */
  deviceId?: string
  localName: string
}

/** Parses a caller-supplied session name + optional explicit device into a
 *  resolved routing target, WITHOUT consulting online state — a bare name
 *  always means local, a composite/explicit device always means that exact
 *  device, full stop. */
export function resolveExistingTarget(name: string, explicitDevice: string | undefined): ResolvedTarget {
  const sep = name.indexOf(':')
  if (sep === -1) {
    if (explicitDevice !== undefined && explicitDevice !== 'local') return { deviceId: explicitDevice, localName: name }
    return { localName: name }
  }
  const impliedDevice = name.slice(0, sep)
  const localName = name.slice(sep + 1)
  if (explicitDevice !== undefined && explicitDevice !== impliedDevice) {
    throw new DeviceConflictError(
      `device "${explicitDevice}" conflicts with device "${impliedDevice}" implied by session name "${name}"`,
    )
  }
  if (impliedDevice === 'local') return { localName }
  return { deviceId: impliedDevice, localName }
}

interface OpenCandidate {
  deviceId?: string
  engines: EngineId[]
}

/** Device selection for `open_session` when no device/composite name is
 *  given. Local is always a candidate (engines = the local enabled-engine
 *  set), so a single-device/no-fleet setup keeps resolving to local exactly
 *  as before. */
export function resolveOpenDevice(runtime: FleetRuntime, explicitDevice: string | undefined, engine: EngineId): string | undefined {
  // A harness engine is a file on this hub (fleet frames carry built-in ids only): always local.
  if (!isBuiltinEngine(engine)) {
    if (explicitDevice !== undefined && explicitDevice !== 'local') {
      throw new DeviceNotFoundError(`engine "${engine}" is not a built-in engine; it runs only on device "local"`)
    }
    return undefined
  }
  if (explicitDevice !== undefined) {
    if (explicitDevice === 'local') {
      const localEngines = runtime.localDevice?.engines ?? []
      if (!localEngines.includes(engine)) {
        throw new DeviceNotFoundError(`device "local" does not support engine "${engine}"`)
      }
      return undefined
    }
    const device = runtime.registry.get(explicitDevice)
    if (!device) throw new DeviceNotFoundError(`device "${explicitDevice}" is not online`)
    if (!device.engines.includes(engine)) {
      throw new DeviceNotFoundError(`device "${explicitDevice}" does not support engine "${engine}"`)
    }
    return explicitDevice
  }

  const candidates: OpenCandidate[] = [
    { deviceId: undefined, engines: runtime.localDevice?.engines ?? [] },
    ...runtime.registry.listOnline().map((d) => ({ deviceId: d.deviceId, engines: d.engines })),
  ]
  const capable = candidates.filter((c) => c.engines.includes(engine))

  if (runtime.defaultDeviceId !== undefined) {
    const configured = candidates.find((c) => (c.deviceId ?? 'local') === runtime.defaultDeviceId)
    if (!configured) throw new DeviceNotFoundError(`default device "${runtime.defaultDeviceId}" is not online`)
    if (!configured.engines.includes(engine)) {
      throw new DeviceNotFoundError(`default device "${runtime.defaultDeviceId}" does not support engine "${engine}"`)
    }
    return configured.deviceId
  }
  if (capable.length === 1) return capable[0]!.deviceId
  if (capable.length === 0) throw new DeviceNotFoundError(`no online device (including local) supports engine "${engine}"`)
  throw new DeviceAmbiguousError(
    `multiple online devices support engine "${engine}"; specify device explicitly`,
    capable.map((c) => c.deviceId ?? 'local'),
  )
}

const SCHEDULED_OPS = new Set<FleetOp>(['open_session', 'send', 'close'])

function brokerErrorToResult(e: unknown): DispatchResult {
  if (e instanceof DeviceOfflineError) return { status: 404, body: { error: e.message } }
  if (e instanceof InFlightLimitError) return { status: 429, body: { error: e.message } }
  if (e instanceof BackpressureError) return { status: 429, body: { error: e.message } }
  if (e instanceof RpcTimeoutError) return { status: 504, body: { error: e.message } }
  if (e instanceof RpcRejectedError) return { status: 502, body: { error: e.message } }
  return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
}

/** Rewrites a `name` field (when present and a string) into the globally
 *  routable composite form, with additive `device`/`localName`. No-op when
 *  the body has no `name` (e.g. read()'s response). */
function rewriteNameField(result: DispatchResult, deviceId: string): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as Record<string, unknown> | undefined
  if (!body || typeof body.name !== 'string') return result
  const localName = body.name
  return { status: result.status, body: { ...body, name: `${deviceId}:${localName}`, device: deviceId, localName } }
}

function rewriteListSessionsResponse(result: DispatchResult, deviceId: string): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as { sessions?: unknown } | undefined
  if (!body || !Array.isArray(body.sessions)) return result
  const sessions = body.sessions.map((s) => {
    if (typeof s !== 'object' || s === null || typeof (s as Record<string, unknown>).id !== 'string') return s
    const rec = s as Record<string, unknown>
    const localName = rec.id as string
    return { ...rec, id: `${deviceId}:${localName}`, device: deviceId, localName }
  })
  return { status: result.status, body: { ...body, sessions } }
}

async function maybeScheduled(runtime: FleetRuntime, op: FleetOp, key: string, run: () => Promise<DispatchResult>): Promise<DispatchResult> {
  return SCHEDULED_OPS.has(op) ? runtime.scheduler.schedule(key, run) : run()
}

export interface OpenSessionRequest {
  name?: string
  engine?: EngineId
  cwd?: string
  model?: string
  effort?: string
  device?: string
}

export async function dispatchOpenSession(runtime: FleetRuntime, req: OpenSessionRequest): Promise<DispatchResult> {
  const engine = req.engine
  let localName = req.name
  let requestedDevice = req.device
  const explicitlyScoped = req.device !== undefined || req.name?.includes(':') === true
  if (req.name?.includes(':')) {
    try {
      const target = resolveExistingTarget(req.name, req.device)
      requestedDevice = target.deviceId ?? 'local'
      localName = target.localName
    } catch (e) {
      if (e instanceof DeviceConflictError) return { status: 400, body: { error: e.message } }
      throw e
    }
  }
  let deviceId: string | undefined
  try {
    deviceId = engine === undefined
      ? requestedDevice === 'local' ? undefined : requestedDevice
      : resolveOpenDevice(runtime, requestedDevice, engine)
  } catch (e) {
    if (e instanceof DeviceAmbiguousError) return { status: 409, body: { error: e.message, candidates: e.candidates } }
    if (e instanceof DeviceNotFoundError) return { status: 400, body: { error: e.message } }
    throw e
  }
  const key = `${deviceId ?? 'local'}:${localName ?? '*'}`
  const result = await maybeScheduled(runtime, 'open_session', key, async () => {
    if (deviceId === undefined) {
      return executeLocalOp('open_session', { name: localName, engine, cwd: req.cwd, model: req.model, effort: req.effort })
    }
    try {
      return await runtime.broker.sendRequest(
        deviceId,
        'open_session',
        { name: localName, engine, cwd: req.cwd, model: req.model, effort: req.effort },
        { timeoutMs: OPEN_SESSION_TIMEOUT_MS },
      )
    } catch (e) {
      return brokerErrorToResult(e)
    }
  })
  return deviceId === undefined
    ? explicitlyScoped
      ? rewriteNameField(result, 'local')
      : result
    : rewriteNameField(result, deviceId)
}

export async function dispatchSessionOp(
  runtime: FleetRuntime,
  op: 'send' | 'read' | 'interrupt' | 'close',
  name: string,
  explicitDevice: string | undefined,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const explicitlyScoped = explicitDevice !== undefined || name.includes(':')
  let target: ResolvedTarget
  try {
    target = resolveExistingTarget(name, explicitDevice)
  } catch (e) {
    if (e instanceof DeviceConflictError) return { status: 400, body: { error: e.message } }
    throw e
  }
  const key = `${target.deviceId ?? 'local'}:${target.localName}`
  const result = await maybeScheduled(runtime, op, key, async () => {
    if (target.deviceId === undefined) {
      return executeLocalOp(op, { sessionId: target.localName, ...payload })
    }
    if (!runtime.registry.isOnline(target.deviceId)) {
      return { status: 404, body: { error: `device "${target.deviceId}" is not online` } }
    }
    try {
      return await runtime.broker.sendRequest(target.deviceId, op, { sessionId: target.localName, ...payload })
    } catch (e) {
      return brokerErrorToResult(e)
    }
  })
  return target.deviceId === undefined
    ? explicitlyScoped
      ? rewriteNameField(result, 'local')
      : result
    : rewriteNameField(result, target.deviceId)
}

/** A remote device's rows, kept to one agent's here: the fleet frame carries no engine. */
function filterRemoteRows(result: DispatchResult, engine: string | undefined): DispatchResult {
  if (engine === undefined || result.status < 200 || result.status >= 300) return result
  const body = result.body as { sessions?: unknown } | undefined
  if (!body || !Array.isArray(body.sessions)) return result
  const rows = body.sessions.filter((s): s is { engine?: string } => typeof s === 'object' && s !== null)
  const sessions = filterSessionsByEngine(rows, engine, rows.length)
  return { status: result.status, body: { ...body, sessions } }
}

export async function dispatchListSessions(
  runtime: FleetRuntime,
  explicitDevice: string | undefined,
  payload: { limit?: number; project?: string; engine?: string },
): Promise<DispatchResult> {
  if (explicitDevice === undefined || explicitDevice === 'local') {
    const result = await executeLocalOp('list_sessions', payload)
    return explicitDevice === 'local' ? rewriteListSessionsResponse(result, 'local') : result
  }
  if (!runtime.registry.isOnline(explicitDevice)) {
    return { status: 404, body: { error: `device "${explicitDevice}" is not online` } }
  }
  let result: DispatchResult
  try {
    result = await runtime.broker.sendRequest(explicitDevice, 'list_sessions', { limit: payload.limit, project: payload.project })
  } catch (e) {
    return brokerErrorToResult(e)
  }
  return rewriteListSessionsResponse(filterRemoteRows(result, payload.engine), explicitDevice)
}

/** Pure local read of the registry's public list — never a wire round trip;
 *  the hub already knows every online device's engines from registration. */
export function dispatchListDevices(runtime: FleetRuntime): DispatchResult {
  const devices = runtime.localDevice ? [runtime.localDevice, ...runtime.registry.publicList()] : runtime.registry.publicList()
  return { status: 200, body: { devices } }
}
