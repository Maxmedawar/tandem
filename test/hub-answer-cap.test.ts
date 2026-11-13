/**
 * U-R1A-33B-4H: one capped reader for every hub answer (bridge/hub-link.ts readHubAnswer,
 * MAX_HUB_ANSWER_BYTES) and presence signed under its own envelope tag (bridge/hub-presence.ts).
 *
 * (c) the reader itself; (s) the five readers (hub-mail, roster-hub, hub-presence, remote-command,
 * hub-rpc) against an in-process node:http fake hub that answers 64 MiB and counts the bytes it
 * managed to write; (t) the presence tag; (p) the cap sits above every legal answer.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a33b4h-, removed in afterAll: HOME,
 * TANDEM_HOME (HOME/.tandem: the roster root+alpha+beta written through bridge/roster.ts, state.db,
 * the audit log), the device keys and the state.db files. TMUX is deleted. This computer is alpha.
 * No case asserts a wall-clock bound: a fake ends its write loop when the client closes the socket.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a33b4h-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a33b4h: temp folder is under the real home')
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

const hl = await import('../bridge/hub-link.ts')
const limits = await import('../bridge/limits.ts')
const { openMailbox } = await import('../bridge/mailbox.ts')
const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { signEnvelope, openEnvelope, EnvelopeError } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer, RosterError } = await import('../bridge/roster.ts')
const { hubMail } = await import('../bridge/hub-mail.ts')
const { rosterHub } = await import('../bridge/roster-hub.ts')
const { createPresence } = await import('../bridge/presence.ts')
const { hubPresence, readRemotePresence } = await import('../bridge/hub-presence.ts')
const { sendRemoteCommand } = await import('../bridge/remote-command.ts')
const { fabricForward } = await import('../bridge/hub-rpc.ts')
// The hub's own constants, read at run time: hub/src is its own package and cannot be type-checked
// from here (as test/e2e/memory-home.test.ts notes), so the specifier is not a literal tsc follows.
const hubSrc = '../hub/src/'
const { MAX_COPY_BYTES } = (await import(`${hubSrc}queue.ts`)) as { MAX_COPY_BYTES: number }
const { WS_MAX_FRAME_BYTES } = (await import(`${hubSrc}frame-size.ts`)) as { WS_MAX_FRAME_BYTES: number }

/** readHubAnswer, read at call time: at BASE it does not exist and each c-case fails here. */
const reader = (): ((answer: Response, maxBytes?: number) => Promise<Buffer | undefined>) => {
  const f = (hl as Json).readHubAnswer
  if (typeof f !== 'function') throw new Error('bridge/hub-link.ts exports no readHubAnswer')
  return f
}

const MiB = 1_048_576
const CAP = 8_388_608
const BIG = 64 * MiB
const T = 1_800_000_000_000
let clock = T
const now = () => clock
const TOKEN = 'q'.repeat(40)

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const ROOT = key('root')
const A = key('alpha')
const B = key('beta')
initRoster(ROOT, 'root')
for (const [id, k] of [['alpha', A], ['beta', B]] as const) {
  receiveOffer(JSON.stringify(makeOffer(k, id)))
  trustOffer(ROOT, k.fingerprint)
}

let dbs = 0
const dbPath = () => join(BOX, 'db', String(++dbs), 'state.db')

