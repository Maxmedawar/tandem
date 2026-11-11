/**
 * The bridge's half of per-computer hub credentials (U-R1A-31B-1): every hub link dial and every
 * fabric POST carries a `tandem-proof` header signed by this computer's device key, beside the
 * unchanged bearer. In process: a `ws` server and a node:http server on 127.0.0.1 stand in for
 * the hub; the proofs they receive are checked with the hub's own parseProof and verifyProof.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('audit rows (U-R1A-31B-1)', () => {
  it('a hub that always answers 409 is redialled with growing waits, never hot', async () => {
    const hub = await wsHub(409)
    const lines: string[] = []
    links.push(startHubLink({ url: hub.url, token: TOKEN, bridgeId: 'probe-one', key }, { log: (line) => lines.push(line), timing: TIMING }))
    const waits = () => lines.flatMap((line) => /^hub link: reconnecting in (\d+)ms$/.exec(line)?.[1] ?? []).map(Number)
    await vi.waitFor(() => expect(waits().length).toBeGreaterThanOrEqual(6), WAIT)
    // Planned 20, 40, 80, 160, 320, 400 ms, each up to 20% early.
    expect(waits()[3]).toBeGreaterThanOrEqual(128)
    expect(waits()[5]).toBeGreaterThanOrEqual(320)
    expect(hub.requests.length).toBeLessThanOrEqual(waits().length + 1)
  })

  it('no log line of a dial, open or refused, carries the proof, its signature or the private key', async () => {
    const hub = await wsHub()
    const refusing = await wsHub(409)
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    links.push(startHubLink({ url: hub.url, token: TOKEN, bridgeId: 'probe-one', key }, { log, timing: TIMING }))
    links.push(startHubLink({ url: refusing.url, token: TOKEN, bridgeId: 'probe-one', key }, { log, timing: TIMING }))
    await vi.waitFor(() => expect(hub.sockets.length).toBeGreaterThanOrEqual(1), WAIT)
    await vi.waitFor(() => expect(refusing.requests.length).toBeGreaterThanOrEqual(2), WAIT)
    const secret = readFileSync(join(dir, 'keys', 'device.key'), 'utf8').split('\n').filter((line) => line && !line.startsWith('-----'))
    expect(secret.length).toBeGreaterThan(0)
    const proofs = [...hub.requests, ...refusing.requests].map((request) => parseProof(String(request.headers[PROOF_HEADER]))!)
    for (const line of lines) {
      expect(line).not.toContain(key.publicKey)
      for (const part of secret) expect(line).not.toContain(part)
      for (const proof of proofs) {
        expect(line).not.toContain(proof.sig)
        expect(line).not.toContain(proof.nonce)
      }
    }
  })

  it('an unusable device key: the dial is not made and logs the reason only; fabricForward answers memory_home_offline with no request', async () => {
    const home = mkdtempSync(join(dir, 'bad-home-'))
    writeFileSync(join(home, 'keys'), 'not a folder')
    const hub = await wsHub()
    const posts: string[] = []
    const server = createServer((request, response) => { posts.push(request.url ?? ''); response.end('{}') })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const lines: string[] = []
    const before = process.env.TANDEM_HOME
    process.env.TANDEM_HOME = home
    try {
      links.push(startHubLink({ url: hub.url, token: TOKEN, bridgeId: 'probe-one' }, { log: (line) => lines.push(line), timing: TIMING }))
      await vi.waitFor(() => expect(lines.filter((line) => line.startsWith('hub link: device key: ')).length).toBeGreaterThanOrEqual(3), WAIT)
      expect(await fabricForward({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN, bridgeId: 'probe-one' }).forward('/fabric/project/list', { input: {} }))
        .toEqual({ error: 'memory_home_offline', message: 'memory home offline: this computer cannot reach the hub' })
      await Promise.all(links.splice(0).map((link) => link.close()))
    } finally {
      if (before === undefined) delete process.env.TANDEM_HOME
      else process.env.TANDEM_HOME = before
    }
    expect(hub.requests).toHaveLength(0)
    expect(posts).toHaveLength(0)
    expect(lines.some((line) => line.includes('dialing'))).toBe(false)
    const waits = lines.flatMap((line) => /^hub link: reconnecting in (\d+)ms$/.exec(line)?.[1] ?? []).map(Number)
    expect(waits[2]).toBeGreaterThanOrEqual(64)
    for (const line of lines) expect(line).not.toContain(TOKEN)
  })
})
