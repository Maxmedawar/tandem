import { join } from 'node:path'
import { tandemHome } from '../tandem-home.ts'
import { isFabricEnabled } from '../../src/fabric/capabilities.ts'
import { setting } from '../../src/legacy-env.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import type { FabricAuditAction, FabricAuditEntry, SQLiteFabricClientOptions } from './sqlite-fabric-client.ts'

export interface LocalFabricHost {
  readonly client: FabricClient
  close(): void
}

export interface LocalFabricHostOptions {
  readonly now?: () => number
  readonly audit?: (entry: FabricAuditEntry) => void
  /** Receives a one-line diagnostic. It must never be given a request body. */
  readonly log?: (message: string) => void
  /** Who a room post wakes (SQLiteFabricClientOptions.onWake), passed to the client. */
  readonly onWake?: SQLiteFabricClientOptions['onWake']
}

/**
 * The sole production host boundary. It is imported by the private Node
 * bridge and dynamically loads node:sqlite only after explicit enablement. The
 * Cloudflare Durable Object never imports or owns this database.
 *
 * Rooms, memory and projects all live in the one SQLite store. Each room post
 * commits in its own transaction, so an acknowledged post survives a kill.
 */
export async function createLocalFabricHost(
  env: Record<string, string | undefined> = process.env,
  options: LocalFabricHostOptions = {},
): Promise<LocalFabricHost | undefined> {
  if (!isFabricEnabled(env)) return undefined
  if (typeof process === 'undefined' || process.release?.name !== 'node' || process.versions.bun) {
    throw new Error('local Fabric storage requires the private Node bridge')
  }
  const configuredPath = setting(env, 'TANDEM_FABRIC_DB_PATH')?.trim()
  const databasePath = configuredPath || join(tandemHome(env.TANDEM_HOME), 'fabric', 'fabric.sqlite3')

  const { SQLiteFabricClient } = await import('./sqlite-fabric-client.ts')
  const client = new SQLiteFabricClient({ databasePath, now: options.now, audit: options.audit, onWake: options.onWake })

  let closed = false
  return Object.freeze({
    client,
    close() {
      if (closed) return
      closed = true
      client.close()
    },
  })
}

export interface StartFabricDependencies {
  readonly env?: Record<string, string | undefined>
  readonly createFabricHost?: typeof createLocalFabricHost
  readonly stdout?: (value: string) => void
  readonly stderr?: (value: string) => void
  /** Passed to the host: who a room post wakes. */
  readonly onWake?: SQLiteFabricClientOptions['onWake']
}

const FABRIC_AUDIT_ACTIONS = new Set<FabricAuditAction>([
  'project.create', 'project.list', 'project.get', 'project.archive',
  'room.post', 'room.read',
  'memory.remember', 'memory.search', 'memory.get', 'memory.forget', 'memory.promote',
])

/**
 * The bridge's fabric start-up step. Fabric is optional to the bridge: this
 * never throws, and its diagnostics are fixed lines that carry no error
 * message, path or input. Closing the host on shutdown is the caller's job.
 */
export async function startFabric(dependencies: StartFabricDependencies = {}): Promise<LocalFabricHost | undefined> {
  const createFabricHost = dependencies.createFabricHost ?? createLocalFabricHost
  const writeStdout = dependencies.stdout ?? (value => process.stdout.write(value))
  const writeStderr = dependencies.stderr ?? (value => process.stderr.write(value))
  const env = dependencies.env ?? process.env
  let fabricHost: LocalFabricHost | undefined
  try {
    fabricHost = await createFabricHost(env, {
      audit: productionFabricAuditSink(writeStdout, writeStderr),
      onWake: dependencies.onWake,
    })
  } catch {
    bestEffort(writeStderr, '[bridge] local Fabric initialization failed; Fabric disabled\n')
    return undefined
  }
  if (fabricHost) bestEffort(writeStdout, '[bridge] local Fabric storage enabled\n')
  return fabricHost
}

function bestEffort(write: (value: string) => void, value: string): void {
  try { write(value) } catch { /* a failed diagnostic must not stop the bridge */ }
}

/**
 * Production audit serialization is deliberately an allowlist. No caller input,
 * room body, memory text, query, idempotency token, path, or native error has a
 * route into the emitted object, even if a future producer adds fields.
 */
function productionFabricAuditSink(
  write: (value: string) => void,
  reportFailure: (value: string) => void,
): (entry: FabricAuditEntry) => void {
  return entry => {
    try {
      if (!FABRIC_AUDIT_ACTIONS.has(entry.action) || !['ok', 'denied', 'failed'].includes(entry.status) ||
        !['agent', 'owner', 'unknown'].includes(entry.actorType)) throw new Error('invalid audit metadata')
      const timestamp = new Date(entry.timestamp).toISOString()
      if (timestamp !== entry.timestamp) throw new Error('invalid audit metadata')
      const record = {
        timestamp,
        action: entry.action,
        status: entry.status,
        ownerId: auditMetadataIdentifier(entry.ownerId),
        deviceId: auditMetadataIdentifier(entry.deviceId),
        agentId: auditMetadataIdentifier(entry.agentId),
        actorType: entry.actorType,
        ...(entry.projectId === undefined ? {} : { projectId: auditMetadataIdentifier(entry.projectId) }),
        ...(entry.targetId === undefined ? {} : { targetId: auditMetadataIdentifier(entry.targetId) }),
        ...(entry.byteCount === undefined ? {} : { byteCount: auditMetadataCount(entry.byteCount) }),
        ...(entry.resultCount === undefined ? {} : { resultCount: auditMetadataCount(entry.resultCount) }),
        ...(entry.correlationId === undefined ? {} : { correlationId: auditMetadataIdentifier(entry.correlationId) }),
      }
      write(`[fabric-audit] ${JSON.stringify(record)}\n`)
    } catch {
      try { reportFailure('[fabric] production audit sink failed\n') } catch { /* fixed fallback is best effort */ }
    }
  }
}

function auditMetadataIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error('invalid audit metadata')
  }
  return value
}

function auditMetadataCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid audit metadata')
  return value
}