const AUDIT = join(TH, 'bridge.log')
const auditLines = (): Json[] => (existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const mark = () => auditLines().length
const refusedSince = (n: number) => auditLines().slice(n).filter((l) => l.event === 'presence.refused').map(({ ts: _ts, ...rest }) => rest)

afterAll(() => {
  rmSync(BOX, { recursive: true, force: true })
})

beforeEach(() => {
  clock = T
  rmSync(join(TH, 'limits.toml'), { force: true })
  limits.applyLimits()
})

/** What one fake-hub request is answered with. */
type Plan =
  | { kind: 'json'; status: number; body: string }
  | { kind: 'pour'; status?: number; prefix: string; total: number; contentLength?: boolean; headers?: Record<string, string> }
type Fake = { url: string; seen: { path: string; body: string }[]; written: number[]; close(): Promise<void> }

/**
 * An in-process fake hub on 127.0.0.1. `answer` plans each request's answer. A `pour` answer is
 * written as 1 MiB chunks (the prefix, then `a`s), each only after the previous one was handed to
 * the socket; `written` sums the chunks whose write completed, and the loop ends the moment the
 * client goes away. `close()` waits for every write loop, then closes the server and its sockets.
 */
async function fakeHub(answer: (path: string, body: string, n: number) => Plan): Promise<Fake> {
  const seen: { path: string; body: string }[] = []
  const written: number[] = []
  const loops: Promise<void>[] = []
  const pour = async (res: ServerResponse, plan: Extract<Plan, { kind: 'pour' }>, slot: number) => {
    let gone = false
    const ended = new Promise<false>((resolve) => res.on('close', () => {
      gone = true
      resolve(false)
    }))
    res.writeHead(plan.status ?? 200, {
      'content-type': 'application/json',
      ...(plan.contentLength ? { 'content-length': String(plan.total) } : {}),
      ...plan.headers,
    })
    let sent = 0
    while (sent < plan.total && !gone) {
      const size = Math.min(MiB, plan.total - sent)
      const chunk = Buffer.alloc(size, 'a')
      if (sent === 0) chunk.write(plan.prefix, 0, 'utf8')
      const ok = await Promise.race([ended, new Promise<boolean>((resolve) => res.write(chunk, (err) => resolve(!err)))])
      if (!ok) break
      sent += size
      written[slot] = sent
    }
    if (!gone) res.end()
  }
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s = { path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') }
      const slot = seen.push(s) - 1
      written[slot] = 0
      const plan = answer(s.path, s.body, slot)
      if (plan.kind === 'json') {
        res.writeHead(plan.status, { 'content-type': 'application/json' })
        res.end(plan.body)
        written[slot] = Buffer.byteLength(plan.body)
        return
      }
      loops.push(pour(res, plan, slot))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}`,
    seen,
    written,
    async close() {
      await Promise.all(loops)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A text of exactly `size` bytes: `json` followed by spaces (still that JSON). */
const padded = (json: string, size = CAP) => json + ' '.repeat(size - Buffer.byteLength(json))
/** A fake hub request answered with `text` (any size) in 1 MiB chunks, chunked encoding. */
async function serveText(res: ServerResponse, text: string, status: number): Promise<number> {
  res.writeHead(status, { 'content-type': 'application/json' })
  const all = Buffer.from(text)
  let sent = 0
  while (sent < all.length) {
    const chunk = all.subarray(sent, sent + MiB)
    const ok = await new Promise<boolean>((resolve) => res.write(chunk, (err) => resolve(!err)))
    if (!ok) break
    sent += chunk.length
  }
  res.end()
  return sent
}
/** A fake hub whose answers are whole texts (any size, chunked), for the s6 and p2 pins. */
async function textHub(answer: (path: string, body: string, n: number) => { status: number; text: string }): Promise<Fake> {
  const seen: { path: string; body: string }[] = []
  const written: number[] = []
  const loops: Promise<void>[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s = { path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') }
      const slot = seen.push(s) - 1
      const a = answer(s.path, s.body, slot)
      loops.push(serveText(res, a.text, a.status).then((n) => void (written[slot] = n)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}`,
    seen,
    written,
    async close() {
      await Promise.all(loops)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const cfgOf = (fake: Fake) => ({ url: fake.url, token: TOKEN, bridgeId: 'alpha' })
const big = (prefix: string): Plan => ({ kind: 'pour', prefix, total: BIG })
const log = (what: string, written: number[]) => console.log(`(33B-4H) ${what} written bytes: ${written.join(', ')}`)

/** A presence on the fake clock with no sessions. */
const quietPresence = () =>
  createPresence({ now, computer: 'alpha', list: async () => [], live: () => undefined, remote: { read: () => [] } })

const hubRow = (path: string): Json => {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT connected FROM presence_hub WHERE k = 1').get()
  } finally {
    db.close()
  }
}

describe('(33B-4H) (c) readHubAnswer', () => {
  it('(33B-4H) c1 a 10-byte answer is that Buffer', async () => {
    const got = await reader()(new Response(Buffer.from('0123456789')))
    expect(got).toEqual(Buffer.from('0123456789'))
  })

  const stream = (sizes: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of sizes) c.enqueue(new Uint8Array(n).fill(0x62))
        c.close()
      },
    })

  it('(33B-4H) c2 exactly maxBytes (1,024 in 3 chunks) is read whole: the cap is inclusive', async () => {
    const got = await reader()(new Response(stream([400, 400, 224])), 1024)
    expect(got?.length).toBe(1024)
    expect(got).toEqual(Buffer.alloc(1024, 0x62))
  })

  it('(33B-4H) c3 maxBytes + 1 streamed is undefined and the stream is cancelled there', async () => {
    let cancelled = false
    let pulls = 0
    const sizes = [400, 400, 225]
    // A stream that never ends on its own: chunks of 400, 400, 225, then 1,000 for ever.
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(sizes[pulls++] ?? 1000))
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const got = await reader()(new Response(endless), 1024)
    expect(got).toBeUndefined()
    expect(cancelled).toBe(true)
    expect(pulls).toBe(3)
  })

  it('(33B-4H) c4 a content-length of 64 MiB is refused at the header: undefined, no body byte read, the fake stops far short of 64 MiB', async () => {
    // In memory: a stream that counts each chunk asked of it; the header alone refuses it.
    let pulls = 0
    let cancelled = false
    const counted = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++
        c.enqueue(new Uint8Array(MiB))
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    expect(await reader()(new Response(counted, { headers: { 'content-length': String(BIG) } }))).toBeUndefined()
    expect([pulls, cancelled]).toEqual([0, true])
    // Over real fetch from a fake hub: the body's reader is never taken. What the fake hands the
    // kernel before the cancel arrives is socket buffering (2 MiB seen on Linux), never 64 MiB.
    const fake = await fakeHub(() => ({ kind: 'pour', prefix: '{"x":"', total: BIG, contentLength: true }))
    const answer = await fetch(fake.url.replace('ws://', 'http://') + '/x')
    const getReader = vi.spyOn(answer.body!, 'getReader')
    try {
      expect(answer.headers.get('content-length')).toBe(String(BIG))
      expect(await reader()(answer)).toBeUndefined()
      expect(getReader).not.toHaveBeenCalled()
    } finally {
      getReader.mockRestore()
      // A body the reader never took is cancelled here, so the fake's loop always ends.
      await answer.body?.cancel().catch(() => {})
      await fake.close()
    }
    log('c4', fake.written)
    expect(fake.written[0]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) c5 no body is an empty Buffer', async () => {
    const got = await reader()(new Response(null))
    expect(Buffer.isBuffer(got)).toBe(true)
    expect(got?.length).toBe(0)
  })

  it('(33B-4H) c6 a stream that errors after one chunk rejects (not undefined)', async () => {
    let n = 0
    const failing = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(new Uint8Array(10))
        else c.error(new Error('r1a33b4h stream broke'))
      },
    })
    const read = reader()
    await expect(read(new Response(failing))).rejects.toThrow('r1a33b4h stream broke')
  })
})

