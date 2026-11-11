/**
 * U-R1A-31B-2: bridge/roster-hub.ts, the roster commands over the hub, in process against a local
 * node:http server that records every request and answers as the test says.
 *
 * Each computer has its own TANDEM_HOME (a folder from mkdtempSync(join(tmpdir(), 'r1a31b2-'))),
 * switched in-process with TANDEM_HUB_LINK_ID; the hub settings are set only inside the cases that
 * need them. Every folder this file makes is removed in afterAll.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const made: string[] = []
const box = (): string => {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'r1a31b2-')))
  made.push(p)
  return p
}
const REAL_ROSTER = join(userInfo().homedir, '.tandem', 'roster')
const REAL_KEYS = join(userInfo().homedir, '.tandem', 'keys')
const realBefore = [existsSync(REAL_ROSTER), existsSync(REAL_KEYS)]
const FIRST = box()
if (!relative(realpathSync(userInfo().homedir), FIRST).startsWith('..')) throw new Error('r1a31b2: temp folder is under the real home')
process.env.TANDEM_HOME = FIRST
process.env.TANDEM_HUB_LINK_ID = 'first'
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN

const { openDeviceKey } = await import('../bridge/device-keys.ts')
const roster = await import('../bridge/roster.ts')
const { initRoster, makeOffer, readRoster, receiveOffer, receiveRoster } = roster
const hubClient = await import('../bridge/roster-hub.ts')
const { rosterHub } = hubClient
const { parseProof, verifyProof } = await import('../hub/src/devices.ts')

const TOKEN = 't'.repeat(40)

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
type Answer = { status: number; body: unknown }
let server: Server
let port = 0
const seen: Seen[] = []
let answer: (req: Seen) => Answer = () => ({ status: 404, body: { error: 'no_roster' } })

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      seen.push(s)
      const a = answer(s)
      res.writeHead(a.status, { 'content-type': typeof a.body === 'string' ? 'text/plain' : 'application/json' })
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  for (const p of made) rmSync(p, { recursive: true, force: true })
  expect([existsSync(REAL_ROSTER), existsSync(REAL_KEYS)]).toEqual(realBefore)
})

beforeEach(() => {
  seen.length = 0
  delete process.env.TANDEM_HUB_LINK_URL
  delete process.env.TANDEM_HUB_LINK_TOKEN
})

type Computer = { home: string; id: string }
const on = (c: Computer) => {
  process.env.TANDEM_HOME = c.home
  process.env.TANDEM_HUB_LINK_ID = c.id
}
const computer = (id: string): Computer & { key: ReturnType<typeof openDeviceKey> } => {
  const c = { home: box(), id }
  on(c)
  return { ...c, key: openDeviceKey() }
}
const hubOn = () => {
  process.env.TANDEM_HUB_LINK_URL = `ws://127.0.0.1:${port}`
  process.env.TANDEM_HUB_LINK_TOKEN = TOKEN
}
const config = (id: string) => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN, bridgeId: id })
const rosterFile = (c: Computer) => join(c.home, 'roster', 'roster.json')

/** What `fn` writes to stdout and stderr, and what it returns. */
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => ((out += String(s)), true))
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => ((err += String(s)), true))
  try {
    const code = await fn()
    return { code, out, err }
  } finally {
    o.mockRestore()
    e.mockRestore()
  }
}

/** True when the request's proof is one 31B-1's hub accepts for exactly what the server got. */
async function proofOk(s: Seen, id: string, key: string): Promise<boolean> {
  const parsed = parseProof(s.headers['tandem-proof'] as string)
  if (!parsed || parsed.id !== id || parsed.key !== key) return false
  const path = new URL(s.url, 'http://x').pathname
  const bodySha256 = createHash('sha256').update(s.body).digest('hex')
  return verifyProof(parsed, { host: `127.0.0.1:${port}`, method: s.method, path, bodySha256 })
}

