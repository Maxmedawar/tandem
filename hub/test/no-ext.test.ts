/**
 * The extension mailbox is not part of this hub. Its old routes, /__ext/poll and
 * /__ext/fire, get the same 404 `not found` as any unknown path, with or without
 * a secret in the header, the body or the URL.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = `${process.pid}-${Date.now()}`
const T = `no-ext-tunnel-${run}`
const E = `no-ext-old-${run}`

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** fetch with a 5 s abort, so a route that holds the request fails the case. */
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

const NOT_FOUND = { status: 404, body: 'not found' }

let wrangler: ChildProcess | undefined
let port = 0
let persist = ''
let log = ''

beforeAll(async () => {
  port = await freePort()
  const inspectorPort = await freePort()
  persist = mkdtempSync(join(tmpdir(), 'no-ext-wrangler-'))
  // The old mailbox secret is set too: even with it configured and presented,
  // the routes do not exist.
  wrangler = spawn(join(root, 'node_modules', '.bin', 'wrangler'), [
    'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--var', `CCM_TUNNEL_TOKEN:${T}`, '--var', `CCM_EXT_TOKEN:${E}`,
    '--var', `CCM_MCP_PASSWORD:${'p'.repeat(32)}`,
    '--persist-to', persist,
  ], { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev was not ready in 60 s:\n${log}`)), 60_000)
    const read = (chunk: Buffer) => {
      log += chunk.toString()
      if (log.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    wrangler!.stdout!.on('data', read)
    wrangler!.stderr!.on('data', read)
    wrangler!.once('exit', code => { clearTimeout(timer); reject(new Error(`wrangler dev exited ${code}:\n${log}`)) })
  })
}, 90_000)

afterAll(() => {
  if (wrangler?.pid) {
    try { process.kill(-wrangler.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  if (persist) rmSync(persist, { recursive: true, force: true })
})

describe('the mailbox routes are not in the hub', () => {
  it('baseline: GET /__no-such-path gets 404 not found', async () => {
    expect(await request('/__no-such-path')).toEqual(NOT_FOUND)
  })

  it('GET /__ext/poll?pairs=p gets 404 not found', async () => {
    expect(await request('/__ext/poll?pairs=p')).toEqual(NOT_FOUND)
  })

  it('GET /__ext/poll with a Bearer header gets 404 not found', async () => {
    expect(await request('/__ext/poll', { headers: { Authorization: `Bearer ${E}` } })).toEqual(NOT_FOUND)
  })

  it('POST /__ext/fire with a JSON body gets 404 not found', async () => {
    expect(await request('/__ext/fire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: 'p', token: E }),
    })).toEqual(NOT_FOUND)
  })

  it('POST /__ext/fire?token=x gets 404 not found', async () => {
    expect(await request('/__ext/fire?token=x', { method: 'POST' })).toEqual(NOT_FOUND)
  })
})
