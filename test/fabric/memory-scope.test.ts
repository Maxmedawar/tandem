/**
 * U-R1A-47: an agent's memory and transcript reach stop at its own project folder; memory text is
 * masked when saved (gate A1.19).
 *
 * An agent is a stdio server (src/stdio-server.ts) started with the caller token of a shell session
 * opened through route() (as test/agent-caller.test.ts does); the owner is one started with no
 * token. Under `memory_scope = "project"` (the default) an agent sees only fabric projects whose
 * workspaceRef holds its session's folder (caller_tokens.folder); under `transcript_scope =
 * "project"` it searches only its own folder or one under it. Every memory text is masked by
 * bridge/transcripts/redact.ts before it is stored.
 *
 * Every folder is under one mkdtemp folder named r1a47- in TMPDIR: TANDEM_HOME (state.db, the limits
 * file, Tandem's tmux socket), HOME, the work folders and the fabric database. TMUX is deleted before
 * the dynamic imports. afterAll ends every tmux server whose socket is in that folder, then removes
 * it. No real agent program starts: sessions are the pinned shell harness. Tokens and test secrets
 * are built at run time, compared in code and never printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL('../..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a47-')))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
const HOME = join(BOX, 'home')
const CONFIG = join(BOX, 'claude-config')
const CODEX = join(BOX, 'codex-home')
const W = join(BOX, 'w')
const X = join(W, 'x')
const Y = join(W, 'y')
const X2 = join(W, 'x2')
const XSUB = join(X, 'sub')
const Z = join(HOME, 'w', 'z')
const LNK = join(BOX, 'lnk')
for (const d of [HOME, CONFIG, CODEX, X, Y, X2, XSUB, Z]) mkdirSync(d, { recursive: true })
mkdirSync(TH, { recursive: true, mode: 0o700 })
chmodSync(TH, 0o700)
symlinkSync(X, LNK)
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.env.CODEX_HOME = CODEX
process.env.CCM_CWD_ALLOWLIST = BOX
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.TANDEM_WAIT_MS = '8000'
process.env.SHELL = '/bin/sh'
delete process.env.TANDEM_ALLOW_BYPASS

const tokens = await import('../../bridge/caller-tokens.ts')
const { route } = await import('../../bridge/router.ts')
const { loadedHarnesses, resetHarnessCache } = await import('../../bridge/engine-registry.ts')
const limits = await import('../../bridge/limits.ts')
const { agentEntry, writeLimits } = await import('../fixtures/limits.ts')
const fabricClient = await import('../../bridge/fabric/sqlite-fabric-client.ts')
const { openTranscriptSearch } = await import('../../bridge/transcripts/search.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const DB = join(TH, 'state.db')
const FABRIC_DB = join(BOX, 'fabric', 'fabric.sqlite3')
const FABRIC = { CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: FABRIC_DB }
const DENIED = { error: 'fabric_operation_denied' }
const INVALID = { error: 'fabric_request_invalid' }
const NO_FOLDER = (field: string) => ({ error: `${field}: this session has no recorded folder; reopen it through Tandem` })
const FORWARD_REFUSED = {
  error: 'memory_scope: an agent\'s memory calls cannot be limited to its project on another computer\'s memory home yet; the owner can set memory_scope = "all" on this computer',
}
const TRANSCRIPT_REFUSED = { error: 'transcript_scope: an agent searches only its own session\'s folder or one under it' }
const MEMORY_SCOPE_TEXT = 'wrong type for memory_scope: expected "project" or "all"'
const TRANSCRIPT_SCOPE_TEXT = 'wrong type for transcript_scope: expected "project" or "computer" ("all" needs search across computers, which is not built)'
const UNKNOWN_PROJECT = 'project-00000000-0000-0000-0000-000000000000'
const FABRIC_TOOLS = [
  'memory_forget', 'memory_get', 'memory_promote', 'memory_remember', 'memory_search',
  'project_archive', 'project_create', 'project_get', 'project_list', 'room_post', 'room_read',
]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Test secrets, built from parts at run time and never written whole in this file. */
const pick = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('')
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const akia = () => 'AK' + 'IA' + pick(UPPER, 16)
const KEY1 = akia()
const KEY2 = akia()
const KEY3 = akia()
const PEM_BODY = randomBytes(48).toString('base64')
const PEM = ['-----BEGIN ', 'PRIVATE KEY-----\n', PEM_BODY, '\n-----END ', 'PRIVATE KEY-----'].join('')
const ENV_SECRET = 'r47' + randomBytes(18).toString('base64url')
const SHORT_SECRET = pick('bcdfghjkmnpqrstvwxz', 6)
const SECRET_ENV = { R1A47_API_TOKEN: ENV_SECRET, R1A47_SHORT_PASSWORD: SHORT_SECRET }

