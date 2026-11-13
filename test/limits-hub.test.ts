/**
 * U-R1A-17B: the limits file's `hub_commands` and `hub_reads` are enforced where hub requests
 * arrive (bridge/hub-rpc.ts handleHubRequest), forwarded memory calls included. Local MCP calls
 * (route(), routeFabricRpc()) are unaffected; usage and signed computer-to-computer commands are not
 * gated; nothing in a hub request widens either field. Also the tool text both MCP servers show.
 *
 * Everything lives under one mkdtemp folder r1a17b-: HOME, TANDEM_HOME, the work folder. No tmux
 * session is opened: the one session is a plain registered object whose drive methods throw.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { stringify } from 'smol-toml'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const search = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    search: async () => ({ status: 200, body: { results: [] } }),
    get: async () => ({ status: 404, body: { error: 'not found' } }),
  })),
}))
vi.mock('../bridge/transcripts/search.ts', async (original) => ({ ...(await original<object>()), openTranscriptSearch: search.open }))

const repo = fileURLToPath(new URL('..', import.meta.url))
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a17b-')))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const HOME = join(BOX, 'home')
const TH = join(HOME, '.tandem')
const WORK = join(BOX, 'work')
mkdirSync(HOME, { recursive: true })
mkdirSync(TH, { recursive: true, mode: 0o700 })
mkdirSync(WORK, { recursive: true })
process.env.HOME = HOME
process.env.TANDEM_HOME = TH
for (const k of ['TANDEM_HUB_LINK_URL', 'TANDEM_HUB_LINK_TOKEN', 'TANDEM_CALLER_TOKEN']) delete process.env[k]
process.env.TANDEM_HUB_LINK_ID = 'r1a17b-home'
process.env.TANDEM_ENABLED_ENGINES = 'shell'
process.env.CCM_CWD_ALLOWLIST = WORK

const quiet = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
const limits = await import('../bridge/limits.ts')
const { handleHubRequest, fabricForward, memoryAnswerText } = await import('../bridge/hub-rpc.ts')
const { route } = await import('../bridge/router.ts')
const { routeFabricRpc } = await import('../bridge/fabric/rpc-router.ts')
const { registerLive, unregisterLive } = await import('../bridge/sessions.ts')
const { verifySignature } = await import('../bridge/device-keys.ts')
const { main } = await import('../bridge/limits-cli.ts')
const { writeLimits, writeLimitsAsGiven } = await import('./fixtures/limits.ts')
const { CCM_FRAME_TYPES } = await import('../hub/src/protocol.ts')
const { FABRIC_MCP_TRUST } = await import('../src/fabric/rpc-contract.ts')
quiet.mockRestore()

const HUB = (limits as Json).HUB_REFUSALS as Record<'commands' | 'screens' | 'transcripts' | 'memory', string>
const NOTICE = ' (notice: the limits file changed on disk and is not applied; apply it at this computer)'
const LIMITS = join(TH, 'limits.toml')
const APPLIED = join(TH, 'limits.applied.toml')
const LOG = join(TH, 'bridge.log')
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const caller = { ownerId: `owner-${'a'.repeat(64)}`, deviceId: `mcp-device-${'b'.repeat(64)}`, agentId: `mcp-owner-${'c'.repeat(64)}` }
/** True when `error` is none of the hub refusal texts (each starts with its field's name). */
const notHubText = (error: unknown) => !/^hub_(commands|reads)/.test(String(error ?? ''))
const ALL_OFF = { hub_commands: false, hub_reads: { screens: false, transcripts: false, memory: false } }

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  spawnSync('find', [BOX, '-type', 's', '-exec', 'tmux', '-S', '{}', 'kill-server', ';'])
  rmSync(BOX, { recursive: true, force: true })
})

/** Runs `run` with stdout and stderr captured. */
async function captured<T>(run: () => Promise<T> | T): Promise<{ value: T; out: string; err: string }> {
  let out = ''
  let err = ''
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Json) => { out += String(chunk); return true })
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Json) => { err += String(chunk); return true })
  try {
    return { value: await run(), out, err }
  } finally {
    o.mockRestore()
    e.mockRestore()
  }
}

