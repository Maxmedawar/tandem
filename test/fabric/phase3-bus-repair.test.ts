/**
 * The states an independent review of Phase 3 found the projection could not
 * survive.
 *
 * Each case here is one of those findings, reproduced against a bus double
 * that can be put into a state a real fabricd only reaches under a race, a
 * lost acknowledgement, or a retained window that has dropped its oldest
 * events.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SQLiteFabricClient } from '../../bridge/fabric/sqlite-fabric-client.ts'
import { createCallerContext } from '../../src/fabric/capabilities.ts'
import { FabricValidationError } from '../../src/fabric/validation.ts'
import type { CallerContext, FabricCapability } from '../../src/fabric/types.ts'
import { FakeRoomBus, type FakeRoomBusHooks } from './fake-room-bus.ts'

// Vitest 2 predates node:sqlite and does not externalize that newer builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const capabilities: FabricCapability[] = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:read', 'memory:delete',
]

const context = (agentId: string, projectId?: string, actorType: 'agent' | 'owner' = 'agent'): CallerContext =>
  createCallerContext({ ownerId: 'owner-a', deviceId: `device-${agentId}`, agentId, projectId, actorType, capabilities })

const directories: string[] = []
const clients: SQLiteFabricClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function open(bus: FakeRoomBus, databasePath?: string): { client: SQLiteFabricClient; databasePath: string } {
  let path = databasePath
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), 'tandem-phase3-repair-'))
    chmodSync(directory, 0o700)
    directories.push(directory)
    path = join(directory, 'fabric.sqlite3')
  }
  const client = new SQLiteFabricClient({ databasePath: path, bus })
  clients.push(client)
  return { client, databasePath: path }
}

async function project(client: SQLiteFabricClient, members: string[] = []) {
  return client.createProject(context('agent-a', undefined, 'owner'), {
    displayName: 'Alpha', memberAgentIds: members,
  })
}

describe('phase 3 repairs: the projection survives the bus', () => {
  it('does not let one agent idempotency key swallow another agent post', async () => {
    const bus = new FakeRoomBus()
    const { client } = open(bus)
    const created = await project(client, ['agent-b'])

    const first = await client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'from a', idempotencyKey: 'task-42',
    })
    const second = await client.postRoomEvent(context('agent-b', created.projectId), {
      room: 'main', type: 'message', body: 'from b', idempotencyKey: 'task-42',
    })

    // The idempotency scope is per agent. Two agents choosing the same key is
    // two posts, not one; returning the first agent's event to the second
    // discards a message and hands over its contents.
    expect(second.id).not.toBe(first.id)
    expect(second.body).toBe('from b')

    const read = await client.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body).sort()).toEqual(['from a', 'from b'])
  })

  it('does not fail a post whose event the reader projected first', async () => {
    // The window is real: an acknowledgement is in flight while another call
    // reconciles the same room and projects the event under its own id.
    const hooks: FakeRoomBusHooks = {}
    const bus = new FakeRoomBus(hooks)
    const { client } = open(bus)
    const created = await project(client)

    let reconciled = false
    hooks.afterStore = async () => {
      if (reconciled) return
      reconciled = true
      await client.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    }

    const posted = await client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'raced', idempotencyKey: 'k-1',
    })
    expect(posted.body).toBe('raced')

    const read = await client.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body)).toEqual(['raced'])
  })

  it('reaches an event whose acknowledgement was lost after a later one committed', async () => {
    const hooks: FakeRoomBusHooks = {}
    const bus = new FakeRoomBus(hooks)
    const { client } = open(bus)
    const created = await project(client)

    // Lose the acknowledgement for the first post only.
    let lost = false
    hooks.loseAck = () => {
      if (lost) return false
      lost = true
      return true
    }

    await expect(client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'first', idempotencyKey: 'k-1',
    })).rejects.toThrow()

    await client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'second', idempotencyKey: 'k-2',
    })

    // The first event is durable. A watermark that jumped to the second event
    // would make it unreachable through the room contract forever.
    const read = await client.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body)).toEqual(['first', 'second'])
  })

  it('never advances the watermark past an event it has not projected', async () => {
    // The watermark is a claim about how much of the log has been consumed in
    // order. A post that advanced it to its own sequence would be asserting
    // that claim about events it never looked at - and anything it stepped
    // over is durable in the log and unreachable through the room for good.
    const bus = new FakeRoomBus({ maxEventsPerFetch: 1 })
    const { client, databasePath } = open(bus)
    const created = await project(client)

    for (const key of ['k-1', 'k-2']) {
      await client.postRoomEvent(context('agent-a', created.projectId), {
        room: 'main', type: 'message', body: key, idempotencyKey: key,
      })
    }

    // A projection that has fallen behind a log holding more than one fetch
    // can return, which is the ordinary case once events carry real bodies.
    clients.splice(clients.indexOf(client), 1)
    client.close()
    wipeProjection(databasePath)
    const rebuilt = open(bus, databasePath).client

    await rebuilt.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'k-3', idempotencyKey: 'k-3',
    })

    const database = new DatabaseSync(databasePath)
    const watermark = (database.prepare(
      'SELECT bus_sequence FROM room_bus_watermark WHERE owner_id = ? AND project_id = ?',
    ).get('owner-a', created.projectId) as { bus_sequence: number } | undefined)?.bus_sequence ?? 0
    const projected = (database.prepare(
      'SELECT bus_sequence FROM room_events WHERE owner_id = ? AND project_id = ? AND room = ?',
    ).all('owner-a', created.projectId, 'main') as Array<{ bus_sequence: number }>).map(row => row.bus_sequence)
    database.close()

    for (let sequence = 1; sequence <= watermark; sequence += 1) {
      expect(projected, `sequence ${sequence} is under the watermark but not projected`).toContain(sequence)
    }
    const read = await rebuilt.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body)).toEqual(['k-1', 'k-2', 'k-3'])
  })

  it('keeps reconciling when a fetch is cut short by its byte budget', async () => {
    const bus = new FakeRoomBus({ maxEventsPerFetch: 2 })
    const { client, databasePath } = open(bus)
    const created = await project(client)

    for (let index = 0; index < 7; index += 1) {
      await client.postRoomEvent(context('agent-a', created.projectId), {
        room: 'main', type: 'message', body: `event ${index}`, idempotencyKey: `k-${index}`,
      })
    }
    expect(bus.stored('owner-a', created.projectId, 'main')).toBe(7)

    // A fetch returns fewer events than the limit whenever the byte budget
    // runs out first, which is routine. Treating that as "caught up" leaves
    // the projection short of the log.
    clients.splice(clients.indexOf(client), 1)
    client.close()
    wipeProjection(databasePath)
    const rebuilt = open(bus, databasePath).client

    const read = await rebuilt.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main', limit: 50 })
    expect(read.events.map(event => event.body)).toEqual(
      Array.from({ length: 7 }, (_value, index) => `event ${index}`),
    )
  })

  it('fails a cursor closed when the log dropped events it never projected', async () => {
    const bus = new FakeRoomBus()
    const { client, databasePath } = open(bus)
    const created = await project(client)
    const reader = context('agent-a', created.projectId, 'owner')

    for (const key of ['k-0', 'k-1']) {
      await client.postRoomEvent(context('agent-a', created.projectId), {
        room: 'main', type: 'message', body: key, idempotencyKey: key,
      })
    }
    // Taken while the room held only its first two events, so this checkpoint
    // sits below everything the log is about to drop.
    const cursor = (await client.readRoom(reader, { room: 'main' })).cursor
    expect(cursor).toBeDefined()
    for (const key of ['k-2', 'k-3']) {
      await client.postRoomEvent(context('agent-a', created.projectId), {
        room: 'main', type: 'message', body: key, idempotencyKey: key,
      })
    }

    clients.splice(clients.indexOf(client), 1)
    client.close()
    wipeProjection(databasePath)
    // The retained window has moved past the events this cursor covered, so a
    // rebuild can only recover a suffix.
    bus.ageOut('owner-a', created.projectId, 3)
    const rebuilt = open(bus, databasePath).client

    await expect(rebuilt.readRoom(reader, { room: 'main', cursor })).rejects.toThrow(FabricValidationError)
  })

  it('does not fence a room because a sibling room lost events it never had', async () => {
    // A project is one stream, so a room's sequences have its siblings'
    // interleaved between them. Comparing a room's oldest retained event
    // against a room's own position therefore reads a sibling's aged-out
    // events as a hole in this room - and fences a room that lost nothing.
    const bus = new FakeRoomBus()
    const { client } = open(bus)
    const created = await project(client)
    const agent = context('agent-a', created.projectId)
    const reader = context('agent-a', created.projectId, 'owner')

    await client.postRoomEvent(agent, { room: 'ops', type: 'message', body: 'ops one', idempotencyKey: 'ops-1' })
    for (let index = 0; index < 5; index += 1) {
      await client.postRoomEvent(agent, {
        room: 'general', type: 'message', body: `general ${index}`, idempotencyKey: `general-${index}`,
      })
    }
    const cursor = (await client.readRoom(reader, { room: 'ops' })).cursor
    expect(cursor).toBeDefined()

    // Retention drops the oldest three - one ops event this reader has already
    // consumed, and two general events. Nothing after the reader's position is
    // gone.
    bus.ageOut('owner-a', created.projectId, 3)
    await client.postRoomEvent(agent, { room: 'ops', type: 'message', body: 'ops two', idempotencyKey: 'ops-2' })

    const resumed = await client.readRoom(reader, { room: 'ops', cursor })
    expect(resumed.events.map(event => event.body)).toEqual(['ops two'])
  })

  it('skips a log record it cannot store instead of bricking the room', async () => {
    const bus = new FakeRoomBus()
    const { client } = open(bus)
    const created = await project(client)

    await client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'good', idempotencyKey: 'k-1',
    })
    // A record no build of this bridge would write: a hop budget outside the
    // range the projection's own constraint allows.
    bus.injectRaw('owner-a', created.projectId, 'main', Buffer.from(JSON.stringify({
      id: 'event-broken', ownerId: 'owner-a', projectId: created.projectId, room: 'main',
      type: 'message', fromAgentId: 'agent-a', body: 'broken', createdAt: new Date(0).toISOString(),
      createdAtMs: 0, expiresAtMs: Date.now() + 86_400_000, ttlHops: 0, deviceId: 'device-a',
    }), 'utf8').toString('base64'))
    await client.postRoomEvent(context('agent-a', created.projectId), {
      room: 'main', type: 'message', body: 'after', idempotencyKey: 'k-2',
    })

    const read = await client.readRoom(context('agent-a', created.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body)).toEqual(['good', 'after'])
  })

  it('keeps deduplicating a retried post after the crash window that stored it', async () => {
    const hooks: FakeRoomBusHooks = {}
    const bus = new FakeRoomBus(hooks)
    const { client } = open(bus)
    const created = await project(client)

    let lost = true
    hooks.loseAck = () => {
      const value = lost
      lost = false
      return value
    }
    const post = { room: 'main', type: 'message' as const, body: 'once', idempotencyKey: 'k-1' }
    await expect(client.postRoomEvent(context('agent-a', created.projectId), post)).rejects.toThrow()

    // The retry recovers the stored event. It must also leave the local
    // idempotency record behind, or the post is protected only for as long as
    // the bus remembers the message id.
    const recovered = await client.postRoomEvent(context('agent-a', created.projectId), post)
    expect(recovered.body).toBe('once')

    const again = await client.postRoomEvent(context('agent-a', created.projectId), post)
    expect(again.id).toBe(recovered.id)
    expect(bus.stored('owner-a', created.projectId, 'main')).toBe(1)
  })
})

/**
 * Discards everything derived from the log, leaving a database that knows the
 * project exists and nothing about its rooms.
 */
function wipeProjection(databasePath: string): void {
  const database = new DatabaseSync(databasePath)
  database.exec('DELETE FROM room_events; DELETE FROM room_bus_watermark; DELETE FROM room_bus_fence;')
  database.close()
}