let BASE_LIMITS: Record<string, unknown> = {}
function setLimits(extra: Record<string, unknown> = {}) {
  writeLimits(TH, { ...BASE_LIMITS, ...extra })
  limits.applyLimits()
}

const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body })

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(100)
  }
  return test()
}
/** The TANDEM_CALLER_TOKEN inside ccm-<name> (a shell session), through a file read and removed at once. */
async function tokenOf(name: string): Promise<string> {
  const file = join(BOX, `tok-${name}`)
  await rq('POST', `/sessions/${name}/send`, { text: `printf %s "$TANDEM_CALLER_TOKEN" > '${file}'` })
  await until(() => existsSync(file) && statSync(file).size > 0, 5_000)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  rmSync(file, { force: true })
  return text
}
async function openSession(name: string, cwd: string): Promise<string> {
  const opened = await rq('POST', '/sessions/open', { engine: 'shell', name, cwd })
  if (opened.status !== 200) throw new Error(`open ${name}: ${opened.status}`)
  return tokenOf(name)
}
/** A file's bytes, read by a `cat` child (closing a SQLite file's descriptor here would drop its locks). */
const bytesOf = (file: string): Buffer => (existsSync(file) ? spawnSync('cat', [file], { maxBuffer: 256 * 1024 * 1024 }).stdout : Buffer.alloc(0))

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANDEM_') || key.startsWith('CCM_')) continue
    env[key] = value
  }
  return Object.assign(env, {
    HOME, TANDEM_HOME: TH, TMUX_TMPDIR: BOX, TANDEM_CWD_ALLOWLIST: BOX, TANDEM_ENABLED_ENGINES: 'shell',
    TANDEM_WAIT_MS: '8000', SHELL: '/bin/sh', NODE_NO_WARNINGS: '1',
  }, extra)
}

interface Child {
  err: { text: string }
  call(name: string, args?: Record<string, unknown>): Promise<Json>
  tools(): Promise<Json[]>
  close(): Promise<void>
}
const CHILDREN: Child[] = []
async function startChild(extra: Record<string, string> = {}): Promise<Child> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--experimental-strip-types', 'src/stdio-server.ts'], cwd: repo, stderr: 'pipe', env: childEnv(extra),
  })
  const err = { text: '' }
  transport.stderr?.on('data', (d) => { err.text += d })
  const client = new Client({ name: 'r1a47', version: '0.0.0' })
  await client.connect(transport)
  const child: Child = {
    err,
    async call(name, args = {}) {
      const text = ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text
      return JSON.parse(text)
    },
    async tools() {
      return (await client.listTools()).tools as Json[]
    },
    close: () => client.close(),
  }
  CHILDREN.push(child)
  return child
}

let owner: Child
let agentX: Child
let TOKEN_X = ''
let PX = ''
let PY = ''
let MX = ''
let MY = ''
let EY = ''
const SHARED = 'r1a47shared'
/** Well-formed arguments for each of the 11 fabric tools, all naming the agent's own project X. */
const toolArgs = (): Record<string, Record<string, unknown>> => ({
  memory_forget: { projectId: PX, id: MX }, memory_get: { projectId: PX, id: MX },
  memory_promote: { projectId: PX, roomEventId: EY, kind: 'fact', importance: 0.5, idempotencyKey: 'tool-args' },
  memory_remember: { projectId: PX, scope: 'project', kind: 'fact', text: 'r1a47 tool args', importance: 0.5 },
  memory_search: { projectId: PX, query: SHARED }, project_archive: { projectId: PX },
  project_create: { displayName: 'tool args', workspaceRef: X }, project_get: { projectId: PX }, project_list: {},
  room_post: { projectId: PX, room: 'r47', type: 'message', body: 'tool args', idempotencyKey: 'tool-args' }, room_read: { projectId: PX, room: 'r47' },
})
const ids = (list: Json): string[] => (Array.isArray(list) ? list.map((p: Json) => p.projectId) : [])
const recordIds = (answer: Json): string[] => (Array.isArray(answer?.records) ? answer.records.map((r: Json) => r.id) : [])