/** `fields` with the hub fields a case does not name written ON (an absent field or key reads off). */
const hubOn = (fields: Record<string, unknown>) => ({
  ...fields,
  hub_commands: fields.hub_commands ?? true,
  hub_reads: { screens: true, transcripts: true, memory: true, ...(fields.hub_reads as object | undefined) },
})

/** `fields` (hub fields not named: on) written as limits.toml and applied as the owner's `tandem limits apply` does. */
const applied = (fields: Record<string, unknown>) => appliedAsWritten(hubOn(fields))

/** Exactly `fields` written as limits.toml and applied as the owner's `tandem limits apply` does. */
async function appliedAsWritten(fields: Record<string, unknown>) {
  const file = writeLimitsAsGiven(TH, fields)
  const { value } = await captured(() => limits.commitLimits(sha256(readFileSync(file))))
  expect(value).toBeUndefined()
}

/** `text` written as limits.toml with no applied copy, read as at start. */
async function rawFile(text: string) {
  rmSync(APPLIED, { force: true })
  writeFileSync(LIMITS, text, { mode: 0o600 })
  await captured(() => limits.applyLimits())
}

let seq = 0
function frame(method: string, path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string[]> } = {}) {
  const raw = opts.rawBody ?? ('body' in opts ? JSON.stringify(opts.body) : undefined)
  return {
    type: CCM_FRAME_TYPES.httpRequest,
    request_id: `r1a17b-${++seq}`,
    method,
    path,
    headers: opts.headers ?? {},
    ...(raw !== undefined ? { body_base64: Buffer.from(raw, 'utf8').toString('base64') } : {}),
  } as Json
}
type Answer = { status: number; body: Json; signed: boolean }
const answerOf = (res: Json): Answer => ({
  status: res.status_code,
  body: JSON.parse(Buffer.from(res.body_base64 ?? '', 'base64').toString('utf8')),
  signed: res.headers?.['tandem-memory-answer'] !== undefined,
})
const hub = async (method: string, path: string, opts: Parameters<typeof frame>[2] = {}, host?: Json) =>
  answerOf(await handleHubRequest(frame(method, path, opts), host))

