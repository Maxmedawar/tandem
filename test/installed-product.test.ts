/**
 * The installed product, driven as a person would drive it.
 *
 * Everything else in this repository tests the code in this repository. This
 * builds a release, installs it into a throwaway home, and then uses only what
 * the installer put there: the launcher and the runtime tree. Nothing here
 * imports the runtime from the source tree, except the repository's own harness
 * list that the installed one is compared with.
 *
 * The runtime is never started: it binds a port this suite cannot claim. The
 * cases that need a running runtime answering on a status socket come with
 * `tandem status`.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadHarnesses } from '../bridge/harness-registry.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const onMac = process.platform === 'darwin'
let archive: string
let stubDir: string
let releaseDir: string
const homes: string[] = []

beforeAll(() => {
  releaseDir = mkdtempSync(join(tmpdir(), 'tandem-product-release-'))
  execFileSync('sh', [join(repoRoot, 'packaging', 'build-release.sh'), releaseDir], {
    cwd: repoRoot, stdio: 'pipe',
  })
  archive = join(releaseDir, readdirSync(releaseDir).find(name => name.endsWith('.tar.gz'))!)

  stubDir = mkdtempSync(join(tmpdir(), 'tandem-product-stub-'))
  for (const tool of ['launchctl', 'systemctl']) {
    writeFileSync(join(stubDir, tool), `#!/bin/sh\necho "${tool} $*" >> "$SERVICE_LOG"\nexit 0\n`)
    chmodSync(join(stubDir, tool), 0o755)
  }
}, 900_000)

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  for (const directory of [releaseDir, stubDir]) {
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

interface Installed {
  readonly home: string
  readonly state: string
  readonly env: NodeJS.ProcessEnv
  readonly serviceLog: string
  run(args: readonly string[]): string
}

function install(): Installed {
  const home = mkdtempSync(join(tmpdir(), 'tandem-product-home-'))
  homes.push(home)
  const state = join(home, '.tandem')
  const serviceLog = join(home, 'service.log')
  writeFileSync(serviceLog, '')
  const env = {
    ...process.env,
    HOME: home,
    TANDEM_HOME: state,
    TANDEM_ARCHIVE: archive,
    SERVICE_LOG: serviceLog,
    PATH: `${stubDir}:${process.env.PATH}`,
  }
  execFileSync('sh', [join(repoRoot, 'packaging', 'install.sh')], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })

  const launcher = join(state, 'current', 'bin', 'tandem')
  return {
    home,
    state,
    env,
    serviceLog,
    run(args) {
      return execFileSync('sh', [launcher, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    },
  }
}

/** Whether the installed release carries its own Node, by its own manifest. */
function bundlesNode(state: string): boolean {
  const manifest = JSON.parse(readFileSync(join(state, 'current', 'manifest.json'), 'utf8')) as { requiresSystemNode: boolean }
  return manifest.requiresSystemNode === false
}

/** The service definition was written and the service manager (a stub) was asked to start it. */
function expectService(tandem: Installed): void {
  const log = readFileSync(tandem.serviceLog, 'utf8')
  if (onMac) {
    expect(readFileSync(join(tandem.state, 'agents', 'com.tandem.runtime.plist'), 'utf8')).toContain('<string>com.tandem.runtime</string>')
    expect(log).toContain('launchctl bootstrap')
  } else {
    expect(readFileSync(join(tandem.home, '.config', 'systemd', 'user', 'tandem.service'), 'utf8')).toContain('ExecStart=')
    expect(log).toContain('systemctl --user enable --now tandem.service')
  }
}

describe('the installed product', () => {
  it('installs from a release and reports its own version', () => {
    const tandem = install()

    // The launcher runs from the installed tree, not from this repository.
    const repoVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version
    expect(tandem.run(['version']).trim()).toBe(repoVersion)
    expect(tandem.run(['version']).trim()).toMatch(/^\d+\.\d+\.\d+$/)
    // And through the link on PATH, which is how a person runs it.
    expect(execFileSync(join(tandem.home, '.local', 'bin', 'tandem'), ['version'], {
      encoding: 'utf8', env: tandem.env, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()).toBe(repoVersion)
    if (bundlesNode(tandem.state)) {
      expect(existsSync(join(tandem.state, 'current', 'libexec', 'node'))).toBe(true)
    }
    expectService(tandem)
  }, 300_000)

  it('loads the hub link and the harness registry from the installed tree', () => {
    const tandem = install()
    const current = join(tandem.state, 'current')
    // The Node the launcher would use: the bundled one when the release has it.
    const node = bundlesNode(tandem.state) ? join(current, 'libexec', 'node') : 'node'
    const script = [
      `const link = await import(${JSON.stringify(join(current, 'runtime', 'bridge', 'hub-link.ts'))})`,
      `const registry = await import(${JSON.stringify(join(current, 'runtime', 'bridge', 'harness-registry.ts'))})`,
      'const { harnesses } = registry.loadHarnesses()',
      'process.stdout.write(JSON.stringify({ frame: link.MAX_FRAME_BYTES, names: [...harnesses.keys()].sort() }))',
    ].join('\n')
    // Run from the home, not the repository, so nothing resolves from this checkout.
    const printed = execFileSync(node, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      encoding: 'utf8', cwd: tandem.home, env: tandem.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const loaded = JSON.parse(printed) as { frame: number; names: string[] }
    expect(loaded.frame).toBeGreaterThan(0)

    const repo = loadHarnesses({ ownerDir: join(tandem.home, 'no-owner-harnesses') })
    expect(loaded.names).toEqual([...repo.harnesses.keys()].sort())
    expectService(tandem)
  }, 300_000)
})
