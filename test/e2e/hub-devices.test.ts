/**
 * Per-computer hub credentials against a local hub (U-R1A-31B-1, gate A4.12): the hub binds each
 * machine id to the first device key that proves it and refuses every other key under that id,
 * on the tunnel and on the fabric link route. The shared link token alone gets nothing.
 *
 * One local hub (`wrangler dev --local`) through ./hub-harness.ts; raw `ws` dials with keys from
 * node:crypto; two real bridges with the same id and their own HOME (so their own device keys).
 * Skipped only when wrangler or tmux is missing.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CCM_TUNNEL_SUBPROTOCOL } from '../../hub/src/protocol.ts'
import { hubProofHeader } from '../../bridge/hub-link.ts'
import { hub, LINK_TOKEN, missing, startBridge, startHub, stopBridge, stopHub, type Bridge } from './hub-harness.ts'

// Every child the harness spawns, with its stderr, so the log of a bridge that never connects can
// be read (startBridge stops such a bridge itself and throws without its stderr).
const children = vi.hoisted(() => [] as { child: ChildProcess; stderr: string }[])
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const child = real.spawn(...args)
      const seen = { child, stderr: '' }
      children.push(seen)
      child.stderr?.on('data', (chunk: Buffer) => { seen.stderr += chunk.toString() })
      return child
    },
  }
})

const TAKEN_LINE = (id: string) => `hub link: the hub holds another key for ${id}; this computer cannot connect as ${id}`

function newKey() {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }).x as string,
    sign: (data: string | Uint8Array) => sign(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, pair.privateKey).toString('base64url'),
  }
}
const keyA = newKey()
const keyB = newKey()
const keyC = newKey()

const connectProof = (key: ReturnType<typeof newKey>, id: string, now?: number) =>
  hubProofHeader(key, { url: hub, method: 'GET', path: '/__tunnel/connect', id, now })

/** Every socket a dial opened, left open; afterAll ends them. */
const open: WebSocket[] = []

/** One raw tunnel dial: 'open' (the socket is kept in `open`), the HTTP refusal, or an error message. */
function dial(bridgeId: string, headers: Record<string, string>): Promise<'open' | { status: number; body: string } | string> {
  const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/__tunnel/connect?bridge_id=${bridgeId}`, CCM_TUNNEL_SUBPROTOCOL, { headers })
  return new Promise((resolve) => {
    ws.on('error', (error) => resolve(error.message))
    ws.once('open', () => { open.push(ws); resolve('open') })
    ws.once('unexpected-response', (_request, response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }); ws.terminate() })
    })
  })
}

async function fabric(body: string, proof: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${hub}/__tunnel/fabric-rpc/fabric/project/list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${LINK_TOKEN}`, 'content-type': 'application/json', 'tandem-proof': proof },
    body,
  })
  return { status: response.status, body: await response.text() }
}

const UNAUTHORIZED = { status: 401, body: 'unauthorized' }
const bearer = { Authorization: `Bearer ${LINK_TOKEN}` }

const title = missing
  ? `per-computer hub credentials (skipped: ${missing} missing)`
  : 'per-computer hub credentials'

describe.skipIf(Boolean(missing))(title, () => {
  let headerA = ''

  beforeAll(async () => {
    await startHub('/tmp/r1a31b1-e2e-')
  }, 90_000)

  afterAll(async () => {
    for (const ws of open) ws.terminate()
    await stopHub()
  }, 30_000)

  it('(1) the right bearer and no proof: 401 unauthorized', async () => {
    expect(await dial('r1a31b-a', bearer)).toEqual(UNAUTHORIZED)
  })

  it('(2) a proofed dial as r1a31b-a with key A opens', async () => {
    headerA = connectProof(keyA, 'r1a31b-a')
    expect(await dial('r1a31b-a', { ...bearer, 'tandem-proof': headerA })).toBe('open')
    expect(open).toHaveLength(1)
  })

  it('(3) key B as r1a31b-a: 409 machine id taken, and A stays open', async () => {
    expect(await dial('r1a31b-a', { ...bearer, 'tandem-proof': connectProof(keyB, 'r1a31b-a') })).toEqual({ status: 409, body: 'machine id taken' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(open[0].readyState).toBe(WebSocket.OPEN)
  })

  it("(4) A's exact header sent again: 401", async () => {
    expect(await dial('r1a31b-a', { ...bearer, 'tandem-proof': headerA })).toEqual(UNAUTHORIZED)
    expect(open[0].readyState).toBe(WebSocket.OPEN)
  })

  it('(5) a proof with a ts 301 s old: 401', async () => {
    expect(await dial('r1a31b-a', { ...bearer, 'tandem-proof': connectProof(keyA, 'r1a31b-a', Date.now() - 301_000) })).toEqual(UNAUTHORIZED)
  })

  it('(6) proof id r1a31b-a, URL bridge_id r1a31b-x: 401', async () => {
    expect(await dial('r1a31b-x', { ...bearer, 'tandem-proof': connectProof(keyA, 'r1a31b-a') })).toEqual(UNAUTHORIZED)
  })

  it('(7) a wrong bearer with a good proof: 401', async () => {
    expect(await dial('r1a31b-a', { Authorization: `Bearer ${'w'.repeat(32)}`, 'tandem-proof': connectProof(keyA, 'r1a31b-a') })).toEqual(UNAUTHORIZED)
  })

  it("(8) the fabric route: A's proof over other body bytes 401; a good proof by a never-connected id 401", async () => {
    const body = JSON.stringify({ input: {} })
    const path = '/__tunnel/fabric-rpc/fabric/project/list'
    const overOther = hubProofHeader(keyA, { url: hub, method: 'POST', path, id: 'r1a31b-a', body: JSON.stringify({ input: { x: 1 } }) })
    expect(await fabric(body, overOther)).toEqual(UNAUTHORIZED)
    const stranger = hubProofHeader(keyC, { url: hub, method: 'POST', path, id: 'r1a31b-n', body })
    expect(await fabric(body, stranger)).toEqual(UNAUTHORIZED)
    // The control: A's proof over these bytes passes the device check (no home is connected).
    const good = hubProofHeader(keyA, { url: hub, method: 'POST', path, id: 'r1a31b-a', body })
    expect((await fabric(body, good)).status).toBe(503)
  })

  it('(9) a second bridge as r1a31b-c with another key never connects and logs the taken line', async () => {
    let first: Bridge | undefined
    try {
      first = await startBridge('r1a31b-c')
      expect(first.stderr).toContain('hub link: connected')
      const before = children.length
      const started = Date.now()
      const second = await startBridge('r1a31b-c').then(
        async (bridge) => { await stopBridge(bridge); return 'connected' },
        (error: Error) => error.message,
      )
      expect(second).toBe('timed out waiting for r1a31b-c to connect')
      expect(Date.now() - started).toBeGreaterThanOrEqual(15_000)
      const spawned = children.slice(before).filter((c) => c.child.spawnargs.includes('src/server.ts'))
      expect(spawned).toHaveLength(1)
      const stderr = spawned[0].stderr
      expect(stderr).not.toContain('hub link: connected')
      expect(stderr).toContain(TAKEN_LINE('r1a31b-c'))
      expect(stderr).not.toContain(LINK_TOKEN)
      expect(first.stderr.split('hub link: connected').length - 1).toBe(1)
    } finally {
      await stopBridge(first)
    }
  }, 120_000)
})
