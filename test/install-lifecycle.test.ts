/**
 * Installing, upgrading, and removing Tandem.
 *
 * These run the real scripts against a real release, in a throwaway home. What
 * they cannot do is load a launchd agent or a systemd unit - that would put a
 * service on the machine running the tests - so `launchctl` and `systemctl` are
 * replaced by stubs on PATH that record what they were asked to do. Everything
 * else is genuine: an archive, a digest check, an unpack, a symlink flip, and a
 * removal.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const onMac = process.platform === 'darwin'
let releaseDir: string
let archive: string
let stubDir: string

beforeAll(() => {
  releaseDir = mkdtempSync(join(tmpdir(), 'tandem-install-release-'))
  execFileSync('sh', [join(repoRoot, 'packaging', 'build-release.sh'), releaseDir], {
    cwd: repoRoot, stdio: 'pipe',
  })
  archive = join(releaseDir, readdirSync(releaseDir).find(name => name.endsWith('.tar.gz'))!)

  // Both service managers are stubbed rather than run, whichever this machine
  // has: these tests must not leave a service registered where they ran.
  stubDir = mkdtempSync(join(tmpdir(), 'tandem-install-stub-'))
  for (const tool of ['launchctl', 'systemctl']) {
    writeFileSync(join(stubDir, tool), `#!/bin/sh\necho "${tool} $*" >> "$SERVICE_LOG"\nexit 0\n`)
    chmodSync(join(stubDir, tool), 0o755)
  }
}, 900_000)

afterAll(() => {
  for (const directory of [releaseDir, stubDir]) {
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

interface Sandbox {
  readonly home: string
  readonly state: string
  readonly serviceLog: string
  /** The launchd plist on macOS, the systemd user unit on Linux. */
  readonly serviceFile: string
  run(script: string, args?: readonly string[], archiveOverride?: string): string
  cleanup(): void
}

/**
 * The same release under a different version number.
 *
 * Upgrading has to be tested with two versions. Installing one archive twice
 * writes to the same directory, so a test that did that could not tell an
 * installer that preserves the previous version from one that deletes it.
 */
function bumpedArchive(version: string): string {
  const work = mkdtempSync(join(tmpdir(), 'tandem-bump-'))
  execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'pipe' })
  const original = readdirSync(work).find(name => name.startsWith('tandem-'))!
  const renamed = original.replace(/tandem-[^-]+-/, `tandem-${version}-`)
  cpSync(join(work, original), join(work, renamed), { recursive: true })
  rmSync(join(work, original), { recursive: true, force: true })

  const manifestPath = join(work, renamed, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.version = version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // The digest list covers the manifest's own digest, so it is rebuilt too.
  execFileSync('sh', ['-c',
    `cd "${join(work, renamed)}" && find . -type f ! -name manifest.json ! -name FILES.sha256 ! -name manifest.json.sig -exec shasum -a 256 {} + | ` +
    'sed "s|^\\([0-9a-f]*\\)  \\./|\\1  |" | LC_ALL=C sort -k 2 > FILES.sha256',
  ], { stdio: 'pipe' })
  const digest = execFileSync('shasum', ['-a', '256', join(work, renamed, 'FILES.sha256')], { encoding: 'utf8' }).split(/\s+/)[0]
  manifest.filesSha256 = digest
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const out = join(work, 'tandem.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', work, renamed], { stdio: 'pipe' })
  return out
}

/** The service definition is in place and the service manager (a stub) was asked to start it. */
function expectServiceInstalled(box: Sandbox): void {
  const definition = readFileSync(box.serviceFile, 'utf8')
  const log = readFileSync(box.serviceLog, 'utf8')
  if (onMac) {
    expect(definition).toContain('<string>com.tandem.runtime</string>')
    expect(log).toContain('launchctl bootstrap')
  } else {
    expect(definition).toContain(`ExecStart=${join(box.state, 'current')}/bin/tandem run`)
    expect(log).toContain('systemctl --user enable --now tandem.service')
  }
}

/** The service is stopped and its definition removed. */
function expectServiceRemoved(box: Sandbox): void {
  expect(existsSync(box.serviceFile)).toBe(false)
  const log = readFileSync(box.serviceLog, 'utf8')
  if (onMac) expect(log).toContain('launchctl bootout')
  else expect(log).toContain('systemctl --user disable --now tandem.service')
}

function sandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'tandem-home-'))
  const state = join(home, '.tandem')
  const serviceLog = join(home, 'service.log')
  writeFileSync(serviceLog, '')
  return {
    home,
    state,
    serviceLog,
    serviceFile: onMac
      ? join(state, 'agents', 'com.tandem.runtime.plist')
      : join(home, '.config', 'systemd', 'user', 'tandem.service'),
    run(script, args = [], archiveOverride) {
      return execFileSync('sh', [join(repoRoot, 'packaging', script), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          TANDEM_HOME: state,
          TANDEM_ARCHIVE: archiveOverride ?? archive,
          SERVICE_LOG: serviceLog,
          PATH: `${stubDir}:${process.env.PATH}`,
        },
      })
    },
    cleanup() { rmSync(home, { recursive: true, force: true }) },
  }
}

describe('installing Tandem on a machine that has nothing', { timeout: 300_000 }, () => {
  it('installs, points current at the version, and starts the runtime', () => {
    const box = sandbox()
    try {
      const output = box.run('install.sh')

      expect(output).toContain('is installed and running')
      const version = readdirSync(join(box.state, 'versions'))
      expect(version).toHaveLength(1)
      expect(realpathSync(join(box.state, 'current'))).toBe(realpathSync(join(box.state, 'versions', version[0]!)))
      expect(existsSync(join(box.state, 'current', 'bin', 'tandem'))).toBe(true)
      expect(existsSync(join(box.state, 'current', 'runtime', 'src', 'server.ts'))).toBe(true)
      expect(existsSync(join(box.home, '.local', 'bin', 'tandem'))).toBe(true)

      // The runtime is a background service, which is the product decision:
      // there is no application to keep open.
      expectServiceInstalled(box)
      const definition = readFileSync(box.serviceFile, 'utf8')
      if (onMac) {
        expect(definition).toContain('<key>RunAtLoad</key>')
        expect(definition).toContain('KeepAlive')
      } else {
        expect(definition).toContain('Restart=on-failure')
      }
    } finally { box.cleanup() }
  })

  it('installs nothing but Tandem', () => {
    const box = sandbox()
    try {
      box.run('install.sh')

      // The whole promise is that a person installs one thing. If a broker, a
      // network client, or a database had to be fetched, this is where it
      // would show up.
      const installed = readdirSync(box.state).sort()
      expect(installed).toEqual(['agents', 'current', 'run', 'versions'])
      expectServiceInstalled(box)
    } finally { box.cleanup() }
  })

  it('refuses an archive that does not match its published digest', () => {
    const box = sandbox()
    const tampered = join(box.home, 'tampered.tar.gz')
    try {
      mkdirSync(dirname(tampered), { recursive: true })
      writeFileSync(tampered, readFileSync(archive))
      writeFileSync(`${tampered}.sha256`, `${'0'.repeat(64)}  tampered.tar.gz\n`)

      expect(() => box.run('install.sh', [], tampered)).toThrow()

      // Nothing was unpacked, so a bad download cannot become the running
      // version, and no service manager was asked to do anything.
      expect(existsSync(join(box.state, 'current'))).toBe(false)
      expect(existsSync(box.serviceFile)).toBe(false)
      expect(readFileSync(box.serviceLog, 'utf8')).toBe('')
    } finally { box.cleanup() }
  })
})

