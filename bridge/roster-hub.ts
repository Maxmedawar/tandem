/**
 * roster-hub.ts: the roster commands with the hub as the carrier (U-R1A-31B-2). The hub keeps one
 * copy of the owner's roster and the offers waiting (hub/src/roster-store.ts); nothing here relies
 * on the hub's own checks, so every roster or offer fetched here goes through bridge/roster.ts,
 * which checks the whole chain itself. Every call carries the link bearer and a `tandem-proof`
 * signed by this computer's device key over the exact body bytes (hubProofHeader,
 * bridge/hub-link.ts).
 *
 * The launcher runs this file for `fingerprint`, `roster` (init, clear) and `trust`. With no
 * TANDEM_HUB_LINK_URL it is exactly roster.ts `main`. Nothing is printed outside main, and no
 * token, key or proof text is ever printed.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintOf, openDeviceKey, type DeviceKey } from './device-keys.ts'
import { hubLinkConfigFromEnv, hubProofHeader, type HubLinkConfig } from './hub-link.ts'
import {
  joinRoster,
  main as localMain,
  makeOffer,
  readRoster,
  receiveOffer,
  receiveRoster,
  RosterError,
  rosterDir,
  signOffer,
  sweepOffers,
} from './roster.ts'

const TIMEOUT_MS = 10_000
const FINGERPRINT = /^[0-9a-f]{16}$/
/** The only text of a hub answer ever put in a message: a short plain word list. */
const PLAIN = /^[a-z_ ]{1,64}$/

/** The hub's http(s) origin for its ws(s) link URL (bridge/hub-rpc.ts hubHttpOrigin, copied: that file loads the router). */
const httpOrigin = (wsOrigin: string) => wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')

export interface RosterHub {
  /** The hub's roster and its length, or undefined when it holds none. */
  get(): Promise<{ len: number; roster: string } | undefined>
  /** Upload `text` over the hub's roster of length `base`: ok, or a conflict with the hub's length now. */
  put(base: number, text: string): Promise<{ ok: boolean; len: number }>
  postOffer(offerText: string): Promise<void>
  offers(): Promise<string[]>
}

export function rosterHub(config: Pick<HubLinkConfig, 'url' | 'token' | 'bridgeId'>, key?: DeviceKey): RosterHub {
  const origin = httpOrigin(config.url)
  async function call(method: string, path: string, body?: string): Promise<{ status: number; data: Record<string, unknown> | undefined }> {
    const proof = hubProofHeader(key ?? openDeviceKey(), { url: config.url, method, path, id: config.bridgeId, body })
    let status: number
    let text: string
    try {
      const answer = await fetch(origin + path, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          'tandem-proof': proof,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      status = answer.status
      text = await answer.text()
    } catch {
      throw new RosterError('hub: unreachable')
    }
    let data: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
    } catch {
      data = undefined
    }
    return { status, data: data ?? (PLAIN.test(text) ? { error: text } : undefined) }
  }
  const refused = (status: number, data: Record<string, unknown> | undefined) => {
    const error = typeof data?.error === 'string' && PLAIN.test(data.error) ? ` ${data.error}` : ''
    return new RosterError(`hub: ${status}${error}`)
  }
  const isLen = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
  return {
    async get() {
      const { status, data } = await call('GET', '/__tunnel/roster')
      if (status === 404 && data?.error === 'no_roster') return undefined
      if (status !== 200 || !isLen(data?.len) || typeof data?.roster !== 'string') throw refused(status, data)
      return { len: data.len, roster: data.roster }
    },
    async put(base, text) {
      const { status, data } = await call('PUT', '/__tunnel/roster', JSON.stringify({ base, roster: text }))
      if (status === 200 && isLen(data?.len)) return { ok: true, len: data.len }
      if (status === 409 && data?.error === 'roster_conflict' && isLen(data.len)) return { ok: false, len: data.len }
      throw refused(status, data)
    },
    async postOffer(offerText) {
      const { status, data } = await call('POST', '/__tunnel/roster/offer', JSON.stringify({ offer: offerText }))
      if (status !== 200 || data?.ok !== true) throw refused(status, data)
    },
    async offers() {
      const { status, data } = await call('GET', '/__tunnel/roster/offers')
      const list = data?.offers
      if (status !== 200 || !Array.isArray(list) || !list.every((o) => typeof o === 'string')) throw refused(status, data)
      return list as string[]
    },
  }
}

