/**
 * U-R1A-33B-4: the sender signs the mail order (bridge/hub-mail.ts, bridge/mailbox.ts).
 *
 * (o) a v:2 mail body carries `n`, one counter per `<computer>:<session>`; the receiver stores one
 * sender computer's mail to one session in n order only, holds an early copy up to GAP_HOLD_MS,
 * then writes `mail.gap` plus an inbox notice; a copy after its gap is dropped as `mail.late`.
 * (g) gap edges. (e) the ack cursor kept in state.db with the hub queue's epoch.
 *
 * In process against a local node:http fake hub (127.0.0.1, port 0) that queues puts per
 * receiving computer (the proof names the caller), honours `ack` on a take and, where a row says,
 * the hub's EPOCH rule (it can be wiped: new epoch, seqs from 1, queue empty). Every request is
 * recorded. Every folder is under one mkdtemp folder in TMPDIR named r1a33b4-, removed in afterAll:
 * HOME, TANDEM_HOME (HOME/.tandem: the roster root+alpha+beta+gamma, the audit log, the replay
 * store) and the state.db files. TMUX is deleted. The clock is fake and is the carriers' only
 * clock; no case asserts a wall-clock bound.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a33b4-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a33b4: temp folder is under the real home')
const HOME = join(BOX, 'home')
const TH = join(HOME, '.tandem')
mkdirSync(HOME, { mode: 0o700 })
mkdirSync(TH, { mode: 0o700 })
delete process.env.TMUX
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.TANDEM_HUB_LINK_ID = 'alpha'

const limits = await import('../bridge/limits.ts')
const mailbox = await import('../bridge/mailbox.ts')
const { openMailbox } = mailbox
const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { signEnvelope, openEnvelope, MAX_AGE_CAP_MS } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const hm = await import('../bridge/hub-mail.ts')
const { hubMail } = hm
const { parseProof } = await import('../hub/src/devices.ts')

const T = 1_800_000_000_000
let clock = T
const now = () => clock
const TOKEN = 'o'.repeat(40)
const PUT = '/__tunnel/mail/put'
const TAKE = '/__tunnel/mail/take'
const GAP = 30_000

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const ROOT = key('root')
const A = key('alpha')
const B = key('beta')
const G = key('gamma')
initRoster(ROOT, 'root')
// gamma IS a member here (o8).
for (const [id, k] of [['alpha', A], ['beta', B], ['gamma', G]] as const) {
  receiveOffer(JSON.stringify(makeOffer(k, id)))
  trustOffer(ROOT, k.fingerprint)
}

type Copy = { id: string; from: string; room: null; room_seq: null; seq: number; kind: string; body: string }
type Answer = { status: number; body: unknown }
type Seen = { path: string; caller: string; body: string }

/** The fake hub: one queue per receiving computer, the EPOCH rule when `epochRule` is on. */
const hub = {
  epoch: randomBytes(16).toString('base64url'),
  epochRule: false,
  /** Any take carrying an `epoch` key is refused 400 mail_invalid (an older hub). */
  refuseEpoch: false,
  /** An ack deletes nothing (as if the ack never reached the store). */
  ackKeeps: false,
  queues: new Map<string, Copy[]>(),
  last: new Map<string, number>(),
  /** Copies an ack deleted that no take page ever handed out. */
  unread: [] as string[],
  handed: new Set<string>(),
  onTake: undefined as ((req: Json) => Answer | undefined) | undefined,
  onPut: undefined as ((put: Json) => Answer | 'drop' | undefined) | undefined,
  pageSize: 100,
}
const seen: Seen[] = []
let server: Server
let port = 0

const queueOf = (to: string) => {
  if (!hub.queues.has(to)) hub.queues.set(to, [])
  return hub.queues.get(to)!
}
function hubPut(to: string, c: Omit<Copy, 'seq' | 'room' | 'room_seq'>, seq?: number): Copy {
  const next = seq ?? (hub.last.get(to) ?? 0) + 1
  hub.last.set(to, Math.max(next, hub.last.get(to) ?? 0))
  const copy: Copy = { room: null, room_seq: null, seq: next, ...c }
  queueOf(to).push(copy)
  return copy
}
function hubAck(to: string, ack: number): void {
  if (hub.ackKeeps) return
  const q = queueOf(to)
  for (const c of q) if (c.seq <= ack && !hub.handed.has(`${to}/${c.seq}/${c.id}`)) hub.unread.push(c.id)
  hub.queues.set(to, q.filter((c) => c.seq > ack))
}
function hubPage(to: string, after: number): Copy[] {
  const page = queueOf(to).filter((c) => c.seq > after).sort((a, b) => a.seq - b.seq).slice(0, hub.pageSize)
  for (const c of page) hub.handed.add(`${to}/${c.seq}/${c.id}`)
  return page
}
/** Wiped storage: a new epoch, every queue empty, numbers from 1 again. */
function wipe(): void {
  hub.epoch = randomBytes(16).toString('base64url')
  hub.queues.clear()
  hub.last.clear()
  hub.handed.clear()
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const caller = parseProof(req.headers['tandem-proof'] as string)?.id ?? ''
      const s: Seen = { path: req.url ?? '', caller, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      let a: Answer | 'drop' | undefined
      const body = JSON.parse(s.body)
      if (s.path === TAKE) {
        a = hub.onTake?.(body)
        if (!a && hub.refuseEpoch && Object.hasOwn(body, 'epoch')) a = { status: 400, body: { error: 'mail_invalid' } }
        if (!a && hub.epochRule && Object.hasOwn(body, 'epoch')) {
          if (body.epoch === hub.epoch) {
            hubAck(caller, body.ack)
            a = { status: 200, body: { copies: hubPage(caller, body.ack), epoch: hub.epoch } }
          } else {
            a = { status: 200, body: { copies: hubPage(caller, 0), epoch: hub.epoch } }
          }
        }
        if (!a) {
          hubAck(caller, body.ack)
          a = { status: 200, body: { copies: hubPage(caller, body.ack) } }
        }
      } else if (s.path === PUT) {
        a = hub.onPut?.(body)
        if (!a) {
          const to = body.to[0]
          const copy = hubPut(to, { id: body.id, from: caller, kind: 'message', body: body.body })
          a = { status: 200, body: { results: [{ to, seq: copy.seq }] } }
        }
      } else a = { status: 404, body: {} }
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
  wipe()
  hub.epochRule = false
  hub.refuseEpoch = false
  hub.ackKeeps = false
  hub.unread = []
  hub.onTake = undefined
  hub.onPut = undefined
  hub.pageSize = 100
  rmSync(join(TH, 'limits.toml'), { force: true })
  limits.applyLimits()
})

