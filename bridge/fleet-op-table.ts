/**
 * fleet-op-table.ts — the ONE fixed operation → local route translation table
 * (binding — Phase 3 correction 11): fleet dispatch is a fixed table, never
 * arbitrary method/path forwarding. `bridge/router.ts` remains the single
 * device-local trust boundary — this module only ever calls its existing
 * `routeForTest()` seam with a hard-coded method/path per operation, exactly
 * like every other caller of the router.
 *
 * Used IDENTICALLY by the hub's own local dispatch (bridge/fleet-dispatch.ts)
 * and by a device executing an incoming fleet request (bridge/fleet-device-
 * router.ts) — same table, same router, same trust boundary either way.
 */
import { routeForTest } from './router.ts'
import type { FleetOp } from './fleet-protocol.ts'

export interface DispatchResult {
  status: number
  body: unknown
}

export interface LocalOpPayload {
  name?: string
  engine?: string
  cwd?: string
  model?: string
  effort?: string
  sessionId?: string
  text?: string
  cursor?: number
  limit?: number
  project?: string
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v))
  return usp.toString()
}

export async function executeLocalOp(op: FleetOp, payload: LocalOpPayload): Promise<DispatchResult> {
  switch (op) {
    case 'open_session':
      return routeForTest('POST', '/sessions/open', {
        name: payload.name,
        engine: payload.engine,
        cwd: payload.cwd,
        model: payload.model,
        effort: payload.effort,
      })
    case 'send':
      return routeForTest('POST', `/sessions/${encodeURIComponent(payload.sessionId ?? '')}/send`, {
        text: payload.text ?? '',
        cursor: payload.cursor,
        model: payload.model,
        effort: payload.effort,
      })
    case 'read':
      return routeForTest(
        'GET',
        `/sessions/${encodeURIComponent(payload.sessionId ?? '')}/read`,
        {},
        buildQuery({ cursor: payload.cursor }),
      )
    case 'interrupt':
      return routeForTest('POST', `/sessions/${encodeURIComponent(payload.sessionId ?? '')}/interrupt`)
    case 'close':
      return routeForTest('POST', `/sessions/${encodeURIComponent(payload.sessionId ?? '')}/close`)
    case 'list_sessions':
      return routeForTest('GET', '/sessions', {}, buildQuery({ limit: payload.limit, project: payload.project, engine: payload.engine }))
  }
}
