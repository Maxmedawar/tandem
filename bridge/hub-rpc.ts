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
 *
 * A path starting `/fabric/` goes to the fabric router instead, with the frame's
 * `trusted_surface` marker (only the hub's /__fabric-rpc route sets it; without it the
 * answer is 403) and this process's fabric store, if one is open (none: 503).
 *
 * A path starting `/transcripts/` goes to this process's own transcript search
 * (./transcripts/search.ts, opened on first use): POST `/transcripts/search` and
 * `/transcripts/get` with an object body answer its status and body; any other method or
 * path there is 404, any other body 400.
 *
 * fabricForward is the other direction, for a computer with no store: its local MCP
 * servers pass each fabric call over HTTPS to the hub's link route, and the hub sends it
 * to the memory home. HTTPS, not a frame: the stdio server has no link socket.
 */
import { hostname } from 'node:os'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { routeFabricRpc } from './fabric/rpc-router.ts'
import type { LocalFabricHost } from './fabric/local-fabric-host.ts'
import { deriveBridgeId, hubProofHeader, MAX_FRAME_BYTES } from './hub-link.ts'
import { route } from './router.ts'
import type { TranscriptSearch } from './transcripts/search.ts'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame, type CcmHttpResponseFrame } from '../hub/src/protocol.ts'
import { PROOF_HEADER } from '../hub/src/devices.ts'

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

/** A link URL's origin as HTTP: `wss://` becomes `https://`, `ws://` becomes `http://`; nothing else changes. */
export function hubHttpOrigin(wsOrigin: string): string {
  return wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')
}

export interface FabricForward {
  forward(path: string, body: unknown): Promise<unknown>
}

const HUB_UNREACHABLE = Object.freeze({
  error: 'memory_home_offline',
  message: 'memory home offline: this computer cannot reach the hub',
})

/**
 * POSTs `body` to `<hub>/__tunnel/fabric-rpc<path>` with the link token as bearer and a
 * `tandem-proof` over the exact bytes sent (id `bridgeId`, else this computer's link id; key
 * `key`, else this computer's device key), and returns the hub's JSON whatever the status. A
 * non-JSON answer is `fabric_unavailable`; no answer (network error, 120 s) or no usable device
 * key is memory_home_offline. The token is only ever in the header.
 */
export function fabricForward(config: { url: string; token: string; bridgeId?: string; key?: DeviceKey }): FabricForward {
  const base = `${hubHttpOrigin(config.url)}/__tunnel/fabric-rpc`
  return {
    async forward(path, body) {
      let text: string
      try {
        const target = `${base}${path}`
        const bytes = JSON.stringify(body)
        const proof = hubProofHeader(config.key ?? openDeviceKey(), {
          url: config.url,
          method: 'POST',
          path: new URL(target).pathname,
          id: config.bridgeId ?? deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname()),
          body: bytes,
        })
        const answer = await fetch(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', [PROOF_HEADER]: proof },
          body: bytes,
          signal: AbortSignal.timeout(120_000),
        })
        text = await answer.text()
      } catch {
        return { ...HUB_UNREACHABLE }
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        return { error: 'fabric_unavailable' }
      }
    },
  }
}

let transcripts: Promise<TranscriptSearch> | undefined

async function transcriptRequest(frame: CcmHttpRequestFrame): Promise<CcmHttpResponseFrame> {
  const action = frame.path === '/transcripts/search' ? 'search' : frame.path === '/transcripts/get' ? 'get' : undefined
  if (!action || frame.method.toUpperCase() !== 'POST') return response(frame.request_id, 404, { error: 'not found' })
  let body: unknown = null
  if (frame.body_base64) {
    try {
      body = JSON.parse(Buffer.from(frame.body_base64, 'base64').toString('utf8'))
    } catch {
      body = null
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return response(frame.request_id, 400, { error: 'body: must be an object' })
  try {
    transcripts ??= import('./transcripts/search.ts').then((m) => m.openTranscriptSearch())
    const search = await transcripts
    const result = action === 'search' ? await search.search(body) : await search.get(body)
    return response(frame.request_id, result.status, result.body)
  } catch {
    transcripts = undefined
    return response(frame.request_id, 500, { error: 'search unavailable' })
  }
}

export async function handleHubRequest(frame: CcmHttpRequestFrame, fabric?: LocalFabricHost): Promise<CcmHttpResponseFrame> {
  if (frame.path.startsWith('/transcripts/')) return transcriptRequest(frame)
  if (frame.path.startsWith('/fabric/')) {
    try {
      const result = await routeFabricRpc({
        trust: frame.trusted_surface,
        client: fabric?.client,
        method: frame.method.toUpperCase(),
        path: frame.path,
        body: parseBody(frame.body_base64),
      })
      return response(frame.request_id, result.status, result.body)
    } catch {
      return response(frame.request_id, 503, { error: 'fabric_unavailable' })
    }
  }
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