const say = (s: string) => process.stdout.write(s + '\n')
const rosterFileText = (): string | undefined => {
  try {
    return readFileSync(join(rosterDir(), 'roster.json'), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Fetch the hub's roster (taken by receiveRoster as from the hub; a refusal is printed as
 * `hub roster: <reason>` and the run goes on) and its offers (each through receiveOffer; the
 * refused ones counted). Returns the hub's roster text and length (0 and undefined on none).
 */
async function pull(hub: RosterHub): Promise<{ len: number; text: string | undefined }> {
  // The offers first: the hub drops an offer when a roster with its key is stored, so an offer
  // gone from this list is in the roster fetched after it (never missing from both).
  const offers = await hub.offers()
  const got = await hub.get()
  if (got) {
    try {
      receiveRoster(got.roster, Date.now(), 'hub')
    } catch (e) {
      if (!(e instanceof RosterError) || e.path) throw e
      process.stderr.write(`hub roster: ${e.reason}\n`)
    }
  }
  let skipped = 0
  for (const offer of offers) {
    try {
      receiveOffer(offer)
    } catch (e) {
      if (!(e instanceof RosterError) || e.path) throw e
      skipped++
    }
  }
  if (skipped > 0) say(`skipped ${skipped} offers`)
  return { len: got?.len ?? 0, text: got?.roster }
}

/**
 * `trust <fp>` with a roster here: sign the offer in (signOffer: nothing written yet) and put that
 * roster at the hub, one retry on a conflict; roster.json takes it, and the offer goes, only once
 * the hub took it, so a refused trust changes no file beyond what its pulls took.
 */
async function trustThroughHub(hub: RosterHub, fp: string): Promise<number> {
  const key = openDeviceKey()
  const trusted = () => readRoster()?.find((e) => fingerprintOf(e.key) === fp)
  let at = await pull(hub)
  for (let attempt = 0; ; attempt++) {
    const next = trusted() ? undefined : signOffer(key, fp)
    const text = next?.text ?? rosterFileText()
    if (text === undefined) throw new RosterError('no roster')
    // Already the hub's roster (another computer put the same one first): nothing to send.
    if (text !== at.text && !(await hub.put(at.len, text)).ok) {
      if (attempt === 1) {
        process.stderr.write(`tandem: hub busy: run tandem trust ${fp} again\n`)
        return 1
      }
      at = await pull(hub)
      continue
    }
    if (next) {
      receiveRoster(next.text, Date.now(), 'peer')
      sweepOffers()
    }
    const id = next?.id ?? trusted()!.id
    say(`trusted ${id} ${fp}. On ${id} run: tandem trust ${key.fingerprint}`)
    return 0
  }
}

export async function main(args: string[]): Promise<number> {
  let config: HubLinkConfig | undefined
  try {
    config = hubLinkConfigFromEnv(process.env)
  } catch {
    process.stderr.write('tandem: hub link: bad configuration\n')
    return 1
  }
  if (!config) return localMain(args)
  const hub = rosterHub(config)
  const [command, ...rest] = args
  try {
    if (command === 'fingerprint' && rest.length === 0) {
      const code = localMain(args)
      if (code !== 0) return code
      await hub.postOffer(JSON.stringify(makeOffer(openDeviceKey(), config.bridgeId)))
      say(`offered to the hub as ${config.bridgeId}`)
      return 0
    }
    if (command === 'roster' && rest.length === 0) {
      await pull(hub)
      sweepOffers()
      return localMain(args)
    }
    if (command === 'roster' && rest.length === 1 && rest[0] === 'init') {
      if (await hub.get()) {
        process.stderr.write('tandem: the hub already holds a roster: join it with tandem trust <fingerprint>\n')
        return 1
      }
      const code = localMain(args)
      if (code !== 0) return code
      const text = rosterFileText()
      if (text === undefined || !(await hub.put(0, text)).ok) throw new RosterError('hub: 409 roster_conflict')
      return 0
    }
    if (command === 'trust' && rest.length === 1) {
      const fp = rest[0]
      if (!FINGERPRINT.test(fp)) throw new RosterError('bad fingerprint')
      // Present at all (a symlink too): roster.ts then refuses a bad file with its own reason.
      const has = (name: string) => lstatSync(join(rosterDir(), name), { throwIfNoEntry: false }) !== undefined
      const hasRoster = has('roster.json')
      const hasPending = has('pending.json')
      if (hasRoster && hasPending) throw new RosterError('roster and pending both exist')
      if (hasRoster) return await trustThroughHub(hub, fp)
      if (hasPending) return localMain(args)
      const got = await hub.get()
      if (!got) throw new RosterError('no roster at the hub yet')
      receiveRoster(got.roster, Date.now(), 'hub')
      joinRoster(openDeviceKey(), fp)
      say(`joined the roster signed by ${fp}`)
      return 0
    }
    return localMain(args)
  } catch (e) {
    if (e instanceof RosterError) {
      process.stderr.write(`tandem: ${e.reason}${e.path ? ` (${e.path})` : ''}\n`)
      return 1
    }
    if (e instanceof Error && e.name === 'DeviceKeyError') {
      process.stderr.write(`tandem: ${e.message}\n`)
      return 1
    }
    throw e
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) void main(process.argv.slice(2)).then((code) => (process.exitCode = code))
