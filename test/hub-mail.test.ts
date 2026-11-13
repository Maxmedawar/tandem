/**
 * U-R1A-33B-2: mail to another computer (bridge/hub-mail.ts, the carrier in the bridge process,
 * and the mailbox's remote rows), in process against a local node:http fake hub that speaks the
 * 33B-1 routes (POST /__tunnel/mail/put and /__tunnel/mail/take) and records every request.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a33b2-, removed in afterAll: TANDEM_HOME
 * (the roster root+alpha+beta, written through bridge/roster.ts; the limits file; state.db), HOME
 * (the audit log), the device keys of root, alpha, beta and gamma (gamma is not in the roster) and
 * the mailbox files. TMUX is deleted. The clock is fake and is the carrier's only clock.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeLimits } from './fixtures/limits.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a33b2-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a33b2: temp folder is under the real home')
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
mkdirSync(TH, { mode: 0o700 })
mkdirSync(HOME, { mode: 0o700 })
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
process.env.TANDEM_HOME = TH
process.env.HOME = HOME
process.env.TANDEM_HUB_LINK_ID = 'alpha'

const limits = await import('../bridge/limits.ts')
const { openMailbox, MailError } = await import('../bridge/mailbox.ts')
const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { signEnvelope, openEnvelope, openReplayStore, MAX_AGE_CAP_MS, CLOCK_SKEW_MS } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { hubMail, SLOW_DOWN_MS, OUTBOX_TTL_MS, MAIL_POLL_MS, PUSH_EVERY_MS, MAX_PAGES } = await import('../bridge/hub-mail.ts')
const { buildMcpServer } = await import('../src/mcp-server.ts')
const { parseProof, verifyProof } = await import('../hub/src/devices.ts')

const T = 1_800_000_000_000
let clock = T
const now = () => clock
const TOKEN = 'r'.repeat(40)
const PUT = '/__tunnel/mail/put'
const TAKE = '/__tunnel/mail/take'
const SECRET = 'r1a33b2 secret text'
const TO_NAME = 'to: a session name on this computer (A-Z a-z 0-9 . _ -, 1 to 256 bytes, not relay-); nothing was saved'

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const ROOT = key('root')
const A = key('alpha')
const B = key('beta')
const G = key('gamma')
initRoster(ROOT, 'root')
for (const [id, k] of [['alpha', A], ['beta', B]] as const) {
  receiveOffer(JSON.stringify(makeOffer(k, id)))
  trustOffer(ROOT, k.fingerprint)
}

type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
type Answer = { status: number; body: unknown } | 'drop'
const seen: Seen[] = []
let onPut: (put: Json) => Answer = () => ({ status: 200, body: { results: [] } })
let onTake: (() => Answer) | undefined
/** The fake hub's queue for whoever takes (one receiving computer at a time in this file). */
let queue: Json[] = []
let lastSeq = 0
let pageSize = 100
let reverseTake = false
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      let a: Answer
      if (s.path === TAKE && onTake) a = onTake()
      else if (s.path === TAKE) {
        const { ack } = JSON.parse(s.body)
        queue = queue.filter((c) => c.seq > ack)
        const page = queue.slice(0, pageSize)
        a = { status: 200, body: { copies: reverseTake ? [...page].reverse() : page } }
      } else a = onPut(JSON.parse(s.body))
      if (a === 'drop') {
        req.socket.destroy()
        return
      }
      res.writeHead(a.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(a.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(BOX, { recursive: true, force: true })
})

beforeEach(() => {
  clock = T
  seen.length = 0
  onTake = undefined
  pageSize = 100
  reverseTake = false
  rmSync(join(TH, 'limits.toml'), { force: true })
  limits.applyLimits()
})

const cfg = (id: string) => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN, bridgeId: id })
let dbs = 0
const dbPath = () => join(BOX, 'db', String(++dbs), 'state.db')
const boxAt = (path = dbPath()) => openMailbox({ path, now })
const ok = (seq: number, to = 'beta'): Answer => ({ status: 200, body: { results: [{ to, seq }] } })
const stateOf = (box: Json, id: string) => box.sent('owner', 500).find((m: Json) => m.id === id)?.state
const hubSeqOf = (path: string, id: string) => {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('SELECT hub_seq FROM mail_remote WHERE id = ?').get(id) as Json)?.hub_seq
  } finally {
    db.close()
  }
}
const puts = () => seen.filter((s) => s.path === PUT)
const takes = () => seen.filter((s) => s.path === TAKE).map((s) => JSON.parse(s.body).ack)

const auditPath = () => join(process.env.TANDEM_HOME!, 'bridge.log')
const auditLines = (): Json[] => (existsSync(auditPath()) ? readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const mark = () => auditLines().length
const since = (n: number) => auditLines().slice(n)
/** The carrier's own lines (mail.refused, mail.repeat, mail.expired), without the ts. */
const carrierLines = (n: number) =>
  since(n).filter((l) => ['mail.refused', 'mail.repeat', 'mail.expired'].includes(l.event)).map(({ ts: _ts, ...rest }) => rest)

/** The MailError a call throws, as { status, message }; the value when it does not throw. */
function refusal(fn: () => unknown): { status: number; message: string } | unknown {
  try {
    return fn()
  } catch (e) {
    if (e instanceof MailError) return { status: e.status, message: e.message }
    throw e
  }
}

async function proofOk(s: Seen, id: string, publicKey: string): Promise<boolean> {
  const parsed = parseProof(s.headers['tandem-proof'] as string)
  if (!parsed || parsed.id !== id || parsed.key !== publicKey) return false
  const bodySha256 = createHash('sha256').update(s.body).digest('hex')
  return verifyProof(parsed, { host: `127.0.0.1:${port}`, method: 'POST', path: s.path, bodySha256 })
}

/** The body of a mail envelope, as JSON text; `over` replaces or adds fields. */
const mailBody = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'mail', id: `mail-${randomUUID()}`, from: 'owner', to: 'bob', level: 'fyi', text: SECRET, sentAt: clock, ...over })
const envelope = (k: Json, from: string, to: string, body: string, ts = clock) => JSON.stringify(signEnvelope(k, { from, to, body }, ts))
/** A copy in the fake hub's queue, with the next seq. */
function enqueue(c: Json): Json {
  const copy = { id: c.id ?? `mail-${randomUUID()}`, from: 'alpha', room: null, room_seq: null, seq: ++lastSeq, kind: 'message', body: '', ...c }
  queue.push(copy)
  return copy
}

