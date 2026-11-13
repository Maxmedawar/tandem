/**
 * U-R1A-36D: one helper (bridge/sqlite-file.ts ensureDbFile) makes every database file before
 * `new DatabaseSync`, and an open never opens and closes a plain descriptor of a file that already
 * exists: closing ANY descriptor of a file drops every POSIX lock this process holds on it, so a
 * second open in a process that already has the file open lets another process take the lock
 * SQLite needs to be the only user (and checkpoint or remove the WAL under the first).
 *
 * Every folder is under one mkdtemp folder in TMPDIR named r1a36d-, removed in afterAll. TMUX is
 * deleted; TANDEM_HOME and HOME are set before any bridge file is imported. Child processes are
 * `node --experimental-strip-types` scripts written into that folder, each with its own
 * TANDEM_HOME and HOME and nothing else from this process's TANDEM_* and CCM_* variables, each in
 * its own process group (killed by group in afterAll if still running). Processes are coordinated
 * by stdin/stdout lines, never by sleeps.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a36d-')))
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith('..')) throw new Error('r1a36d: temp folder is under the real home')
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
mkdirSync(TH, { mode: 0o700 })
mkdirSync(HOME, { mode: 0o700 })
delete process.env.TMUX
process.env.TANDEM_HOME = TH
process.env.HOME = HOME

const { openMailbox } = await import('../bridge/mailbox.ts')
const { openReplayStore } = await import('../bridge/envelope.ts')
/** The helper is imported per row, so the rows that do not need it run (and show their red) without it. */
const helper = () => import('../bridge/sqlite-file.ts')

const src = (f: string) => JSON.stringify(pathToFileURL(join(repo, 'bridge', f)).href)
let made = 0
/** A fresh folder (0700) under BOX. */
const folder = (name: string) => {
  const d = join(BOX, `${name}-${++made}`)
  mkdirSync(d, { mode: 0o700 })
  return d
}
const script = (name: string, lines: string[]) => {
  const f = join(BOX, `${name}-${++made}.mjs`)
  writeFileSync(f, lines.join('\n') + '\n')
  return f
}

function childEnv(th: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'TMUX' || k === 'TMUX_PANE' || k.startsWith('TANDEM_') || k.startsWith('CCM_')) continue
    env[k] = v
  }
  return Object.assign(env, { TANDEM_HOME: th, HOME }, extra)
}

const kids: ChildProcess[] = []
afterAll(() => {
  for (const k of kids) {
    if (k.exitCode === null && k.signalCode === null && k.pid) {
      try {
        process.kill(-k.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  rmSync(BOX, { recursive: true, force: true })
})

/** A one-shot child: its stdout, trimmed; a non-zero exit throws with its stderr. */
function run(file: string, th: string, args: string[] = [], opts: { flags?: string[]; extra?: Record<string, string> } = {}): string {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', ...(opts.flags ?? []), file, ...args], {
    cwd: BOX, env: childEnv(th, opts.extra), encoding: 'utf8', timeout: 60_000,
  })
  if (r.status !== 0) throw new Error(`child ${file} exited ${r.status} ${r.signal ?? ''}: ${r.stderr}`)
  return r.stdout.trim()
}

/** A long-running child spoken to by lines: ask() writes one line and resolves with the next line it prints. */
function kid(file: string, th: string) {
  const child = spawn(process.execPath, ['--experimental-strip-types', file], { cwd: BOX, env: childEnv(th), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  kids.push(child)
  let err = ''
  child.stderr!.on('data', (d) => { err += d })
  const lines: string[] = []
  const waiters: ((l: string) => void)[] = []
  let buf = ''
  child.stdout!.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const l = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const w = waiters.shift()
      if (w) w(l)
      else lines.push(l)
    }
  })
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)))
  const next = (): Promise<string> =>
    lines.length > 0
      ? Promise.resolve(lines.shift()!)
      : Promise.race([new Promise<string>((r) => waiters.push(r)), exited.then((c): string => { throw new Error(`child ${file} exited ${c}: ${err}`) })])
  return {
    next,
    ask(line: string): Promise<string> {
      child.stdin!.write(line + '\n')
      return next()
    },
    exited,
  }
}