describe('(33B-4H) (s) the five readers against a fake hub answering 64 MiB', () => {
  it('(33B-4H) s1 hub-mail: a 64 MiB put answer leaves the row queued; a 64 MiB take answer handles nothing and acks nothing', async () => {
    const fake = await fakeHub((path, _body, n) => {
      if (n < 2) return big(path.endsWith('/take') ? '{"copies":[' : '{"results":[')
      return { kind: 'json', status: 200, body: '{"copies":[]}' }
    })
    const box = openMailbox({ path: dbPath(), now })
    try {
      const mail = hubMail(cfgOf(fake), { box, key: A, now })
      const sent = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'r1a33b4h text' })
      expect(await mail.pushOnce()).toBe(0)
      expect(box.sent('owner', 10).find((m: Json) => m.id === sent.id)?.state).toBe('queued')
      expect(await mail.pullOnce()).toBe(0)
      expect(await mail.pullOnce()).toBe(0)
      expect(fake.seen.map((s) => s.path)).toEqual(['/__tunnel/mail/put', '/__tunnel/mail/take', '/__tunnel/mail/take'])
      expect(fake.seen[2].body).toBe('{"ack":0}')
    } finally {
      box.close()
      await fake.close()
    }
    log('s1', fake.written)
    expect(fake.written[0]).toBeLessThan(16 * MiB)
    expect(fake.written[1]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) s2 roster-hub: a 64 MiB answer rejects with RosterError reason "hub: 200"', async () => {
    const fake = await fakeHub(() => big('{"x":"'))
    let thrown: unknown
    try {
      await rosterHub(cfgOf(fake), A).get().catch((e) => void (thrown = e))
    } finally {
      await fake.close()
    }
    log('s2', fake.written)
    expect(thrown).toBeInstanceOf(RosterError)
    expect((thrown as Json).reason).toBe('hub: 200')
    expect((thrown as Error).message).toBe('roster refused: hub: 200')
    expect(fake.written[0]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) s3 hub-presence: a 64 MiB answer keeps nothing and writes no presence_hub row', async () => {
    const fake = await fakeHub(() => big('{"presence":['))
    const path = dbPath()
    try {
      await hubPresence(cfgOf(fake), { presence: quietPresence(), key: A, now, path }).syncOnce()
    } finally {
      await fake.close()
    }
    log('s3', fake.written)
    expect(readRemotePresence({ now, path, self: 'alpha' })).toEqual([
      { computer: 'beta', at: null, ageMs: null, stale: true, sessions: [], more: 0 },
      { computer: 'root', at: null, ageMs: null, stale: true, sessions: [], more: 0 },
    ])
    expect(hubRow(path)).toBeUndefined()
    expect(fake.written[0]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) s4 remote-command: a 64 MiB answer is { status: 200, body: { error: "answer too large" } }', async () => {
    const fake = await fakeHub((_path, _body, n) => (n === 0 ? big('{"x":"') : { kind: 'json', status: 404, body: '{"error":"not_found"}' }))
    let got: unknown
    try {
      got = await sendRemoteCommand(cfgOf(fake), { to: 'beta', op: 'close', args: { name: 'r1a33b4h-none' }, caller: 'session:r1a33b4h-agent' }, { key: A, now })
    } finally {
      await fake.close()
    }
    log('s4', fake.written)
    expect(got).toEqual({ status: 200, body: { error: 'answer too large' } })
    expect(fake.written[0]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) s5 hub-rpc fabricForward: a 64 MiB answer is memory_home_unverified', async () => {
    const fake = await fakeHub(() => big('{"x":"'))
    let got: unknown
    try {
      got = await fabricForward({ url: fake.url, token: TOKEN, key: A, trusted: () => [{ id: 'beta', key: B.publicKey }] }).forward('/x', {})
    } finally {
      await fake.close()
    }
    log('s5', fake.written)
    expect(got).toEqual({ error: 'memory_home_unverified', message: 'memory home unverified: the answer was not signed by a computer in this roster' })
    expect(fake.written[0]).toBeLessThan(16 * MiB)
  })

  it('(33B-4H) s6 an answer of exactly 8,388,608 bytes of valid JSON is read as at BASE at each site', async () => {
    // hub-mail: a put answer naming seq 7 moves the row; a take page with one expired receipt is handled and acked.
    const expired = { id: `mail-${randomUUID()}`, from: 'beta', room: null, room_seq: null, seq: 1, kind: 'expired', body: '' }
    const mailHub = await textHub((path, _body, n) => {
      if (path.endsWith('/put')) return { status: 200, text: padded('{"results":[{"to":"beta","seq":7}]}') }
      return { status: 200, text: n === 1 ? padded(JSON.stringify({ copies: [expired] })) : padded('{"copies":[]}') }
    })
    const box = openMailbox({ path: dbPath(), now })
    try {
      const mail = hubMail(cfgOf(mailHub), { box, key: A, now })
      const sent = box.send({ from: 'owner', to: 'beta:bob', level: 'fyi', text: 'r1a33b4h text' })
      expect(await mail.pushOnce()).toBe(1)
      expect(box.sent('owner', 10).find((m: Json) => m.id === sent.id)?.state).toBe('sent')
      expect(await mail.pullOnce()).toBe(1)
      expect(mailHub.seen.slice(1).map((s) => JSON.parse(s.body).ack)).toEqual([0, 1])
    } finally {
      box.close()
      await mailHub.close()
    }
    expect(mailHub.written).toEqual([CAP, CAP, CAP])

    const rosterAt = await textHub(() => ({ status: 200, text: padded('{"len":3,"roster":"r1a33b4h"}') }))
    try {
      expect(await rosterHub(cfgOf(rosterAt), A).get()).toEqual({ len: 3, roster: 'r1a33b4h' })
    } finally {
      await rosterAt.close()
    }

    const presenceAt = await textHub(() => ({ status: 200, text: padded('{"presence":[],"connected":["beta"]}') }))
    const path = dbPath()
    try {
      await hubPresence(cfgOf(presenceAt), { presence: quietPresence(), key: A, now, path }).syncOnce()
    } finally {
      await presenceAt.close()
    }
    expect(hubRow(path)).toEqual({ connected: '["beta"]' })

    const commandAt = await textHub(() => ({ status: 200, text: padded('{"ok":true}') }))
    try {
      const got = await sendRemoteCommand(cfgOf(commandAt), { to: 'beta', op: 'close', args: { name: 'r1a33b4h-none' }, caller: 'session:r1a33b4h-agent' }, { key: A, now })
      // remote-command keeps its own 1,048,576-character limit: as at BASE.
      expect(got).toEqual({ status: 200, body: { error: 'answer too large' } })
    } finally {
      await commandAt.close()
    }

    const fabricAt = await textHub(() => ({ status: 504, text: padded('{"error":"gateway_timeout"}') }))
    try {
      expect(await fabricForward({ url: fabricAt.url, token: TOKEN, key: A, trusted: () => [] }).forward('/x', {})).toEqual({ error: 'gateway_timeout' })
    } finally {
      await fabricAt.close()
    }
  })
})

