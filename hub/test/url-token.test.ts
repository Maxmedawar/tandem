/**
 * The Worker refuses a secret in the URL. A `token` query parameter on
 * /__tunnel/connect gets 401 `unauthorized`, even when the header secret is
 * valid: a URL lands in proxy, CDN and request logs, and once the server refuses
 * it no client can keep sending it. The tunnel secret comes only from
 * `Authorization: Bearer`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CCM_TUNNEL_SUBPROTOCOL } from '../src/protocol.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = `${process.pid}-${Date.now()}`
const T = `url-tunnel-${run}`
const E = `url-ext-${run}`

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** 'open', the HTTP refusal (status + body) read from 'unexpected-response', or an error message. */
function dial(socket: WebSocket): Promise<'open' | { status: number; body: string } | string> {
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

/** fetch with a 5 s abort: an empty poll is held 25 s. */
async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5_000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: abort.signal })
    return { status: response.status, body: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

function expectRefused(result: unknown): void {
  expect(result).toEqual({ status: 401, body: 'unauthorized' })
  const body = (result as { body: string }).body
  expect(body).not.toContain(T)
  expect(body).not.toContain(E)
}

let wrangler: ChildProcess | undefined
let port = 0
let persist = ''
let log = ''
let afterReady = -1

beforeAll(async () => {
  port = await freePort()
  const inspectorPort = await freePort()
  persist = mkdtempSync(join(tmpdir(), 'url-token-wrangler-'))
  wrangler = spawn(join(root, 'node_modules', '.bin', 'wrangler'), [
    'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--var', `TANDEM_HUB_LINK_TOKEN:${T}`,
    '--var', `TANDEM_HUB_PASSWORD:${'p'.repeat(32)}`,
    '--persist-to', persist,
  ], { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev was not ready in 60 s:\n${log}`)), 60_000)
    const read = (chunk: Buffer) => {
      log += chunk.toString()
      if (afterReady < 0 && log.includes('Ready on')) {
        // Only output after the "Ready on" line counts: the startup bindings list may print --var values.
        const end = log.indexOf('\n', log.indexOf('Ready on'))
        afterReady = end < 0 ? log.length : end + 1
        clearTimeout(timer)
        resolve()
      }
    }
    wrangler!.stdout!.on('data', read)
    wrangler!.stderr!.on('data', read)
    wrangler!.once('exit', code => { clearTimeout(timer); reject(new Error(`wrangler dev exited ${code}:\n${log}`)) })
  })
  // The mailbox cases are not in this hub, so one GET /__ext/poll with the Bearer
  // header (now a 404) still runs: the log check below needs that request line.
  await request('/__ext/poll', { headers: { Authorization: `Bearer ${E}` } })
}, 90_000)

afterAll(() => {
  if (wrangler?.pid) {
    try { process.kill(-wrangler.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  if (persist) rmSync(persist, { recursive: true, force: true })
})

describe('a token in the URL is refused', () => {
  it('a) the old bridge dial, ?token=<T>&bridge_id=old with the tunnel subprotocol, gets 401', async () => {
    const old = new WebSocket(
      `ws://127.0.0.1:${port}/__tunnel/connect?token=${encodeURIComponent(T)}&bridge_id=old`,
      CCM_TUNNEL_SUBPROTOCOL,
    )
    expectRefused(await dial(old))
  })

  it('b) a valid Bearer header plus ?token=<T> in the URL gets 401', async () => {
    const both = new WebSocket(
      `ws://127.0.0.1:${port}/__tunnel/connect?token=${encodeURIComponent(T)}&bridge_id=both`,
      CCM_TUNNEL_SUBPROTOCOL,
      { headers: { Authorization: `Bearer ${T}` } },
    )
    expectRefused(await dial(both))
  })
})

describe('kept: the header and body secrets still work', () => {
  it('kept: openTunnelSocket opens with the header and a wrong token gets 401', async () => {
    // openTunnelSocket is in the bridge, which is not in this package: the same
    // dial (Bearer header, tunnel subprotocol, bridge_id in the URL) is made here.
    const openTunnelSocket = (base: string, token: string, bridgeId: string) => new WebSocket(
      `${base}/__tunnel/connect?bridge_id=${encodeURIComponent(bridgeId)}`,
      CCM_TUNNEL_SUBPROTOCOL,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(await dial(openTunnelSocket(`ws://127.0.0.1:${port}`, T, 'probe'))).toBe('open')
    const wrong = await dial(openTunnelSocket(`ws://127.0.0.1:${port}`, 'not-the-token', 'probe-wrong'))
    expect(wrong).toMatchObject({ status: 401 })
  })

  it('kept: wrangler dev output after "Ready on" contains neither secret', async () => {
    await new Promise(resolve => setTimeout(resolve, 1_000)) // let the last request lines flush
    const requests = log.slice(afterReady)
    expect(requests).toContain('/__ext/poll') // the request log was captured
    expect(requests).not.toContain(T)
    expect(requests).not.toContain(E)
  })
})
