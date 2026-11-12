/**
 * hub-presence.ts: presence between the owner's computers (plan section 3, data flow 4;
 * U-R1A-33B-3). It runs in the bridge process (src/server.ts), beside the mail carrier; the stdio
 * servers answer who_is_up from what this process kept in state.db (readRemotePresence).
 *
 * Push: every PRESENCE_EVERY_MS one POST /__tunnel/presence. When the session names changed since
 * the last push, or PUSH_HEARTBEAT_MS passed since it, it carries one envelope per other computer
 * of this computer's roster, signed by this computer's device key (bridge/envelope.ts): a body of
 * exactly v, kind, at, sessions (name, engine, project, state, stateAt; no folder, no screen text)
 * and more (the rows left out so the envelope fits MAX_READING_BYTES). Else it carries none and
 * only reads.
 *
 * Read: each row the hub hands back is checked: the sender in this computer's verified roster,
 * the envelope signed by its key, addressed here, at most PRESENCE_MAX_AGE_MS old, the body
 * exactly a presence body. A refusal writes one `presence.refused` audit line and keeps the old
 * reading; a reading is kept only when newer than the kept one. The hub's `connected` list and the
 * sync time are kept too: a computer is stale when its reading is over STALE_MS old (counted on
 * this computer's clock from no later than its arrival), it is not connected, or the last sync is
 * over STALE_MS old. Names, engines and projects with hidden characters are refused (`shape`). Every state change happens after the store
 * wrote it: a failed call or store changes nothing here, so the next sync does the work again.
 * Every call carries the link bearer and a `tandem-proof` over the exact bytes; no token, key,
 * proof or reading is ever logged. `now` is the only clock.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { EnvelopeError, openEnvelope, signEnvelope } from './envelope.ts'
import { hubProofHeader, type HubLinkConfig } from './hub-link.ts'
import type { Presence } from './presence.ts'
import { readRoster, thisId, trustedKey } from './roster.ts'
import { DatabaseSync, type DatabaseSync as NodeDatabaseSync, ensureDbFile } from './sqlite-file.ts'

export const PRESENCE_EVERY_MS = 2000
export const PUSH_HEARTBEAT_MS = 10_000
export const STALE_MS = 30_000
export const PRESENCE_MAX_AGE_MS = 60_000
export const MAX_READING_BYTES = 16_384

const SLOW_DOWN_MS = 60_000
const TIMEOUT_MS = 10_000
const LOG_EVERY_MS = 60_000
const ROUTE = '/__tunnel/presence'
const BODY_KEYS = ['at', 'kind', 'more', 'sessions', 'v'].join()
const ROW_KEYS = ['engine', 'name', 'project', 'state', 'stateAt'].join()
const STATES = ['working', 'idle', 'waiting_for_approval', 'unknown']
/** A session name or engine as this product makes them (bridge/sessions.ts), at most 300 characters. */
const NAME = /^[A-Za-z0-9._-]{1,300}$/
/** Never shown from another computer: control, format (bidi, zero-width, tag), lone surrogate and line-separator characters. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u{e0000}-\u{e007f}]/u
/** A project (a folder's last name) that may be shown: at most 300 characters, none hidden. */
const plain = (s: string) => s.length <= 300 && !HIDDEN.test(s)

export type RemoteSession = { name: string; engine: string; project: string; state: string; stateAt: number; ageMs: number }
export type RemoteReading = { computer: string; at: number | null; ageMs: number | null; stale: boolean; sessions: RemoteSession[]; more: number }
type Row = Omit<RemoteSession, 'ageMs'>
type Body = { v: 1; kind: 'presence'; at: number; sessions: Row[]; more: number }
type Json = Record<string, unknown>

const httpOrigin = (wsOrigin: string) => wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')
const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function stateFile(): string {
  return join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'state.db')
}

