/**
 * hub-rpc.ts: a request frame from the hub becomes a route() call in
 * ./router.ts, and the router's result becomes the response frame.
 *
 * The body is base64, then UTF-8, then JSON; no body or bad JSON is `{}`, and any
 * other parsed value goes to route() unchanged so its statuses hold. Hub headers
 * are ignored: none grants or changes anything. A router throw answers 500
 * `internal_error`; its message goes to stderr only. A response frame over the
 * link cap is answered 413 `payload_too_large` instead of being sent. The agent filter and
 * the read log lines live in route(), so hub calls and local MCP calls get the same ones.
 */
import { MAX_FRAME_BYTES } from './hub-link.ts'
import { route } from './router.ts'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame, type CcmHttpResponseFrame } from '../hub/src/protocol.ts'

function parseBody(base64: string | undefined): unknown {
  if (!base64) return {}
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

function response(requestId: string, status: number, body: unknown): CcmHttpResponseFrame {
  const frame: CcmHttpResponseFrame = {
    type: CCM_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: status,
    headers: { 'content-type': ['application/json'] },
    body_base64: Buffer.from(JSON.stringify(body ?? null), 'utf8').toString('base64'),
  }
  // The link cap holds in this direction too: a frame over it can cost the bridge its socket.
  if (status !== 413 && Buffer.byteLength(JSON.stringify(frame), 'utf8') > MAX_FRAME_BYTES) {
    return response(requestId, 413, { error: 'payload_too_large' })
  }
  return frame
}

export async function handleHubRequest(frame: CcmHttpRequestFrame): Promise<CcmHttpResponseFrame> {
  try {
    const method = frame.method.toUpperCase()
    const query = new URLSearchParams(frame.raw_query ?? '')
    // route() reads the body as an object; any other JSON value passes unchanged (see the file comment).
    const body = parseBody(frame.body_base64) as Record<string, unknown>
    const result = await route({ method, path: frame.path, query, body })
    return response(frame.request_id, result.status, result.body)
  } catch (error) {
    process.stderr.write(`hub-rpc: router failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return response(frame.request_id, 500, { error: 'internal_error' })
  }
}