beforeAll(async () => {
  resetHarnessCache()
  const sh = loadedHarnesses().get('shell')
  if (!sh) throw new Error('the shell harness file did not load')
  BASE_LIMITS = { folders: [X, Y, X2, Z], shell: true, agents: { shell: agentEntry(sh) } }
  setLimits()
  TOKEN_X = await openSession('r1a47-x', X)
  if (!/^[A-Za-z0-9_-]{43}$/.test(TOKEN_X)) throw new Error('r1a47-x: no caller token')
  owner = await startChild(FABRIC)
  agentX = await startChild({ ...FABRIC, ...SECRET_ENV, TANDEM_CALLER_TOKEN: TOKEN_X })
  PX = (await owner.call('project_create', { displayName: 'X', workspaceRef: X })).projectId
  PY = (await owner.call('project_create', { displayName: 'Y', workspaceRef: Y })).projectId
  MX = (await owner.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text: `${SHARED} alpha kept in X`, importance: 0.5 })).id
  MY = (await owner.call('memory_remember', { projectId: PY, scope: 'project', kind: 'fact', text: `${SHARED} beta kept in Y`, importance: 0.5 })).id
  EY = (await owner.call('room_post', { projectId: PY, room: 'r47', type: 'decision', body: 'r1a47 Y room decision', idempotencyKey: 'y-1' })).id
  for (const [what, v] of Object.entries({ PX, PY, MX, MY, EY })) if (typeof v !== 'string') throw new Error(`setup: ${what} missing`)
})