const cfg = (id: string) => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN, bridgeId: id })
let dbs = 0
const dbPath = () => join(BOX, 'db', String(++dbs), 'state.db')
const boxAt = (path: string) => openMailbox({ path, now })
/** beta's carrier on the mailbox at `path`. */
const receiver = (path = dbPath()) => {
  const box: Json = boxAt(path)
  return { path, box, mail: hubMail(cfg('beta'), { box, key: B, now }) }
}

const AUDIT = join(TH, 'bridge.log')
const auditLines = (): Json[] => (existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const mark = () => auditLines().length
const CARRIER = ['mail.refused', 'mail.repeat', 'mail.gap', 'mail.late', 'mail.hub_epoch']
/** The carrier's own lines since `n`, without the ts. */
const carrierLines = (n: number) => auditLines().slice(n).filter((l) => CARRIER.includes(l.event)).map(({ ts: _ts, ...rest }) => rest)
const takeBodies = (): Json[] => seen.filter((s) => s.path === TAKE).map((s) => JSON.parse(s.body))
const putBodies = (): Json[] => seen.filter((s) => s.path === PUT).map((s) => JSON.parse(s.body))

/** A query on a state.db file; [] when the table is not there (BASE). */
function rows(path: string, query: string, ...args: (string | number)[]): Json[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(query).all(...args) as Json[]
  } catch (e) {
    if (/no such table/.test(String(e))) return []
    throw e
  } finally {
    db.close()
  }
}
const hubCursorRow = (path: string) => rows(path, 'SELECT epoch, cursor FROM hub_cursor')[0]
const orderRows = (path: string) => rows(path, 'SELECT from_id, to_name, next FROM mail_order_in')

/** A v:2 mail body with number `n`, as JSON text; `over` replaces or adds fields. */
const v2 = (n: unknown, over: Json = {}) =>
  JSON.stringify({ v: 2, kind: 'mail', id: `mail-${randomUUID()}`, from: 'owner', to: 'bob', level: 'fyi', text: `msg ${String(n)}`, sentAt: clock, n, ...over })
const v1 = (over: Json = {}) =>
  JSON.stringify({ v: 1, kind: 'mail', id: `mail-${randomUUID()}`, from: 'owner', to: 'bob', level: 'fyi', text: 'v1 text', sentAt: clock, ...over })
/** A copy for beta from `sender` (default alpha) over `body`, signed now, in the fake hub's queue. */
function toBeta(body: string, opts: { sender?: 'alpha' | 'gamma'; seq?: number } = {}): Copy {
  const sender = opts.sender ?? 'alpha'
  const k = sender === 'alpha' ? A : G
  const env = JSON.stringify(signEnvelope(k, { from: sender, to: 'beta', body }, clock))
  return hubPut('beta', { id: JSON.parse(body).id, from: sender, kind: 'message', body: env }, opts.seq)
}
/** Inbox texts of `to`, oldest first; they become delivered (bridge/mailbox.ts read). */
const inbox = (box: Json, to = 'bob') => box.read(to, 500).map((m: Json) => m.text)
const notice = (from: string, first: number, last: number) =>
  `mail ${first === last ? first : `${first}-${last}`} from ${from} did not arrive within 30 s; later mail follows`

