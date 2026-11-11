/**
 * bridge/hub-rpc.ts: a hub request frame becomes a route() call in
 * bridge/router.ts, and the router's result becomes the response frame.
 *
 * Frames go straight to handleHubRequest in process: no hub, no socket, no tmux.
 * HOME is a temporary folder so the audit lines land in $HOME/.tandem/bridge.log there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame, type CcmHttpResponseFrame } from '../hub/src/protocol.ts'
import { FABRIC_MCP_TRUST } from '../src/fabric/rpc-contract.ts'

const home = mkdtempSync(join(tmpdir(), 'hub-rpc-home-'))
const savedHome = process.env.HOME
process.env.HOME = home
const { handleHubRequest } = await import('../bridge/hub-rpc.ts')
const { filterSessionsByEngine } = await import('../bridge/router.ts')
const { createLocalFabricHost } = await import('../bridge/fabric/local-fabric-host.ts')

afterAll(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

let seq = 0
function frame(method: string, path: string, opts: { body?: unknown; rawBody?: string; rawQuery?: string } = {}): CcmHttpRequestFrame {
  const raw = opts.rawBody ?? ('body' in opts ? JSON.stringify(opts.body) : undefined)
  return {
    type: CCM_FRAME_TYPES.httpRequest,
    request_id: `req-${++seq}`,
    method,
    path,
    ...(opts.rawQuery !== undefined ? { raw_query: opts.rawQuery } : {}),
    headers: {},
    ...(raw !== undefined ? { body_base64: Buffer.from(raw, 'utf8').toString('base64') } : {}),
  }
}

function bodyOf(response: CcmHttpResponseFrame): unknown {
  return JSON.parse(Buffer.from(response.body_base64 ?? '', 'base64').toString('utf8'))
}

const logPath = join(home, '.tandem', 'bridge.log')
function auditLines(): Record<string, unknown>[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describe('the request body', () => {
  it.each([
    [[], 400],
    ['not-an-object', 400],
    [42, 400],
    [true, 400],
    [null, 500],
  ])('preserves the pre-Fabric /relay/start status for JSON body %j', async (body, status) => {
    const response = await handleHubRequest(frame('POST', '/relay/start', { body }))
    expect(response.status_code).toBe(status)
  })

  it('no body on POST /relay/start gives 400 (the body is {}); bad JSON does the same', async () => {
    const none = await handleHubRequest(frame('POST', '/relay/start'))
    expect(none.status_code).toBe(400)
    expect(bodyOf(none)).toEqual({ error: 'goal is required' })
    const bad = await handleHubRequest(frame('POST', '/relay/start', { rawBody: '{not json' }))
    expect(bad.status_code).toBe(400)
    expect(bodyOf(bad)).toEqual({ error: 'goal is required' })
  })

  it('a router throw answers 500 internal_error; its message goes to stderr only', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const response = await handleHubRequest(frame('POST', '/relay/start', { body: null }))
      expect(response.status_code).toBe(500)
      expect(bodyOf(response)).toEqual({ error: 'internal_error' })
    } finally {
      spy.mockRestore()
    }
    expect(lines.join('')).toMatch(/null/)
  })
})

describe('relay-owned names', () => {
  const NAME = 'relay-deadbeef-lead'
  it.each([
    ['open', 'POST', '/sessions/open', { name: NAME }],
    ['send', 'POST', `/sessions/${NAME}/send`, { text: 'x' }],
    ['read', 'GET', `/sessions/${NAME}/read`, undefined],
    ['interrupt', 'POST', `/sessions/${NAME}/interrupt`, undefined],
    ['close', 'POST', `/sessions/${NAME}/close`, undefined],
  ])('the name relay-deadbeef-lead gives 409 on %s', async (_action, method, path, body) => {
    const response = await handleHubRequest(frame(method, path, body === undefined ? {} : { body }))
    expect(response.status_code).toBe(409)
    expect(JSON.stringify(bodyOf(response))).toContain('relay')
  })
})

describe('read audit', () => {
  it('a session read through hub-rpc adds one line naming the route and the name, with no text', async () => {
    const before = auditLines().length
    const response = await handleHubRequest(frame('GET', '/sessions/r1a07-probe/read', { rawQuery: 'cursor=0' }))
    expect(response.status_code).toBe(200)
    const after = auditLines()
    expect(after).toHaveLength(before + 1)
    const entry = after[after.length - 1]
    expect(entry).toMatchObject({ route: 'GET /sessions/:name/read', name: 'r1a07-probe' })
    expect(Object.keys(entry).sort()).toEqual(['name', 'route', 'ts'])
  })

  it('a relay read through hub-rpc adds one line naming the route and the loopId, with no text', async () => {
    const before = auditLines().length
    const response = await handleHubRequest(frame('GET', '/relay/feedf00d/read', { rawQuery: 'cursor=0' }))
    expect(response.status_code).toBe(404)
    const after = auditLines()
    expect(after).toHaveLength(before + 1)
    const entry = after[after.length - 1]
    expect(entry).toMatchObject({ route: 'GET /relay/:loopId/read', loopId: 'feedf00d' })
    expect(Object.keys(entry).sort()).toEqual(['loopId', 'route', 'ts'])
  })

  it('a send with empty text is a read (the router returns the transcript), so it adds one line too', async () => {
    const before = auditLines().length
    const response = await handleHubRequest(frame('POST', '/sessions/r1a07-probe/send', { body: { text: '' } }))
    expect(response.status_code).toBe(409) // not live here; a live session answers with its transcript
    const after = auditLines()
    expect(after).toHaveLength(before + 1)
    const entry = after[after.length - 1]
    expect(entry).toMatchObject({ route: 'POST /sessions/:name/send', name: 'r1a07-probe', read: true })
    expect(Object.keys(entry).sort()).toEqual(['name', 'read', 'route', 'ts'])
  })
})

describe('agent filter (pure)', () => {
  const rows = [
    { id: 'c1', engine: 'claude' },
    { id: 'c2', engine: 'claude' },
    { id: 'c3', engine: 'claude' },
    { id: 's1', engine: 'shell' },
    { id: 's2', engine: 'shell' },
    { id: 'x1', engine: 'codex' },
  ]
  const ids = (list: { id: string }[]) => list.map((row) => row.id)

  it('shell keeps only shell rows', () => {
    expect(ids(filterSessionsByEngine(rows, 'shell', 20))).toEqual(['s1', 's2'])
  })
  it('terminal means shell', () => {
    expect(ids(filterSessionsByEngine(rows, 'terminal', 20))).toEqual(['s1', 's2'])
  })
  it('all keeps every row', () => {
    expect(filterSessionsByEngine(rows, 'all', 20)).toEqual(rows)
  })
  it('absent keeps every row', () => {
    expect(filterSessionsByEngine(rows, undefined, 20)).toEqual(rows)
  })
  it('the limit applies after the filter', () => {
    // A limit of 2 before the filter would keep c1, c2 and leave no shell row.
    expect(ids(filterSessionsByEngine(rows, 'shell', 2))).toEqual(['s1', 's2'])
    expect(ids(filterSessionsByEngine(rows, 'shell', 1))).toEqual(['s1'])
  })
})

describe('the response frame', () => {
  it('keeps the request_id and the content type', async () => {
    const response = await handleHubRequest({ ...frame('GET', '/relay/feedf00d/read'), request_id: 'keep-me-0123' })
    expect(response.type).toBe(CCM_FRAME_TYPES.httpResponse)
    expect(response.request_id).toBe('keep-me-0123')
    expect(response.headers).toEqual({ 'content-type': ['application/json'] })
  })

  it('a response frame over the 1 MiB link cap is answered 413 payload_too_large instead', async () => {
    // The router's 404 names the path, so a long path makes a body over the cap.
    const response = await handleHubRequest(frame('GET', `/${'x'.repeat(1_100_000)}`))
    expect(response.status_code).toBe(413)
    expect(bodyOf(response)).toEqual({ error: 'payload_too_large' })
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(1_048_576)
  })

  it("an unknown path gives the router's 404", async () => {
    const response = await handleHubRequest(frame('GET', '/no/such/route'))
    expect(response.status_code).toBe(404)
    expect(bodyOf(response)).toEqual({ error: 'no route for GET /no/such/route' })
  })
})

describe('fabric paths', () => {
  const caller = {
    ownerId: `owner-${'a'.repeat(64)}`,
    deviceId: `mcp-device-${'b'.repeat(64)}`,
    agentId: `mcp-owner-${'c'.repeat(64)}`,
  }
  const listFrame = (marked: boolean): CcmHttpRequestFrame => ({
    ...frame('POST', '/fabric/project/list', { body: { caller, input: {} } }),
    ...(marked ? { trusted_surface: FABRIC_MCP_TRUST } : {}),
  })

  it('/fabric/project/list without the trusted marker answers 403 fabric_operation_denied', async () => {
    const folder = mkdtempSync('/tmp/r1a22-hubrpc-')
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: join(folder, 'fabric.sqlite3') })
    try {
      const response = await handleHubRequest(listFrame(false), host)
      expect(response.status_code).toBe(403)
      expect(bodyOf(response)).toEqual({ error: 'fabric_operation_denied' })
    } finally {
      host?.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('with the marker and no fabric host answers 503 fabric_unavailable', async () => {
    const response = await handleHubRequest(listFrame(true))
    expect(response.status_code).toBe(503)
    expect(bodyOf(response)).toEqual({ error: 'fabric_unavailable' })
  })

  it('with the marker and a fabric host answers 200', async () => {
    const folder = mkdtempSync('/tmp/r1a22-hubrpc-')
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: join(folder, 'fabric.sqlite3') })
    try {
      const response = await handleHubRequest(listFrame(true), host)
      expect(response.status_code).toBe(200)
      expect(bodyOf(response)).toEqual([])
    } finally {
      host?.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('(31C-1) the home signs memory answers', () => {
  const c = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
  const memKey = () => {
    const { privateKey } = c.generateKeyPairSync('ed25519')
    const publicKey = c.createPublicKey(privateKey).export({ format: 'jwk' }).x as string
    return { publicKey, fingerprint: '', sign: (d: string | Uint8Array) => c.sign(null, Buffer.from(d), privateKey).toString('base64url') }
  }
  const sha = (data: string | Buffer) => c.createHash('sha256').update(data).digest('hex')
  const home = { id: 'r1a31c1-home', key: memKey() }
  const CHALLENGE = 'r1a31c1-challenge_0123'
  const caller = { ownerId: `owner-${'a'.repeat(64)}`, deviceId: `mcp-device-${'b'.repeat(64)}`, agentId: `mcp-owner-${'c'.repeat(64)}` }
  const input = {}
  type Fields = { id: string; key: string; challenge: string; method: string; path: string; input: unknown; status: number; body: Buffer }
  const answerText = (f: Fields) =>
    ['tandem-memory-answer-v1', f.id, f.key, f.challenge, f.method, f.path, sha(JSON.stringify(f.input ?? null)), String(f.status), sha(f.body)].join('\n')
  const listFrame = (challenge?: string | string[]): CcmHttpRequestFrame => ({
    ...frame('POST', '/fabric/project/list', { body: { caller, input } }),
    trusted_surface: FABRIC_MCP_TRUST,
    headers: challenge === undefined ? {} : { 'tandem-memory-challenge': Array.isArray(challenge) ? challenge : [challenge] },
  })
  const answerOf = (response: CcmHttpResponseFrame) => response.headers?.['tandem-memory-answer']
  const fieldsOf = (response: CcmHttpResponseFrame): Fields => ({
    id: home.id, key: home.key.publicKey, challenge: CHALLENGE, method: 'POST', path: '/fabric/project/list', input,
    status: response.status_code, body: Buffer.from(response.body_base64 ?? '', 'base64'),
  })
  const hostWith = (result: unknown) => ({ client: { listProjects: async () => result }, close() {} }) as unknown as Parameters<typeof handleHubRequest>[1]

  it('with a challenge and a fabric host: the header verifies with the home key over ANSWER_TEXT of the body bytes in the frame', async () => {
    const { verifySignature } = await import('../bridge/device-keys.ts')
    const folder = mkdtempSync('/tmp/r1a31c1-hubrpc-')
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: join(folder, 'fabric.sqlite3') })
    try {
      expect(CHALLENGE).toMatch(/^[A-Za-z0-9_-]{22}$/)
      const response = await handleHubRequest(listFrame(CHALLENGE), host, home)
      expect(response.status_code).toBe(200)
      expect(bodyOf(response)).toEqual([])
      const header = answerOf(response)
      expect(header).toHaveLength(1)
      const [v, id, key, sig, ...rest] = header![0].split(' ')
      expect([v, id, key, rest]).toEqual(['v1', home.id, home.key.publicKey, []])
      expect(verifySignature(home.key.publicKey, answerText(fieldsOf(response)), sig)).toBe(true)
    } finally {
      host?.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it.each([
    ['no challenge', undefined],
    ['21 characters', CHALLENGE.slice(1)],
    ['23 characters', `${CHALLENGE}A`],
    ['a character outside base64url', `${CHALLENGE.slice(1)}+`],
    ['two values', [CHALLENGE, CHALLENGE]],
  ] as const)('%s: no answer header', async (_label, challenge) => {
    const response = await handleHubRequest(listFrame(challenge as string | string[] | undefined), hostWith([]), home)
    expect(response.status_code).toBe(200)
    expect(answerOf(response)).toBeUndefined()
  })

  it('a 413-substituted answer is signed over the 413 body', async () => {
    const { verifySignature } = await import('../bridge/device-keys.ts')
    const response = await handleHubRequest(listFrame(CHALLENGE), hostWith(['x'.repeat(1_100_000)]), home)
    expect(response.status_code).toBe(413)
    expect(bodyOf(response)).toEqual({ error: 'payload_too_large' })
    const sig = answerOf(response)![0].split(' ')[3]
    expect(verifySignature(home.key.publicKey, answerText(fieldsOf(response)), sig)).toBe(true)
  })

  it('changing any one of id, key, challenge, method, path, input, status or body makes verifySignature false', async () => {
    const { verifySignature } = await import('../bridge/device-keys.ts')
    const response = await handleHubRequest(listFrame(CHALLENGE), hostWith([]), home)
    const sig = answerOf(response)![0].split(' ')[3]
    const good = fieldsOf(response)
    expect(verifySignature(home.key.publicKey, answerText(good), sig)).toBe(true)
    const changed: Partial<Fields>[] = [
      { id: 'r1a31c1-other' }, { key: memKey().publicKey }, { challenge: `B${CHALLENGE.slice(1)}` }, { method: 'GET' },
      { path: '/fabric/project/get' }, { input: { projectId: 'p1' } }, { status: 201 }, { body: Buffer.from('[] ') },
    ]
    for (const change of changed) expect(verifySignature(home.key.publicKey, answerText({ ...good, ...change }), sig), Object.keys(change)[0]).toBe(false)
  })

  it('a signature by the same key over a proof, roster entry, roster offer or envelope text with the same values is never an answer', async () => {
    const { verifySignature } = await import('../bridge/device-keys.ts')
    const { proofText } = await import('../hub/src/devices.ts')
    const response = await handleHubRequest(listFrame(CHALLENGE), hostWith([]), home)
    const f = fieldsOf(response)
    const bodySha = sha(f.body)
    const others = [
      proofText({ host: home.id, method: f.method, path: f.path, id: home.id, key: f.key, ts: f.status, nonce: f.challenge, bodySha256: bodySha }),
      `tandem-roster-v1\n${f.status}\n${bodySha}\n${home.id}\n${f.key}\n${f.key}\n${f.status}`,
      `tandem-roster-offer-v1\n${home.id}\n${f.key}\n${f.status}`,
      `tandem-envelope-v1\n${home.id}\n${home.id}\n${f.challenge}\n${f.status}\n${bodySha}`,
      answerText(f).replace(/^tandem-memory-answer-v1/, 'tandem-hub-proof-v1'),
    ]
    for (const text of others) {
      expect(text.split('\n')[0]).not.toBe('tandem-memory-answer-v1')
      expect(verifySignature(f.key, answerText(f), home.key.sign(text))).toBe(false)
    }
  })
})
