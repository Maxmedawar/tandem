/**
 * U-R1A-43: scripts/cutover.sh installs the new build beside the old one (its own service name,
 * home `~/.tandem-next` and computer name) and one command removes it again; the old service, its
 * home and its `tandem` command are never touched.
 *
 * Everything runs in one box (BOX): HOME is BOX/home, so `~` in the scripts is the box, and
 * `launchctl`, `systemctl`, `wrangler` and `fleetbus` are stubs in BOX/stubs that append
 * `<name> <args>` to BOX/stub.log (asserted on PATH before any script runs). The l-cases build a
 * release, install it twice and start two runtimes against a local hub: Linux only, so the real
 * launchd is never in reach on a Mac.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The box, before any repo code is imported.
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a43-')))
const HOME = join(BOX, 'home')
mkdirSync(HOME)
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const STUBS = join(BOX, 'stubs')
const DARWIN = join(BOX, 'stubs-darwin')
const LINUX = join(BOX, 'stubs-linux')
const LOG = join(BOX, 'stub.log')

const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
const CUTOVER = join(repo, 'scripts', 'cutover.sh')
const onLinux = process.platform === 'linux'
const uid = process.getuid!()
const SERVICE_LINE = 'tandem: TANDEM_SERVICE must be a short lower-case name\n'
// tmux's folder too: `limits init` asks tmux whether it runs inside a Tandem session, and without
// tmux on PATH under a tmux-hosted test run it cannot tell and refuses.
const tmuxDir = dirname(spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/tmux')
const PATHS = `${STUBS}:${dirname(process.execPath)}:${tmuxDir}:/usr/bin:/bin`

function stub(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> '${LOG}'\n${body}\nexit 0\n`)
  chmodSync(join(dir, name), 0o755)
}
stub(STUBS, 'launchctl', `if [ "$1" = list ] && [ ! -e '${BOX}/loaded-'"$2" ]; then echo "Could not find service \\"$2\\" in domain for port" >&2; exit 113; fi`)
stub(STUBS, 'systemctl', `if [ "$2" = is-active ] && [ ! -e '${BOX}/loaded-'"$4" ]; then echo inactive; exit 3; fi`)
stub(STUBS, 'wrangler', '')
stub(STUBS, 'fleetbus', '')
stub(DARWIN, 'uname', 'case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac')
stub(LINUX, 'uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac')
writeFileSync(LOG, '')

let archive = ''

beforeAll(() => {
  const out = join(BOX, 'release')
  mkdirSync(out)
  const built = spawnSync('sh', [join(repo, 'packaging', 'build-release.sh'), out], { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`build-release failed:\n${built.stderr}`)
  archive = join(out, readdirSync(out).find((name) => name.endsWith('.tar.gz'))!)
}, 900_000)

afterAll(() => {
  spawnSync('chmod', ['-R', 'u+w', BOX])
  rmSync(BOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** The env every script gets: no inherited TANDEM_* or CCM_*, HOME the box, the stubs first. */
function env(extra: Record<string, string> = {}, shape: 'host' | 'darwin' | 'linux' = 'host'): NodeJS.ProcessEnv {
  const path = shape === 'darwin' ? `${DARWIN}:${PATHS}` : shape === 'linux' ? `${LINUX}:${PATHS}` : PATHS
  return { HOME, PATH: path, TMPDIR: tmpdir(), TMUX_TMPDIR: BOX, USER: userInfo().username, LOGNAME: userInfo().username, ...extra }
}

/** Throws before anything runs unless launchctl and systemctl resolve to the stubs under `e`. */
function assertStubs(e: NodeJS.ProcessEnv): void {
  const found = spawnSync('sh', ['-c', 'command -v launchctl; command -v systemctl'], { env: e, encoding: 'utf8' }).stdout
  if (found !== `${join(STUBS, 'launchctl')}\n${join(STUBS, 'systemctl')}\n`) throw new Error(`service managers are not the stubs: ${found}`)
}

