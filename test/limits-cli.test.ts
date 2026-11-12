/**
 * U-R1A-48: `tandem limits init` writes the first limits file and applies it; `tandem limits apply`
 * shows what changed and applies it after a typed `yes` at this computer (bridge/limits-cli.ts).
 * The applied limits live in a copy beside the file, limits.applied.toml: every process reads the
 * copy and picks up a new one at its next call, so an edit to limits.toml is used by no process
 * (this one, one started later, an agent's running server) until the owner applies it.
 *
 * Requests go through handleHubRequest as the hub sends them, with the env switches on, so the limits
 * file is the only gate the cases move. Every folder is under one mkdtemp folder /tmp/r1a48-: HOME,
 * TANDEM_HOME (Tandem's own tmux socket), the work folders, and the test's own tmux socket own.sock
 * for the real-terminal rows (never Tandem's). afterAll ends every tmux server whose socket is in
 * that folder, then removes it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { agentEntry, writeLimits } from './fixtures/limits.ts'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(repo, 'bridge', 'limits-cli.ts')
const LIMITS_TS = join(repo, 'bridge', 'limits.ts')
const FAKE = join(repo, 'test', 'fixtures', 'fake-cli.sh')
const BOX = realpathSync(mkdtempSync('/tmp/r1a48-'))
delete process.env.TMUX
delete process.env.TANDEM_CALLER_TOKEN
delete process.env.TANDEM_ALLOW_BYPASS
process.env.TMUX_TMPDIR = BOX
const HOME = join(BOX, 'home')
const TH = join(BOX, 'tandem')
const LIMITS = join(TH, 'limits.toml')
const APPLIED = join(TH, 'limits.applied.toml')
const WORK = join(BOX, 'work')
const SKIP = join(WORK, 'skip')
const OTHER = join(BOX, 'other')
const BIN = join(BOX, 'bin')
const OWN = join(BOX, 'own.sock')
for (const d of [HOME, SKIP, OTHER, BIN]) mkdirSync(d, { recursive: true })
/** fake-b: another fake agent program. fake-bash: a shell (named bash, so its kind is shell) that really runs what is typed (A4.27). */
const FAKE_B = join(BIN, 'fake-b-cli')
const FAKE_BASH = join(BIN, 'bash')
copyFileSync(FAKE, FAKE_B)
chmodSync(FAKE_B, 0o755)
writeFileSync(FAKE_BASH, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 })
const TMUX_BIN = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
/** The PATH a child gets: tmux (offRefusal asks Tandem's socket), node, the system. */
const CHILD_PATH = [dirname(TMUX_BIN), dirname(process.execPath), '/usr/bin', '/bin'].join(':')

