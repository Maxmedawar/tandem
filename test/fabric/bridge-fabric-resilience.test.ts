import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalFabricHost, startFabric } from '../../bridge/fabric/local-fabric-host.ts'
import type { FabricAuditEntry } from '../../bridge/fabric/sqlite-fabric-client.ts'
import { createCallerContext, FabricAuthError } from '../../src/fabric/capabilities.ts'
import type { FabricCapability } from '../../src/fabric/types.ts'

const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

const capabilities: FabricCapability[] = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:write:user',
  'memory:read', 'memory:read:user', 'memory:delete',
]

function context(projectId?: string, granted: readonly FabricCapability[] = capabilities) {
  return createCallerContext({
    ownerId: 'owner-production-audit',
    deviceId: 'device-production-audit',
    agentId: 'agent-production-audit',
    projectId,
    actorType: 'owner',
    capabilities: granted,
  })
}

describe('bridge startup resilience', () => {
  it('continues the existing connection startup when optional Fabric initialization fails', async () => {
    const calls: string[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = process.exitCode

    await expect(startFabric({
      createFabricHost: async () => {
        calls.push('fabric')
        throw new Error('PRIVATE_DATABASE_PATH_AND_NATIVE_ERROR')
      },
      stdout: value => stdout.push(value),
      stderr: value => stderr.push(value),
      env: {},
    })).resolves.toBeUndefined()

    expect(calls).toEqual(['fabric'])
    expect(process.exitCode).toBe(exitCode)
    expect(stderr).toEqual(['[bridge] local Fabric initialization failed; Fabric disabled\n'])
    expect([...stdout, ...stderr].join('')).not.toContain('PRIVATE_DATABASE_PATH_AND_NATIVE_ERROR')
  })

  it('wires a content-free production sink for successful, denied, and failed Fabric operations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tandem-production-audit-'))
    chmodSync(directory, 0o700)
    temporaryDirectories.add(directory)
    const stdout: string[] = []
    const stderr: string[] = []

    const host = await startFabric({
      env: {
        CCM_FABRIC_ENABLED: 'true',
        CCM_FABRIC_DB_PATH: join(directory, 'fabric.sqlite3'),
      },
      createFabricHost: async (env, options) => createLocalFabricHost(env, options),
      stdout: value => stdout.push(value),
      stderr: value => stderr.push(value),
    })

    expect(host).toBeDefined()
    expect(stdout).toContain('[bridge] local Fabric storage enabled\n')
    const project = await host!.client.createProject(context(), {
      displayName: 'PROJECT_NAME_MUST_NOT_LOG',
    })
    const scoped = context(project.projectId)
    await host!.client.postRoomEvent(scoped, {
      room: 'ROOM_NAME_MUST_NOT_LOG',
      type: 'message',
      body: 'ROOM_BODY_MUST_NOT_LOG',
      idempotencyKey: 'IDEMPOTENCY_TOKEN_MUST_NOT_LOG',
      correlationId: 'CORRELATION_SECRET_MUST_NOT_LOG',
    })
    await host!.client.remember(scoped, {
      scope: 'project',
      kind: 'fact',
      text: 'MEMORY_TEXT_MUST_NOT_LOG',
      importance: 0.5,
    })
    await host!.client.searchMemory(scoped, { query: 'SEARCH_QUERY_MUST_NOT_LOG' })
    await expect(host!.client.listProjects(context(undefined, []))).rejects.toBeInstanceOf(FabricAuthError)
    host!.close()
    await expect(host!.client.listProjects(context())).rejects.toThrow('fabric storage is unavailable')

    const auditLines = stdout.filter(line => line.startsWith('[fabric-audit] '))
    expect(auditLines).toHaveLength(6)
    const entries = auditLines.map(line => JSON.parse(line.slice('[fabric-audit] '.length)) as FabricAuditEntry)
    expect(entries.map(entry => entry.status)).toEqual(expect.arrayContaining(['ok', 'denied', 'failed']))
    expect(entries.map(entry => entry.action)).toEqual(expect.arrayContaining([
      'project.create', 'room.post', 'memory.remember', 'memory.search', 'project.list',
    ]))
    expect([...stdout, ...stderr].join('')).not.toMatch(
      /PROJECT_NAME_MUST_NOT_LOG|ROOM_NAME_MUST_NOT_LOG|ROOM_BODY_MUST_NOT_LOG|IDEMPOTENCY_TOKEN_MUST_NOT_LOG|CORRELATION_SECRET_MUST_NOT_LOG|MEMORY_TEXT_MUST_NOT_LOG|SEARCH_QUERY_MUST_NOT_LOG/,
    )
  })

  it('surfaces production audit sink failures with one fixed content-free diagnostic', async () => {
    const stderr: string[] = []
    let audit: ((entry: FabricAuditEntry) => void) | undefined
    await startFabric({
      createFabricHost: async (_env, options) => {
        audit = options?.audit
        return undefined
      },
      stdout: value => {
        if (value.startsWith('[fabric-audit] ')) throw new Error('AUDIT_WRITER_SECRET_MUST_NOT_LOG')
      },
      stderr: value => stderr.push(value),
      env: {},
    })

    expect(audit).toBeTypeOf('function')
    audit!({
      timestamp: '2026-08-12T00:00:00.000Z',
      action: 'project.list',
      status: 'ok',
      ownerId: 'owner-safe',
      deviceId: 'device-safe',
      agentId: 'agent-safe',
      actorType: 'owner',
    })
    expect(stderr).toEqual(['[fabric] production audit sink failed\n'])
    expect(stderr.join('')).not.toContain('AUDIT_WRITER_SECRET_MUST_NOT_LOG')
  })
})