/** P: a bridge-like process. Lines: `open` (one more openMailbox), `send <text>` (through the first), `close` (all, then exit). */
const pScript = () => script('p', [
  `import { createInterface } from 'node:readline'`,
  `import { openMailbox } from ${src('mailbox.ts')}`,
  `const boxes = []`,
  `for await (const line of createInterface({ input: process.stdin })) {`,
  `  const [cmd, arg] = line.split(' ')`,
  `  if (cmd === 'open') boxes.push(openMailbox())`,
  `  else if (cmd === 'send') boxes[0].send({ from: 'owner', to: 'dur', level: 'fyi', text: arg })`,
  `  else if (cmd === 'close') { for (const b of boxes.reverse()) b.close(); process.stdout.write('closed\\n'); process.exit(0) }`,
  `  process.stdout.write('ok\\n')`,
  `}`,
])
/** A plain node:sqlite reader: the mail texts in order and the integrity check, then it closes. */
const readerScript = () => script('reader', [
  `import { DatabaseSync } from 'node:sqlite'`,
  `const db = new DatabaseSync(process.argv[2])`,
  `const texts = db.prepare('SELECT text FROM mail ORDER BY seq').all().map((r) => r.text)`,
  `const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check`,
  `db.close()`,
  `process.stdout.write(JSON.stringify({ texts, integrity }))`,
])
/** A process that asks SQLite for the database file's EXCLUSIVE lock (the lock a last user takes before it checkpoints and removes the WAL). */
const exclusiveScript = () => script('exclusive', [
  `import { DatabaseSync } from 'node:sqlite'`,
  `const db = new DatabaseSync(process.argv[2], { timeout: 0 })`,
  `let answer`,
  `try { db.exec('PRAGMA locking_mode = EXCLUSIVE'); db.prepare('SELECT count(*) AS n FROM mail').get(); answer = 'took the exclusive lock' }`,
  `catch (e) { answer = String(e.message) }`,
  `db.close()`,
  `process.stdout.write(answer)`,
])

describe('(36D) (s1) a second openMailbox keeps the locks the first holds', () => {
  it('(36D) (s1) P has state.db open twice; Q asks for the exclusive lock and is refused; m1 and m2 are both there (while P runs and after) and integrity_check is ok', async () => {
    const th = folder('s1')
    const db = join(th, 'state.db')
    const P = kid(pScript(), th)
    expect(await P.ask('open')).toBe('ok')
    expect(await P.ask('send m1')).toBe('ok')
    expect(await P.ask('open')).toBe('ok')
    const q = run(exclusiveScript(), th, [db])
    expect(await P.ask('send m2')).toBe('ok')
    // Another process reads while P still runs: what P stored must be in the file it reads.
    expect(JSON.parse(run(readerScript(), th, [db]))).toEqual({ texts: ['m1', 'm2'], integrity: 'ok' })
    expect(await P.ask('close')).toBe('closed')
    expect(await P.exited).toBe(0)
    const r = JSON.parse(run(readerScript(), th, [db]))
    expect(r).toEqual({ texts: ['m1', 'm2'], integrity: 'ok' })
    expect(q).toBe('database is locked')
  }, 120_000)

  it('(36D) (s1a) the same with Q a plain reader that reads and closes (the lone-reader close): m1 and m2 are both there and integrity_check is ok', async () => {
    const th = folder('s1a')
    const db = join(th, 'state.db')
    const P = kid(pScript(), th)
    expect(await P.ask('open')).toBe('ok')
    expect(await P.ask('send m1')).toBe('ok')
    expect(await P.ask('open')).toBe('ok')
    expect(JSON.parse(run(readerScript(), th, [db]))).toEqual({ texts: ['m1'], integrity: 'ok' })
    expect(await P.ask('send m2')).toBe('ok')
    expect(await P.ask('close')).toBe('closed')
    expect(await P.exited).toBe(0)
    expect(JSON.parse(run(readerScript(), th, [db]))).toEqual({ texts: ['m1', 'm2'], integrity: 'ok' })
  }, 120_000)
})

