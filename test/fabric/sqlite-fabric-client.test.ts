import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCallerContext,
  FabricAccessError,
  FabricAuthError,
} from '../../src/fabric/capabilities.ts'
import type { CallerContext, FabricCapability } from '../../src/fabric/types.ts'
import { FabricValidationError } from '../../src/fabric/validation.ts'
import {
  CURRENT_FABRIC_SCHEMA_VERSION,
  FABRIC_CLEANUP_BATCH_SIZE,
  FabricStorageError,
  SQLiteFabricClient,
  type FabricAuditEntry,
} from '../../bridge/fabric/sqlite-fabric-client.ts'

// Vitest 2 predates node:sqlite and does not externalize that newer builtin.
// Loading it through Node's native require keeps the test on the real builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const allCapabilities: FabricCapability[] = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:write:user',
  'memory:read', 'memory:read:user', 'memory:delete',
]

const caller = (
  agentId: string,
  projectId?: string,
  options: {
    ownerId?: string
    deviceId?: string
    actorType?: 'agent' | 'owner'
    capabilities?: readonly FabricCapability[]
  } = {},
): CallerContext => createCallerContext({
  ownerId: options.ownerId ?? 'owner-a',
  deviceId: options.deviceId ?? `device-${agentId}`,
  agentId,
  projectId,
  actorType: options.actorType ?? 'agent',
  capabilities: options.capabilities ?? allCapabilities,
})

const temporaryDirectories = new Set<string>()
function privateDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tandem-fabric-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.add(directory)
  return join(directory, 'fabric.sqlite3')
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

async function teamProject(client: SQLiteFabricClient) {
  return client.createProject(caller('agent-a', undefined, { actorType: 'owner' }), {
    displayName: 'Alpha',
    memberAgentIds: ['agent-b', 'agent-c'],
  })
}

