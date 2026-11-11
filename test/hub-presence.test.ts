/**
 * U-R1A-33B-3: presence across computers (bridge/hub-presence.ts, the carrier in the bridge
 * process, and who_is_up's `others`), in process against a local node:http fake hub that speaks
 * the 33B-1 route POST /__tunnel/presence and records every request.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a33b3-, removed in afterAll:
 * TANDEM_HOME (a roster rooted at alpha with beta trusted; the state.db files), HOME (the audit
 * log), the device keys of alpha, beta and gamma (gamma is not in the roster). TMUX is deleted.
 * The clock is fake and is the carrier's only clock. This computer is alpha.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a33b3-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a33b3: temp folder is under the real home')
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

const { openDeviceKey } = await import('../bridge/device-keys.ts')
const { signEnvelope, openEnvelope } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { createPresence } = await import('../bridge/presence.ts')
const hp = await import('../bridge/hub-presence.ts')
const { hubPresence, readRemotePresence } = hp
const { buildMcpServer } = await import('../src/mcp-server.ts')
const { parseProof, verifyProof } = await import('../hub/src/devices.ts')

const T = 1_800_000_000_000
let clock = T
const now = () => clock
const TOKEN = 'p'.repeat(40)
const PATH = '/__tunnel/presence'

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const A = key('alpha')
const B = key('beta')
const G = key('gamma')
initRoster(A, 'alpha')
receiveOffer(JSON.stringify(makeOffer(B, 'beta')))
trustOffer(A, B.fingerprint)

type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
type Answer = { status: number; body: unknown } | 'drop'
const seen: Seen[] = []
let onPresence: (body: Json) => Answer = () => ({ status: 200, body: { presence: [], connected: [] } })
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      const a = onPresence(JSON.parse(s.body))
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
  onPresence = () => ({ status: 200, body: { presence: [], connected: [] } })
})

const cfg = { get url() { return `ws://127.0.0.1:${port}` }, token: TOKEN, bridgeId: 'alpha' }
let dbs = 0
const dbPath = () => join(BOX, 'db', String(++dbs), 'state.db')

/** A presence on the fake clock whose list answers `names` (each session in folder /tmp/r1a33b3-x/<name>). */
function fakePresence(names: string[]) {
  const counts = { refresh: 0 }
  const presence = createPresence({
    now,
    computer: 'alpha',
    list: async () => names.map((id) => ({ id, engine: 'shell', project: 'work', cwd: `/tmp/r1a33b3-x/${id}`, live: true, updatedAt: T, attachHint: '' }) as Json),
    live: () => undefined,
    remote: { read: () => [] },
  })
  const whoIsUp = presence.whoIsUp.bind(presence)
  presence.whoIsUp = async (opts?: { refresh?: boolean }) => {
    if (opts?.refresh) counts.refresh++
    return whoIsUp(opts)
  }
  return { presence, counts }
}

