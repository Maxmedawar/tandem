/**
 * U-R1A-34: group chats wake an agent only on @mention, and stop after 5 agent-to-agent replies.
 * A room post naming `@<session>` or `@<computer>:<session>` leaves one fixed FYI line in that
 * session's inbox (never the post's text); the 5th agent post in a row in one room wakes nobody;
 * an owner post starts the count again.
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a34-, removed in afterAll: TANDEM_HOME
 * (the roster root+alpha+beta, the limits file), HOME (the audit log), the device keys, the fabric
 * databases and the mailbox files. TMUX is deleted before the dynamic imports. The clock is fake.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeLimits } from './fixtures/limits.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a34-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a34: temp folder is under the real home')
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
const { signEnvelope } = await import('../bridge/envelope.ts')
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import('../bridge/roster.ts')
const { hubMail } = await import('../bridge/hub-mail.ts')
const { createCallerContext } = await import('../src/fabric/capabilities.ts')
const { FabricValidationError } = await import('../src/fabric/validation.ts')
const fabricModule: Json = await import('../bridge/fabric/sqlite-fabric-client.ts')
const { SQLiteFabricClient, mentionsIn } = fabricModule
const { startFabric } = await import('../bridge/fabric/local-fabric-host.ts')
const { FakeRoomBus } = await import('./fabric/fake-room-bus.ts')

const T = 1_800_000_000_000
let clock = T
const now = () => clock
const MARKER = 'ZEBRAQUARTZ-r1a34'
const LINE = (room: string, id: string) => `You were mentioned in room ${room} (event ${id}). Read it with room_read.`
const ROOM_FYI_ONLY = 'level: room mail is fyi only; nothing was saved'

const key = (id: string) => openDeviceKey({ path: join(BOX, 'keys', id, 'device.key') })
const ROOT = key('root')
const A = key('alpha')
const B = key('beta')
initRoster(ROOT, 'root')
for (const [id, k] of [['alpha', A], ['beta', B]] as const) {
  receiveOffer(JSON.stringify(makeOffer(k, id)))
  trustOffer(ROOT, k.fingerprint)
}

afterAll(() => rmSync(BOX, { recursive: true, force: true }))
beforeEach(() => {
  clock = T
  rmSync(join(TH, 'limits.toml'), { force: true })
  limits.applyLimits()
})

const ALL = ['project:create', 'project:members', 'project:read', 'project:archive', 'room:post', 'room:read',
  'memory:write', 'memory:write:user', 'memory:read', 'memory:read:user', 'memory:delete'] as const
const ctxOf = (agentId: string, projectId: string | undefined, actorType: 'agent' | 'owner') =>
  createCallerContext({ ownerId: 'owner-a', deviceId: `device-${agentId}`, agentId, projectId, actorType, capabilities: ALL })

let n = 0
const dir = () => join(BOX, `case-${++n}`)
const dbFile = () => join(dir(), 'fabric.sqlite3')
const boxAt = () => openMailbox({ path: join(dir(), 'state.db'), now })

type Wake = { names: string[]; room: string; eventId: string; projectId: string }

/** A client on its own database, its onWake recorded, and a project with members a and b. */
async function fabric(options: Json = {}) {
  const wakes: Wake[] = []
  const databasePath = options.databasePath ?? dbFile()
  const client = new SQLiteFabricClient({ databasePath, now, onWake: (w: Wake) => wakes.push(w), ...options })
  const project = options.project ?? await client.createProject(ctxOf('owner', undefined, 'owner'), { displayName: 'Rooms', memberAgentIds: ['a', 'b'] })
  const owner = ctxOf('owner', project.projectId, 'owner')
  const agent = (name: string) => ctxOf(name, project.projectId, 'agent')
  let k = 0
  const post = (ctx: Json, body: string, room = 'general', idempotencyKey = `k-${++k}`) =>
    client.postRoomEvent(ctx, { room, type: 'message', body, idempotencyKey })
  return { client, wakes, project, owner, agent, post, databasePath }
}

