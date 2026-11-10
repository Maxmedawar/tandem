/**
 * auth-gate.ts — the /authorize PASSWORD GATE for the OAuth handshake.
 *
 * SECURITY (this is the front door): claude.ai opens /authorize in the user's
 * browser during connector setup. Previously this AUTO-APPROVED every request with
 * zero credentials — anyone with the Worker URL could complete the handshake and
 * gain full control of Max's Mac (and with the ccm- fence removed, that's "drive
 * any terminal"). This module gates /authorize on a shared password secret
 * `CCM_MCP_PASSWORD` (set via `wrangler secret put`, never in code).
 *
 * Behavior:
 *   - No CCM_MCP_PASSWORD configured -> FAIL CLOSED (503). NEVER auto-approve.
 *   - GET /authorize -> render a minimal HTML login form. The original OAuth query
 *     params are preserved as HTML-ESCAPED hidden inputs so the flow resumes after
 *     auth; a `password` param is never preserved.
 *   - POST /authorize, correct password -> rebuild the auth request from the
 *     preserved params (parseAuthRequest reads url.searchParams), completeAuthorization
 *     (userId 'max'), 302 back to the client. The library validates redirect_uri
 *     against the registered client; we do NOT hand-roll the redirect.
 *   - POST, wrong/missing password -> re-render the form with a GENERIC error, 401.
 *
 * NEVER log, echo, or embed the password/secret in any response or error. Every
 * value interpolated into the form is HTML-escaped (a crafted client_id/state must
 * not inject markup). Password compare is constant-time-ish (timingSafeEqual).
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { Env } from './types'
import { addressKey, clearLogin, reserveLogin } from './login-throttle'

/** Stable identity for the single human (Max) using this personal connector. */
const SINGLE_USER_ID = 'max'

/** A shorter CCM_MCP_PASSWORD is treated like a missing one: the gate stays shut. */
const MIN_PASSWORD_LENGTH = 24

/** The 503 for a misconfigured or unavailable gate. Says nothing about the cause;
 *  the caller logs the detail with console.error. */
function disabledResponse(): Response {
  return htmlResponse(
    '<!doctype html><meta charset="utf-8"><title>503</title>' +
      '<h1>503</h1><p>authorization disabled, check Worker configuration</p>',
    503,
  )
}

/** Env as seen here: the OAuthProvider injects OAUTH_PROVIDER before defaultHandler. */
export type AuthGateEnv = Env & { OAUTH_PROVIDER: OAuthHelpers }

/**
 * Default redirect-origin allowlist. An OAuth auth code may ONLY ever be returned
 * to one of these origins — never an attacker-controlled URL (the phishing hole:
 * open client registration + a generic login form would let an attacker register
 * `redirect_uri:https://evil/cb`, send Max a crafted /authorize link, and launder
 * the code to their address). Widen via CCM_ALLOWED_REDIRECT_ORIGINS only if your
 * Claude client uses another origin.
 */
const DEFAULT_ALLOWED_REDIRECT_ORIGINS = 'https://claude.ai,https://claude.com'

/** The origin (scheme://host[:port]) of a URL, lowercased; undefined if unparseable. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return undefined
  }
}

/** Parse CCM_ALLOWED_REDIRECT_ORIGINS (comma-separated) into a Set of origins.
 *  Only http(s) origins are admitted: an opaque scheme (`javascript:`, `data:`,
 *  `file:`) has the literal origin "null", which would otherwise let an attacker's
 *  `data:`/`javascript:` redirect (also origin "null") MATCH the allowlist (review
 *  H1). We drop "null" and any non-http(s) origin. */
export function parseAllowedOrigins(env: { CCM_ALLOWED_REDIRECT_ORIGINS?: string }): Set<string> {
  const raw = env.CCM_ALLOWED_REDIRECT_ORIGINS ?? DEFAULT_ALLOWED_REDIRECT_ORIGINS
  const out = new Set<string>()
  for (const entry of raw.split(',')) {
    const o = originOf(entry.trim())
    if (o && o !== 'null' && (o.startsWith('https://') || o.startsWith('http://'))) out.add(o)
  }
  return out
}

/** True if `redirectUri`'s origin is on the allowlist. */
export function isAllowedRedirect(redirectUri: string, allowed: Set<string>): boolean {
  const o = originOf(redirectUri)
  return o !== undefined && allowed.has(o)
}

