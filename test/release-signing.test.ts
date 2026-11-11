/**
 * Signing a release, and refusing one that is not signed by Tandem.
 *
 * A digest published beside an archive protects against a download that broke.
 * It does not protect against one that was replaced, because whoever replaced
 * the archive publishes the digest too. A signature is the difference, and the
 * key it is checked against has to be in the installer rather than in the
 * archive - a key shipped alongside what it signs proves nothing.
 *
 * The key here is a throwaway one made for this run; no real key is involved.
 * `launchctl` and `systemctl` are logging stubs, so no service is registered.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const onMac = process.platform === 'darwin'
let workDir: string
let signingKey: string
let publicKey: string
let releaseDir: string
let tree: string
let stubDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tandem-signing-'))
  signingKey = join(workDir, 'release.key')
  publicKey = join(workDir, 'release.pub')

  // The same curve the installer verifies with, chosen because it is what the
  // system toolchain on a target machine supports.
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', signingKey], { stdio: 'pipe' })
  execFileSync('openssl', ['ec', '-in', signingKey, '-pubout', '-out', publicKey], { stdio: 'pipe' })

  releaseDir = join(workDir, 'release')
  execFileSync('sh', [join(repoRoot, 'packaging', 'build-release.sh'), releaseDir], {
    cwd: repoRoot, stdio: 'pipe', env: { ...process.env, TANDEM_SIGNING_KEY: signingKey },
  })
  tree = join(releaseDir, readdirSync(releaseDir, { withFileTypes: true })
    .find(entry => entry.isDirectory() && entry.name.startsWith('tandem-'))!.name)

  // Both service managers are stubbed, whichever this machine has: these tests
  // must not leave a service registered on whatever machine they ran on.
  stubDir = join(workDir, 'stub')
  execFileSync('mkdir', ['-p', stubDir])
  for (const tool of ['launchctl', 'systemctl']) {
    writeFileSync(join(stubDir, tool), `#!/bin/sh\necho "${tool} $*" >> "$SERVICE_LOG"\nexit 0\n`)
    chmodSync(join(stubDir, tool), 0o755)
  }
}, 900_000)

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** An installer with a real public key baked in, as a published one would be. */
function installerWith(key: string): string {
  const source = readFileSync(join(repoRoot, 'packaging', 'install.sh'), 'utf8')
  const path = join(mkdtempSync(join(tmpdir(), 'tandem-installer-')), 'install.sh')
  writeFileSync(path, source.replace('TANDEM_RELEASE_PUBLIC_KEY', readFileSync(key, 'utf8').trim()))
  chmodSync(path, 0o755)
  return path
}

function pack(from: string): string {
  const archive = join(mkdtempSync(join(tmpdir(), 'tandem-archive-')), 'tandem.tar.gz')
  // Links are preserved as links rather than followed, which is what an
  // attacker appending one to a real archive would produce.
  execFileSync('tar', ['-czf', archive, '-C', dirname(from), from.split('/').pop()!], { stdio: 'pipe' })
  execFileSync('sh', ['-c', `shasum -a 256 "${archive}" > "${archive}.sha256"`], { stdio: 'pipe' })
  return archive
}

/** The service definition the installer writes on this platform. */
function serviceFile(home: string): string {
  return onMac
    ? join(home, '.tandem', 'agents', 'com.tandem.runtime.plist')
    : join(home, '.config', 'systemd', 'user', 'tandem.service')
}

interface Result { ok: boolean; output: string; home: string; log: string }

function install(installer: string, archive: string, extraEnv: Record<string, string> = {}): Result {
  const home = mkdtempSync(join(tmpdir(), 'tandem-signing-home-'))
  const serviceLog = join(home, 'service.log')
  writeFileSync(serviceLog, '')
  let ok = true
  let output: string
  try {
    output = execFileSync('sh', [installer], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, HOME: home, TANDEM_HOME: join(home, '.tandem'),
        TANDEM_ARCHIVE: archive, SERVICE_LOG: serviceLog, PATH: `${stubDir}:${process.env.PATH}`,
        ...extraEnv,
      },
    })
  } catch (error) {
    ok = false
    output = String((error as { stderr?: string }).stderr ?? error)
  }
  return { ok, output, home, log: readFileSync(serviceLog, 'utf8') }
}