describe('(36D) (s2) no site opens a plain descriptor of an existing database file', () => {
  it('(36D) (s2) openMailbox, the hub-presence reader, openReplayStore, both transcripts openers and ensureDbFile, each twice on existing files: no fs.openSync names any of them', () => {
    const th = folder('s2')
    const log = join(th, 'open.log')
    const files = {
      mailbox: join(th, 'mail.db'),
      presence: join(th, 'presence.db'),
      replay: join(th, 'replay.db'),
      index: join(th, 'transcripts', 'index.sqlite3'),
      search: join(th, 'transcripts', 'search.sqlite3'),
      helper: join(th, 'helper.db'),
    }
    const probe = join(th, 'probe.txt')
    const logger = script('logger', [
      `import fs from 'node:fs'`,
      `import { syncBuiltinESMExports } from 'node:module'`,
      `const real = fs.openSync`,
      `let inside = false`,
      `fs.openSync = function (path, ...rest) {`,
      `  if (!inside) { inside = true; try { fs.appendFileSync(process.env.R1A36D_LOG, String(path) + '\\n') } finally { inside = false } }`,
      `  return real.call(this, path, ...rest)`,
      `}`,
      `syncBuiltinESMExports()`,
    ])
    const sites = script('sites', [
      `import { closeSync, openSync, writeFileSync } from 'node:fs'`,
      `import { openMailbox } from ${src('mailbox.ts')}`,
      `import { readRemotePresence } from ${src('hub-presence.ts')}`,
      `import { openReplayStore } from ${src('envelope.ts')}`,
      `const f = JSON.parse(process.argv[2])`,
      `const times = process.argv[3] === 'make' ? 1 : 2`,
      `const members = () => [{ id: 'beta' }]`,
      `let n = 0`,
      // The probe proves the wrapper reaches a named openSync import.
      `if (times === 2) closeSync(openSync(process.env.R1A36D_PROBE, 'a'))`,
      `for (let i = 0; i < times; i++) {`,
      `  openMailbox({ path: f.mailbox }).close()`,
      `  readRemotePresence({ path: f.presence, self: 'alpha', members })`,
      `  openReplayStore({ path: f.replay }).close()`,
      `  const index = await import(${src('transcripts/index.ts')} + '?i=' + ++n)`,
      `  await index.transcriptFor('nobody')`,
      `  const search = await import(${src('transcripts/search.ts')} + '?i=' + n)`,
      `  const s = search.openTranscriptSearch({ path: f.search })`,
      `  s.indexSource({ name: 'n' + n, agent: 'shell', cwd: process.env.TANDEM_HOME, path: '/nowhere', sha256: 'a'.repeat(64) }, [])`,
      `  s.close()`,
      `}`,
      `if (times === 2) {`,
      `  const { ensureDbFile } = await import(${src('sqlite-file.ts')})`,
      `  ensureDbFile(f.helper); ensureDbFile(f.helper)`,
      `} else writeFileSync(f.helper, '')`,
      `process.stdout.write('done')`,
    ])
    expect(run(sites, th, [JSON.stringify(files), 'make'])).toBe('done')
    for (const p of Object.values(files)) expect(existsSync(p)).toBe(true)
    writeFileSync(log, '')
    let answer = ''
    try {
      answer = run(sites, th, [JSON.stringify(files), 'check'], { flags: ['--import', pathToFileURL(logger).href], extra: { R1A36D_LOG: log, R1A36D_PROBE: probe } })
    } catch (e) {
      answer = (e as Error).message
    }
    const opened = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((p) => resolve(p))
    expect(opened).toContain(probe)
    expect(opened.filter((p) => Object.values(files).includes(p))).toEqual([])
    expect(answer).toBe('done')
  }, 120_000)
})

