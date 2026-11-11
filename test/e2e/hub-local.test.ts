/**
 * One local hub, two bridges: every session and relay tool called at the hub
 * reaches the router of the computer it names.
 *
 * The hub is `wrangler dev --local` (as in hub/test/url-token.test.ts); the two
 * bridges, `alpha` and `beta`, are real `src/server.ts` children, each with its
 * own HOME, tmux socket (TMUX_TMPDIR, no TMUX) and folder. The test signs in the
 * way claude.ai does (register, authorize with the password, token with PKCE)
 * and calls the hub's tools with the MCP SDK client.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LINK_TOKEN, hub, missing, rand, signIn, socketOf, startBridge, startHub, stopBridge, stopHub, type Bridge,
} from './hub-harness.ts'

const title = missing
  ? `one local hub, two bridges (skipped: ${missing} missing)`
  : 'one local hub, two bridges'

const WAIT = 120_000

type Id = 'alpha' | 'beta'
type Json = Record<string, any>

let client: Client | undefined
const bridges = {} as Record<Id, Bridge>
const other = (id: Id): Id => (id === 'alpha' ? 'beta' : 'alpha')

function hasSession(bridge: Bridge, name: string): boolean {
  return spawnSync('tmux', ['-S', socketOf(bridge), 'has-session', '-t', `=ccm-${name}`], { stdio: 'ignore' }).status === 0
}

function auditText(bridge: Bridge): string {
  const path = join(bridge.home, '.tandem', 'bridge.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** One tool call; the bridge's JSON answer, or what went wrong at the MCP layer. */
async function tool(name: string, args: Record<string, unknown>): Promise<Json> {
  try {
    const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: WAIT })
    const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ''
    if (result.isError) return { toolError: text }
    return JSON.parse(text) as Json
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

const sessionIds = (listed: Json): string[] => ((listed.sessions ?? []) as { id: string }[]).map((s) => s.id)