describe('(33B-2) (u1) push: one row at a time, oldest first, to the hub', () => {
  it('(33B-2) a queued row to beta:bob: the put is {id,to:["beta"],body}, its body opens under alpha\'s key for beta; 200 seq 7 -> sent', async () => {
    const path = dbPath()
    const box = boxAt(path)
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const sent = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    expect(sent).toEqual({ id: expect.stringMatching(/^mail-/), to: 'beta:bob', level: 'fyi', state: 'queued', sentAt: T })
    onPut = () => ok(7)
    expect(await mail.pushOnce()).toBe(1)
    expect(puts()).toHaveLength(1)
    const put = JSON.parse(puts()[0].body)
    expect(Object.keys(put).sort()).toEqual(['body', 'id', 'to'])
    expect(put).toEqual({ id: sent.id, to: ['beta'], body: expect.any(String) })
    expect(puts()[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(await proofOk(puts()[0], 'alpha', A.publicKey)).toBe(true)
    const opened = openEnvelope(put.body, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: T, maxAgeMs: MAX_AGE_CAP_MS })
    expect(opened.from).toBe('alpha')
    expect(opened.to).toBe('beta')
    expect(Object.keys(JSON.parse(opened.body)).sort()).toEqual(['from', 'id', 'kind', 'level', 'n', 'sentAt', 'text', 'to', 'v'])
    expect(JSON.parse(opened.body)).toEqual({ v: 2, kind: 'mail', id: sent.id, from: 'owner', to: 'bob', level: 'fyi', text: SECRET, sentAt: T, n: 1 })
    expect(stateOf(box, sent.id)).toBe('sent')
    expect(hubSeqOf(path, sent.id)).toBe(7)
    expect(await mail.pushOnce()).toBe(0)
    expect(puts()).toHaveLength(1)
    box.close()
  })

  it('(33B-2) 200 with queue_full for beta -> queue_full', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const sent = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    onPut = () => ({ status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } })
    expect(await mail.pushOnce()).toBe(1)
    expect(stateOf(box, sent.id)).toBe('queue_full')
    expect(await mail.pushOnce()).toBe(0)
    box.close()
  })

  it('(33B-2) 403 -> refused; 400 -> refused; the next row is still tried in the same pass', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const one = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    const two = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    const answers: Answer[] = [{ status: 403, body: { error: 'not_in_roster' } }, { status: 400, body: { error: 'mail_invalid' } }]
    onPut = () => answers.shift()!
    expect(await mail.pushOnce()).toBe(2)
    expect([stateOf(box, one.id), stateOf(box, two.id)]).toEqual(['refused', 'refused'])
    expect(puts().map((s) => JSON.parse(s.body).id)).toEqual([one.id, two.id])
    box.close()
  })

  it('(33B-2) no answer -> still queued, the pass ends; each retry sends byte-identical text; 401 and 500 keep it queued too', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const one = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    onPut = () => 'drop'
    expect(await mail.pushOnce()).toBe(0)
    expect(puts()).toHaveLength(1) // the pass ended at the first row
    expect(stateOf(box, one.id)).toBe('queued')
    clock += 1000
    for (const answer of [{ status: 401, body: 'unauthorized' }, { status: 500, body: { error: 'x' } }] as Answer[]) {
      onPut = () => answer
      expect(await mail.pushOnce()).toBe(0)
      expect(stateOf(box, one.id)).toBe('queued')
    }
    onPut = () => ok(9)
    expect(await mail.pushOnce()).toBe(2)
    const bodies = puts().filter((s) => JSON.parse(s.body).id === one.id).map((s) => s.body)
    expect(bodies).toHaveLength(4)
    expect(new Set(bodies).size).toBe(1)
    expect(stateOf(box, one.id)).toBe('sent')
    box.close()
  })

  it('(33B-2) 429 -> no call at all (push or pull) until the clock passes SLOW_DOWN_MS', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const one = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    onPut = () => ({ status: 429, body: { error: 'slow_down' } })
    expect(await mail.pushOnce()).toBe(0)
    expect(seen).toHaveLength(1)
    clock = T + SLOW_DOWN_MS - 1
    expect(await mail.pushOnce()).toBe(0)
    expect(await mail.pullOnce()).toBe(0)
    expect(seen).toHaveLength(1)
    clock = T + SLOW_DOWN_MS + 1
    onPut = () => ok(11)
    expect(await mail.pushOnce()).toBe(1)
    expect(seen).toHaveLength(2)
    expect(stateOf(box, one.id)).toBe('sent')
    box.close()
  })

  it('(33B-2) a row queued OUTBOX_TTL_MS + 1 ago -> expired with no call; a younger row is sent', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const old = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    clock = T + OUTBOX_TTL_MS + 1
    const n = mark()
    expect(await mail.pushOnce()).toBe(1)
    expect(seen).toEqual([])
    expect(stateOf(box, old.id)).toBe('expired')
    expect(carrierLines(n)).toEqual([{ event: 'mail.expired', id: old.id }])
    const young = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    onPut = () => ok(12)
    expect(await mail.pushOnce()).toBe(1)
    expect(stateOf(box, young.id)).toBe('sent')
    box.close()
  })

  it('(33B-2) oldest first, one at a time, each to its own computer; local rows never leave', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const local = box.send({ from: 'owner', to: 'bob', level: 'fyi', text: 'stays here' })
    const rows = [0, 1, 2, 3].map((k) => box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: `${SECRET} ${k}` }))
    let next = 20
    onPut = () => ok(next++)
    expect(await mail.pushOnce()).toBe(4)
    expect(puts().map((s) => JSON.parse(s.body).id)).toEqual(rows.map((r) => r.id))
    expect(stateOf(box, local.id)).toBe('queued')
    expect(box.pending('bob')).toEqual({ fyi: 1, ask: 0, interrupt: 0 })
    box.close()
  })

  it('(33B-2) the timing constants', () => {
    expect([MAIL_POLL_MS, PUSH_EVERY_MS, SLOW_DOWN_MS, OUTBOX_TTL_MS, MAX_PAGES]).toEqual([2000, 500, 60_000, 7 * 86_400_000, 10])
  })
})

