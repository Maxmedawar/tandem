/** Secondary source guard. Behavior and schemas are exercised by the pure MCP
 * registration and bridge RPC tests; this only proves the production entrypoint
 * invokes that seam without importing local SQLite into Cloudflare. */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Phase 1: Fabric is conditionally wired without moving storage into Cloudflare', () => {
  it('production source never imports the test-only adapter', () => {
    const root = new URL('../../src/', import.meta.url)
    const files = (directory: URL): URL[] => readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
      const url=new URL(entry.name + (entry.isDirectory()?'/':''),directory)
      return entry.isDirectory()?files(url):[url]
    })
    for (const file of files(root)) {
      const src = readFileSync(file, 'utf8')
      expect(src).not.toMatch(/test\/fabric|in-memory-fabric-client|fake-fabric-client/i)
    }
  })
})