describe('(36D) (s3) a missing file is made 0600; an existing one is set 0600 in place', () => {
  it('(36D) (s3) missing: 0600 under umask 022 and 077, in a folder the caller made 0700', async () => {
    const { ensureDbFile } = await helper()
    const old = process.umask()
    try {
      for (const mask of [0o022, 0o077]) {
        process.umask(mask)
        const dir = join(BOX, `s3-umask-${mask.toString(8)}`)
        mkdirSync(dir, { mode: 0o700 })
        const p = join(dir, 'state.db')
        ensureDbFile(p)
        const st = lstatSync(p)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o777).toBe(0o600)
        expect(st.size).toBe(0)
        expect(statSync(dir).mode & 0o777).toBe(0o700)
      }
    } finally {
      process.umask(old)
    }
  })

  it('(36D) (s3) existing at 0644: becomes 0600 with the same inode and the same bytes', async () => {
    const { ensureDbFile } = await helper()
    const p = join(folder('s3-existing'), 'state.db')
    writeFileSync(p, 'SQLite bytes kept')
    chmodSync(p, 0o644)
    const before = lstatSync(p)
    ensureDbFile(p)
    const after = lstatSync(p)
    expect(after.mode & 0o777).toBe(0o600)
    expect(after.ino).toBe(before.ino)
    expect(readFileSync(p, 'utf8')).toBe('SQLite bytes kept')
  })
})