/** The stored run of one room, or undefined when there is no row. */
function runOf(databasePath: string, projectId: string, room: string): number | undefined {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return (db.prepare('SELECT run FROM room_agent_run WHERE owner_id = ? AND project_id = ? AND room = ?').get('owner-a', projectId, room) as Json)?.run
  } finally {
    db.close()
  }
}

/** The MailError a call throws, as { status, message }; the value when it does not throw. */
function refusal(fn: () => unknown): Json {
  try {
    return fn()
  } catch (e) {
    if (e instanceof MailError) return { status: e.status, message: e.message }
    throw e
  }
}

const AUDIT = join(HOME, '.tandem', 'bridge.log')
const auditText = () => (existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : '')
const auditLines = (): Json[] => auditText().split('\n').filter(Boolean).map((l) => JSON.parse(l))

/**
 * Two agents a and b that answer each other: each wake of a name makes that agent post
 * `@<other> reply <i>` as an agent. Returns the agent posts made, in order.
 */
async function answerEachOther(f: Awaited<ReturnType<typeof fabric>>, counter: { i: number }) {
  const posted: Json[] = []
  while (f.wakes.length > 0) {
    const w = f.wakes.shift()!
    for (const name of w.names) {
      const other = name === 'a' ? 'b' : 'a'
      posted.push(await f.post(f.agent(name), `@${other} reply ${++counter.i}`))
    }
    if (posted.length > 50) throw new Error('the loop did not stop')
  }
  return posted
}

describe('(34) (a) mentionsIn', () => {
  it('(34) (a) names in order, the email form, @@, a repeat, the first 10, a capital computer, a bare @...', () => {
    expect(mentionsIn('hi @alice and @beta:bob.')).toEqual(['alice', 'beta:bob'])
    expect(mentionsIn('x@alice')).toEqual([])
    expect(mentionsIn('@@alice')).toEqual([])
    expect(mentionsIn('@alice @alice')).toEqual(['alice'])
    const twelve = Array.from({ length: 12 }, (_, i) => `s${i}`)
    expect(mentionsIn(twelve.map((s) => `@${s}`).join(' '))).toEqual(twelve.slice(0, 10))
    expect(fabricModule.MAX_MENTIONS).toBe(10)
    expect(mentionsIn('@Beta:bob')).toEqual(['Beta'])
    expect(mentionsIn('@...')).toEqual([])
  })
})

describe('(34) (b) an owner post wakes its mentions once', () => {
  it('(34) (b) owner `@a start` -> one call ["a"]; no mention -> no call; a retry by idempotencyKey -> no second call', async () => {
    const f = await fabric()
    const event = await f.post(f.owner, '@a start', 'general', 'start')
    expect(f.wakes).toEqual([{ names: ['a'], room: 'general', eventId: event.id, projectId: f.project.projectId }])
    await f.post(f.owner, 'nobody named here')
    expect(f.wakes).toHaveLength(1)
    const again = await f.post(f.owner, '@a start', 'general', 'start')
    expect(again.id).toBe(event.id)
    expect(f.wakes).toHaveLength(1)
    // An agent's retry changes no run either.
    await f.post(f.agent('a'), '@b one', 'general', 'agent-one')
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(1)
    await f.post(f.agent('a'), '@b one', 'general', 'agent-one')
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(1)
    expect(f.wakes).toHaveLength(2)
    f.client.close()
  })
})

