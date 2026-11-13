/**
 * What a published Tandem release may and may not contain.
 *
 * A leak of this kind is invisible by looking at a tarball: nobody unpacks a
 * release and reads every file, and by the time anyone would, it has been
 * downloaded. So the build is run for real and its output is walked here.
 *
 * The checks are deliberately about the whole tree rather than about a list of
 * files someone remembered to exclude. A release is defined by what it is
 * allowed to contain.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
let releaseDir: string
let tree: string
let files: string[]

/** Everything in the release that Tandem itself wrote. */
function ours(): string[] {
  return files.map(file => relative(tree, file)).filter(path => !path.startsWith('runtime/node_modules/'))
}

/** Everything in the release that came from a dependency. */
function dependencyPaths(): string[] {
  return files.map(file => relative(tree, file)).filter(path => path.startsWith('runtime/node_modules/'))
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

/** Every package directory under a node_modules folder, nested ones included, named as npm names them. */
function packageDirs(modules: string): Array<{ name: string; dir: string }> {
  if (!existsSync(modules)) return []
  return readdirSync(modules, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => entry.name.startsWith('@')
      ? readdirSync(join(modules, entry.name), { withFileTypes: true })
        .filter(scoped => scoped.isDirectory())
        .map(scoped => ({ name: `${entry.name}/${scoped.name}`, dir: join(modules, entry.name, scoped.name) }))
      : [{ name: entry.name, dir: join(modules, entry.name) }])
    .flatMap(pkg => [pkg, ...packageDirs(join(pkg.dir, 'node_modules'))])
}

beforeAll(() => {
  releaseDir = mkdtempSync(join(tmpdir(), 'tandem-release-'))
  execFileSync('sh', [join(repoRoot, 'packaging', 'build-release.sh'), releaseDir], {
    cwd: repoRoot, stdio: 'pipe',
  })
  const staged = readdirSync(releaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('tandem-'))
  expect(staged, 'the build produced no release tree').toHaveLength(1)
  tree = join(releaseDir, staged[0]!.name)
  files = walk(tree)
}, 900_000)

afterAll(() => {
  if (releaseDir) rmSync(releaseDir, { recursive: true, force: true })
})

describe('a published release', () => {
  it('contains the launcher, the runtime, the built-in harnesses, and the notices', () => {
    for (const path of [
      'bin/tandem',
      'runtime/src/server.ts',
      'runtime/bridge/hub-link.ts',
      'runtime/hub/src/protocol.ts',
      'runtime/hub/src/bridge-id.ts',
      'runtime/hub/src/devices.ts',
      'runtime/harnesses/SCHEMA.md',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      expect(existsSync(join(tree, path)), `${path} is missing`).toBe(true)
    }
    for (const harness of readdirSync(join(repoRoot, 'harnesses')).filter(name => name.endsWith('.toml'))) {
      expect(existsSync(join(tree, 'runtime', 'harnesses', harness)), `harness ${harness} is missing`).toBe(true)
    }
    expect(readFileSync(join(tree, 'LICENSE.txt'), 'utf8')).toContain('MIT License')
    expect(existsSync(join(tree, 'libexec', 'fabricd'))).toBe(false)
  })

  it('names every bundled dependency package with its licence', () => {
    const notices = readFileSync(join(tree, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const packages = packageDirs(join(tree, 'runtime', 'node_modules'))
    expect(packages.length, 'the release bundles no dependencies').toBeGreaterThan(0)
    for (const { name, dir } of packages) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; license?: unknown }
      expect(typeof manifest.license === 'string' && manifest.license.length > 0, `${name} declares no licence`).toBe(true)
      expect(notices, `notices omit ${name}`).toContain(`${name} ${manifest.version}: ${manifest.license as string}`)
    }
  })

  it('does not redistribute a runtime without its licence', () => {
    // Node aggregates V8, OpenSSL, ICU, libuv, zlib and others. Shipping it
    // without that attribution is a licence violation, so a build that cannot
    // find the licence must not ship the binary either.
    const bundledNode = existsSync(join(tree, 'libexec', 'node'))
    const notices = readFileSync(join(tree, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    if (bundledNode) {
      expect(existsSync(join(tree, 'LICENSE.node.txt')), 'Node is bundled without its LICENSE').toBe(true)
      expect(notices, 'notices omit the bundled Node runtime').toContain('Node.js')
    }
    const manifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as { requiresSystemNode: boolean }
    expect(manifest.requiresSystemNode).toBe(!bundledNode)
  })

  it('(51) ships the ccusage helper, its licence and its notice line, all in the manifest', () => {
    expect(statSync(join(tree, 'libexec', 'ccusage')).mode & 0o111, 'libexec/ccusage is not executable').not.toBe(0)
    expect(readFileSync(join(tree, 'LICENSE.ccusage.txt'), 'utf8'))
      .toBe(readFileSync(join(repoRoot, 'packaging', 'helpers', 'ccusage', 'LICENSE'), 'utf8'))
    expect(readFileSync(join(tree, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
      .toContain('- ccusage 20.0.49 (libexec/ccusage, native helper): MIT, see LICENSE.ccusage.txt')
    const listed = (JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }> }).files.map(entry => entry.path)
    for (const path of ['libexec/ccusage', 'LICENSE.ccusage.txt', 'THIRD_PARTY_NOTICES.md']) expect(listed, `${path} is not in the manifest`).toContain(path)
  })

  it('lists every file it contains with a digest that matches', () => {
    const manifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>
    }
    const listed = new Set(manifest.files.map(entry => entry.path))
    for (const file of files) {
      const path = relative(tree, file)
      if (path === 'manifest.json' || path === 'FILES.sha256') continue
      expect(listed.has(path), `${path} is in the release but not in its manifest`).toBe(true)
    }
    // The digests are what an installer verifies before running any of it.
    execFileSync('shasum', ['-a', '256', '-c', 'FILES.sha256'], { cwd: tree, stdio: 'pipe' })
  }, 60_000)

  it('carries none of this project\'s test, benchmark, or development material', () => {
    const forbidden = ours()
      .filter(path => /(^|\/)(test|tests|bench|\.git|\.github|\.wrangler)(\/|$)/.test(path)
        || /\.test\.ts$/.test(path)
        || /(^|\/)(wrangler\.toml|vitest\.config\.ts|tsconfig\.json|\.env.*|CLAUDE\.md|AGENTS\.md)$/.test(path))
    expect(forbidden, 'development material reached the release').toEqual([])
  })

  it('ships its dependencies pruned of the material they only need to develop', () => {
    // Dependencies are shipped so the runtime does not have to reach a package
    // registry the first time it starts. What they carry is theirs, but their
    // fixtures are not something Tandem should be redistributing - a package
    // with a sample key would put one inside a Tandem release.
    const leftovers = dependencyPaths()
      .filter(path => /(^|\/)(test|tests|__tests__|fixtures|__fixtures__|examples?|docs?|coverage|\.github)(\/|$)/.test(path)
        || /\.(test|spec)\.js$/.test(path))
    expect(leftovers.slice(0, 10), 'dependency development material reached the release').toEqual([])
  })

  it('carries no credential, token, or private endpoint', () => {
    // A build machine has an environment. A release must not have absorbed any
    // of it, which is not something a reviewer can see by looking.
    const patterns: Array<[string, RegExp]> = [
      ['an API key', /\b(sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
      ['a bearer token', /\bBearer\s+[A-Za-z0-9._-]{20,}/],
      ['a private key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
      ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
      ['a Cloudflare account id', /\baccount_id\s*=\s*"[0-9a-f]{32}"/],
    ]
    const found: string[] = []
    for (const path of ours()) {
      if (/\/node$/.test(path)) continue
      const contents = readFileSync(join(tree, path), 'utf8')
      for (const [what, pattern] of patterns) {
        if (pattern.test(contents)) found.push(`${path}: ${what}`)
      }
    }
    expect(found).toEqual([])
  })

  it('ships no actual key material, including inside its dependencies', () => {
    // A library that parses keys contains the words a key begins with. What
    // must not be here is a key: a header, a body, and a footer.
    const key = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[A-Za-z0-9+/=\s]{64,}-----END/
    const found: string[] = []
    for (const file of files) {
      if (/\/node$/.test(file)) continue
      if (key.test(readFileSync(file, 'utf8'))) found.push(relative(tree, file))
    }
    expect(found).toEqual([])
  })

  it('carries no path from the machine that built it', () => {
    const home = process.env.HOME
    expect(home, 'HOME is unset, so this check would prove nothing').toBeTruthy()
    // Every file, dependencies included. They are copied from the tree this
    // machine resolved, so a package that wrote an absolute path into a
    // generated file would carry this machine's home into the release.
    // The home is matched as a whole path, never inside a longer name: with a
    // home of /root, "/roots/list" and ".../gcc-toolset-12/root/usr" are not it.
    const homePath = new RegExp(`(?<![A-Za-z0-9._-])${home!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`)
    const found: string[] = []
    for (const file of files) {
      const path = relative(tree, file)
      if (/manifest\.json$|FILES\.sha256$/.test(path)) continue
      if (homePath.test(readFileSync(file, 'latin1'))) found.push(path)
    }
    expect(found, 'the build machine\'s home directory reached the release').toEqual([])
  })

  it('is installed owner-only, with an executable launcher', () => {
    expect(statSync(join(tree, 'bin', 'tandem')).mode & 0o111).not.toBe(0)
    for (const file of files) {
      expect(statSync(file).mode & 0o002, `${relative(tree, file)} is world-writable`).toBe(0)
    }
  })

  it('packs a tarball beside a digest of it', () => {
    const archives = readdirSync(releaseDir).filter(name => name.endsWith('.tar.gz'))
    expect(archives).toHaveLength(1)
    const digestFile = join(releaseDir, `${archives[0]!}.sha256`)
    expect(existsSync(digestFile)).toBe(true)

    const published = readFileSync(digestFile, 'utf8').split(/\s+/)[0]
    const actual = execFileSync('shasum', ['-a', '256', join(releaseDir, archives[0]!)], { encoding: 'utf8' })
      .split(/\s+/)[0]
    expect(actual).toBe(published)
    // The digest file names the archive alone, so it verifies wherever both
    // are put and carries no path from the build machine.
    expect(readFileSync(digestFile, 'utf8')).toBe(`${published}  ${archives[0]!}\n`)
  })
})

describe('the npm package', () => {
  it('carries the hub files the bridge imports and the built-in harnesses', () => {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ files: Array<{ path: string }> }>
    const paths = packed!.files.map(file => file.path)
    for (const path of ['hub/src/protocol.ts', 'hub/src/bridge-id.ts', 'hub/src/devices.ts', 'harnesses/SCHEMA.md']) {
      expect(paths, `npm pack omits ${path}`).toContain(path)
    }
  })
})

describe('the licence shipped with a bundled runtime', () => {
  it('describes the binary it sits beside', () => {
    // A licence that does not describe the binary it ships with is worse than
    // none: it looks like attribution while attributing the wrong thing.
    const nodePath = join(tree, 'libexec', 'node')
    if (!existsSync(nodePath)) return

    const license = readFileSync(join(tree, 'LICENSE.node.txt'), 'utf8')
    // The aggregate: Node's own terms plus the components it embeds.
    for (const component of ['Node.js is licensed', 'OpenSSL', 'libuv', 'zlib']) {
      expect(license, `the bundled licence omits ${component}`).toContain(component)
    }
  })
})

/**
 * U-R1A-FIXNODE: the `node` a build finds is often a link (mini: ~/.local/bin/node ->
 * ~/.hermes/node/bin/node, the LICENSE in ~/.hermes/node). A build that cannot ship Node stops,
 * unless TANDEM_BUNDLE_NODE=0 asks for a release that needs Node on the target.
 */
describe('(FIXNODE) bundling Node', { timeout: 900_000 }, () => {
  const box = mkdtempSync(join(tmpdir(), 'r1afixnode-'))
  const LICENSE_TEXT = 'Node.js is licensed for use as follows:\n\nr1afixnode fake licence\n'
  /** <box>/<name>/real/bin/node (answers process.execPath with its own path, else runs this Node), linked from <box>/<name>/link/node. */
  function fakeNode(name: string, withLicense: boolean): string {
    const real = join(box, name, 'real')
    mkdirSync(join(real, 'bin'), { recursive: true })
    mkdirSync(join(box, name, 'link'))
    writeFileSync(join(real, 'bin', 'node'), `#!/bin/sh\nif [ "$1" = -p ] && [ "$2" = process.execPath ]; then echo '${join(real, 'bin', 'node')}'; exit 0; fi\nexec '${process.execPath}' "$@"\n`)
    chmodSync(join(real, 'bin', 'node'), 0o755)
    if (withLicense) writeFileSync(join(real, 'LICENSE'), LICENSE_TEXT)
    symlinkSync(join(real, 'bin', 'node'), join(box, name, 'link', 'node'))
    return join(box, name, 'link')
  }
  function build(link: string, out: string, extra: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${link}:${process.env.PATH}`, TANDEM_SKIP_AUDIT: '1', ...extra }
    for (const name of ['TANDEM_NODE_LICENSE', 'TANDEM_NODE_BINARY', 'TANDEM_BUNDLE_NODE']) if (!(name in extra)) delete env[name]
    mkdirSync(out)
    return spawnSync('sh', [join(repoRoot, 'packaging', 'build-release.sh'), out], { cwd: repoRoot, env, encoding: 'utf8' })
  }
  const stagedTree = (out: string) => join(out, readdirSync(out).find(name => name.startsWith('tandem-') && !name.includes('.tar.gz'))!)

  afterAll(() => {
    spawnSync('chmod', ['-R', 'u+w', box])
    rmSync(box, { recursive: true, force: true })
  })

  it('(FIXNODE) f1 a linked node whose real folder holds the Node LICENSE is bundled', () => {
    const out = join(box, 'out-f1')
    const r = build(fakeNode('licensed', true), out)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('  node runtime\n')
    expect(r.stderr).not.toContain('node runtime (skipped')
    const staged = stagedTree(out)
    expect(existsSync(join(staged, 'libexec', 'node'))).toBe(true)
    expect(readFileSync(join(staged, 'LICENSE.node.txt'), 'utf8')).toBe(LICENSE_TEXT)
    const manifest = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8')) as { requiresSystemNode: boolean }
    expect(manifest.requiresSystemNode).toBe(false)
    const archive = readdirSync(out).find(name => name.endsWith('.tar.gz'))!
    const listed = execFileSync('tar', ['-tzf', join(out, archive)], { encoding: 'utf8' }).split('\n')
    expect(listed).toContain(`${archive.replace(/\.tar\.gz$/, '')}/libexec/node`)
  })

  it('(FIXNODE) f2 no Node LICENSE anywhere: the build exits non-zero naming both ways out', () => {
    const out = join(box, 'out-f2')
    const r = build(fakeNode('bare', false), out)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('its LICENSE was not found')
    expect(r.stderr).toContain('TANDEM_NODE_LICENSE')
    expect(r.stderr).toContain('TANDEM_BUNDLE_NODE=0')
    expect(readdirSync(out).filter(name => name.endsWith('.tar.gz'))).toEqual([])
  })

  it('(FIXNODE) f3 TANDEM_BUNDLE_NODE=0 builds without Node and records that it needs one', () => {
    const out = join(box, 'out-f3')
    const r = build(fakeNode('bare-f3', false), out, { TANDEM_BUNDLE_NODE: '0' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('  node runtime (not bundled: TANDEM_BUNDLE_NODE=0; the target needs its own Node)\n')
    const staged = stagedTree(out)
    expect(existsSync(join(staged, 'libexec', 'node'))).toBe(false)
    expect(existsSync(join(staged, 'LICENSE.node.txt'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8')) as { requiresSystemNode: boolean }
    expect(manifest.requiresSystemNode).toBe(true)
  })
})
