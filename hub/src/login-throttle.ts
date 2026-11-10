/**
 * login-throttle.ts — limits password guesses on the /authorize gate.
 *
 * One global SQLite-backed Durable Object (idFromName('global')) holds the counts,
 * so parallel guesses cannot race each other the way they would on KV. The gate
 * calls reserve() BEFORE it compares the password and clear() after a success.
 *
 * The counting lives in the plain LoginThrottle class (injected storage + clock)
 * so it tests without a Durable Object runtime. This file deliberately does not
 * import 'cloudflare:workers' (the node test env cannot load it): the Durable
 * Object is the plain fetch-handler kind and the gate talks to it over fetch.
 */

export const ADDRESS_LIMIT = 5
export const ADDRESS_WINDOW_MS = 15 * 60_000
export const GLOBAL_LIMIT = 50
export const GLOBAL_WINDOW_MS = 60 * 60_000

export type ReserveResult = { allowed: true } | { allowed: false; retryAfterSec: number }

/** One counter: attempts counted since `start` (ms), the window's first attempt. */
export interface ThrottleRow {
  count: number
  start: number
}

/** The storage the counter needs. A `Map<string, ThrottleRow>` satisfies it. */
export interface ThrottleStore {
  get(key: string): ThrottleRow | undefined
  set(key: string, row: ThrottleRow): unknown
  delete(key: string): unknown
  entries(): Iterable<[string, ThrottleRow]>
}

const GLOBAL_KEY = 'global'
/** Address rows are prefixed so no address key can ever equal GLOBAL_KEY. */
const addressRow = (addressKey: string) => `addr:${addressKey}`
const windowOf = (rowKey: string) => (rowKey === GLOBAL_KEY ? GLOBAL_WINDOW_MS : ADDRESS_WINDOW_MS)

export class LoginThrottle {
  private readonly store: ThrottleStore
  private readonly now: () => number

  constructor(store: ThrottleStore, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  /**
   * Count one attempt against both the address and the global budget, or refuse.
   * Fully synchronous: inside a Durable Object nothing else can run in between,
   * which is what makes the check-and-add atomic. A refused attempt is not counted.
   */
  reserve(addressKey: string): ReserveResult {
    const now = this.now()
    for (const [key, row] of [...this.store.entries()]) {
      if (now >= row.start + windowOf(key)) this.store.delete(key)
    }
    const key = addressRow(addressKey)
    const global = this.store.get(GLOBAL_KEY)
    const address = this.store.get(key)
    const blockedUntil = Math.max(
      global && global.count >= GLOBAL_LIMIT ? global.start + GLOBAL_WINDOW_MS : 0,
      address && address.count >= ADDRESS_LIMIT ? address.start + ADDRESS_WINDOW_MS : 0,
    )
    if (blockedUntil > 0) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) }
    }
    this.store.set(GLOBAL_KEY, { count: (global?.count ?? 0) + 1, start: global?.start ?? now })
    this.store.set(key, { count: (address?.count ?? 0) + 1, start: address?.start ?? now })
    return { allowed: true }
  }

  /** A successful login: forget that address and give back its one global count. */
  clear(addressKey: string): void {
    this.store.delete(addressRow(addressKey))
    const global = this.store.get(GLOBAL_KEY)
    if (global && global.count > 0) this.store.set(GLOBAL_KEY, { ...global, count: global.count - 1 })
  }
}

/**
 * The counting key for a CF-Connecting-IP value: the whole IPv4 address, the
 * first 64 bits of an IPv6 address (one home or one server usually owns a whole
 * /64, so counting single addresses would hand out unlimited guesses), and
 * 'unknown' when the header is missing.
 */
export function addressKey(ip: string | null | undefined): string {
  const raw = (ip ?? '').trim().toLowerCase()
  if (!raw) return 'unknown'
  if (!raw.includes(':')) return raw
  const [head, tail] = raw.split('::') as [string, string | undefined]
  const groups = head ? head.split(':') : []
  // '::' stands for however many zero groups bring the total to 8; the groups
  // after it can still fall inside the first four (2001::1:a:b:c:d is 2001:0:0:1).
  if (tail !== undefined) {
    const after = tail ? tail.split(':') : []
    // A dotted IPv4 ending (::ffff:192.0.2.1) is one item here but two groups.
    const zeros = 8 - groups.length - after.length - (tail.includes('.') ? 1 : 0)
    groups.push(...Array(Math.max(0, zeros)).fill('0'), ...after)
  }
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')
}

/** Serve one throttle call. Shared by the Durable Object and the test fake. */
export async function throttleFetch(throttle: LoginThrottle, request: Request): Promise<Response> {
  const op = new URL(request.url).pathname
  const key = await request.text()
  if (request.method !== 'POST' || !key) return new Response('bad request', { status: 400 })
  if (op === '/reserve') return Response.json(throttle.reserve(key))
  if (op === '/clear') {
    throttle.clear(key)
    return Response.json({})
  }
  return new Response('not found', { status: 404 })
}

/** What the gate needs from the LOGIN_THROTTLE binding. */
interface ThrottleNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(url: string, init?: RequestInit): Promise<Response> }
}

async function call(ns: ThrottleNamespace, op: 'reserve' | 'clear', key: string): Promise<unknown> {
  const res = await ns.get(ns.idFromName('global')).fetch(`https://login-throttle/${op}`, { method: 'POST', body: key })
  if (!res.ok) throw new Error(`login throttle ${op} failed: ${res.status}`)
  return res.json()
}

/** Gate side of reserve(). Throws on any failure or malformed answer (caller fails closed). */
export async function reserveLogin(ns: ThrottleNamespace, key: string): Promise<ReserveResult> {
  const result = (await call(ns, 'reserve', key)) as ReserveResult
  if (result?.allowed === true) return result
  if (result?.allowed === false && Number.isFinite(result.retryAfterSec)) return result
  throw new Error('login throttle reserve returned a malformed answer')
}

/** Gate side of clear(). */
export async function clearLogin(ns: ThrottleNamespace, key: string): Promise<void> {
  await call(ns, 'clear', key)
}

/** The SQLite-backed Durable Object. One instance: idFromName('global'). */
export class LoginThrottleDO {
  private readonly throttle: LoginThrottle

  constructor(ctx: DurableObjectState) {
    const sql = ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, start INTEGER NOT NULL)')
    this.throttle = new LoginThrottle({
      get: (key) => {
        const row = sql.exec('SELECT count, start FROM login_attempts WHERE key = ?', key).toArray()[0]
        return row && { count: Number(row.count), start: Number(row.start) }
      },
      set: (key, row) =>
        sql.exec('INSERT OR REPLACE INTO login_attempts (key, count, start) VALUES (?, ?, ?)', key, row.count, row.start),
      delete: (key) => sql.exec('DELETE FROM login_attempts WHERE key = ?', key),
      entries: () =>
        sql
          .exec('SELECT key, count, start FROM login_attempts')
          .toArray()
          .map((r): [string, ThrottleRow] => [String(r.key), { count: Number(r.count), start: Number(r.start) }]),
    })
  }

  fetch(request: Request): Promise<Response> {
    return throttleFetch(this.throttle, request)
  }
}