interface Ran { status: number | null; stdout: string; stderr: string }
function sh(script: string, args: string[], e: NodeJS.ProcessEnv): Ran {
  assertStubs(e)
  const r = spawnSync('sh', [script, ...args], { cwd: repo, env: e, encoding: 'utf8', input: '' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
const cutover = (args: string[], e: NodeJS.ProcessEnv = env()) => sh(CUTOVER, args, e)
const packaging = (name: string, args: string[], e: NodeJS.ProcessEnv) => sh(join(repo, 'packaging', name), args, e)

/** Every path under the box with its size and mtime: equal listings = nothing written. */
function listing(root = BOX): string[] {
  const out: string[] = []
  const walk = (p: string) => {
    const st = lstatSync(p)
    out.push(`${p} ${st.size} ${st.mtimeMs}`)
    if (st.isDirectory()) for (const name of readdirSync(p).sort()) walk(join(p, name))
  }
  walk(root)
  return out
}
const stubLog = () => readFileSync(LOG, 'utf8')

/** An empty box home and an empty stub log. */
function resetHome(): void {
  spawnSync('chmod', ['-R', 'u+w', HOME])
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME)
  writeFileSync(LOG, '')
}

/** The old install as the d-cases see it: a `current` folder and the `tandem` link into it. */
function oldInstall(): void {
  mkdirSync(join(HOME, '.tandem', 'current', 'bin'), { recursive: true })
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true })
  symlinkSync(join(HOME, '.tandem', 'current', 'bin', 'tandem'), join(HOME, '.local', 'bin', 'tandem'))
}