describe('(33B-2) (u2) pull: each copy checked, stored once, then acked', () => {
  const path = join(BOX, 'beta-box', 'state.db')
  let box: Json
  let mail: Json
  beforeAll(() => {
    process.env.TANDEM_HUB_LINK_ID = 'beta'
    box = boxAt(path)
    mail = hubMail(cfg('beta'), { box, key: B, now })
  })
  afterAll(() => {
    box.close()
    process.env.TANDEM_HUB_LINK_ID = 'alpha'
  })

  /** One copy through one pull: the pull handled it and the pull's last take acked its seq. */
  async function pullOne(c: Json): Promise<{ copy: Json; lines: Json[] }> {
    const n = mark()
    const copy = enqueue(c)
    seen.length = 0
    expect(await mail.pullOnce()).toBe(1)
    expect(takes().at(-1)).toBe(copy.seq)
    return { copy, lines: carrierLines(n) }
  }
  const refusedAs = async (c: Json, denied: string, status?: number) => {
    const { copy, lines } = await pullOne(c)
    expect(lines).toEqual([{ event: 'mail.refused', from: copy.from, id: copy.id, denied, ...(status ? { status } : {}) }])
  }

  it('(33B-2) a good copy -> one inbox message from machine:alpha/owner with the sender\'s id; the same copy again -> mail.repeat, still one', async () => {
    const body = mailBody()
    const id = JSON.parse(body).id
    const text = envelope(A, 'alpha', 'beta', body)
    const first = await pullOne({ id, body: text })
    expect(first.lines).toEqual([])
    expect(box.pending('bob')).toEqual({ fyi: 1, ask: 0, interrupt: 0 })
    const again = await pullOne({ id, body: text })
    expect(again.lines).toEqual([{ event: 'mail.repeat', from: 'alpha', id }])
    expect(box.pending('bob')).toEqual({ fyi: 1, ask: 0, interrupt: 0 })
    expect(box.read('bob', 50)).toEqual([{ id, from: 'machine:alpha/owner', to: 'bob', level: 'fyi', text: SECRET, state: 'delivered', sentAt: T, deliveredAt: T }])
  })

  it('(33B-2) a retried put (the hub queues it twice) and a re-signed envelope with the same id: stored once, then mail.repeat', async () => {
    const body = mailBody()
    const id = JSON.parse(body).id
    const text = envelope(A, 'alpha', 'beta', body)
    const n = mark()
    enqueue({ id, body: text })
    enqueue({ id, body: text })
    enqueue({ id, body: envelope(A, 'alpha', 'beta', body) })
    expect(await mail.pullOnce()).toBe(3)
    expect(carrierLines(n)).toEqual([{ event: 'mail.repeat', from: 'alpha', id }, { event: 'mail.repeat', from: 'alpha', id }])
    expect(box.read('bob', 50).map((m: Json) => m.id)).toEqual([id])
  })

  it('(33B-2) a body that is not an envelope -> refused shape', async () => {
    await refusedAs({ body: 'not an envelope' }, 'shape')
  })

  it('(33B-2) an envelope to gamma -> refused to', async () => {
    await refusedAs({ body: envelope(A, 'alpha', 'gamma', mailBody()) }, 'to')
  })

  it('(33B-2) the hub names alpha while gamma signed as gamma -> refused from', async () => {
    await refusedAs({ from: 'alpha', body: envelope(G, 'gamma', 'beta', mailBody()) }, 'from')
  })

  it('(33B-2) A3.16 a hub that forges a sender: an envelope from alpha signed with gamma\'s key, copy.from alpha -> refused signature', async () => {
    await refusedAs({ from: 'alpha', body: envelope(G, 'alpha', 'beta', mailBody()) }, 'signature')
  })

  it('(33B-2) an old ts -> refused time', async () => {
    await refusedAs({ body: envelope(A, 'alpha', 'beta', mailBody(), T - MAX_AGE_CAP_MS - 1) }, 'time')
  })

  it('(33B-2) a changed body -> refused body', async () => {
    const e = signEnvelope(A, { from: 'alpha', to: 'beta', body: mailBody() }, T)
    await refusedAs({ body: JSON.stringify({ ...e, body: mailBody({ text: 'changed' }) }) }, 'body')
  })

  it('(33B-2) a copy from a computer outside the roster -> refused unknown_sender', async () => {
    await refusedAs({ from: 'gamma', body: envelope(G, 'gamma', 'beta', mailBody()) }, 'unknown_sender')
  })

  it('(33B-2) a signed body without exactly the named keys and types, or a sender that is not local -> refused shape', async () => {
    const good = JSON.parse(mailBody())
    const { sentAt: _drop, ...noSentAt } = good
    for (const body of [
      'not json',
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify(noSentAt),
      JSON.stringify({ ...good, kind: 'presence' }),
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, from: 'machine:alpha/owner' }),
      JSON.stringify({ ...good, sentAt: '1' }),
      JSON.stringify({ ...good, replyBy: T }),
    ]) {
      await refusedAs({ body: envelope(A, 'alpha', 'beta', body) }, 'shape')
    }
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
  })

  it('(33B-2) an ask -> refused mailbox 403 with the control_from text', async () => {
    const body = mailBody({ level: 'ask', replyBy: T + 600_000 })
    await refusedAs({ body: envelope(A, 'alpha', 'beta', body) }, 'mailbox', 403)
    const b = JSON.parse(body)
    expect(refusal(() => box.receive({ ...b, from: 'machine:alpha/owner' }))).toEqual({
      status: 403, message: 'control_from: alpha may not send Ask here (limits file); nothing was saved',
    })
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
  })

  it('(33B-2) an interrupt with no interrupt_from -> refused mailbox 403 with the interrupt_from text', async () => {
    const body = mailBody({ level: 'interrupt' })
    await refusedAs({ body: envelope(A, 'alpha', 'beta', body) }, 'mailbox', 403)
    const b = JSON.parse(body)
    expect(refusal(() => box.receive({ ...b, from: 'machine:alpha/owner' }))).toEqual({
      status: 403, message: 'interrupt_from: machine:alpha/owner may not send Interrupt (limits file); nothing was saved',
    })
  })

  it('(33B-2) a text with U+202E -> refused mailbox 400', async () => {
    await refusedAs({ body: envelope(A, 'alpha', 'beta', mailBody({ text: 'a‮b' })) }, 'mailbox', 400)
  })

  it('(33B-2) a full inbox -> refused mailbox 429', async () => {
    for (let k = 0; k < 1000; k++) box.send({ from: 'owner', to: 'full', level: 'fyi', text: `m${k}` })
    await refusedAs({ body: envelope(A, 'alpha', 'beta', mailBody({ to: 'full' })) }, 'mailbox', 429)
    expect(box.pending('full').fyi).toBe(1000)
  })

  it('(33B-2) interrupt_from ["machine:alpha/session:lead"]: an interrupt from alpha\'s session:lead is stored, one from owner refused', async () => {
    writeLimits(TH, { interrupt_from: ['machine:alpha/session:lead'] })
    limits.applyLimits()
    const lead = mailBody({ level: 'interrupt', from: 'session:lead', to: 'boss' })
    expect((await pullOne({ body: envelope(A, 'alpha', 'beta', lead) })).lines).toEqual([])
    await refusedAs({ body: envelope(A, 'alpha', 'beta', mailBody({ level: 'interrupt', to: 'boss' })) }, 'mailbox', 403)
    expect(box.read('boss', 50).map((m: Json) => [m.from, m.level])).toEqual([['machine:alpha/session:lead', 'interrupt']])
  })

  it('(33B-2) an expired copy for a sent row -> expired; for an unknown id -> nothing changes', async () => {
    const out = box.send({ from: 'owner', to: 'alpha:bob', level: 'fyi', text: SECRET })
    expect(box.markRemote(out.id, 'sent', 3)).toBe(true)
    const { lines } = await pullOne({ id: out.id, kind: 'expired', from: 'alpha', body: '' })
    expect(lines).toEqual([{ event: 'mail.expired', id: out.id }])
    expect(stateOf(box, out.id)).toBe('expired')
    const before = box.sent('owner', 500)
    const unknown = await pullOne({ id: `mail-${randomUUID()}`, kind: 'expired', from: 'alpha', body: '' })
    expect(unknown.lines).toEqual([])
    expect(box.sent('owner', 500)).toEqual(before)
  })

  it('(33B-2) copies are handled in seq order whatever order the hub lists them; a refused copy is acked and never blocks the next', async () => {
    reverseTake = true
    const ids = [0, 1, 2].map(() => `mail-${randomUUID()}`)
    enqueue({ id: ids[0], body: envelope(A, 'alpha', 'beta', mailBody({ id: ids[0], text: 'o1', to: 'order' })) })
    const bad = enqueue({ body: 'not an envelope' })
    enqueue({ id: ids[1], body: envelope(A, 'alpha', 'beta', mailBody({ id: ids[1], text: 'o2', to: 'order' })) })
    const last = enqueue({ id: ids[2], body: envelope(A, 'alpha', 'beta', mailBody({ id: ids[2], text: 'o3', to: 'order' })) })
    seen.length = 0
    expect(await mail.pullOnce()).toBe(4)
    expect(takes().at(-1)).toBe(last.seq)
    expect(takes().at(-1)).toBeGreaterThan(bad.seq)
    expect(box.read('order', 50).map((m: Json) => m.text)).toEqual(['o1', 'o2', 'o3'])
  })

  it('(33B-2) at most MAX_PAGES takes per pull; the rest come with the next pull', async () => {
    pageSize = 3
    for (let k = 0; k < 40; k++) enqueue({ body: 'not an envelope' })
    seen.length = 0
    expect(await mail.pullOnce()).toBe(30)
    expect(takes()).toHaveLength(MAX_PAGES)
    expect(await mail.pullOnce()).toBe(10)
    expect(queue).toEqual([])
  })

  it('(33B-2) a take the hub refuses (500) or never answers: nothing handled, the cursor unchanged', async () => {
    const c = enqueue({ body: envelope(A, 'alpha', 'beta', mailBody({ to: 'kept' })) })
    onTake = () => ({ status: 500, body: { error: 'x' } })
    expect(await mail.pullOnce()).toBe(0)
    onTake = () => 'drop'
    expect(await mail.pullOnce()).toBe(0)
    onTake = undefined
    seen.length = 0
    expect(await mail.pullOnce()).toBe(1)
    expect(takes().at(-1)).toBe(c.seq)
    expect(box.pending('kept').fyi).toBe(1)
  })

  it('(33B-2) no audit line holds message text', () => {
    const log = readFileSync(auditPath(), 'utf8')
    expect(log).not.toContain(SECRET)
    expect(log).toContain('"event":"mail.refused"')
  })
})

