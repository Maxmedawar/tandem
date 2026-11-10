import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SQLiteFabricClient } from '../../bridge/fabric/sqlite-fabric-client.ts'
import { createCallerContext, FabricAccessError } from '../../src/fabric/capabilities.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import { DEFAULT_MEMORY_SEARCH_LIMIT, MAX_MEMORY_SEARCH_LIMIT, type CallerContext, type FabricCapability } from '../../src/fabric/types.ts'
import { FabricValidationError } from '../../src/fabric/validation.ts'
import { InMemoryFabricClient } from './in-memory-fabric-client.ts'

const capabilities: FabricCapability[] = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:read', 'memory:delete',
]

const context = (agentId: string, projectId?: string, ownerId = 'owner-a', actorType: 'agent' | 'owner' = 'agent'): CallerContext =>
  createCallerContext({ ownerId, deviceId: `device-${agentId}`, agentId, projectId, actorType, capabilities })

interface ContractHarness {
  readonly client: FabricClient
  advance(milliseconds: number): void
  close(): void
}

const adapters: Array<{ name: string; create(): ContractHarness }> = [
  {
    name: 'in-memory contract double',
    create() {
      let now = Date.UTC(2026, 7, 12)
      return {
        client: new InMemoryFabricClient({ now: () => now, roomRateLimit: { maxEvents: 2, windowMs: 1_000 } }),
        advance(milliseconds) { now += milliseconds },
        close() {},
      }
    },
  },
  {
    name: 'SQLite production adapter',
    create() {
      let now = Date.UTC(2026, 7, 12)
      const directory = mkdtempSync(join(tmpdir(), 'tandem-fabric-contract-'))
      chmodSync(directory, 0o700)
      const client = new SQLiteFabricClient({
        databasePath: join(directory, 'fabric.sqlite3'),
        now: () => now,
        roomRateLimit: { maxEvents: 2, windowMs: 1_000 },
      })
      return {
        client,
        advance(milliseconds) { now += milliseconds },
        close() { client.close(); rmSync(directory, { recursive: true, force: true }) },
      }
    },
  },
]