describe('(33B-4) (o) the sender numbers each destination; the receiver stores in that order', () => {
  it('(33B-4) o1 sender: n 1, 2, 3 to beta:bob, 1 to beta:carol; a re-signed row keeps its n; a new carrier goes on at 4; a signing that throws uses no number', async () => {
    const path = dbPath()
    let box: Json = boxAt(path)
    let mail = hubMail(cfg('alpha'), { box, key: A, now })
    const bob = [1, 2, 3].map((i) => box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: `bob ${i}` }).id)
    const carol = box.send({ from: 'owner', to: 'beta:carol', level: 'ask', text: 'carol 1' }).id
    expect(await mail.pushOnce()).toBe(4)
    const opened = putBodies().map((p) => JSON.parse(openEnvelope(p.body, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock, maxAgeMs: MAX_AGE_CAP_MS }).body))
    expect(opened.map((b: Json) => [b.id, b.to, b.n])).toEqual([[bob[0], 'bob', 1], [bob[1], 'bob', 2], [bob[2], 'bob', 3], [carol, 'carol', 1]])
    for (const b of opened.slice(0, 3)) {
      expect(Object.keys(b).sort()).toEqual(['from', 'id', 'kind', 'level', 'n', 'sentAt', 'text', 'to', 'v'])
      expect(b.v).toBe(2)
    }
    expect(Object.keys(opened[3]).sort()).toEqual(['from', 'id', 'kind', 'level', 'n', 'replyBy', 'sentAt', 'text', 'to', 'v'])
    // A row kept, its put lost, signed again after 61 s: the same n, a new signature time.
    const carol2 = box.send({ from: 'owner', to: 'beta:carol', level: 'fyi', text: 'carol 2' }).id
    seen.length = 0
    hub.onPut = () => 'drop'
    expect(await mail.pushOnce()).toBe(0)
    clock = T + 61_000
    hub.onPut = undefined
    expect(await mail.pushOnce()).toBe(1)
    const envs = putBodies().map((p) => JSON.parse(p.body))
    expect(envs.map((e: Json) => e.ts)).toEqual([T, T + 61_000])
    expect(envs.map((e: Json) => JSON.parse(e.body).n)).toEqual([2, 2])
    expect(JSON.parse(envs[1].body).id).toBe(carol2)
    // A new carrier on the same state.db numbers bob's next row 4.
    box.close()
    box = boxAt(path)
    mail = hubMail(cfg('alpha'), { box, key: A, now })
    box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'bob 4' })
    seen.length = 0
    expect(await mail.pushOnce()).toBe(1)
    expect(JSON.parse(JSON.parse(putBodies()[0].body).body).n).toBe(4)
    // A signing that throws rolls the number back: the next row gets 5.
    const lost = `mail-${randomUUID()}`
    expect(() => box.keepNumbered(lost, 'beta:bob', () => { throw new Error('r1a33b4 sign failed') })).toThrow('r1a33b4 sign failed')
    expect(box.numberOf(lost)).toBeUndefined()
    expect(box.envelopeOf(lost)).toBeUndefined()
    box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'bob 5' })
    seen.length = 0
    expect(await mail.pushOnce()).toBe(1)
    expect(JSON.parse(JSON.parse(putBodies()[0].body).body).n).toBe(5)
    expect(rows(path, 'SELECT dest, n FROM mail_counter_out ORDER BY dest')).toEqual([{ dest: 'beta:bob', n: 5 }, { dest: 'beta:carol', n: 2 }])
    box.close()
  })

  it('(33B-4) o2 (RED at BASE) a hub that hands n 1, 2, 3 under seqs 3, 1, 2 in one page: bob reads 1, 2, 3', async () => {
    const { box, mail } = receiver()
    // beta knows alpha->bob already starts at 1 (first contact is the baseline: stated limit).
    box.setOrderNext?.('alpha', 'bob', 1)
    toBeta(v2(1), { seq: 3 })
    toBeta(v2(2), { seq: 1 })
    toBeta(v2(3), { seq: 2 })
    expect(await mail.pullOnce()).toBe(3)
    expect(inbox(box)).toEqual(['msg 1', 'msg 2', 'msg 3'])
    box.close()
  })

  it('(33B-4) o3 withheld n 2: 3 waits 30 s, then one mail.gap, the notice before 3; a late 2 is dropped as mail.late and acked', async () => {
    const { box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    expect(await mail.pullOnce()).toBe(2)
    expect(inbox(box)).toEqual(['msg 1'])
    clock = T + GAP - 1
    let n = mark()
    await mail.pullOnce()
    expect(inbox(box)).toEqual([])
    expect(carrierLines(n)).toEqual([])
    clock = T + GAP
    n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.gap', from: 'alpha', to: 'bob', missing_from: 2, missing_to: 2 }])
    const read = box.read('bob', 500)
    expect(read.map((m: Json) => [m.from, m.text, m.level])).toEqual([
      ['machine:alpha/gap', notice('alpha', 2, 2), 'fyi'],
      ['machine:alpha/owner', 'msg 3', 'fyi'],
    ])
    const lateBody = v2(2)
    const late = toBeta(lateBody)
    n = mark()
    seen.length = 0
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([{ event: 'mail.late', from: 'alpha', to: 'bob', n: 2, id: JSON.parse(lateBody).id }])
    expect(inbox(box)).toEqual(['a message from alpha arrived out of order and was dropped'])
    expect(takeBodies().at(-1).ack).toBe(late.seq)
    box.close()
  })

  it('(33B-4) o4 n 1 then n 5: the notice says 2-4; n 6 handed before the 30 s waits behind 5 and is stored right after it', async () => {
    const { box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(5))
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 1'])
    clock = T + 10_000
    toBeta(v2(6))
    await mail.pullOnce()
    expect(inbox(box)).toEqual([])
    clock = T + GAP
    const n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.gap', from: 'alpha', to: 'bob', missing_from: 2, missing_to: 4 }])
    expect(inbox(box)).toEqual([notice('alpha', 2, 4), 'msg 5', 'msg 6'])
    expect(box.orderNext('alpha', 'bob')).toBe(7)
    box.close()
  })

  it('(33B-4) o5 a restart keeps the hold time: n 3 held at t, a new carrier at t + 20 s releases it at t + 30 s', async () => {
    const first = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    await first.mail.pullOnce()
    expect(inbox(first.box)).toEqual(['msg 1'])
    first.box.close()
    clock = T + 20_000
    const second = receiver(first.path)
    await second.mail.pullOnce()
    expect(inbox(second.box)).toEqual([])
    clock = T + GAP
    await second.mail.pullOnce()
    expect(inbox(second.box)).toEqual([notice('alpha', 2, 2), 'msg 3'])
    second.box.close()
  })

  it('(33B-4) o6 a v:1 body is stored as at BASE with no order row; v:2 with n 0, -1, 1.5, "2" or 2^53 is refused shape; n 1 is stored', async () => {
    const { path, box, mail } = receiver()
    const one = v1()
    toBeta(one)
    let n = mark()
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([])
    expect(box.read('bob', 50).map((m: Json) => [m.id, m.from, m.text])).toEqual([[JSON.parse(one).id, 'machine:alpha/owner', 'v1 text']])
    expect(orderRows(path)).toEqual([])
    const bad = [0, -1, 1.5, '2', 2 ** 53].map((x) => toBeta(v2(x)))
    n = mark()
    expect(await mail.pullOnce()).toBe(5)
    expect(carrierLines(n)).toEqual(bad.map((c) => ({ event: 'mail.refused', from: 'alpha', id: c.id, denied: 'shape' })))
    expect(inbox(box)).toEqual([])
    toBeta(v2(1))
    expect(await mail.pullOnce()).toBe(1)
    expect(inbox(box)).toEqual(['msg 1'])
    box.close()
  })

  it('(33B-4) o7 first contact: the first copy from alpha to bob has n 5 and is stored at once; next is 6', async () => {
    const { path, box, mail } = receiver()
    toBeta(v2(5))
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 5'])
    expect(orderRows(path)).toEqual([{ from_id: 'alpha', to_name: 'bob', next: 6 }])
    box.close()
  })

  it('(33B-4) o8 the same envelope twice: one store and the repeat line, no gap; alpha and gamma keep separate counters', async () => {
    const { box, mail } = receiver()
    const body = v2(1)
    const c = toBeta(body)
    hubPut('beta', { id: c.id, from: 'alpha', kind: 'message', body: c.body })
    let n = mark()
    expect(await mail.pullOnce()).toBe(2)
    expect(carrierLines(n)).toEqual([{ event: 'mail.repeat', from: 'alpha', id: c.id }])
    toBeta(v2(2))
    toBeta(v2(3))
    toBeta(v2(1), { sender: 'gamma' })
    n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([])
    expect(box.read('bob', 50).map((m: Json) => [m.from, m.text])).toEqual([
      ['machine:alpha/owner', 'msg 1'],
      ['machine:alpha/owner', 'msg 2'],
      ['machine:alpha/owner', 'msg 3'],
      ['machine:gamma/owner', 'msg 1'],
    ])
    box.close()
  })

  it('(33B-4) o9 a held Ask from a computer without the ask right is refused at release (mailbox 403) and the order moves on', async () => {
    const { box, mail } = receiver()
    toBeta(v2(1))
    const ask = v2(3, { level: 'ask', replyBy: T + 600_000 })
    toBeta(ask)
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 1'])
    toBeta(v2(2))
    const n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.refused', from: 'alpha', id: JSON.parse(ask).id, denied: 'mailbox', status: 403 }])
    expect(box.orderNext('alpha', 'bob')).toBe(4)
    toBeta(v2(4))
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 2', 'msg 4'])
    box.close()
  })

  it('(33B-4) o10 MAX_HELD: with next 1 and 1,000 held copies (n 3 .. 1002), n 1003 is refused held_full and acked', async () => {
    const { box, mail } = receiver()
    expect(mailbox.MAX_HELD).toBe(1000)
    box.setOrderNext('alpha', 'bob', 1)
    for (let k = 3; k <= 1002; k++) expect(box.hold('alpha', 'bob', k, '{}', clock)).toBe('held')
    expect(box.hold('alpha', 'bob', 1003, '{}', clock)).toBe('full')
    const c = toBeta(v2(1003))
    const n = mark()
    seen.length = 0
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([{ event: 'mail.refused', from: 'alpha', id: c.id, denied: 'held_full' }])
    expect(takeBodies().at(-1).ack).toBe(c.seq)
    expect(box.heldFor('alpha', 'bob')).toHaveLength(1000)
    box.close()
  })
})