afterAll(async () => {
  for (const c of CHILDREN) await c.close().catch(() => {})
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  // A child or a pane still closing may write one last file while the folder goes: retried.
  rmSync(BOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('(m1) the limits file: memory_scope and transcript_scope', () => {
  afterAll(() => setLimits())

  it('(47) (m1) memory_scope "project"/"all" and transcript_scope "project"/"computer" load', () => {
    for (const [m, t] of [['project', 'project'], ['all', 'computer']]) {
      setLimits({ memory_scope: m, transcript_scope: t })
      const s = limits.limitsSnapshot()
      expect(s.problem).toBeUndefined()
      expect([s.memory_scope, s.transcript_scope]).toEqual([m, t])
    }
  })

  it('(47) (m1) a wrong memory_scope or transcript_scope refuses the file with the exact text, and both read "project"', () => {
    const rows: [string, unknown, string][] = [
      ...['Project', 1, 'everything'].map((v): [string, unknown, string] => ['memory_scope', v, MEMORY_SCOPE_TEXT]),
      ...['Project', 1, 'everything', 'all'].map((v): [string, unknown, string] => ['transcript_scope', v, TRANSCRIPT_SCOPE_TEXT]),
    ]
    for (const [field, value, text] of rows) {
      setLimits({ [field]: value })
      const s = limits.limitsSnapshot()
      expect(s.problem).toBe(`${limits.limitsFile()}: ${text}`)
      expect([s.memory_scope, s.transcript_scope]).toEqual(['project', 'project'])
      expect(s.folders).toEqual([])
    }
  })

  it('(47) (m1) absent fields and a missing file read "project" for both', () => {
    setLimits()
    expect([limits.limitsSnapshot().memory_scope, limits.limitsSnapshot().transcript_scope]).toEqual(['project', 'project'])
    rmSync(limits.limitsFile())
    limits.applyLimits()
    const s = limits.limitsSnapshot()
    expect(s.digest).toBe('missing')
    expect([s.memory_scope, s.transcript_scope]).toEqual(['project', 'project'])
  })

  it('(47) (m1) limitsSnapshot() keeps both fields off its listed keys, so whole-object rows hold', () => {
    setLimits({ memory_scope: 'all', transcript_scope: 'computer' })
    const s = limits.limitsSnapshot()
    expect(Object.keys(s).includes('memory_scope') || Object.keys(s).includes('transcript_scope')).toBe(false)
    expect(s.memory_scope).toBe('all')
    expect(s.transcript_scope).toBe('computer')
    expect(JSON.parse(JSON.stringify(s))).toEqual({ folders: s.folders, shell: true, permission_skip: [], agents: s.agents, digest: s.digest })
  })
})

describe('(m2) A1.19: an agent in X never reaches project Y', () => {
  const rows: [string, () => Promise<void>][] = [
    ['memory_search projectId Y is denied (an agent reads project Y)', async () => {
      expect(await agentX.call('memory_search', { projectId: PY, query: SHARED })).toEqual(DENIED)
    }],
    ['memory_search projectId X returns X\'s memory only', async () => {
      const found = await agentX.call('memory_search', { projectId: PX, query: SHARED })
      expect(recordIds(found)).toContain(MX)
      expect(recordIds(found).includes(MY)).toBe(false)
      expect(found.records.every((r: Json) => r.projectId === PX)).toBe(true)
    }],
    ['memory_search with no projectId is denied', async () => {
      expect(await agentX.call('memory_search', { query: SHARED })).toEqual(DENIED)
    }],
    ['project_list lists X and not Y', async () => {
      const listed = ids(await agentX.call('project_list'))
      expect(listed).toContain(PX)
      expect(listed.includes(PY)).toBe(false)
    }],
    ['project_get Y answers as an unknown project does', async () => {
      const unknown = await agentX.call('project_get', { projectId: UNKNOWN_PROJECT })
      expect(await agentX.call('project_get', { projectId: PY })).toEqual(unknown)
      expect((await agentX.call('project_get', { projectId: PX }))?.projectId).toBe(PX)
    }],
    ['project_archive Y is denied', async () => {
      expect(await agentX.call('project_archive', { projectId: PY })).toEqual(DENIED)
    }],
    ['room_read Y is denied', async () => {
      expect(await agentX.call('room_read', { projectId: PY, room: 'r47' })).toEqual(DENIED)
    }],
    ['room_post Y is denied', async () => {
      expect(await agentX.call('room_post', { projectId: PY, room: 'r47', type: 'message', body: 'from x', idempotencyKey: 'x-into-y' })).toEqual(DENIED)
    }],
    ['memory_remember into Y, or with no projectId, is denied', async () => {
      expect(await agentX.call('memory_remember', { projectId: PY, scope: 'project', kind: 'fact', text: 'x writes into y', importance: 0.5 })).toEqual(DENIED)
      expect(await agentX.call('memory_remember', { scope: 'agent', kind: 'fact', text: 'x writes with no project', importance: 0.5 })).toEqual(DENIED)
    }],
    ['memory_remember in X superseding Y\'s memory is denied', async () => {
      expect(await agentX.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text: 'x replaces y', importance: 0.5, supersedes: MY })).toEqual(DENIED)
    }],
    ['memory_get of Y\'s memory is not returned (projectId X, Y or none)', async () => {
      for (const args of [{ projectId: PX, id: MY }, { projectId: PY, id: MY }, { id: MY }]) {
        expect(await agentX.call('memory_get', args)).toEqual(DENIED)
      }
    }],
    ['memory_forget of Y\'s memory is denied and the owner still finds it', async () => {
      for (const args of [{ projectId: PX, id: MY }, { projectId: PY, id: MY }, { id: MY }]) {
        expect(await agentX.call('memory_forget', args)).toEqual(DENIED)
      }
      expect((await owner.call('memory_get', { projectId: PY, id: MY })).id).toBe(MY)
    }],
    ['memory_promote from Y\'s room is denied', async () => {
      expect(await agentX.call('memory_promote', { projectId: PY, roomEventId: EY, kind: 'decision', importance: 0.5, idempotencyKey: 'x-promote-y' })).toEqual(DENIED)
    }],
    ['its own project X works on every path', async () => {
      const e = await agentX.call('room_post', { projectId: PX, room: 'r47', type: 'message', body: 'x in x', idempotencyKey: 'x-in-x' })
      expect(typeof e.id).toBe('string')
      expect((await agentX.call('room_read', { projectId: PX, room: 'r47' })).events.map((v: Json) => v.id)).toContain(e.id)
      expect((await agentX.call('memory_get', { projectId: PX, id: MX })).id).toBe(MX)
      const m = await agentX.call('memory_remember', { projectId: PX, scope: 'agent', kind: 'fact', text: 'r1a47 x agent note', importance: 0.5 })
      expect(typeof m.id).toBe('string')
    }],
  ]
  it.each(rows)('(47) (m2) %s', async (_title, row) => {
    await row()
  })
})

describe('(m3) (m4) widened by the owner, and the owner unchanged', () => {
  afterAll(() => setLimits())

  it('(47) (m4) the owner sees X and Y on every path under memory_scope "project"', async () => {
    const listed = ids(await owner.call('project_list'))
    expect(listed).toEqual(expect.arrayContaining([PX, PY]))
    expect(recordIds(await owner.call('memory_search', { projectId: PY, query: SHARED }))).toContain(MY)
    expect(recordIds(await owner.call('memory_search', { projectId: PX, query: SHARED }))).toContain(MX)
    expect((await owner.call('project_get', { projectId: PY })).projectId).toBe(PY)
    expect((await owner.call('room_read', { projectId: PY, room: 'r47' })).events.map((v: Json) => v.id)).toContain(EY)
  })

  it('(47) (m3) memory_scope = "all": a fresh agent child of the same session reads Y as before this unit', async () => {
    setLimits({ memory_scope: 'all' })
    const wide = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: TOKEN_X })
    expect(recordIds(await wide.call('memory_search', { projectId: PY, query: SHARED }))).toContain(MY)
    expect(ids(await wide.call('project_list'))).toEqual(expect.arrayContaining([PX, PY]))
    expect((await wide.call('room_read', { projectId: PY, room: 'r47' })).events.map((v: Json) => v.id)).toContain(EY)
    // The child started under "project" keeps it: limits are read at a process's start.
    expect(await agentX.call('memory_search', { projectId: PY, query: SHARED })).toEqual(DENIED)
    await wide.close()
  })

  it('(47) (m4) the owner sees X and Y under memory_scope "all" too', async () => {
    setLimits({ memory_scope: 'all' })
    const owner2 = await startChild(FABRIC)
    expect(ids(await owner2.call('project_list'))).toEqual(expect.arrayContaining([PX, PY]))
    expect(recordIds(await owner2.call('memory_search', { projectId: PY, query: SHARED }))).toContain(MY)
    await owner2.close()
  })
})

