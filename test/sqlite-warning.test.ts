/**
 * U-R1A-NODEWARN: on Node 22 no Tandem entry point prints `ExperimentalWarning: SQLite is an
 * experimental feature`, and every other warning still prints. bridge/sqlite-file.ts is the only
 * runtime module that loads node:sqlite; before it loads, it replaces the process's 'warning'
 * listeners with one filter that drops only that warning and passes every other one on.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SQLITE = 'ExperimentalWarning: SQLite is an experimental feature'
const IS22 = process.versions.node.startsWith('22.')
const BOX = mkdtempSync(join(tmpdir(), 'r1anodewarn-'))
const HOME = join(BOX, 'home')
const TH = join(BOX, 'th')
mkdirSync(HOME)
mkdirSync(TH)
const FILE_URL = pathToFileURL(join(repo, 'bridge', 'sqlite-file.ts')).href

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, TANDEM_HOME: TH }
  for (const k of ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'TMUX', 'TANDEM_CALLER_TOKEN']) delete env[k]
  return env
}

function node(...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', ...args], { cwd: BOX, timeout: 30_000, env: childEnv(), encoding: 'utf8' })
}

function script(name: string, body: string): string {
  const path = join(BOX, name)
  writeFileSync(path, body)
  return path
}

const count = (text: string, part: string) => text.split(part).length - 1

/** `<path>:<line>` for every line under bridge/, src/, scripts/, packaging/ of `root` that names node:sqlite in quotes. */
function sqliteSpecifiers(root: string): string[] {
  const out: string[] = []
  for (const top of ['bridge', 'src', 'scripts', 'packaging']) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!ent.isFile()) continue
      const path = join(ent.parentPath, ent.name)
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (/["'\x60]node:sqlite["'\x60]/.test(line)) out.push(`${relative(root, path)}:${i + 1}`)
      })
    }
  }
  return out.sort()
}