describe('rosterHub client', () => {
  it('each call: the bearer and a proof over the exact bytes received; nothing secret in a URL; refusals name only status and error', async () => {
    const a = computer('a')
    const rosterText = JSON.stringify({ v: 1, entries: initRoster(a.key, 'a') })
    const offerText = JSON.stringify(makeOffer(a.key, 'a'))
    answer = (s) => {
      if (s.method === 'GET' && s.url === '/__tunnel/roster') return { status: 200, body: { len: 1, roster: rosterText } }
      if (s.method === 'PUT') return { status: 200, body: { len: 1 } }
      if (s.method === 'POST') return { status: 200, body: { ok: true } }
      return { status: 200, body: { offers: [offerText] } }
    }
    const hub = rosterHub(config('a'), a.key)
    expect(await hub.get()).toEqual({ len: 1, roster: rosterText })
    expect(await hub.put(0, rosterText)).toEqual({ ok: true, len: 1 })
    await hub.postOffer(offerText)
    expect(await hub.offers()).toEqual([offerText])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /__tunnel/roster', 'PUT /__tunnel/roster', 'POST /__tunnel/roster/offer', 'GET /__tunnel/roster/offers'])
    expect(JSON.parse(seen[1].body.toString())).toEqual({ base: 0, roster: rosterText })
    expect(JSON.parse(seen[2].body.toString())).toEqual({ offer: offerText })
    const proofs = new Set<string>()
    for (const s of seen) {
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(await proofOk(s, 'a', a.key.publicKey)).toBe(true)
      for (const secret of [TOKEN, a.key.publicKey, s.headers['tandem-proof'] as string]) expect(s.url).not.toContain(secret)
      proofs.add(s.headers['tandem-proof'] as string)
    }
    expect(proofs.size).toBe(4)
    // A proof is over this request only: the PUT's proof does not verify over other bytes.
    expect(await proofOk({ ...seen[1], body: Buffer.from('{}') }, 'a', a.key.publicKey)).toBe(false)

    seen.length = 0
    answer = (s) => (s.method === 'GET' ? { status: 404, body: { error: 'no_roster' } } : s.method === 'PUT' ? { status: 409, body: { error: 'roster_conflict', len: 3 } } : { status: 403, body: { error: 'offer_not_yours' } })
    expect(await hub.get()).toBeUndefined()
    expect(await hub.put(0, rosterText)).toEqual({ ok: false, len: 3 })
    const refused = await hub.postOffer(offerText).then(() => 'accepted', (e: Error) => e)
    expect(refused).toBeInstanceOf(roster.RosterError)
    expect((refused as InstanceType<typeof roster.RosterError>).reason).toBe('hub: 403 offer_not_yours')
    answer = () => ({ status: 401, body: 'unauthorized' })
    const plain = await hub.offers().then(() => 'accepted', (e: Error) => e)
    expect((plain as InstanceType<typeof roster.RosterError>).reason).toBe('hub: 401 unauthorized')
    for (const e of [refused, plain]) {
      const text = `${String(e)} ${(e as Error).message}`
      for (const secret of [TOKEN, a.key.publicKey]) expect(text).not.toContain(secret)
    }
  })
})