describe('(m5) project_create by an agent', () => {
  it('(47) (m5) a workspaceRef outside its folder, a relative one, or none is 400 fabric_request_invalid', async () => {
    for (const ref of [Y, W, '/', 'w/x', `${X}/../y`, X2, undefined]) {
      const args: Record<string, unknown> = { displayName: 'out' }
      if (ref !== undefined) args.workspaceRef = ref
      expect(await agentX.call('project_create', args)).toEqual(INVALID)
    }
  })

  it('(47) (m5) its own folder and one under it are created; a project at its folder is listed as its own, one under it is its sub-folder session\'s own', async () => {
    const at = await agentX.call('project_create', { displayName: 'at x', workspaceRef: X })
    const sub = await agentX.call('project_create', { displayName: 'x sub', workspaceRef: XSUB })
    expect(typeof at.projectId).toBe('string')
    expect(typeof sub.projectId).toBe('string')
    const listed = ids(await agentX.call('project_list'))
    expect(listed).toContain(at.projectId)
    // Own = its workspaceRef holds the session's folder; x/sub does not hold x.
    expect(listed.includes(sub.projectId)).toBe(false)
    const token = await openSession('r1a47-xsub', XSUB)
    const agentSub = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: token })
    const subListed = ids(await agentSub.call('project_list'))
    expect(subListed).toEqual(expect.arrayContaining([sub.projectId, at.projectId, PX]))
    expect(subListed.includes(PY)).toBe(false)
    await agentSub.close()
  })
})