const AUDIT = join(HOME, '.tandem', 'bridge.log')
const auditLines = (): Json[] => (existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const mark = () => auditLines().length
const refusedSince = (n: number) => auditLines().slice(n).filter((l) => l.event === 'presence.refused').map(({ ts: _ts, ...rest }) => rest)

async function proofOk(s: Seen, id: string, publicKey: string): Promise<boolean> {
  const parsed = parseProof(s.headers['tandem-proof'] as string)
  if (!parsed || parsed.id !== id || parsed.key !== publicKey) return false
  const bodySha256 = createHash('sha256').update(s.body).digest('hex')
  return verifyProof(parsed, { host: `127.0.0.1:${port}`, method: 'POST', path: s.path, bodySha256 })
}

/** A presence body as beta would sign it; `over` replaces or adds fields. */
const reading = (over: Json = {}) => JSON.stringify({
  v: 1, kind: 'presence', at: clock,
  sessions: [
    { name: 'b-two', engine: 'shell', project: 'work', state: 'idle', stateAt: clock },
    { name: 'b-one', engine: 'claude', project: 'site', state: 'working', stateAt: clock },
  ],
  more: 0, ...over,
})
const envelope = (k: Json, from: string, to: string, body: string, ts = clock) => JSON.stringify(signEnvelope(k, { from, to, body }, ts))
const answer = (rows: { from: string; envelope: string }[], connected = ['alpha', 'beta']): Answer =>
  ({ status: 200, body: { presence: rows.map((r) => ({ ...r, at: clock })), connected } })
const pushed = (s: Seen) => JSON.parse(s.body).presence as { to: string; envelope: string }[]
const openFor = (text: string, self = 'beta') =>
  openEnvelope(text, { sender: { id: 'alpha', publicKey: A.publicKey }, self, seen: { remember: () => true }, now: clock, maxAgeMs: 60_000 })
const remote = (path: string, extra: Json = {}) => readRemotePresence({ now, path, self: 'alpha', ...extra })

describe('(33B-3) (h1) push: one signed envelope per other roster member, on a change or every 10 s', () => {
  it('(33B-3) the constants', () => {
    expect([hp.PRESENCE_EVERY_MS, hp.PUSH_HEARTBEAT_MS, hp.STALE_MS, hp.PRESENCE_MAX_AGE_MS, hp.MAX_READING_BYTES]).toEqual([2000, 10_000, 30_000, 60_000, 16_384])
  })

  it('(33B-3) first sync: one envelope to beta only (not alpha, not gamma), signed by alpha, exactly v/kind/at/sessions/more, no cwd; the call carries the bearer and a proof', async () => {
    const { presence } = fakePresence(['s-b', 's-a'])
    const carrier = hubPresence(cfg, { presence, key: A, now, path: dbPath() })
    await carrier.syncOnce()
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe(PATH)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(await proofOk(seen[0], 'alpha', A.publicKey)).toBe(true)
    expect(Object.keys(JSON.parse(seen[0].body))).toEqual(['presence'])
    const items = pushed(seen[0])
    expect(items.map((i) => i.to)).toEqual(['beta'])
    expect(items[0].envelope).not.toContain('cwd')
    expect(items[0].envelope).not.toContain('/tmp/r1a33b3-x')
    const opened = openFor(items[0].envelope)
    expect([opened.from, opened.to]).toEqual(['alpha', 'beta'])
    const body = JSON.parse(opened.body)
    expect(Object.keys(body)).toEqual(['v', 'kind', 'at', 'sessions', 'more'])
    expect(body).toEqual({
      v: 1, kind: 'presence', at: T, more: 0,
      sessions: [
        { name: 's-a', engine: 'shell', project: 'work', state: 'unknown', stateAt: T },
        { name: 's-b', engine: 'shell', project: 'work', state: 'unknown', stateAt: T },
      ],
    })
    for (const row of body.sessions) expect(Object.keys(row)).toEqual(['name', 'engine', 'project', 'state', 'stateAt'])
  })

  it('(33B-3) 2 s later, same names: presence []; a new name: a push at once (refreshed); 10 s with no change: a push', async () => {
    const names = ['s-a']
    const { presence, counts } = fakePresence(names)
    const carrier = hubPresence(cfg, { presence, key: A, now, path: dbPath() })
    await carrier.syncOnce()
    expect(pushed(seen[0])).toHaveLength(1)
    clock = T + 2000
    await carrier.syncOnce()
    expect(pushed(seen[1])).toEqual([])
    names.push('s-c')
    clock = T + 4000
    const refreshed = counts.refresh
    await carrier.syncOnce()
    expect(counts.refresh).toBe(refreshed + 1)
    expect(JSON.parse(openFor(pushed(seen[2])[0].envelope).body)).toMatchObject({ at: T + 4000, sessions: [{ name: 's-a' }, { name: 's-c' }] })
    clock = T + 13_999
    await carrier.syncOnce()
    expect(pushed(seen[3])).toEqual([])
    clock = T + 14_000
    await carrier.syncOnce()
    expect(pushed(seen[4])).toHaveLength(1)
    expect(JSON.parse(openFor(pushed(seen[4])[0].envelope).body)).toMatchObject({ at: T + 14_000 })
  })

  it('(33B-3) a 429 makes no call for 60 s; a 500 or no answer keeps nothing and the next sync pushes again', async () => {
    const { presence } = fakePresence(['s-a'])
    const path = dbPath()
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    onPresence = () => ({ status: 500, body: { error: 'x' } })
    await carrier.syncOnce()
    onPresence = () => 'drop'
    clock = T + 2000
    await carrier.syncOnce()
    expect(seen.map((s) => pushed(s).length)).toEqual([1, 1])
    expect(remote(path)).toEqual([{ computer: 'beta', at: null, ageMs: null, stale: true, sessions: [], more: 0 }])
    onPresence = () => ({ status: 429, body: { error: 'slow_down' } })
    clock = T + 4000
    await carrier.syncOnce()
    expect(seen).toHaveLength(3)
    clock = T + 4000 + 59_999
    await carrier.syncOnce()
    expect(seen).toHaveLength(3)
    onPresence = () => answer([])
    clock = T + 4000 + 60_000
    await carrier.syncOnce()
    expect(seen).toHaveLength(4)
    expect(pushed(seen[3])).toHaveLength(1)
  })
})

describe('(33B-3) (h2) answered rows: checked, kept only when newer, refused with one audit line', () => {
  it('(33B-3) beta\'s good reading is listed, not stale, sessions in name order with their age; the same envelope again does no work and writes no line', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    let asked = 0
    const trusted = (id: string) => { asked++; return id === 'beta' ? B.publicKey : undefined }
    const carrier = hubPresence(cfg, { presence, key: A, now, path, trusted })
    const good = envelope(B, 'beta', 'alpha', reading({ at: T - 1000 }))
    onPresence = () => answer([{ from: 'beta', envelope: good }])
    const n = mark()
    await carrier.syncOnce()
    expect(asked).toBe(1)
    const want = {
      computer: 'beta', at: T - 1000, ageMs: 1000, stale: false, more: 0,
      sessions: [
        { name: 'b-one', engine: 'claude', project: 'site', state: 'working', stateAt: T, ageMs: 0 },
        { name: 'b-two', engine: 'shell', project: 'work', state: 'idle', stateAt: T, ageMs: 0 },
      ],
    }
    expect(remote(path)).toEqual([want])
    clock = T + 2000
    await carrier.syncOnce()
    expect(asked).toBe(1)
    expect(refusedSince(n)).toEqual([])
    expect(remote(path)).toEqual([{ ...want, ageMs: 3000, sessions: want.sessions.map((s) => ({ ...s, ageMs: 2000 })) }])
  })

  it('(33B-3) an older reading from beta (smaller at, new envelope) changes nothing', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: T })) }])
    await carrier.syncOnce()
    const kept = remote(path)
    expect(kept[0].at).toBe(T)
    onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: T - 5000, sessions: [] })) }])
    await carrier.syncOnce()
    expect(remote(path)).toEqual(kept)
  })

  const refusals: [string, string, () => { from: string; envelope: string }][] = [
    ['signature', 'signed by gamma claiming beta (a hub that forges a sender)', () => ({ from: 'beta', envelope: envelope(G, 'beta', 'alpha', reading()) })],
    ['to', 'addressed to gamma', () => ({ from: 'beta', envelope: envelope(B, 'beta', 'gamma', reading()) })],
    ['time', '61 s old', () => ({ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: clock - 61_000 }), clock - 61_000) })],
    ['body', 'a changed body', () => {
      const e = JSON.parse(envelope(B, 'beta', 'alpha', reading()))
      return { from: 'beta', envelope: JSON.stringify({ ...e, body: reading({ sessions: [] }) }) }
    }],
    ['unknown_sender', 'a computer outside the roster', () => ({ from: 'gamma', envelope: envelope(G, 'gamma', 'alpha', reading()) })],
    ['shape', 'an extra body key', () => ({ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ cwd: '/tmp/x' })) })],
    ['shape', 'a reading time after the envelope\'s', () => ({ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: clock + 1 })) })],
    ['shape', 'a row with an extra key', () => ({ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ sessions: [{ name: 'x', engine: 'e', project: 'p', state: 'idle', stateAt: clock, cwd: '/' }] })) })],
  ]
  for (const [denied, what, row] of refusals) {
    it(`(33B-3) refused ${denied}: ${what}; one presence.refused line, the old reading kept`, async () => {
      const path = dbPath()
      const { presence } = fakePresence([])
      const carrier = hubPresence(cfg, { presence, key: A, now, path })
      onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: T - 1000 })) }])
      await carrier.syncOnce()
      const kept = remote(path)
      expect(kept[0]).toMatchObject({ computer: 'beta', at: T - 1000, stale: false })
      clock = T + 2000
      const bad = row()
      onPresence = () => answer([bad])
      const n = mark()
      await carrier.syncOnce()
      expect(refusedSince(n)).toEqual([{ event: 'presence.refused', from: bad.from, denied }])
      clock = T + 4000
      await carrier.syncOnce() // the same refused text again: no second line
      expect(refusedSince(n)).toHaveLength(1)
      expect(remote(path).map(({ ageMs: _a, sessions, ...r }) => ({ ...r, sessions: sessions.map(({ ageMs: _s, ...s }) => s) })))
        .toEqual(kept.map(({ ageMs: _a, sessions, ...r }) => ({ ...r, sessions: sessions.map(({ ageMs: _s, ...s }) => s) })))
    })
  }
})