describe.skipIf(Boolean(missing))(title, () => {
  beforeAll(async () => {
    await startHub('/tmp/r1a07-')
    // allSettled: a bridge that connects after its sibling failed is still recorded, so afterAll stops it.
    const ids: Id[] = ['alpha', 'beta']
    const started = await Promise.allSettled(ids.map((id) => startBridge(id)))
    started.forEach((result, i) => { if (result.status === 'fulfilled') bridges[ids[i]] = result.value })
    for (const result of started) if (result.status === 'rejected') throw result.reason
    const token = await signIn()
    client = new Client({ name: 'r1a07-e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
  }, 150_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    try {
      await Promise.all([stopBridge(bridges.alpha), stopBridge(bridges.beta)])
    } finally {
      // Always: a failed bridge cleanup must not leave the hub process running.
      await stopHub()
    }
  }, 30_000)

  it('/mcp without a token gives 401', async () => {
    const response = await fetch(`${hub}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)
  })

  it('with the token, list_machines shows alpha and beta', async () => {
    const machines = await tool('list_machines', {})
    expect([...(machines.connected ?? [])].sort()).toEqual(['alpha', 'beta'])
  })

  describe.each(['alpha', 'beta'] as Id[])('sessions on %s', (id) => {
    it(`open, send, read, interrupt and close reach ${id} only; list_sessions filters by agent`, async () => {
      const bridge = bridges[id]
      const elsewhere = bridges[other(id)]
      const name = `e2e-${id}-${rand(6)}`

      const opened = await tool('open_session', { name, cwd: bridge.folder, engine: 'shell', machine: id })
      expect(opened).toMatchObject({ name, engine: 'shell' })
      expect(hasSession(bridge, name)).toBe(true)
      expect(hasSession(elsewhere, name)).toBe(false)

      const marker = `${id}-${rand(12)}`
      const sent = await tool('send_to_session', { name, text: `echo ${marker}`, machine: id })
      expect(sent).toMatchObject({ name, engine: 'shell' })
      expect(sent.report).toContain(marker)

      // The hub link secret is not in a session's environment: it would let an agent pose as another computer.
      const probe = await tool('send_to_session', { name, text: `echo ${marker}-[$TANDEM_HUB_LINK_TOKEN]`, machine: id })
      expect(probe.report).toContain(`${marker}-[]`)
      expect(JSON.stringify(probe)).not.toContain(LINK_TOKEN)

      const read = await tool('read_session', { name, sinceCursor: 0, machine: id })
      expect(read).toMatchObject({ live: true, engine: 'shell' })
      expect(read.text).toContain(marker)

      expect(sessionIds(await tool('list_sessions', { engine: 'shell', machine: id }))).toContain(name)
      expect(sessionIds(await tool('list_sessions', { engine: 'claude', machine: id }))).toEqual([])
      expect(sessionIds(await tool('list_sessions', { engine: 'shell', machine: other(id) }))).not.toContain(name)
      expect(sessionIds(await tool('list_sessions', { machine: other(id) }))).not.toContain(name)

      expect(await tool('interrupt_session', { name, machine: id })).toMatchObject({ ok: true, name, engine: 'shell' })
      expect(await tool('close_session', { name, machine: id })).toMatchObject({ ok: true, name, engine: 'shell' })
      expect(hasSession(bridge, name)).toBe(false)
    }, WAIT)
  })

  it("open_session with engine no-such-agent on beta returns beta's 400 naming the engine", async () => {
    const opened = await tool('open_session', { name: `e2e-x-${rand(6)}`, cwd: bridges.beta.folder, engine: 'no-such-agent', machine: 'beta' })
    expect(opened.error).toMatch(/^unknown engine: "no-such-agent"\./)
  }, WAIT)

  describe.each(['alpha', 'beta'] as Id[])('relay on %s', (id) => {
    it(`start, read, stop and inject get ${id}'s own answer`, async () => {
      const bridge = bridges[id]
      const elsewhere = bridges[other(id)]
      const started = await tool('start_relay', { goal: 'e2e goal', cwd: bridges.alpha.folder, machine: id })
      if (id === 'alpha') expect(started.error).toMatch(/^engine "claude" is disabled/) // 403: claude not enabled
      else expect(started.error).toBe(`cwd not allowed: ${bridges.alpha.folder}`) // 403: not beta's folder

      const loopId = `${id}-loop-${rand(8)}`
      expect(await tool('read_relay', { loopId, machine: id })).toEqual({ error: `unknown loopId: ${loopId}` }) // 404
      expect(await tool('stop_relay', { loopId, machine: id })).toEqual({ ok: false, running: false })
      expect(await tool('inject_to_relay', { loopId, message: 'e2e note', machine: id })).toEqual({ ok: false })

      const here = auditText(bridge)
      for (const route of ['GET /relay/:loopId/read', 'POST /relay/:loopId/stop', 'POST /relay/:loopId/inject']) {
        expect(here).toContain(JSON.stringify({ route, loopId }).slice(1, -1))
      }
      expect(auditText(elsewhere)).not.toContain(loopId)
    }, WAIT)
  })

  it('oversize: 900 KiB to alpha gives payload_too_large, the link stays up, and the next call to alpha succeeds', async () => {
    const sent = await tool('send_to_session', { name: 'e2e-big', text: 'x'.repeat(900 * 1024), machine: 'alpha' })
    expect(sent).toEqual({ error: 'payload_too_large' })
    await new Promise((resolve) => setTimeout(resolve, 1_500)) // a dropped link would redial within this
    expect(bridges.alpha.stderr.split('hub link: connected').length - 1).toBe(1)
    const loopId = `after-big-${rand(6)}`
    expect(await tool('read_relay', { loopId, machine: 'alpha' })).toEqual({ error: `unknown loopId: ${loopId}` })
  }, WAIT)
})
