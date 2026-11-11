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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
  })

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