describe('(33B-4) (g) gap edges', () => {
  it('(33B-4) g1 a hub that stops answering (every take 503) still releases: the notice and the held copy are stored with no take succeeding', async () => {
    const { box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 1'])
    hub.onTake = () => ({ status: 503, body: { error: 'down' } })
    clock = T + GAP
    expect(await mail.pullOnce()).toBe(0)
    expect(inbox(box)).toEqual([notice('alpha', 2, 2), 'msg 3'])
    box.close()
  })

  it('(33B-4) g2 bob\'s inbox at MAX_INBOX queued: the gap closes with no notice row; the mail.gap line is written', async () => {
    const { path, box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    await mail.pullOnce()
    const db = new DatabaseSync(path)
    try {
      db.exec('BEGIN')
      const add = db.prepare(`INSERT INTO mail (id, from_id, to_name, level, text, sent_at_ms, reply_by_ms, state, state_at_ms) VALUES (?, 'owner', 'bob', 'fyi', 'fill', ?, NULL, 'queued', ?)`)
      for (let k = 1; k < mailbox.MAX_INBOX; k++) add.run(`mail-${randomUUID()}`, T, T)
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    expect(box.pending('bob').fyi).toBe(mailbox.MAX_INBOX)
    clock = T + GAP
    const n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([
      { event: 'mail.gap', from: 'alpha', to: 'bob', missing_from: 2, missing_to: 2 },
      { event: 'mail.refused', from: 'alpha', id: expect.stringMatching(/^mail-/), denied: 'mailbox', status: 429 },
    ])
    expect(rows(path, `SELECT count(*) AS n FROM mail WHERE from_id = 'machine:alpha/gap'`)).toEqual([{ n: 0 }])
    expect(box.orderNext('alpha', 'bob')).toBe(4)
    box.close()
  })

  it('(33B-4) g3 two pairs (alpha->bob, alpha->carol) with gaps opened 10 s apart close 10 s apart, each with its own notice', async () => {
    const { box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    await mail.pullOnce()
    clock = T + 10_000
    toBeta(v2(1, { to: 'carol' }))
    toBeta(v2(3, { to: 'carol' }))
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 1'])
    expect(inbox(box, 'carol')).toEqual(['msg 1'])
    clock = T + GAP
    let n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.gap', from: 'alpha', to: 'bob', missing_from: 2, missing_to: 2 }])
    expect(inbox(box)).toEqual([notice('alpha', 2, 2), 'msg 3'])
    expect(inbox(box, 'carol')).toEqual([])
    clock = T + GAP + 10_000
    n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.gap', from: 'alpha', to: 'carol', missing_from: 2, missing_to: 2 }])
    expect(inbox(box, 'carol')).toEqual([notice('alpha', 2, 2), 'msg 3'])
    box.close()
  })

  it('(33B-4) the gap constant is 30 s', () => {
    expect(hm.GAP_HOLD_MS).toBe(GAP)
  })
})

describe('(33B-4) (e) the ack cursor is kept with the hub queue epoch', () => {
  it('(33B-4) e1 (RED at BASE) a hub wiped while the carrier runs: the next take sends the old epoch, the hub answers from 0 with the new one, nothing is acked away unread', async () => {
    hub.epochRule = true
    const { path, box, mail } = receiver()
    for (let k = 1; k <= 50; k++) toBeta(v2(k))
    const E = hub.epoch
    expect(await mail.pullOnce()).toBe(50)
    const firstTake = takeBodies()[0]
    wipe()
    const F = hub.epoch
    for (let k = 51; k <= 53; k++) toBeta(v2(k))
    seen.length = 0
    const n = mark()
    const handled = await mail.pullOnce()
    // At BASE the take is { ack: 50 }: the wiped hub deletes its 3 new copies unread.
    expect(hub.unread).toEqual([])
    expect(handled).toBe(3)
    expect(firstTake).toEqual({ ack: 0, epoch: '' })
    expect(takeBodies()[0]).toEqual({ ack: 50, epoch: E })
    expect(inbox(box).slice(-3)).toEqual(['msg 51', 'msg 52', 'msg 53'])
    expect(hubCursorRow(path)).toEqual({ epoch: F, cursor: 3 })
    expect(carrierLines(n)).toEqual([{ event: 'mail.hub_epoch', changed: true }])
    box.close()
  })

  it('(33B-4) e2 a restart sends the kept cursor with its epoch first; nothing is handled twice', async () => {
    hub.epochRule = true
    hub.ackKeeps = true
    const first = receiver()
    for (let k = 1; k <= 5; k++) toBeta(v2(k))
    expect(await first.mail.pullOnce()).toBe(5)
    expect(hubCursorRow(first.path)).toEqual({ epoch: hub.epoch, cursor: 5 })
    first.box.close()
    const second = receiver(first.path)
    seen.length = 0
    const n = mark()
    expect(await second.mail.pullOnce()).toBe(0)
    expect(takeBodies()[0]).toEqual({ ack: 5, epoch: hub.epoch })
    expect(carrierLines(n)).toEqual([])
    expect(inbox(second.box)).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5'])
    second.box.close()
  })

  it('(33B-4) e3 an older hub: one that answers without an epoch key works as at BASE with no hub_cursor row; one that refuses the epoch key gets { ack } takes after one hub_epoch line', async () => {
    const plain = receiver()
    toBeta(v1({ text: 'plain' }))
    expect(await plain.mail.pullOnce()).toBe(1)
    expect(inbox(plain.box)).toEqual(['plain'])
    expect(hubCursorRow(plain.path)).toBeUndefined()
    plain.box.close()

    hub.refuseEpoch = true
    const old = receiver()
    toBeta(v1({ text: 'old 1' }))
    toBeta(v1({ text: 'old 2' }))
    seen.length = 0
    const n = mark()
    expect(await old.mail.pullOnce()).toBe(2)
    expect(carrierLines(n)).toEqual([{ event: 'mail.hub_epoch', supported: false }])
    const bodies = takeBodies()
    expect(Object.hasOwn(bodies[0], 'epoch')).toBe(true)
    expect(bodies.slice(1).map((b) => Object.keys(b))).toEqual(bodies.slice(1).map(() => ['ack']))
    expect(bodies[1]).toEqual({ ack: 0 })
    expect(inbox(old.box)).toEqual(['old 1', 'old 2'])
    // For the rest of this carrier's life: { ack } only, no second line.
    seen.length = 0
    const m = mark()
    await old.mail.pullOnce()
    expect(takeBodies().map((b) => Object.keys(b))).toEqual([['ack']])
    expect(carrierLines(m)).toEqual([])
    old.box.close()
  })

  it('(33B-4) e4 an answer whose epoch is "short" stops the pass as unreadable: nothing handled, hub_cursor unchanged', async () => {
    hub.epochRule = true
    const { path, box, mail } = receiver()
    toBeta(v2(1))
    expect(await mail.pullOnce()).toBe(1)
    expect(inbox(box)).toEqual(['msg 1'])
    const kept = hubCursorRow(path)
    expect(kept).toEqual({ epoch: hub.epoch, cursor: 1 })
    toBeta(v2(2))
    hub.onTake = () => ({ status: 200, body: { copies: hubPage('beta', 0), epoch: 'short' } })
    expect(await mail.pullOnce()).toBe(0)
    expect(hubCursorRow(path)).toEqual(kept)
    expect(inbox(box)).toEqual([])
    box.close()
  })
})

describe('(33B-4) (b) a number the hub never stored goes back (director ruling, option B)', () => {
  /** The n of each put body since `seen` was last cleared, in put order. */
  const putNs = () => putBodies().map((p) => JSON.parse(JSON.parse(p.body).body).n)
  const sender = () => {
    const path = dbPath()
    const box: Json = boxAt(path)
    return { path, box, mail: hubMail(cfg('alpha'), { box, key: A, now }) }
  }
  const sendBob = (box: Json, text: string) => box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text }).id as string

  it('(33B-4) b1 queue_full, then the next send: the same n, and beta stores it with no gap notice', async () => {
    const alpha = sender()
    const beta = receiver()
    sendBob(alpha.box, 'one')
    expect(await alpha.mail.pushOnce()).toBe(1)
    await beta.mail.pullOnce()
    expect(inbox(beta.box)).toEqual(['one'])
    const full = sendBob(alpha.box, 'full')
    hub.onPut = () => ({ status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } })
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(alpha.box.sent('owner', 10).find((m: Json) => m.id === full).state).toBe('queue_full')
    hub.onPut = undefined
    sendBob(alpha.box, 'after')
    seen.length = 0
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(putNs()).toEqual([2])
    const n = mark()
    await beta.mail.pullOnce()
    expect(inbox(beta.box)).toEqual(['after'])
    clock = T + GAP
    await beta.mail.pullOnce()
    expect(carrierLines(n)).toEqual([])
    expect(inbox(beta.box)).toEqual([])
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-4) b2 expired at the hub: the next send is n + 1 and beta writes the gap notice after the 30 s hold', async () => {
    const alpha = sender()
    const beta = receiver()
    sendBob(alpha.box, 'one')
    await alpha.mail.pushOnce()
    await beta.mail.pullOnce()
    expect(inbox(beta.box)).toEqual(['one'])
    const lost = sendBob(alpha.box, 'lost')
    await alpha.mail.pushOnce()
    // The hub's 7 days pass: the copy to beta goes, alpha gets one expired receipt.
    hub.queues.set('beta', queueOf('beta').filter((c) => c.id !== lost))
    hubPut('alpha', { id: lost, from: 'beta', kind: 'expired', body: '' })
    await alpha.mail.pullOnce()
    expect(alpha.box.sent('owner', 10).find((m: Json) => m.id === lost).state).toBe('expired')
    sendBob(alpha.box, 'after')
    seen.length = 0
    await alpha.mail.pushOnce()
    expect(putNs()).toEqual([3])
    await beta.mail.pullOnce()
    expect(inbox(beta.box)).toEqual([])
    clock = T + GAP
    const n = mark()
    await beta.mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.gap', from: 'alpha', to: 'bob', missing_from: 2, missing_to: 2 }])
    expect(inbox(beta.box)).toEqual([notice('alpha', 2, 2), 'after'])
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-4) b3 the first of two rows refused while the later one has a number already: no rollback, the next row goes on after it', async () => {
    const alpha = sender()
    const first = sendBob(alpha.box, 'first')
    const later = alpha.box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'later' })
    hub.onPut = () => 'drop'
    expect(await alpha.mail.pushOnce()).toBe(0)
    // The later row is numbered (2) before the hub answers the first.
    const body = (n: number) => JSON.stringify({ v: 2, kind: 'mail', id: later.id, from: 'owner', to: 'bob', level: 'fyi', text: 'later', sentAt: later.sentAt, n })
    alpha.box.keepNumbered(later.id, 'beta:bob', (n: number) => JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: body(n) }, clock)))
    hub.onPut = (put) => (put.id === first ? { status: 400, body: { error: 'mail_invalid' } } : undefined)
    seen.length = 0
    expect(await alpha.mail.pushOnce()).toBe(2)
    expect(putNs()).toEqual([1, 2])
    expect(alpha.box.sent('owner', 10).find((m: Json) => m.id === first).state).toBe('refused')
    hub.onPut = undefined
    sendBob(alpha.box, 'next')
    seen.length = 0
    await alpha.mail.pushOnce()
    expect(putNs()).toEqual([3])
    expect(rows(alpha.path, 'SELECT dest, n FROM mail_counter_out')).toEqual([{ dest: 'beta:bob', n: 3 }])
    alpha.box.close()
  })
})