describe('(33B-2) (u3) (b) one clock for the replay sweep and the envelope check', () => {
  it('(33B-2) stored at T; repeat at T + 1 h; refused time past ts + MAX_AGE_CAP_MS + CLOCK_SKEW_MS and held once; the next good copy sweeps the old nonce', async () => {
    const home = join(BOX, 'u3')
    mkdirSync(join(home, 'roster'), { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    copyFileSync(join(TH, 'roster', 'roster.json'), join(home, 'roster', 'roster.json'))
    chmodSync(join(home, 'roster', 'roster.json'), 0o600)
    process.env.TANDEM_HOME = home
    try {
      queue = []
      const box = boxAt(join(home, 'state.db'))
      const mail = hubMail(cfg('beta'), { box, key: B, now })
      const body = mailBody({ to: 'clock' })
      const id = JSON.parse(body).id
      const text = envelope(A, 'alpha', 'beta', body, T)
      let n = mark()
      enqueue({ id, body: text })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([])
      clock = T + 3_600_000
      n = mark()
      enqueue({ id, body: text })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([{ event: 'mail.repeat', from: 'alpha', id }])
      clock = T + MAX_AGE_CAP_MS + CLOCK_SKEW_MS + 1
      n = mark()
      enqueue({ id, body: text })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([{ event: 'mail.refused', from: 'alpha', id, denied: 'time' }])
      expect(box.pending('clock').fyi).toBe(1)
      n = mark()
      enqueue({ body: envelope(A, 'alpha', 'beta', mailBody({ to: 'clock' }), clock) })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([])
      expect(box.pending('clock').fyi).toBe(2)
      const store = openReplayStore({ path: join(home, 'state.db') })
      try {
        expect(store.size()).toBe(1)
      } finally {
        store.close()
      }
      box.close()
    } finally {
      process.env.TANDEM_HOME = TH
    }
  })
})

describe('(33B-2) (u4) (d) remote senders: a form only the carrier makes', () => {
  it('(33B-2) a local send with from machine:alpha/owner -> 400; receive refuses a local sender and a bad id', () => {
    const box = boxAt()
    expect(refusal(() => box.send({ from: 'machine:alpha/owner', to: 'bob', level: 'fyi', text: 'x' }))).toEqual({
      status: 400, message: 'from: owner or session:<name>; nothing was saved',
    })
    const good = { id: `mail-${randomUUID()}`, from: 'machine:alpha/owner', to: 'bob', level: 'fyi' as const, text: 'x', sentAt: T }
    expect(refusal(() => box.receive({ ...good, from: 'owner' }))).toEqual({ status: 400, message: 'from: machine:<id>/owner or machine:<id>/session:<name>; nothing was saved' })
    expect(refusal(() => box.receive({ ...good, from: 'machine:Alpha/owner' }))).toEqual({ status: 400, message: 'from: machine:<id>/owner or machine:<id>/session:<name>; nothing was saved' })
    expect(refusal(() => box.receive({ ...good, id: 'mail-1' }))).toEqual({ status: 400, message: 'id: mail-<uuid>; nothing was saved' })
    expect(refusal(() => box.receive({ ...good, to: 'beta:bob' }))).toEqual({ status: 400, message: TO_NAME })
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    expect(box.receive(good)).toBe('stored')
    expect(box.receive(good)).toBe('repeat')
    expect(box.pending('bob')).toEqual({ fyi: 1, ask: 0, interrupt: 0 })
    box.close()
  })

  it('(33B-2) interrupt_from ["machine:Alpha/owner"] or ["machine:alpha/"] refuses the whole file; ["machine:alpha/owner","owner"] applies', () => {
    const TEXT = 'wrong type for interrupt_from: expected an array of "owner", "session:<name>", "machine:<id>/owner" or "machine:<id>/session:<name>"'
    for (const bad of [['machine:Alpha/owner'], ['machine:alpha/']]) {
      writeLimits(TH, { interrupt_from: bad, shell: true })
      limits.applyLimits()
      const snap = limits.limitsSnapshot()
      expect([JSON.stringify(bad), snap.problem]).toEqual([JSON.stringify(bad), expect.stringContaining(TEXT)])
      expect(snap.shell).toBe(false)
      expect('interrupt_from' in snap).toBe(false)
    }
    writeLimits(TH, { interrupt_from: ['machine:alpha/owner', 'owner'] })
    limits.applyLimits()
    const snap = limits.limitsSnapshot()
    expect(snap.problem).toBeUndefined()
    expect(snap.interrupt_from).toEqual(['machine:alpha/owner', 'owner'])
    expect(limits.isMailSender('machine:alpha/owner')).toBe(false)
    expect(['machine:alpha/owner', 'machine:a.b-c_9/session:x', 'owner', 'session:x'].map(limits.isInterruptSender)).toEqual([true, true, true, true])
    expect(['machine:alpha/owner', 'machine:a/session:x'].map(limits.isRemoteSender)).toEqual([true, true])
    expect(['machine:/owner', 'machine:alpha/session:', 'machine:alpha/session:a b', 'machine:alpha:owner', 'owner'].map(limits.isRemoteSender)).toEqual([false, false, false, false, false])
  })

  it('(33B-2) markRemote: sent, queue_full and refused only from queued; expired from queued or sent; never a local row', () => {
    const box = boxAt()
    const r = () => box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'x' }).id
    const local = box.send({ from: 'owner', to: 'bob', level: 'fyi', text: 'x' }).id
    const [a, b, c, d] = [r(), r(), r(), r()]
    expect(box.outgoing(50).map((m: Json) => m.id)).toEqual([a, b, c, d])
    expect(box.markRemote(a, 'sent', 1)).toBe(true)
    expect(box.markRemote(a, 'refused')).toBe(false)
    expect(box.markRemote(a, 'expired')).toBe(true)
    expect(box.markRemote(b, 'queue_full')).toBe(true)
    expect(box.markRemote(b, 'expired')).toBe(false)
    expect(box.markRemote(c, 'refused')).toBe(true)
    expect(box.markRemote(c, 'sent', 2)).toBe(false)
    expect(box.markRemote(local, 'sent', 3)).toBe(false)
    expect(box.markRemote(local, 'expired')).toBe(false)
    expect(box.outgoing(50).map((m: Json) => m.id)).toEqual([d])
    expect(box.envelopeOf(d)).toBeUndefined()
    box.keepEnvelope(d, 'first')
    box.keepEnvelope(d, 'second')
    expect(box.envelopeOf(d)).toBe('first')
    box.close()
  })
})

