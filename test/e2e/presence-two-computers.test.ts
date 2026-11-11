/**
 * U-R1A-33B-3: presence between two computers through the hub, signed (test A3.2).
 *
 * One local hub (`wrangler dev --local`) and two real bridges (src/server.ts, each running the
 * presence carrier bridge/hub-presence.ts) through ./hub-harness.ts: `alpha` and `beta`. A roster
 * of root, alpha and beta is put at the hub by root and written into both bridges' `.tandem/roster`
 * (root's key is held by this test). A signed-in hub MCP client opens one shell session on each
 * computer (open_session with `machine`); one src/stdio-server.ts per computer, with that bridge's
 * kept env (its HOME, so its roster and state.db), answers who_is_up. Every wait is a poll with a
 * stated limit; the measured times are printed. Skipped only when wrangler or tmux is missing.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDeviceKey, type DeviceKey } from '../../bridge/device-keys.ts'
import { initRoster, makeOffer, receiveOffer, trustOffer } from '../../bridge/roster.ts'
import { rosterHub } from '../../bridge/roster-hub.ts'
import {
  hub, LINK_TOKEN, missing, pauseBridge, rand, repo, restartBridge, signIn, startBridge, startHub, stopBridge, stopHub, type Bridge,
} from './hub-harness.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const PREFIX = '/tmp/r1a33b3-e2e-'
const folders: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const keyIn = (home: string): DeviceKey => openDeviceKey({ path: join(home, '.tandem', 'keys', 'device.key') })
const tandemHome = (b: Bridge) => join(b.home, '.tandem')

/** The owner's roster: started by `root` in `rootHome`, each of `others` trusted, put at the hub as root, then copied into `copies`. */
async function ownerRoster(rootHome: string, root: { id: string; key: DeviceKey }, others: [string, DeviceKey][], copies: string[]) {
  const before = process.env.TANDEM_HOME
  process.env.TANDEM_HOME = rootHome
  try {
    initRoster(root.key, root.id)
    for (const [id, key] of others) {
      receiveOffer(JSON.stringify(makeOffer(key, id)))
      trustOffer(root.key, key.fingerprint)
    }
  } finally {
    if (before === undefined) delete process.env.TANDEM_HOME
    else process.env.TANDEM_HOME = before
  }
  const text = readFileSync(join(rootHome, 'roster', 'roster.json'), 'utf8')
  const put = await rosterHub({ url: hub, token: LINK_TOKEN, bridgeId: root.id }, root.key).put(0, text)
  if (!put.ok) throw new Error(`roster put: ${put.len}`)
  for (const home of copies) {
    mkdirSync(join(home, 'roster'), { recursive: true, mode: 0o700 })
    chmodSync(join(home, 'roster'), 0o700)
    copyFileSync(join(rootHome, 'roster', 'roster.json'), join(home, 'roster', 'roster.json'))
    chmodSync(join(home, 'roster', 'roster.json'), 0o600)
  }
}

/** src/stdio-server.ts with the bridge's kept env (its HOME, roster and state.db); close() ends that child only. */
async function startStdio(b: Bridge) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(b.env ?? {})) if (v !== undefined) env[k] = v
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, env, stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: `r1a33b3-${b.id}`, version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
  return JSON.parse((result.content as { text: string }[])[0].text)
}

const title = missing ? `(33B-3) presence between two computers (skipped: ${missing} missing)` : '(33B-3) presence between two computers'