describe('(34) (c) A3.4: two agents set to answer each other stop at 5 replies', () => {
  it('(34) (c) after owner `@a go`: exactly 5 agent posts, the 5th wakes nobody; owner `@a again` -> 5 more', async () => {
    const f = await fabric()
    const counter = { i: 0 }
    await f.post(f.owner, '@a go')
    const first = await answerEachOther(f, counter)
    expect(first).toHaveLength(5)
    expect(first.map((e: Json) => e.body)).toEqual(['@b reply 1', '@a reply 2', '@b reply 3', '@a reply 4', '@b reply 5'])
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(5)
    expect(f.wakes).toEqual([])

    await f.post(f.owner, '@a again')
    expect(f.wakes.map((w) => w.names)).toEqual([['a']])
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(0)
    const second = await answerEachOther(f, counter)
    expect(second).toHaveLength(5)
    expect(f.wakes).toEqual([])
    f.client.close()
  })

  it('(34) (c) the 5th agent post wakes nobody even when it names someone; the 4th still does', async () => {
    const f = await fabric()
    for (let i = 1; i <= 4; i++) await f.post(f.agent(i % 2 ? 'a' : 'b'), `@x n${i}`)
    expect(f.wakes).toHaveLength(4)
    const fifth = await f.post(f.agent('a'), '@x five')
    expect(f.wakes).toHaveLength(4)
    expect(f.wakes.some((w) => w.eventId === fifth.id)).toBe(false)
    await f.post(f.agent('b'), '@x six')
    expect(f.wakes).toHaveLength(4)
    expect(fabricModule.HOP_BUDGET).toBe(5)
    f.client.close()
  })
})

describe('(34) (c) the bus path counts the same way', () => {
  it('(34) (c) with a bus: owner `@a go` then the loop gives 5 agent posts; a retry wakes nobody', async () => {
    const f = await fabric({ bus: new FakeRoomBus() })
    const go = await f.post(f.owner, '@a go', 'general', 'go')
    expect(f.wakes).toEqual([{ names: ['a'], room: 'general', eventId: go.id, projectId: f.project.projectId }])
    const posted = await answerEachOther(f, { i: 0 })
    expect(posted).toHaveLength(5)
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(5)
    await f.post(f.owner, '@a go', 'general', 'go')
    expect(f.wakes).toEqual([])
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(5)
    f.client.close()
  })
})

describe('(34) (d) the run is per room and per project', () => {
  it('(34) (d) 5 agent posts in r1 do not stop a wake in r2 or in another project\'s r1', async () => {
    const f = await fabric()
    for (let i = 1; i <= 5; i++) await f.post(f.agent('a'), `@b n${i}`, 'r1')
    expect(f.wakes).toHaveLength(4)
    await f.post(f.agent('a'), '@b other room', 'r2')
    expect(f.wakes.at(-1)).toEqual(expect.objectContaining({ names: ['b'], room: 'r2' }))
    const other = await f.client.createProject(ctxOf('owner', undefined, 'owner'), { displayName: 'Other', memberAgentIds: ['a', 'b'] })
    await f.client.postRoomEvent(ctxOf('a', other.projectId, 'agent'), { room: 'r1', type: 'message', body: '@b other project', idempotencyKey: 'op' })
    expect(f.wakes.at(-1)).toEqual(expect.objectContaining({ names: ['b'], room: 'r1', projectId: other.projectId }))
    expect(f.wakes).toHaveLength(6)
    expect(runOf(f.databasePath, f.project.projectId, 'r1')).toBe(5)
    expect(runOf(f.databasePath, f.project.projectId, 'r2')).toBe(1)
    expect(runOf(f.databasePath, other.projectId, 'r1')).toBe(1)
    f.client.close()
  })
})

describe('(34) (e) the run survives a restart', () => {
  it('(34) (e) 4 agent posts, close, reopen the same file: the 5th wakes nobody', async () => {
    const f = await fabric()
    for (let i = 1; i <= 4; i++) await f.post(f.agent('a'), `@b n${i}`)
    expect(f.wakes).toHaveLength(4)
    f.client.close()
    const g = await fabric({ databasePath: f.databasePath, project: f.project })
    await g.post(g.agent('b'), '@a five', 'general', 'after-restart')
    expect(g.wakes).toEqual([])
    expect(runOf(g.databasePath, g.project.projectId, 'general')).toBe(5)
    g.client.close()
  })
})

