/**
 * U-R1A-36B: an agent on one computer acts on another only as that computer's limits file allows
 * (A3.13): signed commands through the hub's POST /__tunnel/command, run at the receiver only when
 * its `control_from` lists the sender; remote Ask mail likewise; FYI always.
 *
 * One local hub (`wrangler dev --local`) and two real bridges (src/server.ts) through
 * ./hub-harness.ts: `alpha` and `beta`. A roster of root, alpha, beta and gamma is written into
 * both bridges' `.tandem/roster` and put at the hub (as mail-two-computers.test.ts does); root's and
 * gamma's keys are held by this test, and gamma talks to the hub only through raw proofed posts.
 * The agent on alpha: a shell session `r1a36b-agent` the owner opens on alpha, a caller token
 * minted for it in alpha's state.db, and src/stdio-server.ts with alpha's kept env plus that token.
 * Every wait is a poll with a stated limit. Skipped only when wrangler or tmux is missing.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hubProofHeader } from '../../bridge/hub-link.ts'
import { openDeviceKey, type DeviceKey } from '../../bridge/device-keys.ts'
import { signEnvelope } from '../../bridge/envelope.ts'
import { initRoster, makeOffer, receiveOffer, trustOffer } from '../../bridge/roster.ts'
import { rosterHub } from '../../bridge/roster-hub.ts'
import { mintCallerToken } from '../../bridge/caller-tokens.ts'
import { openMailbox, type Mailbox } from '../../bridge/mailbox.ts'
import { writeLimits } from '../fixtures/limits.ts'
import { hub, LINK_TOKEN, missing, pauseBridge, repo, restartBridge, startBridge, startHub, stopBridge, stopHub, type Bridge } from './hub-harness.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const PREFIX = '/tmp/r1a36b-e2e-'
const AGENT = 'r1a36b-agent'
const CALLER = `session:${AGENT}`
const NOT_ALPHA = 'control_from: alpha may not act on this computer (limits file)'
const COMMAND = '/__tunnel/command'
const folders: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(50)
  }
}

const keyIn = (home: string): DeviceKey => openDeviceKey({ path: join(home, '.tandem', 'keys', 'device.key') })
const tandemHome = (b: Bridge) => join(b.home, '.tandem')

/** The owner's roster: started by `root` in `rootHome`, each of `others` trusted, copied into `copies`, put at the hub as root. */
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
  for (const home of copies) {
    mkdirSync(join(home, 'roster'), { recursive: true, mode: 0o700 })
    chmodSync(join(home, 'roster'), 0o700)
    copyFileSync(join(rootHome, 'roster', 'roster.json'), join(home, 'roster', 'roster.json'))
    chmodSync(join(home, 'roster', 'roster.json'), 0o600)
  }
  const put = await rosterHub({ url: hub, token: LINK_TOKEN, bridgeId: root.id }, root.key).put(0, text)
  if (!put.ok) throw new Error(`roster put: ${put.len}`)
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
  const client = new Client({ name: `r1a36b-${b.id}`, version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  return JSON.parse((result.content as { text: string }[])[0].text)
}

const commandBody = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'command', op: 'close', args: { name: 'r1a36b-none' }, caller: CALLER, ...over })

const title = missing ? `(36B) an agent on two computers (skipped: ${missing} missing)` : '(36B) an agent on two computers'

