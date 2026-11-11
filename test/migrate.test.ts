// U-R1A-42: scripts/migrate-from-synergy.ts, a one-way copy of a Synergy fabric store into a core
// store, re-keyed from Synergy's owner to core's. The fixture was made by Synergy's own code at
// 8fc22da (test/fixtures/synergy-store/make-fixture.ts) and expected.json holds Synergy's answers.
// Every case copies the fixture into its own /tmp/r1a42-case-* folder and migrates that copy;
// liveHome is always a temp folder (the real home's `.tandem` is only ever compared as a string).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { FABRIC_MCP_TRUST, routeFabricRpc } from '../bridge/fabric/rpc-router.ts'
import { SQLiteFabricClient } from '../bridge/fabric/sqlite-fabric-client.ts'
import { configureFabricTools, fabricCallerFor, type FabricToolHandler } from '../src/fabric/mcp-tools.ts'

type Migrate = typeof import('../scripts/migrate-from-synergy.ts')
const load = (): Promise<Migrate> => import('../scripts/migrate-from-synergy.ts')

interface Expected {
  synergyCommit: string
  clock: { start: string; stepMs: number; end: string }
  subject: string
  sha256: string
  projects: Array<{ projectId: string; displayName: string; archived: boolean }>
  rooms: Array<{ projectId: string; room: string; eventIds: string[] }>
  memories: { live: number; forgotten: number }
  searches: Array<{ input: Record<string, unknown>; top5: string[] }>
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'synergy-store')
const fixture = join(fixtureDir, 'fabric.sqlite3')
const script = join(here, '..', 'scripts', 'migrate-from-synergy.ts')
const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8')) as Expected
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/** expected.json's clock, picking up where the fixture's last call left it. */
const clock = (): (() => number) => {
  let t = Date.parse(expected.clock.end)
  return () => { const value = t; t += expected.clock.stepMs; return value }
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const listing = (dir: string) => readdirSync(dir).sort().map(name => {
  const stat = statSync(join(dir, name))
  return [name, stat.size, stat.mtimeMs]
})
const once = (n: number) => `fixture-case-${n}`

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A case folder: src/fabric.sqlite3 (a fixture copy), live/ (the liveHome), out/ (absent, for --to). */
function freshCase() {
  const dir = mkdtempSync('/tmp/r1a42-case-')
  made.push(dir)
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'live'))
  const from = join(dir, 'src', 'fabric.sqlite3')
  copyFileSync(fixture, from)
  return { dir, from, to: join(dir, 'out', 'fabric.sqlite3'), live: join(dir, 'live') }
}
type Case = ReturnType<typeof freshCase>

async function run(c: Case, overrides: Record<string, unknown> = {}) {
  const { migrateFromSynergy } = await load()
  return migrateFromSynergy({ from: c.from, to: c.to, fromSubject: expected.subject, liveHome: c.live, now: clock(), ...overrides })
}

/** Every table's rows, BigInts kept, so a 63-bit value never throws. */
function tables(path: string): Map<string, Array<Record<string, unknown>>> {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const names = (database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(row => row.name)
    return new Map(names.map(name => {
      const statement = database.prepare(`SELECT * FROM "${name}"`)
      statement.setReadBigInts(true)
      return [name, statement.all() as Array<Record<string, unknown>>]
    }))
  } finally {
    database.close()
  }
}
const canonical = (row: unknown) => JSON.stringify(row, (_key, value) =>
  typeof value === 'bigint' ? `${value}n` : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value)
const digests = (path: string) => Object.fromEntries([...tables(path)].map(([name, rows]) =>
  [name, createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex')]))
const count = (path: string, sql: string) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return Number((database.prepare(sql).get() as { n: number | bigint }).n) } finally { database.close() }
}

/** Core's own surface on the target: core's MCP tools for subject `owner`, core's router, no bus. */
async function coreTools(databasePath: string) {
  const client = new SQLiteFabricClient({ databasePath, now: clock() })
  const tools = new Map<string, FabricToolHandler>()
  const registered = await configureFabricTools({ registerTool: (name, _definition, handler) => { tools.set(name, handler) } }, {
    enabled: '1',
    oauthSubject: 'owner',
    rpc: async (path, body) => {
      const answer = await routeFabricRpc({ trust: FABRIC_MCP_TRUST, client, method: 'POST', path, body })
      if (answer.status !== 200) throw new Error(`fabric rpc ${path} answered ${answer.status}`)
      return answer.body
    },
  })
  expect(registered).toBe(true)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const value = JSON.parse((await tools.get(name)!(args)).content[0].text)
    expect(value?.error, name).toBeUndefined()
    return value
  }
  return { call, close: () => client.close() }
}