describe('(33B-3) (h3) stale', () => {
  it('(33B-3) a fresh reading with beta not connected is stale; connected again, not stale', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    const good = envelope(B, 'beta', 'alpha', reading())
    onPresence = () => answer([{ from: 'beta', envelope: good }], ['alpha'])
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ computer: 'beta', at: T, ageMs: 0, stale: true })
    onPresence = () => answer([{ from: 'beta', envelope: good }])
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ stale: false })
  })

  it('(33B-3) a reading 30,000 ms old is not stale, 30,001 ms old is, with the hub reached at each sync', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    const once = envelope(B, 'beta', 'alpha', reading())
    onPresence = () => answer([{ from: 'beta', envelope: once }])
    await carrier.syncOnce()
    clock = T + 30_000
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ at: T, ageMs: 30_000, stale: false })
    clock = T + 30_001
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ at: T, ageMs: 30_001, stale: true })
  })

  it('(33B-3) the last sync 30,001 ms ago (the hub down) makes a younger reading stale', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    // beta's clock runs 20 s ahead (inside the envelope's skew): its reading is younger than the sync
    onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ at: T + 20_000, sessions: [] }), T + 20_000) }])
    await carrier.syncOnce()
    onPresence = () => 'drop'
    clock = T + 30_000
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ at: T + 20_000, stale: false })
    clock = T + 30_001
    await carrier.syncOnce()
    expect(remote(path)[0]).toMatchObject({ at: T + 20_000, ageMs: 10_001, stale: true })
  })

  it('(33B-3) a roster member with no reading is listed with at null, stale; self is never listed; sorted by id', async () => {
    const path = dbPath()
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now, path })
    onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading({ sessions: [] })) }])
    await carrier.syncOnce()
    const members = () => [{ id: 'delta' }, { id: 'alpha' }, { id: 'beta' }]
    expect(remote(path, { members })).toEqual([
      { computer: 'beta', at: T, ageMs: 0, stale: false, sessions: [], more: 0 },
      { computer: 'delta', at: null, ageMs: null, stale: true, sessions: [], more: 0 },
    ])
    expect(remote(dbPath())).toEqual([{ computer: 'beta', at: null, ageMs: null, stale: true, sessions: [], more: 0 }])
    expect(remote(dbPath(), { members: () => undefined })).toEqual([])
  })
})