/**
 * True iff `redirectUri` is an http(s) LOOPBACK redirect — `127.0.0.1`, `::1`, or
 * `localhost`, ANY port (RFC 8252 native-app/CLI flow: Claude Code CLI / Hermes /
 * Codex use `http://127.0.0.1:<port>/callback`). Phishing-safe: a code sent to a
 * loopback address is delivered to a server on the END USER's own machine, so a
 * remote phisher can't receive it — and the password gate still authenticates the
 * human. We compare the EXACT hostname (never a substring), so
 * `127.0.0.1.evil.com` / `localhost.evil.com` are FALSE, and `0.0.0.0` /
 * link-local `169.254.x` are NOT loopback.
 */
export function isLoopbackRedirect(redirectUri: string): boolean {
  let u: URL
  try {
    u = new URL(redirectUri)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]") — strip them.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** A redirect is PERMITTED if its origin is on the allowlist OR it is a loopback
 *  (local-client) redirect. Used by registration + the authorize belt-and-braces. */
function isPermittedRedirect(redirectUri: string, allowed: Set<string>): boolean {
  return isAllowedRedirect(redirectUri, allowed) || isLoopbackRedirect(redirectUri)
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * PRIMARY anti-phishing fix: gate dynamic client registration (POST /register) so
 * a client whose redirect_uri origin is off-allowlist can NEVER be registered.
 * Returns a 400 Response to BLOCK, or undefined to pass the request through to the
 * provider's own registration handler. (The provider handles /register itself,
 * before defaultHandler — so this runs as a wrapper in index.ts that inspects a
 * CLONE of the request and leaves the original body intact for the provider.)
 */
export async function guardClientRegistration(
  request: Request,
  env: { CCM_ALLOWED_REDIRECT_ORIGINS?: string },
): Promise<Response | undefined> {
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    // Malformed/no JSON — let the provider return its own 400 (don't mask it).
    return undefined
  }
  const uris = (body as { redirect_uris?: unknown })?.redirect_uris
  if (!Array.isArray(uris)) {
    // No redirect_uris — the provider will reject (>=1 required); pass through.
    return undefined
  }
  const allowed = parseAllowedOrigins(env)
  for (const u of uris) {
    // Permit allowlisted origins (claude.ai/claude.com) AND loopback redirects
    // (local CLI clients: http://127.0.0.1:<port>/callback). Any other remote
    // origin is still rejected (anti-phishing).
    if (typeof u !== 'string' || !isPermittedRedirect(u, allowed)) {
      return jsonResponse(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri must be an allowlisted origin or a loopback (127.0.0.1/localhost/::1) address',
        },
        400,
      )
    }
  }
  return undefined // all redirect_uris permitted -> let the provider register
}

/** Minimal shape of the OAuthProvider we delegate to (DI seam for testing). */
interface ProviderFetch {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> | Response
}

/**
 * Build the exported Worker `fetch` that WRAPS the OAuthProvider: it gates
 * `POST <registerEndpoint>` through guardClientRegistration BEFORE delegating, and
 * forwards everything else (authorize/token/api/tunnel/health) straight to the
 * provider with `(request, env, ctx)` intact. Extracted as a DI factory so it can
 * be unit-tested with a stub provider (importing index.ts is impossible in the
 * node test env — it pulls in `cloudflare:`-scheme modules via agents/mcp).
 *
 * `registerEndpoint` is passed in (shared with the OAuthProvider config) so the
 * guard path and the provider's registration path can never drift apart (H2).
 */
export function createRegistrationGuardedFetch(provider: ProviderFetch, registerEndpoint: string) {
  return (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response => {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === registerEndpoint) {
      return guardClientRegistration(request, env).then(
        (blocked) => blocked ?? provider.fetch(request, env, ctx),
      )
    }
    return provider.fetch(request, env, ctx)
  }
}

/** Constant-time-ish string compare (length-leaking is acceptable for this MVP). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Escape a string for safe interpolation into HTML text AND double-quoted
 *  attribute values. Order matters: ampersand first. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Consent details shown ON the login form so Max sees WHO/WHERE he is authorizing
 *  before typing the password (defense in depth — review: consent visibility). */
interface Consent {
  clientId: string
  clientName?: string
  clientUri?: string
  redirectUri: string
  /** redirect classification → drives the consent message (3 buckets):
   *  'allowlist' = recognized Claude origin; 'loopback' = local client on this
   *  machine; 'other' = remote off-allowlist (RED do-not-continue warning). */
  redirectKind: 'allowlist' | 'loopback' | 'other'
}