describe('(m6) (m7) which workspaceRef is an agent\'s own', () => {
  it('(47) (m6) projects at /, HOME, HOME\'s parent, a relative path and a missing folder are nobody\'s own', async () => {
    const refs = ['/', HOME, dirname(HOME), 'w/z', join(HOME, 'w', 'missing')]
    const made: string[] = []
    for (const ref of refs) {
      const p = await owner.call('project_create', { displayName: `bad ${ref}`, workspaceRef: ref })
      expect(typeof p.projectId).toBe('string')
      made.push(p.projectId)
    }
    const token = await openSession('r1a47-z', Z)
    const agentZ = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: token })
    expect(await agentZ.call('project_list')).toEqual([])
    for (const projectId of made) {
      expect(await agentZ.call('memory_search', { projectId, query: SHARED })).toEqual(DENIED)
      expect(await agentZ.call('room_read', { projectId, room: 'r47' })).toEqual(DENIED)
    }
    await agentZ.close()
  })

  it('(47) (m7) a workspaceRef through a symlink to its folder is own; x/../y is not; a session in x2 does not own a project at x', async () => {
    const viaLink = (await owner.call('project_create', { displayName: 'link', workspaceRef: LNK })).projectId
    const dotted = (await owner.call('project_create', { displayName: 'dotted', workspaceRef: `${X}/../y` })).projectId
    const listed = ids(await agentX.call('project_list'))
    expect(listed).toContain(viaLink)
    expect(listed.includes(dotted)).toBe(false)
    expect((await agentX.call('memory_search', { projectId: viaLink, query: SHARED })).error).toBeUndefined()
    expect(await agentX.call('memory_search', { projectId: dotted, query: SHARED })).toEqual(DENIED)
    const token = await openSession('r1a47-x2', X2)
    const agentX2 = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: token })
    const listed2 = ids(await agentX2.call('project_list'))
    expect(listed2.includes(PX) || listed2.includes(viaLink)).toBe(false)
    expect(await agentX2.call('memory_search', { projectId: PX, query: SHARED })).toEqual(DENIED)
    await agentX2.close()
  })

  it('(47) (m7) the folder rule in sqlite-fabric-client.ts gives the same answer as transcripts search.ts\'s projectOf on one table', async () => {
    const search = openTranscriptSearch({ path: join(BOX, 'drift', 'search.sqlite3') })
    try {
      const table = ['/', HOME, `${HOME}/`, dirname(HOME), BOX, W, X, `${X}/`, `${X}/../y`, LNK, XSUB, Z, join(HOME, 'w', 'missing'),
        'w/x', '', '.', '/nonexistent-r1a47/a', `${X}\0`, '/usr', dirname(realpathSync(tmpdir()))]
      for (const p of table) {
        const copy = fabricClient.projectFolderOf(p)
        const answer = await search.get({ hash: '0'.repeat(64), project: p })
        expect([p, copy === undefined]).toEqual([p, answer.status === 400])
      }
    } finally {
      search.close()
    }
  })
})

describe('(m8) (m9) memory text is masked when saved', () => {
  it('(47) (m8) a key, a private key block and a secret env value come back masked from memory_get and memory_search', async () => {
    const text = `r1a47m8 note ${KEY1} then ${PEM} and ${ENV_SECRET} end`
    const saved = await agentX.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text, importance: 0.5 })
    expect(typeof saved.id).toBe('string')
    const got = await agentX.call('memory_get', { projectId: PX, id: saved.id })
    const found = await agentX.call('memory_search', { projectId: PX, query: 'r1a47m8' })
    expect(recordIds(found)).toContain(saved.id)
    for (const answer of [saved, got, found]) {
      const s = JSON.stringify(answer)
      expect(s.includes('[secret:')).toBe(true)
      expect([KEY1, PEM_BODY, ENV_SECRET].map((v) => s.includes(v))).toEqual([false, false, false])
    }
  })

  it('(47) (m8) the fabric database and its WAL hold none of the three values', () => {
    const bytes = [bytesOf(FABRIC_DB), bytesOf(`${FABRIC_DB}-wal`)]
    expect(bytes[0].length > 0).toBe(true)
    for (const b of bytes) {
      expect([KEY1, PEM_BODY, ENV_SECRET].map((v) => b.includes(Buffer.from(v)))).toEqual([false, false, false])
    }
  })

  it('(47) (m8) two memories that differ only in the secret merge into one (the digest is of the masked text)', async () => {
    const a = await agentX.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text: `r1a47dup deploy key ${KEY1}`, importance: 0.4 })
    const b = await agentX.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text: `r1a47dup deploy key ${KEY2}`, importance: 0.6 })
    expect(typeof a.id).toBe('string')
    expect(b.id).toBe(a.id)
    expect(JSON.stringify(b).includes(KEY2)).toBe(false)
  })

  it('(47) (m8) memory_promote of a room event holding a key stores a masked memory', async () => {
    const e = await agentX.call('room_post', { projectId: PX, room: 'r47', type: 'decision', body: `r1a47promote use ${KEY3}`, idempotencyKey: 'x-key' })
    expect(typeof e.id).toBe('string')
    const m = await agentX.call('memory_promote', { projectId: PX, roomEventId: e.id, kind: 'decision', importance: 0.5, idempotencyKey: 'x-key-promote' })
    expect(typeof m.id).toBe('string')
    const got = JSON.stringify(await agentX.call('memory_get', { projectId: PX, id: m.id }))
    expect(got.includes('[secret:aws-key]')).toBe(true)
    expect(got.includes(KEY3)).toBe(false)
  })

  it('(47) (m9) a text whose masked form is over the limit is 400 fabric_request_invalid and nothing is stored', async () => {
    const text = `r1a47m9 ${`${SHORT_SECRET} `.repeat(2000)}`
    expect(Buffer.byteLength(text) <= 16_384).toBe(true)
    // Compared in code: a stored answer would hold the test secret.
    const answer = await agentX.call('memory_remember', { projectId: PX, scope: 'project', kind: 'fact', text, importance: 0.5 })
    expect(typeof answer?.error === 'string' ? answer : 'stored, not refused').toEqual(INVALID)
    // Search also admits near neighbours by meaning: nothing whose text holds the word was stored.
    const found = await owner.call('memory_search', { projectId: PX, query: 'r1a47m9' })
    expect(Array.isArray(found.records)).toBe(true)
    expect(found.records.filter((r: Json) => String(r.text).includes('r1a47m9')).map((r: Json) => r.id)).toEqual([])
  })
})

