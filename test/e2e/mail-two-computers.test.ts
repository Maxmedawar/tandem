/**
 * U-R1A-33B-2: mail between two computers through the hub, signed, in order, exactly once.
 *
 * One local hub (`wrangler dev --local`) and two real bridges (src/server.ts, each running the
 * carrier bridge/hub-mail.ts) through ./hub-harness.ts: `alpha` and `beta`. A roster of root,
 * alpha, beta and gamma is written into both bridges' `.tandem/roster` and put at the hub as
 * memory-home.test.ts `ownerRoster` does; root's and gamma's keys are held by this test, and gamma
 * talks to the hub only through raw proofed puts. One src/stdio-server.ts per computer runs with
 * that bridge's kept env (its HOME, so its state.db): the agents' mail_send and mail_read. Every
 * wait is a poll with a stated limit. Skipped only when wrangler or tmux is missing.
 */
import { randomUUID } from 'node:crypto'
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
import { openMailbox, type Mailbox } from '../../bridge/mailbox.ts'
import { writeLimits } from '../fixtures/limits.ts'
import {
  hub, LINK_TOKEN, missing, pauseBridge, repo, restartBridge, restartHub, startBridge, startHub, stopBridge, stopHub, type Bridge,
} from './hub-harness.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
const PREFIX = '/tmp/r1a33b2-e2e-'
const folders: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `check` true within `ms`, polled every 50 ms; else a throw naming `what`. */
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

/** src/stdio-server.ts with the bridge's kept env (its HOME and state.db); close() ends that child only. */
async function startStdio(b: Bridge) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(b.env ?? {})) if (v !== undefined) env[k] = v
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, env, stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: `r1a33b2-${b.id}`, version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
  return JSON.parse((result.content as { text: string }[])[0].text)
}

const mailBody = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'mail', id: `mail-${randomUUID()}`, from: 'owner', to: 'bob', level: 'fyi', text: 'r1a33b2 body', sentAt: Date.now(), ...over })

const title = missing ? `(33B-2) mail between two computers (skipped: ${missing} missing)` : '(33B-2) mail between two computers'