describe('main', () => {
  it('no hub settings: exactly what roster.ts main prints for the same arguments', async () => {
    const x = computer('x')
    const y = computer('y')
    on(y)
    const offer = JSON.stringify(makeOffer(y.key, 'y'))
    on(x)
    const runs: string[][] = [['fingerprint'], ['roster'], ['trust', '0123456789abcdef'], ['trust'], ['bogus'], [], ['roster', 'bogus'], ['roster', 'init'], ['roster'], ['roster', 'clear'], ['roster', 'init'], ['trust', '0123456789abcdef']]
    for (const args of runs) {
      if (args[0] === 'roster' && args[1] === 'clear') receiveOffer(offer)
      const viaHub = await capture(() => hubClient.main(args))
      if (args.join(' ') === 'roster init' && viaHub.code === 0) rmSync(join(x.home, 'roster'), { recursive: true })
      if (args[0] === 'roster' && args[1] === 'clear') receiveOffer(offer)
      const local = await capture(() => roster.main(args))
      expect([args.join(' '), viaHub]).toEqual([args.join(' '), local])
    }
    expect(seen).toEqual([])
  })

  it('a bad hub setting: exit 1 with the one line', async () => {
    computer('x')
    process.env.TANDEM_HUB_LINK_URL = 'http://127.0.0.1:1'
    process.env.TANDEM_HUB_LINK_TOKEN = TOKEN
    expect(await capture(() => hubClient.main(['roster']))).toEqual({ code: 1, out: '', err: 'tandem: hub link: bad configuration\n' })
    expect(seen).toEqual([])
  })

  it('fingerprint posts an offer whose id and key are this computer\'s', async () => {
    const x = computer('r1a31b2-x')
    hubOn()
    answer = () => ({ status: 200, body: { ok: true } })
    expect(await capture(() => hubClient.main(['fingerprint']))).toEqual({
      code: 0,
      out: `this computer: r1a31b2-x ${x.key.fingerprint}\noffered to the hub as r1a31b2-x\n`,
      err: '',
    })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /__tunnel/roster/offer'])
    const posted = JSON.parse(JSON.parse(seen[0].body.toString()).offer)
    expect(posted).toMatchObject({ v: 1, id: 'r1a31b2-x', key: x.key.publicKey })
    expect(await proofOk(seen[0], 'r1a31b2-x', x.key.publicKey)).toBe(true)
    // The offer verifies as one (another computer keeps it).
    const other = computer('other')
    on(other)
    expect(receiveOffer(JSON.stringify(posted))).toBe(x.key.fingerprint)
    // A refusal: exit 1, the reason.
    on(x)
    answer = () => ({ status: 429, body: { error: 'slow_down' } })
    expect(await capture(() => hubClient.main(['fingerprint']))).toEqual({ code: 1, out: `this computer: r1a31b2-x ${x.key.fingerprint}\n`, err: 'tandem: hub: 429 slow_down\n' })
  })

  /** A with a roster and B's offer waiting at the hub; the hub holds no roster. */
  function trustSetup() {
    const a = computer('r1a31b2-a')
    const b = computer('r1a31b2-b')
    on(b)
    const offer = JSON.stringify(makeOffer(b.key, 'r1a31b2-b'))
    on(a)
    initRoster(a.key, 'r1a31b2-a')
    hubOn()
    return { a, b, offer }
  }

  it('trust: the PUT answered 409 once then 200: one pull, one retry, exit 0', async () => {
    const { a, b, offer } = trustSetup()
    let puts = 0
    answer = (s) => {
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offer] } }
      if (s.method === 'GET') return { status: 404, body: { error: 'no_roster' } }
      return ++puts === 1 ? { status: 409, body: { error: 'roster_conflict', len: 0 } } : { status: 200, body: { len: 2 } }
    }
    expect(await capture(() => hubClient.main(['trust', b.key.fingerprint]))).toEqual({
      code: 0,
      out: `trusted r1a31b2-b ${b.key.fingerprint}. On r1a31b2-b run: tandem trust ${a.key.fingerprint}\n`,
      err: '',
    })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /__tunnel/roster/offers', 'GET /__tunnel/roster', 'PUT /__tunnel/roster',
      'GET /__tunnel/roster/offers', 'GET /__tunnel/roster', 'PUT /__tunnel/roster',
    ])
    const sent = JSON.parse(seen[5].body.toString())
    expect(sent).toEqual({ base: 0, roster: readFileSync(rosterFile(a), 'utf8') })
    on(a)
    expect((readRoster() ?? []).map((e) => e.id)).toEqual(['r1a31b2-a', 'r1a31b2-b'])
  })

  it('trust: 409 twice: exit 1 with the exact message', async () => {
    const { b, offer } = trustSetup()
    answer = (s) => {
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offer] } }
      if (s.method === 'GET') return { status: 404, body: { error: 'no_roster' } }
      return { status: 409, body: { error: 'roster_conflict', len: 0 } }
    }
    expect(await capture(() => hubClient.main(['trust', b.key.fingerprint]))).toEqual({
      code: 1,
      out: '',
      err: `tandem: hub busy: run tandem trust ${b.key.fingerprint} again\n`,
    })
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(2)
  })

  it('trust: a 409 with the other branch at the hub: this computer moves onto the hub\'s roster even where forkWinner picks its own', async () => {
    // L starts the roster and trusts W (the lower fingerprint: by forkWinner W's own branch would win).
    const p = computer('r1a31b2-p')
    const q = computer('r1a31b2-q')
    const [w, l] = p.key.fingerprint < q.key.fingerprint ? [p, q] : [q, p]
    const d = computer('r1a31b2-d')
    const e = computer('r1a31b2-e')
    on(d)
    const offerD = JSON.stringify(makeOffer(d.key, d.id))
    on(e)
    const offerE = JSON.stringify(makeOffer(e.key, e.id))
    on(l)
    initRoster(l.key, l.id)
    receiveOffer(JSON.stringify(makeOffer(w.key, w.id)))
    roster.trustOffer(l.key, w.key.fingerprint)
    const base = readFileSync(rosterFile(l), 'utf8')
    receiveOffer(offerD)
    roster.trustOffer(l.key, d.key.fingerprint)
    const hubHeld = readFileSync(rosterFile(l), 'utf8')
    hubOn()
    for (const [offer, who] of [[offerD, d], [offerE, e]] as const) {
      on(w)
      rmSync(join(w.home, 'roster'), { recursive: true, force: true })
      receiveRoster(base)
      roster.joinRoster(w.key, l.key.fingerprint)
      seen.length = 0
      let gets = 0
      answer = (s) => {
        if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offer] } }
        if (s.method === 'GET') return ++gets === 1 ? { status: 200, body: { len: 2, roster: base } } : { status: 200, body: { len: 3, roster: hubHeld } }
        return seen.filter((x) => x.method === 'PUT').length === 1 ? { status: 409, body: { error: 'roster_conflict', len: 3 } } : { status: 200, body: { len: 4 } }
      }
      const run = await capture(() => hubClient.main(['trust', who.key.fingerprint]))
      expect(run).toEqual({ code: 0, out: `trusted ${who.id} ${who.key.fingerprint}. On ${who.id} run: tandem trust ${w.key.fingerprint}\n`, err: '' })
      const puts = seen.filter((x) => x.method === 'PUT')
      const first = JSON.parse(JSON.parse(puts[0].body.toString()).roster).entries
      // The peer rule alone would keep W's own branch.
      expect(roster.forkWinner(first[2], JSON.parse(hubHeld).entries[2])).toBe('a')
      const now = readRoster() ?? []
      expect(readFileSync(rosterFile(w), 'utf8').startsWith(hubHeld.slice(0, -2))).toBe(true)
      if (who === d) {
        // The hub already holds D: nothing more to send.
        expect(puts).toHaveLength(1)
        expect(readFileSync(rosterFile(w), 'utf8')).toBe(hubHeld)
      } else {
        // W's own entry for E, signed again by W on the hub's roster, then sent once more.
        expect(puts).toHaveLength(2)
        expect(now[3]).toMatchObject({ seq: 3, id: e.id, key: e.key.publicKey, signer: w.key.publicKey })
        expect(JSON.parse(puts[1].body.toString())).toEqual({ base: 3, roster: readFileSync(rosterFile(w), 'utf8') })
      }
    }
  })

  it('audit: trust while another computer\'s upload of the same offer lands between this one\'s two fetches: exit 0, nothing sent', async () => {
    const l = computer('r1a31b2-l')
    const w = computer('r1a31b2-w')
    const d = computer('r1a31b2-d')
    on(d)
    const offerD = JSON.stringify(makeOffer(d.key, d.id))
    on(l)
    initRoster(l.key, l.id)
    receiveOffer(JSON.stringify(makeOffer(w.key, w.id)))
    roster.trustOffer(l.key, w.key.fingerprint)
    const base = readFileSync(rosterFile(l), 'utf8')
    receiveOffer(offerD)
    roster.trustOffer(l.key, d.key.fingerprint)
    const hubHeld = readFileSync(rosterFile(l), 'utf8')
    on(w)
    receiveRoster(base)
    roster.joinRoster(w.key, l.key.fingerprint)
    hubOn()
    // The hub drops an offer the moment a roster with its key is stored: L's upload lands after W's first fetch.
    answer = (s) => {
      const landed = seen.length > 1
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: landed ? [] : [offerD] } }
      if (s.method === 'GET') return landed ? { status: 200, body: { len: 3, roster: hubHeld } } : { status: 200, body: { len: 2, roster: base } }
      return { status: 409, body: { error: 'roster_conflict', len: 3 } }
    }
    expect(await capture(() => hubClient.main(['trust', d.key.fingerprint]))).toEqual({
      code: 0,
      out: `trusted ${d.id} ${d.key.fingerprint}. On ${d.id} run: tandem trust ${w.key.fingerprint}\n`,
      err: '',
    })
    expect(seen.filter((x) => x.method === 'PUT')).toHaveLength(0)
    expect(readFileSync(rosterFile(w), 'utf8')).toBe(hubHeld)
  })

  it('trust with nothing here: the hub holds no roster: exit 1; it holds one: joined', async () => {
    const { a, b } = trustSetup()
    on(b)
    hubOn()
    answer = () => ({ status: 404, body: { error: 'no_roster' } })
    expect(await capture(() => hubClient.main(['trust', a.key.fingerprint]))).toEqual({ code: 1, out: '', err: 'tandem: no roster at the hub yet\n' })
    // A trusts B locally; the hub serves A's roster.
    on(a)
    receiveOffer(JSON.stringify(makeOffer(b.key, 'r1a31b2-b')))
    roster.trustOffer(a.key, b.key.fingerprint)
    const text = readFileSync(rosterFile(a), 'utf8')
    on(b)
    answer = () => ({ status: 200, body: { len: 2, roster: text } })
    expect(await capture(() => hubClient.main(['trust', a.key.fingerprint]))).toEqual({ code: 0, out: `joined the roster signed by ${a.key.fingerprint}\n`, err: '' })
    expect(readFileSync(rosterFile(b), 'utf8')).toBe(text)
    // roster init with a roster at the hub: refused, nothing written.
    const c = computer('r1a31b2-c')
    on(c)
    expect(await capture(() => hubClient.main(['roster', 'init']))).toEqual({ code: 1, out: '', err: 'tandem: the hub already holds a roster: join it with tandem trust <fingerprint>\n' })
    expect(existsSync(join(c.home, 'roster', 'roster.json'))).toBe(false)
    // roster: pulls the hub's roster and offers; a bad offer is counted and the run goes on.
    on(b)
    answer = (s) => (s.url === '/__tunnel/roster/offers' ? { status: 200, body: { offers: ['{"bad":1}'] } } : { status: 200, body: { len: 2, roster: text } })
    const listed = await capture(() => hubClient.main(['roster']))
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('skipped 1 offers\n')
    expect(listed.out).toContain(`1 r1a31b2-b ${b.key.fingerprint} signed by ${a.key.fingerprint}\n`)
    expect(receiveRoster(text)).toBe('same')
  })
})

