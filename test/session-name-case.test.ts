/**
 * U-R1A-27B: a new session name that differs only in case from an open one is refused where
 * sessions are opened (bridge/router.ts handleOpen), so two sessions never share a delivery or
 * transcript file on a case-insensitive disk. The exact same name still reuses as before.
 *
 * tmux runs only on a private socket: before any import TMUX is unset and TMUX_TMPDIR is a new
 * r1a27b- folder; HOME and TANDEM_HOME live in it too. afterAll kills that folder's tmux servers
 * (after `test -S`) and removes it. The agent is an owner harness file (delivery hook) over
 * test/fixtures/fake-cli.sh, enabled through TANDEM_ENABLED_ENGINES and the limits file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.sh', import.meta.url))
const BOX = mkdtempSync(join(tmpdir(), 'r1a27b-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
const OWNER = join(TH, 'harnesses')
mkdirSync(HOME)
mkdirSync(WORK)
mkdirSync(OWNER, { recursive: true })
chmodSync(OWNER, 0o700)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CCM_CWD_ALLOWLIST = WORK
process.env.TANDEM_WAIT_MS = '8000'
const ENGINE = 'r1a27b-fake'
process.env.TANDEM_ENABLED_ENGINES = ENGINE
process.env.PATH = `/usr/bin:/bin:${process.env.PATH ?? ''}`
writeFileSync(join(OWNER, `${ENGINE}.toml`), `name = "${ENGINE}"\nprogram = "${FAKE}"\nhas_prompts = true\ndelivery = "hook"\nhook = "--settings"\n[states]\nworking = ['^fake is thinking\\z']\nidle = ['^fake>\\z']\nwaiting_for_approval = ['\\(y/n\\)\\z']\ndebounce_ms = 300\n`, { mode: 0o600 })

const { route } = await import('../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../bridge/engine-registry.ts')
const { applyLimits } = await import('../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('./fixtures/limits.ts')
const { unregisterLive } = await import('../bridge/sessions.ts')
const { TerminalSession } = await import('../bridge/terminal-session.ts')
const { harnessDescriptor } = await import('../bridge/engines/harness-engine.ts')

const SOCK = join(TH, 'tmux', 'tandem')

beforeAll(() => {
  resetHarnessCache()
  const h = loadedHarnesses().get(ENGINE)
  if (!h) throw new Error('the fake harness file did not load')
  writeLimits(TH, { folders: [WORK], agents: { [ENGINE]: agentEntry(h) } })
  applyLimits()
})

afterAll(() => {
  const uid = process.getuid!()
  for (const sock of [join(BOX, `tmux-${uid}`, 'default'), SOCK]) {
    if (spawnSync('test', ['-S', sock]).status === 0) spawnSync('tmux', ['-S', sock, 'kill-server'])
  }
  rmSync(BOX, { recursive: true, force: true })
})

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })
const open = (name: string) => rq('POST', '/sessions/open', { engine: ENGINE, name, cwd: WORK })
const close = (name: string) => rq('POST', `/sessions/${name}/close`)
const refusal = (name: string, other: string) => ({
  status: 409,
  body: { error: `session name "${name}" differs only in case from session "${other}"; use another name` },
})

function tmuxNames(): string[] {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const auditLog = join(HOME, '.tandem', 'bridge.log')
const caseLines = () =>
  (existsSync(auditLog) ? readFileSync(auditLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((l: Record<string, unknown>) => l.denied === 'name-case')
/** Files under <TANDEM_HOME>/delivery whose name starts `<name>.`, compared exactly (the folder keeps each file's own case). */
const deliveryFiles = (name: string) => {
  const dir = join(TH, 'delivery')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.`)) : []
}

describe('(h) open one name, then the same name in another case', () => {
  it('409 naming the open one, one name-case line, no second tmux session, no file; the same name reuses; after close the other opens', async () => {
    const first = await open('r1a27b-Case')
    expect(first.status).toBe(200)
    expect(deliveryFiles('r1a27b-Case').length).toBeGreaterThan(0)
    const before = caseLines().length
    const tmuxBefore = tmuxNames()
    expect(await open('r1a27b-case')).toEqual(refusal('r1a27b-case', 'r1a27b-Case'))
    expect(caseLines().slice(before)).toEqual([
      expect.objectContaining({ route: 'POST /sessions/open', name: 'r1a27b-case', denied: 'name-case' }),
    ])
    expect(tmuxNames()).toEqual(tmuxBefore)
    expect(tmuxNames()).not.toContain('ccm-r1a27b-case')
    expect(deliveryFiles('r1a27b-case')).toEqual([])
    const again = await open('r1a27b-Case')
    expect(again).toMatchObject({ status: 200, body: { name: 'r1a27b-Case', reused: true } })
    expect(await close('r1a27b-Case')).toMatchObject({ status: 200 })
    const other = await open('r1a27b-case')
    expect(other).toMatchObject({ status: 200, body: { name: 'r1a27b-case' } })
    expect(tmuxNames()).toContain('ccm-r1a27b-case')
    expect(tmuxNames()).not.toContain('ccm-r1a27b-Case')
    expect(await close('r1a27b-case')).toMatchObject({ status: 200 })
  }, 60_000)
})

describe('(i) two opens started together', () => {
  it('r1a27b-Two and r1a27b-two: one opens, the other is refused naming it', async () => {
    const names = ['r1a27b-Two', 'r1a27b-two']
    const answers = await Promise.all(names.map((n) => open(n)))
    try {
      const won = answers.findIndex((a) => a.status === 200)
      expect(won).toBeGreaterThanOrEqual(0)
      const lost = 1 - won
      expect(answers[lost]).toEqual(refusal(names[lost]!, names[won]!))
      expect(tmuxNames()).not.toContain(`ccm-${names[lost]}`)
    } finally {
      for (const [k, a] of answers.entries()) if (a.status === 200) await close(names[k]!)
    }
  }, 60_000)
})

describe('(j) a Tandem tmux session this process did not register', () => {
  it('open r1a27b-tmx is refused naming r1a27b-Tmx', async () => {
    const h = loadedHarnesses().get(ENGINE)!
    const left = await TerminalSession.spawn({ name: 'r1a27b-Tmx', cwd: WORK, allowlist: [WORK], descriptor: harnessDescriptor(h) })
    unregisterLive('r1a27b-Tmx')
    try {
      expect(tmuxNames()).toContain('ccm-r1a27b-Tmx')
      expect(await open('r1a27b-tmx')).toEqual(refusal('r1a27b-tmx', 'r1a27b-Tmx'))
      expect(tmuxNames()).not.toContain('ccm-r1a27b-tmx')
    } finally {
      await left.close()
    }
  }, 60_000)
})
