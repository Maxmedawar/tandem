/**
 * auth-gate.test.ts — the SECURITY-CRITICAL /authorize password gate.
 *
 * Hermetic: env.OAUTH_PROVIDER is a spy (no real OAuthProvider). Asserts the gate
 * fails closed without a secret, renders an escaped login form, rejects a wrong
 * password without completing the grant, and completes only on the correct one.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleAuthorize,
  timingSafeEqual,
  guardClientRegistration,
  createRegistrationGuardedFetch,
  parseAllowedOrigins,
  isAllowedRedirect,
  isLoopbackRedirect,
  type AuthGateEnv,
} from '../src/auth-gate.ts'

const PASSWORD = 'correct-horse-battery-staple'

function makeEnv(password: string | undefined, allowedOrigins?: string) {
  const parseAuthRequest = vi.fn(async (_request: Request) => ({
    responseType: 'code',
    clientId: 'client-1',
    redirectUri: 'https://claude.ai/callback',
    scope: ['mcp'],
    state: 'xyz',
  }))
  const completeAuthorization = vi.fn(async (_opts: { userId: string; props: { userId: string } }) => ({
    redirectTo: 'https://claude.ai/callback?code=THE_CODE&state=xyz',
  }))
  // lookupClient returns a registered claude.ai client by default (so the happy
  // path passes the belt-and-braces checks); tests override per-case.
  const lookupClient = vi.fn(
    async (
      _clientId: string,
    ): Promise<{ clientId: string; redirectUris: string[]; clientName?: string; clientUri?: string } | null> => ({
      clientId: 'client-1',
      redirectUris: ['https://claude.ai/callback'],
      clientName: 'Claude',
      clientUri: 'https://claude.ai',
    }),
  )
  const env = {
    CCM_MCP_PASSWORD: password,
    CCM_ALLOWED_REDIRECT_ORIGINS: allowedOrigins,
    OAUTH_PROVIDER: { parseAuthRequest, completeAuthorization, lookupClient },
    // Login throttle binding: always allows here (counting is in login-throttle.test.ts).
    LOGIN_THROTTLE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  } as unknown as AuthGateEnv
  return { env, parseAuthRequest, completeAuthorization, lookupClient }
}

function regReq(redirectUris: unknown): Request {
  return new Request('https://worker.example/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'x' }),
  })
}

const OAUTH_QS =
  'response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback' +
  '&scope=mcp&state=xyz&code_challenge=abc123&code_challenge_method=S256'

function getReq(qs = OAUTH_QS): Request {
  return new Request(`https://worker.example/authorize?${qs}`, { method: 'GET' })
}
function postReq(fields: Record<string, string>): Request {
  return new Request('https://worker.example/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

describe('timingSafeEqual', () => {
  it('matches equal strings, rejects differing / different-length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('handleAuthorize — fail closed', () => {
  it('no CCM_MCP_PASSWORD configured -> 503, never completes', async () => {
    const { env, completeAuthorization } = makeEnv(undefined)
    const res = await handleAuthorize(getReq(), env)
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toMatch(/CCM_MCP_PASSWORD/)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('empty-string password also fails closed', async () => {
    const { env, completeAuthorization } = makeEnv('')
    const res = await handleAuthorize(getReq(), env)
    expect(res.status).toBe(503)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })
})

describe('handleAuthorize — GET renders the login form', () => {
  it('200 HTML with a password input; no grant; original params as ESCAPED hidden fields', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(getReq(), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('type="password"')
    expect(html).toContain('name="password"')
    // every original OAuth param is preserved as a hidden input so the POST resumes
    expect(html).toContain('name="response_type"')
    expect(html).toContain('value="code"')
    expect(html).toContain('name="client_id"')
    expect(html).toContain('value="client-1"')
    expect(html).toContain('name="redirect_uri"')
    expect(html).toContain('value="https://claude.ai/callback"')
    expect(html).toContain('name="code_challenge"')
    expect(html).toContain('name="code_challenge_method"')
    // a GET never parses/completes the grant
    expect(parseAuthRequest).not.toHaveBeenCalled()
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('HTML-escapes crafted client_id / state so no markup is injected', async () => {
    const evil = '"><script>alert(1)</script>'
    const qs = `response_type=code&client_id=${encodeURIComponent(evil)}&redirect_uri=https%3A%2F%2Fc%2Fcb&state=${encodeURIComponent(evil)}`
    const { env } = makeEnv(PASSWORD)
    const res = await handleAuthorize(getReq(qs), env)
    const html = await res.text()
    // the raw injection string must NOT appear; the escaped form must
    expect(html).not.toContain('"><script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;&gt;') // the leading "> escaped
  })
})

describe('handleAuthorize — POST', () => {
  it('wrong password -> 401, generic error, NO completeAuthorization', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(
      postReq({ password: 'nope', response_type: 'code', client_id: 'client-1', redirect_uri: 'https://claude.ai/callback', state: 'xyz', scope: 'mcp' }),
      env,
    )
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain('incorrect password')
    expect(html).toContain('type="password"') // form re-rendered
    expect(parseAuthRequest).not.toHaveBeenCalled()
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('missing password field -> 401, NO completeAuthorization', async () => {
    const { env, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(
      postReq({ response_type: 'code', client_id: 'client-1', redirect_uri: 'https://claude.ai/callback' }),
      env,
    )
    expect(res.status).toBe(401)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('correct password -> parseAuthRequest + completeAuthorization(userId max) once, 302', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(
      postReq({
        password: PASSWORD,
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: 'https://claude.ai/callback',
        scope: 'mcp',
        state: 'xyz',
        code_challenge: 'abc123',
        code_challenge_method: 'S256',
      }),
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://claude.ai/callback?code=THE_CODE&state=xyz')
    expect(parseAuthRequest).toHaveBeenCalledTimes(1)
    expect(completeAuthorization).toHaveBeenCalledTimes(1)
    const arg = completeAuthorization.mock.calls[0][0] as { userId: string; props: { userId: string } }
    expect(arg.userId).toBe('max')
    expect(arg.props.userId).toBe('max')

    // The rebuilt request passed to parseAuthRequest carries the OAuth params as the
    // QUERY STRING (and NOT the password).
    const passed = parseAuthRequest.mock.calls[0][0] as Request
    const passedUrl = new URL(passed.url)
    expect(passedUrl.searchParams.get('client_id')).toBe('client-1')
    expect(passedUrl.searchParams.get('code_challenge')).toBe('abc123')
    expect(passedUrl.searchParams.get('password')).toBeNull()
  })

  it('correct password but the request has no client_id/redirect_uri -> 400, no grant', async () => {
    const { env, completeAuthorization } = makeEnv(PASSWORD)
    // parseAuthRequest returns an empty request (e.g. /authorize hit with no OAuth context).
    ;(env.OAUTH_PROVIDER.parseAuthRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      responseType: '',
      clientId: '',
      redirectUri: '',
      scope: [],
      state: '',
    })
    const res = await handleAuthorize(postReq({ password: PASSWORD }), env)
    expect(res.status).toBe(400)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })
})

// ── allowlist helpers ────────────────────────────────────────────────────────

describe('redirect-origin allowlist helpers', () => {
  it('parseAllowedOrigins defaults to claude.ai + claude.com, normalizes to origins', () => {
    const s = parseAllowedOrigins({})
    expect(s.has('https://claude.ai')).toBe(true)
    expect(s.has('https://claude.com')).toBe(true)
  })
  it('parseAllowedOrigins parses a custom comma list', () => {
    const s = parseAllowedOrigins({ CCM_ALLOWED_REDIRECT_ORIGINS: 'https://a.example, https://b.example/path' })
    expect(s.has('https://a.example')).toBe(true)
    expect(s.has('https://b.example')).toBe(true) // path stripped to origin
    expect(s.has('https://claude.ai')).toBe(false)
  })
  it('isAllowedRedirect matches by origin, rejects off-allowlist + junk', () => {
    const allowed = parseAllowedOrigins({})
    expect(isAllowedRedirect('https://claude.ai/callback?x=1', allowed)).toBe(true)
    expect(isAllowedRedirect('https://evil.example/cb', allowed)).toBe(false)
    expect(isAllowedRedirect('not a url', allowed)).toBe(false)
    // a look-alike host is a different origin
    expect(isAllowedRedirect('https://claude.ai.evil.example/cb', allowed)).toBe(false)
  })
})

// ── PRIMARY FIX: client registration is allowlist-gated ──────────────────────

describe('guardClientRegistration (POST /register)', () => {
  it('BLOCKS an off-allowlist redirect origin with 400 invalid_redirect_uri', async () => {
    const res = await guardClientRegistration(regReq(['https://evil.example/cb']), {})
    expect(res).toBeDefined()
    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error?: string }
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('BLOCKS when ANY of several redirect_uris is off-allowlist', async () => {
    const res = await guardClientRegistration(
      regReq(['https://claude.ai/cb', 'https://evil.example/cb']),
      {},
    )
    expect(res?.status).toBe(400)
  })

  it('ALLOWS (passes through, undefined) when all redirect_uris are on-allowlist', async () => {
    const res = await guardClientRegistration(regReq(['https://claude.ai/callback']), {})
    expect(res).toBeUndefined()
  })

  it('leaves the request body intact for the provider (reads a clone)', async () => {
    const req = regReq(['https://claude.ai/callback'])
    await guardClientRegistration(req, {})
    // original body still readable downstream (provider re-reads it)
    const body = (await req.json()) as { redirect_uris: string[] }
    expect(body.redirect_uris).toEqual(['https://claude.ai/callback'])
  })

  it('honors a custom allowlist', async () => {
    const ok = await guardClientRegistration(regReq(['https://myclient.example/cb']), {
      CCM_ALLOWED_REDIRECT_ORIGINS: 'https://myclient.example',
    })
    expect(ok).toBeUndefined()
    const blocked = await guardClientRegistration(regReq(['https://claude.ai/cb']), {
      CCM_ALLOWED_REDIRECT_ORIGINS: 'https://myclient.example',
    })
    expect(blocked?.status).toBe(400)
  })
})

// ── BELT-AND-BRACES: authorize rejects unknown client / off-allowlist redirect ─

describe('handleAuthorize — anti-phishing belt-and-braces', () => {
  const goodPost = {
    password: PASSWORD,
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: 'https://claude.ai/callback',
    scope: 'mcp',
    state: 'xyz',
  }

  it('unknown client (lookupClient null) -> 400, no grant (even with correct password)', async () => {
    const { env, lookupClient, completeAuthorization } = makeEnv(PASSWORD)
    lookupClient.mockResolvedValueOnce(null)
    const res = await handleAuthorize(postReq(goodPost), env)
    expect(res.status).toBe(400)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('off-allowlist resolved redirect_uri -> 400, no grant (even with correct password)', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    // a registered client, but the resolved redirect points off-allowlist
    parseAuthRequest.mockResolvedValueOnce({
      responseType: 'code',
      clientId: 'client-1',
      redirectUri: 'https://evil.example/cb',
      scope: ['mcp'],
      state: 'xyz',
    })
    const res = await handleAuthorize(
      postReq({ ...goodPost, redirect_uri: 'https://evil.example/cb' }),
      env,
    )
    expect(res.status).toBe(400)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('known client + on-allowlist redirect + correct password -> 302 grant', async () => {
    const { env, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(postReq(goodPost), env)
    expect(res.status).toBe(302)
    expect(completeAuthorization).toHaveBeenCalledTimes(1)
  })
})

// ── consent visibility on the login form ─────────────────────────────────────

describe('handleAuthorize — consent visibility', () => {
  it('GET form shows the (escaped) client_id and redirect_uri being authorized', async () => {
    const { env } = makeEnv(PASSWORD)
    const res = await handleAuthorize(getReq(), env)
    const html = await res.text()
    expect(html).toContain('You are authorizing')
    expect(html).toContain('https://claude.ai/callback') // the redirect target shown
    expect(html).toContain('client-1')
  })

  it('GET form HTML-escapes a crafted off-allowlist redirect_uri (no markup injection)', async () => {
    const evil = 'https://evil.example/cb"><script>alert(1)</script>'
    const qs = `response_type=code&client_id=client-1&redirect_uri=${encodeURIComponent(evil)}&state=s`
    const { env, lookupClient } = makeEnv(PASSWORD)
    lookupClient.mockResolvedValueOnce(null) // unknown client -> no name lookup
    const res = await handleAuthorize(getReq(qs), env)
    const html = await res.text()
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&lt;script&gt;')
    // and it warns that this redirect is not on the allowlist
    expect(html).toContain('NOT on the allowlist')
  })
})

// ── H1: opaque / non-http(s) origins must not enter the allowlist ────────────

describe('parseAllowedOrigins — opaque scheme rejection (H1)', () => {
  it('drops javascript:/data:/file: entries (origin "null"), keeps http(s)', () => {
    const set = parseAllowedOrigins({
      CCM_ALLOWED_REDIRECT_ORIGINS: 'javascript:alert(1),data:text/html,x,file:///etc,https://claude.ai',
    })
    expect(set.has('null')).toBe(false)
    expect(set.has('https://claude.ai')).toBe(true)
    expect(set.size).toBe(1)
  })
  it('an opaque-scheme redirect can never match (no "null" in the set)', () => {
    const set = parseAllowedOrigins({ CCM_ALLOWED_REDIRECT_ORIGINS: 'javascript:alert(1),https://claude.ai' })
    expect(isAllowedRedirect('data:text/html,x', set)).toBe(false)
    expect(isAllowedRedirect('javascript:alert(1)', set)).toBe(false)
  })
})

// ── H3: the exported wrapper (DI factory) end-to-end ─────────────────────────

describe('createRegistrationGuardedFetch (export-wrapper E2E)', () => {
  function stub() {
    const fetch = vi.fn(
      async (_req: Request, _env: unknown, _ctx: ExecutionContext) => new Response('provider-ok', { status: 200 }),
    )
    return { provider: { fetch }, fetch }
  }
  const CTX = { sentinel: true } as unknown as ExecutionContext
  const ENV = {} as never // CCM_ALLOWED_REDIRECT_ORIGINS undefined -> default allowlist

  it('(a) POST /register off-allowlist -> 400 from the wrapper; provider.fetch NOT called', async () => {
    const { provider, fetch } = stub()
    const handler = createRegistrationGuardedFetch(provider, '/register')
    const res = await handler(regReq(['https://evil.example/cb']), ENV, CTX)
    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('(b) POST /register on-allowlist -> provider.fetch once with the ORIGINAL request, body still readable', async () => {
    const { provider, fetch } = stub()
    const handler = createRegistrationGuardedFetch(provider, '/register')
    const req = regReq(['https://claude.ai/cb'])
    const res = await handler(req, ENV, CTX)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(req) // original request forwarded (not a clone)
    expect(await res.text()).toBe('provider-ok')
    // the guard read a CLONE, so the original body is still consumable downstream
    const body = (await req.json()) as { redirect_uris: string[] }
    expect(body.redirect_uris).toEqual(['https://claude.ai/cb'])
  })

  it('(c) a non-/register route delegates to provider.fetch with (request, env, ctx) forwarded', async () => {
    const { provider, fetch } = stub()
    const handler = createRegistrationGuardedFetch(provider, '/register')
    const req = new Request('https://worker.example/', { method: 'GET' })
    const res = await handler(req, ENV, CTX)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(req)
    expect(fetch.mock.calls[0][1]).toBe(ENV)
    expect(fetch.mock.calls[0][2]).toBe(CTX) // ctx passed through
    expect(await res.text()).toBe('provider-ok')
  })

  it('(c2) POST /token (non-register) also delegates (guard is /register-only)', async () => {
    const { provider, fetch } = stub()
    const handler = createRegistrationGuardedFetch(provider, '/register')
    await handler(new Request('https://worker.example/token', { method: 'POST', body: 'x' }), ENV, CTX)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('GET /register (not POST) delegates — the guard only fires on POST', async () => {
    const { provider, fetch } = stub()
    const handler = createRegistrationGuardedFetch(provider, '/register')
    await handler(new Request('https://worker.example/register', { method: 'GET' }), ENV, CTX)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// ── loopback redirect support (local MCP clients — Claude Code CLI / Hermes / Codex) ──

describe('isLoopbackRedirect', () => {
  it('TRUE for http(s) loopback hosts, any port', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:51365/callback')).toBe(true)
    expect(isLoopbackRedirect('http://localhost:8976/cb')).toBe(true)
    expect(isLoopbackRedirect('http://[::1]:5000/cb')).toBe(true)
    expect(isLoopbackRedirect('https://127.0.0.1:9000/cb')).toBe(true)
  })
  it('FALSE for look-alike hosts, 0.0.0.0, link-local, and junk (exact-hostname match)', () => {
    expect(isLoopbackRedirect('http://127.0.0.1.evil.com/cb')).toBe(false)
    expect(isLoopbackRedirect('http://localhost.evil.com/cb')).toBe(false)
    expect(isLoopbackRedirect('http://0.0.0.0:1/cb')).toBe(false)
    expect(isLoopbackRedirect('https://claude.ai.evil.com/cb')).toBe(false)
    expect(isLoopbackRedirect('http://169.254.1.1/cb')).toBe(false)
    expect(isLoopbackRedirect('not a url')).toBe(false)
    expect(isLoopbackRedirect('ftp://127.0.0.1/cb')).toBe(false) // wrong scheme
  })
})

describe('registration permits loopback, still blocks remote off-allowlist', () => {
  it('a loopback-only redirect PASSES the guard (delegates to provider)', async () => {
    expect(await guardClientRegistration(regReq(['http://127.0.0.1:51365/callback']), {})).toBeUndefined()
    expect(await guardClientRegistration(regReq(['http://localhost:8976/cb']), {})).toBeUndefined()
  })
  it('loopback + an evil-remote redirect is STILL rejected (any off-allowlist non-loopback fails)', async () => {
    const res = await guardClientRegistration(
      regReq(['http://127.0.0.1:51365/callback', 'https://evil.example/cb']),
      {},
    )
    expect(res?.status).toBe(400)
  })
  it('a pure evil-remote redirect is STILL rejected', async () => {
    const res = await guardClientRegistration(regReq(['https://evil.example/cb']), {})
    expect(res?.status).toBe(400)
  })
})

describe('authorize accepts loopback (with password), warns only on remote off-allowlist', () => {
  const loopbackPost = {
    password: PASSWORD,
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: 'http://127.0.0.1:51365/callback',
    scope: 'mcp',
    state: 'xyz',
  }

  it('loopback redirect + correct password -> completeAuthorization called, 302 (no 400)', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    parseAuthRequest.mockResolvedValueOnce({
      responseType: 'code',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:51365/callback',
      scope: ['mcp'],
      state: 'xyz',
    })
    const res = await handleAuthorize(postReq(loopbackPost), env)
    expect(res.status).toBe(302)
    expect(completeAuthorization).toHaveBeenCalledTimes(1)
  })

  it('password STILL required for loopback (no password -> 401, no completeAuthorization)', async () => {
    const { env, completeAuthorization } = makeEnv(PASSWORD)
    const res = await handleAuthorize(postReq({ ...loopbackPost, password: 'wrong' }), env)
    expect(res.status).toBe(401)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('GET form for a loopback redirect: NO "do NOT continue" warning, DOES show the redirect', async () => {
    const qs =
      'response_type=code&client_id=client-1&redirect_uri=' +
      encodeURIComponent('http://127.0.0.1:51365/callback') +
      '&state=s'
    const { env } = makeEnv(PASSWORD)
    const html = await (await handleAuthorize(getReq(qs), env)).text()
    expect(html).not.toContain('do NOT continue')
    expect(html).not.toContain('NOT on the allowlist')
    expect(html).toContain('Local client on this machine')
    expect(html).toContain('http://127.0.0.1:51365/callback') // redirect shown
  })

  it('GET form for a remote off-allowlist redirect STILL shows the red warning', async () => {
    const qs =
      'response_type=code&client_id=client-1&redirect_uri=' + encodeURIComponent('https://evil.example/cb') + '&state=s'
    const { env, lookupClient } = makeEnv(PASSWORD)
    lookupClient.mockResolvedValueOnce(null)
    const html = await (await handleAuthorize(getReq(qs), env)).text()
    expect(html).toContain('NOT on the allowlist')
  })

  it('remote off-allowlist redirect + correct password is STILL rejected (400, no grant)', async () => {
    const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
    parseAuthRequest.mockResolvedValueOnce({
      responseType: 'code',
      clientId: 'client-1',
      redirectUri: 'https://evil.example/cb',
      scope: ['mcp'],
      state: 'xyz',
    })
    const res = await handleAuthorize(
      postReq({ ...loopbackPost, redirect_uri: 'https://evil.example/cb' }),
      env,
    )
    expect(res.status).toBe(400)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })
})

// ── login hardening: short password and throttle failure both fail closed ────

describe('handleAuthorize — login hardening', () => {
  const fields = { response_type: 'code', client_id: 'client-1', redirect_uri: 'https://claude.ai/callback' }

  it('f) CCM_MCP_PASSWORD shorter than 24 characters -> 503, grant not completed', async () => {
    const short = 'x'.repeat(23)
    const { env, completeAuthorization } = makeEnv(short)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const req of [postReq({ ...fields, password: short }), getReq()]) {
        const res = await handleAuthorize(req, env)
        expect(res.status).toBe(503)
        const body = await res.text()
        expect(body).toContain('authorization disabled, check Worker configuration')
        expect(body).not.toContain(short)
        expect(body).not.toContain('24') // the detail goes to the log, not the page
        expect(body).not.toContain('type="password"')
      }
      expect(completeAuthorization).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalled()
      expect(JSON.stringify(errors.mock.calls)).not.toContain(short)
    } finally {
      errors.mockRestore()
    }
    // exactly 24 characters is accepted
    const ok = makeEnv('y'.repeat(24))
    expect((await handleAuthorize(postReq({ ...fields, password: 'y'.repeat(24) }), ok.env)).status).toBe(302)
  })

  it('g) throttle call throws -> 503, grant not completed', async () => {
    const broken: Record<string, unknown> = {
      'get() throws': { idFromName: () => 'global', get: () => { throw new Error('do down') } },
      'fetch() rejects': { idFromName: () => 'global', get: () => ({ fetch: async () => { throw new Error('do down') } }) },
      'fetch() answers 500': { idFromName: () => 'global', get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) },
      'binding missing': undefined,
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const [name, binding] of Object.entries(broken)) {
        const { env, completeAuthorization } = makeEnv(PASSWORD)
        ;(env as unknown as { LOGIN_THROTTLE: unknown }).LOGIN_THROTTLE = binding
        const res = await handleAuthorize(postReq({ ...fields, password: PASSWORD }), env)
        expect(res.status, name).toBe(503)
        expect(await res.text(), name).toContain('authorization disabled, check Worker configuration')
        expect(completeAuthorization, name).not.toHaveBeenCalled()
        // A wrong guess must also get 503, never an unthrottled compare (401).
        const wrong = await handleAuthorize(postReq({ ...fields, password: 'nope' }), env)
        expect(wrong.status, `${name}, wrong password`).toBe(503)
      }
      // reserve works but clear fails: the correct password still gets no grant.
      const { env, completeAuthorization } = makeEnv(PASSWORD)
      ;(env as unknown as { LOGIN_THROTTLE: unknown }).LOGIN_THROTTLE = {
        idFromName: () => 'global',
        get: () => ({
          fetch: async (url: string) =>
            url.endsWith('/reserve') ? Response.json({ allowed: true }) : new Response('boom', { status: 500 }),
        }),
      }
      const res = await handleAuthorize(postReq({ ...fields, password: PASSWORD }), env)
      expect(res.status, 'clear fails').toBe(503)
      expect(completeAuthorization, 'clear fails').not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})

// ── a password in the /authorize URL never reaches the compare ──────────────

describe('handleAuthorize — URL password is never preserved or compared', () => {
  const oauthFields = [...new URLSearchParams(OAUTH_QS)]
  function twoPasswordReq(first: string, second: string): Request {
    return new Request('https://worker.example/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['password', first], ['password', second], ...oauthFields]).toString(),
    })
  }
  function recordingThrottle(reserveAnswer: object) {
    const urls: string[] = []
    const stub = {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (url: string) => {
          urls.push(url)
          return Response.json(url.endsWith('/reserve') ? reserveAnswer : {})
        },
      }),
    }
    return { stub, urls }
  }

  it('a) GET with password in the URL -> 200, password not echoed, one password input, OAuth fields kept', async () => {
    const { env } = makeEnv(PASSWORD)
    const res = await handleAuthorize(getReq(`${OAUTH_QS}&password=${PASSWORD}`), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(PASSWORD)
    expect(body.split('name="password"').length - 1).toBe(1)
    expect(body).toContain('name="client_id" value="client-1"')
    expect(body).toContain('name="redirect_uri" value="https://claude.ai/callback"')
    expect(body).toContain('name="state" value="xyz"')
  })

  it('b) POST with two password fields -> 400, no compare, no grant', async () => {
    for (const [first, second] of [[PASSWORD, 'wrong'], ['wrong', PASSWORD], [PASSWORD, PASSWORD]]) {
      const { env, parseAuthRequest, completeAuthorization } = makeEnv(PASSWORD)
      const label = `[${first}, ${second}]`
      const res = await handleAuthorize(twoPasswordReq(first, second), env)
      expect(res.status, label).toBe(400)
      expect(parseAuthRequest, label).not.toHaveBeenCalled()
      expect(completeAuthorization, label).not.toHaveBeenCalled()
      const body = await res.text()
      expect(body, label).not.toContain(PASSWORD)
      expect(body, label).not.toContain('wrong')
    }
  })

  it('c) one password field still works: correct -> 302 with one grant, wrong -> 401', async () => {
    const ok = makeEnv(PASSWORD)
    const res = await handleAuthorize(postReq({ ...Object.fromEntries(oauthFields), password: PASSWORD }), ok.env)
    expect(res.status).toBe(302)
    expect(ok.completeAuthorization).toHaveBeenCalledTimes(1)
    const bad = makeEnv(PASSWORD)
    const wrong = await handleAuthorize(postReq({ ...Object.fromEntries(oauthFields), password: 'wrong' }), bad.env)
    expect(wrong.status).toBe(401)
    expect(bad.completeAuthorization).not.toHaveBeenCalled()
  })

  it('d) a two-password POST is counted by the limiter first and never cleared; over the limit -> 429', async () => {
    const { env } = makeEnv(PASSWORD)
    const counted = recordingThrottle({ allowed: true })
    ;(env as unknown as { LOGIN_THROTTLE: unknown }).LOGIN_THROTTLE = counted.stub
    const res = await handleAuthorize(twoPasswordReq(PASSWORD, 'wrong'), env)
    expect(res.status).toBe(400)
    expect(counted.urls.filter((u) => u.endsWith('/reserve')).length).toBe(1)
    expect(counted.urls.filter((u) => u.endsWith('/clear')).length).toBe(0)

    const limited = makeEnv(PASSWORD)
    const blocked = recordingThrottle({ allowed: false, retryAfterSec: 60 })
    ;(limited.env as unknown as { LOGIN_THROTTLE: unknown }).LOGIN_THROTTLE = blocked.stub
    const over = await handleAuthorize(twoPasswordReq(PASSWORD, 'wrong'), limited.env)
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBe('60')
  })
})
