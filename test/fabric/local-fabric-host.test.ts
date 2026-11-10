import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('does not create or expose a client unless explicitly enabled', async () => {
    const path = databasePath()
    expect(await createLocalFabricHost({ CCM_FABRIC_DB_PATH: path })).toBeUndefined()
    expect(await createLocalFabricHost({ CCM_FABRIC_ENABLED: 'yes', CCM_FABRIC_DB_PATH: path })).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })
})