describe('SQLiteFabricClient Phase 1 durable contract', () => {
  it('creates, lists, gets, archives, and durably reopens projects', async () => {
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath })
    const project = await teamProject(first)
    expect((await first.listProjects(caller('agent-b'))).map(value => value.projectId)).toEqual([project.projectId])
    expect((await first.getProject(caller('agent-c'), project.projectId))?.displayName).toBe('Alpha')
    expect(await first.getProject(caller('outsider'), project.projectId)).toBeNull()
    first.close()

    const reopened = new SQLiteFabricClient({ databasePath })
    expect((await reopened.getProject(caller('agent-b'), project.projectId))?.projectId).toBe(project.projectId)
    const archived = await reopened.archiveProject(caller('agent-a', project.projectId), project.projectId)
    expect(archived.alreadyArchived).toBe(false)
    expect((await reopened.archiveProject(caller('agent-a', project.projectId), project.projectId)).alreadyArchived).toBe(true)
    const scoped = caller('agent-a', project.projectId)
    await expect(reopened.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'blocked', idempotencyKey: 'blocked' })).rejects.toBeInstanceOf(FabricAccessError)
    await expect(reopened.remember(scoped, { scope: 'project', kind: 'fact', text: 'blocked', importance: 0.5 })).rejects.toBeInstanceOf(FabricAccessError)
    reopened.close()
  })

  it('exchanges, isolates, replays after an extended offline period, and filters directed project-room events exactly once', async () => {
    let now = Date.UTC(2026, 7, 12)
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), now: () => now })
    const project = await teamProject(client)
    const other = await client.createProject(caller('agent-a'), { displayName: 'Other' })
    const a = caller('agent-a', project.projectId)
    const b = caller('agent-b', project.projectId)
    const c = caller('agent-c', project.projectId)
    const otherA = caller('agent-a', other.projectId)

    const privateEvent = await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'private', toAgentId: 'agent-b', idempotencyKey: 'private' })
    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'broadcast', idempotencyKey: 'broadcast' })
    expect((await client.readRoom(a, { room: 'main' })).events.map(event => event.body)).toEqual(['private', 'broadcast'])
    const firstRead = await client.readRoom(b, { room: 'main' })
    expect(firstRead.events.map(event => event.body)).toEqual(['private', 'broadcast'])
    await client.postRoomEvent(b, { room: 'main', type: 'message', body: 'agent-b reply', replyTo: privateEvent.id, idempotencyKey: 'agent-b-reply' })
    expect((await client.readRoom(a, { room: 'main' })).events.map(event => event.body)).toEqual(['private', 'broadcast', 'agent-b reply'])
    expect((await client.readRoom(c, { room: 'main' })).events.map(event => event.body)).toEqual(['broadcast', 'agent-b reply'])
    expect((await client.readRoom(otherA, { room: 'main' })).events).toEqual([])

    now += 10 * 60_000
    await client.postRoomEvent(a, { room: 'main', type: 'progress', body: 'missed while offline', idempotencyKey: 'offline' })
    const resumed = await client.readRoom(b, { room: 'main', cursor: firstRead.cursor })
    expect(resumed.events.map(event => event.body)).toEqual(['missed while offline'])
    expect(await client.readRoom(b, { room: 'main', cursor: resumed.cursor })).toMatchObject({ events: [] })
    await expect(client.readRoom(otherA, { room: 'main', cursor: firstRead.cursor })).rejects.toThrow(FabricValidationError)
    client.close()
  })

  it('deduplicates logical room work across independently opened clients and restarts', async () => {
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath })
    const project = await teamProject(first)
    const scoped = caller('agent-a', project.projectId)
    const event = await first.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'exactly once', idempotencyKey: 'same' })
    const second = new SQLiteFabricClient({ databasePath })
    const [retryA, retryB] = await Promise.all([
      first.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'exactly once', idempotencyKey: 'same' }),
      second.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'exactly once', idempotencyKey: 'same' }),
    ])
    expect(retryA.id).toBe(event.id)
    expect(retryB.id).toBe(event.id)
    expect((await second.readRoom(scoped, { room: 'main' })).events).toHaveLength(1)
    await expect(second.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'changed', idempotencyKey: 'same' })).rejects.toBeInstanceOf(FabricAccessError)
    first.close()
    second.close()

    const reopened = new SQLiteFabricClient({ databasePath })
    expect((await reopened.readRoom(scoped, { room: 'main' })).events.map(value => value.id)).toEqual([event.id])
    reopened.close()
  })

  it('fingerprints room-post and promotion idempotency on every semantic field, matching the in-memory contract', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const a = caller('agent-a', project.projectId)
    const post = {
      room: 'main', type: 'decision' as const, body: 'once',
      artifactRefs: ['a', 'b'], ttlHops: 4, sessionId: 'session-a', idempotencyKey: 'room-key',
    }
    const first = await client.postRoomEvent(a, post)
    expect((await client.postRoomEvent(a, { ...post })).id).toBe(first.id)
    for (const changed of [
      { ...post, artifactRefs: ['b', 'a'] },
      { ...post, ttlHops: 5 },
      { ...post, sessionId: 'session-b' },
    ]) {
      await expect(client.postRoomEvent(a, changed)).rejects.toBeInstanceOf(FabricAccessError)
    }
    const otherDevice = caller('agent-a', project.projectId, { deviceId: 'device-other' })
    await expect(client.postRoomEvent(otherDevice, { ...post })).rejects.toBeInstanceOf(FabricAccessError)

    const second = await client.postRoomEvent(a, { ...post, idempotencyKey: 'room-key-2', body: 'second' })
    const promotion = { roomEventId: first.id, kind: 'decision' as const, importance: .5, confidence: .8, idempotencyKey: 'promotion-key' }
    const memory = await client.promoteRoomEvent(a, promotion)
    expect((await client.promoteRoomEvent(a, { ...promotion })).id).toBe(memory.id)
    for (const changed of [
      { ...promotion, roomEventId: second.id },
      { ...promotion, kind: 'fact' as const },
      { ...promotion, importance: .6 },
      { ...promotion, confidence: .7 },
    ]) {
      await expect(client.promoteRoomEvent(a, changed)).rejects.toBeInstanceOf(FabricAccessError)
    }
    client.close()
  })

  it('replays an exact retained reply retry after its earlier parent expires', async () => {
    let now = Date.UTC(2026, 7, 12)
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), now: () => now })
    const project = await client.createProject(caller('agent-a'), {
      displayName: 'Retained reply retry', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const parent = await client.postRoomEvent(scoped, {
      room: 'main', type: 'question', body: 'parent expires first', idempotencyKey: 'retained-parent',
    })

    now += 60 * 60_000
    const replyInput = {
      room: 'main' as const,
      type: 'answer' as const,
      body: 'reply remains retained',
      replyTo: parent.id,
      idempotencyKey: 'retained-reply',
    }
    const reply = await client.postRoomEvent(scoped, replyInput)

    now += 23 * 60 * 60_000 + 1
    expect((await client.postRoomEvent(scoped, replyInput)).id).toBe(reply.id)
    client.close()
  })

  it('catches a reply retry that drops its explicit ttlHops while the parent is still resolvable', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const scoped = caller('agent-a', project.projectId)
    const root = await client.postRoomEvent(scoped, { room: 'main', type: 'question', body: 'root', idempotencyKey: 'root' })
    expect(root.ttlHops).toBe(8)

    const replyKey = 'explicit-reply'
    const explicitReply = await client.postRoomEvent(scoped, {
      room: 'main', type: 'answer', body: 'explicit hop budget', replyTo: root.id, ttlHops: 3, idempotencyKey: replyKey,
    })
    expect(explicitReply.ttlHops).toBe(3)

    // Same idempotency key, but this retry omits ttlHops. Freshly resolved that means
    // "whatever the parent has left" (7), not the 3 the original request pinned - a
    // genuine semantic change that must not silently dedupe against the pinned reply.
    await expect(client.postRoomEvent(scoped, {
      room: 'main', type: 'answer', body: 'explicit hop budget', replyTo: root.id, idempotencyKey: replyKey,
    })).rejects.toBeInstanceOf(FabricAccessError)

    // An exact retry - same explicit ttlHops - still dedupes.
    expect((await client.postRoomEvent(scoped, {
      room: 'main', type: 'answer', body: 'explicit hop budget', replyTo: root.id, ttlHops: 3, idempotencyKey: replyKey,
    })).id).toBe(explicitReply.id)

    // An implicit reply (no explicit ttlHops either time) still dedupes against itself.
    const implicitKey = 'implicit-reply'
    const implicitReply = await client.postRoomEvent(scoped, {
      room: 'main', type: 'answer', body: 'implicit hop budget', replyTo: root.id, idempotencyKey: implicitKey,
    })
    expect(implicitReply.ttlHops).toBe(7)
    expect((await client.postRoomEvent(scoped, {
      room: 'main', type: 'answer', body: 'implicit hop budget', replyTo: root.id, idempotencyKey: implicitKey,
    })).id).toBe(implicitReply.id)
    client.close()
  })

  it('shares project memory without leaking project, agent, or user scopes', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const other = await client.createProject(caller('agent-a'), { displayName: 'Other' })
    const a = caller('agent-a', project.projectId)
    const b = caller('agent-b', project.projectId)
    const projectMemory = await client.remember(a, { scope: 'project', kind: 'constraint', text: 'shared alpha rule', importance: 0.9 })
    await client.remember(b, { scope: 'project', kind: 'fact', text: 'shared beta detail', importance: 0.6 })
    await client.remember(a, { scope: 'agent', kind: 'fact', text: 'private agent note', importance: 0.5 })

    expect((await client.searchMemory(b, { query: 'shared' })).records).toHaveLength(2)
    expect((await client.getMemory(b, projectMemory.id))?.id).toBe(projectMemory.id)
    expect((await client.searchMemory(caller('agent-a', other.projectId), { query: 'shared' })).records).toEqual([])
    // Hybrid retrieval favours recall under a bounded semantic budget, so an
    // unmatched query can still return authorized project memory. What must
    // never appear is another agent's private note.
    const privateNote = await client.remember(a, { scope: 'agent', kind: 'fact', text: 'private agent ledger key', importance: 0.5 })
    expect((await client.searchMemory(b, { query: 'private agent' })).records.map(record => record.id)).not.toContain(privateNote.id)
    expect((await client.searchMemory(caller('agent-a'), { query: 'private agent' })).records.map(record => record.id)).not.toContain(privateNote.id)
    expect((await client.searchMemory(caller('agent-a'), { query: 'private agent' })).records.every(record => record.scope !== 'agent')).toBe(true)

    const owner = caller('agent-a', undefined, { actorType: 'owner' })
    const userMemory = await client.remember(owner, { scope: 'user', kind: 'preference', text: 'owner global preference', importance: 0.8, authorship: 'owner' })
    expect(userMemory.projectId).toBeUndefined()
    expect(userMemory.agentId).toBeUndefined()
    expect((await client.searchMemory(owner, { scope: 'user', query: 'global' })).records.map(record => record.id)).toEqual([userMemory.id])
    const insideProject = await client.searchMemory(caller('agent-a', project.projectId, { actorType: 'owner' }), { query: 'global' })
    expect(insideProject.records.map(record => record.id)).not.toContain(userMemory.id)
    expect(insideProject.records.every(record => record.scope === 'project')).toBe(true)
    client.close()
  })

  it('applies memory authorization and ranking before the SQL result limit', async () => {
    const preparedSql: string[] = []
    const nativePrepare = DatabaseSync.prototype.prepare
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      preparedSql.push(sql)
      return nativePrepare.call(this, sql)
    })
    try {
      const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
      const visibleProject = await teamProject(client)
      const hiddenProject = await client.createProject(caller('agent-a'), { displayName: 'Hidden' })
      const hidden = caller('agent-a', hiddenProject.projectId)
      for (let index = 0; index < 25; index++) {
        await client.remember(hidden, { scope: 'project', kind: 'fact', text: `bounded query ${index}`, importance: 1 })
      }
      const visible = await client.remember(caller('agent-b', visibleProject.projectId), {
        scope: 'project', kind: 'fact', text: 'bounded query visible', importance: 0.1,
      })
      preparedSql.length = 0
      expect((await client.searchMemory(caller('agent-b', visibleProject.projectId), { query: 'bounded query', limit: 1 })).records.map(record => record.id)).toEqual([visible.id])
      const rowSql = preparedSql.filter(sql => sql.includes('SELECT m.* FROM memories m'))
      expect(rowSql).not.toHaveLength(0)
      for (const sql of rowSql) {
        expect(sql).toContain("m.scope = 'project' AND m.project_id = ?")
        expect(sql).not.toContain('successor.deleted_at')
        // Candidates are hydrated from an explicit identifier list. A search must
        // never select an entire scope's rows to filter them in process.
        expect(sql).toContain('m.id IN (')
      }
      client.close()
    } finally {
      prepare.mockRestore()
    }
  })

  it('keeps a superseded predecessor obsolete when its successor is deleted', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const ctx = caller('agent-a')
    const original = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'deploy on Friday', importance: 0.5 })
    const corrected = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'deploy on Monday', importance: 0.8, supersedes: original.id })
    expect((await client.searchMemory(ctx, { query: 'deploy' })).records.map(record => record.id)).toEqual([corrected.id])
    expect((await client.getMemory(ctx, original.id))?.id).toBe(original.id)
    await client.forgetMemory(ctx, corrected.id)
    expect((await client.searchMemory(ctx, { query: 'deploy' })).records).toEqual([])
    const correctedAgain = await client.remember(ctx, { scope: 'agent', kind: 'fact', text: 'deploy on Tuesday', importance: 0.9, supersedes: original.id })
    expect((await client.searchMemory(ctx, { query: 'deploy' })).records.map(record => record.id)).toEqual([correctedAgain.id])
    client.close()
  })

  it('never auto-promotes room chatter and explicitly promotes decisions with stored provenance', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const a = caller('agent-a', project.projectId, { deviceId: 'trusted-device-a' })
    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'ordinary chatter', idempotencyKey: 'chatter' })
    expect((await client.searchMemory(a, { query: 'ordinary chatter' })).records).toEqual([])
    const decision = await client.postRoomEvent(a, { room: 'main', type: 'decision', body: 'use SQLite locally', sessionId: 'trusted-session', idempotencyKey: 'decision' })
    const promoted = await client.promoteRoomEvent(a, { roomEventId: decision.id, kind: 'decision', importance: 0.9, idempotencyKey: 'promotion' })
    expect(promoted.text).toBe('use SQLite locally')
    expect(promoted.source).toEqual({ type: 'room', agentId: 'agent-a', roomEventId: decision.id, sessionId: 'trusted-session' })
    expect((await client.promoteRoomEvent(a, { roomEventId: decision.id, kind: 'decision', importance: 0.9, idempotencyKey: 'promotion' })).id).toBe(promoted.id)
    client.close()
  })

  it('reclaims promotion idempotency metadata when its retained source event expires', async () => {
    let now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await client.createProject(caller('agent-a'), { displayName: 'Bounded', retention: { roomRetentionDays: 1 } })
    const scoped = caller('agent-a', project.projectId)
    const event = await client.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'retain this decision', idempotencyKey: 'event' })
    await client.promoteRoomEvent(scoped, { roomEventId: event.id, kind: 'decision', importance: 0.8, idempotencyKey: 'promotion' })
    now += 86_400_001
    await client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'trigger cleanup', idempotencyKey: 'cleanup' })
    client.close()

    const inspected = new DatabaseSync(databasePath)
    const row = inspected.prepare("SELECT count(*) AS count FROM idempotency WHERE operation = 'memory.promote'").get() as { count: number }
    expect(row.count).toBe(0)
    inspected.close()
  })

  it('physically reclaims expired events and idempotency records on startup without a new write', async () => {
    let now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await first.createProject(caller('agent-a'), {
      displayName: 'Startup cleanup', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const event = await first.postRoomEvent(scoped, {
      room: 'main', type: 'decision', body: 'expires while inactive', idempotencyKey: 'startup-event',
    })
    await first.promoteRoomEvent(scoped, {
      roomEventId: event.id, kind: 'decision', importance: 0.8, idempotencyKey: 'startup-promotion',
    })
    first.close()

    const before = new DatabaseSync(databasePath)
    const eventRow = before.prepare('SELECT sequence FROM room_events WHERE id = ?').get(event.id) as { sequence: number }
    expect((before.prepare('SELECT count(*) AS count FROM room_events').get() as { count: number }).count).toBe(1)
    expect((before.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count).toBe(2)
    before.close()

    now += 86_400_001
    const reopened = new SQLiteFabricClient({ databasePath, now: () => now })
    reopened.close()

    const after = new DatabaseSync(databasePath)
    expect((after.prepare('SELECT count(*) AS count FROM room_events').get() as { count: number }).count).toBe(0)
    expect((after.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count).toBe(0)
    expect((after.prepare(`
      SELECT replay_floor_sequence FROM room_stream_state
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'main'
    `).get(project.projectId) as { replay_floor_sequence: number }).replay_floor_sequence).toBe(eventRow.sequence)
    after.close()
  })

  it('drains more than one cleanup batch on startup so a restart with only reads still purges all expired plaintext', async () => {
    const now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await first.createProject(caller('agent-a'), {
      displayName: 'Startup backlog', retention: { roomRetentionDays: 1 },
    })
    first.close()

    const overflow = FABRIC_CLEANUP_BATCH_SIZE + 5
    const seeded = new DatabaseSync(databasePath)
    const insertEvent = seeded.prepare(`
      INSERT INTO room_events (
        id, owner_id, project_id, room, type, from_agent_id, body, created_at,
        created_at_ms, expires_at_ms, ttl_hops, provenance_device_id
      ) VALUES (?, 'owner-a', ?, 'main', 'message', 'agent-a', 'stale plaintext body', ?, ?, ?, 8, 'device-agent-a')
    `)
    const insertIdempotency = seeded.prepare(`
      INSERT INTO idempotency (
        owner_id, project_id, agent_id, operation, idempotency_key,
        fingerprint, result_id, created_at_ms, expires_at_ms
      ) VALUES ('owner-a', ?, 'agent-a', 'room.post', ?, 'fingerprint', ?, ?, ?)
    `)
    for (let index = 0; index < overflow; index++) {
      const id = `backlog-event-${index}`
      insertEvent.run(id, project.projectId, new Date(now - 2_000).toISOString(), now - 2_000, now - 1)
      insertIdempotency.run(project.projectId, `backlog-key-${index}`, id, now - 2_000, now - 1)
    }
    seeded.close()

    const reopened = new SQLiteFabricClient({ databasePath, now: () => now })
    const scoped = caller('agent-a', project.projectId)
    // A pure read-only poll: no new event is ever posted, so nothing besides startup itself can drive cleanup.
    expect((await reopened.readRoom(scoped, { room: 'main' })).events).toEqual([])
    reopened.close()

    const after = new DatabaseSync(databasePath)
    expect((after.prepare('SELECT count(*) AS count FROM room_events WHERE expires_at_ms <= ?').get(now) as { count: number }).count).toBe(0)
    expect((after.prepare("SELECT count(*) AS count FROM idempotency WHERE operation = 'room.post' AND expires_at_ms <= ?").get(now) as { count: number }).count).toBe(0)
    after.close()
  })

  it('treats an exact expired idempotency key as absent beyond the cleanup batch', async () => {
    const now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await client.createProject(caller('agent-a'), {
      displayName: 'Logical idempotency expiry', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const seeded = new DatabaseSync(databasePath)
    const insert = seeded.prepare(`
      INSERT INTO idempotency (
        owner_id, project_id, agent_id, operation, idempotency_key,
        fingerprint, result_id, created_at_ms, expires_at_ms
      ) VALUES ('owner-a', ?, 'agent-a', 'room.post', ?, ?, ?, ?, ?)
    `)
    for (let index = 0; index < 64; index++) {
      insert.run(
        project.projectId,
        `earlier-expired-${index}`,
        `earlier-fingerprint-${index}`,
        `missing-earlier-result-${index}`,
        now - 2_000,
        now - 2,
      )
    }
    insert.run(
      project.projectId,
      'expired-target-key',
      'stale-target-fingerprint',
      'missing-target-result',
      now - 1_000,
      now - 1,
    )

    const posted = await client.postRoomEvent(scoped, {
      room: 'main',
      type: 'message',
      body: 'fresh request after logical expiry',
      idempotencyKey: 'expired-target-key',
    })
    expect(posted.body).toBe('fresh request after logical expiry')
    const target = seeded.prepare(`
      SELECT result_id, fingerprint, expires_at_ms FROM idempotency
      WHERE owner_id = 'owner-a' AND project_id = ? AND agent_id = 'agent-a'
        AND operation = 'room.post' AND idempotency_key = 'expired-target-key'
    `).get(project.projectId) as { result_id: string; fingerprint: string; expires_at_ms: number }
    expect(target.result_id).toBe(posted.id)
    expect(target.fingerprint).not.toBe('stale-target-fingerprint')
    expect(target.expires_at_ms).toBeGreaterThan(now)
    seeded.close()
    client.close()
  })

  it('derives provenance from trusted caller snapshots and rejects spoof-shaped input', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const trusted = caller('agent-a', project.projectId, { deviceId: 'device-trusted' })
    const event = await client.postRoomEvent(trusted, { room: 'main', type: 'discovery', body: 'found it', idempotencyKey: 'trusted' })
    const memory = await client.remember(trusted, { scope: 'project', kind: 'discovery', text: 'durable finding', importance: 0.7 })
    expect(event.fromAgentId).toBe('agent-a')
    expect(event.provenance.deviceId).toBe('device-trusted')
    expect(memory.source).toEqual({ type: 'agent', agentId: 'agent-a' })
    await expect(client.postRoomEvent(trusted, { room: 'main', type: 'message', body: 'x', idempotencyKey: 'spoof', provenance: { deviceId: 'attacker' } } as never)).rejects.toThrow(FabricValidationError)
    const raw = { ...trusted, agentId: 'attacker' }
    await expect(client.remember(raw as never, { scope: 'project', kind: 'fact', text: 'x', importance: 0.5 })).rejects.toBeInstanceOf(FabricAuthError)
    client.close()
  })

  it('rejects supersession across project and owner boundaries', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const first = await client.createProject(caller('agent-a'), { displayName: 'First' })
    const second = await client.createProject(caller('agent-a'), { displayName: 'Second' })
    const original = await client.remember(caller('agent-a', first.projectId), { scope: 'project', kind: 'fact', text: 'first only', importance: 0.5 })
    await expect(client.remember(caller('agent-a', second.projectId), {
      scope: 'project', kind: 'fact', text: 'scope spoof', importance: 0.6, supersedes: original.id,
    })).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.remember(caller('agent-a', first.projectId, { ownerId: 'owner-b' }), {
      scope: 'project', kind: 'fact', text: 'owner spoof', importance: 0.6, supersedes: original.id,
    })).rejects.toBeInstanceOf(FabricAccessError)
    client.close()
  })

  it('treats SQL metacharacters as data and leaves the schema intact', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await client.createProject(caller('agent-a'), { displayName: "Alpha'); DROP TABLE projects; --" })
    const scoped = caller('agent-a', project.projectId)
    const text = "literal '); DROP TABLE memories; -- payload"
    const memory = await client.remember(scoped, { scope: 'project', kind: 'fact', text, importance: 0.5 })
    expect((await client.searchMemory(scoped, { query: "'); DROP TABLE memories; --" })).records.map(record => record.id)).toEqual([memory.id])
    expect((await client.getProject(scoped, project.projectId))?.displayName).toContain('DROP TABLE projects')
    client.close()
  })

  it('enforces payload, rate, hop, and retention bounds fail closed', async () => {
    let now = Date.UTC(2026, 7, 12)
    const client = new SQLiteFabricClient({
      databasePath: privateDatabasePath(),
      now: () => now,
      roomRateLimit: { maxEvents: 2, windowMs: 1_000 },
    })
    await expect(client.createProject(caller('agent-a'), { displayName: 'Bad', retention: { roomRetentionDays: 0 } })).rejects.toThrow(FabricValidationError)
    const project = await client.createProject(caller('agent-a'), { displayName: 'Bounded', retention: { roomRetentionDays: 1, roomEventTtlHops: 2 } })
    const scoped = caller('agent-a', project.projectId)
    await expect(client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'x'.repeat(16_385), idempotencyKey: 'oversized' })).rejects.toThrow(FabricValidationError)
    const root = await client.postRoomEvent(scoped, { room: 'main', type: 'question', body: 'root', idempotencyKey: 'root' })
    expect(root.ttlHops).toBe(2)
    const reply = await client.postRoomEvent(scoped, { room: 'main', type: 'answer', body: 'reply', replyTo: root.id, idempotencyKey: 'reply' })
    expect(reply.ttlHops).toBe(1)
    await expect(client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'loop', replyTo: reply.id, idempotencyKey: 'loop' })).rejects.toThrow(FabricValidationError)
    await expect(client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'rate limited', idempotencyKey: 'rate' })).rejects.toThrow(FabricValidationError)
    expect((await client.postRoomEvent(scoped, { room: 'main', type: 'question', body: 'root', idempotencyKey: 'root' })).id).toBe(root.id)

    now += 1_001
    const expiring = await client.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'expires', idempotencyKey: 'expires' })
    now += 86_400_001
    expect((await client.readRoom(scoped, { room: 'main' })).events).toEqual([])
    await expect(client.promoteRoomEvent(scoped, { roomEventId: expiring.id, kind: 'decision', importance: 0.5, idempotencyKey: 'expired-promotion' })).rejects.toBeInstanceOf(FabricAccessError)
    client.close()
  })

  it('keeps opaque cursors owner, project, room, and reader bound across reopen', async () => {
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath })
    const project = await teamProject(first)
    const otherProject = await first.createProject(caller('agent-b'), { displayName: 'Other reader project' })
    const otherOwnerProject = await first.createProject(caller('agent-b', undefined, { ownerId: 'owner-b' }), { displayName: 'Other owner project' })
    const a = caller('agent-a', project.projectId)
    const b = caller('agent-b', project.projectId)
    await first.postRoomEvent(a, { room: 'main', type: 'message', body: 'one', idempotencyKey: 'one' })
    const cursor = (await first.readRoom(b, { room: 'main' })).cursor!
    expect(cursor).toMatch(/^[0-9a-f-]{36}$/i)
    expect(cursor).not.toContain(project.projectId)
    first.close()

    const reopened = new SQLiteFabricClient({ databasePath })
    await reopened.postRoomEvent(a, { room: 'main', type: 'message', body: 'two', idempotencyKey: 'two' })
    expect((await reopened.readRoom(b, { room: 'main', cursor })).events.map(event => event.body)).toEqual(['two'])
    await expect(reopened.readRoom(a, { room: 'main', cursor })).rejects.toThrow(FabricValidationError)
    await expect(reopened.readRoom(b, { room: 'other', cursor })).rejects.toThrow(FabricValidationError)
    await expect(reopened.readRoom(caller('agent-b', otherProject.projectId), { room: 'main', cursor })).rejects.toThrow(FabricValidationError)
    await expect(reopened.readRoom(caller('agent-b', otherOwnerProject.projectId, { ownerId: 'owner-b' }), { room: 'main', cursor })).rejects.toThrow(FabricValidationError)
    reopened.close()
  })

  it('reuses cursorless checkpoints per reader and sequence without breaking offline replay', async () => {
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath })
    const project = await teamProject(client)
    const scoped = caller('agent-b', project.projectId)

    const emptyCursors = new Set<string | undefined>()
    for (let index = 0; index < 200; index++) {
      const read = await client.readRoom(scoped, { room: 'main' })
      expect(read.events).toEqual([])
      emptyCursors.add(read.cursor)
    }
    expect(emptyCursors.size).toBe(1)
    const offlineCursor = [...emptyCursors][0]

    const event = await client.postRoomEvent(caller('agent-a', project.projectId), {
      room: 'main', type: 'message', body: 'offline replay remains available', idempotencyKey: 'bounded-cursor-post',
    })
    const advancedCursors = new Set<string | undefined>()
    for (let index = 0; index < 200; index++) {
      const read = await client.readRoom(scoped, { room: 'main' })
      expect(read.events.map(value => value.id)).toEqual([event.id])
      advancedCursors.add(read.cursor)
    }
    expect(advancedCursors.size).toBe(1)
    expect((await client.readRoom(scoped, { room: 'main', cursor: offlineCursor })).events.map(value => value.id))
      .toEqual([event.id])

    const inspected = new DatabaseSync(databasePath)
    expect((inspected.prepare(`
      SELECT count(*) AS count FROM room_cursors
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'main' AND agent_id = 'agent-b'
    `).get(project.projectId) as { count: number }).count).toBe(2)
    inspected.close()
    client.close()
  })

  it('stops extending stale cursor checkpoints below the replay floor', async () => {
    let now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await client.createProject(caller('agent-a', undefined, { actorType: 'owner' }), {
      displayName: 'Stale cursor retention',
      memberAgentIds: ['agent-b'],
      retention: { roomRetentionDays: 1 },
    })
    const writer = caller('agent-a', project.projectId)
    const reader = caller('agent-b', project.projectId)
    await client.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'one', idempotencyKey: 'stale-cursor-one',
    })
    const staleCursor = (await client.readRoom(reader, { room: 'main' })).cursor!

    now += 12 * 60 * 60_000
    await client.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'two', idempotencyKey: 'stale-cursor-two',
    })
    now += 12 * 60 * 60_000 + 1
    await client.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'three', idempotencyKey: 'stale-cursor-three',
    })

    const inspected = new DatabaseSync(databasePath)
    const cursorExpiry = () => (inspected.prepare(
      'SELECT expires_at_ms FROM room_cursors WHERE token = ?',
    ).get(staleCursor) as { expires_at_ms: number } | undefined)?.expires_at_ms
    const lastUsefulExpiry = cursorExpiry()

    now += 12 * 60 * 60_000
    await client.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'four', idempotencyKey: 'stale-cursor-four',
    })
    expect(cursorExpiry()).toBe(lastUsefulExpiry)

    now += 12 * 60 * 60_000 + 1
    await client.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'five', idempotencyKey: 'stale-cursor-five',
    })
    expect(cursorExpiry()).toBeUndefined()
    inspected.close()
    client.close()
  })

  it('persists the retained replay floor and rejects a stale cursor after restart', async () => {
    let now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const first = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await first.createProject(caller('agent-a', undefined, { actorType: 'owner' }), {
      displayName: 'Persistent gap', memberAgentIds: ['agent-b', 'agent-c'], retention: { roomRetentionDays: 1 },
    })
    const a = caller('agent-a', project.projectId)
    const b = caller('agent-b', project.projectId)
    const c = caller('agent-c', project.projectId)

    await first.postRoomEvent(a, { room: 'main', type: 'message', body: 'one', idempotencyKey: 'restart-gap-one' })
    const stale = (await first.readRoom(b, { room: 'main' })).cursor
    const caughtUpFirst = await first.readRoom(c, { room: 'main' })
    now += 60 * 60_000
    await first.postRoomEvent(a, { room: 'main', type: 'progress', body: 'two', idempotencyKey: 'restart-gap-two' })
    const caughtUp = (await first.readRoom(c, { room: 'main', cursor: caughtUpFirst.cursor })).cursor
    now += 22 * 60 * 60_000
    await first.postRoomEvent(a, { room: 'main', type: 'message', body: 'three', idempotencyKey: 'restart-gap-three' })
    now += 2 * 60 * 60_000 + 1
    await first.postRoomEvent(a, { room: 'main', type: 'message', body: 'four triggers cleanup', idempotencyKey: 'restart-gap-four' })
    first.close()

    const reopened = new SQLiteFabricClient({ databasePath, now: () => now })
    await expect(reopened.readRoom(b, { room: 'main', cursor: stale })).rejects.toThrow(FabricValidationError)
    expect((await reopened.readRoom(c, { room: 'main', cursor: caughtUp })).events.map(event => event.body)).toEqual(['three', 'four triggers cleanup'])
    reopened.close()
  })

  it('scopes the persisted replay floor to reader visibility so an invisible directed expiry cannot block an uninvolved reader', async () => {
    let now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await client.createProject(caller('agent-a', undefined, { actorType: 'owner' }), {
      displayName: 'Visibility floor', memberAgentIds: ['agent-b', 'agent-c'], retention: { roomRetentionDays: 1 },
    })
    const a = caller('agent-a', project.projectId)
    const c = caller('agent-c', project.projectId)

    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor one', idempotencyKey: 'floor-one' })
    const caughtUp = (await client.readRoom(c, { room: 'main' })).cursor
    if (caughtUp === undefined) throw new Error('cursor was not issued')

    now += 500
    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor private', toAgentId: 'agent-b', idempotencyKey: 'floor-private' })
    now += 500
    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor two', idempotencyKey: 'floor-two' })
    // Expires the invisible directed event and the already-read broadcast, but not 'floor two'.
    now += 86_399_600
    // Triggers physical cleanup of the two now-expired rows before c ever reads again.
    await client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor three', idempotencyKey: 'floor-three' })

    const resumed = await client.readRoom(c, { room: 'main', cursor: caughtUp })
    expect(resumed.events.map(event => event.body)).toEqual(['floor two', 'floor three'])

    const inspected = new DatabaseSync(databasePath)
    const agentFloors = inspected.prepare(`
      SELECT agent_id FROM room_stream_agent_floor
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'main' ORDER BY agent_id
    `).all(project.projectId) as Array<{ agent_id: string }>
    expect(agentFloors.map(row => row.agent_id)).toEqual(['agent-a', 'agent-b'])
    inspected.close()
    client.close()
  })

  it('issues a room cursor from one locked snapshot with a final replay-floor check', async () => {
    const now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, now: () => now, busyTimeoutMs: 50 })
    const project = await client.createProject(caller('agent-a'), {
      displayName: 'Transactional read', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const event = await client.postRoomEvent(scoped, {
      room: 'main', type: 'message', body: 'must not disappear mid-read', idempotencyKey: 'transactional-read',
    })
    const cleanup = new DatabaseSync(databasePath)
    cleanup.exec('PRAGMA busy_timeout = 1')
    const eventRow = cleanup.prepare('SELECT sequence, expires_at_ms FROM room_events WHERE id = ?').get(event.id) as {
      sequence: number
      expires_at_ms: number
    }
    const nativePrepare = DatabaseSync.prototype.prepare
    let cleanupAttempt: 'pending' | 'applied' | 'blocked' = 'pending'
    let replayFloorReads = 0
    let attempted = false
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: InstanceType<typeof DatabaseSync>,
      sql: string,
    ) {
      const statement = nativePrepare.call(this, sql)
      if (!sql.includes('SELECT max(sequence) AS expired_floor FROM room_events')) return statement
      return new Proxy(statement, {
        get(target, property) {
          if (property !== 'get') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (...params: unknown[]) => {
            const result = target.get(...params as never[])
            replayFloorReads += 1
            if (attempted) return result
            attempted = true
            let began = false
            try {
              cleanup.exec('BEGIN IMMEDIATE')
              began = true
              cleanup.prepare(`
                INSERT INTO room_stream_state (owner_id, project_id, room, replay_floor_sequence)
                VALUES ('owner-a', ?, 'main', ?)
                ON CONFLICT(owner_id, project_id, room)
                DO UPDATE SET replay_floor_sequence = max(replay_floor_sequence, excluded.replay_floor_sequence)
              `).run(project.projectId, eventRow.sequence)
              cleanup.prepare('DELETE FROM room_events WHERE id = ? AND expires_at_ms = ?')
                .run(event.id, eventRow.expires_at_ms)
              cleanup.exec('COMMIT')
              began = false
              cleanupAttempt = 'applied'
            } catch {
              if (began) {
                try { cleanup.exec('ROLLBACK') } catch { /* original contention wins */ }
              }
              cleanupAttempt = 'blocked'
            }
            return result
          }
        },
      }) as typeof statement
    })

    try {
      const read = await client.readRoom(scoped, { room: 'main' })
      expect(cleanupAttempt).toBe('blocked')
      expect(replayFloorReads).toBe(2)
      expect(read.events.map(value => value.id)).toEqual([event.id])
      if (read.cursor === undefined) throw new Error('cursor was not issued')
      const checkpoint = cleanup.prepare('SELECT last_sequence FROM room_cursors WHERE token = ?').get(read.cursor) as {
        last_sequence: number
      }
      expect(checkpoint.last_sequence).toBe(eventRow.sequence)
    } finally {
      prepare.mockRestore()
      cleanup.close()
      client.close()
    }
  })

  it('bounds every foreground cleanup class to one indexed batch and drains incrementally', async () => {
    const cleanupBatchSize = 64
    const now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({
      databasePath,
      now: () => now,
      roomRateLimit: { maxEvents: 1_000, windowMs: 1_000 },
    })
    const project = await client.createProject(caller('agent-a'), {
      displayName: 'Bounded cleanup', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const retained = await client.postRoomEvent(scoped, {
      room: 'other-room', type: 'message', body: 'must survive cleanup', idempotencyKey: 'retained-sentinel',
    })
    const seeded = new DatabaseSync(databasePath)
    const insertEvent = seeded.prepare(`
      INSERT INTO room_events (
        id, owner_id, project_id, room, type, from_agent_id, body, created_at,
        created_at_ms, expires_at_ms, ttl_hops, provenance_device_id
      ) VALUES (?, 'owner-a', ?, 'cleanup-room', 'message', 'agent-a', 'expired', ?, ?, ?, 8, 'device-agent-a')
    `)
    const insertCursor = seeded.prepare(`
      INSERT INTO room_cursors (token, owner_id, project_id, room, agent_id, last_sequence, expires_at_ms)
      VALUES (?, 'owner-a', ?, 'cleanup-room', ?, 0, ?)
    `)
    const insertRate = seeded.prepare(`
      INSERT INTO room_rate_windows (owner_id, project_id, agent_id, window_started_at_ms, event_count)
      VALUES ('owner-a', ?, ?, ?, 1)
    `)
    const insertIdempotency = seeded.prepare(`
      INSERT INTO idempotency (
        owner_id, project_id, agent_id, operation, idempotency_key, fingerprint,
        result_id, created_at_ms, expires_at_ms
      ) VALUES ('owner-a', ?, ?, ?, ?, 'fingerprint', ?, ?, ?)
    `)
    const eventSequences: number[] = []
    for (let index = 0; index < cleanupBatchSize + 5; index++) {
      const eventId = `expired-event-${index}`
      const result = insertEvent.run(eventId, project.projectId, new Date(now - 2_000).toISOString(), now - 2_000, now - 1)
      eventSequences.push(Number(result.lastInsertRowid))
      insertCursor.run(`expired-cursor-${index}`, project.projectId, `cleanup-cursor-agent-${index}`, now - 1)
      insertRate.run(project.projectId, `cleanup-rate-agent-${index}`, now - 2_000)
      insertIdempotency.run(project.projectId, `cleanup-post-agent-${index}`, 'room.post', `cleanup-post-${index}`, eventId, now - 2_000, now - 1)
      insertIdempotency.run(project.projectId, `cleanup-promotion-agent-${index}`, 'memory.promote', `cleanup-promotion-${index}`, `missing-memory-${index}`, now - 2_000, now - 1)
    }

    await client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'first cleanup pass', idempotencyKey: 'cleanup-pass-one' })
    const count = (sql: string): number => (seeded.prepare(sql).get(now) as { count: number }).count
    expect(count('SELECT count(*) AS count FROM room_events WHERE expires_at_ms <= ?')).toBe(5)
    expect(count('SELECT count(*) AS count FROM room_cursors WHERE expires_at_ms <= ?')).toBe(5)
    expect(count('SELECT count(*) AS count FROM room_rate_windows WHERE window_started_at_ms <= ? - 1000')).toBe(5)
    expect((seeded.prepare("SELECT count(*) AS count FROM idempotency WHERE agent_id LIKE 'cleanup-post-agent-%'").get() as { count: number }).count).toBe(5)
    expect((seeded.prepare("SELECT count(*) AS count FROM idempotency WHERE agent_id LIKE 'cleanup-promotion-agent-%'").get() as { count: number }).count).toBe(5)

    const firstFloor = seeded.prepare(`
      SELECT replay_floor_sequence FROM room_stream_state
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'cleanup-room'
    `).get(project.projectId) as { replay_floor_sequence: number }
    expect(firstFloor.replay_floor_sequence).toBe(eventSequences[cleanupBatchSize - 1])

    await client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'second cleanup pass', idempotencyKey: 'cleanup-pass-two' })
    expect(count('SELECT count(*) AS count FROM room_events WHERE expires_at_ms <= ?')).toBe(0)
    expect(count('SELECT count(*) AS count FROM room_cursors WHERE expires_at_ms <= ?')).toBe(0)
    expect(count('SELECT count(*) AS count FROM room_rate_windows WHERE window_started_at_ms <= ? - 1000')).toBe(0)
    expect((seeded.prepare("SELECT count(*) AS count FROM idempotency WHERE agent_id LIKE 'cleanup-post-agent-%'").get() as { count: number }).count).toBe(0)
    expect((seeded.prepare("SELECT count(*) AS count FROM idempotency WHERE agent_id LIKE 'cleanup-promotion-agent-%'").get() as { count: number }).count).toBe(0)
    expect((seeded.prepare(`
      SELECT replay_floor_sequence FROM room_stream_state
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'cleanup-room'
    `).get(project.projectId) as { replay_floor_sequence: number }).replay_floor_sequence).toBe(eventSequences.at(-1))
    expect((seeded.prepare('SELECT count(*) AS count FROM room_events WHERE id = ?').get(retained.id) as { count: number }).count).toBe(1)

    const indexNames = (table: string) => (seeded.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map(row => row.name)
    expect(indexNames('room_events')).toContain('room_events_expiry_idx')
    expect(indexNames('room_cursors')).toContain('room_cursors_expiry_idx')
    expect(indexNames('room_rate_windows')).toContain('room_rate_windows_cleanup_idx')
    expect(indexNames('idempotency')).toContain('idempotency_cleanup_idx')
    expect(indexNames('idempotency')).toContain('idempotency_expiry_idx')
    const sequenceColumn = (seeded.prepare("PRAGMA table_info('room_events')").all() as Array<{ name: string; pk: number }>)
      .find(column => column.name === 'sequence')
    expect(sequenceColumn?.pk).toBe(1)
    const replayFloorPlan = seeded.prepare(`
      EXPLAIN QUERY PLAN SELECT max(sequence) AS expired_floor FROM room_events
      WHERE owner_id = ? AND project_id = ? AND room = ? AND expires_at_ms <= ?
    `).all('owner-a', project.projectId, 'cleanup-room', now) as Array<{ detail: string }>
    expect(replayFloorPlan.map(row => row.detail).join(' ')).toContain('room_events_stream_expiry_idx')
    const idempotencyPlan = seeded.prepare(`
      EXPLAIN QUERY PLAN SELECT rowid FROM idempotency
      WHERE operation = 'memory.promote' AND expires_at_ms <= ?
      ORDER BY expires_at_ms, rowid LIMIT ?
    `).all(now, cleanupBatchSize) as Array<{ detail: string }>
    expect(idempotencyPlan.map(row => row.detail).join(' ')).toContain('idempotency_expiry_idx')
    seeded.close()
    client.close()
  })

  it('rolls back replay-floor advancement when the matching expired-event delete fails', async () => {
    const now = Date.UTC(2026, 7, 12)
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({
      databasePath,
      now: () => now,
      roomRateLimit: { maxEvents: 1_000, windowMs: 1_000 },
    })
    const project = await client.createProject(caller('agent-a'), {
      displayName: 'Atomic cleanup', retention: { roomRetentionDays: 1 },
    })
    const scoped = caller('agent-a', project.projectId)
    const inspected = new DatabaseSync(databasePath)
    const inserted = inspected.prepare(`
      INSERT INTO room_events (
        id, owner_id, project_id, room, type, from_agent_id, body, created_at,
        created_at_ms, expires_at_ms, ttl_hops, provenance_device_id
      ) VALUES ('atomic-expired', 'owner-a', ?, 'atomic-room', 'message', 'agent-a',
        'expired', ?, ?, ?, 8, 'device-agent-a')
    `).run(project.projectId, new Date(now - 2_000).toISOString(), now - 2_000, now - 1)
    inspected.exec(`
      CREATE TRIGGER force_expired_delete_failure
      BEFORE DELETE ON room_events WHEN OLD.id = 'atomic-expired'
      BEGIN SELECT RAISE(ABORT, 'forced cleanup failure'); END
    `)

    await expect(client.postRoomEvent(scoped, {
      room: 'main', type: 'message', body: 'must roll back', idempotencyKey: 'atomic-failed-post',
    })).rejects.toBeInstanceOf(FabricStorageError)
    expect(inspected.prepare(`
      SELECT replay_floor_sequence FROM room_stream_state
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'atomic-room'
    `).get(project.projectId)).toBeUndefined()
    expect((inspected.prepare("SELECT count(*) AS count FROM room_events WHERE id = 'atomic-expired'").get() as { count: number }).count).toBe(1)
    expect((inspected.prepare("SELECT count(*) AS count FROM room_events WHERE body = 'must roll back'").get() as { count: number }).count).toBe(0)

    inspected.exec('DROP TRIGGER force_expired_delete_failure')
    await client.postRoomEvent(scoped, {
      room: 'main', type: 'message', body: 'cleanup can commit', idempotencyKey: 'atomic-success-post',
    })
    expect((inspected.prepare(`
      SELECT replay_floor_sequence FROM room_stream_state
      WHERE owner_id = 'owner-a' AND project_id = ? AND room = 'atomic-room'
    `).get(project.projectId) as { replay_floor_sequence: number }).replay_floor_sequence).toBe(Number(inserted.lastInsertRowid))
    expect((inspected.prepare("SELECT count(*) AS count FROM room_events WHERE id = 'atomic-expired'").get() as { count: number }).count).toBe(0)
    inspected.close()
    client.close()
  })

  it('makes inaccessible and nonexistent direct IDs equally non-oracular', async () => {
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const a = caller('agent-a', project.projectId)
    const memory = await client.remember(a, { scope: 'project', kind: 'fact', text: 'secret memory body', importance: 0.5 })
    const event = await client.postRoomEvent(a, { room: 'main', type: 'decision', body: 'secret room body', idempotencyKey: 'secret' })
    const sameOwnerNonmember = caller('nonmember', project.projectId)
    await expect(client.getMemory(sameOwnerNonmember, memory.id)).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.forgetMemory(sameOwnerNonmember, memory.id)).rejects.toBeInstanceOf(FabricAccessError)
    const attacker = caller('attacker', project.projectId, { ownerId: 'owner-b' })
    const memoryErrors: string[] = []
    for (const id of [memory.id, `memory-${randomUUID()}`]) {
      try { await client.getMemory(attacker, id) } catch (error) { memoryErrors.push(String(error)) }
    }
    expect(memoryErrors).toEqual([memoryErrors[0], memoryErrors[0]])
    const eventErrors: string[] = []
    for (const id of [event.id, `event-${randomUUID()}`]) {
      try { await client.promoteRoomEvent(attacker, { roomEventId: id, kind: 'decision', importance: 0.5, idempotencyKey: `promote-${id}` }) } catch (error) { eventErrors.push(String(error)) }
    }
    expect(eventErrors).toEqual([eventErrors[0], eventErrors[0]])
    expect([...memoryErrors, ...eventErrors].join(' ')).not.toMatch(/secret|owner-|project-|agent-|memory-|event-/)
    client.close()
  })

  it('uses a transactional migration and fails closed on incompatible versions', () => {
    const incompatiblePath = privateDatabasePath()
    const incompatible = new DatabaseSync(incompatiblePath)
    incompatible.exec(`PRAGMA user_version = ${CURRENT_FABRIC_SCHEMA_VERSION + 1}`)
    incompatible.close()
    expect(() => new SQLiteFabricClient({ databasePath: incompatiblePath })).toThrow(FabricStorageError)
    const unchanged = new DatabaseSync(incompatiblePath)
    expect((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_FABRIC_SCHEMA_VERSION + 1)
    unchanged.close()

    const failedPath = privateDatabasePath()
    const malformed = new DatabaseSync(failedPath)
    malformed.exec('CREATE TABLE project_members (broken TEXT); PRAGMA user_version = 0')
    malformed.close()
    expect(() => new SQLiteFabricClient({ databasePath: failedPath })).toThrow(FabricStorageError)
    const inspected = new DatabaseSync(failedPath)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    const tables = (inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(['project_members'])
    inspected.close()
  })

  it('rejects a malformed database that falsely claims the current schema version', () => {
    const databasePath = privateDatabasePath()
    const malformed = new DatabaseSync(databasePath)
    malformed.exec(`
      CREATE TABLE room_cursors (expires_at_ms INTEGER NOT NULL);
      CREATE TABLE room_rate_windows (window_started_at_ms INTEGER NOT NULL);
      CREATE TABLE room_events (
        sequence INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        room TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE room_stream_state (
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        room TEXT NOT NULL,
        replay_floor_sequence INTEGER NOT NULL,
        PRIMARY KEY (owner_id, project_id, room)
      );
      CREATE TABLE idempotency (operation TEXT NOT NULL, expires_at_ms INTEGER NOT NULL);
      INSERT INTO room_events VALUES (1, 'owner-a', 'project-a', 'main', 0);
      INSERT INTO idempotency VALUES ('room.post', 0);
      PRAGMA user_version = ${CURRENT_FABRIC_SCHEMA_VERSION};
    `)
    malformed.close()

    let unexpectedlyOpened: SQLiteFabricClient | undefined
    try {
      expect(() => {
        unexpectedlyOpened = new SQLiteFabricClient({ databasePath, now: () => 1 })
      }).toThrow(FabricStorageError)
    } finally {
      unexpectedlyOpened?.close()
    }

    const inspected = new DatabaseSync(databasePath)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(CURRENT_FABRIC_SCHEMA_VERSION)
    expect((inspected.prepare('SELECT count(*) AS count FROM room_events').get() as { count: number }).count).toBe(1)
    expect((inspected.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count).toBe(1)
    inspected.close()
  })

  it('upgrades version-four idempotency rows with their retained event expiry', async () => {
    const databasePath = privateDatabasePath()
    const now = 1_000
    const initialized = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await initialized.createProject(caller('agent-a'), { displayName: 'Legacy v4' })
    const scoped = caller('agent-a', project.projectId)
    const event = await initialized.postRoomEvent(scoped, {
      room: 'main', type: 'decision', body: 'legacy decision', idempotencyKey: 'post-key',
    })
    await initialized.promoteRoomEvent(scoped, {
      roomEventId: event.id, kind: 'decision', importance: 0.8, idempotencyKey: 'promote-key',
    })
    const cursor = (await initialized.readRoom(scoped, { room: 'main' })).cursor
    if (cursor === undefined) throw new Error('cursor was not issued')
    initialized.close()

    const legacy = new DatabaseSync(databasePath)
    const eventExpiry = (legacy.prepare('SELECT expires_at_ms FROM room_events WHERE id = ?').get(event.id) as {
      expires_at_ms: number
    }).expires_at_ms
    legacy.exec(`
      DROP INDEX idempotency_expiry_idx;
      ALTER TABLE idempotency DROP COLUMN expires_at_ms;
      UPDATE room_cursors SET expires_at_ms = ${eventExpiry - 1};
      PRAGMA user_version = 4;
    `)
    legacy.close()

    const migrated = new SQLiteFabricClient({ databasePath, now: () => now })
    migrated.close()
    const inspected = new DatabaseSync(databasePath)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_FABRIC_SCHEMA_VERSION)
    expect((inspected.prepare('SELECT operation, expires_at_ms FROM idempotency ORDER BY operation').all() as Array<{ operation: string; expires_at_ms: number }>))
      .toEqual([
        { operation: 'memory.promote', expires_at_ms: eventExpiry },
        { operation: 'room.post', expires_at_ms: eventExpiry },
      ])
    expect((inspected.prepare("PRAGMA index_list('idempotency')").all() as Array<{ name: string }>).map(row => row.name))
      .toContain('idempotency_expiry_idx')
    expect(inspected.prepare('SELECT expires_at_ms FROM room_cursors WHERE token = ?').get(cursor)).toBeUndefined()
    inspected.close()
  })

  it('invalidates legacy cursors when version five global replay floors become scoped', async () => {
    const databasePath = privateDatabasePath()
    const now = Date.UTC(2026, 7, 12)
    const initialized = new SQLiteFabricClient({ databasePath, now: () => now })
    const project = await initialized.createProject(caller('agent-a', undefined, { actorType: 'owner' }), {
      displayName: 'Legacy scoped replay floor', memberAgentIds: ['agent-b'],
    })
    const writer = caller('agent-a', project.projectId)
    const reader = caller('agent-b', project.projectId)
    await initialized.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'legacy acknowledged', idempotencyKey: 'legacy-acknowledged',
    })
    const oldCursor = (await initialized.readRoom(reader, { room: 'main' })).cursor
    await initialized.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'legacy deleted broadcast', idempotencyKey: 'legacy-deleted',
    })
    await initialized.postRoomEvent(writer, {
      room: 'main', type: 'message', body: 'retained suffix', idempotencyKey: 'legacy-retained',
    })
    initialized.close()

    const legacy = new DatabaseSync(databasePath)
    const deletedSequence = (legacy.prepare("SELECT sequence FROM room_events WHERE body = 'legacy deleted broadcast'").get() as {
      sequence: number
    }).sequence
    legacy.prepare(`
      INSERT INTO room_stream_state (owner_id, project_id, room, replay_floor_sequence, broadcast_replay_floor_sequence)
      VALUES ('owner-a', ?, 'main', ?, 0)
      ON CONFLICT(owner_id, project_id, room)
      DO UPDATE SET replay_floor_sequence = excluded.replay_floor_sequence
    `).run(project.projectId, deletedSequence)
    legacy.prepare("DELETE FROM room_events WHERE body = 'legacy deleted broadcast'").run()
    legacy.exec(`
      DROP TABLE room_stream_agent_floor;
      ALTER TABLE room_stream_state DROP COLUMN broadcast_replay_floor_sequence;
      PRAGMA user_version = 5;
    `)
    legacy.close()

    const migrated = new SQLiteFabricClient({ databasePath, now: () => now })
    await expect(migrated.readRoom(reader, { room: 'main', cursor: oldCursor })).rejects.toThrow(FabricValidationError)
    migrated.close()

    const inspected = new DatabaseSync(databasePath)
    expect((inspected.prepare('SELECT count(*) AS count FROM room_cursors').get() as { count: number }).count).toBe(0)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(CURRENT_FABRIC_SCHEMA_VERSION)
    inspected.close()
  })

  it('invalidates surviving room cursors when migrating scoped replay floors from v5 to v6', async () => {
    const databasePath = privateDatabasePath()
    const initialized = new SQLiteFabricClient({ databasePath })
    const project = await teamProject(initialized)
    const cursor = (await initialized.readRoom(caller('agent-b', project.projectId), { room: 'main' })).cursor
    if (cursor === undefined) throw new Error('cursor was not issued')
    initialized.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP TABLE room_stream_agent_floor;
      ALTER TABLE room_stream_state DROP COLUMN broadcast_replay_floor_sequence;
      UPDATE room_stream_state SET replay_floor_sequence = 42;
      PRAGMA user_version = 5;
    `)
    expect((legacy.prepare('SELECT count(*) AS count FROM room_cursors').get() as { count: number }).count).toBe(1)
    legacy.close()

    const migrated = new SQLiteFabricClient({ databasePath })
    migrated.close()
    const inspected = new DatabaseSync(databasePath)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_FABRIC_SCHEMA_VERSION)
    expect((inspected.prepare('SELECT count(*) AS count FROM room_cursors').get() as { count: number }).count).toBe(0)
    expect(inspected.prepare('SELECT token FROM room_cursors WHERE token = ?').get(cursor)).toBeUndefined()
    inspected.close()
  })

  it('fails closed on a malformed non-SQLite database file without exposing its contents', () => {
    const databasePath = privateDatabasePath()
    writeFileSync(databasePath, 'GARBAGE_DATABASE_SECRET')
    let message = ''
    try { new SQLiteFabricClient({ databasePath }) } catch (error) { message = String(error) }
    expect(message).toBe('FabricStorageError: fabric storage is unavailable')
    expect(message).not.toContain('GARBAGE_DATABASE_SECRET')
    expect(message).not.toContain(databasePath)
  })

  it('fails closed under a real cross-process migration lock and recovers after release', () => {
    const databasePath = privateDatabasePath()
    const initialized = new SQLiteFabricClient({ databasePath })
    initialized.close()
    const blocker = new DatabaseSync(databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    const moduleUrl = new URL('../../bridge/fabric/sqlite-fabric-client.ts', import.meta.url).href
    const script = `
      import { SQLiteFabricClient } from ${JSON.stringify(moduleUrl)};
      try {
        new SQLiteFabricClient({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 50 });
        process.stdout.write('unexpected-success');
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.name : 'unknown');
      }
    `
    const contended = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    })
    expect(contended.status).toBe(0)
    expect(contended.stdout).toBe('FabricStorageError')
    expect(contended.stdout).not.toContain(databasePath)
    blocker.exec('ROLLBACK')
    blocker.close()
    const recovered = new SQLiteFabricClient({ databasePath, busyTimeoutMs: 50 })
    recovered.close()
  })

  it('reads the schema version only after winning a contended migration lock', async () => {
    const databasePath = privateDatabasePath()
    const initialized = new SQLiteFabricClient({ databasePath })
    initialized.close()
    const blocker = new DatabaseSync(databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    blocker.exec(`PRAGMA user_version = ${CURRENT_FABRIC_SCHEMA_VERSION + 1}`)
    const moduleUrl = new URL('../../bridge/fabric/sqlite-fabric-client.ts', import.meta.url).href
    const script = `
      import { SQLiteFabricClient } from ${JSON.stringify(moduleUrl)};
      process.stdout.write('ready\\n');
      try {
        const client = new SQLiteFabricClient({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 2000 });
        client.close();
        process.stdout.write('unexpected-success');
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.name : 'unknown');
      }
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let released = false
    try {
      const completed = new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill()
          reject(new Error('migration contention child timed out'))
        }, 5_000)
        child.stdout.on('data', chunk => {
          stdout += String(chunk)
          if (!released && stdout.includes('ready\n')) {
            released = true
            setTimeout(() => {
              blocker.exec('COMMIT')
              blocker.close()
            }, 100)
          }
        })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.once('error', reject)
        child.once('exit', code => {
          clearTimeout(timeout)
          resolve(code)
        })
      })
      expect(await completed).toBe(0)
      expect(stdout).toBe('ready\nFabricStorageError')
      expect(stderr).not.toContain(databasePath)
      const inspected = new DatabaseSync(databasePath)
      expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(CURRENT_FABRIC_SCHEMA_VERSION + 1)
      inspected.close()
    } finally {
      if (!released) {
        try { blocker.exec('ROLLBACK') } catch { /* best effort */ }
        try { blocker.close() } catch { /* best effort */ }
      }
      if (child.exitCode === null) child.kill()
    }
  })

  it('keeps an empty cursor poll read-only under writer contention and installs cleanup indexes', async () => {
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, busyTimeoutMs: 50 })
    const project = await teamProject(client)
    const scoped = caller('agent-a', project.projectId)
    await client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'seen', idempotencyKey: 'seen' })
    const cursor = (await client.readRoom(scoped, { room: 'main' })).cursor

    const blocker = new DatabaseSync(databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    expect((await client.readRoom(scoped, { room: 'main', cursor })).events).toEqual([])
    blocker.exec('ROLLBACK')

    const cursorIndexes = (blocker.prepare("PRAGMA index_list('room_cursors')").all() as Array<{ name: string }>).map(row => row.name)
    const eventIndexes = (blocker.prepare("PRAGMA index_list('room_events')").all() as Array<{ name: string }>).map(row => row.name)
    const idempotencyIndexes = (blocker.prepare("PRAGMA index_list('idempotency')").all() as Array<{ name: string }>).map(row => row.name)
    expect(cursorIndexes).toContain('room_cursors_stream_idx')
    expect(eventIndexes).toContain('room_events_stream_expiry_idx')
    expect(idempotencyIndexes).toContain('idempotency_cleanup_idx')
    blocker.close()
    client.close()
  })

  it('stores the database privately and emits content-free audit metadata', async () => {
    const databasePath = privateDatabasePath()
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath, audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const scoped = caller('agent-a', project.projectId)
    await client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'ROOM_BODY_MUST_NOT_LOG', idempotencyKey: 'audit-room' })
    await client.remember(scoped, { scope: 'project', kind: 'fact', text: 'MEMORY_TEXT_MUST_NOT_LOG', importance: 0.5 })
    await client.searchMemory(scoped, { query: 'MEMORY_TEXT_MUST_NOT_LOG' })
    const serialized = JSON.stringify(audit)
    expect(serialized).not.toContain('ROOM_BODY_MUST_NOT_LOG')
    expect(serialized).not.toContain('MEMORY_TEXT_MUST_NOT_LOG')
    expect(audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['project.create', 'room.post', 'memory.remember', 'memory.search']))
    expect(statSync(databasePath).mode & 0o777).toBe(0o600)
    client.close()
    expect(readFileSync(databasePath).byteLength).toBeGreaterThan(0)
  })

  it('audits every successful public operation exactly once', async () => {
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const scoped = caller('agent-a', project.projectId)
    await client.listProjects(scoped)
    await client.getProject(scoped, project.projectId)
    const event = await client.postRoomEvent(scoped, { room: 'main', type: 'decision', body: 'decision', idempotencyKey: 'decision' })
    await client.readRoom(scoped, { room: 'main' })
    const memory = await client.remember(scoped, { scope: 'project', kind: 'fact', text: 'fact', importance: 0.5 })
    await client.searchMemory(scoped, { query: 'fact' })
    await client.getMemory(scoped, memory.id)
    const promoted = await client.promoteRoomEvent(scoped, { roomEventId: event.id, kind: 'decision', importance: 0.8, idempotencyKey: 'promote' })
    await client.forgetMemory(scoped, promoted.id)
    await client.archiveProject(scoped, project.projectId)

    expect(audit.map(entry => entry.action)).toEqual([
      'project.create', 'project.list', 'project.get', 'room.post', 'room.read',
      'memory.remember', 'memory.search', 'memory.get', 'memory.promote',
      'memory.forget', 'project.archive',
    ])
    expect(audit.every(entry => entry.status === 'ok')).toBe(true)
    client.close()
  })

  it('audits every required capability, membership, and cross-owner denial exactly once without content', async () => {
    const audit: FabricAuditEntry[] = []
    const databasePath = privateDatabasePath()
    const client = new SQLiteFabricClient({ databasePath, audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const member = caller('agent-a', project.projectId)
    const memory = await client.remember(member, { scope: 'project', kind: 'fact', text: 'DENIED_MEMORY_SECRET', importance: 0.5 })
    audit.length = 0

    await expect(client.listProjects(caller('agent-a', undefined, { capabilities: [] }))).rejects.toBeInstanceOf(FabricAuthError)
    await expect(client.readRoom(caller('agent-a', project.projectId, { ownerId: 'owner-b' }), {
      room: 'main',
    })).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.postRoomEvent(caller('outsider', project.projectId), {
      room: 'main', type: 'message', body: 'DENIED_ROOM_SECRET', idempotencyKey: 'denied-room',
    })).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.getMemory(caller('attacker', project.projectId, { ownerId: 'owner-b' }), memory.id)).rejects.toBeInstanceOf(FabricAccessError)
    await expect(client.remember(caller('outsider', project.projectId), {
      scope: 'project', kind: 'fact', text: 'DENIED_REMEMBER_SECRET', importance: 0.5,
    })).rejects.toBeInstanceOf(FabricAccessError)

    expect(audit).toHaveLength(5)
    expect(audit.map(entry => [entry.action, entry.status])).toEqual([
      ['project.list', 'denied'],
      ['room.read', 'denied'],
      ['room.post', 'denied'],
      ['memory.get', 'denied'],
      ['memory.remember', 'denied'],
    ])
    expect(audit[3]).toMatchObject({
      ownerId: 'owner-b', deviceId: 'device-attacker', agentId: 'attacker', actorType: 'agent',
      projectId: project.projectId, targetId: memory.id,
    })
    const allowedKeys = new Set(['timestamp', 'action', 'status', 'ownerId', 'deviceId', 'agentId', 'actorType', 'projectId', 'targetId', 'byteCount', 'resultCount', 'correlationId'])
    expect(audit.every(entry => Object.keys(entry).every(key => allowedKeys.has(key)))).toBe(true)
    const serialized = JSON.stringify(audit)
    expect(serialized).not.toContain('DENIED_MEMORY_SECRET')
    expect(serialized).not.toContain('DENIED_ROOM_SECRET')
    expect(serialized).not.toContain('DENIED_REMEMBER_SECRET')
    expect(serialized).not.toContain(databasePath)
    client.close()
  })

  it('audits an internal storage error exactly once as failed without native details', async () => {
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), audit: entry => audit.push(entry) })
    client.close()
    await expect(client.listProjects(caller('agent-a'))).rejects.toBeInstanceOf(FabricStorageError)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'project.list', status: 'failed' })
    expect(JSON.stringify(audit[0])).not.toMatch(/sqlite|database|path|select|closed/i)
  })

  it('never copies caller-controlled correlation or unknown target content into audit metadata', async () => {
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const scoped = caller('agent-a', project.projectId)
    audit.length = 0

    await client.postRoomEvent(scoped, {
      room: 'main', type: 'message', body: 'safe body', idempotencyKey: 'audit-secret-correlation',
      correlationId: 'CORRELATION_SECRET_MUST_NOT_LOG',
    })
    await expect(client.getMemory(scoped, 'UNKNOWN_TARGET_SECRET_MUST_NOT_LOG')).rejects.toBeInstanceOf(FabricAccessError)

    expect(audit).toHaveLength(2)
    expect(audit[0].correlationId).toMatch(/^correlation-[a-f0-9]{64}$/)
    expect(audit[1].targetId).toBeUndefined()
    expect(JSON.stringify(audit)).not.toMatch(/CORRELATION_SECRET|UNKNOWN_TARGET_SECRET/)
    client.close()
  })

  it('distinguishes a write absorbed into an existing memory from a fresh create in the audit trail', async () => {
    // A merge writes into a record another agent may own and raises its
    // importance. An entry byte-identical in shape to a create leaves an owner
    // reviewing the trail unable to tell those two events apart.
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const first = await client.remember(caller('agent-a', project.projectId), {
      scope: 'project', kind: 'fact', text: 'Deploy region is us-west-2.', importance: 0.2,
    })
    audit.length = 0

    const merged = await client.remember(caller('agent-b', project.projectId), {
      scope: 'project', kind: 'fact', text: '  deploy region is US-WEST-2  ', importance: 0.9,
    })
    expect(merged.id).toBe(first.id)
    expect(audit).toHaveLength(1)
    expect(audit[0].action).toBe('memory.remember')
    expect(audit[0].status).toBe('ok')
    expect(audit[0].merged).toBe(true)
    expect(audit[0].targetId).toBe(first.id)

    audit.length = 0
    await client.remember(caller('agent-b', project.projectId), { scope: 'project', kind: 'fact', text: 'a distinct fact', importance: 0.5 })
    expect(audit).toHaveLength(1)
    expect(audit[0].merged).toBeUndefined()
    client.close()
  })

  it('marks a promotion absorbed into an earlier promotion of the same event as a merge', async () => {
    // Same reason as the remember merge: a re-promotion raises an existing
    // shared record's importance rather than creating one, and an owner reading
    // the trail cannot otherwise tell those two events apart.
    const audit: FabricAuditEntry[] = []
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath(), audit: entry => audit.push(entry) })
    const project = await teamProject(client)
    const event = await client.postRoomEvent(caller('agent-a', project.projectId), {
      room: 'main', type: 'decision', body: 'Ship the packaged store by default', idempotencyKey: 'decision-source',
    })
    const first = await client.promoteRoomEvent(caller('agent-a', project.projectId), {
      roomEventId: event.id, kind: 'decision', importance: 0.3, idempotencyKey: 'promote-1',
    })
    audit.length = 0

    const merged = await client.promoteRoomEvent(caller('agent-b', project.projectId), {
      roomEventId: event.id, kind: 'decision', importance: 0.9, idempotencyKey: 'promote-2',
    })
    expect(merged.id).toBe(first.id)
    expect(audit).toHaveLength(1)
    expect(audit[0].action).toBe('memory.promote')
    expect(audit[0].status).toBe('ok')
    expect(audit[0].merged).toBe(true)
    expect(audit[0].targetId).toBe(first.id)

    audit.length = 0
    const other = await client.postRoomEvent(caller('agent-a', project.projectId), {
      room: 'main', type: 'decision', body: 'A different durable decision', idempotencyKey: 'decision-other',
    })
    await client.promoteRoomEvent(caller('agent-a', project.projectId), {
      roomEventId: other.id, kind: 'decision', importance: 0.5, idempotencyKey: 'promote-3',
    })
    expect(audit.filter(entry => entry.action === 'memory.promote')).toHaveLength(1)
    expect(audit.filter(entry => entry.action === 'memory.promote')[0].merged).toBeUndefined()
    client.close()
  })

  it('retries a merged promotion under its own idempotency key without a third record', async () => {
    // The merged promotion still owns its idempotency key, so replaying that
    // key must return the surviving record rather than falling through to a
    // fresh insert.
    const client = new SQLiteFabricClient({ databasePath: privateDatabasePath() })
    const project = await teamProject(client)
    const event = await client.postRoomEvent(caller('agent-a', project.projectId), {
      room: 'main', type: 'decision', body: 'Freeze the schema at version nine', idempotencyKey: 'decision-source',
    })
    const first = await client.promoteRoomEvent(caller('agent-a', project.projectId), {
      roomEventId: event.id, kind: 'decision', importance: 0.3, idempotencyKey: 'promote-1',
    })
    const retryable = { roomEventId: event.id, kind: 'decision' as const, importance: 0.9, idempotencyKey: 'promote-2' }
    const merged = await client.promoteRoomEvent(caller('agent-b', project.projectId), retryable)
    const replayed = await client.promoteRoomEvent(caller('agent-b', project.projectId), retryable)
    expect(merged.id).toBe(first.id)
    expect(replayed.id).toBe(first.id)
    expect((await client.searchMemory(caller('agent-b', project.projectId), { query: 'freeze schema version nine' })).records.map(record => record.id))
      .toEqual([first.id])
    client.close()
  })

  it('fails closed rather than placing authority in a non-private directory', () => {
    const databasePath = privateDatabasePath()
    chmodSync(dirname(databasePath), 0o755)
    expect(() => new SQLiteFabricClient({ databasePath })).toThrow(FabricStorageError)
    expect(() => readFileSync(databasePath)).toThrow()
  })
})
