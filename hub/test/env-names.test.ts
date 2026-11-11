/**
 * env-names.test.ts — the hub reads only TANDEM_* settings and carries no private
 * names. This is the one hub file that may hold the old CCM_ setting names, as
 * test input. Rows a) to e) match the unit brief.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { handleAuthorize, parseAllowedOrigins, type AuthGateEnv } from '../src/auth-gate.ts'
import { CCM_TUNNEL_SUBPROTOCOL } from '../src/protocol.ts'
import { EMPTY_SHA256, proofText } from '../src/devices.ts'

// mcp.ts extends McpAgent, whose package loads `cloudflare:` modules the node
// test env cannot; a plain base class stands in so the real resolveTarget runs.
vi.mock('agents/mcp', () => ({ McpAgent: class {} }))

const root = fileURLToPath(new URL('..', import.meta.url))
const BINDINGS = ['TUNNEL', 'MCP_OBJECT', 'LOGIN_THROTTLE', 'OAUTH_KV', 'OAUTH_PROVIDER']
const KEPT_IDENTIFIERS = ['CCM_FRAME_TYPES', 'CCM_TUNNEL_SUBPROTOCOL']
const DEFAULT_ORIGINS = new Set(['https://claude.ai', 'https://claude.com'])
const PASSWORD = 'p'.repeat(32)

const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const srcFiles = readdirSync(join(root, 'src')).filter(f => f.endsWith('.ts')).map(f => `src/${f}`)
const scanned = [
  ...srcFiles,
  ...readdirSync(join(root, 'test')).filter(f => f !== 'env-names.test.ts').map(f => `test/${f}`),
  'wrangler.jsonc',
  'package.json',
  'vitest.config.ts',
]

/* ---------------- a) every setting name starts with TANDEM_ ---------------- */