/** state.db as bridge/mailbox.ts opens it (folder 0700, file 0600), with the two presence tables. */
function openStore(path: string): NodeDatabaseSync {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  ensureDbFile(path)
  const db: NodeDatabaseSync = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS presence_remote (computer TEXT PRIMARY KEY, reading TEXT NOT NULL, at_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS presence_hub (k INTEGER PRIMARY KEY CHECK (k = 1), connected TEXT NOT NULL, at_ms INTEGER NOT NULL)`)
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

/** The signed body as a presence body with exactly the named keys and types, its times no later than the envelope's `ts`; else undefined. */
function presenceBody(text: string, ts: number): Body | undefined {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(b) || Object.keys(b).sort().join() !== BODY_KEYS) return undefined
  if (b.v !== 1 || b.kind !== 'presence' || !isTime(b.at) || b.at > ts || ts - b.at > PRESENCE_MAX_AGE_MS || !isTime(b.more) || !Array.isArray(b.sessions)) return undefined
  const sessions: Row[] = []
  for (const r of b.sessions as unknown[]) {
    if (!isObject(r) || Object.keys(r).sort().join() !== ROW_KEYS) return undefined
    const { name, engine, project, state, stateAt } = r
    if (typeof name !== 'string' || typeof engine !== 'string' || typeof project !== 'string' || !STATES.includes(state as string)) return undefined
    // What another computer names is shown to agents: anything that could pass as an instruction line or hide text is refused.
    if (!NAME.test(name) || !NAME.test(engine) || !plain(project)) return undefined
    if (!isTime(stateAt) || stateAt > ts || ts - stateAt > PRESENCE_MAX_AGE_MS) return undefined
    sessions.push({ name, engine, project, state: state as string, stateAt })
  }
  return { v: 1, kind: 'presence', at: b.at, sessions, more: b.more }
}

export function hubPresence(
  config: Pick<HubLinkConfig, 'url' | 'token' | 'bridgeId'>,
  opts: { presence: Presence; key?: DeviceKey; now?: () => number; trusted?: (id: string) => string | undefined; path?: string },
): { syncOnce(): Promise<void>; start(): () => void } {
  const { presence } = opts
  const now = opts.now ?? Date.now
  const trusted = opts.trusted ?? trustedKey
  const self = config.bridgeId
  const origin = httpOrigin(config.url)
  let key = opts.key
  const signer = () => (key ??= openDeviceKey())
  let db: NodeDatabaseSync | undefined
  const store = () => (db ??= openStore(opts.path ?? stateFile()))
  /** The hub said slow down (429): no call before this time. */
  let quietUntil = -Infinity
  /** The names and time of the last push the hub took. */
  let last: { names: string; at: number } | undefined
  /** The envelope text last handled per sender: the same text again is skipped. */
  const handled = new Map<string, string>()
  /** Why the last sync stopped early, for start()'s stderr line. */
  let failed: string | undefined
  /** openEnvelope's replay store: every nonce is new; a replayed reading is caught by its `at`. */
  const fresh = { remember: () => true }

  /** One envelope from this computer to `to`, rows dropped from the end until it fits MAX_READING_BYTES. */
  function envelopeTo(to: string, at: number, rows: Row[]): string {
    for (let n = rows.length; ; n--) {
      const body = JSON.stringify({ v: 1, kind: 'presence', at, sessions: rows.slice(0, n), more: rows.length - n })
      const text = JSON.stringify(signEnvelope(signer(), { from: self, to, body }, now()))
      if (Buffer.byteLength(text, 'utf8') <= MAX_READING_BYTES || n === 0) return text
    }
  }

  /** One answered row: checked and kept, skipped as already handled, or refused with one audit line. */
  function receive(from: string, text: string): void {
    if (handled.get(from) === text) return
    // ponytail: a hub naming more senders than any roster holds only costs a re-check of each.
    if (handled.size >= 1000) handled.clear()
    const refuse = (denied: string) => {
      audit({ event: 'presence.refused', from: from.slice(0, 300), denied })
      handled.set(from, text)
    }
    let publicKey: string | undefined
    try {
      publicKey = trusted(from)
    } catch {
      publicKey = undefined
    }
    if (publicKey === undefined) return refuse('unknown_sender')
    if (Buffer.byteLength(text, 'utf8') > MAX_READING_BYTES) return refuse('shape')
    let opened: { body: string; ts: number }
    try {
      opened = openEnvelope(text, { sender: { id: from, publicKey }, self, seen: fresh, now: now(), maxAgeMs: PRESENCE_MAX_AGE_MS })
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e
      return refuse(e.reason)
    }
    const body = presenceBody(opened.body, opened.ts)
    if (!body) return refuse('shape')
    store()
      .prepare(`INSERT INTO presence_remote (computer, reading, at_ms, received_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT (computer) DO UPDATE SET reading = excluded.reading, at_ms = excluded.at_ms, received_ms = excluded.received_ms
        WHERE excluded.at_ms > presence_remote.at_ms`)
      .run(from, JSON.stringify(body), body.at, now())
    handled.set(from, text)
  }

  async function syncOnce(): Promise<void> {
    failed = undefined
    if (now() < quietUntil) return
    const members = (readRoster() ?? []).map((e) => e.id).filter((id) => id !== self)
    // No other computer in the roster: nothing to send and nobody to hear from.
    if (members.length === 0) return
    const names = JSON.stringify((await presence.names()).sort())
    const changed = names !== last?.names
    const items: { to: string; envelope: string }[] = []
    if (changed || now() - last!.at >= PUSH_HEARTBEAT_MS) {
      const reading = await presence.whoIsUp(changed ? { refresh: true } : {})
      const rows = [...reading.sessions].sort(byName).map(({ name, engine, project, state, stateAt }) => ({ name, engine, project: plain(project) ? project : '', state, stateAt }))
      for (const to of members) items.push({ to, envelope: envelopeTo(to, reading.at, rows) })
    }
    const body = JSON.stringify({ presence: items })
    let status: number | undefined
    let data: Json | undefined
    try {
      const answer = await fetch(origin + ROUTE, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'tandem-proof': hubProofHeader(signer(), { url: config.url, method: 'POST', path: ROUTE, id: self, body }),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      status = answer.status
      try {
        const parsed: unknown = JSON.parse(await answer.text())
        if (isObject(parsed)) data = parsed
      } catch {
        data = undefined
      }
    } catch {
      status = undefined
    }
    if (status === 429) quietUntil = now() + SLOW_DOWN_MS
    const rows = data?.presence
    const connected = data?.connected
    if (status !== 200 || !Array.isArray(rows) || !Array.isArray(connected) || !connected.every((c) => typeof c === 'string')) {
      failed = status === undefined ? 'no answer' : String(status)
      return
    }
    if (items.length > 0) last = { names, at: now() }
    for (const r of rows as unknown[]) {
      if (isObject(r) && typeof r.from === 'string' && typeof r.envelope === 'string' && r.from !== self) receive(r.from, r.envelope)
    }
    // A computer that left the roster: its kept reading goes too.
    store().prepare('DELETE FROM presence_remote WHERE computer NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(members))
    store()
      .prepare('INSERT INTO presence_hub (k, connected, at_ms) VALUES (1, ?, ?) ON CONFLICT (k) DO UPDATE SET connected = excluded.connected, at_ms = excluded.at_ms')
      .run(JSON.stringify(connected), now())
  }

  function start(): () => void {
    let running = false
    let fails = 0
    let waitUntil = -Infinity
    let logged = -Infinity
    // A sync that failed waits twice the interval, doubling up to SLOW_DOWN_MS, before the next:
    // a hub that is down or refusing is never asked every 2 s (the proof allowance).
    const timer = setInterval(() => {
      if (running || now() < waitUntil) return
      running = true
      syncOnce()
        .catch(() => {
          failed = 'error'
        })
        .finally(() => {
          running = false
          fails = failed === undefined ? 0 : fails + 1
          waitUntil = fails === 0 ? -Infinity : now() + Math.min(SLOW_DOWN_MS, PRESENCE_EVERY_MS * 2 ** Math.min(fails, 10))
          if (failed !== undefined && now() - logged >= LOG_EVERY_MS) {
            logged = now()
            process.stderr.write(`hub presence: sync failed: ${failed}\n`)
          }
        })
    }, PRESENCE_EVERY_MS)
    timer.unref()
    return () => {
      clearInterval(timer)
      db?.close()
      db = undefined
    }
  }

  return { syncOnce, start }
}

/**
 * What this computer last received from each other computer of its roster (sorted by id), read
 * from state.db at each call: [] with no roster or a roster of this computer alone (state.db is
 * then not opened). A computer with no kept reading is listed with `at: null`, stale.
 */
export function readRemotePresence(opts: { now?: () => number; path?: string; self?: string; members?: () => { id: string }[] | undefined } = {}): RemoteReading[] {
  const self = opts.self ?? thisId()
  const ids = [...new Set(((opts.members ?? readRoster)() ?? []).map((m) => m.id).filter((id) => id !== self))].sort()
  if (ids.length === 0) return []
  const db = openStore(opts.path ?? stateFile())
  try {
    const t = (opts.now ?? Date.now)()
    const hub = db.prepare('SELECT connected, at_ms FROM presence_hub WHERE k = 1').get() as { connected: string; at_ms: number } | undefined
    const connected: string[] = hub ? (JSON.parse(hub.connected) as string[]) : []
    const hubGone = hub === undefined || t - hub.at_ms > STALE_MS
    const one = db.prepare('SELECT reading, received_ms FROM presence_remote WHERE computer = ?')
    return ids.map((computer): RemoteReading => {
      const row = one.get(computer) as { reading: string; received_ms: number } | undefined
      if (!row) return { computer, at: null, ageMs: null, stale: true, sessions: [], more: 0 }
      const b = JSON.parse(row.reading) as Body
      // Ages are counted on this computer's clock: a sender's time counts only up to the moment its
      // reading arrived here, so a clock that runs ahead (envelopes allow 5 min) never reads as fresh.
      const since = (ms: number) => t - Math.min(ms, row.received_ms)
      const ageMs = since(b.at)
      return {
        computer,
        at: b.at,
        ageMs,
        stale: hubGone || ageMs > STALE_MS || ageMs < 0 || !connected.includes(computer),
        sessions: [...b.sessions].sort(byName).map((s) => ({ ...s, ageMs: since(s.stateAt) })),
        more: b.more,
      }
    })
  } finally {
    db.close()
  }
}