function auditLines(): Json[] {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const calls: string[] = []
/** A registered session whose drive methods record their name and throw. */
async function withSession<T>(run: () => Promise<T>): Promise<T> {
  const thrower = (name: string) => async () => { calls.push(name); throw new Error(`r1a17b: ${name} reached`) }
  registerLive({
    id: 'r1a17b-s', engine: 'shell', cwd: WORK, isAlive: async () => true, attachHint: () => '',
    isWorking: thrower('isWorking'), send: thrower('send'), read: thrower('read'), interrupt: thrower('interrupt'), close: thrower('close'),
  } as Json)
  calls.length = 0
  try {
    return await run()
  } finally {
    unregisterLive('r1a17b-s')
  }
}

const ran: string[] = []
const host = {
  client: {
    searchMemory: async () => { ran.push('search'); return { records: [{ id: 'r1a17b-m' }] } },
    rememberMemory: async () => { ran.push('remember'); return { id: 'r1a17b-m' } },
    readRoom: async () => { ran.push('room-read'); return { messages: [] } },
    postRoom: async () => { ran.push('room-post'); return { id: 'r1a17b-p' } },
    listProjects: async () => { ran.push('list'); return { projects: [] } },
  },
  close() {},
} as Json
const fabricFrame = (path: string, headers: Record<string, string[]> = {}) =>
  ({ ...frame('POST', path, { body: { caller, input: {} }, headers }), trusted_surface: FABRIC_MCP_TRUST })

describe('(17B) p: the two fields in the limits file', () => {
  it('(17B) p1 hub_commands = false and hub_reads = { screens = false, transcripts = true, memory = false } load with no problem', async () => {
    await appliedAsWritten({ folders: [WORK], hub_commands: false, hub_reads: { screens: false, transcripts: true, memory: false } })
    const snap = limits.limitsSnapshot() as Json
    expect(snap.problem).toBeUndefined()
    expect(snap.hub_commands).toBe(false)
    expect(snap.hub_reads).toEqual({ screens: false, transcripts: true, memory: false })
  })

  it('(17B) p2 a file with neither field: both off (fail closed), and an absent hub_reads key reads off', async () => {
    await appliedAsWritten({ folders: [WORK] })
    const snap = limits.limitsSnapshot() as Json
    expect(snap.problem).toBeUndefined()
    expect(snap.hub_commands).toBe(false)
    expect(snap.hub_reads).toEqual({ screens: false, transcripts: false, memory: false })
    await appliedAsWritten({ folders: [WORK], hub_reads: { memory: true } })
    expect((limits.limitsSnapshot() as Json).problem).toBeUndefined()
    expect((limits.limitsSnapshot() as Json).hub_commands).toBe(false)
    expect((limits.limitsSnapshot() as Json).hub_reads).toEqual({ screens: false, transcripts: false, memory: true })
  })

  it('(17B) p8 an applied file written without the fields: every hub frame answers 403 until a file with the fields on is applied', async () => {
    await appliedAsWritten({ folders: [WORK] })
    ran.length = 0
    search.open.mockClear()
    const frames = [
      ['POST', '/sessions/r1a17b-none/send', { body: { text: 'r1a17b-typed' } }, HUB.commands],
      ['POST', '/sessions/open', { body: { name: 'r1a17b-new', engine: 'shell', cwd: WORK } }, HUB.commands],
      ['POST', '/r1a17b-nowhere', {}, HUB.commands],
      ['GET', '/sessions/r1a17b-none/read', {}, HUB.screens],
      ['POST', '/sessions/r1a17b-none/send', { body: {} }, HUB.screens],
      ['POST', '/transcripts/search', { body: { query: 'x' } }, HUB.transcripts],
    ] as const
    for (const [method, path, opts, text] of frames) {
      expect(await hub(method, path, opts), `${method} ${path}`).toEqual({ status: 403, body: { error: text }, signed: false })
    }
    expect(answerOf(await handleHubRequest(fabricFrame('/fabric/memory/search'), host))).toEqual({ status: 403, body: { error: HUB.memory }, signed: false })
    expect(ran).toEqual([])
    expect(search.open).not.toHaveBeenCalled()
    // The owner writes the fields on and applies: the same frames are no longer refused by the hub fields.
    await appliedAsWritten({ folders: [WORK], hub_commands: true, hub_reads: { screens: true, transcripts: true, memory: true } })
    for (const [method, path, opts] of frames.filter(([, path]) => path !== '/sessions/open' && path !== '/transcripts/search')) {
      const got = await hub(method, path, opts)
      expect(notHubText(got.body.error), `${method} ${path}`).toBe(true)
    }
    expect(notHubText(answerOf(await handleHubRequest(fabricFrame('/fabric/memory/search'), host)).body.error)).toBe(true)
  })

  it('(17B) p9 a refused frame with a 200 KB path grows the audit log by under 1 KB', async () => {
    await applied({ folders: [WORK], ...ALL_OFF })
    const size = () => (existsSync(LOG) ? readFileSync(LOG).length : 0)
    const before = size()
    const lines = auditLines().length
    const path = `/r1a17b-long/${'p'.repeat(200_000)}`
    expect(await hub('POST', path)).toEqual({ status: 403, body: { error: HUB.commands }, signed: false })
    expect(size() - before).toBeLessThan(1024)
    const [line] = auditLines().slice(lines)
    expect(line).toMatchObject({ denied: 'hub_commands', hub: true })
    expect(line.route).toBe(`${`POST ${path}`.slice(0, 200)}…`)
  })

  it.each([
    ['hub_commands = "no"\n', 'wrong type for hub_commands: expected true or false'],
    ['hub_reads = true\n', 'wrong type for hub_reads: expected a table { screens, transcripts, memory } of true or false'],
    ['hub_reads = { screens = 1 }\n', 'wrong type for hub_reads.screens: expected true or false'],
    ['hub_reads = { files = true }\n', 'unknown field hub_reads.files'],
  ])('(17B) p3 %j refuses the file with its reason, and every hub field reads off', async (text, reason) => {
    await rawFile(text)
    const snap = limits.limitsSnapshot() as Json
    expect(snap.problem).toBe(`${limits.limitsFile()}: ${reason}`)
    expect(snap.hub_commands).toBe(false)
    expect(snap.hub_reads).toEqual({ screens: false, transcripts: false, memory: false })
    const gate = (limits.limitsGate() as Json)
    for (const what of ['commands', 'screens', 'transcripts', 'memory'] as const) expect(gate.hub(what)).toBe(HUB[what])
  })

  it('(17B) p4 no file at all: every hub field off, and a hub request answers 403', async () => {
    rmSync(LIMITS, { force: true })
    rmSync(APPLIED, { force: true })
    await captured(() => limits.applyLimits())
    const snap = limits.limitsSnapshot() as Json
    expect(snap.digest).toBe('missing')
    expect(snap.hub_commands).toBe(false)
    expect(snap.hub_reads).toEqual({ screens: false, transcripts: false, memory: false })
    expect(await hub('POST', '/sessions/r1a17b-none/send', { body: { text: 'r1a17b' } })).toEqual({ status: 403, body: { error: HUB.commands }, signed: false })
    expect(await hub('GET', '/sessions/r1a17b-none/read')).toEqual({ status: 403, body: { error: HUB.screens }, signed: false })
  })

  it('(17B) p5 the snapshot holds both fields but does not list them', async () => {
    await applied({ folders: [WORK], hub_commands: false, hub_reads: { transcripts: false } })
    const snap = limits.limitsSnapshot() as Json
    const listed = JSON.parse(JSON.stringify(snap))
    expect(Object.keys(listed)).not.toContain('hub_commands')
    expect(Object.keys(listed)).not.toContain('hub_reads')
    expect(snap.hub_commands).toBe(false)
    expect(snap.hub_reads).toEqual({ screens: true, transcripts: false, memory: true })
  })

  it('(17B) p6 FIELDS ends with both, INIT_DEFAULTS holds both on, and the init-shaped file loads with both on', async () => {
    expect(limits.FIELDS.slice(-2)).toEqual(['hub_commands', 'hub_reads'])
    expect((limits.INIT_DEFAULTS as Json).hub_commands).toBe(true)
    expect((limits.INIT_DEFAULTS as Json).hub_reads).toEqual({ screens: true, transcripts: true, memory: true })
    rmSync(APPLIED, { force: true })
    writeFileSync(LIMITS, stringify({ folders: [], agents: {}, ...limits.INIT_DEFAULTS } as Json), { mode: 0o600 })
    await captured(() => limits.applyLimits())
    const snap = limits.limitsSnapshot() as Json
    expect(snap.problem).toBeUndefined()
    expect(snap.hub_commands).toBe(true)
    expect(snap.hub_reads).toEqual({ screens: true, transcripts: true, memory: true })
  })

  it('(17B) p9 a refused frame with a 200 KB path grows the audit log by under 1 KB', async () => {
    await applied({ folders: [WORK], ...ALL_OFF })
    const size = () => (existsSync(LOG) ? readFileSync(LOG).length : 0)
    const before = size()
    const lines = auditLines().length
    const path = `/r1a17b-long/${'p'.repeat(200_000)}`
    expect(await hub('POST', path)).toEqual({ status: 403, body: { error: HUB.commands }, signed: false })
    expect(size() - before).toBeLessThan(1024)
    const [line] = auditLines().slice(lines)
    expect(line).toMatchObject({ denied: 'hub_commands', hub: true })
    expect(line.route).toBe(`${`POST ${path}`.slice(0, 200)}…`)
  })

  it('(17B) p7 tandem limits apply shows a hub_reads change as one line and applies it', async () => {
    await applied({ folders: [WORK], agents: {}, ...limits.INIT_DEFAULTS })
    writeLimits(TH, { folders: [WORK], agents: {}, ...limits.INIT_DEFAULTS, hub_reads: { screens: false, transcripts: true, memory: true } })
    const input = Object.assign(new PassThrough(), { isTTY: true })
    input.write('yes\n')
    const r = await captured(() => main(['apply'], { input }))
    expect(r.value, r.out + r.err).toBe(0)
    expect(r.out.split('\n')).toContain('  hub_reads: {"screens":true,"transcripts":true,"memory":true} -> {"screens":false,"transcripts":true,"memory":true}')
    expect((limits.limitsSnapshot() as Json).hub_reads.screens).toBe(false)
  })
})

describe('(17B) h: hub_commands', () => {
  it('(17B) h1 hub_commands = false: every command passed on by the hub answers 403, nothing reaches the session, each refusal is logged', async () => {
    await applied({ folders: [WORK], hub_commands: false })
    await withSession(async () => {
      const before = auditLines().length
      const frames: [string, string, unknown][] = [
        ['POST', '/sessions/r1a17b-s/send', { text: 'r1a17b-typed' }],
        ['POST', '/sessions/r1a17b-s/interrupt', undefined],
        ['POST', '/sessions/r1a17b-s/close', undefined],
        ['POST', '/sessions/open', { name: 'r1a17b-new', engine: 'shell', cwd: WORK }],
        ['POST', '/relay/start', { goal: 'r1a17b', cwd: WORK }],
        ['POST', '/relay/r1a17b-loop/inject', { message: 'x' }],
        ['POST', '/relay/r1a17b-loop/enqueue', { task: 'x' }],
        ['POST', '/relay/r1a17b-loop/stop', undefined],
        ['POST', '/r1a17b-nowhere', undefined],
      ]
      for (const [method, path, body] of frames) {
        expect(await hub(method, path, body === undefined ? {} : { body }), path).toEqual({ status: 403, body: { error: HUB.commands }, signed: false })
      }
      expect(calls).toEqual([])
      const lines = auditLines().slice(before)
      expect(lines).toHaveLength(frames.length)
      lines.forEach((line, i) => {
        expect(line).toMatchObject({ route: `${frames[i][0]} ${frames[i][1]}`, denied: 'hub_commands', hub: true })
        expect(line).not.toHaveProperty('forwarded')
      })
    })
  })

  it('(17B) h2 hub_commands = false: the list and reads still answer', async () => {
    await applied({ folders: [WORK], hub_commands: false })
    const list = await hub('GET', '/sessions')
    expect(list.status).not.toBe(403)
    const read = await hub('GET', '/sessions/r1a17b-none/read')
    expect(read.body.error).not.toBe(HUB.commands)
    expect((limits.limitsGate() as Json).hub('commands')).toBe(HUB.commands)
    const local = await route({ method: 'GET', path: '/sessions/r1a17b-none/read', query: new URLSearchParams(), body: {} })
    expect({ status: read.status, body: read.body }).toEqual({ status: local.status, body: local.body })
  })

  it('(17B) h3 hub_commands on: a send gets the router\'s own answer, never the hub text', async () => {
    await applied({ folders: [WORK] })
    const sent = await hub('POST', '/sessions/r1a17b-none/send', { body: { text: 'x' } })
    const local = await route({ method: 'POST', path: '/sessions/r1a17b-none/send', query: new URLSearchParams(), body: { text: 'x' } })
    expect({ status: sent.status, body: sent.body }).toEqual({ status: local.status, body: local.body })
    expect(notHubText(sent.body.error)).toBe(true)
  })
})

describe('(17B) s: hub_reads.screens', () => {
  it('(17B) s1 screens off: reads and polls answer 403; the list and a send with text still pass', async () => {
    await applied({ folders: [WORK], hub_reads: { screens: false } })
    await withSession(async () => {
      for (const [method, path, opts] of [
        ['GET', '/sessions/r1a17b-s/read', {}],
        ['POST', '/sessions/r1a17b-s/send', { body: { text: '' } }],
        ['POST', '/sessions/r1a17b-s/send', { body: {} }],
        ['GET', '/relay/r1a17b-loop/read', {}],
      ] as const) {
        expect(await hub(method, path, opts), `${method} ${path}`).toEqual({ status: 403, body: { error: HUB.screens }, signed: false })
      }
      expect(calls).toEqual([])
      expect((await hub('GET', '/sessions')).status).not.toBe(403)
      const typed = await hub('POST', '/sessions/r1a17b-s/send', { body: { text: 'r1a17b-typed' } })
      expect(typed.status).not.toBe(403)
      expect(notHubText(typed.body.error)).toBe(true)
    })
  })
})

describe('(17B) t: hub_reads.transcripts', () => {
  it('(17B) t1 transcripts off: search and get answer 403 and the search is never opened; on, the search answers', async () => {
    await applied({ folders: [WORK], hub_reads: { transcripts: false } })
    search.open.mockClear()
    expect(await hub('POST', '/transcripts/search', { body: { query: 'x' } })).toEqual({ status: 403, body: { error: HUB.transcripts }, signed: false })
    expect(await hub('POST', '/transcripts/get', { body: { hash: '0'.repeat(64) } })).toEqual({ status: 403, body: { error: HUB.transcripts }, signed: false })
    expect(search.open).not.toHaveBeenCalled()
    await applied({ folders: [WORK] })
    expect(await hub('POST', '/transcripts/search', { body: { query: 'x' } })).toEqual({ status: 200, body: { results: [] }, signed: false })
    expect(search.open).toHaveBeenCalledTimes(1)
  })
})

describe('(17B) m: hub_reads.memory', () => {
  it('(17B) m1 memory off: the hub MCP\'s fabric calls answer 403 unsigned and nothing runs; _ready still answers', async () => {
    await applied({ folders: [WORK], hub_reads: { memory: false } })
    ran.length = 0
    const before = auditLines().length
    const paths = ['/fabric/memory/search', '/fabric/memory/remember', '/fabric/room/read', '/fabric/room/post', '/fabric/project/list']
    for (const path of paths) {
      expect(answerOf(await handleHubRequest(fabricFrame(path), host)), path).toEqual({ status: 403, body: { error: HUB.memory }, signed: false })
    }
    expect(ran).toEqual([])
    const lines = auditLines().slice(before)
    expect(lines).toHaveLength(paths.length)
    lines.forEach((line, i) => {
      expect(line).toMatchObject({ route: `POST ${paths[i]}`, denied: 'hub_reads.memory', hub: true })
      expect(line).not.toHaveProperty('forwarded')
    })
    const ready = answerOf(await handleHubRequest(fabricFrame('/fabric/_ready'), host))
    expect(ready.status).toBe(200)
    expect(ready.body).toMatchObject({ ready: true })
  })

  const http = process.getBuiltinModule('node:http') as typeof import('node:http')
  const c = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
  const memKey = () => {
    const { privateKey } = c.generateKeyPairSync('ed25519')
    const publicKey = c.createPublicKey(privateKey).export({ format: 'jwk' }).x as string
    return { publicKey, fingerprint: '', sign: (d: string | Uint8Array) => c.sign(null, Buffer.from(d), privateKey).toString('base64url') }
  }
  const home = { id: 'r1a17b-home', key: memKey() }
  const callerKey = memKey()

  /** The real forwarder against the real home through a stand-in hub that frames the call as the hub's link route does. */
  async function through(path: string, input: Json) {
    let status = 0
    let signedForCaller = false
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (d: Buffer) => chunks.push(d))
      request.on('end', async () => {
        const sent = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: unknown }).input
        const asked = String(request.headers['tandem-memory-challenge'])
        const answer = await handleHubRequest({
          ...frame('POST', (request.url ?? '').replace('/__tunnel/fabric-rpc', ''), { body: { caller, input: sent } }),
          trusted_surface: FABRIC_MCP_TRUST,
          headers: { 'tandem-memory-challenge': [asked] },
        }, host, home)
        const header = answer.headers?.['tandem-memory-answer']?.[0]
        const body = Buffer.from(answer.body_base64 ?? '', 'base64')
        status = answer.status_code
        signedForCaller = header !== undefined && verifySignature(home.key.publicKey, memoryAnswerText({
          id: home.id, key: home.key.publicKey, challenge: asked, method: 'POST', path, input, status, body,
        }), header.split(' ')[3])
        response.writeHead(status, { 'content-type': 'application/json', ...(header ? { 'tandem-memory-answer': header } : {}) })
        response.end(body)
      })
    })
    server.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const port = (server.address() as import('node:net').AddressInfo).port
      const forwarder = fabricForward({
        url: `ws://127.0.0.1:${port}`, token: `r1a17b-${'t'.repeat(24)}`, bridgeId: 'r1a17b-caller', key: callerKey as never,
        trusted: () => [{ id: home.id, key: home.key.publicKey }],
      })
      return { answer: await forwarder.forward(path, { caller, input }), status, signedForCaller }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  it('(17B) m2 memory off: a memory call forwarded from another computer gets the signed 403 and its agent reads the hub_reads.memory text', async () => {
    await applied({ folders: [WORK], hub_reads: { memory: false } })
    ran.length = 0
    const before = auditLines().length
    const got = await through('/fabric/memory/search', { query: 'r1a17b' })
    expect(got.answer).toEqual({ error: HUB.memory })
    expect(got.status).toBe(403)
    expect(got.signedForCaller).toBe(true)
    expect(ran).toEqual([])
    const lines = auditLines().slice(before)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ route: 'POST /fabric/memory/search', denied: 'hub_reads.memory', hub: true, forwarded: true })
  })

  it('(17B) m3 memory on: the forwarded call answers the home\'s records (control)', async () => {
    await applied({ folders: [WORK] })
    ran.length = 0
    const got = await through('/fabric/memory/search', { query: 'r1a17b' })
    expect([got.status, got.signedForCaller]).toEqual([200, true])
    expect(got.answer).toEqual({ records: [{ id: 'r1a17b-m' }] })
    expect(ran).toEqual(['search'])
  })
})