describe('(33B-2) (u5) mail_send to <computer>:<session> through the MCP tool', () => {
  async function connect(mail: Json) {
    const server = await buildMcpServer(undefined, undefined, mail)
    const client = new Client({ name: 'r1a33b2', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client, close: async () => { await client.close(); await server.close() } }
  }
  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Json> {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse((result.content as { text: string }[])[0].text)
  }

  it('(33B-2) beta:bob queued; this computer, a computer outside the roster, relay- and a capital computer refused with their exact texts; a remote interrupt is queued', async () => {
    const box = boxAt()
    const m = await connect(box)
    try {
      expect(await call(m.client, 'mail_send', { to: 'beta:bob', level: 'fyi', text: 'far' })).toEqual({
        id: expect.stringMatching(/^mail-/), to: 'beta:bob', level: 'fyi', state: 'queued', sentAt: T,
      })
      expect(await call(m.client, 'mail_send', { to: 'alpha:bob', level: 'fyi', text: 'far' })).toEqual({
        error: 'to: alpha is this computer; use the bare session name; nothing was saved',
      })
      expect(await call(m.client, 'mail_send', { to: 'zeta:bob', level: 'fyi', text: 'far' })).toEqual({
        error: "to: computer zeta is not in this computer's roster; nothing was saved",
      })
      for (const to of ['beta:relay-x', 'Beta:bob', 'beta:', ':bob', 'beta:a b']) {
        expect([to, await call(m.client, 'mail_send', { to, level: 'fyi', text: 'far' })]).toEqual([to, { error: TO_NAME }])
      }
      const interrupt = await call(m.client, 'mail_send', { to: 'beta:bob', level: 'interrupt', text: 'stop' })
      expect(interrupt).toEqual({ id: expect.stringMatching(/^mail-/), to: 'beta:bob', level: 'interrupt', state: 'queued', sentAt: T })
      expect(box.outgoing(50)).toHaveLength(2)
      for (const to of ['beta:bob', 'alpha:bob']) expect(refusal(() => box.pending(to))).toEqual({ status: 400, message: TO_NAME })
      expect(refusal(() => box.read('beta:bob', 5))).toEqual({ status: 400, message: TO_NAME })
    } finally {
      await m.close()
      box.close()
    }
  })

  it('(33B-2) mail_read outbox shows sent, queue_full, refused and expired for mail to another computer', async () => {
    const box = boxAt()
    const m = await connect(box)
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    try {
      const ids: string[] = []
      for (let k = 0; k < 4; k++) ids.push((await call(m.client, 'mail_send', { to: 'beta:bob', level: 'fyi', text: `o${k}` })).id)
      const answers: Answer[] = [ok(1), { status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } }, { status: 403, body: { error: 'not_in_roster' } }, ok(2)]
      onPut = () => answers.shift()!
      expect(await mail.pushOnce()).toBe(4)
      expect(box.markRemote(ids[3], 'expired')).toBe(true)
      const out = await call(m.client, 'mail_read', { box: 'outbox' })
      expect(out.map((x: Json) => [x.id, x.to, x.state])).toEqual([
        [ids[0], 'beta:bob', 'sent'], [ids[1], 'beta:bob', 'queue_full'], [ids[2], 'beta:bob', 'refused'], [ids[3], 'beta:bob', 'expired'],
      ])
    } finally {
      await m.close()
      box.close()
    }
  })
})

