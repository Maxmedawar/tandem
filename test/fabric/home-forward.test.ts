/**
 * The forwarder a computer without the memory store uses (bridge/hub-rpc.ts): each of the 11
 * fabric calls goes over HTTPS to the hub's link route, and the hub sends it to the memory home.
 *
 * A fake hub (a node:http server on 127.0.0.1, port 0) records each request and answers what the
 * case sets.
 */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fabricForward, hubHttpOrigin } from '../../bridge/hub-rpc.ts'
import { buildMcpServer } from '../../src/mcp-server.ts'

const TOKEN = `r1a23-forward-${'k'.repeat(24)}`
const FABRIC_TOOLS = [
  'memory_forget', 'memory_get', 'memory_promote', 'memory_remember', 'memory_search',
  'project_archive', 'project_create', 'project_get', 'project_list', 'room_post', 'room_read',
]
const CONFLICT = {
  error: 'memory_home_conflict',
  machines: ['alpha', 'gamma'],
  message: 'more than one computer holds a memory store (alpha, gamma); turn the store off on all but one',
}

interface Seen { method: string; url: string; authorization?: string; contentType?: string; body: string }
const seen: Seen[] = []
let answer: { status: number; type: string; body: string } = { status: 200, type: 'application/json', body: '{}' }
let server: Server
let fake = { url: '', token: TOKEN }

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      })
      response.writeHead(answer.status, { 'content-type': answer.type })
      response.end(answer.body)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  fake = { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN }
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  seen.length = 0
  answer = { status: 200, type: 'application/json', body: '{}' }
})

describe('fabricForward', () => {
  it('POSTs to /__tunnel/fabric-rpc<path> with the bearer header and the body; the URL holds no token; a 409 body comes back unchanged', async () => {
    answer = { status: 409, type: 'application/json', body: JSON.stringify(CONFLICT) }
    const body = { caller: { ownerId: 'o', deviceId: 'd', agentId: 'a' }, input: { query: 'r1a23' } }
    const result = await fabricForward(fake).forward('/fabric/memory/search', body)
    expect(result).toEqual(CONFLICT)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/__tunnel/fabric-rpc/fabric/memory/search',
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
    })
    expect(JSON.parse(seen[0].body)).toEqual(body)
    expect(seen[0].url).not.toContain(TOKEN)
  })

  it('a non-JSON answer gives fabric_unavailable', async () => {
    answer = { status: 502, type: 'text/html', body: '<html>bad gateway</html>' }
    expect(await fabricForward(fake).forward('/fabric/project/list', { input: {} })).toEqual({ error: 'fabric_unavailable' })
  })

  it('a closed port gives the exact cannot-reach body', async () => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))
    const result = await fabricForward({ url: `ws://127.0.0.1:${port}`, token: TOKEN }).forward('/fabric/project/list', { input: {} })
    expect(result).toEqual({ error: 'memory_home_offline', message: 'memory home offline: this computer cannot reach the hub' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

describe('hubHttpOrigin', () => {
  it.each([
    ['wss://h.example', 'https://h.example'],
    ['ws://127.0.0.1:9', 'http://127.0.0.1:9'],
  ])('%s -> %s', (from, to) => {
    expect(hubHttpOrigin(from)).toBe(to)
  })
})

describe('buildMcpServer with a forwarder', () => {
  it('lists 18 tools with no /fabric/_ready call; memory_search reaches the hub; no fabric tool takes `machine`', async () => {
    const mcp = await buildMcpServer(undefined, fabricForward(fake))
    const client = new Client({ name: 'r1a23-forward', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
    try {
      const tools = (await client.listTools()).tools
      expect(tools).toHaveLength(18)
      for (const name of FABRIC_TOOLS) expect(tools.map((tool) => tool.name)).toContain(name)
      for (const tool of tools.filter((t) => FABRIC_TOOLS.includes(t.name))) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('machine')
      }
      expect(seen.map((request) => request.url)).not.toContain('/__tunnel/fabric-rpc/fabric/_ready')

      answer = { status: 200, type: 'application/json', body: JSON.stringify({ records: [] }) }
      const result = await client.callTool({ name: 'memory_search', arguments: { query: 'r1a23 forward', machine: 'mini' } })
      const text = (result.content as { type: string; text: string }[])[0].text
      expect(JSON.parse(text)).toEqual({ records: [] })
      expect(seen).toHaveLength(1)
      expect(seen[0].url).toBe('/__tunnel/fabric-rpc/fabric/memory/search')
      expect(JSON.parse(seen[0].body).input).toEqual({ query: 'r1a23 forward' })
    } finally {
      await client.close()
      await mcp.close()
    }
  })
})