describe.each(adapters)('core FabricClient contract: $name', ({ create }) => {
  it('lets a trusted owner inspect every owned project and directed room event without membership', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Owner visibility', memberAgentIds: ['agent-b'],
      })
      await harness.client.postRoomEvent(context('agent-a', project.projectId), {
        room: 'main', type: 'message', body: 'directed detail', toAgentId: 'agent-b', idempotencyKey: 'owner-view',
      })
      const owner = context('owner-console', project.projectId, 'owner-a', 'owner')
      expect((await harness.client.listProjects(owner)).map(item => item.projectId)).toContain(project.projectId)
      expect((await harness.client.getProject(owner, project.projectId))?.projectId).toBe(project.projectId)
      expect((await harness.client.readRoom(owner, { room: 'main' })).events.map(event => event.body)).toEqual(['directed detail'])
    } finally { harness.close() }
  })

  it('isolates projects and enforces directed room visibility', async () => {
    const harness = create()
    try {
      const first = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'First', memberAgentIds: ['agent-b', 'agent-c'],
      })
      const second = await harness.client.createProject(context('agent-a'), { displayName: 'Second' })
      const a = context('agent-a', first.projectId)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'private', toAgentId: 'agent-b', idempotencyKey: 'private' })
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'broadcast', idempotencyKey: 'broadcast' })
      expect((await harness.client.readRoom(context('agent-b', first.projectId), { room: 'main' })).events.map(event => event.body)).toEqual(['private', 'broadcast'])
      expect((await harness.client.readRoom(context('agent-c', first.projectId), { room: 'main' })).events.map(event => event.body)).toEqual(['broadcast'])
      expect((await harness.client.readRoom(context('agent-a', second.projectId), { room: 'main' })).events).toEqual([])
      await expect(harness.client.readRoom(context('outsider', first.projectId), { room: 'main' })).rejects.toBeInstanceOf(FabricAccessError)
    } finally { harness.close() }
  })

  it('replays only missed retained events after more than five minutes offline', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Replay', memberAgentIds: ['agent-b'], retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'seen', idempotencyKey: 'seen' })
      const firstRead = await harness.client.readRoom(b, { room: 'main' })
      harness.advance(10 * 60_000)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'progress', body: 'missed', idempotencyKey: 'missed' })
      const resumed = await harness.client.readRoom(b, { room: 'main', cursor: firstRead.cursor })
      expect(resumed.events.map(event => event.body)).toEqual(['missed'])
      expect((await harness.client.readRoom(b, { room: 'main', cursor: resumed.cursor })).events).toEqual([])
    } finally { harness.close() }
  })

  it('uses one deliverable stream for self replies, pagination, retry, and replay floors', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Deliverable stream', memberAgentIds: ['agent-b'], retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const owner = context('owner-console', project.projectId, 'owner-a', 'owner')
      const root = await harness.client.postRoomEvent(a, {
        room: 'main', type: 'question', body: 'root authored post', idempotencyKey: 'deliverable-root',
      })
      const aAtRoot = await harness.client.readRoom(a, { room: 'main', limit: 1 })
      const bAtRoot = await harness.client.readRoom(b, { room: 'main', limit: 1 })
      expect(aAtRoot.events.map(event => event.body)).toEqual(['root authored post'])

      harness.advance(500)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'answer', body: 'self-authored reply', replyTo: root.id,
        idempotencyKey: 'deliverable-reply',
      })
      expect((await harness.client.readRoom(a, { room: 'main', cursor: aAtRoot.cursor })).events).toEqual([])

      const bRetry = await harness.client.readRoom(b, { room: 'main', cursor: bAtRoot.cursor, limit: 1 })
      expect(bRetry.events.map(event => event.body)).toEqual(['self-authored reply'])
      const bDuplicate = await harness.client.readRoom(b, { room: 'main', cursor: bAtRoot.cursor, limit: 1 })
      expect(bDuplicate.events.map(event => event.body)).toEqual(['self-authored reply'])
      expect(bDuplicate.cursor).toBe(bRetry.cursor)
      expect((await harness.client.readRoom(owner, { room: 'main', limit: 10 })).events.map(event => event.body))
        .toEqual(['root authored post', 'self-authored reply'])

      harness.advance(500)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'message', body: 'later retained root', idempotencyKey: 'deliverable-later',
      })
      harness.advance(86_399_501)

      expect((await harness.client.readRoom(a, { room: 'main', cursor: aAtRoot.cursor })).events.map(event => event.body))
        .toEqual(['later retained root'])
      await expect(harness.client.readRoom(b, { room: 'main', cursor: bAtRoot.cursor })).rejects.toThrow(FabricValidationError)
    } finally { harness.close() }
  })

  it('uses immutable room checkpoints for normal advancement, duplicate retry, and reader isolation', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Immutable checkpoints',
        memberAgentIds: ['agent-b'],
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const initial = await harness.client.readRoom(a, { room: 'main' })
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'message', body: 'first unread', idempotencyKey: 'immutable-first',
      })
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'message', body: 'second unread', idempotencyKey: 'immutable-second',
      })

      const first = await harness.client.readRoom(a, { room: 'main', cursor: initial.cursor, limit: 1 })
      expect(first.events.map(event => event.body)).toEqual(['first unread'])
      expect(first.cursor).not.toBe(initial.cursor)
      const duplicate = await harness.client.readRoom(a, { room: 'main', cursor: initial.cursor, limit: 1 })
      expect(duplicate.events.map(event => event.body)).toEqual(['first unread'])
      expect(duplicate.cursor).toBe(first.cursor)

      const second = await harness.client.readRoom(a, { room: 'main', cursor: first.cursor, limit: 1 })
      expect(second.events.map(event => event.body)).toEqual(['second unread'])
      const caughtUp = await harness.client.readRoom(a, { room: 'main', cursor: second.cursor })
      expect(caughtUp.events).toEqual([])
      expect(caughtUp.cursor).toBe(second.cursor)
      await expect(harness.client.readRoom(b, { room: 'main', cursor: first.cursor })).rejects.toThrow(FabricValidationError)
    } finally { harness.close() }
  })

  it('excludes self-authored broadcast replies without weakening replay, retry, pagination, or lost-event detection', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Broadcast reply delivery',
        memberAgentIds: ['agent-b', 'agent-c'],
        retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const c = context('agent-c', project.projectId)
      const owner = context('owner-console', project.projectId, 'owner-a', 'owner')

      const root = await harness.client.postRoomEvent(a, {
        room: 'main', type: 'question', body: 'authored root', idempotencyKey: 'broadcast-root',
      })
      const authorBase = await harness.client.readRoom(a, { room: 'main' })
      const uninvolvedBase = await harness.client.readRoom(c, { room: 'main' })
      const ownerBase = await harness.client.readRoom(owner, { room: 'main' })
      expect(authorBase.events.map(event => event.body)).toEqual(['authored root'])

      harness.advance(500)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'answer', body: 'self-authored broadcast reply',
        replyTo: root.id, idempotencyKey: 'broadcast-reply',
      })
      const authorResume = await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor })
      expect(authorResume).toEqual({ events: [], cursor: authorBase.cursor })
      expect((await harness.client.readRoom(b, { room: 'main' })).events.map(event => event.body))
        .toEqual(['authored root', 'self-authored broadcast reply'])
      expect((await harness.client.readRoom(owner, { room: 'main', cursor: ownerBase.cursor })).events.map(event => event.body))
        .toEqual(['self-authored broadcast reply'])

      harness.advance(500)
      await harness.client.postRoomEvent(b, {
        room: 'main', type: 'progress', body: 'page one', idempotencyKey: 'broadcast-page-one',
      })
      await harness.client.postRoomEvent(b, {
        room: 'main', type: 'progress', body: 'page two', idempotencyKey: 'broadcast-page-two',
      })
      const firstPage = await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor, limit: 1 })
      expect(firstPage.events.map(event => event.body)).toEqual(['page one'])
      const retry = await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor, limit: 1 })
      expect(retry.events.map(event => event.body)).toEqual(['page one'])
      expect(retry.cursor).toBe(firstPage.cursor)
      expect((await harness.client.readRoom(a, { room: 'main', cursor: firstPage.cursor, limit: 1 })).events.map(event => event.body))
        .toEqual(['page two'])

      // The root and reply expire while both pages remain retained. Posting triggers the
      // physical cleanup path and persists the same reader-scoped floors used before cleanup.
      harness.advance(86_399_600)
      await harness.client.postRoomEvent(c, {
        room: 'main', type: 'progress', body: 'after cleanup', idempotencyKey: 'broadcast-after-cleanup',
      })
      expect((await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor, limit: 1 })).events.map(event => event.body))
        .toEqual(['page one'])
      await expect(harness.client.readRoom(c, { room: 'main', cursor: uninvolvedBase.cursor }))
        .rejects.toThrow(FabricValidationError)
      await expect(harness.client.readRoom(owner, { room: 'main', cursor: ownerBase.cursor }))
        .rejects.toThrow(FabricValidationError)
    } finally { harness.close() }
  })

  it('does not advance a directed-reply floor for its excluded sender but still detects recipient loss', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Directed reply delivery',
        memberAgentIds: ['agent-b', 'agent-c'],
        retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const c = context('agent-c', project.projectId)
      const owner = context('owner-console', project.projectId, 'owner-a', 'owner')

      const root = await harness.client.postRoomEvent(a, {
        room: 'main', type: 'question', body: 'directed root', toAgentId: 'agent-b', idempotencyKey: 'directed-root',
      })
      const authorBase = await harness.client.readRoom(a, { room: 'main' })
      const recipientBase = await harness.client.readRoom(b, { room: 'main' })
      const ownerBase = await harness.client.readRoom(owner, { room: 'main' })
      expect(authorBase.events.map(event => event.body)).toEqual(['directed root'])

      harness.advance(500)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'answer', body: 'self-authored directed reply', toAgentId: 'agent-b',
        replyTo: root.id, idempotencyKey: 'directed-reply',
      })
      expect(await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor }))
        .toEqual({ events: [], cursor: authorBase.cursor })
      expect((await harness.client.readRoom(b, { room: 'main', cursor: recipientBase.cursor })).events.map(event => event.body))
        .toEqual(['self-authored directed reply'])
      expect((await harness.client.readRoom(owner, { room: 'main', cursor: ownerBase.cursor })).events.map(event => event.body))
        .toEqual(['self-authored directed reply'])

      harness.advance(500)
      await harness.client.postRoomEvent(c, {
        room: 'main', type: 'progress', body: 'retained for sender', idempotencyKey: 'directed-retained',
      })
      harness.advance(86_399_600)
      await harness.client.postRoomEvent(c, {
        room: 'main', type: 'progress', body: 'directed cleanup trigger', idempotencyKey: 'directed-cleanup',
      })

      expect((await harness.client.readRoom(a, { room: 'main', cursor: authorBase.cursor })).events.map(event => event.body))
        .toEqual(['retained for sender', 'directed cleanup trigger'])
      await expect(harness.client.readRoom(b, { room: 'main', cursor: recipientBase.cursor }))
        .rejects.toThrow(FabricValidationError)
      await expect(harness.client.readRoom(owner, { room: 'main', cursor: ownerBase.cursor }))
        .rejects.toThrow(FabricValidationError)
    } finally { harness.close() }
  })

  it('keeps a default-retention cursor resumable after twenty-nine days offline', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Long replay', memberAgentIds: ['agent-b'],
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const cursor = (await harness.client.readRoom(b, { room: 'main' })).cursor

      harness.advance(29 * 86_400_000)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'handoff', body: 'still inside retention', idempotencyKey: 'long-replay',
      })

      expect((await harness.client.readRoom(b, { room: 'main', cursor })).events.map(event => event.body))
        .toEqual(['still inside retention'])
    } finally { harness.close() }
  })

  it('fails closed on an expired unread gap while a fully caught-up cursor resumes', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Gap detection', memberAgentIds: ['agent-b', 'agent-c'], retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const c = context('agent-c', project.projectId)

      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'sequence one', idempotencyKey: 'gap-one' })
      const stale = (await harness.client.readRoom(b, { room: 'main' })).cursor
      const caughtUpFirst = await harness.client.readRoom(c, { room: 'main' })

      harness.advance(60 * 60_000)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'progress', body: 'sequence two unread by b', idempotencyKey: 'gap-two' })
      const caughtUp = (await harness.client.readRoom(c, { room: 'main', cursor: caughtUpFirst.cursor })).cursor

      harness.advance(22 * 60 * 60_000)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'sequence three retained', idempotencyKey: 'gap-three' })
      harness.advance(2 * 60 * 60_000 + 1)

      await expect(harness.client.readRoom(b, { room: 'main', cursor: stale })).rejects.toThrow(FabricValidationError)
      expect((await harness.client.readRoom(c, { room: 'main', cursor: caughtUp })).events.map(event => event.body)).toEqual(['sequence three retained'])
    } finally { harness.close() }
  })

  it('keeps an uninvolved reader cursor valid when an invisible directed event expires, still delivering later retained visible events', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Visibility scoped floor', memberAgentIds: ['agent-b', 'agent-c'], retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const c = context('agent-c', project.projectId)

      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor one', idempotencyKey: 'floor-one' })
      const caughtUp = (await harness.client.readRoom(c, { room: 'main' })).cursor!

      harness.advance(500)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor private', toAgentId: 'agent-b', idempotencyKey: 'floor-private' })
      harness.advance(500)
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor two', idempotencyKey: 'floor-two' })

      // Advances past the invisible directed event's expiry but not the still-retained broadcast that follows it.
      harness.advance(86_399_600)
      const beforeCleanup = await harness.client.readRoom(c, { room: 'main', cursor: caughtUp })
      expect(beforeCleanup.events.map(event => event.body)).toEqual(['floor two'])

      // A later post triggers physical cleanup of the expired rows, persisting whatever floor state the fix uses.
      await harness.client.postRoomEvent(a, { room: 'main', type: 'message', body: 'floor three', idempotencyKey: 'floor-three' })
      const afterCleanup = await harness.client.readRoom(c, { room: 'main', cursor: beforeCleanup.cursor })
      expect(afterCleanup.events.map(event => event.body)).toEqual(['floor three'])
    } finally { harness.close() }
  })

  it('starts a fresh cursor at the replay floor after all earlier events expire', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Fresh floor cursor', memberAgentIds: ['agent-b'], retention: { roomRetentionDays: 1 },
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      await harness.client.postRoomEvent(a, {
        room: 'main', type: 'message', body: 'expires before first read', idempotencyKey: 'fresh-floor-event',
      })
      harness.advance(86_400_001)

      const first = await harness.client.readRoom(b, { room: 'main' })
      expect(first.events).toEqual([])
      await expect(harness.client.readRoom(b, { room: 'main', cursor: first.cursor })).resolves.toMatchObject({ events: [] })
    } finally { harness.close() }
  })

  it('enforces hop, rate, and retention bounds', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a'), {
        displayName: 'Bounds', retention: { roomEventTtlHops: 2, roomRetentionDays: 1 },
      })
      const scoped = context('agent-a', project.projectId)
      const root = await harness.client.postRoomEvent(scoped, { room: 'main', type: 'question', body: 'root', idempotencyKey: 'root' })
      const reply = await harness.client.postRoomEvent(scoped, { room: 'main', type: 'answer', body: 'reply', replyTo: root.id, idempotencyKey: 'reply' })
      expect(reply.ttlHops).toBe(1)
      await expect(harness.client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'loop', replyTo: reply.id, idempotencyKey: 'loop' })).rejects.toThrow(FabricValidationError)
      await expect(harness.client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'rate', idempotencyKey: 'rate' })).rejects.toThrow(FabricValidationError)
      harness.advance(1_001)
      await harness.client.postRoomEvent(scoped, { room: 'main', type: 'message', body: 'expires', idempotencyKey: 'expires' })
      harness.advance(86_400_001)
      expect((await harness.client.readRoom(scoped, { room: 'main' })).events).toEqual([])
    } finally { harness.close() }
  })

  it('keeps a predecessor obsolete and permits re-correction after successor deletion', async () => {
    const harness = create()
    try {
      const agent = context('agent-a')
      const original = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: 'deploy Friday', importance: 0.5 })
      const correction = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: 'deploy Monday', importance: 0.8, supersedes: original.id })
      await harness.client.forgetMemory(agent, correction.id)
      expect((await harness.client.searchMemory(agent, { query: 'deploy' })).records).toEqual([])
      const next = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: 'deploy Tuesday', importance: 0.9, supersedes: original.id })
      expect((await harness.client.searchMemory(agent, { query: 'deploy' })).records.map(record => record.id)).toEqual([next.id])
    } finally { harness.close() }
  })

  it('merges an exact-duplicate write into the existing record instead of storing a second one', async () => {
    // The returned id is the *existing* record's, so a caller that stores it
    // and a reviewer reading the trail are both looking at one merged memory.
    // This is public, observable behaviour and belongs to the contract, not to
    // one adapter; see docs/adr/0003-phase-2-local-hybrid-memory.md.
    const harness = create()
    try {
      const agent = context('agent-a')
      const original = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: 'Deploy region is us-west-2.', importance: 0.5, confidence: 0.4 })
      const merged = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: '  deploy region is US-WEST-2  ', importance: 0.8, confidence: 0.9 })
      expect(merged.id).toBe(original.id)
      // A merge raises the surviving record; it never lowers it.
      expect(merged.importance).toBe(0.8)
      expect(merged.confidence).toBe(0.9)
      const weaker = await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: 'Deploy region is us-west-2', importance: 0.1, confidence: 0.1 })
      expect(weaker.id).toBe(original.id)
      expect(weaker.importance).toBe(0.8)
      expect(weaker.confidence).toBe(0.9)
      expect((await harness.client.searchMemory(agent, { query: 'deploy region' })).records.map(record => record.id)).toEqual([original.id])
    } finally { harness.close() }
  })

  it('honours a search limit up to the advertised maximum and defaults below it', async () => {
    const harness = create()
    try {
      const agent = context('agent-a')
      for (let i = 0; i < DEFAULT_MEMORY_SEARCH_LIMIT + 5; i++) {
        await harness.client.remember(agent, { scope: 'agent', kind: 'fact', text: `alpha beta ledger ${i}`, importance: 0.5 })
      }
      expect((await harness.client.searchMemory(agent, { query: 'alpha beta', limit: MAX_MEMORY_SEARCH_LIMIT })).records)
        .toHaveLength(DEFAULT_MEMORY_SEARCH_LIMIT + 5)
      expect((await harness.client.searchMemory(agent, { query: 'alpha beta' })).records).toHaveLength(DEFAULT_MEMORY_SEARCH_LIMIT)
      await expect(harness.client.searchMemory(agent, { query: 'alpha beta', limit: MAX_MEMORY_SEARCH_LIMIT + 1 }))
        .rejects.toBeInstanceOf(FabricValidationError)
    } finally { harness.close() }
  })

  it('preserves promotion idempotency for the retained retry window after the result is forgotten', async () => {
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a'), {
        displayName: 'Promotion retry', retention: { roomRetentionDays: 1 },
      })
      const scoped = context('agent-a', project.projectId)
      const eventInput = {
        room: 'main', type: 'decision', body: 'retain idempotency', idempotencyKey: 'promotion-source',
      } as const
      const event = await harness.client.postRoomEvent(scoped, eventInput)
      expect((await harness.client.postRoomEvent(scoped, eventInput)).id).toBe(event.id)
      const input = {
        roomEventId: event.id, kind: 'decision' as const, importance: 0.8, idempotencyKey: 'promotion-retry',
      }
      const promoted = await harness.client.promoteRoomEvent(scoped, input)
      expect((await harness.client.promoteRoomEvent(scoped, input)).id).toBe(promoted.id)
      await harness.client.forgetMemory(scoped, promoted.id)

      await expect(harness.client.promoteRoomEvent(scoped, input)).rejects.toBeInstanceOf(FabricAccessError)
      expect((await harness.client.searchMemory(scoped, { query: 'retain idempotency' })).records).toEqual([])
    } finally { harness.close() }
  })

  it('collapses repeated promotions of one room event into a single project memory', async () => {
    // Idempotency keys are per caller and per attempt, so they cannot stop a
    // second agent — or the same agent retrying under a fresh key — from
    // promoting the same decision again. Without consolidation on this write
    // path every member of the project then retrieves the same decision two or
    // three times over. The merge is the same shape as the exact-duplicate
    // `remember` merge: the surviving id is the first promotion's, importance
    // and confidence only rise, and the source room event id is preserved
    // because the survivor was promoted from that very event.
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a', undefined, 'owner-a', 'owner'), {
        displayName: 'Promotion consolidation', memberAgentIds: ['agent-b'],
      })
      const a = context('agent-a', project.projectId)
      const b = context('agent-b', project.projectId)
      const event = await harness.client.postRoomEvent(a, {
        room: 'main', type: 'decision', body: 'We ship the packaged vector store by default', idempotencyKey: 'decision-source',
      })

      const first = await harness.client.promoteRoomEvent(a, { roomEventId: event.id, kind: 'decision', importance: 0.5, confidence: 0.4, idempotencyKey: 'promote-1' })
      const again = await harness.client.promoteRoomEvent(a, { roomEventId: event.id, kind: 'decision', importance: 0.9, confidence: 0.8, idempotencyKey: 'promote-2' })
      expect(again.id).toBe(first.id)
      expect(again.importance).toBe(0.9)
      expect(again.confidence).toBe(0.8)

      const byOtherAgent = await harness.client.promoteRoomEvent(b, { roomEventId: event.id, kind: 'decision', importance: 0.1, idempotencyKey: 'promote-3' })
      expect(byOtherAgent.id).toBe(first.id)
      // A merge raises the surviving record; it never lowers it.
      expect(byOtherAgent.importance).toBe(0.9)
      expect(byOtherAgent.confidence).toBe(0.8)
      // Promotion provenance survives the merge — spec section 7.3.
      expect(byOtherAgent.source.type).toBe('room')
      expect(byOtherAgent.source.roomEventId).toBe(event.id)

      const found = await harness.client.searchMemory(b, { query: 'packaged vector store' })
      expect(found.records.map(record => record.id)).toEqual([first.id])
    } finally { harness.close() }
  })

  it('promotes the same room event afresh once the earlier promotion is forgotten', async () => {
    // The merge must not resurrect a memory the owner deleted: a forgotten
    // promotion is gone, and a later promotion under a new key is a new record.
    const harness = create()
    try {
      const project = await harness.client.createProject(context('agent-a'), { displayName: 'Promotion after forget' })
      const scoped = context('agent-a', project.projectId)
      const event = await harness.client.postRoomEvent(scoped, {
        room: 'main', type: 'decision', body: 'Rollback window stays at one hour', idempotencyKey: 'decision-source',
      })
      const promoted = await harness.client.promoteRoomEvent(scoped, { roomEventId: event.id, kind: 'decision', importance: 0.5, idempotencyKey: 'promote-1' })
      await harness.client.forgetMemory(scoped, promoted.id)

      const fresh = await harness.client.promoteRoomEvent(scoped, { roomEventId: event.id, kind: 'decision', importance: 0.5, idempotencyKey: 'promote-2' })
      expect(fresh.id).not.toBe(promoted.id)
      expect((await harness.client.searchMemory(scoped, { query: 'rollback window' })).records.map(record => record.id)).toEqual([fresh.id])
    } finally { harness.close() }
  })
})