describe('(33B-4H) (t) presence is signed and opened under tandem-presence-v1', () => {
  const reading = (at = clock) => JSON.stringify({
    v: 1, kind: 'presence', at,
    sessions: [{ name: 'b-one', engine: 'shell', project: 'work', state: 'idle', stateAt: at }],
    more: 0,
  })
  const presenceAnswer = (rows: { from: string; envelope: string }[]) =>
    JSON.stringify({ presence: rows.map((r) => ({ ...r, at: clock })), connected: ['alpha', 'beta'] })
  const openAs = (text: string, kind?: 'command' | 'presence' | 'mail') =>
    openEnvelope(text, { sender: { id: 'alpha', publicKey: A.publicKey }, self: 'beta', seen: { remember: () => true }, now: clock, maxAgeMs: 60_000, ...(kind ? { kind } : {}) })
  const reason = (fn: () => unknown) => {
    try {
      fn()
      return 'opened'
    } catch (e) {
      if (e instanceof EnvelopeError) return e.reason
      throw e
    }
  }

  it('(33B-4H) t1 the pushed envelope opens as presence and fails signature as mail and as command', async () => {
    const fake = await fakeHub(() => ({ kind: 'json', status: 200, body: presenceAnswer([]) }))
    try {
      await hubPresence(cfgOf(fake), { presence: quietPresence(), key: A, now, path: dbPath() }).syncOnce()
    } finally {
      await fake.close()
    }
    const pushed = JSON.parse(fake.seen[0].body).presence as { to: string; envelope: string }[]
    const toBeta = pushed.find((p) => p.to === 'beta')!.envelope
    expect(reason(() => openAs(toBeta, 'presence'))).toBe('opened')
    expect(reason(() => openAs(toBeta))).toBe('signature')
    expect(reason(() => openAs(toBeta, 'command'))).toBe('signature')
  })

  /** A carrier that first keeps a good presence-tag reading from beta, then is handed `bad`. */
  async function refusedAfterGood(bad: string) {
    const path = dbPath()
    const good = JSON.stringify(signEnvelope(B, { from: 'beta', to: 'alpha', body: reading(T - 1000) }, T, 'presence'))
    let rows = [{ from: 'beta', envelope: good }]
    const fake = await fakeHub(() => ({ kind: 'json', status: 200, body: presenceAnswer(rows) }))
    try {
      const carrier = hubPresence(cfgOf(fake), { presence: quietPresence(), key: A, now, path })
      await carrier.syncOnce()
      const kept = readRemotePresence({ now, path, self: 'alpha' }).find((r) => r.computer === 'beta')
      expect(kept).toMatchObject({ computer: 'beta', at: T - 1000 })
      clock = T + 2000
      rows = [{ from: 'beta', envelope: bad }]
      const n = mark()
      await carrier.syncOnce()
      expect(refusedSince(n)).toEqual([{ event: 'presence.refused', from: 'beta', denied: 'signature' }])
      const after = readRemotePresence({ now, path, self: 'alpha' }).find((r) => r.computer === 'beta')
      expect(after?.at).toBe(T - 1000)
      expect(after?.sessions.map((s) => s.name)).toEqual(['b-one'])
    } finally {
      await fake.close()
    }
  }

  it('(33B-4H) t2 a reading from beta signed under the mail tag is refused signature; the kept reading is unchanged', async () => {
    await refusedAfterGood(JSON.stringify(signEnvelope(B, { from: 'beta', to: 'alpha', body: reading(T + 2000) }, T + 2000)))
  })

  it('(33B-4H) t3 a mail envelope and a command envelope handed to the presence receiver are refused signature', async () => {
    const mailBody = JSON.stringify({ v: 1, kind: 'mail', id: `mail-${randomUUID()}`, from: 'owner', to: 'bob', level: 'fyi', text: 'r1a33b4h', sentAt: T + 2000 })
    await refusedAfterGood(JSON.stringify(signEnvelope(B, { from: 'beta', to: 'alpha', body: mailBody }, T + 2000, 'mail')))
    clock = T
    const commandBody = JSON.stringify({ v: 1, kind: 'command', op: 'close', args: { name: 'x' }, caller: 'session:r1a33b4h' })
    await refusedAfterGood(JSON.stringify(signEnvelope(B, { from: 'beta', to: 'alpha', body: commandBody }, T + 2000, 'command')))
  })
})

