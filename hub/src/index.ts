/**
 * tandem hub Worker entry.
 *
 * Layout:
 *   - OAuthProvider (@cloudflare/workers-oauth-provider) wraps the MCP endpoint
 *     so claude.ai's custom-connector OAuth handshake works. This is a personal,
 *     single-user connector, so the authorize step is gated by a PASSWORD login
 *     form (src/auth-gate.ts, secret TANDEM_HUB_PASSWORD) — NOT auto-approved. On the
 *     correct password it completes the grant for the one user (the owner) and 302s back
 *     with a code; with no secret configured it FAILS CLOSED.
 *   - The MCP server (Streamable HTTP at /mcp, SSE at /sse) is the OAuth-protected
 *     API; tokens are minted by the provider and required to reach it.
 *   - GET /__tunnel/connect is a RAW websocket route guarded by a shared secret
 *     (TANDEM_HUB_LINK_TOKEN) and the computer's own device proof (`tandem-proof`, ./devices:
 *     the id is bound to the first key that proves it); it forwards to the singleton TunnelDO.
 *     It is NOT behind OAuth — it is the Mac bridge's own outbound channel.
 *   - POST /__tunnel/fabric-rpc/fabric/<op> (same secret and proof, from an id already bound
 *     on the tunnel): a computer with no memory
 *     store passes a fabric call here; the TunnelDO sends it to the memory home. The hub
 *     sets the caller itself (its one owner); a caller in the body is never used.
 *   - The roster routes (U-R1A-31B-2; same secret and proof, an id proved here for the first
 *     time is bound: a new computer offers before its bridge ever connected): GET and PUT of the
 *     owner's roster, POST of this computer's pairing offer, GET of the offers waiting. The hub
 *     keeps them (./roster-store) and never checks a signature; every computer does.
 *   - GET / is an unauthenticated health check.
 *
 * The provider routes: anything starting with the API routes (/mcp, /sse) and
 * with a valid access token goes to `apiHandlers`; everything else (authorize,
 * tunnel, health) goes to `defaultHandler` below.
 */

import OAuthProvider, { type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { TandemMcp } from './mcp'
import { iconBytes, ICON_MIME } from './icon'
import { TUNNEL_SINGLETON_NAME, type Env } from './types'
import { handleAuthorize, timingSafeEqual, createRegistrationGuardedFetch, SINGLE_USER_ID } from './auth-gate'
import { WS_MAX_FRAME_BYTES } from './frame-size'
import { fabricCallerFor } from '../../src/fabric/mcp-tools.ts'
import { EMPTY_SHA256, PROOF_HEADER, sha256Hex, type ProofContext } from './devices'

/** Env as seen by the default handler: the provider injects OAUTH_PROVIDER. */
type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers }

/**
 * Default (non-API) handler: the password-gated OAuth authorize route, the tunnel
 * upgrade route, and the health check.
 */
const defaultHandler: ExportedHandler<HandlerEnv> = {
  async fetch(request: Request, env: HandlerEnv): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/') {
      return new Response('tandem', { status: 200 })
    }

    // Connector icon (the Claude Code crab). Unauthenticated, non-sensitive:
    // claude.ai fetches the connector origin's favicon, so this is what makes the
    // icon show next to the connector / its tools. Cached for a day.
    if (url.pathname === '/favicon.ico' || url.pathname === '/icon.png') {
      return new Response(iconBytes(), {
        status: 200,
        headers: { 'content-type': ICON_MIME, 'cache-control': 'public, max-age=86400' },
      })
    }

    if (url.pathname === '/__tunnel/connect') {
      // A secret in the URL lands in proxy, CDN and request logs. Refuse any
      // `token` query parameter on the secret route, even when the header
      // secret is valid, so no client can keep sending one.
      if (url.searchParams.has('token')) return new Response('unauthorized', { status: 401 })
      return handleTunnelConnect(request, env)
    }

    if (url.pathname.startsWith(FABRIC_LINK_PREFIX + '/fabric/')) {
      return handleFabricLink(request, env, url)
    }

    // Each roster route runs the device check for its own request.
    if (url.pathname === '/__tunnel/roster') return handleRoster(request, env, url, 'roster', (stub, ctx) => stub.checkDevice(request.headers.get(PROOF_HEADER), ctx))
    if (url.pathname === '/__tunnel/roster/offer') return handleRoster(request, env, url, 'offer', (stub, ctx) => stub.checkDevice(request.headers.get(PROOF_HEADER), ctx))
    if (url.pathname === '/__tunnel/roster/offers') return handleRoster(request, env, url, 'offers', (stub, ctx) => stub.checkDevice(request.headers.get(PROOF_HEADER), ctx))

    if (url.pathname === '/authorize') {
      return handleAuthorize(request, env)
    }

    return new Response('not found', { status: 404 })
  },
}

/** The secret from `Authorization: Bearer <t>` (scheme case-insensitive), the
 *  only place the tunnel secret is read from. */
