/**
 * login-throttle.test.ts — password-guess limiting on the /authorize gate.
 *
 * Hermetic: the counting class runs over a Map and an injected clock, and the
 * gate reaches it through a fake Durable Object namespace that speaks the same
 * fetch protocol as the real LoginThrottleDO. Row letters match the unit brief.
 */

import { describe, it, expect, vi } from 'vitest'
import { handleAuthorize, type AuthGateEnv } from '../src/auth-gate.ts'

// Loaded per test (not at file top) so a missing module fails each row by name.
const load = () => import('../src/login-throttle.ts')

const PASSWORD = 'correct-horse-battery-staple'
const MIN = 60_000

async function makeGate() {
  const { LoginThrottle, throttleFetch } = await load()
  const clock = { now: 1_000_000 }
  const throttle = new LoginThrottle(new Map(), () => clock.now)
  const completeAuthorization = vi.fn(async (_opts: unknown) => ({
    redirectTo: 'https://claude.ai/callback?code=THE_CODE&state=xyz',
  }))
  const env = {
    CCM_MCP_PASSWORD: PASSWORD,
    LOGIN_THROTTLE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (url: string, init?: RequestInit) => throttleFetch(throttle, new Request(url, init)),
      }),
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        responseType: 'code',
        clientId: 'client-1',
        redirectUri: 'https://claude.ai/callback',
        scope: ['mcp'],
        state: 'xyz',
      }),
      completeAuthorization,
      lookupClient: async () => ({ clientId: 'client-1', redirectUris: ['https://claude.ai/callback'] }),
    },
  } as unknown as AuthGateEnv
  const post = (ip: string | undefined, password: string) =>
    handleAuthorize(
      new Request('https://worker.example/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(ip ? { 'cf-connecting-ip': ip } : {}),
        },
        body: new URLSearchParams({
          password,
          response_type: 'code',
          client_id: 'client-1',
          redirect_uri: 'https://claude.ai/callback',
        }).toString(),
      }),
      env,
    )
  return { post, clock, throttle, completeAuthorization }
}

async function expectBlocked(res: Response) {
  expect(res.status).toBe(429)
  const retry = Number(res.headers.get('retry-after'))
  expect(retry).toBeGreaterThan(0)
  const html = await res.text()
  expect(html).toContain('too many attempts, try again later')
  expect(html).toContain('type="password"') // the normal login form
}

