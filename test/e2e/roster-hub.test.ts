/**
 * The roster through a local hub (U-R1A-31B-2): pairing offers and the roster carried between
 * computers by the hub, two computers trusting one new computer at once ending on one roster,
 * one roster per hub, and the hub's per-computer offer limits.
 *
 * One local hub (`wrangler dev --local`) through ./hub-harness.ts. Computers a, b, c, d, f are
 * the launcher tree of roster.test.ts (i): `<tmp>/bin/tandem` a copy of packaging/tandem,
 * `<tmp>/runtime` a symlink to this checkout, each computer with its own TANDEM_HOME and HOME
 * and the hub link settings. Skipped only when wrangler or tmux is missing.
 */
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hub, LINK_TOKEN, missing, repo, startHub, stopHub } from './hub-harness.ts'

const PREFIX = '/tmp/r1a31b2-e2e-'
const made: string[] = []
const folder = (name: string) => {
  const p = realpathSync(mkdtempSync(`${PREFIX}${name}-`))
  made.push(p)
  return p
}

type Computer = { letter: string; id: string; home: string; tandemHome: string }
type Run = { code: number | null; out: string; err: string }

let tree = ''
const computers: Record<string, Computer> = {}

function computer(letter: string): Computer {
  const base = folder(letter)
  const c = { letter, id: `r1a31b2-${letter}`, home: join(base, 'home'), tandemHome: join(base, 'tandem') }
  mkdirSync(c.home, { mode: 0o700 })
  computers[letter] = c
  return c
}

function env(c: Computer): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TANDEM_') && !k.startsWith('CCM_') && k !== 'TMUX') out[k] = v
  return {
    ...out,
    HOME: c.home,
    TANDEM_NODE: process.execPath,
    TANDEM_HOME: c.tandemHome,
    TANDEM_HUB_LINK_URL: hub.replace(/^http:/, 'ws:'),
    TANDEM_HUB_LINK_TOKEN: LINK_TOKEN,
    TANDEM_HUB_LINK_ID: c.id,
  }
}