describe.skipIf(Boolean(missing))(title, () => {
  let alpha: Bridge | undefined
  let beta: Bridge | undefined
  let alphaAgent: Client | undefined
  let betaAgent: Client | undefined
  let alphaBox: Mailbox | undefined
  let betaBox: Mailbox | undefined
  let gamma: DeviceKey
  const keys = mkdtempSync(`${PREFIX}keys-`)
  folders.push(keys)

  /** One raw put as gamma: the bearer and a proof by gamma's key over the exact bytes. */
  async function gammaPut(id: string, body: string): Promise<{ status: number; data: Json }> {
    const text = JSON.stringify({ id, to: ['beta'], body })
    const path = '/__tunnel/mail/put'
    const response = await fetch(`${hub}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LINK_TOKEN}`,
        'content-type': 'application/json',
        'tandem-proof': hubProofHeader(gamma, { url: hub, method: 'POST', path, id: 'gamma', body: text }),
      },
      body: text,
    })
    return { status: response.status, data: await response.json() }
  }
  const betaAudit = (): Json[] => {
    const file = join(tandemHome(beta!), 'bridge.log')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const refusedAtBeta = (from: string) => betaAudit().filter((l) => l.event === 'mail.refused' && l.from === from)
  const outbox = (texts: string[]) => alphaBox!.sent('owner', 500).filter((m) => texts.includes(m.text))
  const send = async (text: string, level = 'fyi', extra: Json = {}) => {
    const sent = await call(alphaAgent!, 'mail_send', { to: 'beta:bob', level, text, ...extra })
    expect(sent).toEqual(expect.objectContaining({ to: 'beta:bob', level, state: 'queued' }))
    return sent.id as string
  }
  /** Beta's bob inbox read by beta's agent once `count` are queued there (within `ms`). */
  const arrive = async (count: number, ms: number) => {
    await until(() => betaBox!.pending('bob').fyi + betaBox!.pending('bob').interrupt >= count, ms, `${count} messages at beta`)
    return (await call(betaAgent!, 'mail_read', { name: 'bob', limit: 50 })).messages as Json[]
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
    alphaAgent = await startStdio(alpha)
    betaAgent = await startStdio(beta)
    alphaBox = openMailbox({ path: join(tandemHome(alpha), 'state.db') })
    betaBox = openMailbox({ path: join(tandemHome(beta), 'state.db') })
  }, 180_000)

  afterAll(async () => {
    for (const client of [alphaAgent, betaAgent]) await client?.close().catch(() => {})
    alphaBox?.close()
    betaBox?.close()
    try {
      await Promise.all([stopBridge(alpha), stopBridge(beta)])
    } finally {
      await stopHub()
      for (const f of folders) rmSync(f, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60_000)

  it('(33B-2) (m1) A3.12: 20 fyi from alpha arrive once at beta, in send order, from machine:alpha/owner; alpha\'s outbox shows them sent', async () => {
    const texts = Array.from({ length: 20 }, (_, k) => `r1a33b2 m${String(k + 1).padStart(2, '0')}`)
    const ids: string[] = []
    for (const text of texts) ids.push(await send(text))
    const got = await arrive(20, 30_000)
    expect(got.map((m) => m.text)).toEqual(texts)
    expect(got.map((m) => m.id)).toEqual(ids)
    expect(new Set(got.map((m) => m.from))).toEqual(new Set(['machine:alpha/owner']))
    await until(() => outbox(texts).every((m) => m.state === 'sent'), 30_000, 'alpha outbox all sent')
    const out = (await call(alphaAgent!, 'mail_read', { box: 'outbox', limit: 500 })) as Json[]
    expect(out.filter((m) => ids.includes(m.id)).map((m) => [m.to, m.state])).toEqual(ids.map(() => ['beta:bob', 'sent']))
    await sleep(10_000)
    expect((await call(betaAgent!, 'mail_read', { name: 'bob', limit: 50 })).messages).toEqual([])
  }, 90_000)

  it('(33B-2) (m2) link drop mid-send: alpha killed with some sent and some queued; after both restart, beta holds all in send order, each once', async () => {
    await pauseBridge(beta!)
    let texts: string[] = []
    let counts = { sent: 0, queued: 0 }
    for (const n of [30, 200]) {
      texts = Array.from({ length: n }, (_, k) => `r1a33b2 d${n}-${String(k + 1).padStart(3, '0')}`)
      for (const text of texts) await send(text)
      const end = Date.now() + 60_000
      for (;;) {
        const rows = outbox(texts)
        counts = { sent: rows.filter((m) => m.state === 'sent').length, queued: rows.filter((m) => m.state === 'queued').length }
        if ((counts.sent >= 1 && counts.queued >= 1) || counts.sent === n || Date.now() > end) break
        await sleep(2)
      }
      if (counts.sent >= 1 && counts.queued >= 1) break
      // every row was sent before the kill: once more with 200, after beta takes these
      await restartBridge(beta!)
      await arrive(n, 60_000)
      await pauseBridge(beta!)
    }
    expect(counts.sent).toBeGreaterThanOrEqual(1)
    expect(counts.queued).toBeGreaterThanOrEqual(1)
    await pauseBridge(alpha!, 'SIGKILL')
    process.stderr.write(`(33B-2) (m2) at the kill: ${counts.sent} sent, ${counts.queued} queued of ${texts.length}\n`)
    await restartBridge(alpha!)
    await restartBridge(beta!)
    const got = await arrive(texts.length, 60_000)
    const all = [...got]
    while (all.length < texts.length) all.push(...(await call(betaAgent!, 'mail_read', { name: 'bob', limit: 50 })).messages)
    expect(all.map((m) => m.text)).toEqual(texts)
    expect(new Set(all.map((m) => m.from))).toEqual(new Set(['machine:alpha/owner']))
    await until(() => outbox(texts).every((m) => m.state === 'sent'), 60_000, 'alpha outbox all sent')
    await sleep(4_000)
    expect(betaBox!.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
  }, 300_000)

  it('(33B-2) (m3) A3.15 hub restart: 5 sent while beta is away arrive once, in order, after the hub restarts', async () => {
    await pauseBridge(beta!)
    const texts = Array.from({ length: 5 }, (_, k) => `r1a33b2 h${k + 1}`)
    for (const text of texts) await send(text)
    await until(() => outbox(texts).every((m) => m.state === 'sent'), 30_000, 'the 5 sent')
    await restartHub()
    await restartBridge(beta!)
    const got = await arrive(5, 60_000)
    expect(got.map((m) => m.text)).toEqual(texts)
    await sleep(4_000)
    expect(betaBox!.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
  }, 180_000)

  it('(33B-2) (m4) queue full: gamma fills beta\'s queue with 1,000; alpha\'s send reads queue_full; beta refuses the 1,000 as shape and acks them; the next send arrives', async () => {
    const start = Date.now()
    await sleep(5_000) // beta's last take carried its ack
    await pauseBridge(beta!)
    for (let k = 0; k < 1000; k++) {
      const put = await gammaPut(`r1a33b2-g${k}`, `r1a33b2 gamma ${k}`)
      expect([k, put.status, typeof put.data.results?.[0]?.seq]).toEqual([k, 200, 'number'])
    }
    const full = await send('r1a33b2 full')
    await until(() => alphaBox!.sent('owner', 500).find((m) => m.id === full)?.state === 'queue_full', 30_000, 'queue_full at alpha')
    await restartBridge(beta!)
    await until(() => refusedAtBeta('gamma').length >= 1000, 120_000, '1,000 refusals at beta')
    expect(refusedAtBeta('gamma')).toHaveLength(1000)
    expect(new Set(refusedAtBeta('gamma').map((l) => l.denied))).toEqual(new Set(['shape']))
    expect(betaBox!.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    await sleep(5_000) // the last page's ack goes with beta's next take
    const after = await send('r1a33b2 after full')
    const got = await arrive(1, 30_000)
    expect(got.map((m) => [m.id, m.text])).toEqual([[after, 'r1a33b2 after full']])
    expect(JSON.stringify(got)).not.toContain('gamma')
    process.stderr.write(`(33B-2) (m4) took ${Date.now() - start} ms\n`)
  }, 300_000)

  it('(33B-2) (m5) the signer, not the hub, names the sender: gamma claiming alpha is refused from; gamma as gamma is stored from machine:gamma/owner', async () => {
    const forgedBody = mailBody({ text: 'r1a33b2 forged' })
    const forgedId = JSON.parse(forgedBody).id
    expect((await gammaPut(forgedId, JSON.stringify(signEnvelope(gamma, { from: 'alpha', to: 'beta', body: forgedBody })))).status).toBe(200)
    await until(() => refusedAtBeta('gamma').some((l) => l.id === forgedId), 30_000, 'the forged copy refused')
    expect(refusedAtBeta('gamma').filter((l) => l.id === forgedId).map((l) => l.denied)).toEqual(['from'])
    const goodBody = mailBody({ text: 'r1a33b2 from gamma' })
    const goodId = JSON.parse(goodBody).id
    expect((await gammaPut(goodId, JSON.stringify(signEnvelope(gamma, { from: 'gamma', to: 'beta', body: goodBody })))).status).toBe(200)
    const got = await arrive(1, 30_000)
    expect(got.map((m) => [m.id, m.from, m.text])).toEqual([[goodId, 'machine:gamma/owner', 'r1a33b2 from gamma']])
  }, 90_000)

  it('(33B-2) (m6) levels: ask and interrupt from alpha are refused at beta under its default limits; with interrupt_from listing machine:alpha/owner an interrupt is stored', async () => {
    const ask = await send('r1a33b2 ask', 'ask', { replyByMinutes: 5 })
    const interrupt = await send('r1a33b2 interrupt', 'interrupt')
    await until(() => refusedAtBeta('alpha').filter((l) => [ask, interrupt].includes(l.id)).length === 2, 30_000, 'both refused at beta')
    expect(refusedAtBeta('alpha').filter((l) => [ask, interrupt].includes(l.id)).map((l) => [l.id, l.denied, l.status])).toEqual([
      [ask, 'mailbox', 403], [interrupt, 'mailbox', 403],
    ])
    expect(betaBox!.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    const out = (await call(alphaAgent!, 'mail_read', { box: 'outbox', limit: 500 })) as Json[]
    expect(out.filter((m) => [ask, interrupt].includes(m.id)).map((m) => m.state)).toEqual(['sent', 'sent'])

    await pauseBridge(beta!)
    const file = join(tandemHome(beta!), 'limits.toml')
    writeLimits(tandemHome(beta!), { ...(parse(readFileSync(file, 'utf8')) as Json), interrupt_from: ['machine:alpha/owner'] })
    await restartBridge(beta!)
    const again = await send('r1a33b2 interrupt again', 'interrupt')
    const got = await arrive(1, 30_000)
    expect(got.map((m) => [m.id, m.from, m.level])).toEqual([[again, 'machine:alpha/owner', 'interrupt']])
  }, 120_000)
})
