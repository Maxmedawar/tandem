/**
 * U-R1A-47H: the scope check fails closed (G6); room event bodies and a project's displayName and
 * repoRef are masked at write (G7, G8 part); rows stored before a store recorded `mask_version` are
 * rewritten masked once when the store opens, with their FTS rows rebuilt (G7).
 *
 * Every folder is under one mkdtemp folder named r1a47h- in TMPDIR: HOME, TANDEM_HOME and every
 * store. TMUX is deleted before any bridge import; no tmux server and no agent program starts. The
 * scope cases build the MCP server in process with limitsSnapshot and the caller mocked (a valid
 * limits file cannot hold a missing or unknown scope value). Test secrets are built from pieces at
 * run time, compared in code and never printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const h = vi.hoisted(() => ({ current: {} as Record<string, unknown>, box: '' }))

vi.mock('../../bridge/limits.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../bridge/limits.ts')>()
  return { ...real, limitsSnapshot: () => h.current }
})
vi.mock('../../bridge/caller-tokens.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../bridge/caller-tokens.ts')>()
  return { ...real, processCaller: () => 'r1a47h-agent', callerFolder: () => `${h.box}/x` }
})

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a47h-')))
h.box = BOX
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const HOME = join(BOX, 'home')
mkdirSync(HOME, { recursive: true })
const TH = join(HOME, '.tandem')
mkdirSync(TH, { recursive: true, mode: 0o700 })
chmodSync(TH, 0o700)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
delete process.env.TANDEM_HUB_LINK_URL
delete process.env.TANDEM_HUB_LINK_TOKEN
delete process.env.TANDEM_CALLER_TOKEN
for (const d of ['x', 'y']) mkdirSync(join(BOX, d))

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const { createCallerContext } = await import('../../src/fabric/capabilities.ts')
const { FabricValidationError } = await import('../../src/fabric/validation.ts')
const { SQLiteFabricClient } = await import('../../bridge/fabric/sqlite-fabric-client.ts')
const redactModule = (await import('../../bridge/transcripts/redact.ts')) as Record<string, unknown>
const REDACT_VERSION = redactModule.REDACT_VERSION
const { FakeRoomBus } = await import('./fake-room-bus.ts')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

afterAll(() => {
  rmSync(BOX, { recursive: true, force: true })
})

/** Test secrets, built from parts at run time and never written whole in this file. */
const pick = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('')
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const akia = () => 'AK' + 'IA' + pick(UPPER, 16)
const ghTok = () => 'gh' + 'p_' + pick(ALNUM, 36)
const pemOf = (body: string) => ['-----BEGIN ', 'PRIVATE KEY-----\n', body, '\n-----END ', 'PRIVATE KEY-----'].join('')
/** Three values: an AWS-key shape, a GitHub-token shape and a private-key block's body (the block is `pem`). */
function secrets() {
  const pemBody = randomBytes(48).toString('base64')
  return { key: akia(), gh: ghTok(), pemBody, pem: pemOf(pemBody) }
}
const values = (s: ReturnType<typeof secrets>) => [s.key, s.gh, s.pemBody]

const caps = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:write:user',
  'memory:read', 'memory:read:user', 'memory:delete',
] as const
const owner = (projectId?: string) => createCallerContext({
  ownerId: 'owner-a', deviceId: 'device-owner', agentId: 'agent-owner', projectId, actorType: 'owner', capabilities: caps,
})