describe('(31C-2) trust through the hub writes roster.json only after the hub took it (31B-2 G6); the hub slowing down', () => {
  const offerFile = (c: Computer, fp: string) => join(c.home, 'roster', 'offers', `${fp}.json`)
  const read = (p: string) => (existsSync(p) ? readFileSync(p) : undefined)
  type Key = ReturnType<typeof openDeviceKey>
  type E = { seq: number; id: string; key: string; signer: string; ts: number; prev: string; sig: string }
  const etext = (e: Omit<E, 'sig'>) => `tandem-roster-v1\n${e.seq}\n${e.prev}\n${e.id}\n${e.key}\n${e.signer}\n${e.ts}`
  /** `text` with one more entry for id/key, signed by `by`. */
  const extend = (text: string, by: Key, id: string, key: string) => {
    const entries = JSON.parse(text).entries as E[]
    const last = entries[entries.length - 1]
    const head = { seq: entries.length, id, key, signer: by.publicKey, ts: last.ts, prev: createHash('sha256').update(etext(last), 'utf8').digest('hex') }
    return JSON.stringify({ v: 1, entries: [...entries, { ...head, sig: by.sign(etext(head)) }] })
  }

  /** A with a roster and B's offer waiting at the hub; the hub holds A's roster. */
  function setup() {
    const a = computer('r1a31c2-a')
    const b = computer('r1a31c2-b')
    on(b)
    const offer = JSON.stringify(makeOffer(b.key, b.id))
    on(a)
    initRoster(a.key, a.id)
    const held = readFileSync(rosterFile(a), 'utf8')
    hubOn()
    return { a, b, offer, held }
  }

  it('the PUT answered 409 twice: exit 1 with the hub busy line; roster.json bytes and the offer file unchanged', async () => {
    const { a, b, offer, held } = setup()
    answer = (s) => {
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offer] } }
      if (s.method === 'GET') return { status: 200, body: { len: 1, roster: held } }
      return { status: 409, body: { error: 'roster_conflict', len: 1 } }
    }
    // The offer as the first pull keeps it, before the command.
    on(a)
    receiveOffer(offer)
    const [rosterBefore, offerBefore] = [read(rosterFile(a)), read(offerFile(a, b.key.fingerprint))]
    expect(offerBefore).toBeDefined()
    expect(await capture(() => hubClient.main(['trust', b.key.fingerprint]))).toEqual({
      code: 1,
      out: '',
      err: `tandem: hub busy: run tandem trust ${b.key.fingerprint} again\n`,
    })
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(2)
    expect(read(rosterFile(a))).toEqual(rosterBefore)
    expect(read(offerFile(a, b.key.fingerprint))).toEqual(offerBefore)
  })

  it("the hub's roster is another branch (hub roster: fork) and the PUT is 409 twice: roster.json bytes unchanged", async () => {
    const l = computer('r1a31c2-l')
    const w = computer('r1a31c2-w')
    const x = computer('r1a31c2-x')
    const y = computer('r1a31c2-y')
    const z = computer('r1a31c2-z')
    on(z)
    const offerZ = JSON.stringify(makeOffer(z.key, z.id))
    on(l)
    initRoster(l.key, l.id)
    receiveOffer(JSON.stringify(makeOffer(w.key, w.id)))
    roster.trustOffer(l.key, w.key.fingerprint)
    const base = readFileSync(rosterFile(l), 'utf8')
    // W holds L's branch with x; the hub holds L's branch with y: from the hub, W would drop x (signed by L).
    const mine = extend(base, l.key, x.id, x.key.publicKey)
    const hubs = extend(base, l.key, y.id, y.key.publicKey)
    on(w)
    receiveRoster(base)
    roster.joinRoster(w.key, l.key.fingerprint)
    expect(receiveRoster(mine)).toBe('updated')
    const before = read(rosterFile(w))
    hubOn()
    answer = (s) => {
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offerZ] } }
      if (s.method === 'GET') return { status: 200, body: { len: 3, roster: hubs } }
      return { status: 409, body: { error: 'roster_conflict', len: 3 } }
    }
    const run = await capture(() => hubClient.main(['trust', z.key.fingerprint]))
    expect(run.code).toBe(1)
    expect(run.out).toBe('')
    expect(run.err).toContain('hub roster: fork\n')
    expect(run.err.endsWith(`tandem: hub busy: run tandem trust ${z.key.fingerprint} again\n`)).toBe(true)
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(2)
    expect(read(rosterFile(w))).toEqual(before)
    on(w)
    expect((readRoster() ?? []).map((e) => e.id)).toEqual([l.id, w.id, x.id])
  })

  it('the PUT answered 200: roster.json bytes are the PUT body roster, the offer gone, the trusted line', async () => {
    const { a, b, offer, held } = setup()
    answer = (s) => {
      if (s.url === '/__tunnel/roster/offers') return { status: 200, body: { offers: [offer] } }
      if (s.method === 'GET') return { status: 200, body: { len: 1, roster: held } }
      return { status: 200, body: { len: 2 } }
    }
    expect(await capture(() => hubClient.main(['trust', b.key.fingerprint]))).toEqual({
      code: 0,
      out: `trusted ${b.id} ${b.key.fingerprint}. On ${b.id} run: tandem trust ${a.key.fingerprint}\n`,
      err: '',
    })
    const puts = seen.filter((s) => s.method === 'PUT')
    expect(puts).toHaveLength(1)
    const sent = JSON.parse(puts[0].body.toString())
    expect(sent.base).toBe(1)
    expect(readFileSync(rosterFile(a), 'utf8')).toBe(sent.roster)
    expect(existsSync(offerFile(a, b.key.fingerprint))).toBe(false)
    on(a)
    expect((readRoster() ?? []).map((e) => e.id)).toEqual([a.id, b.id])
  })

  it('the hub answering 429 slow down to every call: tandem roster exits 1 with the one line', async () => {
    const { a } = setup()
    const before = read(rosterFile(a))
    answer = () => ({ status: 429, body: 'slow down' })
    expect(await capture(() => hubClient.main(['roster']))).toEqual({ code: 1, out: '', err: 'tandem: hub: 429 slow down\n' })
    expect(read(rosterFile(a))).toEqual(before)
  })
})
