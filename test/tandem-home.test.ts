/**
 * U-R1A-HOMEPATH: every path inside a Tandem home comes from one function, bridge/tandem-home.ts
 * tandemHome(): TANDEM_HOME when it is a non-empty string, else ~/.tandem, worked out at each call.
 * (h) the function, (p) the 8 paths that ignored TANDEM_HOME, (i) inline copies through their
 * exported readers, (g) a guard that finds every other `.tandem` path literal in bridge/, src/ and
 * scripts/, with its negative control. Every folder a case makes is a mkdtemp r1ahomepath- folder
 * under tmpdir(); nothing here writes, reads or stats anything under the real home.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { tandemHome } from '../bridge/tandem-home.ts'
import { audit } from '../bridge/audit.ts'
import { emitCompletion } from '../bridge/events.ts'
import { createLocalFabricHost } from '../bridge/fabric/local-fabric-host.ts'
import { FleetEnrollmentStore } from '../bridge/fleet-enrollment.ts'
import { managerDir } from '../bridge/manager.ts'
import { defaultStateDir, loadOrCreateOwnerId } from '../bridge/ownership.ts'
import { loadOAuthConfig } from '../src/auth-config.ts'
import { controlSocketPath } from '../bridge/control-socket.ts'
import { tmuxSocketPath } from '../bridge/terminal-session.ts'
import { dropDirOf } from '../bridge/usage/claude.ts'

/** Every `.tandem` path derivation under <root>/bridge, <root>/src and <root>/scripts: a string or
 *  template literal whose text, split on `/` and `\`, has a part exactly `.tandem`. Folders are
 *  walked (never git); a missing folder is skipped. Sorted by file, then line. */
function scan(root: string): { file: string; line: number }[] {
  const kinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ])
  const out: { file: string; line: number }[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
          if (kinds.has(node.kind) && (node as ts.LiteralLikeNode).text.split(/[/\\]/).includes('.tandem')) {
            out.push({ file: relative(root, p).split(sep).join('/'), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
          }
          ts.forEachChild(node, visit)
        }
        visit(sf)
      }
    }
  }
  for (const top of ['bridge', 'src', 'scripts']) walk(join(root, top))
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

const boxes: string[] = []
const box = (): string => {
  const b = mkdtempSync(join(tmpdir(), 'r1ahomepath-'))
  boxes.push(b)
  return b
}
afterAll(() => {
  for (const b of boxes) rmSync(b, { recursive: true, force: true })
})

/** Runs fn with TANDEM_HOME set to value (undefined: unset), restoring it in finally. */
async function withTH<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const was = process.env.TANDEM_HOME
  try {
    if (value === undefined) delete process.env.TANDEM_HOME
    else process.env.TANDEM_HOME = value
    return await fn()
  } finally {
    if (was === undefined) delete process.env.TANDEM_HOME
    else process.env.TANDEM_HOME = was
  }
}

const homeTandem = () => join(homedir(), '.tandem')
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('(HOMEPATH) tandemHome()', () => {
  it('(HOMEPATH) h1 TANDEM_HOME=T (absolute) gives T', async () => {
    const t = box()
    expect(await withTH(t, () => tandemHome())).toBe(t)
  })
  it('(HOMEPATH) h2 unset gives resolve(join(homedir(), ".tandem")) under the setup temp HOME', async () => {
    expect(homedir() !== userInfo().homedir, 'HOME is the setup temp HOME').toBe(true)
    expect(await withTH(undefined, () => tandemHome())).toBe(resolve(join(homedir(), '.tandem')))
  })
  it('(HOMEPATH) h3 an empty TANDEM_HOME gives the same as unset', async () => {
    expect(await withTH('', () => tandemHome())).toBe(resolve(join(homedir(), '.tandem')))
  })
  it('(HOMEPATH) h4 a relative TANDEM_HOME is resolved', async () => {
    expect(await withTH('rel/x', () => tandemHome())).toBe(resolve('rel/x'))
  })
  it('(HOMEPATH) h5 an explicit argument wins over the environment', async () => {
    const t = box()
    const d = box()
    expect(await withTH(t, () => tandemHome(d))).toBe(d)
  })
  it('(HOMEPATH) h6 read at each call', async () => {
    const t1 = box()
    const t2 = box()
    const a = await withTH(t1, () => tandemHome())
    const b = await withTH(t2, () => tandemHome())
    expect([a, b]).toEqual([t1, t2])
  })
})