const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`
/** The owner harness files every TANDEM_HOME of this test holds (same programs, so the same pins). */
function harnessFiles(th: string) {
  const dir = join(th, 'harnesses')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(th, 0o700)
  chmodSync(dir, 0o700)
  writeFileSync(join(dir, 'fake-a.toml'), `name = "fake-a"\nprogram = "${FAKE}"\nhas_prompts = true\nskip_prompts_args = ["--r1a48-skip"]\n${RULES}`, { mode: 0o600 })
  writeFileSync(join(dir, 'fake-b.toml'), `name = "fake-b"\nprogram = "${FAKE_B}"\nhas_prompts = true\n${RULES}`, { mode: 0o600 })
  writeFileSync(join(dir, 'fake-bash.toml'), `name = "fake-bash"\nprogram = "${FAKE_BASH}"\nhas_prompts = false\n\n[states]\ndebounce_ms = 1500\n\n[keys]\ninterrupt = "C-c"\n`, { mode: 0o600 })
}
harnessFiles(TH)

process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CCM_CWD_ALLOWLIST = `${WORK}:${OTHER}`
process.env.TANDEM_ENABLED_ENGINES = 'fake-a,fake-b,fake-bash,shell'
process.env.TANDEM_WAIT_MS = '8000'

// The start read: no file yet. Its stderr line is caught here.
const startLines: string[] = []
const startSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
  startLines.push(String(chunk))
  return true
}) as never)
const limits = await import('../bridge/limits.ts')
const { main } = await import('../bridge/limits-cli.ts')
const { handleHubRequest } = await import('../bridge/hub-rpc.ts')
const { loadedHarnesses } = await import('../bridge/engine-registry.ts')
const { mintCallerToken } = await import('../bridge/caller-tokens.ts')
const { CCM_FRAME_TYPES } = await import('../hub/src/protocol.ts')
const harnesses = loadedHarnesses()
startSpy.mockRestore()

vi.setConfig({ testTimeout: 90_000 })

const NOTICE = ' (notice: the limits file changed on disk and is not applied; apply it at this computer)'
const USAGE_FIRST = 'usage: tandem limits init [--folder <path>]... [--agent <name>]... [--force]'
const USAGE = `${USAGE_FIRST}\n       tandem limits apply\n`
const PIPE_APPLY = 'tandem: limits apply needs you at this computer: run it in a terminal, not from a pipe or a script'
const FROM_INSIDE = (cmd: 'init' | 'apply') => `tandem: limits ${cmd} refused: run it from your own terminal, not from inside a Tandem session`
const HEADER = 'Tandem limits: what sessions on this computer may do. Nothing is allowed until it is listed here.'
const FOLDERS_Q = 'Folders where sessions may start (absolute or ~/ paths, comma-separated; empty for none): '
const AGENTS_Q = 'Agents to allow (names from the list, comma-separated; empty for none): '
const APPLY_Q = 'Type yes to apply these limits on this computer: '
const FORCE_Q = 'Type yes to replace the limits file and apply it: '
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const entry = (name: string) => agentEntry(harnesses.get(name)!)
const lastLine = (text: string) => text.trimEnd().split('\n').pop()
const mode = (p: string) => statSync(p).mode & 0o777
const wrote = (file = LIMITS) => `tandem: wrote ${file} and applied it\n`
/** What init writes for `--folder WORK --agent fake-a`. */
const initFields = () => ({ folders: [WORK], agents: { 'fake-a': entry('fake-a') }, ...limits.INIT_DEFAULTS })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.TANDEM_CALLER_TOKEN
  process.env.TANDEM_HOME = TH
})

afterAll(() => {
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

/** A terminal on stdin, in this process. */
function tty(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true })
}
/** A pipe on stdin, in this process. */
function pipe(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: false })
}

/** Runs main(args) in this process with stdout and stderr captured; `token` set makes this an agent. */
function start(args: string[], o: { input?: NodeJS.ReadableStream & { isTTY?: boolean }; token?: string } = {}) {
  let out = ''
  let err = ''
  if (o.token === undefined) delete process.env.TANDEM_CALLER_TOKEN
  else process.env.TANDEM_CALLER_TOKEN = o.token
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Json) => { out += String(chunk); return true })
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Json) => { err += String(chunk); return true })
  const done = main(args, o.input === undefined ? { input: pipe() } : { input: o.input })
    .then((code) => ({ code, out, err }))
    .finally(() => {
      so.mockRestore()
      se.mockRestore()
      delete process.env.TANDEM_CALLER_TOKEN
    })
  return { done, out: () => out }
}
const cli = (args: string[], o: Parameters<typeof start>[1] = {}) => start(args, o).done
/** An in-process terminal that has `lines` typed (each ends with Enter), then nothing more. */
function typed(...lines: string[]) {
  const input = tty()
  input.write(lines.map((l) => `${l}\n`).join(''))
  return input
}
async function until(what: string, ok: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

let seq = 0
/** One request as the hub sends it: a frame through handleHubRequest; the status and JSON body back. */
async function viaHub(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const frame = {
    type: CCM_FRAME_TYPES.httpRequest,
    request_id: `r1a48-${++seq}`,
    method,
    path,
    headers: {},
    ...(body !== undefined ? { body_base64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64') } : {}),
  }
  const res = await handleHubRequest(frame as never)
  return { status: res.status_code, body: JSON.parse(Buffer.from(res.body_base64 ?? '', 'base64').toString('utf8')) }
}
const open = (name: string, engine: string, cwd: string, extra: Record<string, unknown> = {}) =>
  viaHub('POST', '/sessions/open', { name, engine, cwd, ...extra })
const close = (name: string) => viaHub('POST', `/sessions/${name}/close`)
const tandemTmux = (...args: string[]) => execFileSync('tmux', ['-S', join(process.env.TANDEM_HOME!, 'tmux', 'tandem'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const pane = (name: string) => tandemTmux('capture-pane', '-p', '-t', `=ccm-${name}:`)

function auditLines(): Json[] {
  return readFileSync(join(HOME, '.tandem', 'bridge.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const lastAudit = () => auditLines().pop()

/** A 403 from the limits gate, with its audit line; `notice` says whether the error ends with the notice. */
function expectLimitsRefusal(res: { status: number; body: any }, name: string, engine: string, notice: boolean) {
  expect(res.status, JSON.stringify(res.body)).toBe(403)
  expect(res.body.error).toMatch(/^limits: /)
  if (notice) expect(res.body.error.endsWith(NOTICE)).toBe(true)
  else expect(res.body.error).not.toContain('notice')
  expect(lastAudit()).toMatchObject({ route: 'POST /sessions/open', name, engine, denied: 'limits' })
}

let n = 0
const uniq = (tag: string) => `r1a48-${tag}-${++n}`

/** No limits file and no copy in TH; this process's snapshot read again (nothing allowed). */
function noFiles() {
  rmSync(LIMITS, { force: true })
  rmSync(APPLIED, { force: true })
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  limits.applyLimits()
  spy.mockRestore()
}
/** `fields` written as limits.toml and applied by the owner (`tandem limits apply`, `yes` at an in-process terminal). */
async function ownerApplies(fields?: Record<string, unknown>) {
  if (fields) writeLimits(TH, fields)
  const r = await cli(['apply'], { input: typed('yes') })
  expect([r.code, lastLine(r.err) ?? ''], r.out + r.err).toEqual([0, ''])
  expect(r.out).toMatch(/tandem: (limits applied|the limits file is already applied)\n$/)
  expect(readFileSync(APPLIED)).toEqual(readFileSync(LIMITS))
}
/** A fresh TANDEM_HOME under BOX (owner harness files in it); this process's snapshot reads it. */
function freshHome(tag: string): { th: string; file: string; copy: string } {
  const th = join(BOX, `home-${tag}`, 'tandem')
  harnessFiles(th)
  process.env.TANDEM_HOME = th
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  limits.applyLimits()
  spy.mockRestore()
  return { th, file: join(th, 'limits.toml'), copy: join(th, 'limits.applied.toml') }
}

/** A new node process that imports bridge/limits.ts and prints JSON of its snapshot (stands for any process started now). */
function newProcess(th = TH): { folders: string[]; shell: boolean; agents: string[]; digest: string } {
  const code = `const l = await import(process.argv[1]); const s = l.limitsSnapshot();