function hostSlug(): string {
  const raw = spawnSync('sh', ['-c', 'hostname -s 2>/dev/null || uname -n'], { env: env(), encoding: 'utf8' }).stdout.trim()
  return raw.split('.')[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 58)
}
function checkoutSha(): string {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { env: env(), encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

function tokenFile(text: string, mode = 0o600): string {
  const file = join(BOX, `token-${text.length}-${mode.toString(8)}`)
  writeFileSync(file, text)
  chmodSync(file, mode)
  return file
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const newSvc = (darwin: boolean) => (darwin ? 'com.tandem-next.runtime' : 'tandem-next.service')
const oldSvc = (darwin: boolean) => (darwin ? 'com.tandem.runtime' : 'tandem.service')
const svcFile = (darwin: boolean, home: string) =>
  darwin ? join(home, 'agents', 'com.tandem-next.runtime.plist') : join(HOME, '.config', 'systemd', 'user', 'tandem-next.service')

describe('(43) d: dry run and refusals', { timeout: 60_000 }, () => {
  const darwin = !onLinux

  it('(43) d1 dry run prints what it would do and writes nothing', () => {
    resetHome()
    oldInstall()
    const before = listing()
    const r = cutover(['install', '--dry-run'])
    const next = join(HOME, '.tandem-next')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe([
      `cutover: home ${next}`,
      `cutover: service tandem-next (${newSvc(darwin)})`,
      `cutover: computer ${hostSlug()}-next`,
      'cutover: port 8797',
      'cutover: hub none',
      'cutover: limits 0 folder(s), 0 agent(s)',
      `cutover: old: installed (${oldSvc(darwin)}); not touched`,
      `cutover: would build a release from ${repo} at ${checkoutSha()}`,
      `cutover: would write ${svcFile(darwin, next)}`,
      `cutover: would start ${newSvc(darwin)}`,
      'cutover: dry run: nothing was changed',
      '',
    ].join('\n'))
    expect(stubLog()).toBe('')
    expect(listing()).toEqual(before)
    expect(existsSync(next)).toBe(false)
  })

  const refusals: [string, () => { args: string[]; line: string }][] = [
    ['home ~/.tandem', () => ({ args: ['--home', join(HOME, '.tandem')], line: `home ${HOME}/.tandem is the old Tandem home or inside it` })],
    ['home ~/.tandem/ with a trailing slash', () => ({ args: ['--home', `${HOME}/.tandem/`], line: `home ${HOME}/.tandem is the old Tandem home or inside it` })],
    ['home ~/.TANDEM', () => ({ args: ['--home', join(HOME, '.TANDEM')], line: `home ${HOME}/.TANDEM is the old Tandem home or inside it` })],
    ['home a link to ~/.tandem', () => {
      symlinkSync(join(HOME, '.tandem'), join(HOME, 'link'))
      return { args: ['--home', join(HOME, 'link')], line: `home ${HOME}/link is the old Tandem home or inside it` }
    }],
    ['home a folder inside ~/.tandem', () => ({ args: ['--home', join(HOME, '.tandem', 'next')], line: `home ${HOME}/.tandem/next is the old Tandem home or inside it` })],
    ['a foreign existing home without .cutover', () => {
      mkdirSync(join(HOME, '.tandem-next'))
      writeFileSync(join(HOME, '.tandem-next', 'someone'), 'x')
      return { args: [], line: `home ${HOME}/.tandem-next exists and was not made by cutover` }
    }],
    ['a bad computer name', () => ({ args: ['--name', 'Bad_Name'], line: 'computer name Bad_Name must be lower-case letters, digits and -, 1 to 63 characters' })],
    ['the hostname as computer name', () => ({ args: ['--name', hostSlug()], line: `computer name ${hostSlug()} is this computer's own name; the old install uses it` })],
    ['port 80', () => ({ args: ['--port', '80'], line: 'port 80 must be a number from 1024 to 65535' })],
    ['a hub URL without a token file', () => ({ args: ['--hub-url', 'https://hub.example.com'], line: '--hub-url needs --hub-token-file' })],
    ['a token file without a hub URL', () => ({ args: ['--hub-token-file', tokenFile('a'.repeat(32))], line: '--hub-token-file needs --hub-url' })],
    ['http://example.com', () => ({
      args: ['--hub-url', 'http://example.com', '--hub-token-file', tokenFile('a'.repeat(32))],
      line: 'hub URL must be https://<host> or http://127.0.0.1:<port> or http://localhost:<port>',
    })],
    ['a token file of mode 0644', () => {
      const file = tokenFile('b'.repeat(32), 0o644)
      return { args: ['--hub-url', 'https://hub.example.com', '--hub-token-file', file], line: `token file ${file} must be a regular file of mode 0600 owned by you` }
    }],
    ['a 15-character token', () => {
      const file = tokenFile('c'.repeat(15) + '\n')
      return { args: ['--hub-url', 'https://hub.example.com', '--hub-token-file', file], line: `token file ${file} must hold 16 to 512 characters of A-Z a-z 0-9 . _ ~ + / = -` }
    }],
  ]
  for (const [what, setup] of refusals) {
    it(`(43) d2 refuses ${what}: rc 1, one line, nothing written`, () => {
      resetHome()
      oldInstall()
      const { args, line } = setup()
      const before = listing()
      const r = cutover(['install', '--no-start', '--archive', join(BOX, 'absent.tar.gz'), ...args])
      expect(r.stderr).toBe(`cutover: ${line}\n`)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(listing()).toEqual(before)
      expect(stubLog()).toBe('')
    })
  }

  it('(43) d2 refuses the account home\'s ~/.tandem before any file call on it', () => {
    resetHome()
    const live = join(userInfo().homedir, '.tandem')
    const existed = existsSync(live)
    const before = listing()
    const r = cutover(['install', '--no-start', '--archive', join(BOX, 'absent.tar.gz'), '--home', live])
    expect(r.stderr).toBe(`cutover: home ${live} is the old Tandem home or inside it\n`)
    expect(r.status).toBe(1)
    expect(existsSync(live)).toBe(existed)
    expect(listing()).toEqual(before)
    expect(stubLog()).toBe('')
  })

  it('(43) d2 refuses a port something listens on', async () => {
    resetHome()
    const server: Server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = String((server.address() as { port: number }).port)
    try {
      const before = listing()
      const r = cutover(['install', '--no-start', '--archive', join(BOX, 'absent.tar.gz'), '--port', port])
      expect(r.stderr).toBe(`cutover: port ${port} is in use on 127.0.0.1\n`)
      expect(r.status).toBe(1)
      expect(listing()).toEqual(before)
      expect(stubLog()).toBe('')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('(43) d3 an unknown subcommand or option is rc 2', () => {
    resetHome()
    const before = listing()
    for (const args of [['frobnicate'], ['install', '--bogus'], ['rollback', '--bogus'], ['status', '--bogus'], []]) {
      const r = cutover(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stderr).toMatch(/^usage: /)
    }
    expect(listing()).toEqual(before)
    expect(stubLog()).toBe('')
  })

  it('(43) d4 rollback refuses a home without .cutover and says so for an absent one', () => {
    resetHome()
    const next = join(HOME, '.tandem-next')
    mkdirSync(join(next, 'versions'), { recursive: true })
    writeFileSync(join(next, 'tandem.env'), 'X=1\n')
    const before = listing()
    const r = cutover(['rollback'])
    expect(r.stderr).toBe(`cutover: ${next} was not made by cutover; nothing removed\n`)
    expect(r.status).toBe(1)
    expect(listing()).toEqual(before)
    expect(stubLog()).toBe('')

    resetHome()
    const gone = cutover(['rollback'])
    expect(gone.stdout).toBe('cutover: nothing to roll back\n')
    expect(gone.status).toBe(0)
  })
})

describe('(43) m: the macOS shape', { timeout: 300_000 }, () => {
  it('(43) m1 the dry run names the next label and its plist', () => {
    resetHome()
    const next = join(HOME, '.tandem-next')
    const r = cutover(['install', '--dry-run', '--port', '18797'], env({}, 'darwin'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('cutover: service tandem-next (com.tandem-next.runtime)\n')
    expect(r.stdout).toContain(`cutover: would write ${next}/agents/com.tandem-next.runtime.plist\n`)
    expect(r.stdout).toContain('cutover: old: not found; not touched\n')
    expect(existsSync(next)).toBe(false)
  })

  it('(43) m2 install.sh with TANDEM_SERVICE=tandem-next uses its own label and leaves the tandem command alone', () => {
    resetHome()
    const next = join(HOME, '.tandem-next')
    const r = packaging('install.sh', [], env({
      TANDEM_HOME: next, TANDEM_SERVICE: 'tandem-next', TANDEM_ARCHIVE: archive, TANDEM_NO_START: '1', TANDEM_NO_LIMITS: '1', TANDEM_PORT: '18797',
    }, 'darwin'))
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const plist = readFileSync(join(next, 'agents', 'com.tandem-next.runtime.plist'), 'utf8')
    expect(plist).toContain('<key>Label</key><string>com.tandem-next.runtime</string>')
    expect(plist).toContain('<key>TANDEM_SERVICE</key><string>tandem-next</string>')
    const log = stubLog()
    expect(log).toContain(`launchctl bootout gui/${uid}/com.tandem-next.runtime\n`)
    expect(log).not.toContain('com.tandem.runtime')
    expect(existsSync(join(HOME, '.local', 'bin', 'tandem'))).toBe(false)
    expect(r.stdout).toContain(`run it as: TANDEM_HOME=${next} ${next}/current/bin/tandem <command>`)
  })

  it('(43) m3 the launcher takes TANDEM_SERVICE from tandem.env for stop', () => {
    resetHome()
    const next = join(HOME, '.tandem-next')
    mkdirSync(next)
    writeFileSync(join(next, 'tandem.env'), "TANDEM_SERVICE='tandem-next'\n")
    const r = packaging('tandem', ['stop'], env({ TANDEM_HOME: next }, 'darwin'))
    expect(r.status).toBe(0)
    const service = stubLog().split('\n').filter((line) => line && !line.startsWith('uname '))
    expect(service).toEqual([`launchctl bootout gui/${uid}/com.tandem-next.runtime`])
  })
})

describe('(43) p: packaging', { timeout: 300_000 }, () => {
  for (const shape of ['darwin', 'linux'] as const) {
    it(`(43) p1 with TANDEM_SERVICE unset the ${shape} install keeps today's names and the tandem link`, () => {
      resetHome()
      const state = join(HOME, '.tandem')
      const r = packaging('install.sh', [], env({ TANDEM_HOME: state, TANDEM_ARCHIVE: archive, TANDEM_NO_START: '1', TANDEM_NO_LIMITS: '1', TANDEM_PORT: '18797' }, shape))
      expect(r.status).toBe(0)
      if (shape === 'darwin') {
        const plist = readFileSync(join(state, 'agents', 'com.tandem.runtime.plist'), 'utf8')
        expect(plist).toContain('<key>Label</key><string>com.tandem.runtime</string>')
        expect(plist).toContain(`<dict><key>TANDEM_HOME</key><string>${state}</string></dict>`)
        expect(stubLog()).toContain(`launchctl bootout gui/${uid}/com.tandem.runtime\n`)
      } else {
        const unit = readFileSync(join(HOME, '.config', 'systemd', 'user', 'tandem.service'), 'utf8')
        expect(unit).toContain(`Environment="TANDEM_HOME=${state}"\n`)
        expect(stubLog()).toContain('systemctl --user stop tandem.service\n')
      }
      expect(readlinkSync(join(HOME, '.local', 'bin', 'tandem'))).toBe(join(state, 'current', 'bin', 'tandem'))
    })
  }

  it('(43) p2 a bad TANDEM_SERVICE stops install.sh, uninstall.sh and the launcher\'s start before anything', () => {
    for (const value of ['tandem;x', '../x', 'Tandem', '', 'a'.repeat(32)]) {
      resetHome()
      const state = join(HOME, '.tandem-x')
      const before = listing()
      const runs = [
        packaging('install.sh', [], env({ TANDEM_HOME: state, TANDEM_SERVICE: value, TANDEM_ARCHIVE: archive, TANDEM_NO_START: '1', TANDEM_NO_LIMITS: '1', TANDEM_PORT: '18797' }, 'darwin')),
        packaging('uninstall.sh', [], env({ TANDEM_HOME: state, TANDEM_SERVICE: value }, 'darwin')),
        packaging('tandem', ['start'], env({ TANDEM_HOME: state, TANDEM_SERVICE: value }, 'darwin')),
      ]
      for (const r of runs) {
        expect(r.stderr, JSON.stringify(value)).toBe(SERVICE_LINE)
        expect(r.status, JSON.stringify(value)).toBe(1)
      }
      expect(stubLog()).toBe('')
      expect(listing()).toEqual(before)
    }
  })

  it('(43) p3 TANDEM_NO_LIMITS=1 leaves the limits to the caller', () => {
    resetHome()
    const state = join(HOME, '.tandem-next')
    const r = packaging('install.sh', [], env({ TANDEM_HOME: state, TANDEM_SERVICE: 'tandem-next', TANDEM_ARCHIVE: archive, TANDEM_NO_START: '1', TANDEM_NO_LIMITS: '1', TANDEM_PORT: '18797' }))
    expect(r.status).toBe(0)
    expect(existsSync(join(state, 'current', 'bin', 'tandem'))).toBe(true)
    expect(existsSync(join(state, 'limits.toml'))).toBe(false)
    expect(existsSync(join(state, 'limits.applied.toml'))).toBe(false)
  })
})

describe('(43) c: docs/CUTOVER.md', { timeout: 60_000 }, () => {
  const doc = () => readFileSync(join(repo, 'docs', 'CUTOVER.md'), 'utf8')
  /** The text of `## <name>` up to the next `## `. */
  const section = (name: string) => {
    const text = doc()
    const start = text.indexOf(`\n## ${name}\n`)
    if (start < 0) throw new Error(`no section ${name}`)
    const end = text.indexOf('\n## ', start + 1)
    return text.slice(start, end < 0 ? undefined : end)
  }

  it('(43) c1 the sections are Before you start, mini, macbook, mini2, Known limits', () => {
    const headings = doc().split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3))
    expect(headings).toEqual(['Before you start', 'mini', 'macbook', 'mini2', 'Known limits'])
  })

  for (const machine of ['mini', 'macbook', 'mini2']) {
    it(`(43) c2 the ${machine} section's cutover commands parse and pass the refusals`, () => {
      resetHome()
      const blocks = [...section(machine).matchAll(/```sh\n([\s\S]*?)```/g)]
      expect(blocks).toHaveLength(1)
      const lines = blocks[0]![1]!.split('\n').filter((line) => line.includes('scripts/cutover.sh'))
      expect(lines.length).toBeGreaterThanOrEqual(3)
      mkdirSync(join(BOX, 'work'), { recursive: true })
      const token = tokenFile('d'.repeat(40))
      for (const line of lines) {
        const filled = line.trim()
          .replaceAll('<NEW HUB URL>', 'https://hub.example.com')
          .replaceAll('<TOKEN FILE>', token)
          .replaceAll('<FOLDER>', join(BOX, 'work'))
          .replaceAll('<AGENT>', 'shell')
        expect(filled, line).not.toMatch(/[<>~$]/)
        const words = filled.split(/\s+/)
        expect(words.slice(0, 2)).toEqual(['sh', 'scripts/cutover.sh'])
        const args = words.slice(2)
        if (args[0] === 'install' && !args.includes('--dry-run')) args.splice(1, 0, '--dry-run')
        const r = cutover(args)
        expect(r.stderr, filled).toBe('')
        expect(r.status, filled).toBe(0)
      }
      expect(existsSync(join(HOME, '.tandem-next'))).toBe(false)
    })
  }

  it('(43) c3 the mini section names the store path the code uses, A5.2 and A11.5', async () => {
    const x = join(BOX, 'x')
    const { createLocalFabricHost } = await import('../bridge/fabric/local-fabric-host.ts')
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', TANDEM_HOME: x })
    host!.close()
    const store = join(x, 'fabric', 'fabric.sqlite3')
    expect(existsSync(store)).toBe(true)
    const mini = section('mini')
    expect(mini).toContain(store.replace(x, '~/.tandem-next'))
    expect(mini).toContain('A5.2')
    expect(mini).toContain('A11.5')
  })
})

describe.runIf(onLinux)('(43) l: lifecycle beside an old install, one local hub (Linux)', { timeout: 300_000 }, () => {
  type Harness = typeof import('./e2e/hub-harness.ts')
  let harness: Harness
  let client: { close(): Promise<void>; callTool(...a: unknown[]): Promise<unknown> } | undefined
  const old = join(HOME, '.tandem')
  const next = join(HOME, '.tandem-next')
  const oldStore = join(old, 'fabric', 'fabric.sqlite3')
  const nextStore = join(next, 'fabric', 'fabric.sqlite3')
  const oldUnit = join(HOME, '.config', 'systemd', 'user', 'tandem.service')
  const nextUnit = join(HOME, '.config', 'systemd', 'user', 'tandem-next.service')
  const runtimes: Record<'old' | 'next', { child: ChildProcess; stderr: string } | undefined> = { old: undefined, next: undefined }
  let snapshot = ''
  let token = ''
  let nextArgs: string[] = []

  /** The operator's own settings a runtime needs to start (cutover does not manage them; CUTOVER.md adds them). */
  const operator = (id: string) => [
    `TANDEM_PUBLIC_URL='https://${id}.example/mcp'`,
    `TANDEM_OWNER_PASSWORD='${harness.rand(32)}'`,
    "CCM_FABRIC_ENABLED='1'",
  ]

  function start(which: 'old' | 'next', home: string, extra: Record<string, string> = {}): Promise<void> {
    const child = spawn(join(home, 'current', 'bin', 'tandem'), ['run'], {
      env: { TANDEM_HOME: home, HOME, PATH: PATHS, TMUX_TMPDIR: BOX, ...extra },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const run = { child, stderr: '' }
    runtimes[which] = run
    child.stdout!.on('data', () => {})
    child.stderr!.on('data', (chunk: Buffer) => { run.stderr += chunk.toString() })
    return new Promise((resolve, reject) => {
      const end = Date.now() + 30_000
      const tick = () => {
        if (run.stderr.includes('hub link: connected')) return resolve()
        if (child.exitCode !== null || Date.now() > end) return reject(new Error(`${which} did not connect:\n${run.stderr}`))
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  async function stop(which: 'old' | 'next'): Promise<void> {
    const child = runtimes[which]?.child
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
  }

  async function connected(): Promise<string[]> {
    const result = await client!.callTool({ name: 'list_machines', arguments: {} }) as { content?: { text?: string }[] }
    const parsed = JSON.parse(result.content?.[0]?.text ?? '{}') as { connected?: string[] }
    return [...(parsed.connected ?? [])].sort()
  }
  async function until(check: (list: string[]) => boolean): Promise<string[]> {
    const end = Date.now() + 30_000
    let list = await connected()
    while (!check(list) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      list = await connected()
    }
    return list
  }

  function files(root: string): string[] {
    if (!existsSync(root)) return []
    const st = lstatSync(root)
    if (st.isSymbolicLink()) return [`${root} -> ${readlinkSync(root)}`]
    if (st.isDirectory()) return readdirSync(root).sort().flatMap((name) => files(join(root, name)))
    return [`${root} ${createHash('sha256').update(readFileSync(root)).digest('hex')}`]
  }
  const oldSnapshot = () => JSON.stringify([
    files(join(old, 'versions')),
    realpathSync(join(old, 'current')),
    files(join(old, 'tandem.env')),
    files(oldUnit),
    readlinkSync(join(HOME, '.local', 'bin', 'tandem')),
    statSync(oldStore).size,
  ])
  const alive = (child: ChildProcess | undefined) => {
    try { process.kill(child!.pid!, 0); return child!.exitCode === null } catch { return false }
  }

  beforeAll(async () => {
    harness = await import('./e2e/hub-harness.ts')
    if (harness.missing) throw new Error(`the l-cases need ${harness.missing}`)
    resetHome()
    await harness.startHub(`${BOX}/hub-`)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const access = await harness.signIn()
    const c = new Client({ name: 'r1a43', version: '0.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(`${harness.hub}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }))
    client = c as unknown as typeof client
  }, 180_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await stop('next')
    await stop('old')
    await harness?.stopHub()
    const walk = (p: string) => {
      let st
      try { st = lstatSync(p) } catch { return }
      if (st.isSocket()) spawnSync('tmux', ['-S', p, 'kill-server'], { stdio: 'ignore' })
      else if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name))
    }
    walk(BOX)
  }, 60_000)

  it('(43) l1 the old release installed with the defaults connects to the hub', async () => {
    const r = packaging('install.sh', [], env({ TANDEM_HOME: old, TANDEM_ARCHIVE: archive, TANDEM_NO_START: '1', TANDEM_NO_LIMITS: '1', TANDEM_PORT: '0' }))
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(oldUnit)).toBe(true)
    writeFileSync(join(old, 'tandem.env'), [
      `TANDEM_HUB_LINK_URL='${harness.hub.replace(/^http/, 'ws')}'`,
      `TANDEM_HUB_LINK_TOKEN='${harness.LINK_TOKEN}'`,
      "TANDEM_HUB_LINK_ID='r1a43-old'",
      `TANDEM_PORT='${await freePort()}'`,
      ...operator('r1a43-old'),
      '',
    ].join('\n'), { mode: 0o600 })
    await start('old', old)
    expect(await until((l) => l.includes('r1a43-old'))).toContain('r1a43-old')
    snapshot = oldSnapshot()
  })

  it('(43) l2 cutover install puts the next build beside it', async () => {
    token = harness.LINK_TOKEN
    const tokenPath = join(BOX, 'token')
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
    mkdirSync(join(BOX, 'work'), { recursive: true })
    const port = String(await freePort())
    nextArgs = ['install', '--archive', archive, '--name', 'r1a43-next', '--port', port, '--hub-url', harness.hub,
      '--hub-token-file', tokenPath, '--folder', join(BOX, 'work'), '--agent', 'shell']
    writeFileSync(LOG, '')
    const r = cutover(nextArgs, env({ CCM_FABRIC_DB_PATH: oldStore }))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe([
      `cutover: home ${next}`,
      'cutover: service tandem-next (tandem-next.service)',
      'cutover: computer r1a43-next',
      `cutover: port ${port}`,
      `cutover: hub ${harness.hub}`,
      'cutover: limits 1 folder(s), 1 agent(s)',
      'cutover: old: installed (tandem.service); not touched',
      'cutover: installed',
      '',
    ].join('\n'))
    expect(statSync(next).mode & 0o777).toBe(0o700)
    expect(existsSync(join(next, '.cutover'))).toBe(true)
    expect(existsSync(join(next, 'current', 'bin', 'tandem'))).toBe(true)
    expect(statSync(join(next, 'tandem.env')).mode & 0o777).toBe(0o600)
    const envText = readFileSync(join(next, 'tandem.env'), 'utf8')
    expect(envText).toBe([
      "TANDEM_SERVICE='tandem-next'",
      "TANDEM_HUB_LINK_ID='r1a43-next'",
      `TANDEM_PORT='${port}'`,
      `CCM_FABRIC_DB_PATH='${nextStore}'`,
      `TANDEM_HUB_LINK_URL='${harness.hub.replace(/^http/, 'ws')}'`,
      `TANDEM_HUB_LINK_TOKEN='${token}'`,
      '',
    ].join('\n'))
    const limits = readFileSync(join(next, 'limits.toml'))
    expect(readFileSync(join(next, 'limits.applied.toml')).equals(limits)).toBe(true)
    for (const f of ['limits.toml', 'limits.applied.toml']) expect(statSync(join(next, f)).mode & 0o777).toBe(0o600)
    expect(limits.toString()).toContain(join(BOX, 'work'))
    expect(limits.toString()).toContain('shell')
    expect(readFileSync(nextUnit, 'utf8')).toContain('"TANDEM_SERVICE=tandem-next"')
    const log = stubLog()
    expect(log).toContain('systemctl --user start tandem-next.service\n')
    for (const line of log.split('\n')) {
      expect(line).not.toMatch(/(^|[^-\w])tandem\.service/)
      expect(line).not.toContain('com.tandem.runtime')
      expect(line).not.toContain(token)
    }
    expect(r.stdout + r.stderr).not.toContain(token)
  })

  it('(43) l2b a second install without rollback is refused and changes nothing', () => {
    const before = listing(next)
    const log = stubLog()
    const r = cutover(nextArgs)
    expect(r.stderr).toBe('cutover: already installed: run rollback first\n')
    expect(r.status).toBe(1)
    expect(listing(next)).toEqual(before)
    expect(stubLog()).toBe(log)
  })

  it('(43) l3 both connect to the hub', async () => {
    // The operator's settings, as CUTOVER.md has them added before the first start.
    writeFileSync(join(next, 'tandem.env'), `${readFileSync(join(next, 'tandem.env'), 'utf8')}${operator('r1a43-next').join('\n')}\n`)
    await start('next', next, { CCM_FABRIC_DB_PATH: oldStore })
    const list = await until((l) => l.includes('r1a43-old') && l.includes('r1a43-next'))
    expect(list).toContain('r1a43-old')
    expect(list).toContain('r1a43-next')
  })

  it('(43) l4 the old install is untouched and the next store is its own', () => {
    expect(oldSnapshot()).toBe(snapshot)
    expect(alive(runtimes.old?.child)).toBe(true)
    const grep = spawnSync('grep', ['-r', '-l', '-F', 'r1a43-next', old], { encoding: 'utf8' })
    expect(grep.stdout).toBe('')
    expect(existsSync(nextStore)).toBe(true)
  })

  it('(43) l5 status names both and never the token', () => {
    const r = cutover(['status'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^cutover: old tandem\.service: /m)
    expect(r.stdout).toContain(`cutover: next ${next}: installed `)
    expect(r.stdout).toContain('computer r1a43-next')
    expect(r.stdout + r.stderr).not.toContain(token)
  })

  it('(43) l6 rollback removes the next service and program, keeps its data; the old stays connected', async () => {
    const r = cutover(['rollback'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`cutover: removed; data kept in ${next} (add --purge to remove it)\n`)
    expect(stubLog()).toContain('systemctl --user disable --now tandem-next.service\n')
    for (const gone of [nextUnit, join(next, 'versions'), join(next, 'current'), join(next, 'run'), join(next, 'agents'), join(next, 'tandem.env')]) {
      expect(existsSync(gone), gone).toBe(false)
    }
    expect(existsSync(nextStore)).toBe(true)
    // systemd is a stub here: the test stops the next runtime by its own process group.
    await stop('next')
    const list = await until((l) => !l.includes('r1a43-next'))
    expect(list).not.toContain('r1a43-next')
    expect(list).toContain('r1a43-old')
    expect(oldSnapshot()).toBe(snapshot)
    expect(alive(runtimes.old?.child)).toBe(true)
  })

  it('(43) l7 rollback --purge removes the next home; again is nothing to roll back', () => {
    const r = cutover(['rollback', '--purge'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`cutover: removed ${next}\n`)
    expect(existsSync(next)).toBe(false)
    const again = cutover(['rollback'])
    expect(again.stdout).toBe('cutover: nothing to roll back\n')
    expect(again.status).toBe(0)
    expect(oldSnapshot()).toBe(snapshot)
  })
})