describe('(33B-4) (a) audit: a number in use is never given twice; the order table is bounded', () => {
  const putNs = () => putBodies().map((p) => JSON.parse(JSON.parse(p.body).body).n)
  const sender = () => {
    const path = dbPath()
    const box: Json = boxAt(path)
    return { path, box, mail: hubMail(cfg('alpha'), { box, key: A, now }) }
  }
  const sendBob = (box: Json, text: string, from = 'owner') => box.send({ from, to: 'beta:bob', level: 'fyi', text }).id as string
  /** The n of every copy in beta's hub queue, by message id (a resent row counts once). */
  const queuedNs = () => [...new Map(queueOf('beta').map((c) => [c.id, JSON.parse(JSON.parse(c.body).body).n as number])).values()]

  it('(33B-4) a1 a put the hub stored but whose answer was lost, then queue_full on the resend: the number stays used, the next row gets the one after, beta stores both', async () => {
    const alpha = sender()
    const beta = receiver()
    sendBob(alpha.box, 'one')
    expect(await alpha.mail.pushOnce()).toBe(1)
    const ghost = sendBob(alpha.box, 'ghost')
    // The hub stores the copy; its answer never arrives.
    hub.onPut = (put) => {
      hubPut('beta', { id: put.id, from: 'alpha', kind: 'message', body: put.body })
      return 'drop'
    }
    expect(await alpha.mail.pushOnce()).toBe(0)
    hub.onPut = () => ({ status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } })
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(alpha.box.sent('owner', 10).find((m: Json) => m.id === ghost).state).toBe('queue_full')
    hub.onPut = undefined
    sendBob(alpha.box, 'after')
    seen.length = 0
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(putNs()).toEqual([3])
    expect(queuedNs()).toEqual([1, 2, 3])
    const n = mark()
    await beta.mail.pullOnce()
    expect(carrierLines(n)).toEqual([])
    expect(inbox(beta.box)).toEqual(['one', 'ghost', 'after'])
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-4) a2 a mixed run (full, lost answer then refused, stored, refused behind a numbered row): no two messages at the hub share a number; beta stores each once, in order, and never writes mail.late', async () => {
    const alpha = sender()
    const beta = receiver()
    beta.box.setOrderNext('alpha', 'bob', 1)
    const full = { status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } }
    const store = (put: Json) => void hubPut('beta', { id: put.id, from: 'alpha', kind: 'message', body: put.body })
    const texts: string[] = []
    for (let round = 0; round < 6; round++) {
      const t = (k: string) => `r${round} ${k}`
      // first put answered queue_full: the number goes back
      sendBob(alpha.box, t('full'))
      hub.onPut = () => full
      await alpha.mail.pushOnce()
      // stored, answer lost, the resend refused: the number stays
      sendBob(alpha.box, t('ghost'))
      hub.onPut = (put) => (store(put), 'drop')
      await alpha.mail.pushOnce()
      hub.onPut = () => ({ status: 403, body: { error: 'not_in_roster' } })
      await alpha.mail.pushOnce()
      hub.onPut = undefined
      sendBob(alpha.box, t('ok'))
      await alpha.mail.pushOnce()
      // two rows numbered back to back; the first is refused after the second has its number
      const first = sendBob(alpha.box, t('first'))
      const later = alpha.box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: t('later') })
      hub.onPut = () => 'drop'
      await alpha.mail.pushOnce()
      const body = (n: number) => JSON.stringify({ v: 2, kind: 'mail', id: later.id, from: 'owner', to: 'bob', level: 'fyi', text: t('later'), sentAt: later.sentAt, n })
      alpha.box.keepNumbered(later.id, 'beta:bob', (n: number) => JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: body(n) }, clock)))
      hub.onPut = (put) => (put.id === first ? { status: 400, body: { error: 'mail_invalid' } } : undefined)
      await alpha.mail.pushOnce()
      hub.onPut = undefined
      texts.push(t('ghost'), t('ok'), t('later'))
    }
    const ns = queuedNs()
    expect(new Set(ns).size).toBe(ns.length)
    expect(ns).toEqual([...ns].sort((a, b) => a - b))
    const n = mark()
    await beta.mail.pullOnce()
    clock = T + GAP
    await beta.mail.pullOnce()
    expect(carrierLines(n).filter((l) => l.event !== 'mail.gap')).toEqual([])
    const got = inbox(beta.box).filter((x: string) => !x.startsWith('mail '))
    expect(got).toEqual(texts)
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-4) a3 returnNumber is one statement: it gives the number back once, only while it is the last of its destination', () => {
    const alpha = sender()
    const one = `mail-${randomUUID()}`
    const two = `mail-${randomUUID()}`
    alpha.box.keepNumbered(one, 'beta:bob', (n: number) => `e${n}`)
    alpha.box.keepNumbered(two, 'beta:bob', (n: number) => `e${n}`)
    expect(alpha.box.returnNumber(one, 'beta:bob')).toBe(false)
    expect(alpha.box.returnNumber(two, 'beta:carol')).toBe(false)
    expect(alpha.box.returnNumber(`mail-${randomUUID()}`, 'beta:bob')).toBe(false)
    expect(alpha.box.returnNumber(two, 'beta:bob')).toBe(true)
    expect(alpha.box.returnNumber(two, 'beta:bob')).toBe(false)
    expect(rows(alpha.path, 'SELECT dest, n FROM mail_counter_out')).toEqual([{ dest: 'beta:bob', n: 1 }])
    expect(readFileSync(new URL('../bridge/mailbox.ts', import.meta.url), 'utf8')).toContain('UPDATE mail_counter_out SET n = n - 1 WHERE dest = ? AND n = (SELECT n FROM mail_remote WHERE id = ?)')
    alpha.box.close()
  })

  it('(33B-4) a4 two sessions on alpha writing to beta:bob share one counter in send order; beta:carol has its own', async () => {
    const alpha = sender()
    const beta = receiver()
    sendBob(alpha.box, 'owner 1')
    sendBob(alpha.box, 'alice 1', 'session:alice')
    alpha.box.send({ from: 'session:alice', to: 'beta:carol', level: 'fyi', text: 'carol 1' })
    sendBob(alpha.box, 'owner 2')
    expect(await alpha.mail.pushOnce()).toBe(4)
    expect(putNs()).toEqual([1, 2, 1, 3])
    await beta.mail.pullOnce()
    expect(beta.box.read('bob', 500).map((m: Json) => [m.from, m.text])).toEqual([
      ['machine:alpha/owner', 'owner 1'], ['machine:alpha/session:alice', 'alice 1'], ['machine:alpha/owner', 'owner 2'],
    ])
    expect(orderRows(beta.path).sort((x: Json, y: Json) => x.to_name.localeCompare(y.to_name))).toEqual([{ from_id: 'alpha', to_name: 'bob', next: 4 }, { from_id: 'alpha', to_name: 'carol', next: 2 }])
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-4) a6 the number is inside the signed body: a hub that rewrites n (with or without the body hash) is refused, nothing stored or held; the untouched copy is then held as n 2', async () => {
    const { path, box, mail } = receiver()
    box.setOrderNext('alpha', 'bob', 1)
    const body = v2(2)
    const id = JSON.parse(body).id
    const signed = JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body }, clock))
    const forged = JSON.parse(signed)
    forged.body = forged.body.replace('"n":2', '"n":1')
    expect(JSON.parse(forged.body).n).toBe(1)
    hubPut('beta', { id, from: 'alpha', kind: 'message', body: JSON.stringify(forged) })
    forged.body_sha256 = createHash('sha256').update(forged.body).digest('hex')
    hubPut('beta', { id, from: 'alpha', kind: 'message', body: JSON.stringify(forged) })
    const n = mark()
    expect(await mail.pullOnce()).toBe(2)
    expect(carrierLines(n).map((l) => [l.event, l.denied])).toEqual([['mail.refused', 'body'], ['mail.refused', 'signature']])
    expect(inbox(box)).toEqual([])
    expect(rows(path, 'SELECT n FROM mail_held')).toEqual([])
    expect(box.orderNext('alpha', 'bob')).toBe(1)
    hubPut('beta', { id, from: 'alpha', kind: 'message', body: signed })
    expect(await mail.pullOnce()).toBe(1)
    expect(rows(path, 'SELECT n FROM mail_held')).toEqual([{ n: 2 }])
    box.close()
  })

  it('(33B-4) a5 MAX_PAIRS: one sender computer keeps at most 1,000 order rows; the one unused longest goes, never one with held copies, never another sender\'s', () => {
    const { path, box } = receiver()
    expect(mailbox.MAX_PAIRS).toBe(1000)
    box.setOrderNext('gamma', 'bob', 7)
    box.setOrderNext('alpha', 'held', 1)
    expect(box.hold('alpha', 'held', 3, '{}', clock)).toBe('held')
    for (let k = 0; k < 999; k++) box.setOrderNext('alpha', `s${k}`, 2)
    expect(orderRows(path).filter((r: Json) => r.from_id === 'alpha')).toHaveLength(1000)
    // s0 is used again: it is now the newest; s1 is the one unused longest without held copies.
    box.setOrderNext('alpha', 's0', 3)
    box.setOrderNext('alpha', 'new', 2)
    const names = orderRows(path).filter((r: Json) => r.from_id === 'alpha').map((r: Json) => r.to_name)
    expect(names).toHaveLength(1000)
    expect(names).toContain('held')
    expect(names).toContain('s0')
    expect(names).toContain('new')
    expect(names).not.toContain('s1')
    expect(box.orderNext('alpha', 's0')).toBe(3)
    expect(box.orderNext('alpha', 's1')).toBeUndefined()
    expect(box.orderNext('gamma', 'bob')).toBe(7)
    box.close()
  })
})