process.stdout.write(JSON.stringify({ folders: s.folders, shell: s.shell, agents: Object.keys(s.agents).sort(), digest: s.digest }))`
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code, LIMITS_TS], {
    encoding: 'utf8', env: { ...process.env, TANDEM_HOME: th, PATH: CHILD_PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(out)
}

/**
 * A REAL terminal: a tmux session on the test's own socket (never Tandem's) running a script that
 * sets every variable it needs, runs the CLI with stdout and stderr to files, and writes its exit
 * code. Each answer waits for its text in the stdout file, then is typed with send-keys.
 */
async function terminal(tag: string, args: string[], answers: [waitFor: string, keys: string][], th = TH): Promise<{ code: number; out: string; err: string }> {
  const out = join(BOX, `${tag}.out`)
  const err = join(BOX, `${tag}.err`)
  const rc = join(BOX, `${tag}.rc`)
  const script = join(BOX, `${tag}.sh`)
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  writeFileSync(script, [
    'unset TMUX TANDEM_CALLER_TOKEN TMUX_PANE',
    `export TANDEM_HOME=${q(th)} HOME=${q(HOME)} PATH=${q(CHILD_PATH)} TANDEM_ENABLED_ENGINES=${q(process.env.TANDEM_ENABLED_ENGINES!)}`,
    `${q(process.execPath)} --experimental-strip-types --no-warnings ${q(CLI)} ${args.map(q).join(' ')} > ${q(out)} 2> ${q(err)}`,
    `echo $? > ${q(rc)}`,
    '',
  ].join('\n'))
  ownTmux('new-session', '-d', '-s', tag, '-x', '220', '-y', '50', `sh ${q(script)}`)
  for (const [waitFor, keys] of answers) {
    await until(`"${waitFor}" in ${tag}.out`, () => existsSync(out) && readFileSync(out, 'utf8').includes(waitFor))
    ownTmux('send-keys', '-t', `=${tag}:`, '-l', keys)
    ownTmux('send-keys', '-t', `=${tag}:`, 'Enter')
  }
  await until(`${tag} exit code`, () => existsSync(rc) && readFileSync(rc, 'utf8').trim() !== '', 30_000)
  return { code: Number(readFileSync(rc, 'utf8').trim()), out: readFileSync(out, 'utf8'), err: readFileSync(err, 'utf8') }
}
function ownTmux(...args: string[]) {
  const env = { ...process.env }
  delete env.TMUX
  return execFileSync('tmux', ['-S', OWN, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('U-R1A-48 tandem limits', () => {
  it('(a) no file allows nothing: a hub open is 403 and logged; apply says there is no file; neither file is made', async () => {
    const home = freshHome('a')
    try {
      const name = uniq('a')
      const res = await open(name, 'fake-a', WORK)
      expectLimitsRefusal(res, name, 'fake-a', false)
      expect(res.body.error).toBe(`limits: no limits file at ${home.file}; nothing is allowed`)
      const r = await cli(['apply'], { input: typed('yes') })
      expect([r.code, r.out, r.err]).toEqual([1, '', `tandem: no limits file at ${home.file}; run tandem limits init\n`])
      expect([existsSync(home.file), existsSync(home.copy)]).toEqual([false, false])
    } finally {
      process.env.TANDEM_HOME = TH
      noFiles()
    }
  })

  it('(b) init writes one (flags, no terminal): 0600 file in a 0700 folder, the copy beside it, used at once', async () => {
    noFiles()
    const r = await cli(['init', '--folder', WORK, '--agent', 'fake-a'])
    expect([r.code, r.out, r.err]).toEqual([0, wrote(), ''])
    expect([mode(LIMITS), mode(TH), mode(APPLIED)]).toEqual([0o600, 0o700, 0o600])
    const parsed = parse(readFileSync(LIMITS, 'utf8')) as Json
    expect(Object.keys(parsed).sort()).toEqual([...limits.FIELDS].sort())
    expect(parsed).toEqual(initFields())
    expect(readFileSync(APPLIED)).toEqual(readFileSync(LIMITS))
    // no applyLimits() here: the snapshot already holds the applied file
    expect(limits.limitsSnapshot().folders).toEqual([WORK])
    expect(Object.keys(limits.limitsSnapshot().agents)).toEqual(['fake-a'])
    const name = uniq('b')
    expect((await open(name, 'fake-a', WORK)).status).toBe(200)
    expect((await close(name)).status).toBe(200)
    expect(auditLines().filter((l) => l.event === 'limits.init').pop()).toMatchObject({ event: 'limits.init', digest: sha256(LIMITS) })
  })

  it('(c) init asks at an in-process terminal, then at a REAL terminal (own tmux socket): the same file', async () => {
    noFiles()
    const run = start(['init'], { input: typed('relative/x', WORK, 'fake-a') })
    const r = await run.done
    expect([r.code, r.err], r.out).toEqual([0, ''])
    const lines = r.out.split('\n')
    expect(lines[0]).toBe(HEADER)
    expect(r.out).toContain(`${FOLDERS_Q}  not used: relative/x: not an absolute or ~/ path\n${FOLDERS_Q}`)
    expect(r.out).toMatch(/Agents found here: .*fake-a \(/)
    expect(r.out).toContain(`fake-a (${realpathSync(FAKE)})`)
    expect(r.out).toContain(AGENTS_Q)
    expect(r.out.endsWith(wrote())).toBe(true)
    expect(r.out.indexOf(FOLDERS_Q)).toBeLessThan(r.out.indexOf('Agents found here'))
    const inProcess = readFileSync(LIMITS, 'utf8')
    expect(parse(inProcess)).toEqual(initFields())

    const home = join(BOX, 'home-c', 'tandem')
    harnessFiles(home)
    const t = await terminal('c', ['init'], [[FOLDERS_Q, WORK], [AGENTS_Q, 'fake-a']], home)
    expect([t.code, lastLine(t.err) ?? ''], t.out + t.err).toEqual([0, ''])
    expect(t.out.startsWith(`${HEADER}\n${FOLDERS_Q}`)).toBe(true)
    expect(t.out.endsWith(wrote(join(home, 'limits.toml')))).toBe(true)
    expect(readFileSync(join(home, 'limits.toml'), 'utf8')).toBe(inProcess)
    expect(readFileSync(join(home, 'limits.applied.toml'), 'utf8')).toBe(inProcess)
  })

  it('(d) init refusals change nothing; --force at a terminal asks for yes; --bogus is usage; no flags and no terminal write the empty file', async () => {
    // a file already there
    noFiles()
    expect((await cli(['init', '--folder', WORK, '--agent', 'fake-a'])).code).toBe(0)
    const before = [readFileSync(LIMITS), readFileSync(APPLIED)]
    const unchanged = () => expect([readFileSync(LIMITS), readFileSync(APPLIED)]).toEqual(before)
    const exists = await cli(['init'], { input: typed(WORK, 'fake-a') })
    expect([exists.code, exists.out, exists.err]).toEqual([1, '', `tandem: ${LIMITS} already exists; nothing was written (edit it and run tandem limits apply)\n`])
    unchanged()
    rmSync(LIMITS)
    const copyOnly = await cli(['init'])
    expect([copyOnly.code, copyOnly.err]).toEqual([1, `tandem: ${APPLIED} already exists; nothing was written (edit it and run tandem limits apply)\n`])
    expect(existsSync(LIMITS)).toBe(false)
    // a copy that is a link to nothing is still a copy (every reader refuses it, nothing allowed): init leaves it alone
    rmSync(APPLIED)
    symlinkSync(join(BOX, 'nowhere'), APPLIED)
    const linked = await cli(['init', '--folder', WORK])
    expect([linked.code, lastLine(linked.err)]).toEqual([1, `tandem: ${APPLIED} already exists; nothing was written (edit it and run tandem limits apply)`])
    expect([existsSync(LIMITS), readlinkSync(APPLIED)]).toEqual([false, join(BOX, 'nowhere')])
    rmSync(APPLIED)
    writeFileSync(APPLIED, before[1]!, { mode: 0o600 })
    writeFileSync(LIMITS, before[0]!, { mode: 0o600 })
    const piped = await cli(['init', '--force', '--folder', OTHER], { input: pipe() })
    expect([piped.code, piped.out, piped.err]).toEqual([1, '', 'tandem: limits init --force needs you at this computer: run it in a terminal, not from a pipe or a script\n'])
    unchanged()
    // an agent (a caller token) is refused before anything else is looked at
    const token = mintCallerToken('r1a48-agent', WORK)
    const agent = await cli(['init', '--force', '--folder', OTHER], { input: typed('yes'), token })
    expect([agent.code, agent.out, agent.err]).toEqual([1, '', `${FROM_INSIDE('init')}\n`])
    expect(lastAudit()).toMatchObject({ event: 'limits.init', refused: 'agent_refused' })
    unchanged()
    // --force at a terminal: `no` keeps both files, `yes` replaces them
    const no = await cli(['init', '--force', '--folder', OTHER, '--agent', 'fake-a'], { input: typed('no') })
    expect([no.code, no.err]).toEqual([1, 'tandem: not replaced\n'])
    expect(no.out).toContain(`limits file: ${LIMITS}\n`)
    expect(no.out).toContain(`  folders: ${JSON.stringify([WORK])} -> ${JSON.stringify([OTHER])}\n`)
    expect(no.out.endsWith(FORCE_Q)).toBe(true)
    unchanged()
    const yes = await cli(['init', '--force', '--folder', OTHER, '--agent', 'fake-a'], { input: typed('yes') })
    expect([yes.code, yes.out.endsWith(`${FORCE_Q}${wrote()}`), yes.err]).toEqual([0, true, ''])
    expect((parse(readFileSync(LIMITS, 'utf8')) as Json).folders).toEqual([OTHER])
    expect(readFileSync(APPLIED)).toEqual(readFileSync(LIMITS))
    expect(limits.limitsSnapshot().folders).toEqual([OTHER])
    expect(readdirSync(TH).filter((f) => f.endsWith('.tmp'))).toEqual([])

    // usage
    for (const args of [['init', '--bogus'], ['init', '--folder'], ['init', 'extra'], ['apply', 'now'], [], ['show']]) {
      const u = await cli(args)
      expect([u.code, u.out, u.err], args.join(' ')).toEqual([2, '', USAGE])
    }

    // bad answers, in a home with no file (each refusal leaves it with none)
    const home = freshHome('d')
    const afile = join(BOX, 'a-file')
    writeFileSync(afile, 'x')
    mkdirSync(join(home.th, 'sub'), { recursive: true })
    const bad: [string, string, string][] = [
      ['--folder', 'relative/x', 'not an absolute or ~/ path'],
      ['--folder', join(BOX, 'missing'), 'not a folder'],
      ['--folder', afile, 'not a folder'],
      ['--folder', `${WORK}\u0007`, 'has a control character'],
      ['--folder', home.th, "holds or lies inside Tandem's own folder"],
      ['--folder', join(home.th, 'sub'), "holds or lies inside Tandem's own folder"],
      ['--folder', dirname(home.th), "holds or lies inside Tandem's own folder"],
      ['--agent', 'nosuch', 'not an agent found here'],
    ]
    for (const [flag, value, reason] of bad) {
      const r = await cli(['init', flag, value])
      // a control character in an entry is shown as `?`
      expect([r.code, r.out, r.err], value).toEqual([1, '', `tandem: limits init: ${value.replace('\u0007', '?')}: ${reason}; nothing was written\n`])
      expect([existsSync(home.file), existsSync(home.copy)]).toEqual([false, false])
    }
    const three = await cli(['init'], { input: typed('relative/a', join(BOX, 'missing'), afile) })
    expect([three.code, three.err]).toEqual([1, 'tandem: limits init: no usable answer; nothing was written\n'])
    expect(three.out.split(FOLDERS_Q)).toHaveLength(4)
    expect([existsSync(home.file), existsSync(home.copy)]).toEqual([false, false])
    const threeAgents = await cli(['init'], { input: typed('', 'nosuch', 'fake-a,nosuch', 'zzz') })
    expect([threeAgents.code, threeAgents.err]).toEqual([1, 'tandem: limits init: no usable answer; nothing was written\n'])
    expect(threeAgents.out).toContain('  not used: nosuch: not an agent found here\n')
    expect([existsSync(home.file), existsSync(home.copy)]).toEqual([false, false])

    // no flags and no terminal in an empty home: the empty file, applied
    const empty = await cli(['init'], { input: pipe() })
    expect([empty.code, empty.err]).toEqual([0, ''])
    expect(empty.out).toBe(`${wrote(home.file)}tandem: nothing is allowed yet: edit ${home.file}, then run tandem limits apply\n`)
    expect(parse(readFileSync(home.file, 'utf8'))).toEqual({ folders: [], agents: {}, ...limits.INIT_DEFAULTS })
    expect(readFileSync(home.copy)).toEqual(readFileSync(home.file))
    expect([mode(home.file), mode(home.copy)]).toEqual([0o600, 0o600])
  })

  it('(e) apply at a terminal shows each changed field, applies on yes only, and refuses a file changed after it was shown', async () => {
    noFiles()
    await ownerApplies(initFields())
    const edit = { ...initFields(), folders: [WORK, OTHER], shell: true, agents: { 'fake-a': entry('fake-a'), 'fake-bash': entry('fake-bash') }, memory_scope: 'all' }
    writeLimits(TH, edit)
    const r = await cli(['apply'], { input: typed('yes') })
    expect([r.code, r.err]).toEqual([0, ''])
    expect(r.out).toBe([
      `limits file: ${LIMITS}`,
      `  folders: ${JSON.stringify([WORK])} -> ${JSON.stringify([WORK, OTHER])}`,
      '  shell: false -> true',
      `  agents.fake-bash: (none) -> ${JSON.stringify(entry('fake-bash'))}`,
      '  memory_scope: "project" -> "all"',
      `${APPLY_Q}tandem: limits applied`,
      '',
    ].join('\n'))
    expect(readFileSync(APPLIED)).toEqual(readFileSync(LIMITS))
    expect(auditLines().pop()).toMatchObject({ event: 'limits.apply', digest: sha256(LIMITS) })

    const again = await cli(['apply'], { input: typed('yes') })
    expect([again.code, again.out, again.err]).toEqual([0, 'tandem: the limits file is already applied\n', ''])

    appendFileSync(LIMITS, '# only a comment\n')
    const comment = await cli(['apply'], { input: typed('no') })
    expect(comment.out).toBe(`limits file: ${LIMITS}\n  (no field changed; only the file's text)\n${APPLY_Q}`)
    expect([comment.code, comment.err]).toEqual([1, 'tandem: not applied\n'])

    writeLimits(TH, { ...edit, shell: false })
    const copy = readFileSync(APPLIED)
    for (const answer of [['y'], ['YES'], [' yes'], [''], []]) {
      const input = typed(...answer)
      input.end()
      const no = await cli(['apply'], { input })
      expect([no.code, no.err, no.out.endsWith(APPLY_Q)], JSON.stringify(answer)).toEqual([1, 'tandem: not applied\n', true])
      expect(readFileSync(APPLIED)).toEqual(copy)
    }
    // the file rewritten between the diff and the yes
    const input = tty()
    const run = start(['apply'], { input })
    await until('the apply prompt', () => run.out().endsWith(APPLY_Q))
    writeLimits(TH, { ...edit, folders: [OTHER] })
    input.write('yes\n')
    const changed = await run.done
    expect([changed.code, changed.err]).toEqual([1, 'tandem: the limits file changed after it was shown; nothing was applied; run tandem limits apply again\n'])
    expect(readFileSync(APPLIED)).toEqual(copy)

    // a legacy home: a file and no copy
    rmSync(APPLIED)
    const legacy = await cli(['apply'], { input: typed('yes') })
    expect([legacy.code, legacy.err]).toEqual([0, ''])
    expect(legacy.out.split('\n').slice(0, 2)).toEqual([`limits file: ${LIMITS}`, '  (first apply here: no applied copy yet)'])
    expect(readFileSync(APPLIED)).toEqual(readFileSync(LIMITS))
  })

  it('(f) apply refusals: a pipe, an agent token, typed inside a Tandem session, a refused file: nothing changes', async () => {
    noFiles()
    const shellHarness = harnesses.get('shell')!
    await ownerApplies({ ...initFields(), shell: true, agents: { 'fake-a': entry('fake-a'), shell: agentEntry(shellHarness) } })
    const copy = readFileSync(APPLIED)
    const snap = limits.limitsSnapshot()
    const same = () => {
      expect(readFileSync(APPLIED)).toEqual(copy)
      expect(limits.limitsSnapshot()).toEqual(snap)
    }
    writeLimits(TH, { ...initFields(), folders: [WORK, OTHER] })

    const piped = await cli(['apply'], { input: Object.assign(typed('yes'), { isTTY: false }) })
    expect([piped.code, piped.out, piped.err]).toEqual([1, '', `${PIPE_APPLY}\n`])
    same()
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'apply'], {
      input: 'yes\n', encoding: 'utf8', env: { ...process.env, PATH: CHILD_PATH },
    })
    expect([child.status, lastLine(child.stderr), child.stdout]).toEqual([1, PIPE_APPLY, ''])
    same()
    const token = mintCallerToken('r1a48-agent-f', WORK)
    const agent = await cli(['apply'], { input: typed('yes'), token })
    expect([agent.code, agent.out, agent.err]).toEqual([1, '', `${FROM_INSIDE('apply')}\n`])
    expect(lastAudit()).toMatchObject({ event: 'limits.apply', refused: 'agent_refused' })
    same()

    // typed into a shell session the test opened on Tandem's socket: its pane is a terminal
    const name = uniq('f')
    const opened = await open(name, 'shell', WORK)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const out = join(BOX, 'f.out')
    const err = join(BOX, 'f.err')
    const rc = join(BOX, 'f.rc')
    const cmd = `unset TANDEM_CALLER_TOKEN TMUX; TANDEM_HOME='${TH}' HOME='${HOME}' '${process.execPath}' --experimental-strip-types --no-warnings '${CLI}' apply > '${out}' 2> '${err}'; echo $? > '${rc}'`
    expect((await viaHub('POST', `/sessions/${name}/send`, { text: cmd })).status).toBe(200)
    await until('the inside run', () => existsSync(rc) && readFileSync(rc, 'utf8').trim() !== '')
    expect([readFileSync(rc, 'utf8').trim(), readFileSync(out, 'utf8'), lastLine(readFileSync(err, 'utf8'))]).toEqual(['1', '', FROM_INSIDE('apply')])
    expect((await close(name)).status).toBe(200)
    same()

    // a refused file: a syntax error, an unknown field, and hub_commands (not a field until U-R1A-17B)
    for (const [text, reason] of [['folders = [\n', /TOML syntax error/], ['extra = 1\n', /unknown field extra/], ['hub_commands = false\n', /unknown field hub_commands/]] as const) {
      writeFileSync(LIMITS, text, { mode: 0o600 })
      const r = await cli(['apply'], { input: typed('yes') })
      expect([r.code, r.out]).toEqual([1, ''])
      expect(r.err).toMatch(new RegExp(`^tandem: the limits file is refused \\(${LIMITS.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: .*\\); nothing was applied\\n$`))
      expect(r.err).toMatch(reason)
      same()
    }
  })

  it('(g) an edited file is not used until applied: not here, not by a new process; after a yes at a REAL terminal, by both', async () => {
    noFiles()
    await ownerApplies(initFields())
    const applied = newProcess()
    writeLimits(TH, { ...initFields(), folders: [WORK, OTHER], shell: true, agents: { 'fake-a': entry('fake-a'), 'fake-bash': entry('fake-bash') } })
    appendFileSync(LIMITS, '# g widen\n') // a digest no earlier case has seen
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true }) as never)
    for (const _ of [1, 2]) {
      const name = uniq('g')
      const res = await open(name, 'fake-a', OTHER)
      expectLimitsRefusal(res, name, 'fake-a', true)
    }
    vi.restoreAllMocks()
    expect(lines.filter((l) => l.includes('changed on disk'))).toHaveLength(1)
    // (2) a process started after the edit reads the applied copy, not the edited file
    expect(newProcess()).toEqual(applied)
    expect(applied).toMatchObject({ folders: [WORK], shell: false, agents: ['fake-a'] })

    // (3) the owner applies at a real terminal
    const t = await terminal('g', ['apply'], [[APPLY_Q, 'yes']])
    expect([t.code, lastLine(t.err) ?? ''], t.out + t.err).toEqual([0, ''])
    expect(t.out.endsWith(`${APPLY_Q}tandem: limits applied\n`)).toBe(true)
    const name = uniq('g')
    expect((await open(name, 'fake-a', OTHER)).status).toBe(200) // no applyLimits(): picked up at this call
    expect((await close(name)).status).toBe(200)
    expect(newProcess()).toEqual({ folders: [WORK, OTHER], shell: true, agents: ['fake-a', 'fake-bash'], digest: sha256(LIMITS) })
  })

  describe('(h) A4.8: no file; asked for more than the file allows; edited by an agent; applied by the owner', () => {
    /** One field end to end; `allowed` checks the last open (a 200, or for permission_skip the skip args on screen). */
    async function a48(o: { tag: string; engine: string; cwd: string; without: Record<string, unknown>; with: Record<string, unknown>; reason: RegExp }) {
      noFiles()
      const none = uniq(o.tag)
      expectLimitsRefusal(await open(none, o.engine, o.cwd), none, o.engine, false)

      await ownerApplies(o.without)
      const without = uniq(o.tag)
      const refused = await open(without, o.engine, o.cwd)
      expectLimitsRefusal(refused, without, o.engine, false)
      expect(refused.body.error).toMatch(o.reason)

      writeLimits(TH, o.with)
      appendFileSync(LIMITS, `# ${o.tag}\n`)
      const edited = uniq(o.tag)
      const still = await open(edited, o.engine, o.cwd)
      expectLimitsRefusal(still, edited, o.engine, true)
      expect(still.body.error).toMatch(o.reason)
      const token = mintCallerToken(`r1a48-${o.tag}`, WORK)
      const byAgent = await cli(['apply'], { input: typed('yes'), token })
      expect([byAgent.code, byAgent.err]).toEqual([1, `${FROM_INSIDE('apply')}\n`])
      const after = uniq(o.tag)
      expectLimitsRefusal(await open(after, o.engine, o.cwd), after, o.engine, true)

      await ownerApplies()
      const name = uniq(o.tag)
      const opened = await open(name, o.engine, o.cwd)
      expect(opened.status, JSON.stringify(opened.body)).toBe(200)
      expect((await close(name)).status).toBe(200)
    }
    const fakeA = () => ({ 'fake-a': entry('fake-a') })

    it('(h) folders', () => a48({
      tag: 'h-folders', engine: 'fake-a', cwd: OTHER,
      without: { ...initFields() }, with: { ...initFields(), folders: [WORK, OTHER] },
      reason: /cwd .* is not inside the limits file's folders/,
    }))
    it('(h) agents', () => a48({
      tag: 'h-agents', engine: 'fake-b', cwd: WORK,
      without: { ...initFields() }, with: { ...initFields(), agents: { ...fakeA(), 'fake-b': entry('fake-b') } },
      reason: /agent "fake-b" is not in the limits file's agents/,
    }))
    it('(h) shell', () => a48({
      tag: 'h-shell', engine: 'shell', cwd: WORK,
      without: { ...initFields(), agents: { ...fakeA(), shell: entry('shell') } },
      with: { ...initFields(), shell: true, agents: { ...fakeA(), shell: entry('shell') } },
      reason: /agent "shell" runs a shell or interpreter and the limits file has shell = false/,
    }))
    it('(h) permission_skip', async () => {
      noFiles()
      const none = uniq('h-skip')
      expectLimitsRefusal(await open(none, 'fake-a', SKIP), none, 'fake-a', false)
      // the file without it: the open runs with its prompts on (no skip args); logged
      await ownerApplies(initFields())
      const without = uniq('h-skip')
      expect((await open(without, 'fake-a', SKIP)).status).toBe(200)
      expect(lastAudit()).toMatchObject({ route: 'POST /sessions/open', name: without, engine: 'fake-a' })
      expect(pane(without)).toContain('argc=0\n')
      expect(pane(without)).not.toContain('--r1a48-skip')
      // edited to allow it: still no skip args, with the notice line; the agent's own apply refused
      writeLimits(TH, { ...initFields(), permission_skip: [SKIP] })
      appendFileSync(LIMITS, '# h-skip\n')
      const lines: string[] = []
      vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true }) as never)
      const edited = uniq('h-skip')
      expect((await open(edited, 'fake-a', SKIP)).status).toBe(200)
      vi.restoreAllMocks()
      expect(lines.filter((l) => l.includes('changed on disk'))).toHaveLength(1)
      expect(pane(edited)).not.toContain('--r1a48-skip')
      const token = mintCallerToken('r1a48-h-skip', WORK)
      const byAgent = await cli(['apply'], { input: typed('yes'), token })
      expect([byAgent.code, byAgent.err]).toEqual([1, `${FROM_INSIDE('apply')}\n`])
      // the owner applies: on screen only inside WORK/skip
      await ownerApplies()
      const inside = uniq('h-skip')
      expect((await open(inside, 'fake-a', SKIP)).status).toBe(200)
      expect(pane(inside)).toContain('argc=1\narg=[--r1a48-skip]\n')
      const outside = uniq('h-skip')
      expect((await open(outside, 'fake-a', WORK)).status).toBe(200)
      expect(pane(outside)).not.toContain('--r1a48-skip')
      for (const s of [without, edited, inside, outside]) expect((await close(s)).status).toBe(200)
    })
  })

  describe('(i) a remote request to widen each field is refused', () => {
    const wide: [string, () => unknown][] = [
      ['folders', () => [OTHER]],
      ['agents', () => ({ 'fake-bash': entry('fake-bash') })],
      ['shell', () => true],
      ['permission_skip', () => [WORK]],
      ['session_cap', () => 100],
      ['interrupt_from', () => ['owner']],
      ['control_from', () => ['evil-1']],
      ['memory_scope', () => 'all'],
      ['transcript_scope', () => 'computer'],
    ]
    it.each(wide)('(i) %s', async (field, value) => {
      noFiles()
      await ownerApplies(initFields())
      const snap = limits.limitsSnapshot() as Json
      const before = JSON.stringify(snap[field])
      const files = [sha256(LIMITS), sha256(APPLIED)]
      const body = { [field]: value(), limits: { [field]: value() } }
      expect((await viaHub('GET', '/limits')).status).toBe(404)
      expect((await viaHub('POST', '/limits', body)).status).toBe(404)
      expect((await viaHub('POST', '/limits/apply', body)).status).toBe(404)
      // the open route ignores keys it does not know (B7): it answers what the applied file allows
      const name = uniq(`i-${field}`)
      const opened = await open(name, 'fake-a', WORK, body)
      expect(opened.status, JSON.stringify(opened.body)).toBe(200)
      expect((await close(name)).status).toBe(200)
      expect(JSON.stringify((limits.limitsSnapshot() as Json)[field])).toBe(before)
      expect([sha256(LIMITS), sha256(APPLIED)]).toEqual(files)
      expect(readdirSync(TH).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
  })

  it("(j) U-R1A-47's scopes reach a running agent's server after apply, with no restart", async () => {
    noFiles()
    await ownerApplies(initFields())
    const code = `const l = await import(process.argv[1]); const rl = (await import('node:readline')).createInterface({ input: process.stdin });
for await (const _ of rl) { const s = l.limitsSnapshot(); process.stdout.write(JSON.stringify({ memory_scope: s.memory_scope, transcript_scope: s.transcript_scope }) + '\\n') }`
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code, LIMITS_TS], {
      env: { ...process.env, PATH: CHILD_PATH }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      let out = ''
      child.stdout.on('data', (c) => { out += String(c) })
      const ask = async () => {
        const had = out.split('\n').length
        child.stdin.write('call\n')
        await until('the child answer', () => out.split('\n').length > had)
        return JSON.parse(out.trimEnd().split('\n').pop()!)
      }
      expect(await ask()).toEqual({ memory_scope: 'project', transcript_scope: 'project' })
      await ownerApplies({ ...initFields(), memory_scope: 'all', transcript_scope: 'computer' })
      expect(await ask()).toEqual({ memory_scope: 'all', transcript_scope: 'computer' })
      const s = limits.limitsSnapshot()
      expect([s.memory_scope, s.transcript_scope]).toEqual(['all', 'computer'])
    } finally {
      child.stdin.end()
      if (child.exitCode === null && child.pid !== undefined) child.kill('SIGTERM')
    }
  })

  it("(k) A4.27: with a file like the fleet's, a hub command to an agent runs and is written to the local log", async () => {
    noFiles()
    const FLEET = {
      folders: [WORK], permission_skip: [WORK], shell: true, agents: { 'fake-a': entry('fake-a'), 'fake-bash': entry('fake-bash') },
      session_cap: 12, interrupt_from: ['owner'], control_from: [], memory_scope: 'project', transcript_scope: 'project',
    }
    await ownerApplies(FLEET)
    const name = uniq('k')
    const opened = await open(name, 'fake-bash', WORK)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const ran = join(BOX, 'a427-ran')
    const sent = await viaHub('POST', `/sessions/${name}/send`, { text: `touch '${ran}'` })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    await until('the command to run', () => existsSync(ran), 10_000)
    expect(auditLines().some((l) => l.route === 'POST /sessions/:name/send' && l.name === name && l.engine === 'fake-bash')).toBe(true)
    expect((await close(name)).status).toBe(200)
  })

  it("(l) packaging/tandem's `limits` case dispatches to bridge/limits-cli.ts; help lists both commands", async () => {
    const inst = join(BOX, 'inst')
    mkdirSync(join(inst, 'bin'), { recursive: true })
    copyFileSync(join(repo, 'packaging', 'tandem'), join(inst, 'bin', 'tandem'))
    if (!existsSync(join(inst, 'runtime'))) execFileSync('ln', ['-s', repo, join(inst, 'runtime')])
    const launch = (...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_NODE: process.execPath, PATH: CHILD_PATH }
      delete env.TANDEM_CALLER_TOKEN
      return spawnSync('sh', [join(inst, 'bin', 'tandem'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const usage = launch('limits')
    expect([usage.status, usage.stdout, usage.stderr.split('\n')[0]]).toEqual([2, '', USAGE_FIRST])
    const apply = launch('limits', 'apply')
    expect([apply.status, lastLine(apply.stderr)]).toEqual([1, PIPE_APPLY])
    const help = launch('help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('  tandem limits init [--folder <path>]... [--agent <name>]... [--force]\n                             write the first limits file: the folders and agents this computer allows\n')
    expect(help.stdout).toContain('  tandem limits apply         show what changed in the limits file and use it, after you type yes here\n')
  })

  it('(m) the installer runs init: nothing allowed from a pipe, kept on a reinstall, asked at a terminal', async () => {
    const release = join(BOX, 'release')
    mkdirSync(release)
    execFileSync('sh', [join(repo, 'packaging', 'build-release.sh'), release], { cwd: repo, stdio: 'pipe', env: { ...process.env, TANDEM_SKIP_AUDIT: '1' } })
    const archive = join(release, readdirSync(release).find((f) => f.endsWith('.tar.gz'))!)
    const stubs = join(BOX, 'stubs')
    mkdirSync(stubs)
    for (const tool of ['launchctl', 'systemctl']) writeFileSync(join(stubs, tool), `#!/bin/sh\necho "${tool} $*" >> "$SERVICE_LOG"\nexit 0\n`, { mode: 0o755 })
    const installEnv = (home: string) => ({
      HOME: home, TANDEM_HOME: join(home, '.tandem'), TANDEM_ARCHIVE: archive, SERVICE_LOG: join(home, 'service.log'),
      PATH: `${stubs}:${CHILD_PATH}`, TANDEM_ENABLED_ENGINES: 'fake-a',
    })
    const install = (home: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...installEnv(home) }
      delete env.TANDEM_CALLER_TOKEN
      return execFileSync('sh', [join(repo, 'packaging', 'install.sh')], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const h1 = join(BOX, 'inst-1')
    mkdirSync(h1)
    const first = install(h1)
    expect(first).toContain('nothing is allowed yet')
    const file = join(h1, '.tandem', 'limits.toml')
    const copy = join(h1, '.tandem', 'limits.applied.toml')
    expect([mode(file), mode(copy)]).toEqual([0o600, 0o600])
    expect(readFileSync(copy)).toEqual(readFileSync(file))
    expect(parse(readFileSync(file, 'utf8'))).toMatchObject({ folders: [], agents: {} })
    const bytes = [readFileSync(file), readFileSync(copy)]
    const second = install(h1)
    expect(second).toContain(`keeping the limits file in ${join(h1, '.tandem')}`)
    expect([readFileSync(file), readFileSync(copy)]).toEqual(bytes)

    // a third install, in a fresh home, with stdout a terminal (a pane on the test's own socket)
    const h3 = join(BOX, 'inst-3')
    harnessFiles(join(h3, '.tandem'))
    const rc = join(BOX, 'm.rc')
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const script = join(BOX, 'm.sh')
    writeFileSync(script, [
      'unset TMUX TANDEM_CALLER_TOKEN TMUX_PANE',
      ...Object.entries(installEnv(h3)).map(([k, v]) => `export ${k}=${q(v)}`),
      `sh ${q(join(repo, 'packaging', 'install.sh'))}`,
      `echo $? > ${q(rc)}`,
      'sleep 600',
      '',
    ].join('\n'))
    ownTmux('new-session', '-d', '-s', 'm', '-x', '250', '-y', '60', `sh ${q(script)}`)
    try {
      const screen = () => ownTmux('capture-pane', '-p', '-J', '-t', '=m:')
      await until('the folders question', () => screen().includes(FOLDERS_Q.trimEnd()), 120_000)
      ownTmux('send-keys', '-t', '=m:', '-l', WORK)
      ownTmux('send-keys', '-t', '=m:', 'Enter')
      await until('the agents question', () => screen().includes(AGENTS_Q.trimEnd()))
      expect(screen()).toMatch(/Agents found here: .*fake-a \(/)
      ownTmux('send-keys', '-t', '=m:', '-l', 'fake-a')
      ownTmux('send-keys', '-t', '=m:', 'Enter')
      await until('the install to end', () => existsSync(rc) && readFileSync(rc, 'utf8').trim() !== '', 60_000)
      expect(readFileSync(rc, 'utf8').trim(), screen()).toBe('0')
    } finally {
      try { ownTmux('kill-session', '-t', '=m') } catch { /* gone */ }
    }
    const f3 = join(h3, '.tandem', 'limits.toml')
    expect(parse(readFileSync(f3, 'utf8'))).toMatchObject({ folders: [WORK], agents: { 'fake-a': entry('fake-a') } })
    expect(readFileSync(join(h3, '.tandem', 'limits.applied.toml'))).toEqual(readFileSync(f3))
  }, 900_000)

  it('(n) init writes only the fields limits.ts knows (U-R1A-17B adds its two fields to FIELDS and INIT_DEFAULTS)', async () => {
    noFiles()
    expect((await cli(['init', '--folder', WORK, '--agent', 'fake-a'])).code).toBe(0)
    const text = readFileSync(LIMITS, 'utf8')
    expect(Object.keys(parse(text)).sort()).toEqual([...limits.FIELDS].sort())
    expect(Object.keys(limits.INIT_DEFAULTS).sort()).toEqual(limits.FIELDS.filter((f) => f !== 'folders' && f !== 'agents').sort())
    expect(text).not.toContain('hub_commands')
    expect(text).not.toContain('hub_reads')
  })

  it('(o) T23, the same-user limit: with the applied copy deleted, a process started after a wider edit reads the wider file', async () => {
    noFiles()
    await ownerApplies(initFields())
    rmSync(APPLIED)
    writeLimits(TH, { ...initFields(), folders: [WORK, OTHER], shell: true })
    // this process keeps what it applied (no fall back while running) ...
    expect(limits.limitsSnapshot().folders).toEqual([WORK])
    // ... a new one reads limits.toml as a home from before U-R1A-48 would
    expect(newProcess()).toMatchObject({ folders: [WORK, OTHER], shell: true, digest: sha256(LIMITS) })
  })
})