describe('(34) (f) a post that fails wakes nobody; a wake that fails never fails the post', () => {
  it('(34) (f) a validation failure and a rate-window refusal: no wake, no run change', async () => {
    const f = await fabric({ roomRateLimit: { maxEvents: 3, windowMs: 60_000 } })
    await f.post(f.agent('a'), '@b one')
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(1)
    await expect(f.client.postRoomEvent(f.agent('a'), { room: 'general', type: 'not-a-type', body: '@b bad', idempotencyKey: 'bad' })).rejects.toBeInstanceOf(FabricValidationError)
    await expect(f.client.postRoomEvent(f.agent('a'), { room: 'general', type: 'message', body: '', idempotencyKey: 'empty' })).rejects.toBeInstanceOf(FabricValidationError)
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(1)
    await f.post(f.agent('a'), '@b two')
    await f.post(f.agent('a'), '@b three')
    expect(f.wakes).toHaveLength(3)
    await expect(f.post(f.agent('a'), '@b four')).rejects.toThrow()
    expect(f.wakes).toHaveLength(3)
    expect(runOf(f.databasePath, f.project.projectId, 'general')).toBe(3)
    f.client.close()
  })

  it('(34) (f) onWake throwing: the post is stored and readable with room_read', async () => {
    let calls = 0
    const f = await fabric({ onWake: () => { calls++; throw new Error(`wake failed ${MARKER}`) } })
    const event = await f.post(f.owner, `@a hello ${MARKER}`)
    expect(calls).toBe(1)
    const read = await f.client.readRoom(f.agent('a'), { room: 'general' })
    expect(read.events.map((e: Json) => e.id)).toEqual([event.id])
    f.client.close()
  })
})

describe('(34) (g) schema version 13', () => {
  it('(34) (g) a version-12 database opens at 13 with room_agent_run', async () => {
    expect(fabricModule.CURRENT_FABRIC_SCHEMA_VERSION).toBe(13)
    const f = await fabric()
    await f.post(f.agent('a'), '@b before')
    f.client.close()
    const legacy = new DatabaseSync(f.databasePath)
    legacy.exec('DROP TABLE room_agent_run; PRAGMA user_version = 12;')
    legacy.close()
    const g = await fabric({ databasePath: f.databasePath, project: f.project })
    g.client.close()
    const inspected = new DatabaseSync(f.databasePath, { readOnly: true })
    try {
      expect((inspected.prepare('PRAGMA user_version').get() as Json).user_version).toBe(13)
      expect((inspected.prepare(`PRAGMA table_info('room_agent_run')`).all() as Json[]).map((c) => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['owner_id', 'TEXT', 1, 1], ['project_id', 'TEXT', 1, 2], ['room', 'TEXT', 1, 3], ['run', 'INTEGER', 1, 0]])
    } finally {
      inspected.close()
    }
  })
})

describe('(34) (h) the wake line through a real mailbox', () => {
  it('(34) (h) wake("a","general","evt-1") -> one queued fyi from room:general with the fixed line; one mail.send audit line', () => {
    const box = boxAt()
    const before = auditLines().length
    const sent = box.wake('a', 'general', 'evt-1')
    expect(sent).toEqual(expect.objectContaining({ to: 'a', level: 'fyi', state: 'queued' }))
    expect(box.pending('a')).toEqual({ fyi: 1, ask: 0, interrupt: 0 })
    expect(box.read('a', 10)).toEqual([expect.objectContaining({ from: 'room:general', to: 'a', level: 'fyi', text: LINE('general', 'evt-1') })])
    const lines = auditLines().slice(before)
    expect(lines).toEqual([expect.objectContaining({ event: 'mail.send', from: 'room:general', to: 'a', level: 'fyi', state: 'queued' })])
    box.close()
  })

  it('(34) (h) a room name with a space -> unnamed; a bad event id -> unknown', () => {
    const box = boxAt()
    box.wake('a', 'my room', 'evt-2')
    box.wake('a', 'general', 'evt 3‮')
    expect(box.read('a', 10).map((m) => [m.from, m.text])).toEqual([
      ['room:unnamed', LINE('unnamed', 'evt-2')],
      ['room:general', LINE('general', 'unknown')],
    ])
    box.close()
  })

  it('(34) (h) wake("beta:bob") with beta in the roster -> one outgoing remote row; gamma not in it -> the not-in-roster 400', () => {
    const box = boxAt()
    box.wake('beta:bob', 'general', 'evt-4')
    expect(box.outgoing(10)).toEqual([expect.objectContaining({ from: 'room:general', to: 'beta:bob', level: 'fyi', text: LINE('general', 'evt-4'), state: 'queued' })])
    expect(refusal(() => box.wake('gamma:bob', 'general', 'evt-5'))).toEqual({ status: 400, message: 'to: computer gamma is not in this computer\'s roster; nothing was saved' })
    expect(refusal(() => box.wake('relay-x', 'general', 'evt-6'))).toEqual(expect.objectContaining({ status: 400 }))
    expect(box.outgoing(10)).toHaveLength(1)
    box.close()
  })

  it('(34) (h) a post through the fabric client to a real mailbox: the line never holds the post body', async () => {
    const box = boxAt()
    const f = await fabric({ onWake: (w: Wake) => { for (const name of w.names) box.wake(name, w.room, w.eventId) } })
    const before = auditText().length
    const event = await f.post(f.owner, `@a @beta:bob look ${MARKER}`)
    const mine = box.read('a', 10)
    expect(mine).toEqual([expect.objectContaining({ from: 'room:general', text: LINE('general', event.id) })])
    expect(box.outgoing(10)).toEqual([expect.objectContaining({ to: 'beta:bob', text: LINE('general', event.id) })])
    expect(JSON.stringify([mine, box.outgoing(10)])).not.toContain(MARKER)
    expect(auditText().slice(before)).not.toContain(MARKER)
    f.client.close()
    box.close()
  })
})