/** Best-effort consent details: client name/uri from lookupClient + the redirect. */
async function buildConsent(
  env: AuthGateEnv,
  clientId: string,
  redirectUri: string,
): Promise<Consent | undefined> {
  if (!clientId && !redirectUri) return undefined
  let clientName: string | undefined
  let clientUri: string | undefined
  try {
    const info = clientId ? await env.OAUTH_PROVIDER.lookupClient(clientId) : null
    if (info) {
      clientName = info.clientName
      clientUri = info.clientUri
    }
  } catch {
    /* lookup is best-effort; fall back to showing just the id + redirect */
  }
  let redirectKind: Consent['redirectKind'] = 'other'
  if (redirectUri) {
    if (isAllowedRedirect(redirectUri, parseAllowedOrigins(env))) redirectKind = 'allowlist'
    else if (isLoopbackRedirect(redirectUri)) redirectKind = 'loopback'
  }
  return { clientId, clientName, clientUri, redirectUri, redirectKind }
}

/** Render the (fully ESCAPED) consent block, with a per-bucket message. */
function renderConsent(c: Consent): string {
  const who = c.clientName ? `${htmlEscape(c.clientName)} (${htmlEscape(c.clientId)})` : htmlEscape(c.clientId || 'unknown client')
  const uri = c.clientUri ? ` · ${htmlEscape(c.clientUri)}` : ''
  let note: string
  if (c.redirectKind === 'allowlist') {
    note = `    <p class="hint">Recognized Claude client.</p>\n`
  } else if (c.redirectKind === 'loopback') {
    note = `    <p class="hint">Local client on this machine (<code>${htmlEscape(c.redirectUri)}</code>).</p>\n`
  } else {
    note = `    <p class="err">⚠ This redirect target is NOT on the allowlist — do NOT continue.</p>\n`
  }
  return (
    `    <p class="consent">You are authorizing: <strong>${who}</strong>${uri}<br>` +
    `→ <code>${htmlEscape(c.redirectUri || '(none)')}</code><br>` +
    `Only continue if this is your real Claude client (claude.ai) or a local client you started.</p>\n` +
    note
  )
}

/** Render the interstitial login form. `params` (the original OAuth params) are
 *  emitted as ESCAPED hidden inputs so a correct POST can resume the flow. The
 *  consent block shows WHO/WHERE is being authorized (escaped). */
