/**
 * hub-mail.ts: the carrier of mail between the owner's computers (plan section 3, data flow 3;
 * U-R1A-33B-2). It runs in the bridge process (src/server.ts), the one process with the hub link
 * settings; the stdio servers only store and read mail in state.db (bridge/mailbox.ts).
 *
 * Push: each row to `<computer>:<session>` still queued, oldest first, one at a time, goes to the
 * hub's queue for that computer (POST /__tunnel/mail/put) inside an envelope signed by this
 * computer's device key (bridge/envelope.ts), kept before the first try so every retry sends the
 * same bytes. The hub's answer becomes the row's state: sent (with the hub's seq), queue_full,
 * refused; a row queued longer than OUTBOX_TTL_MS becomes expired here.
 *
 * Pull: POST /__tunnel/mail/take hands this computer's copies in seq order, acking what was
 * handled before. Each copy is checked: the sender in this computer's verified roster, the
 * envelope signed by that sender's key and addressed here, never seen before, the body exactly a
 * mail body; only then is it stored (mailbox.receive), from `machine:<computer>/<sender>` built
 * from the hub-named AND signature-checked computer and the signed body's local sender. Message
 * text is never read for identity. Repeats are dropped by envelope nonce and by message id, so a
 * copy the hub hands twice is stored once. A copy's nonce is recorded only after the mailbox stored
 * or refused it: a store that fails (SQLite busy) or a stop in between leaves the copy unacked and
 * unrecorded, so the next take stores it. An envelope kept longer than RESIGN_AFTER_MS is signed
 * again at its push (same id and sentAt, new ts and nonce), so the hub's 7 days always fit the
 * receiver's window; the receiver drops the extra copy by message id. Every call carries the link bearer and a
 * `tandem-proof` over the exact bytes; no token, key, proof or message text is ever logged.
 *
 * `now` is the only clock: the replay store, every openEnvelope and every signEnvelope run on it.
 */
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { EnvelopeError, MAX_AGE_CAP_MS, openEnvelope, openReplayStore, signEnvelope, type ReplayStore } from './envelope.ts'
import { hubProofHeader, type HubLinkConfig } from './hub-link.ts'
import { isMailSender } from './limits.ts'
import { MailError, type Mailbox, type Message } from './mailbox.ts'
import { trustedKey } from './roster.ts'

export const MAIL_POLL_MS = 2000
export const PUSH_EVERY_MS = 500
export const SLOW_DOWN_MS = 60_000
export const OUTBOX_TTL_MS = 7 * 86_400_000
export const MAX_PAGES = 10
/** A kept envelope older than this is signed again at its push: the hub may hold it 7 days and the receiver takes ts up to 7 days + 5 min old. */
export const RESIGN_AFTER_MS = 60_000

const TIMEOUT_MS = 10_000
const LOG_EVERY_MS = 60_000
const PUT = '/__tunnel/mail/put'
const TAKE = '/__tunnel/mail/take'
const BODY_KEYS = ['from', 'id', 'kind', 'level', 'sentAt', 'text', 'to', 'v'].join()
const ASK_KEYS = ['from', 'id', 'kind', 'level', 'replyBy', 'sentAt', 'text', 'to', 'v'].join()
const LEVELS = ['fyi', 'ask', 'interrupt']

/** The hub's http(s) origin for its ws(s) link URL (bridge/hub-rpc.ts hubHttpOrigin, copied: that file loads the router). */
const httpOrigin = (wsOrigin: string) => wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')

type Json = Record<string, unknown>
type Copy = { id: string; from: string; seq: number; kind: string; body: string }
type Body = { id: string; from: string; to: string; level: Message['level']; text: string; sentAt: number; replyBy?: number }

const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isCopy = (c: unknown): c is Copy => {
  const v = c as Json
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.from === 'string' &&
    Number.isSafeInteger(v.seq) && (v.seq as number) > 0 && typeof v.kind === 'string' && typeof v.body === 'string'
}

/** The signed body as a mail body with exactly the named keys and types, its sender local; else undefined. */
function mailBody(text: string): Body | undefined {
  let b: Json
  try {
    b = JSON.parse(text) as Json
  } catch {
    return undefined
  }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return undefined
  const keys = Object.keys(b).sort().join()
  const ok = b.v === 1 && b.kind === 'mail' && typeof b.id === 'string' && isMailSender(b.from) && typeof b.to === 'string' &&
    LEVELS.includes(b.level as string) && typeof b.text === 'string' && isTime(b.sentAt) &&
    (b.level === 'ask' ? keys === ASK_KEYS && isTime(b.replyBy) : keys === BODY_KEYS)
  if (!ok) return undefined
  const out: Body = { id: b.id as string, from: b.from as string, to: b.to as string, level: b.level as Body['level'], text: b.text as string, sentAt: b.sentAt as number }
  if (b.level === 'ask') out.replyBy = b.replyBy as number
  return out
}