describe('(34) (i) no caller can spell room:', () => {
  it('(34) (i) send from room:general -> 400; interrupt_from ["room:general"] refuses the whole limits file', () => {
    const box = boxAt()
    expect(refusal(() => box.send({ from: 'room:general', to: 'a', level: 'fyi', text: 'x' }))).toEqual({ status: 400, message: 'from: owner or session:<name>; nothing was saved' })
    writeLimits(TH, { interrupt_from: ['room:general'], shell: true })
    limits.applyLimits()
    const snap = limits.limitsSnapshot()
    expect(snap.problem).toEqual(expect.stringContaining('wrong type for interrupt_from'))
    expect(snap.shell).toBe(false)
    expect(box.pending('a')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    box.close()
  })
})

describe('(34) (j) a room wake from another computer', () => {
  const good = () => ({ id: `mail-${randomUUID()}`, from: 'machine:alpha/room:general', to: 'bob', level: 'fyi' as const, text: LINE('general', 'evt-1'), sentAt: T })

  it('(34) (j) receive from machine:alpha/room:general: fyi stored; ask or interrupt -> 403', () => {
    const box = boxAt()
    expect(box.receive(good())).toBe('stored')
    expect(box.read('bob', 10)).toEqual([expect.objectContaining({ from: 'machine:alpha/room:general', level: 'fyi' })])
    expect(refusal(() => box.receive({ ...good(), level: 'ask', replyBy: T + 600_000 }))).toEqual({ status: 403, message: ROOM_FYI_ONLY })
    writeLimits(TH, { interrupt_from: ['machine:alpha/owner'] })
    limits.applyLimits()
    expect(refusal(() => box.receive({ ...good(), level: 'interrupt' }))).toEqual({ status: 403, message: ROOM_FYI_ONLY })
    expect(refusal(() => box.receive({ ...good(), from: 'machine:alpha/room:bad room' }))).toEqual(expect.objectContaining({ status: 400 }))
    expect(box.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    box.close()
  })

  describe('(34) (j) through the carrier: alpha wakes beta:bob, beta pulls it', () => {
    let server: Server
    let port = 0
    let queue: Json[] = []
    let seq = 0
    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          let answer: Json
          if (req.url === '/__tunnel/mail/put') {
            queue.push({ id: body.id, from: 'alpha', seq: ++seq, kind: 'message', body: body.body })
            answer = { results: [{ to: 'beta', seq }] }
          } else {
            queue = queue.filter((c) => c.seq > body.ack)
            answer = { copies: queue }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(answer))
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as { port: number }).port
    })
    afterAll(() => new Promise((resolve) => server.close(resolve)))
    const cfg = (id: string) => ({ url: `ws://127.0.0.1:${port}`, token: 'r'.repeat(40), bridgeId: id })

    it('(34) (j) a wake row crosses as room:general and is stored from machine:alpha/room:general; a room ask is refused mailbox 403', async () => {
      const alpha = boxAt()
      const beta = boxAt()
      alpha.wake('beta:bob', 'general', 'evt-9')
      expect(await hubMail(cfg('alpha'), { box: alpha, key: A, now }).pushOnce()).toBe(1)
      const pull = hubMail(cfg('beta'), { box: beta, key: B, now })
      expect(await pull.pullOnce()).toBe(1)
      expect(beta.read('bob', 10)).toEqual([expect.objectContaining({ from: 'machine:alpha/room:general', level: 'fyi', text: LINE('general', 'evt-9') })])

      const ask = { v: 1, kind: 'mail', id: `mail-${randomUUID()}`, from: 'room:general', to: 'bob', level: 'ask', text: 'x', sentAt: clock, replyBy: clock + 600_000 }
      queue.push({ id: ask.id, from: 'alpha', seq: ++seq, kind: 'message', body: JSON.stringify(signEnvelope(A, { from: 'alpha', to: 'beta', body: JSON.stringify(ask) }, clock)) })
      const before = auditLines().length
      expect(await pull.pullOnce()).toBe(1)
      expect(auditLines().slice(before).filter((l) => l.event === 'mail.refused')).toEqual([expect.objectContaining({ denied: 'mailbox', status: 403 })])
      expect(beta.pending('bob')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
      alpha.close()
      beta.close()
    })
  })
})