function tandem(c: Computer, ...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(join(tree, 'bin', 'tandem'), args, { env: env(c), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

const rosterText = (c: Computer) => readFileSync(join(c.tandemHome, 'roster', 'roster.json'), 'utf8')
const fingerprint = async (c: Computer) => {
  const r = await tandem(c, 'fingerprint')
  expect(r.code).toBe(0)
  const m = /^this computer: (\S+) ([0-9a-f]{16})\n/.exec(r.out)
  expect(m?.[1]).toBe(c.id)
  return { run: r, fp: m![2] }
}

const title = missing ? `roster through the hub (skipped: ${missing} missing)` : 'roster through the hub'

describe.skipIf(Boolean(missing))(title, () => {
  const fp: Record<string, string> = {}

  beforeAll(async () => {
    tree = folder('tree')
    mkdirSync(join(tree, 'bin'))
    copyFileSync(join(repo, 'packaging', 'tandem'), join(tree, 'bin', 'tandem'))
    chmodSync(join(tree, 'bin', 'tandem'), 0o755)
    symlinkSync(repo, join(tree, 'runtime'))
    for (const letter of ['a', 'b', 'c', 'd', 'f']) computer(letter)
    await startHub(PREFIX)
  }, 90_000)

  afterAll(async () => {
    await stopHub()
    for (const p of made) rmSync(p, { recursive: true, force: true })
  }, 30_000)

  it('(1) a starts the roster; b offers, a sees it and trusts it, b joins: the same bytes', async () => {
    const { a, b } = computers
    const init = await tandem(a, 'roster', 'init')
    expect(init.code).toBe(0)
    fp.a = /^roster started: r1a31b2-a ([0-9a-f]{16})\n$/.exec(init.out)![1]
    const offered = await fingerprint(b)
    fp.b = offered.fp
    expect(offered.run).toEqual({ code: 0, out: `this computer: r1a31b2-b ${fp.b}\noffered to the hub as r1a31b2-b\n`, err: '' })
    const listed = await tandem(a, 'roster')
    expect(listed.code).toBe(0)
    expect(listed.out).toContain(`waiting: r1a31b2-b ${fp.b}\n`)
    expect(await tandem(a, 'trust', fp.b)).toEqual({ code: 0, out: `trusted r1a31b2-b ${fp.b}. On r1a31b2-b run: tandem trust ${fp.a}\n`, err: '' })
    expect(await tandem(b, 'trust', fp.a)).toEqual({ code: 0, out: `joined the roster signed by ${fp.a}\n`, err: '' })
    expect(rosterText(b)).toBe(rosterText(a))
  }, 120_000)

  it('(2) a and c trust d at once: both exit 0, then one roster on a, c and the hub, d once', async () => {
    const { a, c, d, f } = computers
    fp.c = (await fingerprint(c)).fp
    expect((await tandem(a, 'trust', fp.c)).code).toBe(0)
    expect(await tandem(c, 'trust', fp.a)).toEqual({ code: 0, out: `joined the roster signed by ${fp.a}\n`, err: '' })
    fp.d = (await fingerprint(d)).fp
    const both = await Promise.all([tandem(a, 'trust', fp.d), tandem(c, 'trust', fp.d)])
    for (const r of both) {
      expect(r.code, r.err).toBe(0)
      expect(r.out).toMatch(new RegExp(`^trusted r1a31b2-d ${fp.d}\\. On r1a31b2-d run: tandem trust [0-9a-f]{16}\\n$`))
    }
    expect((await tandem(a, 'roster')).code).toBe(0)
    expect((await tandem(c, 'roster')).code).toBe(0)
    expect(rosterText(c)).toBe(rosterText(a))
    const entries = JSON.parse(rosterText(a)).entries as { id: string }[]
    expect(entries.map((e) => e.id).filter((id) => id === 'r1a31b2-d')).toHaveLength(1)
    expect(entries).toHaveLength(4)
    // The hub's copy, read as f.
    process.env.TANDEM_HOME = f.tandemHome
    const { rosterHub } = await import('../../bridge/roster-hub.ts')
    const { openDeviceKey } = await import('../../bridge/device-keys.ts')
    const got = await rosterHub({ url: hub.replace(/^http:/, 'ws:'), token: LINK_TOKEN, bridgeId: f.id }, openDeviceKey()).get()
    expect(got?.len).toBe(entries.length)
    expect(got?.roster).toBe(rosterText(a))
  }, 120_000)

  it('(3) roster init on a fresh computer while the hub holds a roster: exit 1, nothing written', async () => {
    const { f } = computers
    expect(await tandem(f, 'roster', 'init')).toEqual({ code: 1, out: '', err: 'tandem: the hub already holds a roster: join it with tandem trust <fingerprint>\n' })
    expect(() => rosterText(f)).toThrow()
  }, 60_000)

  it("(4) f offering under a's id: offer_not_yours; f's 6th own offer in the hour: slow_down", async () => {
    const { f } = computers
    process.env.TANDEM_HOME = f.tandemHome
    const { rosterHub } = await import('../../bridge/roster-hub.ts')
    const { makeOffer } = await import('../../bridge/roster.ts')
    const { openDeviceKey } = await import('../../bridge/device-keys.ts')
    const key = openDeviceKey()
    const client = rosterHub({ url: hub.replace(/^http:/, 'ws:'), token: LINK_TOKEN, bridgeId: f.id }, key)
    const reason = (p: Promise<unknown>) => p.then(() => 'accepted', (e: { reason?: string }) => e.reason)
    expect(await reason(client.postOffer(JSON.stringify(makeOffer(key, 'r1a31b2-a'))))).toBe('hub: 403 offer_not_yours')
    for (let i = 0; i < 5; i++) expect(await reason(client.postOffer(JSON.stringify(makeOffer(key, f.id))))).toBe('accepted')
    expect(await reason(client.postOffer(JSON.stringify(makeOffer(key, f.id))))).toBe('hub: 429 slow_down')
  }, 60_000)

  it('(5) audit: each roster route refuses before the store without the bearer and a proof for this very request; a far-future offer is refused', async () => {
    const { f } = computers
    process.env.TANDEM_HOME = f.tandemHome
    const { hubProofHeader } = await import('../../bridge/hub-link.ts')
    const { makeOffer } = await import('../../bridge/roster.ts')
    const { openDeviceKey } = await import('../../bridge/device-keys.ts')
    const { rosterHub } = await import('../../bridge/roster-hub.ts')
    const key = openDeviceKey()
    const url = hub.replace(/^http:/, 'ws:')
    const bearer = { authorization: `Bearer ${LINK_TOKEN}` }
    const proof = (method: string, path: string, body?: string) => ({ 'tandem-proof': hubProofHeader(key, { url, method, path, id: f.id, body }) })
    const ask = async (method: string, path: string, headers: Record<string, string>, body?: string) => {
      const r = await fetch(hub + path, { method, headers, body })
      return [r.status, await r.text()]
    }
    const routes: [string, string, string | undefined][] = [
      ['GET', '/__tunnel/roster', undefined],
      ['PUT', '/__tunnel/roster', JSON.stringify({ base: 0, roster: 'x' })],
      ['POST', '/__tunnel/roster/offer', JSON.stringify({ offer: 'x' })],
      ['GET', '/__tunnel/roster/offers', undefined],
    ]
    for (const [method, path, body] of routes) {
      const name = `${method} ${path}`
      const good = proof(method, path, body)
      const rows: [string, (string | number)[], (string | number)[]][] = [
        ['no bearer, a good proof', await ask(method, path, good, body), [401, 'unauthorized']],
        ['a wrong bearer, a good proof', await ask(method, path, { authorization: 'Bearer wrong', ...good }, body), [401, 'unauthorized']],
        ['the bearer, no proof', await ask(method, path, bearer, body), [401, 'unauthorized']],
        ['the bearer, a proof for another path', await ask(method, path, { ...bearer, ...proof(method, '/__tunnel/connect', body) }, body), [401, 'unauthorized']],
        ['the bearer, a proof for another method', await ask(method, path, { ...bearer, ...proof('DELETE', path, body) }, body), [401, 'unauthorized']],
        ['the bearer, a proof over other bytes', await ask(method, path, { ...bearer, ...proof(method, path, `${body ?? ''} `) }, body), [401, 'unauthorized']],
        ['a token in the query', await ask(method, `${path}?token=${LINK_TOKEN}`, { ...bearer, ...good }, body), [401, 'unauthorized']],
        ['a method the route does not take', await ask('DELETE', path, { ...bearer, ...proof('DELETE', path) }), [405, 'method not allowed']],
      ]
      for (const [row, got, want] of rows) expect([name, row, got]).toEqual([name, row, want])
    }
    // The proof just used is spent: the same header again is refused.
    const once = proof('GET', '/__tunnel/roster/offers')
    expect((await ask('GET', '/__tunnel/roster/offers', { ...bearer, ...once }))[0]).toBe(200)
    expect(await ask('GET', '/__tunnel/roster/offers', { ...bearer, ...once })).toEqual([401, 'unauthorized'])
    // Over the cap: refused whole, before the proof is spent.
    const big = JSON.stringify({ offer: 'x'.repeat(8192) })
    expect(await ask('POST', '/__tunnel/roster/offer', { ...bearer, ...proof('POST', '/__tunnel/roster/offer', big) }, big)).toEqual([413, '{"error":"payload_too_large"}'])
    // f is not in the roster: it can read it but never write it.
    const client = rosterHub({ url, token: LINK_TOKEN, bridgeId: f.id }, key)
    const reason = (p: Promise<unknown>) => p.then(() => 'accepted', (e: { reason?: string }) => e.reason)
    const held = await client.get()
    expect(await reason(client.put(held!.len, held!.roster))).toBe('hub: 403 not_in_roster')
    expect(await reason(client.postOffer(JSON.stringify(makeOffer(key, f.id, Date.now() + 86_400_000))))).toBe('hub: 400 roster_invalid')
    expect((await client.get())?.roster).toBe(held!.roster)
  }, 60_000)
})