describe('a) setting names', () => {
  it('every env.<NAME> read in src that is not a binding starts with TANDEM_', () => {
    const reads = new Set<string>()
    for (const f of srcFiles) {
      for (const m of read(f).matchAll(/\benv\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) reads.add(m[1])
    }
    const settings = [...reads].filter(n => !BINDINGS.includes(n))
    expect(settings.length).toBeGreaterThan(0)
    expect(settings.filter(n => !n.startsWith('TANDEM_'))).toEqual([])
  })

  it('every non-binding field of Env starts with TANDEM_', () => {
    const body = read('src/types.ts').match(/export interface Env \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const fields = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(m => m[1])
    expect(fields).toEqual(expect.arrayContaining(BINDINGS.filter(b => b !== 'OAUTH_PROVIDER')))
    const settings = fields.filter(n => !BINDINGS.includes(n))
    expect(settings.sort()).toEqual(
      ['TANDEM_ALLOWED_REDIRECT_ORIGINS', 'TANDEM_DEFAULT_MACHINE', 'TANDEM_HUB_LINK_TOKEN', 'TANDEM_HUB_PASSWORD'],
    )
  })

  it('every key of wrangler.jsonc vars starts with TANDEM_, and the default machine has no value there', () => {
    // Whole-line // comments only: URLs hold // inside strings.
    const json = read('wrangler.jsonc').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    const vars = (JSON.parse(json) as { vars?: Record<string, string> }).vars ?? {}
    expect(Object.keys(vars).length).toBeGreaterThan(0)
    expect(Object.keys(vars).filter(k => !k.startsWith('TANDEM_'))).toEqual([])
    expect(vars).not.toHaveProperty('TANDEM_DEFAULT_MACHINE')
  })
})

/* ---------------- b) no old CCM_ setting name ---------------- */

describe('b) no CCM_ name', () => {
  it(`no scanned file holds CCM_[A-Z] other than ${KEPT_IDENTIFIERS.join(' and ')}`, () => {
    const hits: string[] = []
    for (const f of scanned) {
      for (const m of read(f).matchAll(/CCM_[A-Z][A-Z0-9_]*/g)) {
        if (!KEPT_IDENTIFIERS.includes(m[0])) hits.push(`${f}: ${m[0]}`)
      }
    }
    expect(hits).toEqual([])
  })
})

/* ---------------- c) no private name or text ---------------- */

describe('c) no private text', () => {
  const patterns: RegExp[] = [/\bMax\b/, /['"]max['"]/i, /macbook/i, /\bmini\b/i, /cloud-?code-?mcp/i, /anilo/i]
  for (const re of patterns) {
    it(`no scanned file matches ${re}`, () => {
      const hits: string[] = []
      for (const f of scanned) {
        read(f).split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`) })
      }
      expect(hits).toEqual([])
    })
  }
})

/* ---------------- shared fakes ---------------- */

function gateEnv(settings: Record<string, string>) {
  const completeAuthorization = vi.fn(async (_opts: { userId: string; props: { userId: string } }) => ({
    redirectTo: 'https://claude.ai/callback?code=THE_CODE&state=xyz',
  }))
  const env = {
    ...settings,
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
    LOGIN_THROTTLE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  } as unknown as AuthGateEnv
  return { env, completeAuthorization }
}

function grantRequest(): Request {
  return new Request('https://hub.example/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      password: PASSWORD,
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://claude.ai/callback',
      scope: 'mcp',
      state: 'xyz',
    }).toString(),
  })
}

/** Run the real TandemMcp.resolveTarget (no `machine`) with laptop then desktop connected. */
async function resolveWithout(settings: Record<string, string>): Promise<unknown> {
  const { TandemMcp } = (await import('../src/mcp.ts')) as unknown as { TandemMcp?: { prototype: object } }
  expect(TandemMcp, 'mcp.ts exports TandemMcp').toBeTypeOf('function')
  const agent = Object.create(TandemMcp!.prototype) as { env: unknown; resolveTarget(): Promise<unknown> }
  agent.env = {
    ...settings,
    TUNNEL: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ connected: ['laptop', 'desktop'] }) }),
    },
  }
  return agent.resolveTarget()
}

/* ---------------- local hubs (wrangler dev --local), as in url-token.test.ts ---------------- */

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise(resolve => probe.close(resolve))
  return port
}

interface Hub { port: number; child: ChildProcess; persist: string }

async function startHub(vars: Record<string, string>): Promise<Hub> {
  const port = await freePort()
  const inspectorPort = await freePort()
  const persist = mkdtempSync(join(tmpdir(), 'env-names-wrangler-'))
  const child = spawn(join(root, 'node_modules', '.bin', 'wrangler'), [
    'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
    '--persist-to', persist,
  ], { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev was not ready in 60 s:\n${log}`)), 60_000)
    const onData = (chunk: Buffer) => {
      log += chunk.toString()
      if (log.includes('Ready on')) { clearTimeout(timer); resolve() }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`wrangler dev exited ${code}:\n${log}`)) })
  })
  return { port, child, persist }
}

function stopHub(hub: Hub | undefined): void {
  if (!hub) return
  if (hub.child.pid) {
    try { process.kill(-hub.child.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  rmSync(hub.persist, { recursive: true, force: true })
}

/** U-R1A-31B: a valid `tandem-proof` for a tunnel dial to the local hub on `port` as `id`, signed by this file's own key. */
const device = generateKeyPairSync('ed25519')
function tunnelProof(port: number, id: string): string {
  const key = device.publicKey.export({ format: 'jwk' }).x as string
  const ts = Date.now()
  const nonce = randomBytes(16).toString('base64url')
  const text = proofText({ host: `127.0.0.1:${port}`, method: 'GET', path: '/__tunnel/connect', id, key, ts, nonce, bodySha256: EMPTY_SHA256 })
  return `v1 ${id} ${key} ${ts} ${nonce} ${sign(null, Buffer.from(text, 'utf8'), device.privateKey).toString('base64url')}`
}

/** 'open', the HTTP refusal (status + body), or an error message. */
function dialTunnel(port: number, token: string): Promise<'open' | { status: number; body: string } | string> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/__tunnel/connect?bridge_id=laptop`, CCM_TUNNEL_SUBPROTOCOL, {
    headers: { Authorization: `Bearer ${token}`, 'tandem-proof': tunnelProof(port, 'laptop') },
  })
  return new Promise(resolve => {
    socket.on('error', error => resolve(error.message))
    socket.once('open', () => { socket.close(); resolve('open') })
    socket.once('unexpected-response', (_request, response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }); socket.terminate() })
    })
  })
}

const run = `${process.pid}-${Date.now()}`
const OLD_TOKEN = `env-names-old-${run}`
const NEW_TOKEN = `env-names-new-${run}`
let oldHub: Hub | undefined
let newHub: Hub | undefined

beforeAll(async () => {
  oldHub = await startHub({ CCM_TUNNEL_TOKEN: OLD_TOKEN })
  newHub = await startHub({ TANDEM_HUB_LINK_TOKEN: NEW_TOKEN })
}, 150_000)

afterAll(() => {
  stopHub(oldHub)
  stopHub(newHub)
})

/* ---------------- d) old names do nothing ---------------- */

describe('d) old names do nothing', () => {
  it('only CCM_MCP_PASSWORD set -> 503 naming TANDEM_HUB_PASSWORD, and no grant', async () => {
    const { env, completeAuthorization } = gateEnv({ CCM_MCP_PASSWORD: PASSWORD })
    const res = await handleAuthorize(grantRequest(), env)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('TANDEM_HUB_PASSWORD')
    expect(completeAuthorization).not.toHaveBeenCalled()
  })

  it('only CCM_ALLOWED_REDIRECT_ORIGINS set -> the default origins', () => {
    expect(parseAllowedOrigins({ CCM_ALLOWED_REDIRECT_ORIGINS: 'https://other.example' } as never)).toEqual(DEFAULT_ORIGINS)
  })

  it('only CCM_TUNNEL_TOKEN set -> /__tunnel/connect refuses its value with 401', async () => {
    expect(await dialTunnel(oldHub!.port, OLD_TOKEN)).toEqual({ status: 401, body: 'unauthorized' })
  })

  it('only DEFAULT_MACHINE set -> no default: two machines are ambiguous', async () => {
    expect(await resolveWithout({ DEFAULT_MACHINE: 'desktop' })).toMatchObject({ error: { error: 'ambiguous_machine' } })
  })
})

/* ---------------- e) new names work ---------------- */

describe('e) new names work', () => {
  it('TANDEM_HUB_PASSWORD completes a grant for the owner', async () => {
    const { env, completeAuthorization } = gateEnv({ TANDEM_HUB_PASSWORD: PASSWORD })
    const res = await handleAuthorize(grantRequest(), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://claude.ai/callback?code=THE_CODE&state=xyz')
    expect(completeAuthorization).toHaveBeenCalledTimes(1)
    expect(completeAuthorization.mock.calls[0][0].userId).toBe('owner')
  })

  it('TANDEM_ALLOWED_REDIRECT_ORIGINS widens the set', () => {
    const set = parseAllowedOrigins({ TANDEM_ALLOWED_REDIRECT_ORIGINS: 'https://claude.ai,https://myclient.example' } as never)
    expect(set.has('https://myclient.example')).toBe(true)
    expect(set.has('https://claude.ai')).toBe(true)
  })

  it('TANDEM_HUB_LINK_TOKEN passes the tunnel check, and a wrong token still gets 401', async () => {
    expect(await dialTunnel(newHub!.port, NEW_TOKEN)).toBe('open')
    expect(await dialTunnel(newHub!.port, OLD_TOKEN)).toEqual({ status: 401, body: 'unauthorized' })
  })

  it('TANDEM_DEFAULT_MACHINE picks the default machine', async () => {
    expect(await resolveWithout({ TANDEM_DEFAULT_MACHINE: 'desktop' })).toEqual({ header: 'desktop' })
  })
})