describe('(34) (k) wiring', () => {
  it('(34) (k) startFabric passes onWake to the client: an owner post through the host\'s client wakes through it', async () => {
    const wakes: Wake[] = []
    const host = await startFabric({
      env: { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: dbFile() },
      onWake: (w: Wake) => { wakes.push(w) },
      stdout: () => undefined,
      stderr: () => undefined,
    } as Json)
    expect(host).toBeDefined()
    try {
      const project = await host!.client.createProject(ctxOf('owner', undefined, 'owner'), { displayName: 'Wired', memberAgentIds: ['a'] })
      const event = await host!.client.postRoomEvent(ctxOf('owner', project.projectId, 'owner'), { room: 'general', type: 'message', body: '@a wired', idempotencyKey: 'w' })
      expect(wakes).toEqual([{ names: ['a'], room: 'general', eventId: event.id, projectId: project.projectId }])
    } finally {
      host!.close()
    }
  })

  it('(34) (k) src/stdio-server.ts as its own process: room_post naming @w leaves w one fyi line, read back with mail_read', async () => {
    const root = dir()
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k === 'TMUX' || k === 'TMUX_PANE' || k.startsWith('TANDEM_') || k.startsWith('CCM_')) continue
      env[k] = v
    }
    Object.assign(env, {
      HOME: home, TMUX_TMPDIR: root, TANDEM_CWD_ALLOWLIST: root, TANDEM_ENABLED_ENGINES: 'shell',
      CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: join(root, 'fabric', 'fabric.sqlite3'),
    })
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'],
      cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe', env,
    })
    const err = { text: '' }
    transport.stderr?.on('data', (d) => { err.text += d })
    const client = new Client({ name: 'r1a34-stdio', version: '0.0.0' })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text)
    try {
      const project = await call('project_create', { displayName: 'Stdio' })
      const event = await call('room_post', { projectId: project.projectId, room: 'general', type: 'message', body: `@w look ${MARKER}`, idempotencyKey: 'stdio' })
      const read = await call('mail_read', { name: 'w' })
      expect(read.messages).toEqual([expect.objectContaining({ from: 'room:general', to: 'w', level: 'fyi', text: LINE('general', event.id) })])
      expect(JSON.stringify(read)).not.toContain(MARKER)
      expect(existsSync(join(home, '.tandem', 'state.db'))).toBe(true)
      expect(err.text).not.toContain(MARKER)
    } finally {
      await client.close()
    }
  }, 60_000)
})
