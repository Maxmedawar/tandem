/**
 * U-R1A-52: the `usage` tool on two computers and at the hub (test A11.4).
 *
 * One local hub (`wrangler dev --local`) and two real bridges (src/server.ts) through
 * ./hub-harness.ts: `alpha` and `beta`, with the roster, the signed-in hub MCP client and one
 * src/stdio-server.ts per computer built as test/e2e/presence-two-computers.test.ts builds them.
 * Drop files are written into each bridge's `<HOME>/.tandem/usage/claude/` (folder 0700, files 0600)
 * after the bridges are up; each computer's stdio `usage` with refresh: true then records them in
 * its own state.db, and each bridge carries its rows to the other inside its signed presence.
 * Neither bridge HOME holds an agent folder, so no token helper of any kind runs (tokens stay null).
 * Every wait is a poll with a stated limit; measured times are printed. Skipped only when wrangler
 * or tmux is missing.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDeviceKey, type DeviceKey } from '../../bridge/device-keys.ts'
import { initRoster, makeOffer, receiveOffer, trustOffer } from '../../bridge/roster.ts'
import { rosterHub } from '../../bridge/roster-hub.ts'
import { mintCallerToken } from '../../bridge/caller-tokens.ts'
import { hub, LINK_TOKEN, missing, rand, repo, signIn, startBridge, startHub, stopBridge, stopHub, type Bridge } from './hub-harness.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const PREFIX = '/tmp/r1a52-e2e-'
const folders: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MIN = 60_000
const MARKER = 'R1A52-SESSION-MARKER'

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

/** src/stdio-server.ts with the bridge's kept env plus `extra`; close() ends that child only. */
async function startStdio(b: Bridge, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(b.env ?? {})) if (v !== undefined) env[k] = v
  Object.assign(env, extra)
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, env, stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: `r1a52-${b.id}`, version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  return JSON.parse((result.content as { text: string }[])[0].text)
}