describe('(33B-5) (l) a late copy whose id was never stored leaves an inbox notice', () => {
  const LATE = 'a message from alpha arrived out of order and was dropped'
  const lateRows = (path: string) => rows(path, `SELECT count(*) AS n FROM mail WHERE from_id = 'machine:alpha/gap' AND text = ?`, LATE)[0].n
  const putNs = () => putBodies().map((p) => JSON.parse(JSON.parse(p.body).body).n)
  const sender = () => {
    const path = dbPath()
    const box: Json = boxAt(path)
    return { path, box, mail: hubMail(cfg('alpha'), { box, key: A, now }) }
  }
  const sendBob = (box: Json, text: string) => box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text }).id as string

  it('(33B-5) l1 (RED at BASE) G-1: the hub answers the first put of X queue_full yet hands X on; Y carries X\'s n, is dropped as mail.late and bob gets one notice', async () => {
    const alpha = sender()
    const beta = receiver()
    sendBob(alpha.box, 'one')
    expect(await alpha.mail.pushOnce()).toBe(1)
    await beta.mail.pullOnce()
    expect(inbox(beta.box)).toEqual(['one'])
    const x = sendBob(alpha.box, 'x')
    hub.onPut = (put) => {
      hubPut('beta', { id: put.id, from: 'alpha', kind: 'message', body: put.body })
      return { status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } }
    }
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(alpha.box.sent('owner', 10).find((m: Json) => m.id === x).state).toBe('queue_full')
    hub.onPut = undefined
    const y = sendBob(alpha.box, 'y')
    seen.length = 0
    expect(await alpha.mail.pushOnce()).toBe(1)
    expect(putNs()).toEqual([2])
    const n = mark()
    await beta.mail.pullOnce()
    expect(carrierLines(n)).toEqual([{ event: 'mail.late', from: 'alpha', to: 'bob', n: 2, id: y }])
    expect(beta.box.read('bob', 500).map((m: Json) => [m.from, m.text, m.level])).toEqual([
      ['machine:alpha/owner', 'x', 'fyi'],
      ['machine:alpha/gap', LATE, 'fyi'],
    ])
    expect(lateRows(beta.path)).toBe(1)
    alpha.box.close()
    beta.box.close()
  })

  it('(33B-5) l2 (RED at BASE) o3\'s flow: after the gap notice for n 2 and msg 3, the late n 2 gives one notice; the take is acked to its seq', async () => {
    const { path, box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(3))
    await mail.pullOnce()
    clock = T + GAP
    await mail.pullOnce()
    expect(inbox(box)).toEqual(['msg 1', notice('alpha', 2, 2), 'msg 3'])
    const lateBody = v2(2)
    const late = toBeta(lateBody)
    const n = mark()
    seen.length = 0
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([{ event: 'mail.late', from: 'alpha', to: 'bob', n: 2, id: JSON.parse(lateBody).id }])
    expect(box.read('bob', 500).map((m: Json) => [m.from, m.text, m.level])).toEqual([['machine:alpha/gap', LATE, 'fyi']])
    expect(lateRows(path)).toBe(1)
    expect(takeBodies().at(-1).ack).toBe(late.seq)
    box.close()
  })

  it('(33B-5) l3 the same late envelope handed twice: one notice, the second is mail.repeat; a late copy whose id is stored writes no notice', async () => {
    const { path, box, mail } = receiver()
    const firstBody = v2(1)
    toBeta(firstBody)
    toBeta(v2(2))
    await mail.pullOnce()
    expect(box.orderNext('alpha', 'bob')).toBe(3)
    const lateBody = v2(1)
    const c = toBeta(lateBody)
    hubPut('beta', { id: c.id, from: 'alpha', kind: 'message', body: c.body })
    let n = mark()
    expect(await mail.pullOnce()).toBe(2)
    expect(carrierLines(n)).toEqual([
      { event: 'mail.late', from: 'alpha', to: 'bob', n: 1, id: c.id },
      { event: 'mail.repeat', from: 'alpha', id: c.id },
    ])
    expect(lateRows(path)).toBe(1)
    // A new signature over the stored body (a new nonce, the same id): mail.repeat, no notice.
    const again = toBeta(firstBody)
    n = mark()
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([{ event: 'mail.repeat', from: 'alpha', id: again.id }])
    expect(lateRows(path)).toBe(1)
    expect(inbox(box)).toEqual(['msg 1', 'msg 2', LATE])
    box.close()
  })

  it('(33B-5) l4 bob\'s inbox at MAX_INBOX queued: the late copy writes no notice, the mail.late line is written, nothing throws', async () => {
    const { path, box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(2))
    await mail.pullOnce()
    const db = new DatabaseSync(path)
    try {
      db.exec('BEGIN')
      const add = db.prepare(`INSERT INTO mail (id, from_id, to_name, level, text, sent_at_ms, reply_by_ms, state, state_at_ms) VALUES (?, 'owner', 'bob', 'fyi', 'fill', ?, NULL, 'queued', ?)`)
      for (let k = 2; k < mailbox.MAX_INBOX; k++) add.run(`mail-${randomUUID()}`, T, T)
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    expect(box.pending('bob').fyi).toBe(mailbox.MAX_INBOX)
    const lateBody = v2(1)
    toBeta(lateBody)
    const n = mark()
    expect(await mail.pullOnce()).toBe(1)
    expect(carrierLines(n)).toEqual([{ event: 'mail.late', from: 'alpha', to: 'bob', n: 1, id: JSON.parse(lateBody).id }])
    expect(lateRows(path)).toBe(0)
    expect(box.pending('bob').fyi).toBe(mailbox.MAX_INBOX)
    box.close()
  })

  it('(33B-5) l5 the order row is unchanged by a late notice; later copies still store in order', async () => {
    const { path, box, mail } = receiver()
    toBeta(v2(1))
    toBeta(v2(2))
    await mail.pullOnce()
    const before = box.orderNext('alpha', 'bob')
    expect(before).toBe(3)
    toBeta(v2(1))
    await mail.pullOnce()
    expect(lateRows(path)).toBe(1)
    expect(box.orderNext('alpha', 'bob')).toBe(before)
    toBeta(v2(3))
    toBeta(v2(4))
    const n = mark()
    await mail.pullOnce()
    expect(carrierLines(n)).toEqual([])
    expect(inbox(box)).toEqual(['msg 1', 'msg 2', LATE, 'msg 3', 'msg 4'])
    expect(box.orderNext('alpha', 'bob')).toBe(5)
    box.close()
  })

  it('(33B-5) l6 a2\'s mixed run: zero mail.late lines and zero late notices', async () => {
    const alpha = sender()
    const beta = receiver()
    beta.box.setOrderNext('alpha', 'bob', 1)
    const full = { status: 200, body: { results: [{ to: 'beta', error: 'queue_full' }] } }
    const store = (put: Json) => void hubPut('beta', { id: put.id, from: 'alpha', kind: 'message', body: put.body })
    for (let round = 0; round < 6; round++) {
      const t = (k: string) => `r${round} ${k}`
      sendBob(alpha.box, t('full'))
      hub.onPut = () => full
      await alpha.mail.pushOnce()
      sendBob(alpha.box, t('ghost'))
      hub.onPut = (put) => (store(put), 'drop')
      await alpha.mail.pushOnce()
      hub.onPut = () => ({ status: 403, body: { error: 'not_in_roster' } })
      await alpha.mail.pushOnce()
      hub.onPut = undefined
      sendBob(alpha.box, t('ok'))
      await alpha.mail.pushOnce()
      const first = sendBob(alpha.box, t('first'))
      const later = alpha.box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: t('later') })
      hub.onPut = () => 'drop'
      await alpha.mail.pushOnce()
      const body = (n: number) => JSON.stringify({ v: 2, kind: 'mail', id: later.id, from: 'owner', to: 'bob', level: 'fyi', text: t('later'), sentAt: later.sentAt, n })
      alpha.box.keepNumbered(later.id, 'beta:bob', (n: number) => JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: body(n) }, clock)))
      hub.onPut = (put) => (put.id === first ? { status: 400, body: { error: 'mail_invalid' } } : undefined)
      await alpha.mail.pushOnce()
      hub.onPut = undefined
    }
    const n = mark()
    await beta.mail.pullOnce()
    clock = T + GAP
    await beta.mail.pullOnce()
    expect(carrierLines(n).filter((l) => l.event === 'mail.late')).toEqual([])
    expect(lateRows(beta.path)).toBe(0)
    alpha.box.close()
    beta.box.close()
  })
})