afterAll(() => {
  const socks = spawnSync('find', [BOX, '-type', 's'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  for (const s of socks) spawnSync('tmux', ['-S', s, 'kill-server'])
  rmSync(BOX, { recursive: true, force: true })
})

describe('U-R1A-NODEWARN: the SQLite ExperimentalWarning is dropped at one choke point', () => {
  it('(NODEWARN) w1 a plain child has at least one warning listener (Node prints warnings through it)', () => {
    const r = node('-e', "console.log(process.listeners('warning').length)")
    expect(r.status).toBe(0)
    expect(Number(r.stdout.trim())).toBeGreaterThanOrEqual(1)
  })

  it('(NODEWARN) w2 control: loading node:sqlite directly prints the warning on Node 22', () => {
    const p = script('w2.mjs', "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('node:sqlite')\n")
    const r = node(p)
    expect(r.status).toBe(0)
    if (IS22) expect(r.stderr).toContain(SQLITE)
    else console.log(`w2 control Node ${process.versions.node}: ${r.stderr.includes(SQLITE) ? 'present' : 'absent'}`)
  })

  it('(NODEWARN) w3 `bridge/kill-switch.ts status` prints only its one line', () => {
    const r = node(join(repo, 'bridge', 'kill-switch.ts'), 'status')
    expect([r.status, r.stdout, r.stderr]).toEqual([0, 'tandem: kill switch off\n', ''])
  })

  it('(NODEWARN) w4 `bridge/status.ts --json` prints JSON and no warning', () => {
    const r = node(join(repo, 'bridge', 'status.ts'), '--json')
    expect(r.status).toBe(0)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
    expect(r.stderr).not.toContain(SQLITE)
    expect(r.stderr).not.toContain('ExperimentalWarning')
  })

  it('(NODEWARN) w5 every other warning still prints, once', () => {
    const p = script('w5.mjs', [
      `await import(${JSON.stringify(FILE_URL)})`,
      "process.emitWarning('probe-exp', 'ExperimentalWarning')",
      "process.emitWarning('SQLite is great', 'ExperimentalWarning')",
      "process.emitWarning('SQLite is an experimental feature (copy)', 'Warning')",
      "process.emitWarning('probe-dep', 'DeprecationWarning', 'DEP0999')",
      '',
    ].join('\n'))
    const r = node(p)
    expect(r.status).toBe(0)
    expect(count(r.stderr, 'ExperimentalWarning: probe-exp')).toBe(1)
    expect(count(r.stderr, 'ExperimentalWarning: SQLite is great')).toBe(1)
    expect(count(r.stderr, ' Warning: SQLite is an experimental feature (copy)')).toBe(1)
    expect(count(r.stderr, 'DeprecationWarning: probe-dep')).toBe(1)
    expect(count(r.stderr, SQLITE)).toBe(0)
  })

  it('(NODEWARN) w6 the listeners present at load are replaced by one filter, not added to', () => {
    const p = script('w6.mjs', [
      "import fs from 'node:fs'",
      "process.on('warning', (w) => fs.writeSync(1, 'SEEN ' + w.name + ': ' + w.message + '\\n'))",
      `await import(${JSON.stringify(FILE_URL)})`,
      "console.log(process.listeners('warning').length)",
      "process.emitWarning('probe-exp', 'ExperimentalWarning')",
      '',
    ].join('\n'))
    const r = node(p)
    expect(r.status).toBe(0)
    const lines = r.stdout.split('\n')
    expect(lines[0]).toBe('1')
    expect(count(r.stdout, 'SEEN ExperimentalWarning: probe-exp')).toBe(1)
    expect(r.stdout).not.toContain('SEEN ExperimentalWarning: SQLite is an experimental feature')
  })

  it('(NODEWARN) w7 two evaluations of sqlite-file.ts in one process install one filter', () => {
    const p = script('w7.mjs', [
      `await import(${JSON.stringify(FILE_URL + '?a')})`,
      `await import(${JSON.stringify(FILE_URL + '?b')})`,
      "console.log(process.listeners('warning').length)",
      "process.emitWarning('probe-exp', 'ExperimentalWarning')",
      '',
    ].join('\n'))
    const r = node(p)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('1\n')
    expect(count(r.stderr, 'ExperimentalWarning: probe-exp')).toBe(1)
  })

  it('(NODEWARN) w8 under --no-warnings nothing prints, as before', () => {
    const p = script('w8.mjs', `await import(${JSON.stringify(FILE_URL)})\nprocess.emitWarning('probe-exp', 'ExperimentalWarning')\n`)
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', p], { cwd: BOX, timeout: 30_000, env: childEnv(), encoding: 'utf8' })
    expect([r.status, r.stderr]).toEqual([0, ''])
  })

  it('(NODEWARN) w9 sqlite-file.ts exports the real DatabaseSync', async () => {
    const mod = (await import('../bridge/sqlite-file.ts')) as Record<string, unknown>
    const Real = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
    expect(mod.DatabaseSync).toBe(Real)
    const db = new (mod.DatabaseSync as typeof Real)(':memory:')
    try {
      expect({ ...(db.prepare('select 1 as x').get() as object) }).toEqual({ x: 1 })
    } finally {
      db.close()
    }
  })

  it('(NODEWARN) w10 node:sqlite is named only in bridge/sqlite-file.ts among runtime files', () => {
    const all = sqliteSpecifiers(repo)
    expect(all.filter((x) => !x.startsWith('bridge/sqlite-file.ts:'))).toEqual([])
    expect(all.filter((x) => x.startsWith('bridge/sqlite-file.ts:')).length).toBeGreaterThanOrEqual(1)
    const plant = join(BOX, 'plant')
    mkdirSync(join(plant, 'bridge'), { recursive: true })
    mkdirSync(join(plant, 'scripts'), { recursive: true })
    writeFileSync(join(plant, 'bridge', 'x.ts'), "const a = createRequire(import.meta.url)('node:sqlite')\n")
    writeFileSync(join(plant, 'scripts', 'y.ts'), 'import type { DatabaseSync } from "node:sqlite"\n')
    expect(sqliteSpecifiers(plant)).toEqual(['bridge/x.ts:1', 'scripts/y.ts:1'])
  })
})