describe('(33B-3) (h4) size', () => {
  it('(33B-3) 300 sessions with 200-byte names: the envelope is at most 16,384 bytes, rows dropped from the end, more counts them', async () => {
    const names = Array.from({ length: 300 }, (_, k) => `s${String(k).padStart(3, '0')}-${'n'.repeat(195)}`)
    expect(Buffer.byteLength(names[0])).toBe(200)
    const { presence } = fakePresence([...names].reverse())
    const carrier = hubPresence(cfg, { presence, key: A, now, path: dbPath() })
    await carrier.syncOnce()
    const text = pushed(seen[0])[0].envelope
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16_384)
    const body = JSON.parse(openFor(text).body)
    const kept = body.sessions.length
    expect(kept).toBeGreaterThan(10)
    expect(body.sessions.map((s: Json) => s.name)).toEqual(names.slice(0, kept))
    expect(body.more).toBe(300 - kept)
    // one more row would not have fit
    const bigger = JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: JSON.stringify({ ...body, sessions: [...body.sessions, { ...body.sessions[0], name: names[kept] }], more: body.more - 1 }) }, clock))
    expect(Buffer.byteLength(bigger, 'utf8')).toBeGreaterThan(16_384)
  })
})

describe('(33B-3) (h5) who_is_up through MCP', () => {
  async function connect(presence: Json) {
    const s = await buildMcpServer(undefined, undefined, undefined, presence)
    const client = new Client({ name: 'r1a33b3', version: '0.0.0' })
    const [c, t] = InMemoryTransport.createLinkedPair()
    await Promise.all([s.connect(t), client.connect(c)])
    const call = async () => JSON.parse(((await client.callTool({ name: 'who_is_up', arguments: { refresh: true } })).content as { text: string }[])[0].text)
    return { call, close: async () => { await client.close(); await s.close() } }
  }
  const local = (opts: Json = {}) => createPresence({
    now, computer: 'alpha', live: () => undefined,
    list: async () => [{ id: 's-a', engine: 'shell', project: 'work', cwd: '/tmp/r1a33b3-x/work', live: true, updatedAt: T, attachHint: '' }] as Json,
    ...opts,
  })
  const BASE_ANSWER = {
    computer: 'alpha', at: T, ageMs: 0,
    sessions: [{ name: 's-a', engine: 'shell', project: 'work', cwd: '/tmp/r1a33b3-x/work', state: 'unknown', stateAt: T, ageMs: 0 }],
  }

  it('(33B-3) with a roster holding beta: others lists beta from state.db (the default reader, the default file), with no folder path of beta', async () => {
    const { presence } = fakePresence([])
    const carrier = hubPresence(cfg, { presence, key: A, now })
    onPresence = () => answer([{ from: 'beta', envelope: envelope(B, 'beta', 'alpha', reading()) }])
    await carrier.syncOnce()
    expect(existsSync(join(TH, 'state.db'))).toBe(true)
    const m = await connect(local())
    const body = await m.call()
    expect(body).toEqual({
      ...BASE_ANSWER,
      others: [{
        computer: 'beta', at: T, ageMs: 0, stale: false, more: 0,
        sessions: [
          { name: 'b-one', engine: 'claude', project: 'site', state: 'working', stateAt: T, ageMs: 0 },
          { name: 'b-two', engine: 'shell', project: 'work', state: 'idle', stateAt: T, ageMs: 0 },
        ],
      }],
    })
    await m.close()
  })

  it('(33B-3) with no roster, or a roster of this computer alone, the answer is exactly the BASE shape (no others key)', async () => {
    const before = process.env.TANDEM_HOME
    try {
      for (const alone of [false, true]) {
        const home = mkdtempSync(join(BOX, 'th-'))
        process.env.TANDEM_HOME = home
        if (alone) initRoster(A, 'alpha')
        const m = await connect(local())
        const body = await m.call()
        expect(body).toStrictEqual(BASE_ANSWER)
        expect(Object.keys(body)).toEqual(['computer', 'at', 'ageMs', 'sessions'])
        expect(existsSync(join(home, 'state.db'))).toBe(false)
        await m.close()
      }
    } finally {
      process.env.TANDEM_HOME = before
    }
  })

  it('(33B-3) a remote read that throws: others [] and one stderr line; the call still answers', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true }) as never)
    try {
      const m = await connect(local({ remote: { read: () => { throw new Error('SECRET-r1a33b3 /tmp/r1a33b3-x') } } }))
      const body = await m.call()
      expect(body).toStrictEqual({ ...BASE_ANSWER, others: [] })
      await m.close()
    } finally {
      spy.mockRestore()
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('SECRET-r1a33b3')
  })
})