describe('(33B-4H) (p) the cap is above every legal hub answer', () => {
  it('(33B-4H) p1 MAX_HUB_ANSWER_BYTES is 8,388,608 and above each legal answer size', () => {
    const cap = (hl as Json).MAX_HUB_ANSWER_BYTES
    expect(cap).toBe(8_388_608)
    expect(cap).toBeGreaterThan(MAX_COPY_BYTES + 65_536)
    expect(cap).toBeGreaterThan(WS_MAX_FRAME_BYTES + 65_536)
    expect(cap).toBeGreaterThan(2 * 131_072 + 32 * 2 * 4096 + 65_536)
    expect(cap).toBeGreaterThan(100 * 2 * 16_384 + 65_536)
  })

  it('(33B-4H) p2 a take page of MAX_COPY_BYTES of copies, escaped at its worst, is read whole and handled as a normal page', async () => {
    const copyBytes = (c: Json) => Buffer.byteLength(JSON.stringify({ id: c.id, from: c.from, room: c.room, room_seq: c.room_seq, seq: c.seq, kind: c.kind, body: c.body }))
    const copies: Json[] = []
    const per = Math.floor(MAX_COPY_BYTES / 4)
    let left = MAX_COPY_BYTES
    for (let seq = 1; seq <= 4; seq++) {
      const c = { id: `mail-${randomUUID()}`, from: 'beta', room: null, room_seq: null, seq, kind: 'message', body: '' }
      const room = (seq === 4 ? left : per) - copyBytes(c)
      // Each `"` is two bytes as JSON; an odd byte left over is one `a`.
      c.body = '"'.repeat(Math.floor(room / 2)) + (room % 2 ? 'a' : '')
      left -= copyBytes(c)
      copies.push(c)
    }
    expect(copies.reduce((s, c) => s + copyBytes(c), 0)).toBe(MAX_COPY_BYTES)
    const page = JSON.stringify({ copies })
    const fake = await textHub((_path, _body, n) => ({ status: 200, text: n === 1 ? '{"copies":[]}' : page }))
    try {
      const answer = await fetch(fake.url.replace('ws://', 'http://') + '/page')
      let direct: Buffer | undefined
      try {
        direct = await reader()(answer)
      } finally {
        await answer.body?.cancel().catch(() => {})
      }
      expect(direct?.toString('utf8')).toBe(page)
      fake.seen.length = 0
      const box = openMailbox({ path: dbPath(), now })
      try {
        const n = auditLines().length
        expect(await hubMail(cfgOf(fake), { box, key: A, now }).pullOnce()).toBe(4)
        expect(fake.seen.map((s) => JSON.parse(s.body).ack)).toEqual([0, 4])
        const refused = auditLines().slice(n).filter((l) => l.event === 'mail.refused')
        expect(refused.map((l) => l.denied)).toEqual(['shape', 'shape', 'shape', 'shape'])
      } finally {
        box.close()
      }
    } finally {
      await fake.close()
    }
  })
})