describe.skipIf(Boolean(missing))(title, () => {
  let alpha: Bridge | undefined
  let beta: Bridge | undefined
  let owner: Client | undefined
  let agent: Client | undefined
  let betaBox: Mailbox | undefined
  let gamma: DeviceKey
  /** An envelope alpha sent in (e2), replayed by gamma in (e3). */
  let recorded = ''
  let recordedAnswer: Json
  const keys = mkdtempSync(`${PREFIX}keys-`)
  folders.push(keys)

  /** One raw POST /__tunnel/command as `id` with `key`: the bearer and a proof over the exact bytes. */
  async function post(id: string, key: DeviceKey, body: string, opts: { path?: string; method?: string; bearer?: string } = {}): Promise<{ status: number; data: Json }> {
    const path = opts.path ?? COMMAND
    const method = opts.method ?? 'POST'
    const response = await fetch(`${hub}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.bearer ?? LINK_TOKEN}`,
        'content-type': 'application/json',
        'tandem-proof': hubProofHeader(key, { url: hub, method, path: path.split('?')[0], id, body }),
      },
      ...(method === 'GET' ? {} : { body }),
    })
    const text = await response.text()
    let data: Json = text
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: response.status, data }
  }
  const betaAudit = (): Json[] => {
    const file = join(tandemHome(beta!), 'bridge.log')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const betaSessions = () => {
    const out = spawnSync('tmux', ['-S', beta!.socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    return (out.stdout ?? '').split('\n').filter((n) => n.startsWith('ccm-'))
  }

  beforeAll(async () => {
    await startHub(PREFIX)
    alpha = await startBridge('alpha')
    beta = await startBridge('beta')
    const rootHome = join(keys, 'root')
    mkdirSync(rootHome, { mode: 0o700 })
    const root = { id: 'root', key: openDeviceKey({ path: join(rootHome, 'keys', 'device.key') }) }
    gamma = openDeviceKey({ path: join(keys, 'gamma', 'keys', 'device.key') })
    await ownerRoster(rootHome, root, [['alpha', keyIn(alpha.home)], ['beta', keyIn(beta.home)], ['gamma', gamma]], [tandemHome(alpha), tandemHome(beta)])
    // gamma binds its id at the hub with one roster GET (its key, its first proof).
    expect(await rosterHub({ url: hub, token: LINK_TOKEN, bridgeId: 'gamma' }, gamma).get()).toEqual(expect.objectContaining({ len: 4 }))
    // The agent: the owner opens its shell session on alpha; a token for it is minted in alpha's state.db.
    owner = await startStdio(alpha)
    const opened = await call(owner, 'open_session', { engine: 'shell', name: AGENT, cwd: alpha.folder })
    if (opened.error) throw new Error(`open ${AGENT}: ${opened.error}`)
    const before = process.env.TANDEM_HOME
    process.env.TANDEM_HOME = tandemHome(alpha)
    let token: string
    try {
      token = mintCallerToken(AGENT)
    } finally {
      if (before === undefined) delete process.env.TANDEM_HOME
      else process.env.TANDEM_HOME = before
    }
    agent = await startStdio(alpha, { TANDEM_CALLER_TOKEN: token })
    betaBox = openMailbox({ path: join(tandemHome(beta), 'state.db') })
  }, 180_000)

  afterAll(async () => {
    for (const client of [agent, owner]) await client?.close().catch(() => {})
    betaBox?.close()
    try {
      await Promise.all([stopBridge(alpha), stopBridge(beta)])
    } finally {
      await stopHub()
      for (const f of folders) rmSync(f, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60_000)

  it('(36B) (e1) A3.13 under beta\'s default limits: open_session on beta refused with the control_from text; Ask refused at beta; FYI arrives', async () => {
    const r = await call(agent!, 'open_session', { engine: 'shell', name: 'r1a36b-e1', cwd: beta!.folder, device: 'beta' })
    expect(r).toEqual({ error: NOT_ALPHA })
    expect(betaSessions()).not.toContain('ccm-r1a36b-e1')
    expect(betaAudit().filter((l) => l.event === 'remote.command').map((l) => [l.from, l.caller, l.op, l.name, l.status])).toEqual([
      ['alpha', CALLER, 'open', 'r1a36b-e1', 403],
    ])

    const ask = await call(agent!, 'mail_send', { to: 'beta:bob', level: 'ask', text: 'r1a36b ask e1', replyByMinutes: 5 })
    expect(ask).toEqual(expect.objectContaining({ to: 'beta:bob', level: 'ask', state: 'queued' }))
    await until(() => betaAudit().some((l) => l.event === 'mail.refused' && l.id === ask.id), 30_000, 'the ask refused at beta')
    expect(betaAudit().filter((l) => l.event === 'mail.refused' && l.id === ask.id).map((l) => [l.from, l.denied, l.status])).toEqual([['alpha', 'mailbox', 403]])
    expect(betaBox!.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })

    const fyi = await call(agent!, 'mail_send', { to: 'beta:bob', level: 'fyi', text: 'r1a36b fyi e1' })
    await until(() => betaBox!.pending('bob').fyi >= 1, 30_000, 'the fyi at beta')
    expect(betaBox!.read('bob', 10).map((m) => [m.id, m.from, m.level, m.text])).toEqual([[fyi.id, `machine:alpha/${CALLER}`, 'fyi', 'r1a36b fyi e1']])
  }, 120_000)

  it('(36B) (e2) beta\'s limits gain control_from = ["alpha"]: alpha\'s agent opens a session on beta\'s socket, closes it; a new Ask is stored', async () => {
    await pauseBridge(beta!)
    const file = join(tandemHome(beta!), 'limits.toml')
    writeLimits(tandemHome(beta!), { ...(parse(readFileSync(file, 'utf8')) as Json), control_from: ['alpha'] })
    await restartBridge(beta!)

    const opened = await call(agent!, 'open_session', { engine: 'shell', name: 'r1a36b-e2', cwd: beta!.folder, device: 'beta' })
    expect(opened.error).toBeUndefined()
    expect(betaSessions()).toContain('ccm-r1a36b-e2')
    const closed = await call(agent!, 'close_session', { name: 'beta:r1a36b-e2' })
    expect(closed.error).toBeUndefined()
    expect(betaSessions()).not.toContain('ccm-r1a36b-e2')
    expect(betaAudit().filter((l) => l.event === 'remote.command' && l.name === 'r1a36b-e2').map((l) => [l.from, l.caller, l.op, l.status])).toEqual([
      ['alpha', CALLER, 'open', 200], ['alpha', CALLER, 'close', 200],
    ])

    const ask = await call(agent!, 'mail_send', { to: 'beta:bob', level: 'ask', text: 'r1a36b ask e2', replyByMinutes: 5 })
    await until(() => betaBox!.pending('bob').ask >= 1, 30_000, 'the ask stored at beta')
    expect(betaBox!.read('bob', 10).map((m) => [m.id, m.from, m.level])).toEqual([[ask.id, `machine:alpha/${CALLER}`, 'ask']])

    // One command alpha signs and sends itself (close of a name that is not there), kept for (e3).
    recorded = JSON.stringify(signEnvelope(keyIn(alpha!.home), { from: 'alpha', to: 'beta', body: commandBody() }, undefined, 'command'))
    const sent = await post('alpha', keyIn(alpha!.home), JSON.stringify({ to: 'beta', envelope: recorded }))
    expect(sent.status).toBe(200)
    recordedAnswer = sent.data
  }, 180_000)

  it('(36B) (e3) the hub carries, the signature decides: forged, replayed, offline, not a member', async () => {
    const forged = JSON.stringify(signEnvelope(gamma, { from: 'alpha', to: 'beta', body: commandBody({ op: 'open', args: { engine: 'shell', name: 'r1a36b-e3', cwd: beta!.folder } }) }, undefined, 'command'))
    expect(await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: forged }))).toEqual({ status: 401, data: { error: 'envelope', reason: 'signature' } })
    expect(betaSessions()).not.toContain('ccm-r1a36b-e3')
    // Still 401 replay, run once; since the audit it carries beta's stored receipt of that one run.
    expect(await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: recorded }))).toEqual({
      status: 401, data: { error: 'envelope', reason: 'replay', receipt: { state: 'done', status: 200, body: recordedAnswer } },
    })
    expect(betaAudit().filter((l) => l.event === 'remote.command' && l.name === 'r1a36b-none').map((l) => l.status)).toEqual([200])
    expect(await post('gamma', gamma, JSON.stringify({ to: 'root', envelope: forged }))).toEqual({ status: 503, data: { error: 'bridge_offline', requested: 'root' } })
    expect(await post('gamma', gamma, JSON.stringify({ to: 'delta', envelope: forged }))).toEqual({ status: 403, data: { error: 'not_in_roster' } })
    expect(await post('gamma', gamma, JSON.stringify({ to: 'gamma', envelope: forged }))).toEqual({ status: 403, data: { error: 'not_in_roster' } })
    // The route's order: a token query 401, not POST 405, a wrong bearer 401, a bad body 400.
    expect((await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: forged }), { path: `${COMMAND}?token=x` })).status).toBe(401)
    expect((await post('gamma', gamma, '', { method: 'GET' })).status).toBe(405)
    expect((await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: forged }), { bearer: 'w'.repeat(40) })).status).toBe(401)
    expect(await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: forged, x: 1 }))).toEqual({ status: 400, data: { error: 'command_invalid' } })
    expect((await post('gamma', gamma, JSON.stringify({ to: 'beta', envelope: 'x'.repeat(70_000) }))).status).toBe(413)
  }, 120_000)
  it('(36E) (e4) the hub caps commands per target computer: the 61st in 60 s is 429 target_busy and never reaches the target', async () => {
    const GAMMA = 'control_from: gamma may not act on this computer (limits file)'
    const gammaLines = () => {
      const file = join(tandemHome(alpha!), 'bridge.log')
      const lines: Json[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
      return lines.filter((l) => l.event === 'remote.command' && l.from === 'gamma').length
    }
    const to = (target: string) =>
      JSON.stringify({ to: target, envelope: JSON.stringify(signEnvelope(gamma, { from: 'gamma', to: target, body: commandBody() }, undefined, 'command')) })
    expect(gammaLines()).toBe(0)
    for (let i = 1; i <= 60; i++) expect([i, await post('gamma', gamma, to('alpha'))]).toEqual([i, { status: 403, data: { error: GAMMA } }])
    expect(gammaLines()).toBe(60)
    expect(await post('gamma', gamma, to('alpha'))).toEqual({ status: 429, data: { error: 'target_busy', requested: 'alpha' } })
    expect(gammaLines()).toBe(60)
    expect(await post('gamma', gamma, to('beta'))).toEqual({ status: 403, data: { error: GAMMA } })
    expect(await post('gamma', gamma, to('root'))).toEqual({ status: 503, data: { error: 'bridge_offline', requested: 'root' } })
  }, 120_000)
})