describe('(33B-2) (audit) fail-safe rows added by the audit', () => {
  const copyHome = (name: string) => {
    const home = join(BOX, name)
    mkdirSync(join(home, 'roster'), { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    copyFileSync(join(TH, 'roster', 'roster.json'), join(home, 'roster', 'roster.json'))
    chmodSync(join(home, 'roster', 'roster.json'), 0o600)
    return home
  }

  it('(33B-2) (audit) a store failure that is not a refusal (SQLite busy) or a stop between the check and the store loses nothing: the copy is not acked and the next take stores it once', async () => {
    const home = copyHome('audit-store')
    process.env.TANDEM_HOME = home
    process.env.TANDEM_HUB_LINK_ID = 'beta'
    try {
      queue = []
      const box = boxAt(join(home, 'state.db'))
      let failures = 2
      const flaky = { ...box, receive: (input: Json) => {
        if (failures-- > 0) throw new Error('database is locked')
        return box.receive(input)
      } }
      const body = mailBody({ to: 'busy' })
      const id = JSON.parse(body).id
      const before = enqueue({ body: envelope(A, 'alpha', 'beta', mailBody({ to: 'busy', text: 'first' })) })
      const c = enqueue({ id, body: envelope(A, 'alpha', 'beta', body) })
      // The default replay store (state.db): what a restarted bridge would find.
      const first = hubMail(cfg('beta'), { box: flaky, key: B, now })
      failures = 0
      onTake = () => ({ status: 200, body: { copies: [before] } })
      expect(await first.pullOnce()).toBe(1)
      onTake = undefined
      failures = 2
      seen.length = 0
      await expect(first.pullOnce()).rejects.toThrow('database is locked')
      expect(takes()).toEqual([before.seq]) // never acked above what is stored
      expect(box.pending('busy').fyi).toBe(1)
      // The bridge stops here and starts again: a new carrier, cursor 0, the same state.db.
      const second = hubMail(cfg('beta'), { box: flaky, key: B, now })
      await expect(second.pullOnce()).rejects.toThrow('database is locked')
      const n = mark()
      seen.length = 0
      expect(await second.pullOnce()).toBe(1)
      expect(takes().at(-1)).toBe(c.seq)
      expect(carrierLines(n)).toEqual([])
      expect(box.read('busy', 50).map((m: Json) => m.text)).toEqual(['first', SECRET])
      // Stored once: the same copy again is a repeat, and the nonce is kept now.
      const again = mark()
      enqueue({ id, body: c.body })
      expect(await second.pullOnce()).toBe(1)
      expect(carrierLines(again)).toEqual([{ event: 'mail.repeat', from: 'alpha', id }])
      expect(box.pending('busy').fyi).toBe(0)
      box.close()
    } finally {
      process.env.TANDEM_HOME = TH
      process.env.TANDEM_HUB_LINK_ID = 'alpha'
    }
  })

  it('(33B-2) (audit) a copy the mailbox refused stays refused: its replay is a repeat even after interrupt_from lists the sender', async () => {
    const home = copyHome('audit-refused')
    process.env.TANDEM_HOME = home
    process.env.TANDEM_HUB_LINK_ID = 'beta'
    try {
      queue = []
      limits.applyLimits()
      const box = boxAt(join(home, 'state.db'))
      const mail = hubMail(cfg('beta'), { box, key: B, now })
      const body = mailBody({ to: 'late', level: 'interrupt' })
      const id = JSON.parse(body).id
      const text = envelope(A, 'alpha', 'beta', body)
      let n = mark()
      enqueue({ id, body: text })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([{ event: 'mail.refused', from: 'alpha', id, denied: 'mailbox', status: 403 }])
      writeLimits(home, { interrupt_from: ['machine:alpha/owner'] })
      limits.applyLimits()
      n = mark()
      enqueue({ id, body: text })
      expect(await mail.pullOnce()).toBe(1)
      expect(carrierLines(n)).toEqual([{ event: 'mail.repeat', from: 'alpha', id }])
      expect(box.pending('late')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
      box.close()
    } finally {
      process.env.TANDEM_HOME = TH
      process.env.TANDEM_HUB_LINK_ID = 'alpha'
      limits.applyLimits()
    }
  })

  it('(33B-2) (audit) a signed sentAt no date can show is refused (a roster member cannot break the label), and nothing is stored', async () => {
    const home = copyHome('audit-date')
    process.env.TANDEM_HOME = home
    process.env.TANDEM_HUB_LINK_ID = 'beta'
    try {
      queue = []
      const box = boxAt(join(home, 'state.db'))
      const mail = hubMail(cfg('beta'), { box, key: B, now })
      for (const sentAt of [8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
        const body = mailBody({ to: 'date', sentAt })
        const id = JSON.parse(body).id
        const n = mark()
        enqueue({ id, body: envelope(A, 'alpha', 'beta', body) })
        expect(await mail.pullOnce()).toBe(1)
        expect(carrierLines(n)).toEqual([{ event: 'mail.refused', from: 'alpha', id, denied: 'mailbox', status: 400 }])
      }
      expect(box.pending('date').fyi).toBe(0)
      const edge = mailBody({ to: 'date', sentAt: 8_640_000_000_000_000 })
      enqueue({ id: JSON.parse(edge).id, body: envelope(A, 'alpha', 'beta', edge) })
      expect(await mail.pullOnce()).toBe(1)
      expect(box.read('date', 50).map((m: Json) => new Date(m.sentAt).toISOString())).toHaveLength(1)
      box.close()
    } finally {
      process.env.TANDEM_HOME = TH
      process.env.TANDEM_HUB_LINK_ID = 'alpha'
    }
  })

  it('(33B-2) (audit) a row that waited is signed again at its push, so the hub\'s 7 days fit the receiver\'s window; sentAt and id never change; a quick retry is byte-identical', async () => {
    const box = boxAt()
    const mail = hubMail(cfg('alpha'), { box, key: A, now })
    const one = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: SECRET })
    onPut = () => 'drop'
    expect(await mail.pushOnce()).toBe(0)
    clock = T + 60_000
    expect(await mail.pushOnce()).toBe(0)
    clock = T + 6 * 86_400_000
    expect(await mail.pushOnce()).toBe(0)
    onPut = () => ok(3)
    clock += 1000
    expect(await mail.pushOnce()).toBe(1)
    const sentEnvelopes = puts().map((s) => JSON.parse(JSON.parse(s.body).body))
    expect(sentEnvelopes.map((e: Json) => e.ts)).toEqual([T, T, T + 6 * 86_400_000, T + 6 * 86_400_000])
    expect(puts()[0].body).toBe(puts()[1].body)
    expect(puts()[2].body).toBe(puts()[3].body)
    for (const e of sentEnvelopes) expect(JSON.parse(e.body)).toMatchObject({ id: one.id, sentAt: T, text: SECRET })
    // The receiver takes it on the hub's last day: still inside its window.
    const opened = openEnvelope(sentEnvelopes[3], { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock + 7 * 86_400_000, maxAgeMs: MAX_AGE_CAP_MS })
    expect(JSON.parse(opened.body).id).toBe(one.id)
    box.close()
  })

  it('(33B-2) (audit) a hub that keeps failing is asked less and less: no 2-a-second retry that would spend the proof allowance', async () => {
    const home = copyHome('audit-backoff')
    process.env.TANDEM_HOME = home
    try {
      const box = openMailbox({ path: join(home, 'state.db') })
      box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'x' })
      onPut = () => ({ status: 500, body: { error: 'x' } })
      onTake = () => ({ status: 401, body: 'unauthorized' })
      const mute = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stop = hubMail(cfg('alpha'), { box, key: A }).start()
      await new Promise((resolve) => setTimeout(resolve, 3200))
      stop()
      const lines = mute.mock.calls.map((c) => String(c[0]))
      mute.mockRestore()
      // Without a back-off: 6 puts in 3.2 s (every 500 ms). With it: 0.5 s, then 1 s later, then 2 s later.
      expect(puts().length).toBeGreaterThanOrEqual(1)
      expect(puts().length).toBeLessThanOrEqual(3)
      expect(seen.filter((s) => s.path === TAKE).length).toBe(1)
      expect(lines.sort()).toEqual(['hub mail: pull failed: 401\n', 'hub mail: push failed: 500\n'])
      box.close()
    } finally {
      process.env.TANDEM_HOME = TH
    }
  })

  it('(33B-2) (audit) no local caller spells a remote sender, and a remote address is one computer id, one colon, one session name', () => {
    const box = boxAt()
    for (const from of ['machine:alpha/owner', 'machine:alpha/owner\n', 'Machine:alpha/owner', 'MACHINE:alpha/owner', 'session:machine:alpha/owner', 'session:a/owner',
      'machine:alpha/session:lead', 'owner\nmachine:alpha/owner', 'machine：alpha/owner', 'mаchine:alpha/owner', ' machine:alpha/owner']) {
      expect([from, refusal(() => box.send({ from, to: 'bob', level: 'fyi', text: 'x' }))]).toEqual([from, { status: 400, message: 'from: owner or session:<name>; nothing was saved' }])
    }
    for (const v of ['machine:alpha/owner\n', 'machine:alpha/Owner', 'machine:alpha/session:', 'machine:alpha/session:a/b', 'machine:alpha:beta/owner', 'machine:/owner', 'machine:alpha/owner/owner', `machine:${'a'.repeat(65)}/owner`, 'machine:alphа/owner']) {
      expect([v, limits.isRemoteSender(v), limits.isInterruptSender(v)]).toEqual([v, false, false])
    }
    for (const to of ['beta:bob:x', ':bob', 'beta:', 'beta:relay-x', 'BETA:bob', 'bеta:bob', `${'a'.repeat(65)}:bob`, 'beta:bob\n', 'beta :bob', 'beta:b ob', 'beta::bob', 'beta/bob:x']) {
      expect([to, refusal(() => box.send({ from: 'owner', to, level: 'fyi', text: 'x' }))]).toEqual([to, { status: 400, message: TO_NAME }])
    }
    for (const read of [() => box.pending('beta:bob'), () => box.claim('beta:bob', 'idle'), () => box.read('beta:bob', 5), () => box.noticeFor('beta:bob'), () => box.interruptFor('beta:bob')]) {
      expect(refusal(read)).toEqual({ status: 400, message: TO_NAME })
    }
    expect(box.sent('owner', 50)).toEqual([])
    box.close()
  })

  it('(33B-2) (audit) a remote Interrupt presses the key only while interrupt_from lists its sender, and waits out the cool-down like a local one', () => {
    const box = boxAt()
    const receive = (k: number) => box.receive({ id: `mail-${randomUUID()}`, from: 'machine:alpha/owner', to: 'press', level: 'interrupt', text: `stop ${k}`, sentAt: clock })
    try {
      writeLimits(TH, { interrupt_from: ['machine:alpha/owner'] })
      limits.applyLimits()
      expect(receive(1)).toBe('stored')
      expect(refusal(() => box.receive({ id: `mail-${randomUUID()}`, from: 'machine:alpha/session:lead', to: 'press', level: 'interrupt', text: 'x', sentAt: clock })))
        .toEqual({ status: 403, message: 'interrupt_from: machine:alpha/session:lead may not send Interrupt (limits file); nothing was saved' })
      expect(box.interruptFor('press', 10_000)).toBe(true)
      expect(receive(2)).toBe('stored')
      clock += 9_999
      expect(box.interruptFor('press', 10_000)).toBe(false)
      clock += 1
      // The sender is taken out before the key: nothing is pressed (the press-time check).
      writeLimits(TH, { interrupt_from: ['owner'] })
      limits.applyLimits()
      expect(box.interruptFor('press', 10_000)).toBe(false)
      writeLimits(TH, { interrupt_from: ['machine:alpha/owner'] })
      limits.applyLimits()
      expect(box.interruptFor('press', 10_000)).toBe(true)
    } finally {
      box.close()
    }
  })
})