describe('(m10) transcripts: an agent searches only its own folder', () => {
  afterAll(() => setLimits())

  it('(47) (m10) transcript_scope "project": Y is 403 with the exact text, X and a folder under it are searched', async () => {
    expect(await agentX.call('transcript_search', { query: 'anything', project: Y })).toEqual(TRANSCRIPT_REFUSED)
    expect(await agentX.call('transcript_get', { hash: '0'.repeat(64), project: Y })).toEqual(TRANSCRIPT_REFUSED)
    for (const project of [W, `${X}/../y`, X2, join(X, 'missing')]) {
      expect(await agentX.call('transcript_search', { query: 'anything', project })).toEqual(TRANSCRIPT_REFUSED)
    }
    for (const project of [X, XSUB, LNK]) {
      const r = await agentX.call('transcript_search', { query: 'anything', project })
      expect(r.error).toBeUndefined()
      expect(Array.isArray(r.results)).toBe(true)
    }
    expect(await agentX.call('transcript_get', { hash: '0'.repeat(64), project: X })).toEqual({ error: 'not found' })
  })

  it('(47) (m10) the owner is always searched', async () => {
    for (const project of [X, Y]) expect((await owner.call('transcript_search', { query: 'anything', project })).error).toBeUndefined()
  })

  it('(47) (m10) transcript_scope "computer": a fresh agent child searches Y', async () => {
    setLimits({ transcript_scope: 'computer' })
    const wide = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: TOKEN_X })
    const r = await wide.call('transcript_search', { query: 'anything', project: Y })
    expect(r.error).toBeUndefined()
    expect(Array.isArray(r.results)).toBe(true)
    await wide.close()
  })
})

describe('(m11) a caller_tokens row without a folder', () => {
  it('(47) (m11) fabric and transcript tools answer the exact no-folder errors and nothing reaches the fabric', async () => {
    const token = await openSession('r1a47-nf', X)
    // The minted row (one INSERT that stores the folder) gets its folder cleared, as a row written
    // before this unit would read.
    const db = new DatabaseSync(DB)
    try {
      expect(Number(db.prepare('UPDATE caller_tokens SET folder = NULL WHERE name = ?').run('r1a47-nf').changes)).toBe(1)
    } finally {
      db.close()
    }
    const nf = await startChild({ ...FABRIC, TANDEM_CALLER_TOKEN: token })
    const args = toolArgs()
    for (const tool of FABRIC_TOOLS) expect([tool, await nf.call(tool, args[tool])]).toEqual([tool, NO_FOLDER('memory_scope')])
    expect(await nf.call('transcript_search', { query: 'anything', project: X })).toEqual(NO_FOLDER('transcript_scope'))
    expect(await nf.call('transcript_get', { hash: '0'.repeat(64), project: X })).toEqual(NO_FOLDER('transcript_scope'))
    expect(nf.err.text.includes('[fabric-audit]')).toBe(false)
    // The same calls from a session with a folder do reach the fabric and leave audit lines.
    expect(agentX.err.text.includes('[fabric-audit]')).toBe(true)
    expect((await owner.call('memory_get', { projectId: PX, id: MX })).id).toBe(MX)
    await nf.close()
  })
})