function renderLoginForm(
  params: [string, string][],
  opts: { error?: string; consent?: Consent } = {},
): string {
  const hidden = params
    .map(([k, v]) => `    <input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`)
    .join('\n')
  const consentBlock = opts.consent ? renderConsent(opts.consent) : ''
  const errorBlock = opts.error ? `    <p class="err">${htmlEscape(opts.error)}</p>\n` : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>cloud-code-mcp · sign in</title>
  <style>
    body { font: 15px system-ui, sans-serif; max-width: 26rem; margin: 12vh auto; padding: 0 1rem; }
    h1 { font-size: 1.1rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: .55rem; font-size: 1rem; }
    button { margin-top: .75rem; padding: .55rem 1rem; font-size: 1rem; }
    .err { color: #b00020; }
    .hint { color: #666; font-size: .85rem; }
    .consent { background: #f5f5f5; padding: .6rem .75rem; border-radius: 6px; font-size: .9rem; word-break: break-all; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <h1>Authorize cloud-code-mcp</h1>
  <p class="hint">This connector can drive terminals on Max's Mac. Enter the connector password to continue.</p>
${consentBlock}  <form method="POST" action="/authorize" autocomplete="off">
${hidden}
${errorBlock}    <input type="password" name="password" placeholder="Password" autofocus required aria-label="Connector password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`
}

/**
 * The /authorize password gate. Replaces the former auto-approve. Exported so it
 * can be unit-tested with a mocked env.OAUTH_PROVIDER (no live OAuthProvider).
 */
export async function handleAuthorize(request: Request, env: AuthGateEnv): Promise<Response> {
  const secret = env.CCM_MCP_PASSWORD

  // 1. FAIL CLOSED when the secret is not configured — never auto-approve.
  if (!secret) {
    return htmlResponse(
      '<!doctype html><meta charset="utf-8"><title>503</title>' +
        '<h1>503 — authorization disabled</h1>' +
        '<p>CCM_MCP_PASSWORD is not set on this Worker — refusing to authorize. ' +
        'Set it with <code>wrangler secret put CCM_MCP_PASSWORD</code>.</p>',
      503,
    )
  }
  if (secret.length < MIN_PASSWORD_LENGTH) {
    console.error(`[auth-gate] CCM_MCP_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters, refusing to authorize`)
    return disabledResponse()
  }

  // 2. GET -> render the login form, preserving ALL original OAuth params, and
  // SHOWING who/where is being authorized (consent visibility — defense in depth).
  if (request.method === 'GET') {
    const url = new URL(request.url)
    const params = [...url.searchParams.entries()].filter(([k]) => k !== 'password')
    const consent = await buildConsent(
      env,
      url.searchParams.get('client_id') ?? '',
      url.searchParams.get('redirect_uri') ?? '',
    )
    return htmlResponse(renderLoginForm(params, { consent }), 200)
  }

  if (request.method === 'POST') {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return htmlResponse(renderLoginForm([], { error: 'invalid form submission' }), 400)
    }
    const submitted = String(form.get('password') ?? '')
    // Preserve every non-password field as the OAuth params to resume with.
    const params: [string, string][] = []
    for (const [k, v] of form.entries()) {
      if (k === 'password') continue
      params.push([k, String(v)])
    }
    const get = (k: string) => params.find(([pk]) => pk === k)?.[1] ?? ''

    // Count this attempt BEFORE the password is looked at. Over the limit -> 429,
    // the same answer whether or not the password was right. Any throttle failure
    // fails closed (503): an unthrottled compare must never happen.
    const throttleKey = addressKey(request.headers.get('cf-connecting-ip'))
    let reserved
    try {
      reserved = await reserveLogin(env.LOGIN_THROTTLE, throttleKey)
    } catch (err) {
      console.error('[auth-gate] login throttle unavailable, refusing to authorize:', err)
      return disabledResponse()
    }
    if (!reserved.allowed) {
      const consent = await buildConsent(env, get('client_id'), get('redirect_uri'))
      const res = htmlResponse(
        renderLoginForm(params, { error: 'too many attempts, try again later', consent }),
        429,
      )
      res.headers.set('retry-after', String(reserved.retryAfterSec))
      return res
    }

    // More than one password field (e.g. one smuggled in through the URL) is
    // refused before any compare; the attempt above stays counted.
    if (form.getAll('password').length > 1) {
      return htmlResponse(renderLoginForm([], { error: 'invalid form submission' }), 400)
    }

    // 4. Wrong/missing password -> generic error, 401, NO completeAuthorization.
    if (!submitted || !timingSafeEqual(submitted, secret)) {
      const consent = await buildConsent(env, get('client_id'), get('redirect_uri'))
      return htmlResponse(renderLoginForm(params, { error: 'incorrect password', consent }), 401)
    }

    // Correct password: forget this address's count and give back its global count.
    try {
      await clearLogin(env.LOGIN_THROTTLE, throttleKey)
    } catch (err) {
      console.error('[auth-gate] login throttle unavailable, refusing to authorize:', err)
      return disabledResponse()
    }

    // 3. Correct password -> rebuild a Request carrying the original params as the
    // QUERY STRING (parseAuthRequest only reads url.searchParams), then let the
    // library parse + validate (incl. redirect_uri against the registered client)
    // and complete the grant. We never construct the redirect ourselves.
    const url = new URL(request.url)
    url.search = ''
    for (const [k, v] of params) url.searchParams.append(k, v)
    const rebuilt = new Request(url.toString(), { method: 'GET' })

    let oauthReq
    try {
      oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(rebuilt)
    } catch {
      // Malformed OAuth request / invalid redirect_uri — do NOT complete.
      return htmlResponse(
        '<!doctype html><meta charset="utf-8"><title>400</title>' +
          '<h1>400 — invalid authorization request</h1>',
        400,
      )
    }
    // Defensive: a real authorize must carry a client + redirect. Refuse to mint a
    // grant for an empty/garbage request (e.g. /authorize hit with no OAuth context).
    if (!oauthReq.clientId || !oauthReq.redirectUri) {
      return htmlResponse(
        '<!doctype html><meta charset="utf-8"><title>400</title>' +
          '<h1>400 — missing client_id / redirect_uri</h1>',
        400,
      )
    }

    // BELT-AND-BRACES anti-phishing (even if registration were ever misconfigured):
    // (a) the client MUST be registered — parseAuthRequest SKIPS its redirect_uri
    //     check for an unknown client, so an unknown client_id must be refused here;
    // (b) the resolved redirect_uri origin MUST be on the allowlist. Either failure
    //     => 400, and we NEVER completeAuthorization (no code is ever minted to an
    //     off-allowlist / attacker address).
    let client
    try {
      client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId)
    } catch {
      client = null
    }
    if (!client) {
      return htmlResponse(
        '<!doctype html><meta charset="utf-8"><title>400</title>' +
          '<h1>400 — unknown client</h1>',
        400,
      )
    }
    if (!isPermittedRedirect(oauthReq.redirectUri, parseAllowedOrigins(env))) {
      return htmlResponse(
        '<!doctype html><meta charset="utf-8"><title>400</title>' +
          '<h1>400 — redirect_uri not allowed</h1>',
        400,
      )
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: SINGLE_USER_ID,
      metadata: {},
      scope: oauthReq.scope,
      props: { userId: SINGLE_USER_ID },
    })
    return Response.redirect(redirectTo, 302)
  }

  return new Response('method not allowed', { status: 405 })
}