describe('(17B) u: unaffected', () => {
  it('(17B) u1 every hub field off: the local paths the stdio MCP server uses answer as before', async () => {
    await applied({ folders: [WORK], ...ALL_OFF })
    const read = await route({ method: 'GET', path: '/sessions/r1a17b-none/read', query: new URLSearchParams(), body: {} })
    expect(notHubText((read.body as Json)?.error)).toBe(true)
    const sent = await route({ method: 'POST', path: '/sessions/r1a17b-none/send', query: new URLSearchParams(), body: { text: 'x' } })
    expect(notHubText((sent.body as Json)?.error)).toBe(true)
    ran.length = 0
    const listed = await routeFabricRpc({ trust: FABRIC_MCP_TRUST, client: host.client, method: 'POST', path: '/fabric/project/list', body: { caller, input: {} } })
    expect(listed.status).toBe(200)
    expect(ran).toEqual(['list'])
  })

  it('(17B) u2 every hub field off: usage and signed remote commands are not gated', async () => {
    await applied({ folders: [WORK], ...ALL_OFF })
    expect(await hub('POST', '/usage', { body: [] })).toEqual({ status: 400, body: { error: 'body: only refresh (true or false)' }, signed: false })
    const remote = await hub('POST', '/remote/command', { body: {} })
    expect(remote).toEqual({ status: 400, body: { error: 'command_invalid' }, signed: false })
  })
})