/** A refused release must leave no service behind and no service manager touched. */
function expectNoService(result: Result): void {
  expect(existsSync(serviceFile(result.home))).toBe(false)
  expect(result.log).toBe('')
}

describe('a signed release', { timeout: 300_000 }, () => {
  it('is signed over its manifest, which covers every file', () => {
    expect(existsSync(join(tree, 'manifest.json.sig'))).toBe(true)
    execFileSync('openssl', [
      'dgst', '-sha256', '-verify', publicKey,
      '-signature', join(tree, 'manifest.json.sig'), join(tree, 'manifest.json'),
    ], { stdio: 'pipe' })
  })

  it('installs when the signature matches the key in the installer', () => {
    const result = install(installerWith(publicKey), pack(tree))
    try {
      expect(result.output).toContain('is installed and running')
      const definition = readFileSync(serviceFile(result.home), 'utf8')
      if (onMac) {
        expect(definition).toContain('<string>com.tandem.runtime</string>')
        expect(result.log).toContain('launchctl bootstrap')
      } else {
        expect(definition).toContain('ExecStart=')
        expect(result.log).toContain('systemctl --user enable --now tandem.service')
      }
    } finally { rmSync(result.home, { recursive: true, force: true }) }
  })

  it('is refused when it was signed by somebody else', () => {
    const otherKey = join(workDir, 'other.pub')
    const otherPrivate = join(workDir, 'other.key')
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', otherPrivate], { stdio: 'pipe' })
    execFileSync('openssl', ['ec', '-in', otherPrivate, '-pubout', '-out', otherKey], { stdio: 'pipe' })

    // The archive is intact and its digest matches; it is simply not ours.
    const result = install(installerWith(otherKey), pack(tree))
    try {
      expect(result.ok).toBe(false)
      expect(result.output).toContain('not signed by Tandem')
      expectNoService(result)
    } finally { rmSync(result.home, { recursive: true, force: true }) }
  })

  it('is refused when its contents were changed after it was signed', () => {
    // Kept under the release's own directory name, so this exercises the
    // digest check rather than the installer failing to recognise the tree.
    const tampered = join(mkdtempSync(join(tmpdir(), 'tandem-tamper-')), tree.split('/').pop()!)
    execFileSync('cp', ['-R', tree, tampered], { stdio: 'pipe' })
    writeFileSync(join(tampered, 'runtime', 'src', 'server.ts'), 'console.log("not tandem")\n')

    // The signature still verifies - the manifest was not touched - and the
    // per-file digests are what catch this.
    const result = install(installerWith(publicKey), pack(tampered))
    try {
      expect(result.ok).toBe(false)
      expect(result.output).toContain('do not match its manifest')
      expectNoService(result)
    } finally {
      rmSync(result.home, { recursive: true, force: true })
      rmSync(tampered, { recursive: true, force: true })
    }
  })

  it('is refused when the manifest was rewritten to match changed contents', () => {
    const forged = join(mkdtempSync(join(tmpdir(), 'tandem-forge-')), tree.split('/').pop()!)
    execFileSync('cp', ['-R', tree, forged], { stdio: 'pipe' })
    writeFileSync(join(forged, 'runtime', 'src', 'server.ts'), 'console.log("not tandem")\n')

    // Rebuilt so the digests agree with the new contents. Without a signature
    // this is indistinguishable from a real release.
    execFileSync('sh', ['-c',
      `cd "${forged}" && find . -type f ! -name manifest.json ! -name FILES.sha256 ! -name manifest.json.sig -exec shasum -a 256 {} + | ` +
      'sed "s|^\\([0-9a-f]*\\)  \\./|\\1  |" | LC_ALL=C sort -k 2 > FILES.sha256',
    ], { stdio: 'pipe' })

    const result = install(installerWith(publicKey), pack(forged))
    try {
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/not signed by Tandem|do not match its manifest/)
      expectNoService(result)
    } finally {
      rmSync(result.home, { recursive: true, force: true })
      rmSync(forged, { recursive: true, force: true })
    }
  })

  it('refuses a downloaded release that carries no signature at all', () => {
    const unsigned = join(mkdtempSync(join(tmpdir(), 'tandem-unsigned-')), tree.split('/').pop()!)
    execFileSync('cp', ['-R', tree, unsigned], { stdio: 'pipe' })
    rmSync(join(unsigned, 'manifest.json.sig'), { force: true })

    // Served under the exact name the installer fetches, so this reaches the
    // signature check rather than failing on a missing file - which is what
    // the first version of this test actually measured.
    const served = mkdtempSync(join(tmpdir(), 'tandem-served-'))
    const platform = `${process.platform}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}`
    const name = `tandem-latest-${platform}.tar.gz`
    execFileSync('tar', ['-czf', join(served, name), '-C', dirname(unsigned), unsigned.split('/').pop()!], { stdio: 'pipe' })
    execFileSync('sh', ['-c', `shasum -a 256 "${join(served, name)}" > "${join(served, name)}.sha256"`], { stdio: 'pipe' })

    const result = install(installerWith(publicKey), '', { TANDEM_BASE_URL: `file://${served}` })
    try {
      expect(result.ok, 'an unsigned download was installed').toBe(false)
      // Stripping the signature must be refused as a missing signature, not as
      // a download that could not be found.
      expect(result.output).toContain('carries no signature')
      expectNoService(result)
    } finally {
      rmSync(result.home, { recursive: true, force: true })
      rmSync(served, { recursive: true, force: true })
      rmSync(unsigned, { recursive: true, force: true })
    }
  })

  it('refuses a signed release that has had a file added to it', () => {
    // Nothing existing is changed, so the signature verifies and every listed
    // digest matches. Node resolves a bare import from the importing file's
    // directory upward, so an added node_modules shadows the real dependency
    // and runs as the owner at every boot.
    const injected = join(mkdtempSync(join(tmpdir(), 'tandem-inject-')), tree.split('/').pop()!)
    execFileSync('cp', ['-R', tree, injected], { stdio: 'pipe' })
    const shadow = join(injected, 'runtime', 'src', 'node_modules', 'zod')
    execFileSync('mkdir', ['-p', shadow], { stdio: 'pipe' })
    writeFileSync(join(shadow, 'package.json'), '{"name":"zod","version":"9.9.9","main":"index.js"}\n')
    writeFileSync(join(shadow, 'index.js'), 'module.exports = {}\n')

    const result = install(installerWith(publicKey), pack(injected))
    try {
      expect(result.ok).toBe(false)
      expect(result.output).toContain('do not match the files its manifest lists')
      expectNoService(result)
    } finally {
      rmSync(result.home, { recursive: true, force: true })
      rmSync(injected, { recursive: true, force: true })
    }
  })

  it('refuses a signed release that has had a link added to it', () => {
    // A link is invisible to a file listing and carries the same attack
    // through a different inode type: one at runtime/bridge/node_modules
    // resolves for every bare import from that directory. A real release
    // contains none, so any link here was added afterwards.
    const linked = join(mkdtempSync(join(tmpdir(), 'tandem-link-')), tree.split('/').pop()!)
    execFileSync('cp', ['-R', tree, linked], { stdio: 'pipe' })
    execFileSync('ln', ['-s', '/tmp/attacker-payload', join(linked, 'runtime', 'bridge', 'node_modules')], { stdio: 'pipe' })

    const result = install(installerWith(publicKey), pack(linked))
    try {
      expect(result.ok).toBe(false)
      expect(result.output).toContain('contains a link')
      expectNoService(result)
    } finally {
      rmSync(result.home, { recursive: true, force: true })
      rmSync(linked, { recursive: true, force: true })
    }
  })
})