describe('(36D) (s4) a symlink or a folder at the path is refused', () => {
  it('(36D) (s4) ensureDbFile on a symlink throws ELOOP and leaves the target alone; a folder throws EFTYPE', async () => {
    const { ensureDbFile } = await helper()
    const dir = folder('s4')
    const target = join(dir, 'target.db')
    writeFileSync(target, 'target bytes')
    chmodSync(target, 0o640)
    const link = join(dir, 'state.db')
    symlinkSync(target, link)
    let code: unknown
    try {
      ensureDbFile(link)
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
      expect((e as Error).message).not.toContain(dir)
    }
    expect(code).toBe('ELOOP')
    expect(readFileSync(target, 'utf8')).toBe('target bytes')
    expect(statSync(target).mode & 0o777).toBe(0o640)
    const sub = join(dir, 'folder.db')
    mkdirSync(sub)
    code = undefined
    try {
      ensureDbFile(sub)
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('EFTYPE')
  })

  it('(36D) (s4) openReplayStore answers its own text; openMailbox throws and makes nothing at the link target', () => {
    const dir = folder('s4-sites')
    const target = join(dir, 'missing-target.db')
    const replayLink = join(dir, 'replay.db')
    symlinkSync(target, replayLink)
    expect(() => openReplayStore({ path: replayLink })).toThrow(new Error(`replay store ${replayLink} refused: the file is a symlink`))
    const mailLink = join(dir, 'state.db')
    symlinkSync(target, mailLink)
    expect(() => openMailbox({ path: mailLink })).toThrow()
    expect(existsSync(target)).toBe(false)
  })
})

describe('(36D) (s5) two processes make one missing file together', () => {
  it('(36D) (s5) 20 rounds, a fresh path each: both return, the file is 0600, nobody throws EEXIST', async () => {
    const dir = folder('s5')
    const racer = script('racer', [
      `import { createInterface } from 'node:readline'`,
      `import { ensureDbFile } from ${src('sqlite-file.ts')}`,
      `for await (const p of createInterface({ input: process.stdin })) {`,
      `  try { ensureDbFile(p); process.stdout.write('ok\\n') } catch (e) { process.stdout.write('error ' + e.code + '\\n') }`,
      `}`,
    ])
    const a = kid(racer, TH)
    const b = kid(racer, TH)
    for (let i = 0; i < 20; i++) {
      const p = join(dir, `race-${i}.db`)
      expect(await Promise.all([a.ask(p), b.ask(p)])).toEqual(['ok', 'ok'])
      expect(lstatSync(p).mode & 0o777).toBe(0o600)
      expect(lstatSync(p).isFile()).toBe(true)
    }
  }, 120_000)
})

describe('(36D) (s6) the bridge pattern: mailbox open, presence carrier syncing, replay store opened 50 times, while another process stores 200 messages', () => {
  it('(36D) (s6) every message of both processes is there once and integrity_check is ok', async () => {
    const th = folder('s6')
    const keys = join(BOX, `s6-keys-${++made}`)
    const bridge = script('bridge', [
      `import { createServer } from 'node:http'`,
      `import { createInterface } from 'node:readline'`,
      `import { openMailbox } from ${src('mailbox.ts')}`,
      `import { openReplayStore, signEnvelope } from ${src('envelope.ts')}`,
      `import { hubPresence, readRemotePresence } from ${src('hub-presence.ts')}`,
      `import { openDeviceKey } from ${src('device-keys.ts')}`,
      `import { initRoster, makeOffer, receiveOffer, trustOffer } from ${src('roster.ts')}`,
      `const key = (id) => openDeviceKey({ path: ${JSON.stringify(keys)} + '/' + id + '/device.key' })`,
      `const A = key('alpha'), B = key('beta')`,
      `initRoster(A, 'alpha'); receiveOffer(JSON.stringify(makeOffer(B, 'beta'))); trustOffer(A, B.fingerprint)`,
      `let hubCalls = 0`,
      `const server = createServer((req, res) => {`,
      `  req.resume(); req.on('end', () => {`,
      `    hubCalls++`,
      `    const t = Date.now()`,
      `    const body = JSON.stringify({ v: 1, kind: 'presence', at: t, sessions: [{ name: 'b-one', engine: 'shell', project: 'work', state: 'idle', stateAt: t }], more: 0 })`,
      `    const envelope = JSON.stringify(signEnvelope(B, { from: 'beta', to: 'alpha', body }, t, 'presence'))`,
      `    res.writeHead(200, { 'content-type': 'application/json' })`,
      `    res.end(JSON.stringify({ presence: [{ from: 'beta', envelope, at: t }], connected: ['alpha', 'beta'] }))`,
      `  })`,
      `})`,
      `await new Promise((r) => server.listen(0, '127.0.0.1', r))`,
      `const presence = { names: async () => ['s-a'], whoIsUp: async () => ({ at: Date.now(), sessions: [] }) }`,
      `const box = openMailbox()`,
      `const carrier = hubPresence({ url: 'ws://127.0.0.1:' + server.address().port, token: 'p'.repeat(40), bridgeId: 'alpha' }, { presence, key: A, trusted: (id) => (id === 'beta' ? B.publicKey : undefined) })`,
      `const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()`,
      `process.stdout.write('ready\\n')`,
      `await lines.next()`,
      `let seen = 0`,
      `for (let i = 0; i < 50; i++) {`,
      `  box.send({ from: 'owner', to: 'dur', level: 'fyi', text: 'p' + i })`,
      `  const replay = openReplayStore(); replay.remember('beta', 'n' + i, Date.now() + 60000); replay.close()`,
      `  await carrier.syncOnce()`,
      `  seen += readRemotePresence({ self: 'alpha' }).filter((r) => r.sessions.length === 1).length`,
      `}`,
      `box.close(); carrier.start()(); server.close()`,
      `process.stdout.write(JSON.stringify({ hubCalls, seen }) + '\\n')`,
      `process.exit(0)`,
    ])
    const writer = script('writer', [
      `import { createInterface } from 'node:readline'`,
      `import { openMailbox } from ${src('mailbox.ts')}`,
      `const box = openMailbox()`,
      `const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()`,
      `process.stdout.write('ready\\n')`,
      `await lines.next()`,
      `for (let i = 0; i < 200; i++) box.send({ from: 'owner', to: 'dur', level: 'fyi', text: 'q' + i })`,
      `box.close()`,
      `process.stdout.write('done\\n')`,
      `process.exit(0)`,
    ])
    const P = kid(bridge, th)
    const Q = kid(writer, th)
    expect(await P.next()).toBe('ready')
    expect(await Q.next()).toBe('ready')
    const [p, q] = await Promise.all([P.ask('go'), Q.ask('go')])
    expect(JSON.parse(p)).toEqual({ hubCalls: 50, seen: 50 })
    expect(q).toBe('done')
    expect(await P.exited).toBe(0)
    expect(await Q.exited).toBe(0)
    const r = JSON.parse(run(readerScript(), th, [join(th, 'state.db')]))
    expect(r.integrity).toBe('ok')
    const want = [...Array.from({ length: 50 }, (_, i) => `p${i}`), ...Array.from({ length: 200 }, (_, i) => `q${i}`)].sort()
    expect([...r.texts].sort()).toEqual(want)
  }, 180_000)
})
