// U-R1A-CCMNAMES: the four settings renamed from CCM_ to TANDEM_ are read through src/legacy-env.ts.
// The new name wins; an old name still works and prints one deprecation line per name per process
// (never the value). Stderr cases run in a fresh node so the once-per-process memory starts empty.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const SHIM = new URL('../src/legacy-env.ts', import.meta.url).href
const PAIRS: [string, string][] = [
  ['TANDEM_CWD_ALLOWLIST', 'CCM_CWD_ALLOWLIST'],
  ['TANDEM_DEFAULT_CWD', 'CCM_DEFAULT_CWD'],
  ['TANDEM_FABRIC_DB_PATH', 'CCM_FABRIC_DB_PATH'],
  ['TANDEM_FABRIC_ENABLED', 'CCM_FABRIC_ENABLED'],
]
const line = (oldName: string, newName: string) => `tandem: ${oldName} is deprecated; set ${newName} instead`

// Run `reads` (setting names, in order) in a fresh node with `env` and return each value and stderr.
function child(env: Record<string, string>, reads: string[]): { values: (string | null)[]; stderr: string } {
  const script = `const { setting } = await import(${JSON.stringify(SHIM)}); const e = { ...process.env };
process.stdout.write(JSON.stringify(${JSON.stringify(reads)}.map((n) => setting(e, n) ?? null)));`
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_NO_WARNINGS: '1', ...env },
    encoding: 'utf8',
  })
  expect(r.status, r.stderr).toBe(0)
  return { values: JSON.parse(r.stdout), stderr: r.stderr }
}

const dirs: string[] = []
function runDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'r1accm-'))
  chmodSync(d, 0o700)
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('src/legacy-env.ts setting()', () => {
  it('RENAMED maps exactly the four new names to their old ones', async () => {
    const { RENAMED } = await import('../src/legacy-env.ts')
    expect(Object.entries(RENAMED).sort()).toEqual([...PAIRS].sort())
  })

  it('e1 each new name alone: its value, no stderr line', () => {
    for (const [n] of PAIRS) {
      const r = child({ [n]: `v-${n}` }, [n])
      expect(r.values).toEqual([`v-${n}`])
      expect(r.stderr).toBe('')
    }
  })

  it('e2 each old name alone: its value and exactly one deprecation line; a second read prints nothing more', () => {
    for (const [n, o] of PAIRS) {
      const r = child({ [o]: `v-${o}` }, [n, n])
      expect(r.values).toEqual([`v-${o}`, `v-${o}`])
      expect(r.stderr).toBe(`${line(o, n)}\n`)
    }
  })

  it('e2 all four old names: one line each, in read order', () => {
    const env = Object.fromEntries(PAIRS.map(([, o]) => [o, `v-${o}`]))
    const reads = PAIRS.flatMap(([n]) => [n, n])
    const r = child(env, reads)
    expect(r.values).toEqual(PAIRS.flatMap(([, o]) => [`v-${o}`, `v-${o}`]))
    expect(r.stderr).toBe(PAIRS.map(([n, o]) => `${line(o, n)}\n`).join(''))
  })

  it('e3 both set: the new one wins, no line', () => {
    for (const [n, o] of PAIRS) {
      const r = child({ [n]: 'new', [o]: 'old' }, [n])
      expect(r.values).toEqual(['new'])
      expect(r.stderr).toBe('')
    }
  })

  it('e4 new name blank or whitespace: falls back to the old one (line printed); both blank: undefined', () => {
    for (const [n, o] of PAIRS) {
      for (const blank of ['', '  \t']) {
        const r = child({ [n]: blank, [o]: 'old' }, [n])
        expect(r.values).toEqual(['old'])
        expect(r.stderr).toBe(`${line(o, n)}\n`)
      }
      const both = child({ [n]: ' ', [o]: '' }, [n])
      expect(both.values).toEqual([null])
      expect(both.stderr).toBe('')
    }
  })

  it('e5 an unknown name throws', async () => {
    const { setting } = await import('../src/legacy-env.ts')
    expect(() => setting({}, 'TANDEM_NOT_A_SETTING')).toThrow()
    expect(() => setting({}, 'CCM_FABRIC_DB_PATH')).toThrow()
  })

  it('e6 the line never holds the value', () => {
    const secret = `r1accm-${process.pid}-${Date.now()}-value`
    for (const [n, o] of PAIRS) {
      const r = child({ [o]: secret }, [n])
      expect(r.values).toEqual([secret])
      expect(r.stderr).not.toContain(secret)
      expect(r.stderr).toBe(`${line(o, n)}\n`)
    }
  })
})

describe('e7 the readers go through setting()', () => {
  it('createLocalFabricHost opens the TANDEM_FABRIC_DB_PATH store, no line', async () => {
    const { createLocalFabricHost } = await import('../bridge/fabric/local-fabric-host.ts')
    const path = join(runDir(), 'new.sqlite3')
    const spy = vi.spyOn(process.stderr, 'write')
    try {
      const host = await createLocalFabricHost({ TANDEM_FABRIC_ENABLED: '1', TANDEM_FABRIC_DB_PATH: path })
      expect(host).toBeDefined()
      host!.close()
      expect(existsSync(path)).toBe(true)
      expect(spy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('deprecated'))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('createLocalFabricHost still opens the old pair\'s store, with one line per old name', async () => {
    const { createLocalFabricHost } = await import('../bridge/fabric/local-fabric-host.ts')
    const path = join(runDir(), 'old.sqlite3')
    const spy = vi.spyOn(process.stderr, 'write')
    try {
      const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: path })
      expect(host).toBeDefined()
      host!.close()
      expect(existsSync(path)).toBe(true)
      expect(spy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('deprecated')).sort()).toEqual([
        `${line('CCM_FABRIC_DB_PATH', 'TANDEM_FABRIC_DB_PATH')}\n`,
        `${line('CCM_FABRIC_ENABLED', 'TANDEM_FABRIC_ENABLED')}\n`,
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('isFabricEnabled reads TANDEM_FABRIC_ENABLED', async () => {
    const { isFabricEnabled } = await import('../src/fabric/capabilities.ts')
    expect(isFabricEnabled({ TANDEM_FABRIC_ENABLED: ' TRUE ' })).toBe(true)
    expect(isFabricEnabled({ TANDEM_FABRIC_ENABLED: 'no' })).toBe(false)
    expect(isFabricEnabled({})).toBe(false)
  })

  it('buildAllowlist(setting(...)) from TANDEM_CWD_ALLOWLIST', async () => {
    const { setting } = await import('../src/legacy-env.ts')
    const { buildAllowlist } = await import('../bridge/sessions.ts')
    const d = runDir()
    expect(buildAllowlist(setting({ TANDEM_CWD_ALLOWLIST: d }, 'TANDEM_CWD_ALLOWLIST'))).toEqual([realpathSync(d)])
  })
})

describe('e8 MCP_ENV_NAMES', () => {
  it('holds all eight names, sorted, unique', async () => {
    const { MCP_ENV_NAMES } = await import('../bridge/delivery-hooks.ts')
    for (const [n, o] of PAIRS) {
      expect(MCP_ENV_NAMES).toContain(n)
      expect(MCP_ENV_NAMES).toContain(o)
    }
    expect([...MCP_ENV_NAMES]).toEqual([...new Set(MCP_ENV_NAMES)].sort())
  })
})