describe('login throttle — the /authorize gate', () => {
  it('a) 5 wrong guesses from one address, then the 6th gets 429 + Retry-After even with the correct password', async () => {
    const { post, completeAuthorization } = await makeGate()
    for (let i = 0; i < 5; i++) expect((await post('203.0.113.7', 'nope')).status).toBe(401)
    const res = await post('203.0.113.7', PASSWORD)
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(15 * 60)
    await expectBlocked(res)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('b) while address A is locked, the correct password from address B succeeds', async () => {
    const { post, completeAuthorization } = await makeGate()
    for (let i = 0; i < 6; i++) await post('203.0.113.7', 'nope')
    const res = await post('198.51.100.9', PASSWORD)
    expect(res.status).toBe(302)
    expect(completeAuthorization).toHaveBeenCalledTimes(1)
  })

  it('c) 50 failures across distinct addresses, then a new address gets 429', async () => {
    const { post, completeAuthorization } = await makeGate()
    for (let i = 0; i < 50; i++) expect((await post(`10.0.0.${i}`, 'nope')).status).toBe(401)
    const res = await post('10.9.9.9', PASSWORD)
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(60 * 60)
    await expectBlocked(res)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('d) 6 concurrent wrong guesses from one address: at most 5 reach the password compare', async () => {
    const { post } = await makeGate()
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => post('203.0.113.7', 'nope')))).map(
      (r) => r.status,
    )
    // 401 = the guess was compared; 429 = turned away before the compare.
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(1)
  })

  it('e) success clears only that address and gives back one global count', async () => {
    const { post, throttle } = await makeGate()
    // Address part, through the gate: A and B each fail 4 times, then A succeeds.
    for (let i = 0; i < 4; i++) await post('203.0.113.7', 'nope')
    for (let i = 0; i < 4; i++) await post('198.51.100.9', 'nope')
    expect((await post('203.0.113.7', PASSWORD)).status).toBe(302)
    // A starts over: 5 more guesses are compared before it locks.
    for (let i = 0; i < 5; i++) expect((await post('203.0.113.7', 'nope')).status).toBe(401)
    expect((await post('203.0.113.7', 'nope')).status).toBe(429)
    // B was not cleared: one guess left, then locked.
    expect((await post('198.51.100.9', 'nope')).status).toBe(401)
    expect((await post('198.51.100.9', 'nope')).status).toBe(429)

    // Global part, on the counting class: 14 counted so far (4+4+1-1+5+1).
    for (let i = 0; i < 36; i++) expect(throttle.reserve(`fill-${i}`).allowed).toBe(true) // 50
    expect(throttle.reserve('late').allowed).toBe(false)
    throttle.clear('fill-0') // gives back exactly one
    expect(throttle.reserve('late').allowed).toBe(true)
    expect(throttle.reserve('later').allowed).toBe(false)
  })

  it('h) two IPv6 addresses in the same /64 share one count', async () => {
    const { addressKey } = await load()
    expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:0DB8:0001:0002:ffff:0:0:9'))
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'))
    expect(addressKey('::1')).toBe(addressKey('0:0:0:0:8:8:8:8'))
    // '::' inside the first four groups: the groups after it still belong to the /64.
    expect(addressKey('2001::1:a:b:c:d')).toBe(addressKey('2001:0:0:1::5'))
    expect(addressKey('2001::1:a:b:c:d')).not.toBe(addressKey('2001::2:a:b:c:d'))
    expect(addressKey('::ffff:192.0.2.1')).toBe('0:0:0:0')
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7') // IPv4: the whole address
    expect(addressKey('203.0.113.7')).not.toBe(addressKey('203.0.113.8'))
    expect(addressKey(null)).toBe('unknown')

    const { post, completeAuthorization } = await makeGate()
    for (let i = 0; i < 5; i++) await post('2001:db8:1:2::1', 'nope')
    await expectBlocked(await post('2001:0db8:0001:0002:ffff::9', PASSWORD))
    expect(completeAuthorization).not.toHaveBeenCalled()
    expect((await post('2001:db8:1:3::1', PASSWORD)).status).toBe(302) // a different /64
    // No CF-Connecting-IP header: all such requests share the key 'unknown'.
    for (let i = 0; i < 5; i++) expect((await post(undefined, 'nope')).status).toBe(401)
    expect((await post(undefined, PASSWORD)).status).toBe(429)
  })
})

describe('login throttle — the counting class', () => {
  it('i) counts expire after the window using an injected clock', async () => {
    const { LoginThrottle } = await load()
    let now = 5_000_000
    const store = new Map()
    const throttle = new LoginThrottle(store, () => now)

    // Address window: 15 minutes from the FIRST counted attempt.
    expect(throttle.reserve('A')).toEqual({ allowed: true })
    now += 10 * MIN
    for (let i = 0; i < 4; i++) expect(throttle.reserve('A')).toEqual({ allowed: true })
    expect(throttle.reserve('A')).toEqual({ allowed: false, retryAfterSec: 5 * 60 })
    now += 5 * MIN - 1
    expect(throttle.reserve('A')).toEqual({ allowed: false, retryAfterSec: 1 })
    now += 1
    expect(throttle.reserve('A')).toEqual({ allowed: true })

    // Global window: 60 minutes from its first counted attempt (6 counted so far).
    for (let i = 0; i < 44; i++) expect(throttle.reserve(`addr-${i}`).allowed).toBe(true)
    expect(throttle.reserve('fresh')).toEqual({ allowed: false, retryAfterSec: 45 * 60 })
    now += 45 * MIN - 1
    expect(throttle.reserve('fresh').allowed).toBe(false)
    now += 1
    expect(throttle.reserve('fresh')).toEqual({ allowed: true })
    // Expired rows are deleted on reserve: only 'fresh' and the global row remain.
    expect(store.size).toBe(2)
  })
})