describe('migrate-from-synergy (U-R1A-42)', () => {
  it('(a) the fixture is real: its sha256 is expected.json\'s; user_version 12 with bus_sequence and room_bus_watermark rows', () => {
    expect(expected.synergyCommit).toBe('8fc22da')
    expect(sha(fixture)).toBe(expected.sha256)
    const c = freshCase()
    expect(count(c.from, 'SELECT user_version AS n FROM pragma_user_version')).toBe(12)
    expect(count(c.from, 'SELECT count(*) AS n FROM room_events WHERE bus_sequence IS NOT NULL')).toBeGreaterThan(0)
    expect(count(c.from, 'SELECT count(*) AS n FROM room_bus_watermark')).toBeGreaterThan(0)
  })

  it('(b) core reads what Synergy answered: projects, room events in order, memory counts, the 20 searches; no Synergy id is left', async () => {
    const c = freshCase()
    const result = await run(c)
    expect(result.status).toBe('migrated')
    expect(result.counts).toEqual({ projects: 3, rooms: 4, events: 40, memories: 30 })
    // room_events is the record now: no bus position on a row, and the bus bookkeeping and short-lived state stay behind.
    expect(count(c.to, 'SELECT count(*) AS n FROM room_events WHERE bus_sequence IS NOT NULL')).toBe(0)
    for (const table of ['room_bus_watermark', 'room_bus_fence', 'idempotency', 'room_cursors', 'room_rate_windows']) {
      expect(count(c.to, `SELECT count(*) AS n FROM ${table}`), table).toBe(0)
    }

    const core = await coreTools(c.to)
    try {
      const projects = await core.call('project_list') as Array<{ projectId: string; displayName: string; archivedAt?: string }>
      expect(projects.map(p => ({ projectId: p.projectId, displayName: p.displayName, archived: p.archivedAt !== undefined }))).toEqual(expected.projects)
      for (const room of expected.rooms) {
        const read = await core.call('room_read', { projectId: room.projectId, room: room.room, limit: 500 })
        expect((read.events as Array<{ id: string }>).map(event => event.id), room.room).toEqual(room.eventIds)
      }
      expect(expected.searches).toHaveLength(20)
      for (const search of expected.searches) {
        const found = await core.call('memory_search', search.input)
        expect((found.records as Array<{ id: string }>).slice(0, 5).map(record => record.id), JSON.stringify(search.input)).toEqual(search.top5)
      }
    } finally {
      core.close()
    }
    expect(count(c.to, 'SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL')).toBe(expected.memories.live)
    expect(count(c.to, 'SELECT count(*) AS n FROM memories WHERE deleted_at IS NOT NULL')).toBe(expected.memories.forgotten)

    const synergyCaller = await fabricCallerFor(expected.subject)
    const coreCaller = await fabricCallerFor('owner')
    const synergyIds = new Set([synergyCaller.ownerId, synergyCaller.deviceId, synergyCaller.agentId])
    const left: string[] = []
    const otherOwners: string[] = []
    let ownerColumns = 0
    for (const [table, rows] of tables(c.to)) {
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'string' && synergyIds.has(value)) left.push(`${table}.${column}`)
          if (column === 'owner_id') { ownerColumns += 1; if (value !== coreCaller.ownerId) otherOwners.push(table) }
        }
      }
    }
    expect(left).toEqual([])
    expect(otherOwners).toEqual([])
    expect(ownerColumns).toBeGreaterThan(0)
  })

  it('(c) the new store works: a post reads back after the migrated events; remember then search finds it; project_list lists the projects', async () => {
    const c = freshCase()
    await run(c)
    const core = await coreTools(c.to)
    try {
      const room = expected.rooms[0]
      const posted = await core.call('room_post', { projectId: room.projectId, room: room.room, type: 'message', body: 'A new note posted after the move.', idempotencyKey: once(1) })
      const read = await core.call('room_read', { projectId: room.projectId, room: room.room, limit: 500 })
      expect((read.events as Array<{ id: string }>).map(event => event.id)).toEqual([...room.eventIds, posted.id])
      const remembered = await core.call('memory_remember', { scope: 'user', kind: 'fact', importance: 0.9, text: 'The compost bin moved behind the shed after the move.' })
      const found = await core.call('memory_search', { query: 'compost bin behind the shed' })
      expect((found.records as Array<{ id: string }>).map(record => record.id)).toContain(remembered.id)
      const projects = await core.call('project_list') as Array<{ projectId: string }>
      expect(projects.map(p => p.projectId)).toEqual(expected.projects.map(p => p.projectId))
    } finally {
      core.close()
    }
  })

  it('(d) the source is left as it was: same sha256, same folder listing (no -wal, -shm or -journal); no partial is left', async () => {
    const c = freshCase()
    const before = listing(dirname(c.from))
    const shaBefore = sha(c.from)
    await run(c)
    expect(sha(c.from)).toBe(shaBefore)
    expect(listing(dirname(c.from))).toEqual(before)
    expect(readdirSync(dirname(c.from))).toEqual(['fabric.sqlite3'])
    expect(readdirSync(dirname(c.to))).toEqual(['fabric.sqlite3'])
  })

  it('(e) idempotent: a second run answers already migrated (no change) and every table digest of the target is unchanged', async () => {
    const c = freshCase()
    expect((await run(c)).status).toBe('migrated')
    const before = digests(c.to)
    const shaBefore = sha(c.to)
    expect((await run(c)).status).toBe('already migrated (no change)')
    expect(digests(c.to)).toEqual(before)
    expect(sha(c.to)).toBe(shaBefore)
  })

  describe('(f) refusals leave --to absent (or unchanged) and the source unchanged', () => {
    async function refused(c: Case, overrides: Record<string, unknown>, reason: RegExp) {
      const from = (overrides.from as string | undefined) ?? c.from
      const to = (overrides.to as string | undefined) ?? c.to
      const fromBefore = sha(from)
      const toBefore = existsSync(to) ? sha(to) : undefined
      await expect(run(c, overrides)).rejects.toThrow(reason)
      expect(sha(from)).toBe(fromBefore)
      if (toBefore === undefined) expect(existsSync(to)).toBe(false)
      else expect(sha(to)).toBe(toBefore)
    }

    it('(f) the default liveHome is the account home\'s .tandem (a string check, no fs call)', async () => {
      const { defaultLiveHome } = await load()
      expect(defaultLiveHome()).toBe(join(userInfo().homedir, '.tandem'))
    })

    it('(f) source inside the liveHome temp folder', async () => {
      const c = freshCase()
      const inside = join(c.live, 'fabric.sqlite3')
      copyFileSync(fixture, inside)
      await refused(c, { from: inside }, /^REFUSED --from is inside the live Tandem home/)
    })

    it('(f) a symlink outside the liveHome pointing into it (folder link and file link)', async () => {
      const c = freshCase()
      copyFileSync(fixture, join(c.live, 'fabric.sqlite3'))
      symlinkSync(c.live, join(c.dir, 'link'))
      symlinkSync(join(c.live, 'fabric.sqlite3'), join(c.dir, 'file-link.sqlite3'))
      await refused(c, { from: join(c.dir, 'link', 'fabric.sqlite3') }, /^REFUSED --from resolves inside the live Tandem home/)
      await refused(c, { from: join(c.dir, 'file-link.sqlite3') }, /^REFUSED --from resolves inside the live Tandem home/)
    })

    it('(f) --from equal to --to', async () => {
      const c = freshCase()
      await refused(c, { to: c.from }, /^REFUSED --from and --to are the same file/)
    })

    it('(f) --to inside the liveHome temp folder', async () => {
      const c = freshCase()
      await refused(c, { to: join(c.live, 'fabric', 'fabric.sqlite3') }, /^REFUSED --to is inside the live Tandem home/)
      expect(readdirSync(c.live)).toEqual([])
    })

    it('(f) a non-empty <from>-wal beside the source', async () => {
      const c = freshCase()
      writeFileSync(`${c.from}-wal`, 'unmerged')
      await refused(c, {}, /^REFUSED an unmerged write-ahead log is beside the source; give a checkpointed copy/)
    })

    it('(f) a copy with user_version 11, one with an extra table, one with a row of another owner', async () => {
      const edits: Array<[string, RegExp]> = [
        ['PRAGMA user_version = 11', /^REFUSED source schema version 11, expected 12/],
        ['CREATE TABLE fixture_extra (note TEXT)', /^REFUSED unknown table fixture_extra/],
        [`UPDATE memories SET owner_id = 'owner-fixture-other' WHERE id = (SELECT id FROM memories ORDER BY rowid LIMIT 1)`, /^REFUSED 1 other owner/],
      ]
      for (const [sql, reason] of edits) {
        const c = freshCase()
        const database = new DatabaseSync(c.from)
        database.exec(sql)
        database.close()
        await refused(c, {}, reason)
      }
    })

    it('(f) a target that exists and differs', async () => {
      const c = freshCase()
      new SQLiteFabricClient({ databasePath: c.to, now: clock() }).close()
      await refused(c, {}, /^REFUSED target exists and differs; migrate into a new path/)
    })
  })

  it('(g) the CLI as a child process: PASS migrated with no room body or memory text in its output; no --from-subject is REFUSED', () => {
    const c = freshCase()
    const cli = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8' })
    const ran = cli(['--from', c.from, '--to', c.to, '--from-subject', expected.subject])
    expect(ran.status, ran.stdout + ran.stderr).toBe(0)
    expect(ran.stdout.trim().split('\n').at(-1)).toBe('migrate: PASS migrated')
    const database = new DatabaseSync(c.from, { readOnly: true })
    const private6 = [
      ...(database.prepare('SELECT body AS v FROM room_events ORDER BY sequence LIMIT 3').all() as Array<{ v: string }>),
      ...(database.prepare('SELECT text AS v FROM memories ORDER BY rowid LIMIT 3').all() as Array<{ v: string }>),
    ].map(row => row.v)
    database.close()
    expect(private6).toHaveLength(6)
    for (const text of private6) expect(ran.stdout + ran.stderr).not.toContain(text)

    const other = freshCase()
    const missing = cli(['--from', other.from, '--to', other.to])
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('migrate: REFUSED')
    expect(existsSync(other.to)).toBe(false)
  }, 60_000)
})