describe('upgrading and removing', { timeout: 300_000 }, () => {
  it('leaves the previous version in place so a rollback is a symlink', () => {
    const box = sandbox()
    try {
      box.run('install.sh')
      const first = readdirSync(join(box.state, 'versions'))[0]!

      // A different version, so this is an upgrade rather than the same
      // directory being written twice.
      box.run('install.sh', [], bumpedArchive('9.9.9'))

      const installed = readdirSync(join(box.state, 'versions')).sort()
      expect(installed).toContain(first)
      expect(installed).toContain('9.9.9')
      expect(realpathSync(join(box.state, 'current'))).toBe(realpathSync(join(box.state, 'versions', '9.9.9')))
      // Rolling back is repointing the link at a tree that is still there.
      expect(existsSync(join(box.state, 'versions', first, 'bin', 'tandem'))).toBe(true)
      expect(existsSync(join(box.state, 'versions', first, 'runtime', 'src', 'server.ts'))).toBe(true)
      // The old runtime was stopped before the switch and the service started again.
      const log = readFileSync(box.serviceLog, 'utf8')
      if (onMac) expect(log).toContain('launchctl bootout')
      else expect(log).toContain('systemctl --user stop tandem.service')
      expectServiceInstalled(box)
    } finally { box.cleanup() }
  })

  it('does not destroy the running tree when the same version is installed again', () => {
    const box = sandbox()
    try {
      box.run('install.sh')
      const version = readdirSync(join(box.state, 'versions'))[0]!
      const marker = join(box.state, 'versions', version, 'runtime', 'src', 'server.ts')
      const before = readFileSync(marker).byteLength

      // Reinstalling the same version is the documented way to repair an
      // install. It must not remove what the running runtime is executing
      // from, and it must leave a complete tree behind.
      box.run('install.sh')
      expect(readdirSync(join(box.state, 'versions'))).toEqual([version])
      expect(readFileSync(marker).byteLength).toBe(before)
      expect(existsSync(join(box.state, 'current', 'bin', 'tandem'))).toBe(true)
      expectServiceInstalled(box)
    } finally { box.cleanup() }
  })

  it('removes the software and keeps the fabric data', () => {
    const box = sandbox()
    try {
      box.run('install.sh')
      mkdirSync(join(box.state, 'fabric'), { recursive: true })
      writeFileSync(join(box.state, 'fabric', 'fabric.sqlite3'), 'a project memory')

      const output = box.run('uninstall.sh')

      expect(output).toContain('still in')
      expect(existsSync(join(box.state, 'versions'))).toBe(false)
      expect(existsSync(join(box.state, 'current'))).toBe(false)
      expect(existsSync(join(box.home, '.local', 'bin', 'tandem'))).toBe(false)
      // Uninstalling an application should not be how someone loses a
      // project's memory.
      expect(readFileSync(join(box.state, 'fabric', 'fabric.sqlite3'), 'utf8')).toBe('a project memory')
      expectServiceRemoved(box)
    } finally { box.cleanup() }
  })

  it('reinstalls onto the data it left behind', () => {
    const box = sandbox()
    try {
      box.run('install.sh')
      mkdirSync(join(box.state, 'fabric'), { recursive: true })
      writeFileSync(join(box.state, 'fabric', 'fabric.sqlite3'), 'a project memory')
      box.run('uninstall.sh')

      box.run('install.sh')
      expect(existsSync(join(box.state, 'current', 'bin', 'tandem'))).toBe(true)
      expect(existsSync(join(box.state, 'current', 'runtime', 'src', 'server.ts'))).toBe(true)
      expectServiceInstalled(box)
      expect(readFileSync(join(box.state, 'fabric', 'fabric.sqlite3'), 'utf8')).toBe('a project memory')
    } finally { box.cleanup() }
  })

  it('removes the fabric data only when asked', () => {
    const box = sandbox()
    try {
      box.run('install.sh')
      mkdirSync(join(box.state, 'fabric'), { recursive: true })
      writeFileSync(join(box.state, 'fabric', 'fabric.sqlite3'), 'a project memory')

      const output = box.run('uninstall.sh', ['--purge'])
      expect(output).toContain('have been removed')
      expect(existsSync(join(box.state, 'fabric'))).toBe(false)
      expectServiceRemoved(box)
    } finally { box.cleanup() }
  })

  it('leaves a tandem command it did not install where it is', () => {
    const box = sandbox()
    try {
      mkdirSync(join(box.home, '.local', 'bin'), { recursive: true })
      writeFileSync(join(box.home, '.local', 'bin', 'tandem'), '#!/bin/sh\necho someone elses\n')
      box.run('install.sh')

      // The installer replaces its own link, so this is now Tandem's. Removing
      // it is correct; what must not happen is removing a file that was never
      // a link into Tandem's own state.
      rmSync(join(box.home, '.local', 'bin', 'tandem'))
      writeFileSync(join(box.home, '.local', 'bin', 'tandem'), '#!/bin/sh\necho someone elses\n')
      box.run('uninstall.sh')
      expect(existsSync(join(box.home, '.local', 'bin', 'tandem'))).toBe(true)
      expectServiceRemoved(box)
    } finally { box.cleanup() }
  })
})