function bearerToken(request: Request): string | undefined {
  const auth = request.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return undefined
  return auth.slice('bearer '.length).trim() || undefined
}

/** The plain-text answer to a refused device proof. */
function deviceRefusal(status: 401 | 409 | 503): Response {
  const body = status === 409 ? 'machine id taken' : status === 503 ? 'device table full' : 'unauthorized'
  return new Response(body, { status })
}

/**
 * RAW websocket route for the Mac bridge. Checks the shared secret from
 * `Authorization: Bearer` (401 on a bad/absent token), then the device proof for
 * `GET /__tunnel/connect` whose id must be exactly the `bridge_id` query value (an id
 * proved here for the first time is bound to its key), then forwards the upgrade request
 * to the singleton TunnelDO.
 */
async function handleTunnelConnect(request: Request, env: HandlerEnv): Promise<Response> {
  const presented = bearerToken(request)

  if (!env.TANDEM_HUB_LINK_TOKEN || !presented || !timingSafeEqual(presented, env.TANDEM_HUB_LINK_TOKEN)) {
    return new Response('unauthorized', { status: 401 })
  }

  const id = env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME)
  const stub = env.TUNNEL.get(id)
  const url = new URL(request.url)
  const { status } = await stub.checkDevice(request.headers.get(PROOF_HEADER), {
    host: url.host,
    method: 'GET',
    path: '/__tunnel/connect',
    bodySha256: EMPTY_SHA256,
    queryId: url.searchParams.get('bridge_id') ?? '',
    mayBind: true,
  })
  if (status !== 200) return deviceRefusal(status)
  return stub.fetch(request)
}

const FABRIC_LINK_PREFIX = '/__tunnel/fabric-rpc'

/**
 * The link route for fabric calls. Order: a `token` query 401, not POST 405, a missing or
 * wrong bearer 401, a body over WS_MAX_FRAME_BYTES 413 (readCapped: never held past the cap),
 * a device proof that is not over these exact bytes or not from an id already bound on the
 * tunnel 401 (409/503 as checkDevice says), a body that is not an object with
 * an object `input` 400; then the TunnelDO's answer as it is. Only `input` is kept: the
 * caller is the hub's own owner, derived here as TandemMcp derives it.
 */
