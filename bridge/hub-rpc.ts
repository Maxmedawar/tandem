/**
 * hub-rpc.ts: a request frame from the hub becomes a route() call in
 * ./router.ts, and the router's result becomes the response frame.
 *
 * The body is base64, then UTF-8, then JSON; no body or bad JSON is `{}`, and any
 * other parsed value goes to route() unchanged so its statuses hold. Hub headers
 * are ignored: none grants or changes anything. A router throw answers 500
 * `internal_error`; its message goes to stderr only.
 */
import { audit } from './audit.ts'
import { route } from './router.ts'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame, type CcmHttpResponseFrame } from '../hub/src/protocol.ts'

/** Rows of `engine` (`terminal` means `shell`), then the caller's limit. No engine or `all` keeps every row. */
export function filterSessionsByEngine<T extends { engine?: string }>(
  sessions: T[],
  engine: string | undefined,
  limit: number,
): T[] {
  if (!engine || engine === 'all') return sessions.slice(0, limit)
  const wanted = engine === 'terminal' ? 'shell' : engine
  return sessions.filter((session) => session.engine === wanted).slice(0, limit)
}

function parseBody(base64: string | undefined): unknown {
  if (!base64) return {}
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

function response(requestId: string, status: number, body: unknown): CcmHttpResponseFrame {
  return {
    type: CCM_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: status,
    headers: { 'content-type': ['application/json'] },
    body_base64: Buffer.from(JSON.stringify(body ?? null), 'utf8').toString('base64'),
  }
}

export async function handleHubRequest(frame: CcmHttpRequestFrame): Promise<CcmHttpResponseFrame> {
  try {
    const method = frame.method.toUpperCase()
    const query = new URLSearchParams(frame.raw_query ?? '')
    const parts = frame.path.split('/').filter(Boolean)
    // route() reads the body as an object; any other JSON value passes unchanged (see the file comment).
    const body = parseBody(frame.body_base64) as Record<string, unknown>

    // ponytail: read audit here, move into router.route when a later unit owns router.ts.
    if (method === 'GET' && parts.length === 3 && parts[2] === 'read') {
      if (parts[0] === 'sessions') audit({ route: 'GET /sessions/:name/read', name: decodeURIComponent(parts[1]) })
      if (parts[0] === 'relay') audit({ route: 'GET /relay/:loopId/read', loopId: decodeURIComponent(parts[1]) })
    }

    // ponytail: agent filter here, move into router.route when a later unit owns router.ts.
    const engine = query.get('engine')
    if (method === 'GET' && parts.length === 1 && parts[0] === 'sessions' && engine && engine !== 'all') {
      const limit = query.get('limit') ? Number(query.get('limit')) : 20
      const every = new URLSearchParams(query)
      every.set('limit', String(Number.MAX_SAFE_INTEGER)) // listSessions slices only at the end
      const result = await route({ method, path: frame.path, query: every, body })
      if (result.status !== 200) return response(frame.request_id, result.status, result.body)
      const { sessions = [], ...rest } = result.body as { sessions?: { engine?: string }[] }
      return response(frame.request_id, 200, { ...rest, sessions: filterSessionsByEngine(sessions, engine, limit) })
    }

    const result = await route({ method, path: frame.path, query, body })
    return response(frame.request_id, result.status, result.body)
  } catch (error) {
    process.stderr.write(`hub-rpc: router failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return response(frame.request_id, 500, { error: 'internal_error' })
  }
}