describe('(HOMEPATH) the 8 paths follow TANDEM_HOME', () => {
  it('(HOMEPATH) p1 audit appends to T/bridge.log; an explicit directory D wins', async () => {
    const t = join(box(), 'th')
    const d = join(box(), 'd')
    expect(t).not.toBe(homeTandem())
    await withTH(t, () => {
      audit({ event: 'r1ahomepath-p1' })
      audit({ event: 'r1ahomepath-p1-d' }, { directory: d })
    })
    expect(lines(join(t, 'bridge.log')).map((l) => l.event)).toEqual(['r1ahomepath-p1'])
    expect(lines(join(d, 'bridge.log')).map((l) => l.event)).toEqual(['r1ahomepath-p1-d'])
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p2 emitCompletion appends to T/events.log, and follows a moved TANDEM_HOME (call-time)', async () => {
    const t = join(box(), 'th')
    const t2 = join(box(), 'th2')
    const ev = { type: 'session' as const, id: 'r1ahomepath-p2', cursor: 0, summary: 'x', silent: true }
    await withTH(t, () => emitCompletion(ev))
    await withTH(t2, () => emitCompletion(ev))
    expect(lines(join(t, 'events.log')).map((l) => l.id)).toEqual(['r1ahomepath-p2'])
    expect(lines(join(t2, 'events.log')).map((l) => l.id)).toEqual(['r1ahomepath-p2'])
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p3 the fabric store is T/fabric/fabric.sqlite3; CCM_FABRIC_DB_PATH still comes first', async () => {
    const t = join(box(), 'th')
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', TANDEM_HOME: t })
    host?.close()
    expect(existsSync(join(t, 'fabric', 'fabric.sqlite3'))).toBe(true)
    const t2 = join(box(), 'th')
    const p = join(box(), 'own.sqlite3')
    const own = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', TANDEM_HOME: t2, CCM_FABRIC_DB_PATH: p })
    own?.close()
    expect(existsSync(p)).toBe(true)
    expect(existsSync(join(t2, 'fabric'))).toBe(false)
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p4 FleetEnrollmentStore.open() makes T/fleet/enrollments (0700); open(D) uses D', async () => {
    const t = join(box(), 'th')
    const d = join(box(), 'd')
    await withTH(t, async () => {
      await FleetEnrollmentStore.open()
      await FleetEnrollmentStore.open(d)
    })
    expect(statSync(join(t, 'fleet', 'enrollments')).mode & 0o777).toBe(0o700)
    expect(statSync(d).isDirectory()).toBe(true)
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p5 managerDir follows TANDEM_HOME, moved included', async () => {
    const t = join(box(), 'th')
    const t2 = join(box(), 'th2')
    expect(await withTH(t, () => managerDir('r1ahomepath'))).toBe(join(t, 'manager', 'r1ahomepath'))
    expect(await withTH(t2, () => managerDir('r1ahomepath'))).toBe(join(t2, 'manager', 'r1ahomepath'))
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p6 defaultStateDir() is T; loadOrCreateOwnerId() makes T/owner-id', async () => {
    const t = join(box(), 'th')
    await withTH(t, async () => {
      expect(defaultStateDir()).toBe(t)
      await loadOrCreateOwnerId()
    })
    expect(statSync(join(t, 'owner-id')).isFile()).toBe(true)
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
  it('(HOMEPATH) p7 the OAuth state dir is T/oauth; an explicit stateDir wins', async () => {
    const t = join(box(), 'th')
    const d = join(box(), 'd')
    const input = { publicUrl: 'https://r1ahomepath.example/mcp', ownerPassword: 'r1ahomepath-0123456789' }
    expect((await withTH(t, () => loadOAuthConfig(input))).stateDir).toBe(join(t, 'oauth'))
    expect((await withTH(t, () => loadOAuthConfig({ ...input, stateDir: d }))).stateDir).toBe(resolve(d))
    expect(existsSync(homeTandem()), 'HOME/.tandem made').toBe(false)
  })
})

describe('(HOMEPATH) inline copies, through their exported readers', () => {
  it('(HOMEPATH) i1 controlSocketPath() is T/run/control.sock', async () => {
    const t = box()
    expect(await withTH(t, () => controlSocketPath())).toBe(join(t, 'run', 'control.sock'))
  })
  it('(HOMEPATH) i2 tmuxSocketPath() is T/tmux/tandem; an argument X gives resolve(X)/tmux/tandem', async () => {
    const t = box()
    expect(await withTH(t, () => tmuxSocketPath())).toBe(join(t, 'tmux', 'tandem'))
    expect(await withTH(t, () => tmuxSocketPath('r1ahomepath-x'))).toBe(join(resolve('r1ahomepath-x'), 'tmux', 'tandem'))
  })
  it('(HOMEPATH) i3 dropDirOf("claude") is T/usage/claude', async () => {
    const t = box()
    expect(await withTH(t, () => dropDirOf('claude'))).toBe(join(t, 'usage', 'claude'))
  })
})

describe('(HOMEPATH) guard: one .tandem derivation, one exemption', () => {
  it('(HOMEPATH) g1 the repo scans to exactly the definition and the migration exemption', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(scan(root)).toEqual([
      { file: 'bridge/tandem-home.ts', line: 14 },
      { file: 'scripts/migrate-from-synergy.ts', line: 62 },
    ])
  })
  it('(HOMEPATH) g2 negative control: a planted file gives exactly its three derivations', () => {
    const root = box()
    mkdirSync(join(root, 'bridge'))
    writeFileSync(
      join(root, 'bridge', 'planted.ts'),
      ["join(homedir(), '.tandem')", "'.tandem/relay'", '`${h}/.tandem`', '// ~/.tandem/x', "'.tandem-next'", ''].join('\n'),
    )
    expect(scan(root)).toEqual([
      { file: 'bridge/planted.ts', line: 1 },
      { file: 'bridge/planted.ts', line: 2 },
      { file: 'bridge/planted.ts', line: 3 },
    ])
  })
  it('(HOMEPATH) g3 a folder with no bridge, src or scripts scans to []', () => {
    expect(scan(box())).toEqual([])
  })
})