async function handleFabricLink(request: Request, env: HandlerEnv, url: URL): Promise<Response> {
  if (url.searchParams.has('token')) return new Response('unauthorized', { status: 401 })
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const presented = bearerToken(request)
  if (!env.TANDEM_HUB_LINK_TOKEN || !presented || !timingSafeEqual(presented, env.TANDEM_HUB_LINK_TOKEN)) {
    return new Response('unauthorized', { status: 401 })
  }
  const bytes = await readCapped(request, WS_MAX_FRAME_BYTES)
  if (!bytes) return jsonResponse({ error: 'payload_too_large' }, 413)
  const stub = env.TUNNEL.get(env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME))
  const { status } = await stub.checkDevice(request.headers.get(PROOF_HEADER), {
    host: url.host,
    method: 'POST',
    path: url.pathname,
    bodySha256: await sha256Hex(bytes),
    mayBind: false,
  })
  if (status !== 200) return deviceRefusal(status)
  let input: unknown
  try {
    input = (JSON.parse(new TextDecoder().decode(bytes)) as { input?: unknown }).input
  } catch {
    input = undefined
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return jsonResponse({ error: 'fabric_request_invalid' }, 400)
  }
  return stub.fetch(`https://do/__fabric-rpc${url.pathname.slice(FABRIC_LINK_PREFIX.length)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ caller: await fabricCallerFor(SINGLE_USER_ID), input }),
  })
}

type TunnelStub = DurableObjectStub<import('./tunnel-do').TunnelDO>
type RosterRoute = 'roster' | 'offer' | 'offers'
type DeviceCheck = (stub: TunnelStub, ctx: ProofContext & { mayBind: boolean }) => ReturnType<TunnelStub['checkDevice']>

/** The methods each roster route takes and the body cap for each (bytes). */
const ROSTER_METHODS: Record<RosterRoute, Record<string, number>> = {
  roster: { GET: 0, PUT: 135_168 },
  offer: { POST: 8192 },
  offers: { GET: 0 },
}

/** `{ <names> }` exactly, each of the given type, else undefined. */
function bodyOf(bytes: Uint8Array, types: Record<string, 'number' | 'string'>): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const o = value as Record<string, unknown>
    const names = Object.keys(types).sort()
    if (Object.keys(o).sort().join() !== names.join() || !names.every((n) => typeof o[n] === types[n])) return undefined
    return o
  } catch {
    return undefined
  }
}

/**
 * The roster routes. Order, as the fabric link route: a `token` query 401, a method the route
 * does not take 405, a missing or wrong bearer 401, a body over the route's cap 413, then the
 * device proof over these exact bytes (an id proved for the first time is bound to its key; a
 * refusal as checkDevice says), then the store's answer for the computer the proof names.
 */
async function handleRoster(request: Request, env: HandlerEnv, url: URL, route: RosterRoute, check: DeviceCheck): Promise<Response> {
  if (url.searchParams.has('token')) return new Response('unauthorized', { status: 401 })
  const cap = ROSTER_METHODS[route][request.method]
  if (cap === undefined) return new Response('method not allowed', { status: 405 })
  const presented = bearerToken(request)
  if (!env.TANDEM_HUB_LINK_TOKEN || !presented || !timingSafeEqual(presented, env.TANDEM_HUB_LINK_TOKEN)) {
    return new Response('unauthorized', { status: 401 })
  }
  const bytes = await readCapped(request, cap)
  if (!bytes) return jsonResponse({ error: 'payload_too_large' }, 413)
  const stub = env.TUNNEL.get(env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME))
  const device = await check(stub, {
    host: url.host,
    method: request.method,
    path: url.pathname,
    bodySha256: await sha256Hex(bytes),
    mayBind: true,
  })
  if (device.status !== 200) return deviceRefusal(device.status)
  const { id, key } = device
  if (route === 'offers') return jsonResponse({ offers: await stub.rosterOffers() }, 200)
  if (route === 'offer') {
    const body = bodyOf(bytes, { offer: 'string' })
    if (!body) return jsonResponse({ error: 'roster_invalid' }, 400)
    switch (await stub.rosterPostOffer(id, key, body.offer as string)) {
      case 'ok': return jsonResponse({ ok: true }, 200)
      case 'not_yours': return jsonResponse({ error: 'offer_not_yours' }, 403)
      case 'full': return jsonResponse({ error: 'offers_full' }, 409)
      case 'slow': return jsonResponse({ error: 'slow_down' }, 429)
      default: return jsonResponse({ error: 'roster_invalid' }, 400)
    }
  }
  if (request.method === 'GET') {
    const held = await stub.rosterGet()
    return held ? jsonResponse({ len: held.len, roster: held.roster }, 200) : jsonResponse({ error: 'no_roster' }, 404)
  }
  const body = bodyOf(bytes, { base: 'number', roster: 'string' })
  if (!body) return jsonResponse({ error: 'roster_invalid' }, 400)
  const { answer, len } = await stub.rosterPut(id, key, body.base as number, body.roster as string)
  switch (answer) {
    case 'ok': return jsonResponse({ len }, 200)
    case 'conflict': return jsonResponse({ error: 'roster_conflict', len }, 409)
    case 'not_in_roster': return jsonResponse({ error: 'not_in_roster' }, 403)
    default: return jsonResponse({ error: 'roster_invalid' }, 400)
  }
}

/**
 * The request body, or undefined when it is over `cap` bytes. A declared length over the cap
 * is refused unread. A body with no declared length is kept up to the cap; past it the rest
 * is read and thrown away, so the hub never holds more than `cap` bytes of a refused body.
 * Thrown away, not cancelled: a local hub (`wrangler dev`) fails the next request it gets
 * after a body is cancelled part-way ("Your worker restarted mid-request").
 */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > cap) return undefined
  const bytes = new Uint8Array(cap)
  let size = 0
  for await (const chunk of (request.body ?? []) as AsyncIterable<Uint8Array>) {
    if (size + chunk.byteLength <= cap) bytes.set(chunk, size)
    size += chunk.byteLength
  }
  return size > cap ? undefined : bytes.subarray(0, size)
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The dynamic client registration endpoint. SINGLE source of truth: used BOTH in
 *  the OAuthProvider config below AND by the registration guard, so the guard path
 *  and the provider's registration path can never drift apart (review H2). */
const REGISTER_ENDPOINT = '/register'

const oauthProvider = new OAuthProvider({
  // The OAuth-protected MCP transports. Both serve the same TandemMcp agent
  // (binding MCP_OBJECT, the package default).
  apiHandlers: {
    '/mcp': TandemMcp.serve('/mcp'),
    '/sse': TandemMcp.serveSSE('/sse'),
  },
  // Cast: the provider types defaultHandler's env as `unknown`; we narrow it to
  // our Env (+ injected OAUTH_PROVIDER), which is sound at runtime.
  defaultHandler: defaultHandler as ExportedHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: REGISTER_ENDPOINT,
})

/**
 * The exported Worker handler WRAPS the OAuthProvider so we can gate dynamic
 * client registration (POST /register) BEFORE the provider handles it. Without
 * this, registration is OPEN: an attacker could register a client with
 * `redirect_uri:https://evil/cb`, phish the owner with a crafted /authorize link, and
 * launder the auth code to their address. The guard rejects any registration whose
 * redirect_uri origin is off the allowlist; everything else (authorize, token, api,
 * tunnel, health) passes straight through to the provider with (request, env, ctx).
 */
export default {
  fetch: createRegistrationGuardedFetch(oauthProvider, REGISTER_ENDPOINT),
} satisfies ExportedHandler<HandlerEnv>

export { TunnelDO } from './tunnel-do'
export { TandemMcp } from './mcp'
export { LoginThrottleDO } from './login-throttle'
