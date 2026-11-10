import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isFabricEnabled } from '../../src/fabric/capabilities.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import type { MeshEnrollInput, MeshStatus } from '../../src/fabric/bus-contract.ts'
type MeshTransport = unknown
import type { FabricAuditEntry } from './sqlite-fabric-client.ts'

export interface LocalFabricHost {
  readonly client: FabricClient
  /** This device's view of the fabric it is on, if it is on one. */
  meshStatus(): Promise<MeshStatus>
  /** Joins this device to a fabric, or moves it to another. */
  enroll(input: MeshEnrollInput): Promise<MeshStatus>
  /** Carries fabric requests to and from peers on the mesh. */
  readonly transport: MeshTransport
  close(): void
}

export interface LocalFabricHostOptions {
  readonly now?: () => number
  readonly audit?: (entry: FabricAuditEntry) => void
  /** Receives a one-line diagnostic. It must never be given a request body. */
  readonly log?: (message: string) => void
}

/**
 * The sole Phase 1 production host boundary. It is imported by the private Node
 * bridge and dynamically loads node:sqlite only after explicit enablement. The
 * Cloudflare Durable Object never imports or owns this database.
 */
export async function createLocalFabricHost(
  env: Record<string, string | undefined> = process.env,
  options: LocalFabricHostOptions = {},
): Promise<LocalFabricHost | undefined> {
  if (!isFabricEnabled(env)) return undefined
  if (typeof process === 'undefined' || process.release?.name !== 'node' || process.versions.bun) {
    throw new Error('local Fabric storage requires the private Node bridge')
  }
  const configuredPath = env.CCM_FABRIC_DB_PATH?.trim()
  const databasePath = configuredPath || join(homedir(), '.tandem', 'fabric', 'fabric.sqlite3')

  // A fabric's parts belong together. Pointing Tandem at a different database
  // moves the durable log and the device identity with it unless they are
  // named explicitly, so configuring one part cannot leave the others behind
  // in the default location - which is how a test run ends up writing into
  // somebody's real fabric.
  const fabricRoot = dirname(databasePath)
  const storeDir = env.CCM_FABRIC_BUS_DIR?.trim() || join(fabricRoot, 'bus')
  const meshDir = env.CCM_FABRIC_MESH_DIR?.trim() || join(fabricRoot, 'mesh')

  // Phase 3: room events are durable on the embedded bus, so the bus starting
  // is a precondition for Fabric rather than an enhancement to it. A failure
  // here propagates and the bridge runs with Fabric disabled - which is the
  // honest outcome, because a client that quietly fell back to SQLite-only
  // storage would still answer room reads while no longer being what the
  // rooms are durable in.
  throw new Error('fabric: room bus not available until U-R1A-21')
}