/** A store path in its own 0700 folder under BOX. */
function storeAt(name: string): string {
  const dir = join(BOX, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return join(dir, 'fabric.sqlite3')
}
const bytesOf = (file: string): Buffer => (existsSync(file) ? spawnSync('cat', [file], { maxBuffer: 256 * 1024 * 1024 }).stdout : Buffer.alloc(0))
/** Whether the file, or a journal or log beside it, holds any value (as written or lowercased, as FTS keeps a token). */
function atRest(path: string, list: string[]): boolean[] {
  const all = [bytesOf(path), bytesOf(`${path}-journal`), bytesOf(`${path}-wal`)]
  return list.map((v) => all.some((b) => b.includes(Buffer.from(v)) || b.includes(Buffer.from(v.toLowerCase()))))
}
function query<T = Json>(path: string, sql: string, ...args: Array<string | number>): T[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all(...args) as T[] } finally { db.close() }
}
function hasTable(path: string, name: string): boolean {
  return query(path, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`, name).length === 1
}
const holds = (rows: unknown[], list: string[]) => list.map((v) => JSON.stringify(rows).includes(v))

/* ---------------- (g) scope fails closed ---------------- */

describe('(g) the scope check fails closed', () => {
  const FORWARD_SCOPED = 'memory_scope: an agent\'s memory calls cannot be limited to its project on another computer\'s memory home yet; the owner can set memory_scope = "all" on this computer'
  const TRANSCRIPT_OUTSIDE = "transcript_scope: an agent searches only its own session's folder or one under it"
  const forward = vi.fn(async () => ({ records: [] }))
  const search = vi.fn(async () => ({ status: 200, body: { results: [] } }))
  const get = vi.fn(async () => ({ status: 200, body: { results: [] } }))
  let client: Json
  let server: Json

  beforeAll(async () => {
    const { buildMcpServer } = await import('../../src/mcp-server.ts')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const transcripts = { refresh: async () => {}, indexSource: () => {}, search, get, close: () => {} }
    server = await buildMcpServer(undefined, { forward }, undefined, undefined, transcripts as Json)
    client = new Client({ name: 'r1a47h', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(b), client.connect(a)])
  }, 60_000)
  afterAll(async () => {
    await client?.close()
    await server?.close()
  })

  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text)
  async function memory(snapshot: Record<string, unknown>) {
    h.current = snapshot
    forward.mockClear()
    const answer = await call('memory_search', { query: 'r1a47h' })
    return { answer, forwarded: forward.mock.calls.length }
  }
  async function transcript(snapshot: Record<string, unknown>) {
    h.current = snapshot
    search.mockClear()
    const answer = await call('transcript_search', { query: 'r1a47h', project: join(BOX, 'y') })
    return { answer, searched: search.mock.calls.length }
  }

  it('(47H) g1 a snapshot with no memory_scope key is scoped: refused, nothing forwarded', async () => {
    expect(await memory({ transcript_scope: 'project' })).toEqual({ answer: { error: FORWARD_SCOPED }, forwarded: 0 })
  })
  it('(47H) g2 memory_scope "everything" and "All" are scoped', async () => {
    for (const value of ['everything', 'All']) {
      expect(await memory({ memory_scope: value, transcript_scope: 'project' })).toEqual({ answer: { error: FORWARD_SCOPED }, forwarded: 0 })
    }
  })
  it('(47H) g3 memory_scope "all" is forwarded (pin)', async () => {
    expect(await memory({ memory_scope: 'all', transcript_scope: 'project' })).toEqual({ answer: { records: [] }, forwarded: 1 })
  })
  it('(47H) g4 a snapshot with no transcript_scope key is scoped: refused, nothing searched', async () => {
    expect(await transcript({ memory_scope: 'project' })).toEqual({ answer: { error: TRANSCRIPT_OUTSIDE }, searched: 0 })
  })
  it('(47H) g5 transcript_scope "all" and "Computer" are scoped', async () => {
    for (const value of ['all', 'Computer']) {
      expect(await transcript({ memory_scope: 'project', transcript_scope: value })).toEqual({ answer: { error: TRANSCRIPT_OUTSIDE }, searched: 0 })
    }
  })
  it('(47H) g6 transcript_scope "computer" is searched (pin)', async () => {
    expect(await transcript({ memory_scope: 'project', transcript_scope: 'computer' })).toEqual({ answer: { results: [] }, searched: 1 })
  })
  it('(47H) g7 both "project": scoped as before (pin)', async () => {
    const both = { memory_scope: 'project', transcript_scope: 'project' }
    expect(await memory(both)).toEqual({ answer: { error: FORWARD_SCOPED }, forwarded: 0 })
    expect(await transcript(both)).toEqual({ answer: { error: TRANSCRIPT_OUTSIDE }, searched: 0 })
  })
})

/* ---------------- (r) room bodies masked at write ---------------- */

async function ownerProject(client: InstanceType<typeof SQLiteFabricClient>, displayName = 'r1a47h project') {
  const project = await client.createProject(owner(), { displayName })
  return project.projectId
}

describe('(r) room event bodies are masked before either storage path', () => {
  it('(47H) r1 no bus: the stored body, the read body and the idempotency fingerprint hold no key', async () => {
    const s = secrets()
    const path = storeAt('r1')
    const client = new SQLiteFabricClient({ databasePath: path })
    try {
      const pid = await ownerProject(client)
      await client.postRoomEvent(owner(pid), { room: 'r47h', type: 'message', body: `r1a47h r1 deploy ${s.key} now`, idempotencyKey: 'r1-post' })
      const read = await client.readRoom(owner(pid), { room: 'r47h' })
      expect(read.events.length).toBe(1)
      expect(read.events[0]!.body.includes('[secret:aws-key]')).toBe(true)
      expect(read.events[0]!.body.includes(s.key)).toBe(false)
    } finally {
      client.close()
    }
    expect(holds(query(path, 'SELECT body FROM room_events'), [s.key])).toEqual([false])
    expect(holds(query(path, 'SELECT fingerprint FROM idempotency'), [s.key])).toEqual([false])
  })

  it('(47H) r2 bus: no payload the bus received holds the key, and the stored row is masked', async () => {
    const s = secrets()
    const payloads: string[] = []
    const bus = new FakeRoomBus({ beforeVisible: (input) => { payloads.push(input.payload) } })
    const path = storeAt('r2')
    const client = new SQLiteFabricClient({ databasePath: path, bus })
    try {
      const pid = await ownerProject(client)
      const event = await client.postRoomEvent(owner(pid), { room: 'r47h', type: 'message', body: `r1a47h r2 deploy ${s.key} now`, idempotencyKey: 'r2-post' })
      expect(event.body.includes('[secret:aws-key]')).toBe(true)
      expect(payloads.length > 0).toBe(true)
      expect(payloads.map((p) => p.includes(s.key))).toEqual(payloads.map(() => false))
    } finally {
      client.close()
    }
    const rows = query(path, 'SELECT body FROM room_events')
    expect(rows.length).toBe(1)
    expect(holds(rows, [s.key, '[secret:aws-key]'])).toEqual([false, true])
    expect(holds(query(path, 'SELECT fingerprint FROM idempotency'), [s.key])).toEqual([false])
  })

  it('(47H) r3 a body whose masked form is over 16,384 bytes is refused and nothing is stored', async () => {
    const short = pick('bcdfghjkmnpqrstvwxz', 6)
    process.env.R1A47H_SHORT_PASSWORD = short
    const path = storeAt('r3')
    const client = new SQLiteFabricClient({ databasePath: path })
    try {
      const pid = await ownerProject(client)
      const body = `r1a47h r3 ${`${short} `.repeat(2000)}`
      expect(Buffer.byteLength(body) <= 16_384).toBe(true)
      let refused: unknown
      try {
        await client.postRoomEvent(owner(pid), { room: 'r47h', type: 'message', body, idempotencyKey: 'r3-post' })
      } catch (error) {
        refused = error
      }
      expect(refused instanceof FabricValidationError).toBe(true)
    } finally {
      client.close()
      delete process.env.R1A47H_SHORT_PASSWORD
    }
    expect(query(path, 'SELECT count(*) AS n FROM room_events')).toEqual([{ n: 0 }])
  })

  it('(47H) r4 a retry with the same key and the same raw body is the same event (pin)', async () => {
    const s = secrets()
    const client = new SQLiteFabricClient({ databasePath: storeAt('r4') })
    try {
      const pid = await ownerProject(client)
      const input = { room: 'r47h', type: 'message' as const, body: `r1a47h r4 ${s.gh}`, idempotencyKey: 'r4-post' }
      const first = await client.postRoomEvent(owner(pid), input)
      const again = await client.postRoomEvent(owner(pid), input)
      expect(again.id).toBe(first.id)
      expect((await client.readRoom(owner(pid), { room: 'r47h' })).events.length).toBe(1)
    } finally {
      client.close()
    }
  })
})

describe('(r) a room event read out of the bus log is masked before it is stored', () => {
  it('(47H) r5 bus: a payload an older writer left raw in the log is stored and read masked', async () => {
    const s = secrets()
    const bus = new FakeRoomBus()
    const path = storeAt('r5')
    const client = new SQLiteFabricClient({ databasePath: path, bus })
    try {
      const pid = await ownerProject(client)
      const now = Date.now()
      const record = {
        id: 'event-r1a47h-r5', ownerId: 'owner-a', projectId: pid, room: 'r47h', type: 'message', fromAgentId: 'agent-old',
        body: `r1a47h r5 old writer ${s.key} and ${s.gh}`, createdAt: new Date(now).toISOString(), createdAtMs: now,
        expiresAtMs: now + 86_400_000, ttlHops: 8, deviceId: 'device-old',
      }
      bus.injectRaw('owner-a', pid, 'r47h', Buffer.from(JSON.stringify(record)).toString('base64'))
      const read = await client.readRoom(owner(pid), { room: 'r47h' })
      expect(read.events.length).toBe(1)
      expect(read.events[0]!.body === 'r1a47h r5 old writer [secret:aws-key] and [secret:github-token]').toBe(true)
    } finally {
      client.close()
    }
    expect(holds(query(path, 'SELECT body FROM room_events'), [s.key, s.gh])).toEqual([false, false])
    expect(atRest(path, [s.key, s.gh])).toEqual([false, false])
  })
})

/* ---------------- (j) project fields masked at create ---------------- */

describe('(j) a project\'s displayName and repoRef are masked at create', () => {
  it('(47H) j1 displayName and repoRef read back masked; workspaceRef exactly as given', async () => {
    const s = secrets()
    const path = storeAt('j1')
    const workspaceRef = join(BOX, 'j1-work', 'repo')
    const client = new SQLiteFabricClient({ databasePath: path })
    try {
      const created = await client.createProject(owner(), { displayName: `Alpha ${s.key}`, repoRef: `repo ${s.gh}`, workspaceRef })
      const got = await client.getProject(owner(), created.projectId)
      const listed = (await client.listProjects(owner())).find((p) => p.projectId === created.projectId)
      for (const p of [created, got, listed]) {
        expect(p?.displayName === 'Alpha [secret:aws-key]').toBe(true)
        expect(p?.repoRef === 'repo [secret:github-token]').toBe(true)
        expect(p?.workspaceRef).toBe(workspaceRef)
      }
    } finally {
      client.close()
    }
    expect(holds(query(path, 'SELECT display_name, repo_ref FROM projects'), [s.key, s.gh])).toEqual([false, false])
  })

  it('(47H) j2 a displayName whose masked form is over 256 bytes is refused and no project is added', async () => {
    const short = pick('bcdfghjkmnpqrstvwxz', 6)
    process.env.R1A47H_SHORT_PASSWORD = short
    const path = storeAt('j2')
    const client = new SQLiteFabricClient({ databasePath: path })
    try {
      const displayName = `${short} `.repeat(30)
      expect(Buffer.byteLength(displayName) <= 256).toBe(true)
      let refused: unknown
      try {
        await client.createProject(owner(), { displayName })
      } catch (error) {
        refused = error
      }
      expect(refused instanceof FabricValidationError).toBe(true)
      expect((await client.listProjects(owner())).length).toBe(0)
    } finally {
      client.close()
      delete process.env.R1A47H_SHORT_PASSWORD
    }
    expect(query(path, 'SELECT count(*) AS n FROM projects')).toEqual([{ n: 0 }])
  })
})

/* ---------------- (o) old rows masked once at open ---------------- */

/**
 * A store as it was before this unit: built by the client with placeholder texts, then rewritten raw:
 * 3 memories (and their FTS rows) and 2 room bodies hold the three values, so does the project's
 * display_name and one idempotency fingerprint, and fabric_mask is dropped.
 */
async function rawStore(name: string) {
  const s = secrets()
  const path = storeAt(name)
  const client = new SQLiteFabricClient({ databasePath: path })
  let pid: string
  const memoryIds: string[] = []
  const eventIds: string[] = []
  try {
    pid = await ownerProject(client)
    for (const n of [1, 2, 3]) {
      memoryIds.push((await client.remember(owner(pid), { scope: 'project', kind: 'fact', text: `r1a47h placeholder memory ${n}`, importance: 0.5 })).id)
    }
    for (const n of [1, 2]) {
      eventIds.push((await client.postRoomEvent(owner(pid), { room: 'r47h', type: 'message', body: `r1a47h placeholder event ${n}`, idempotencyKey: `${name}-post-${n}` })).id)
    }
  } finally {
    client.close()
  }
  const texts = [`r1a47h old alpha ${s.key} memo`, `r1a47h old beta ${s.gh} memo`, `r1a47h old gamma ${s.pem} memo`]
  const bodies = [`r1a47h old room ${s.key} and ${s.gh}`, `r1a47h old room ${s.pem}`]
  const db = new DatabaseSync(path)
  try {
    texts.forEach((text, i) => {
      db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(text, memoryIds[i]!)
      db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryIds[i]!)
      db.prepare('INSERT INTO memory_fts(memory_id, text) VALUES (?, ?)').run(memoryIds[i]!, text)
    })
    bodies.forEach((body, i) => {
      db.prepare('UPDATE room_events SET body = ? WHERE id = ?').run(body, eventIds[i]!)
    })
    db.prepare('UPDATE idempotency SET fingerprint = replace(fingerprint, ?, ?)').run('r1a47h placeholder event 1', bodies[0]!)
    db.prepare('UPDATE projects SET display_name = ?').run(`r1a47h ${s.key}`)
    db.exec('DROP TABLE IF EXISTS fabric_mask')
  } finally {
    db.close()
  }
  return { s, path, pid: pid!, memoryIds, eventIds }
}

const CANON_TABLES = ['memories', 'room_events', 'memory_fts', 'projects', 'idempotency', 'fabric_mask']
function canonicalRows(path: string): Record<string, string[]> {
  return Object.fromEntries(CANON_TABLES.map((t) => [t, hasTable(path, t) ? query(path, `SELECT * FROM "${t}"`).map((r) => JSON.stringify(r)).sort() : ['<no table>']]))
}

describe('(o) rows stored before a recorded mask_version are masked once when the store opens', () => {
  it('(47H) o1 3 memories, 2 room events and the project open masked; FTS, search and the closed file hold no value', async () => {
    const { s, path, pid, memoryIds, eventIds } = await rawStore('o1')
    const client = new SQLiteFabricClient({ databasePath: path })
    try {
      for (const id of memoryIds) {
        const m = await client.getMemory(owner(pid), id)
        expect(m?.text.includes('[secret:')).toBe(true)
        expect(holds([m], values(s))).toEqual([false, false, false])
      }
      const read = await client.readRoom(owner(pid), { room: 'r47h' })
      expect(read.events.map((e) => e.id).sort()).toEqual([...eventIds].sort())
      for (const e of read.events) expect(e.body.includes('[secret:')).toBe(true)
      expect(holds(read.events as unknown[], values(s))).toEqual([false, false, false])
      const project = await client.getProject(owner(), pid)
      expect(project?.displayName === 'r1a47h [secret:aws-key]').toBe(true)
      for (const v of values(s)) {
        const found = await client.searchMemory(owner(pid), { query: v })
        expect(found.records.filter((r) => r.text.includes(v)).length).toBe(0)
      }
    } finally {
      client.close()
    }
    for (const v of values(s)) {
      expect(query(path, 'SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?', `"${v}"`)).toEqual([{ n: 0 }])
    }
    expect(holds(query(path, 'SELECT fingerprint FROM idempotency'), values(s))).toEqual([false, false, false])
    expect(query(path, 'SELECT mask_version FROM fabric_mask')).toEqual([{ mask_version: REDACT_VERSION }])
    expect(REDACT_VERSION).toBe(1)
    expect(atRest(path, values(s))).toEqual([false, false, false])
  })

  it('(47H) o2 a second open changes nothing; an empty store opened twice records no version', async () => {
    const { path } = await rawStore('o2')
    new SQLiteFabricClient({ databasePath: path }).close()
    const before = canonicalRows(path)
    expect(before.fabric_mask).toEqual([JSON.stringify({ singleton: 1, mask_version: 1 })])
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(canonicalRows(path)).toEqual(before)

    const empty = storeAt('o2-empty')
    new SQLiteFabricClient({ databasePath: empty }).close()
    new SQLiteFabricClient({ databasePath: empty }).close()
    expect(hasTable(empty, 'fabric_mask') ? query(empty, 'SELECT count(*) AS n FROM fabric_mask') : [{ n: 0 }]).toEqual([{ n: 0 }])
  })

  it('(47H) o3 with the version recorded a raw row is left as it is; a lower version masks it again', async () => {
    const { s, path, memoryIds } = await rawStore('o3')
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(query(path, 'SELECT mask_version FROM fabric_mask')).toEqual([{ mask_version: 1 }])
    const raw = `r1a47h back ${s.key}`
    const db = new DatabaseSync(path)
    try { db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(raw, memoryIds[0]!) } finally { db.close() }
    new SQLiteFabricClient({ databasePath: path }).close()
    // Stated limit: a store that records the version is not looked at again.
    expect(JSON.stringify(query(path, 'SELECT text FROM memories WHERE id = ?', memoryIds[0]!)) === JSON.stringify([{ text: raw }])).toBe(true)
    const db2 = new DatabaseSync(path)
    try { db2.exec('UPDATE fabric_mask SET mask_version = 0') } finally { db2.close() }
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(JSON.stringify(query(path, 'SELECT text FROM memories WHERE id = ?', memoryIds[0]!)) === JSON.stringify([{ text: 'r1a47h back [secret:aws-key]' }])).toBe(true)
    expect(query(path, 'SELECT mask_version FROM fabric_mask')).toEqual([{ mask_version: 1 }])
  })

  it('(47H) o4 the migration shape: an empty store, raw rows inserted, opened again: masked, version recorded', () => {
    const s = secrets()
    const path = storeAt('o4')
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(hasTable(path, 'fabric_mask') ? query(path, 'SELECT count(*) AS n FROM fabric_mask') : [{ n: 0 }]).toEqual([{ n: 0 }])
    const now = Date.now()
    const at = new Date(now).toISOString()
    const db = new DatabaseSync(path)
    try {
      db.exec('BEGIN IMMEDIATE')
      db.prepare(`INSERT INTO projects (project_id, owner_id, display_name, repo_ref, memory_namespace, room_namespace, created_at)
        VALUES ('project-o4', 'owner-a', ?, ?, 'project:project-o4:memory', 'project:project-o4:room', ?)`).run(`o4 ${s.key}`, `o4 ${s.gh}`, at)
      db.prepare(`INSERT INTO memories (id, owner_id, scope, project_id, kind, text, importance, created_at, updated_at, source_type)
        VALUES ('memory-o4', 'owner-a', 'project', 'project-o4', 'fact', ?, 0.5, ?, ?, 'user')`).run(`o4 memo ${s.pem}`, at, at)
      db.exec(`INSERT INTO memory_fts(memory_id, text) SELECT id, text FROM memories WHERE deleted_at IS NULL ORDER BY rowid`)
      db.prepare(`INSERT INTO room_events (id, owner_id, project_id, room, type, from_agent_id, body, created_at, created_at_ms, expires_at_ms, ttl_hops, provenance_device_id)
        VALUES ('event-o4', 'owner-a', 'project-o4', 'r47h', 'message', 'agent-owner', ?, ?, ?, ?, 8, 'device-owner')`).run(`o4 room ${s.key}`, at, now, now + 86_400_000)
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    new SQLiteFabricClient({ databasePath: path }).close()
    const rows = [
      ...query(path, 'SELECT display_name, repo_ref FROM projects'),
      ...query(path, 'SELECT text FROM memories'),
      ...query(path, 'SELECT text FROM memory_fts'),
      ...query(path, 'SELECT body FROM room_events'),
    ]
    expect(rows.length).toBe(4)
    expect(holds(rows, values(s))).toEqual([false, false, false])
    expect(JSON.stringify(query(path, 'SELECT body FROM room_events')) === JSON.stringify([{ body: 'o4 room [secret:aws-key]' }])).toBe(true)
    expect(query(path, 'SELECT mask_version FROM fabric_mask')).toEqual([{ mask_version: 1 }])
  })
})

/**
 * A store that records the version, with the values only in free pages: a table of rows holding them
 * was written and dropped by a writer without secure_delete (what a masking pass leaves behind when
 * the file was not rebuilt after it).
 */
async function staleCopies(name: string) {
  const s = secrets()
  const path = storeAt(name)
  const client = new SQLiteFabricClient({ databasePath: path })
  try {
    const pid = await ownerProject(client)
    await client.remember(owner(pid), { scope: 'project', kind: 'fact', text: 'r1a47h kept memory', importance: 0.5 })
  } finally {
    client.close()
  }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA secure_delete = OFF; CREATE TABLE r1a47h_old (t TEXT)')
    for (let n = 0; n < 200; n++) db.prepare('INSERT INTO r1a47h_old VALUES (?)').run(`${n} ${s.key} ${s.gh} ${'y'.repeat(500)}`)
    db.exec('DROP TABLE r1a47h_old')
  } finally {
    db.close()
  }
  return { s, path }
}
const freePages = (path: string) => query<{ freelist_count: number }>(path, 'PRAGMA freelist_count')[0]!.freelist_count

describe('(o) the file is rebuilt after a masking pass, on a later open when the first try did not finish', () => {
  it('(47H) o5 a rebuild left pending (the first try could not run, or the process ended before it) is done by the next open', async () => {
    const { s, path } = await staleCopies('o5')
    const db = new DatabaseSync(path)
    try { db.exec('CREATE TABLE fabric_mask_vacuum (pending INTEGER)') } finally { db.close() }
    expect(atRest(path, [s.key, s.gh])).toEqual([true, true])
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(hasTable(path, 'fabric_mask_vacuum')).toBe(false)
    expect(atRest(path, [s.key, s.gh])).toEqual([false, false])
    expect(query(path, 'SELECT text FROM memories')).toEqual([{ text: 'r1a47h kept memory' }])
    expect(query(path, 'SELECT mask_version FROM fabric_mask')).toEqual([{ mask_version: 1 }])
  })

  it('(47H) o6 with nothing masked and no rebuild pending the file is not rebuilt (pin)', async () => {
    const { path } = await staleCopies('o6')
    const before = freePages(path)
    expect(before > 0).toBe(true)
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(freePages(path)).toBe(before)
    expect(hasTable(path, 'fabric_mask_vacuum')).toBe(false)
  })

  it('(47H) o7 a pass that masked a row leaves no rebuild pending and no free page holding a value', async () => {
    const { s, path } = await rawStore('o7')
    new SQLiteFabricClient({ databasePath: path }).close()
    expect(hasTable(path, 'fabric_mask_vacuum')).toBe(false)
    expect(atRest(path, values(s))).toEqual([false, false, false])
  })
})

/* ---------------- (s) the Synergy source is never written ---------------- */

describe('(s) the Synergy source store is never written', () => {
  it('(47H) s1 a migrated copy holding keys: the source is unchanged, the target is masked', async () => {
    const fixtureDir = fileURLToPath(new URL('../fixtures/synergy-store/', import.meta.url))
    const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8')) as { subject: string; clock: { end: string; stepMs: number } }
    const clock = (): (() => number) => {
      let t = Date.parse(expected.clock.end)
      return () => { const value = t; t += expected.clock.stepMs; return value }
    }
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
    const s = secrets()
    for (const d of ['src', 'live']) mkdirSync(join(BOX, 's', d), { recursive: true })
    const from = join(BOX, 's', 'src', 'fabric.sqlite3')
    const to = join(BOX, 's', 'out', 'fabric.sqlite3')
    copyFileSync(join(fixtureDir, 'fabric.sqlite3'), from)
    let memoryId = ''
    let eventId = ''
    const db = new DatabaseSync(from)
    try {
      memoryId = (db.prepare('SELECT id FROM memories WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1').get() as { id: string }).id
      eventId = (db.prepare('SELECT id FROM room_events ORDER BY expires_at_ms DESC, sequence DESC LIMIT 1').get() as { id: string }).id
      db.prepare("UPDATE memories SET text = text || ' ' || ? WHERE id = ?").run(s.key, memoryId)
      db.prepare("UPDATE room_events SET body = body || ' ' || ? WHERE id = ?").run(s.gh, eventId)
    } finally {
      db.close()
    }
    const before = sha(from)
    const { migrateFromSynergy } = await import('../../scripts/migrate-from-synergy.ts')
    const result = await migrateFromSynergy({ from, to, fromSubject: expected.subject, liveHome: join(BOX, 's', 'live'), now: clock() })
    expect(result.status).toBe('migrated')
    expect(sha(from)).toBe(before)
    const memo = query<{ text: string }>(to, 'SELECT text FROM memories WHERE id = ?', memoryId)
    const event = query<{ body: string }>(to, 'SELECT body FROM room_events WHERE id = ?', eventId)
    expect([memo.length, event.length]).toEqual([1, 1])
    expect(memo[0]!.text.includes('[secret:aws-key]')).toBe(true)
    expect(event[0]!.body.includes('[secret:github-token]')).toBe(true)
    expect(holds([memo, event], [s.key, s.gh])).toEqual([false, false])
    expect(atRest(to, [s.key, s.gh])).toEqual([false, false])
  })
})

describe('(v) the redact version', () => {
  it('(47H) v1 REDACT_VERSION is exported from bridge/transcripts/redact.ts and equals 1', () => {
    expect(REDACT_VERSION).toBe(1)
  })
})