describe('(17B) w: no widening, and A4.8\'s hub half', () => {
  it('(17B) w1 every hub field off: a hub request that claims the fields in its body or headers is still refused and changes nothing', async () => {
    await applied({ folders: [WORK], ...ALL_OFF })
    const fileBefore = sha256(readFileSync(LIMITS))
    const copyBefore = sha256(readFileSync(APPLIED))
    const snapBefore = limits.limitsSnapshot() as Json
    const claims = { hub_commands: true, hub_reads: { screens: true, transcripts: true, memory: true }, limits: 'hub_commands = true' }
    const headers = { hub_commands: ['true'], 'tandem-limits': ['hub_reads = {}'] }
    await withSession(async () => {
      expect(await hub('POST', '/sessions/r1a17b-s/send', { body: { text: 'r1a17b', ...claims }, headers })).toEqual({ status: 403, body: { error: HUB.commands }, signed: false })
      expect(await hub('GET', '/sessions/r1a17b-s/read', { body: claims, headers })).toEqual({ status: 403, body: { error: HUB.screens }, signed: false })
      expect(await hub('POST', '/transcripts/search', { body: { query: 'x', ...claims }, headers })).toEqual({ status: 403, body: { error: HUB.transcripts }, signed: false })
      expect(answerOf(await handleHubRequest({ ...fabricFrame('/fabric/memory/search', headers), body_base64: Buffer.from(JSON.stringify({ caller, input: {}, ...claims })).toString('base64') }, host)))
        .toEqual({ status: 403, body: { error: HUB.memory }, signed: false })
      expect(calls).toEqual([])
    })
    expect(sha256(readFileSync(LIMITS))).toBe(fileBefore)
    expect(sha256(readFileSync(APPLIED))).toBe(copyBefore)
    const snapAfter = limits.limitsSnapshot() as Json
    expect(snapAfter).toEqual(snapBefore)
    expect([snapAfter.hub_commands, snapAfter.hub_reads, snapAfter.digest]).toEqual([snapBefore.hub_commands, snapBefore.hub_reads, snapBefore.digest])
  })

  it('(17B) w2 a hub read refused and logged; still refused with the notice after an edit nobody applied; allowed after the local apply', async () => {
    await applied({ folders: [WORK], hub_reads: { screens: false } })
    const before = auditLines().length
    expect(await hub('GET', '/sessions/r1a17b-none/read')).toEqual({ status: 403, body: { error: HUB.screens }, signed: false })
    expect(auditLines().slice(before)).toEqual([expect.objectContaining({ route: 'GET /sessions/r1a17b-none/read', denied: 'hub_reads.screens', hub: true })])
    // An agent's edit: screens back on, never applied.
    const file = writeLimits(TH, hubOn({ folders: [WORK, join(BOX, 'r1a17b-w2')] }))
    const asked = await captured(async () => [await hub('GET', '/sessions/r1a17b-none/read'), await hub('GET', '/sessions/r1a17b-none/read')])
    for (const a of asked.value) expect(a).toEqual({ status: 403, body: { error: HUB.screens + NOTICE }, signed: false })
    expect(asked.err).toBe('limits: the limits file changed on disk and is not applied; apply it at this computer\n')
    // The owner's local apply.
    expect(await captured(() => limits.commitLimits(sha256(readFileSync(file))))).toMatchObject({ value: undefined })
    const after = await hub('GET', '/sessions/r1a17b-none/read')
    expect(after.status).not.toBe(403)
    expect(notHubText(after.body.error)).toBe(true)
  })
})

describe('(17B) x: tool text', () => {
  it('(17B) x1 the stdio MCP server: open_session and relay name permission_skip, not the stale bypass sentence', async () => {
    const { buildMcpServer } = await import('../src/mcp-server.ts')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = await buildMcpServer()
    const client = new Client({ name: 'r1a17b', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(b), client.connect(a)])
    try {
      const { tools } = await client.listTools()
      const text = (name: string) => tools.find((t) => t.name === name)?.description ?? ''
      expect(text('open_session')).not.toContain('Permission bypass is off by default')
      expect(text('open_session')).toContain('permission_skip')
      expect(text('relay')).toContain("TANDEM_ALLOW_BYPASS=1 and a cwd inside this computer's limits file permission_skip")
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('(17B) x2 the hub MCP server names the tmux -S attach hint', () => {
    const src = readFileSync(join(repo, 'hub', 'src', 'mcp.ts'), 'utf8')
    expect(src).toContain('"tmux -S <socket> attach -t <target>" hint')
    expect(src).not.toContain('"tmux attach -t')
  })
})