describe.skipIf(Boolean(missing))(title, () => {
  let alpha: Bridge | undefined
  let beta: Bridge | undefined
  let alphaAgent: Client | undefined
  let betaAgent: Client | undefined
  let owner: Client | undefined
  /** Every who_is_up answer alpha gave, as JSON text, for (e3). */
  const alphaAnswers: string[] = []
  const names = { alpha: `r1a33b3-a-${rand(6)}`, beta: `r1a33b3-b-${rand(6)}` }

  /** The `others` row for `id` in `client`'s who_is_up, polled every 250 ms until `ok` (within `ms`); returns it and the ms waited. */
  async function watch(client: Client, id: string, ok: (row: Json) => boolean, ms: number, what: string): Promise<{ row: Json; waited: number }> {
    const start = Date.now()
    let row: Json
    for (;;) {
      const answer = await call(client, 'who_is_up', {})
      if (client === alphaAgent) alphaAnswers.push(JSON.stringify(answer))
      row = (answer.others ?? []).find((o: Json) => o.computer === id)
      if (row && ok(row)) return { row, waited: Date.now() - start }
      if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}; last ${JSON.stringify(row)}`)
      await sleep(250)
    }
  }
  const listed = (name: string) => (row: Json) => row.stale === false && row.sessions.some((s: Json) => s.name === name)

  beforeAll(async () => {
    await startHub(PREFIX)
    alpha = await startBridge('alpha')
    beta = await startBridge('beta')
    const keys = mkdtempSync(`${PREFIX}keys-`)
    folders.push(keys)
    const rootHome = join(keys, 'root')
    mkdirSync(rootHome, { mode: 0o700 })
    const root = { id: 'root', key: openDeviceKey({ path: join(rootHome, 'keys', 'device.key') }) }
    await ownerRoster(rootHome, root, [['alpha', keyIn(alpha.home)], ['beta', keyIn(beta.home)]], [tandemHome(alpha), tandemHome(beta)])
    const token = await signIn()
    owner = new Client({ name: 'r1a33b3-owner', version: '0.0.0' })
    await owner.connect(new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    alphaAgent = await startStdio(alpha)
    betaAgent = await startStdio(beta)
    // presence flows both ways before any measured step
    await watch(alphaAgent, 'beta', (row) => row.stale === false, 60_000, 'beta seen from alpha')
    await watch(betaAgent, 'alpha', (row) => row.stale === false, 60_000, 'alpha seen from beta')
  }, 240_000)

  afterAll(async () => {
    for (const client of [owner, alphaAgent, betaAgent]) await client?.close().catch(() => {})
    try {
      await Promise.all([stopBridge(alpha), stopBridge(beta)])
    } finally {
      await stopHub()
      for (const f of folders) rmSync(f, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60_000)

  it('(33B-3) (e1) A3.2 listed: a session opened on beta is in alpha\'s who_is_up others within 5 s, not stale; the same for alpha\'s seen from beta', async () => {
    /** Opens `name` on `b`; the ms since the call was sent. */
    const open = async (b: Bridge, name: string) => {
      const sent = Date.now()
      expect(await call(owner!, 'open_session', { name, cwd: b.folder, engine: 'shell', machine: b.id })).toMatchObject({ name, engine: 'shell' })
      return () => Date.now() - sent
    }
    const sinceBeta = await open(beta!, names.beta)
    const atAlpha = await watch(alphaAgent!, 'beta', listed(names.beta), 5_000, `${names.beta} at alpha`)
    const fromSendBeta = sinceBeta()
    const sinceAlpha = await open(alpha!, names.alpha)
    const atBeta = await watch(betaAgent!, 'alpha', listed(names.alpha), 5_000, `${names.alpha} at beta`)
    const fromSendAlpha = sinceAlpha()
    process.stderr.write(`(33B-3) (e1) beta's session listed at alpha ${atAlpha.waited} ms after its open answered (${fromSendBeta} ms after the open was sent); alpha's at beta ${atBeta.waited} ms (${fromSendAlpha} ms)\n`)
    expect(atAlpha.row).toMatchObject({ computer: 'beta', stale: false, at: expect.any(Number), ageMs: expect.any(Number) })
    expect(atAlpha.row.sessions.find((s: Json) => s.name === names.beta)).toMatchObject({ engine: 'shell', project: 'work' })
    expect(atAlpha.waited).toBeLessThanOrEqual(5_000)
    expect(atBeta.waited).toBeLessThanOrEqual(5_000)
  }, 60_000)

  it('(33B-3) (e2) A3.2 stale: beta killed (SIGKILL) reads stale at alpha within 30 s; restarted, not stale within 10 s', async () => {
    await pauseBridge(beta!, 'SIGKILL')
    const down = await watch(alphaAgent!, 'beta', (row) => row.stale === true, 30_000, 'beta stale at alpha')
    await restartBridge(beta!)
    const up = await watch(alphaAgent!, 'beta', (row) => row.stale === false, 10_000, 'beta not stale at alpha')
    process.stderr.write(`(33B-3) (e2) beta stale at alpha ${down.waited} ms after the kill; not stale ${up.waited} ms after the restart\n`)
    expect(down.waited).toBeLessThanOrEqual(30_000)
    expect(up.waited).toBeLessThanOrEqual(10_000)
  }, 120_000)

  it('(33B-3) (e3) no folder path of beta ever appears in alpha\'s answers', async () => {
    alphaAnswers.push(JSON.stringify(await call(alphaAgent!, 'who_is_up', { refresh: true })))
    expect(alphaAnswers.length).toBeGreaterThan(3)
    for (const text of alphaAnswers) {
      expect(text).not.toContain(beta!.folder)
      expect(text).not.toContain(beta!.base)
      expect(text).not.toContain('"cwd":"/tmp/r1a33b3-e2e-beta')
    }
    expect(alphaAnswers.some((t) => t.includes(names.beta))).toBe(true)
  }, 60_000)
})