describe('(m12) a hub forwarder (the memory home is another computer)', () => {
  let server: Server
  const seen: string[] = []
  let url = ''
  const HUB_TOKEN = `r1a47-hub-${randomBytes(12).toString('hex')}`
  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request.url ?? '')
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    setLimits()
    await new Promise((done) => server.close(done))
  })

  it('(47) (m12) memory_scope "project": every fabric tool answers the forwarder error and the hub gets no call', async () => {
    const fwd = await startChild({ TANDEM_HUB_LINK_URL: url, TANDEM_HUB_LINK_TOKEN: HUB_TOKEN, TANDEM_CALLER_TOKEN: TOKEN_X })
    const listed = (await fwd.tools()).map((t) => t.name)
    expect(listed).toEqual(expect.arrayContaining(FABRIC_TOOLS))
    const args = toolArgs()
    for (const tool of FABRIC_TOOLS) expect([tool, await fwd.call(tool, args[tool])]).toEqual([tool, FORWARD_REFUSED])
    expect(seen).toEqual([])
    await fwd.close()
  })

  it('(47) (m12) memory_scope "all": the call is forwarded', async () => {
    setLimits({ memory_scope: 'all' })
    const fwd = await startChild({ TANDEM_HUB_LINK_URL: url, TANDEM_HUB_LINK_TOKEN: HUB_TOKEN, TANDEM_CALLER_TOKEN: TOKEN_X })
    const answer = await fwd.call('memory_search', { projectId: PX, query: SHARED })
    expect(answer).not.toEqual(FORWARD_REFUSED)
    expect(seen).toEqual(['/__tunnel/fabric-rpc/fabric/memory/search'])
    await fwd.close()
  })
})

describe('(m13) no input widens an agent', () => {
  const extra = { folder: Y, actor: 'owner', caller: 'owner', agentId: 'mcp-owner-x', ownerId: 'o', projectScope: 'all' }

  it('(47) (m13) folder, actor, caller and agentId are in no fabric or transcript tool schema', async () => {
    const tools = await agentX.tools()
    for (const t of tools.filter((v) => FABRIC_TOOLS.includes(v.name) || v.name.startsWith('transcript_'))) {
      const keys = Object.keys(t.inputSchema?.properties ?? {})
      expect([t.name, keys.filter((k) => ['folder', 'actor', 'caller', 'agentId', 'ownerId'].includes(k))]).toEqual([t.name, []])
    }
  })

  it('(47) (m13) passing them changes nothing: Y stays denied and the list stays its own', async () => {
    expect(await agentX.call('memory_search', { projectId: PY, query: SHARED, ...extra })).toEqual(DENIED)
    expect(await agentX.call('room_read', { projectId: PY, room: 'r47', ...extra })).toEqual(DENIED)
    expect(ids(await agentX.call('project_list', extra)).includes(PY)).toBe(false)
    expect(await agentX.call('transcript_search', { query: 'anything', project: Y, ...extra })).toEqual(TRANSCRIPT_REFUSED)
    expect(await agentX.call('project_create', { displayName: 'wide', workspaceRef: Y, ...extra })).toEqual(INVALID)
  })
})

describe('(m14) the caller_tokens table from before this unit', () => {
  it('(47) (m14) an existing state.db without the folder column gains it at first use; old rows read folder undefined', () => {
    const old = join(BOX, 'old-home')
    mkdirSync(old, { mode: 0o700 })
    const db = new DatabaseSync(join(old, 'state.db'))
    db.exec('CREATE TABLE caller_tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_ms INTEGER NOT NULL)')
    db.prepare('INSERT INTO caller_tokens (name, hash, created_ms) VALUES (?, ?, ?)').run('r1a47-old', 'ab'.repeat(32), 1)
    db.close()
    const saved = process.env.TANDEM_HOME
    process.env.TANDEM_HOME = old
    try {
      expect(tokens.callerFolder('r1a47-old')).toBeUndefined()
      expect(tokens.callerFolder('r1a47-none')).toBeUndefined()
      const check = new DatabaseSync(join(old, 'state.db'), { readOnly: true })
      try {
        expect((check.prepare('PRAGMA table_info(caller_tokens)').all() as Json[]).map((c) => c.name)).toEqual(['name', 'hash', 'created_ms', 'folder'])
      } finally {
        check.close()
      }
      tokens.mintCallerToken('r1a47-new', X)
      expect(tokens.callerFolder('r1a47-new')).toBe(X)
      expect(() => tokens.mintCallerToken('r1a47-rel', 'w/x')).toThrow()
    } finally {
      process.env.TANDEM_HOME = saved
    }
    expect(tokens.callerFolder('r1a47-x')).toBe(X)
  })
})