export function hubMail(
  config: Pick<HubLinkConfig, 'url' | 'token' | 'bridgeId'>,
  opts: { box: Mailbox; key?: DeviceKey; now?: () => number; seen?: ReplayStore; trusted?: (id: string) => string | undefined },
): { pushOnce(): Promise<number>; pullOnce(): Promise<number>; start(): () => void } {
  const { box } = opts
  const now = opts.now ?? Date.now
  const ownSeen = opts.seen ? undefined : openReplayStore({ now })
  const seen = opts.seen ?? ownSeen!
  const trusted = opts.trusted ?? trustedKey
  const origin = httpOrigin(config.url)
  let key = opts.key
  const signer = () => (key ??= openDeviceKey())
  /** The hub said slow down (429): no call before this time. */
  let quietUntil = -Infinity
  /** The last take's seq handled and stored here: the next take acks it. Never above what was handled. */
  let cursor = 0
  /** Why the last pass of each kind stopped early, for start()'s stderr line. */
  const failed: { push?: string; pull?: string } = {}

  /** One proofed POST; status undefined when nothing answered in time. */
  async function call(path: string, body: string): Promise<{ status?: number; data?: Json }> {
    try {
      const answer = await fetch(origin + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'tandem-proof': hubProofHeader(signer(), { url: config.url, method: 'POST', path, id: config.bridgeId, body }),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await answer.text()
      let data: Json | undefined
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Json
      } catch {
        data = undefined
      }
      return { status: answer.status, data }
    } catch {
      return {}
    }
  }

  /** A 429 starts the quiet time; every early stop is remembered for the log. */
  const stop = (kind: 'push' | 'pull', status: number | undefined) => {
    if (status === 429) quietUntil = now() + SLOW_DOWN_MS
    failed[kind] = status === undefined ? 'no answer' : String(status)
  }

  /** Envelopes signed again for rows that waited past RESIGN_AFTER_MS, until the row moves. */
  const again = new Map<string, string>()

  /** The kept envelope of row `m`, else a new one signed now and kept before it is ever sent. */
  function envelopeFor(m: Message, computer: string, session: string): string {
    const kept = again.get(m.id) ?? box.envelopeOf(m.id)
    let last: { ts?: unknown } = {}
    try {
      if (kept !== undefined) last = JSON.parse(kept) as { ts?: unknown }
    } catch {
      last = {}
    }
    if (kept !== undefined && isTime(last.ts) && Math.abs(now() - last.ts) <= RESIGN_AFTER_MS) return kept
    const body: Json = { v: 1, kind: 'mail', id: m.id, from: m.from, to: session, level: m.level, text: m.text, sentAt: m.sentAt }
    if (m.level === 'ask') body.replyBy = m.replyBy
    const text = JSON.stringify(signEnvelope(signer(), { from: config.bridgeId, to: computer, body: JSON.stringify(body) }, now()))
    if (kept === undefined) {
      box.keepEnvelope(m.id, text)
      return box.envelopeOf(m.id)!
    }
    // ponytail: a re-signed envelope lives in memory only (keepEnvelope keeps the first); after a
    // restart the old one is stale again and is signed once more. The receiver drops extras by id.
    again.set(m.id, text)
    return text
  }

  async function pushOnce(): Promise<number> {
    if (now() < quietUntil) return 0
    let moved = 0
    const move = (id: string, state: 'sent' | 'queue_full' | 'refused' | 'expired', seq?: number) => {
      again.delete(id)
      if (!box.markRemote(id, state, seq)) return
      moved++
      if (state === 'expired') audit({ event: 'mail.expired', id })
    }
    for (const m of box.outgoing(50)) {
      if (now() - m.sentAt > OUTBOX_TTL_MS) {
        move(m.id, 'expired')
        continue
      }
      const at = m.to.indexOf(':')
      const computer = m.to.slice(0, at)
      const body = envelopeFor(m, computer, m.to.slice(at + 1))
      const { status, data } = await call(PUT, JSON.stringify({ id: m.id, to: [computer], body }))
      if (status === 200) {
        const results = Array.isArray(data?.results) ? (data.results as Json[]) : []
        const r = results.find((x) => typeof x === 'object' && x !== null && x.to === computer)
        if (r && Number.isSafeInteger(r.seq)) {
          move(m.id, 'sent', r.seq as number)
          continue
        }
        if (r?.error === 'queue_full') {
          move(m.id, 'queue_full')
          continue
        }
      } else if (status === 400 || status === 403) {
        move(m.id, 'refused')
        continue
      }
      // 429, 401, 5xx, an answer this carrier cannot read, or none: the row stays queued for the next pass.
      stop('push', status)
      break
    }
    return moved
  }

  /** One copy from the hub, checked and stored, or refused with one audit line; never throws for a bad copy. */
  function receive(c: Copy): void {
    const refuse = (denied: string, status?: number) =>
      audit({ event: 'mail.refused', from: c.from.slice(0, 300), id: c.id.slice(0, 300), denied, ...(status === undefined ? {} : { status }) })
    const repeat = () => audit({ event: 'mail.repeat', from: c.from.slice(0, 300), id: c.id.slice(0, 300) })
    let publicKey: string | undefined
    try {
      publicKey = trusted(c.from)
    } catch {
      publicKey = undefined
    }
    if (publicKey === undefined) return refuse('unknown_sender')
    // The nonce is only looked up here and recorded below, once the mailbox has stored or refused
    // the message: a store that throws anything else, or a stop before it, records nothing, so the
    // copy (never acked) is stored at the next take instead of being dropped as a repeat.
    let record = (): void => undefined
    const peek = {
      remember: (from: string, nonce: string, expiresAt: number) => {
        record = () => void seen.remember(from, nonce, expiresAt)
        return !seen.has(from, nonce)
      },
    }
    let opened: { body: string }
    try {
      opened = openEnvelope(c.body, { sender: { id: c.from, publicKey }, self: config.bridgeId, seen: peek, now: now(), maxAgeMs: MAX_AGE_CAP_MS })
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e
      return e.reason === 'replay' ? repeat() : refuse(e.reason)
    }
    const body = mailBody(opened.body)
    if (!body) {
      record()
      return refuse('shape')
    }
    let stored: 'stored' | 'repeat'
    try {
      stored = box.receive({ ...body, from: `machine:${c.from}/${body.from}` })
    } catch (e) {
      if (!(e instanceof MailError)) throw e
      record()
      return refuse('mailbox', e.status)
    }
    record()
    if (stored === 'repeat') repeat()
  }

  async function pullOnce(): Promise<number> {
    if (now() < quietUntil) return 0
    let handled = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      const { status, data } = await call(TAKE, JSON.stringify({ ack: cursor }))
      if (status !== 200 || !Array.isArray(data?.copies)) {
        stop('pull', status)
        break
      }
      const copies = (data.copies as unknown[]).filter(isCopy).filter((c) => c.seq > cursor).sort((a, b) => a.seq - b.seq)
      if (copies.length === 0) break
      for (const c of copies) {
        if (c.kind === 'expired') {
          if (box.markRemote(c.id, 'expired')) audit({ event: 'mail.expired', id: c.id })
        } else if (c.kind === 'message') {
          receive(c)
        }
        // Handled (stored, dropped or refused): a refused copy is acked too, so one bad copy never blocks the queue.
        cursor = c.seq
        handled++
      }
    }
    return handled
  }

  function start(): () => void {
    const last: { push?: number; pull?: number } = {}
    const report = (kind: 'push' | 'pull') => {
      const why = failed[kind]
      delete failed[kind]
      if (why === undefined || now() - (last[kind] ?? -Infinity) < LOG_EVERY_MS) return
      last[kind] = now()
      process.stderr.write(`hub mail: ${kind} failed: ${why}\n`)
    }
    const running = { push: false, pull: false }
    // A pass that stopped early waits twice its interval, doubling up to SLOW_DOWN_MS, before the
    // next: a hub that is down or refusing is never asked 2 times a second (the proof allowance).
    const fails = { push: 0, pull: 0 }
    const waitUntil = { push: -Infinity, pull: -Infinity }
    const pass = (kind: 'push' | 'pull', every: number, run: () => Promise<number>) => () => {
      if (running[kind] || now() < waitUntil[kind]) return
      running[kind] = true
      run()
        .catch(() => {
          failed[kind] = 'error'
        })
        .finally(() => {
          running[kind] = false
          fails[kind] = failed[kind] === undefined ? 0 : fails[kind] + 1
          waitUntil[kind] = fails[kind] === 0 ? -Infinity : now() + Math.min(SLOW_DOWN_MS, every * 2 ** Math.min(fails[kind], 10))
          report(kind)
        })
    }
    const timers = [setInterval(pass('push', PUSH_EVERY_MS, pushOnce), PUSH_EVERY_MS), setInterval(pass('pull', MAIL_POLL_MS, pullOnce), MAIL_POLL_MS)]
    for (const t of timers) t.unref()
    return () => {
      for (const t of timers) clearInterval(t)
      ownSeen?.close()
    }
  }

  return { pushOnce, pullOnce, start }
}
