/**
 * The bridge's half of per-computer hub credentials (U-R1A-31B-1): every hub link dial and every
 * fabric POST carries a `tandem-proof` header signed by this computer's device key, beside the
 * unchanged bearer. In process: a `ws` server and a node:http server on 127.0.0.1 stand in for
 * the hub; the proofs they receive are checked with the hub's own parseProof and verifyProof.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { openDeviceKey } from '../bridge/device-keys.ts'
import { hubProofHeader, startHubLink } from '../bridge/hub-link.ts'
import { fabricForward } from '../bridge/hub-rpc.ts'
import { EMPTY_SHA256, PROOF_HEADER, parseProof, verifyProof } from '../hub/src/devices.ts'

const TOKEN = `hub-proof-${'t'.repeat(24)}`
const TIMING = { baseMs: 20, maxMs: 400, healthyMs: 150, dialTimeoutMs: 500, livenessMs: 2_000, heartbeatMs: 1_000 }
const WAIT = { timeout: 5_000, interval: 10 }

const dir = mkdtempSync(join(tmpdir(), 'hub-proof-'))
const key = openDeviceKey({ path: join(dir, 'keys', 'device.key') })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const servers: (WebSocketServer | Server)[] = []
const links: ReturnType<typeof startHubLink>[] = []
afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => link.close()))
  for (const server of servers.splice(0)) {
    if (server instanceof WebSocketServer) for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
})

/** A `ws` hub that records each upgrade request; `refuse` answers every dial with that status. */
async function wsHub(refuse?: number) {
  const requests: IncomingMessage[] = []
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (info, done) => {
      requests.push(info.req)
      if (refuse) done(false, refuse)
      else done(true)
    },
  })
  servers.push(server)
  await once(server, 'listening')
  const sockets: import('ws').WebSocket[] = []
  server.on('connection', (socket) => void sockets.push(socket))
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, sockets }
}

const host = (url: string) => new URL(url).host

describe('hubProofHeader', () => {
  it("passes the hub's parseProof and verifyProof", async () => {
    const value = hubProofHeader(key, { url: 'wss://Hub.Example.com', method: 'get', path: '/__tunnel/connect', id: 'probe-one' })
    const parsed = parseProof(value)
    expect(parsed).toMatchObject({ id: 'probe-one', key: key.publicKey })
    expect(Math.abs(parsed!.ts - Date.now())).toBeLessThan(5_000)
    expect(await verifyProof(parsed!, { host: 'hub.example.com', method: 'GET', path: '/__tunnel/connect', bodySha256: EMPTY_SHA256 })).toBe(true)
  })
})

describe('the hub link dial', () => {
  it('sends tandem-proof for GET /__tunnel/connect as bridgeId, a new nonce on each dial, the bearer unchanged; the token is in no proof, URL or log line', async () => {
    const hub = await wsHub()
    const lines: string[] = []
    links.push(startHubLink({ url: hub.url, token: TOKEN, bridgeId: 'probe-one', key }, { log: (line) => lines.push(line), timing: TIMING }))
    await vi.waitFor(() => expect(hub.sockets.length).toBe(1), WAIT)
    hub.sockets[0].terminate()
    await vi.waitFor(() => expect(hub.requests.length).toBeGreaterThanOrEqual(2), WAIT)

    const proofs = hub.requests.slice(0, 2).map((request) => String(request.headers[PROOF_HEADER]))
    for (const [i, request] of hub.requests.slice(0, 2).entries()) {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
      const parsed = parseProof(proofs[i])
      expect(parsed).toMatchObject({ id: 'probe-one', key: key.publicKey })
      expect(await verifyProof(parsed!, { host: host(hub.url), method: 'GET', path: '/__tunnel/connect', bodySha256: EMPTY_SHA256 })).toBe(true)
      expect(request.url).not.toContain(TOKEN)
      expect(proofs[i]).not.toContain(TOKEN)
    }
    expect(parseProof(proofs[0])!.nonce).not.toBe(parseProof(proofs[1])!.nonce)
    for (const line of lines) expect(line).not.toContain(TOKEN)
  })

  it('a 409 answer logs the exact taken line', async () => {
    const hub = await wsHub(409)
    const lines: string[] = []
    links.push(startHubLink({ url: hub.url, token: TOKEN, bridgeId: 'probe-one', key }, { log: (line) => lines.push(line), timing: TIMING }))
    await vi.waitFor(() => expect(hub.requests.length).toBeGreaterThanOrEqual(2), WAIT)
    await vi.waitFor(() => expect(lines.filter((line) => line === 'hub link: the hub holds another key for probe-one; this computer cannot connect as probe-one').length).toBeGreaterThanOrEqual(2), WAIT)
    expect(lines.some((line) => line.includes('connected'))).toBe(false)
    for (const line of lines) expect(line).not.toContain(TOKEN)
  })
})

describe('fabricForward', () => {
  it('sends a proof whose bodySha256 is the SHA-256 of the exact bytes received', async () => {
    const seen: { url: string; proof: string; bytes: Buffer; authorization?: string }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({ url: request.url ?? '', proof: String(request.headers[PROOF_HEADER]), bytes: Buffer.concat(chunks), authorization: request.headers.authorization })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    const body = { input: { query: 'r1a31b ünïcode' } }
    expect(await fabricForward({ url, token: TOKEN, bridgeId: 'probe-one', key }).forward('/fabric/memory/search', body)).toEqual({})

    expect(seen).toHaveLength(1)
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`)
    const parsed = parseProof(seen[0].proof)
    expect(parsed).toMatchObject({ id: 'probe-one', key: key.publicKey })
    const bodySha256 = createHash('sha256').update(seen[0].bytes).digest('hex')
    expect(bodySha256).not.toBe(EMPTY_SHA256)
    expect(await verifyProof(parsed!, { host: host(url), method: 'POST', path: '/__tunnel/fabric-rpc/fabric/memory/search', bodySha256 })).toBe(true)
    expect(seen[0].proof).not.toContain(TOKEN)
    expect(seen[0].url).not.toContain(TOKEN)
  })
})