/** A claude drop file in `b`'s TANDEM_HOME; windows `[used, resetsMs]` (resets on whole seconds). */
function drop(b: Bridge, account: string, at: number, five?: [number, number], seven?: [number, number]) {
  const usage = join(tandemHome(b), 'usage')
  const dir = join(usage, 'claude')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(usage, 0o700)
  chmodSync(dir, 0o700)
  const win = (w: [number, number]) => ({ used_percentage: w[0], resets_at: Math.round(w[1] / 1000) })
  const file = join(dir, `${account}.json`)
  writeFileSync(file, JSON.stringify({ at, rate_limits: { ...(five ? { five_hour: win(five) } : {}), ...(seven ? { seven_day: win(seven) } : {}) } }), { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** The answer without what differs by who answers and when: the answering computer, the time, ages, and N in notices. */
function normal(a: Json): Json {
  const { computer: _c, at: _a, ...rest } = a
  return {
    ...rest,
    accounts: a.accounts.map(({ ageMs: _g, tokens_age_ms: _t, ...x }: Json) => x),
    notices: a.notices.map((n: string) => n.replace(/for \d+ min/, 'for N min').replace(/read \d+ min ago/, 'read N min ago')),
  }
}
const acct = (a: Json, account: string) => a.accounts.find((x: Json) => x.agent === 'claude' && x.account === account)
const claudeRoom = (a: Json) => a.most_room.find((r: Json) => r.agent === 'claude')

const title = missing ? `(52) usage on two computers (skipped: ${missing} missing)` : '(52) usage on two computers'

describe.skipIf(Boolean(missing))(title, () => {
  let alpha: Bridge | undefined
  let beta: Bridge | undefined
  let alphaStdio: Client | undefined
  let betaStdio: Client | undefined
  let agent: Client | undefined
  let owner: Client | undefined
  /** Every usage answer of this file, as JSON text, for (e5). */
  const answers: string[] = []
  const session = `r1a52-agent-${rand(6)}`
  let NOW = 0

  const usageAt = async (where: 'hub-alpha' | 'hub-beta' | 'alpha' | 'beta' | 'agent', refresh = false): Promise<Json> => {
    const a = where === 'hub-alpha' ? await call(owner!, 'usage', { machine: 'alpha', ...(refresh ? { refresh } : {}) })
      : where === 'hub-beta' ? await call(owner!, 'usage', { machine: 'beta', ...(refresh ? { refresh } : {}) })
        : await call(where === 'alpha' ? alphaStdio! : where === 'beta' ? betaStdio! : agent!, 'usage', refresh ? { refresh } : {})
    answers.push(JSON.stringify(a))
    return a
  }
  const FOUR = ['hub-alpha', 'hub-beta', 'alpha', 'beta'] as const
  /** All four answers, polled every 500 ms until `ok` holds for each and they are equal once normalised (within `ms`); returns them and the ms waited. */
  async function converge(ok: (a: Json) => boolean, ms: number, what: string): Promise<{ all: Json[]; waited: number }> {
    const start = Date.now()
    for (;;) {
      const all: Json[] = []
      for (const w of FOUR) all.push(await usageAt(w))
      const same = all.every((a) => JSON.stringify(normal(a)) === JSON.stringify(normal(all[0])))
      if (all.every(ok) && same) return { all, waited: Date.now() - start }
      if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}; last ${JSON.stringify(all.map(normal))}`)
      await sleep(500)
    }
  }

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
    owner = new Client({ name: 'r1a52-owner', version: '0.0.0' })
    await owner.connect(new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    alphaStdio = await startStdio(alpha)
    betaStdio = await startStdio(beta)
    // Presence flows both ways before any measured step.
    const start = Date.now()
    for (const [client, id] of [[alphaStdio, 'beta'], [betaStdio, 'alpha']] as const) {
      for (;;) {
        const others = (await call(client, 'who_is_up', {})).others ?? []
        if (others.some((o: Json) => o.computer === id && o.stale === false)) break
        if (Date.now() - start > 60_000) throw new Error(`presence: ${id} not seen in 60 s`)
        await sleep(250)
      }
    }
    // The drops, after the bridges are up; each computer's stdio usage with refresh records its own.
    NOW = Date.now()
    const R5 = NOW + 2 * 60 * MIN
    const R7 = NOW + 3 * 24 * 60 * MIN
    drop(alpha, 'claude-shared', NOW - 120_000, [20, R5], [30, R7])
    drop(beta, 'claude-shared', NOW - 60_000, [50, R5], [60, R7])
    drop(beta, 'claude-old', NOW - 31 * MIN - 10_000, [0, R5], [40, R7])
    drop(alpha, 'claude-reset', NOW - 20_000, [30, NOW - 60_000], [40, R7])
    drop(alpha, 'claude-alpha-only', NOW - 30_000, [10, R5], [15, R7])
    await usageAt('alpha', true)
    await usageAt('beta', true)
  }, 240_000)

  afterAll(async () => {
    for (const client of [owner, alphaStdio, betaStdio, agent]) await client?.close().catch(() => {})
    try {
      await Promise.all([stopBridge(alpha), stopBridge(beta)])
    } finally {
      await stopHub()
      for (const f of folders) rmSync(f, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60_000)

  it('(52) (e1) A11.4 one account on both computers: within 30 s every answer (hub for alpha, hub for beta, alpha, beta) shows the fresher reading, from beta, and the four are equal', async () => {
    const { all, waited } = await converge((a) => acct(a, 'claude-shared')?.computer === 'beta' && acct(a, 'claude-old') !== undefined, 30_000, 'claude-shared from beta everywhere')
    process.stderr.write(`(52) (e1) the four answers agreed ${waited} ms after the stdio refreshes\n`)
    expect(waited).toBeLessThanOrEqual(30_000)
    for (const a of all) {
      expect(Object.keys(a)).toEqual(['computer', 'at', 'accounts', 'most_room', 'notices'])
      expect(acct(a, 'claude-shared')).toMatchObject({ computer: 'beta', at: NOW - 60_000, stale: false, five_hour: { used: 50 }, seven_day: { used: 60 }, room: 40, tokens: null, cost_usd: null })
      expect(normal(a)).toEqual(normal(all[0]))
    }
    expect(all.map((a) => a.computer)).toEqual(['alpha', 'beta', 'alpha', 'beta'])
  }, 60_000)

  it('(52) (e2) stale, unknown and most room are the same everywhere: claude-old stale with its notice, claude-reset unknown with room 60, most room claude-alpha-only (85, alpha)', async () => {
    const { all } = await converge((a) => acct(a, 'claude-old') !== undefined && acct(a, 'claude-alpha-only') !== undefined, 30_000, 'every account everywhere')
    expect(all[0].notices).toContain('stale: claude account claude-old (read on beta) has not reported for 31 min; its shares may be out of date')
    for (const a of all) {
      expect(acct(a, 'claude-old')).toMatchObject({ computer: 'beta', stale: true, room: null })
      expect(a.notices.some((n: string) => /^stale: claude account claude-old \(read on beta\) has not reported for \d+ min; its shares may be out of date$/.test(n))).toBe(true)
      expect(acct(a, 'claude-reset')).toMatchObject({ computer: 'alpha', five_hour: { used: null }, seven_day: { used: 40 }, room: 60 })
      expect(a.notices).toContain('unknown: claude account claude-reset five_hour passed its reset; its share is unknown until the next reading')
      expect(acct(a, 'claude-alpha-only')).toMatchObject({ computer: 'alpha', room: 85 })
      expect(claudeRoom(a)).toEqual({ agent: 'claude', account: 'claude-alpha-only', computer: 'alpha', room: 85 })
    }
  }, 60_000)

  it('(52) (e3) refresh: a new drop on alpha shows in alpha\'s refresh answer at once, and within 30 s at beta and at the hub; most room moves to claude-reset everywhere', async () => {
    const t = Date.now()
    drop(alpha!, 'claude-alpha-only', t, [95, t + 2 * 60 * MIN], [15, t + 3 * 24 * 60 * MIN])
    const mine = await usageAt('alpha', true)
    expect(acct(mine, 'claude-alpha-only')).toMatchObject({ computer: 'alpha', at: t, five_hour: { used: 95 }, room: 5 })
    const start = Date.now()
    for (;;) {
      const there = [await usageAt('beta'), await usageAt('hub-beta')]
      if (there.every((a) => acct(a, 'claude-alpha-only')?.five_hour.used === 95)) break
      if (Date.now() - start > 30_000) throw new Error(`the new reading did not reach beta in 30 s: ${JSON.stringify(there.map((a) => acct(a, 'claude-alpha-only')))}`)
      await sleep(250)
    }
    const carried = Date.now() - start
    process.stderr.write(`(52) (e3) the refreshed reading reached beta and the hub (machine beta) ${carried} ms after alpha's refresh answered\n`)
    expect(carried).toBeLessThanOrEqual(30_000)
    const { all } = await converge((a) => acct(a, 'claude-alpha-only')?.five_hour.used === 95, 30_000, 'the new reading everywhere')
    for (const a of all) expect(claudeRoom(a)).toEqual({ agent: 'claude', account: 'claude-reset', computer: 'alpha', room: 60 })
  }, 90_000)

  it('(52) (e4) an agent (a caller token for a session on alpha) gets the owner\'s answer', async () => {
    const opened = await call(owner!, 'open_session', { name: session, cwd: alpha!.folder, engine: 'shell', machine: 'alpha' })
    expect(opened).toMatchObject({ name: session, engine: 'shell' })
    const before = process.env.TANDEM_HOME
    process.env.TANDEM_HOME = tandemHome(alpha!)
    let token: string
    try {
      token = mintCallerToken(session)
    } finally {
      if (before === undefined) delete process.env.TANDEM_HOME
      else process.env.TANDEM_HOME = before
    }
    agent = await startStdio(alpha!, { TANDEM_CALLER_TOKEN: token })
    const start = Date.now()
    for (;;) {
      const [mine, owners] = [await usageAt('agent'), await usageAt('alpha')]
      if (JSON.stringify(normal(mine)) === JSON.stringify(normal(owners))) {
        expect(normal(mine)).toEqual(normal(owners))
        expect(mine.computer).toBe('alpha')
        break
      }
      if (Date.now() - start > 30_000) throw new Error(`agent and owner answers differ: ${JSON.stringify([normal(mine), normal(owners)])}`)
      await sleep(250)
    }
  }, 90_000)

  it('(52) (e5) no session text: after the session prints a marker, no usage answer holds it, the session name or a path', async () => {
    await call(owner!, 'send_to_session', { name: session, text: `echo ${MARKER}`, waitForTurn: false, machine: 'alpha' })
    await sleep(1000)
    for (const w of [...FOUR, 'agent'] as const) await usageAt(w, w === 'alpha' || w === 'beta')
    expect(answers.length).toBeGreaterThan(20)
    for (const text of answers) {
      expect(text).not.toContain(MARKER)
      expect(text).not.toContain(session)
      expect(text).not.toContain('/tmp')
      expect(text).not.toContain('/Users')
      expect(text).not.toContain('/home')
      expect(text).not.toContain('/private')
    }
  }, 60_000)
})
