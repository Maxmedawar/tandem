/**
 * U-R1A-12: the list_sessions agent filter and the read audit live in router.route, so local MCP
 * calls (routeForTest) get the same rows and the same audit lines as hub calls.
 *
 * listSessions is stubbed (vi.mock) to return claude, shell and codex rows, sliced to its limit
 * (default 20) like the real one: no tmux. HOME is a temporary folder so the audit lines land in
 * $HOME/.tandem/bridge.log there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { DrivableSession } from '../bridge/drivable.ts'

const ROWS = vi.hoisted(() => [
  { id: 'c1', engine: 'claude' },
  { id: 'c2', engine: 'claude' },
  { id: 'c3', engine: 'claude' },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `s${i + 1}`, engine: 'shell' })),
  { id: 'x1', engine: 'codex' },
])

vi.mock('../bridge/sessions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge/sessions.ts')>()),
  listSessions: async (opts: { limit?: number } = {}) => ({ sessions: ROWS.slice(0, opts.limit ?? 20) }),
}))

const home = mkdtempSync(join(tmpdir(), 'r1a12-router-home-'))
const savedHome = process.env.HOME
process.env.HOME = home
const { routeForTest } = await import('../bridge/router.ts')
const { registerLive, unregisterLive } = await import('../bridge/sessions.ts')

afterAll(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const logPath = join(home, '.tandem', 'bridge.log')
function auditLines(): Record<string, unknown>[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function listed(rawQuery: string): Promise<string[]> {
  const res = await routeForTest('GET', '/sessions', {}, rawQuery)
  expect(res.status).toBe(200)
  return (res.body as { sessions: { id: string }[] }).sessions.map((s) => s.id)
}

const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

describe('GET /sessions agent filter (router.route)', () => {
  const firstTwenty = ROWS.slice(0, 20).map((r) => r.id)

  it('engine absent keeps every row (default limit 20)', async () => {
    expect(await listed('')).toEqual(firstTwenty)
  })
  it('engine=all keeps every row (default limit 20)', async () => {
    expect(await listed('engine=all')).toEqual(firstTwenty)
  })
  it('engine=terminal means shell', async () => {
    expect(await listed('engine=terminal')).toEqual(range('s', 20))
  })
  it('engine=shell keeps only shell rows, with the same default limit (20) after the filter', async () => {
    expect(await listed('engine=shell')).toEqual(range('s', 20))
  })
  it('engine=codex finds a row past the first 20', async () => {
    expect(await listed('engine=codex')).toEqual(['x1'])
  })
  it('an engine with no rows gives none', async () => {
    expect(await listed('engine=gemini')).toEqual([])
  })
  it('the limit applies after the filter', async () => {
    // A limit of 1 before the filter would keep c1 and leave no shell row.
    expect(await listed('engine=shell&limit=1')).toEqual(['s1'])
    expect(await listed('engine=claude&limit=2')).toEqual(['c1', 'c2'])
    expect(await listed('limit=2')).toEqual(['c1', 'c2'])
  })
})

describe('read audit (router.route): one line per read, live or not, never text', () => {
  async function oneLine(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    const before = auditLines().length
    await run()
    const after = auditLines()
    expect(after).toHaveLength(before + 1)
    return after[after.length - 1]!
  }

  it('GET /sessions/:name/read (not live) adds {route, name}', async () => {
    const entry = await oneLine(() => routeForTest('GET', '/sessions/r1a12-probe/read', {}, 'cursor=0'))
    expect(entry).toMatchObject({ route: 'GET /sessions/:name/read', name: 'r1a12-probe' })
    expect(Object.keys(entry).sort()).toEqual(['name', 'route', 'ts'])
  })

  it('GET /sessions/:name/read (live) adds {route, name}', async () => {
    const live: DrivableSession = {
      id: 'r1a12-live-probe',
      engine: 'codex',
      cwd: '/tmp/fake',
      isAlive: async () => true,
      isWorking: async () => false,
      send: async () => ({ status: 'done', report: '', cursor: 0 }),
      read: async () => ({ text: '', cursor: 0, idle: true }),
      interrupt: async () => {},
      close: async () => {},
      attachHint: () => 'fake-attach-hint',
    }
    registerLive(live)
    try {
      let status = 0
      const entry = await oneLine(async () => {
        status = (await routeForTest('GET', '/sessions/r1a12-live-probe/read')).status
      })
      expect(status).toBe(200)
      expect(entry).toMatchObject({ route: 'GET /sessions/:name/read', name: 'r1a12-live-probe' })
      expect(Object.keys(entry).sort()).toEqual(['name', 'route', 'ts'])
    } finally {
      unregisterLive('r1a12-live-probe')
    }
  })

  it('POST /sessions/:name/send with empty text adds {route, name, read: true}', async () => {
    const entry = await oneLine(() => routeForTest('POST', '/sessions/r1a12-probe/send', { text: '' }))
    expect(entry).toMatchObject({ route: 'POST /sessions/:name/send', name: 'r1a12-probe', read: true })
    expect(Object.keys(entry).sort()).toEqual(['name', 'read', 'route', 'ts'])
  })

  it('GET /relay/:loopId/read adds {route, loopId}', async () => {
    const entry = await oneLine(() => routeForTest('GET', '/relay/feedf00d/read', {}, 'cursor=0'))
    expect(entry).toMatchObject({ route: 'GET /relay/:loopId/read', loopId: 'feedf00d' })
    expect(Object.keys(entry).sort()).toEqual(['loopId', 'route', 'ts'])
  })

  it.each([
    ['GET', '/sessions/relay-deadbeef-lead/read', {}],
    ['POST', '/sessions/relay-deadbeef-lead/send', { text: '' }],
  ])('a relay-owned %s %s adds only its denied line', async (method, path, body) => {
    const entry = await oneLine(() => routeForTest(method, path, body))
    expect(entry).toEqual({
      ts: expect.any(String),
      route: `${method} /sessions/:name/${path.split('/')[3]}`,
      name: 'relay-deadbeef-lead',
      denied: 'relay-owned',
    })
  })
})
