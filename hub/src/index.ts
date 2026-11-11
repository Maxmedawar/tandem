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
 *     (TANDEM_HUB_LINK_TOKEN); it forwards to the singleton TunnelDO. It is NOT behind
 *     OAuth — it is the Mac bridge's own outbound channel.
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
import { handleAuthorize, timingSafeEqual, createRegistrationGuardedFetch } from './auth-gate'

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

/**
 * RAW websocket route for the Mac bridge. Checks the shared secret from
 * `Authorization: Bearer` only, then forwards the upgrade request to the
 * singleton TunnelDO. Rejects with 401 on a bad/absent token.
 */
function handleTunnelConnect(request: Request, env: HandlerEnv): Response | Promise<Response> {
  const presented = bearerToken(request)

  if (!env.TANDEM_HUB_LINK_TOKEN || !presented || !timingSafeEqual(presented, env.TANDEM_HUB_LINK_TOKEN)) {
    return new Response('unauthorized', { status: 401 })
  }

  const id = env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME)
  const stub = env.TUNNEL.get(id)
  return stub.fetch(request)
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
