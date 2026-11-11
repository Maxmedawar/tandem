import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCallerContext } from '../../src/fabric/capabilities.ts'
import { createLocalFabricHost } from '../../bridge/fabric/local-fabric-host.ts'

const directories = new Set<string>()
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tandem-fabric-host-'))
  chmodSync(directory, 0o700)
  directories.add(directory)
  return join(directory, 'fabric.sqlite3')
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

describe('local/private Fabric host', () => {
  it('is initialized only by the private bridge', () => {
    const host = readFileSync(new URL('../../bridge/fabric/local-fabric-host.ts', import.meta.url), 'utf8')
    expect(host).toContain('startFabric')
    const hubSource = new URL('../../hub/src/', import.meta.url)
    const files = readdirSync(hubSource, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(file.parentPath, file.name), 'utf8')
      for (const name of ['createLocalFabricHost', 'SQLiteFabricClient', 'startFabric', 'node:sqlite']) {
        expect(text, `${file.name} contains ${name}`).not.toContain(name)
      }
    }
  })

  it('does not create or expose a client unless explicitly enabled', async () => {
    const path = databasePath()
    expect(await createLocalFabricHost({ CCM_FABRIC_DB_PATH: path })).toBeUndefined()
    expect(await createLocalFabricHost({ CCM_FABRIC_ENABLED: 'yes', CCM_FABRIC_DB_PATH: path })).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('owns the durable SQLite client only when the Node bridge flag is enabled', async () => {
    const path = databasePath()
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: 'true', CCM_FABRIC_DB_PATH: path })
    expect(host).toBeDefined()
    const ctx = createCallerContext({
      ownerId: 'owner-a', deviceId: 'device-a', agentId: 'agent-a',
      actorType: 'owner', capabilities: ['project:create', 'project:read'],
    })
    const project = await host!.client.createProject(ctx, { displayName: 'Local only' })
    host!.close()
    expect(existsSync(path)).toBe(true)

    const reopened = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: path })
    expect((await reopened!.client.getProject(ctx, project.projectId))?.displayName).toBe('Local only')
    reopened!.close()
  })
})
