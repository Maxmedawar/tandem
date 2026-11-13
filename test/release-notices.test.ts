/**
 * U-R1A-44 F2: the project's NOTICE and THIRD-PARTY-NOTICES ship in every release and in the npm
 * package (Apache-2.0 section 4(d) once the licence is Apache-2.0), and a release with an Apache
 * LICENSE and no NOTICE is refused.
 *
 * The files are not in this tree yet, so each case works on a copy of the working tree (tracked and
 * untracked files that git does not ignore; never .git or node_modules) under /tmp/r1a44-notices-*,
 * with node_modules cloned from this checkout's (npm ls refuses a linked one) and the helper cache linked to it. The copy is removed after each case.
 */
import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOTICE_TEXT = 'Tandem\nr1a44 notice fixture\n'
const THIRD_TEXT = 'r1a44 third-party notices fixture\n'
let copy = ''

/** The tree's own NOTICE and THIRD-PARTY-NOTICES where it has them, else a fixture text; returns both texts. */
function withNotices(root: string): [string, string] {
  return (['NOTICE', 'THIRD-PARTY-NOTICES'] as const).map((name, i) => {
    const file = join(root, name)
    if (!existsSync(file)) writeFileSync(file, i === 0 ? NOTICE_TEXT : THIRD_TEXT)
    return readFileSync(file, 'utf8')
  }) as [string, string]
}

afterEach(() => {
  if (copy) rmSync(copy, { recursive: true, force: true })
  copy = ''
})

/** A copy of the working tree with node_modules cloned and .cache linked back to this checkout. */
function copyTree(): string {
  copy = realpathSync(mkdtempSync('/tmp/r1a44-notices-'))
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
  expect(listed.status, listed.stderr).toBe(0)
  for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
    const from = join(repoRoot, path)
    if (!existsSync(from)) continue // deleted in the working tree
    mkdirSync(dirname(join(copy, path)), { recursive: true })
    copyFileSync(from, join(copy, path), constants.COPYFILE_FICLONE)
  }
  mkdirSync(join(repoRoot, '.cache'), { recursive: true })
  cpSync(join(repoRoot, 'node_modules'), join(copy, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  symlinkSync(join(repoRoot, '.cache'), join(copy, '.cache'))
  return copy
}

/** Runs the copy's build-release.sh into <copy>/out; status, output and the release tree. */
function build(root: string) {
  const out = join(root, 'out')
  const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_SKIP_AUDIT: '1', TANDEM_BUNDLE_NODE: '0' }
  delete env.TANDEM_SIGNING_KEY
  const r = spawnSync('sh', [join(root, 'packaging', 'build-release.sh'), out], { cwd: root, env, encoding: 'utf8' })
  const staged = existsSync(out) ? readdirSync(out).filter(name => name.startsWith('tandem-') && statSync(join(out, name)).isDirectory()) : []
  return { status: r.status, output: `${r.stdout}${r.stderr}`, tree: staged.length === 1 ? join(out, staged[0]!) : '' }
}

const manifestPaths = (tree: string) =>
  (JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }> }).files.map(f => f.path)

describe('(44) F2 NOTICE and THIRD-PARTY-NOTICES ship', () => {
  it('(44) N1 a tree with both files: both are in the release tree and its manifest', () => {
    const root = copyTree()
    const [notice, third] = withNotices(root)
    const r = build(root)
    expect(r.status, r.output).toBe(0)
    expect(readFileSync(join(r.tree, 'NOTICE'), 'utf8')).toBe(notice)
    expect(readFileSync(join(r.tree, 'THIRD-PARTY-NOTICES'), 'utf8')).toBe(third)
    const listed = manifestPaths(r.tree)
    expect(listed).toContain('NOTICE')
    expect(listed).toContain('THIRD-PARTY-NOTICES')
  }, 600_000)

  it('(44) N2 npm pack --dry-run --json lists both files', () => {
    const root = copyTree()
    withNotices(root)
    const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const [packed] = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>
    const paths = packed!.files.map(f => f.path)
    expect(paths).toContain('NOTICE')
    expect(paths).toContain('THIRD-PARTY-NOTICES')
  }, 120_000)

  it('(44) N3 an Apache LICENSE and no NOTICE: build-release exits non-zero naming NOTICE', () => {
    const root = copyTree()
    writeFileSync(join(root, 'LICENSE'), '\n                                 Apache License\n                           Version 2.0, January 2004\n')
    rmSync(join(root, 'NOTICE'), { force: true })
    const r = build(root)
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('NOTICE missing for an Apache-2.0 LICENSE')
    expect(r.tree).toBe('')
  }, 600_000)

  it('(44) N4 control: an MIT LICENSE and no NOTICE builds, with no NOTICE in the tree', () => {
    const root = copyTree()
    writeFileSync(join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 r1a44 fixture\n')
    rmSync(join(root, 'NOTICE'), { force: true })
    rmSync(join(root, 'THIRD-PARTY-NOTICES'), { force: true })
    const r = build(root)
    expect(r.status, r.output).toBe(0)
    expect(existsSync(join(r.tree, 'NOTICE'))).toBe(false)
    expect(existsSync(join(r.tree, 'THIRD-PARTY-NOTICES'))).toBe(false)
    expect(manifestPaths(r.tree)).not.toContain('NOTICE')
  }, 600_000)
})
