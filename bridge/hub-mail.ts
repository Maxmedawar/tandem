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
 * from the hub-named AND signature-checked computer and the signed body's local sender (or a room's
 * wake, `room:<label>`, which the mailbox takes at fyi only, U-R1A-34). Message
 * text is never read for identity. Repeats are dropped by envelope nonce and by message id, so a
 * copy the hub hands twice is stored once. A copy's nonce is recorded only after the mailbox stored
 * or refused it: a store that fails (SQLite busy) or a stop in between leaves the copy unacked and
 * unrecorded, so the next take stores it. An envelope kept longer than RESIGN_AFTER_MS is signed
 * again at its push (same id and sentAt, new ts and nonce), so the hub's 7 days always fit the
 * receiver's window; the receiver drops the extra copy by message id. Every call carries the link bearer and a
 * `tandem-proof` over the exact bytes; no token, key, proof or message text is ever logged.
 *
 * Order (U-R1A-33B-4): every new mail body is v:2 and carries `n`, the next number of its
 * destination `<computer>:<session>`, taken in the transaction that keeps the envelope
 * (mailbox.keepNumbered), so a re-signed envelope keeps its n. A row the hub answers queue_full
 * or refused at its FIRST put (nothing stored there) gives its number back when no later row of
 * that destination has one yet (mailbox.returnNumber); a row put before with no answer keeps it
 * (the hub may hold that copy), and an expired row keeps it, as the receiver really missed it.
 * One carrier per state.db is assumed there. The receiver stores one sender
 * computer's mail to one session in n order only: an early copy is held (mail_held, at most
 * MAX_HELD per pair) for up to GAP_HOLD_MS, then one `mail.gap` audit line and one inbox notice
 * from `machine:<computer>/gap` name the missing numbers and the held copies follow; a copy whose
 * number was passed is dropped as `mail.late` (or `mail.repeat` when that id is stored). The gap
 * pass runs at the start of every pull, before any call, so a hub that stops answering still
 * releases held copies; the hold time is in state.db and survives a restart. The take cursor is
 * kept in state.db (hub_cursor) with the hub queue's epoch: a take names the epoch it knows ('' for
 * none); the hub answers with its own, and an epoch that is not the kept one resets the cursor to
 * 0 (the hub then deletes nothing and answers from seq 0). A hub that refuses the epoch key (an
 * older hub, 400 mail_invalid) gets `{ ack }` takes for the rest of the carrier's life after one
 * `mail.hub_epoch` line, and keeps the old risk that its restarted counters are acked unread.
 * Stated limits: first contact is the baseline (a hub can withhold everything before the first
 * copy it hands over); a hub can still withhold everything (a gap shows only when a later copy from
 * that sender arrives); a `mail.late` copy whose id was never stored is dropped and leaves one
 * inbox notice from `machine:<computer>/gap` (skipped only at MAX_INBOX), and a resent copy of a
 * message refused at store reads `mail.late` too; a fresh state.db at the receiver starts a new baseline;
 * all of one owner's computers run one release (an older receiver refuses v:2 bodies as `shape`;
 * a v:1 body from an older sender is stored with no order rule); the epoch protects only against a
 * hub that answers with it; order is per (sender computer, recipient session), not across sessions
 * or senders; a hub that answers a first put queue_full or refused yet hands that copy on makes
 * the next row share its number, and the receiver then drops that next row as `mail.late`, which
 * leaves that one inbox notice (U-R1A-33B-5). The receiver keeps at most mailbox.MAX_PAIRS
 * order rows per sender computer; the pair unused longest starts a new baseline.
 *
 * `now` is the only clock: the replay store, every openEnvelope and every signEnvelope run on it.
 */
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { EnvelopeError, MAX_AGE_CAP_MS, openEnvelope, openReplayStore, signEnvelope, type ReplayStore } from './envelope.ts'
import { hubProofHeader, readHubAnswer, type HubLinkConfig } from './hub-link.ts'
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
/** An early copy waits this long for the numbers before it; then the gap is reported and it is stored. */
export const GAP_HOLD_MS = 30_000

const TIMEOUT_MS = 10_000
const LOG_EVERY_MS = 60_000
const PUT = '/__tunnel/mail/put'
const TAKE = '/__tunnel/mail/take'
const BODY_KEYS = ['from', 'id', 'kind', 'level', 'sentAt', 'text', 'to', 'v'].join()
const ASK_KEYS = ['from', 'id', 'kind', 'level', 'replyBy', 'sentAt', 'text', 'to', 'v'].join()
const BODY2_KEYS = ['from', 'id', 'kind', 'level', 'n', 'sentAt', 'text', 'to', 'v'].join()
const ASK2_KEYS = ['from', 'id', 'kind', 'level', 'n', 'replyBy', 'sentAt', 'text', 'to', 'v'].join()
/** The hub queue's epoch: 16 bytes as base64url. */
const EPOCH = /^[A-Za-z0-9_-]{22}$/
const LEVELS = ['fyi', 'ask', 'interrupt']
/** A room's wake (bridge/mailbox.ts wake): the mailbox stores it fyi only and refuses ask or interrupt (403). */
const ROOM_SENDER = /^room:[A-Za-z0-9._:-]{1,128}$/

/** The hub's http(s) origin for its ws(s) link URL (bridge/hub-rpc.ts hubHttpOrigin, copied: that file loads the router). */
const httpOrigin = (wsOrigin: string) => wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')

type Json = Record<string, unknown>
type Copy = { id: string; from: string; seq: number; kind: string; body: string }
type Body = { id: string; from: string; to: string; level: Message['level']; text: string; sentAt: number; replyBy?: number; n?: number }

const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isCopy = (c: unknown): c is Copy => {
  const v = c as Json
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.from === 'string' &&
    Number.isSafeInteger(v.seq) && (v.seq as number) > 0 && typeof v.kind === 'string' && typeof v.body === 'string'
}

/** The signed body as a mail body with exactly the named keys and types, its sender local; else undefined. v:2 carries `n` (1 or more). */
function mailBody(text: string): Body | undefined {
  let b: Json
  try {
    b = JSON.parse(text) as Json
  } catch {
    return undefined
  }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return undefined
  const keys = Object.keys(b).sort().join()
  const v2 = b.v === 2 && Number.isSafeInteger(b.n) && (b.n as number) >= 1
  const ok = (b.v === 1 || v2) && b.kind === 'mail' && typeof b.id === 'string' && (isMailSender(b.from) || (typeof b.from === 'string' && ROOM_SENDER.test(b.from))) && typeof b.to === 'string' &&
    LEVELS.includes(b.level as string) && typeof b.text === 'string' && isTime(b.sentAt) &&
    (b.level === 'ask' ? keys === (v2 ? ASK2_KEYS : ASK_KEYS) && isTime(b.replyBy) : keys === (v2 ? BODY2_KEYS : BODY_KEYS))
  if (!ok) return undefined
  const out: Body = { id: b.id as string, from: b.from as string, to: b.to as string, level: b.level as Body['level'], text: b.text as string, sentAt: b.sentAt as number }
  if (b.level === 'ask') out.replyBy = b.replyBy as number
  if (v2) out.n = b.n as number
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
  /**
   * The last take's seq handled and stored here: the next take acks it. Never above what was
   * handled. Kept in state.db with the hub queue's epoch it counts in (U-R1A-33B-4).
   */
  const keptCursor = box.hubCursor()
  let cursor = keptCursor?.cursor ?? 0
  let epoch = keptCursor?.epoch
  /** The hub refused the epoch key (an older hub): `{ ack }` takes for the rest of this carrier's life. */
  let epochOff = false
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
      const bytes = await readHubAnswer(answer)
      let data: Json | undefined
      try {
        // Over the cap: as an answer that does not parse.
        const parsed: unknown = bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8'))
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
    /** The envelope over this row's body: v:2 with number `n`, or v:1 (an envelope kept before numbers). */
    const sign = (n: number | undefined) => {
      const body: Json = { v: 1, kind: 'mail', id: m.id, from: m.from, to: session, level: m.level, text: m.text, sentAt: m.sentAt }
      if (m.level === 'ask') body.replyBy = m.replyBy
      if (n !== undefined) Object.assign(body, { v: 2, n })
      return JSON.stringify(signEnvelope(signer(), { from: config.bridgeId, to: computer, body: JSON.stringify(body) }, now()))
    }
    if (kept === undefined) return box.keepNumbered(m.id, m.to, sign)
    const text = sign(box.numberOf(m.id))
    // ponytail: a re-signed envelope lives in memory only (keepEnvelope keeps the first); after a
    // restart the old one is stale again and is signed once more. The receiver drops extras by id.
    again.set(m.id, text)
    return text
  }

  async function pushOnce(): Promise<number> {
    if (now() < quietUntil) return 0
    let moved = 0
    const move = (id: string, state: 'sent' | 'queue_full' | 'refused' | 'expired', seq?: number, dest?: string) => {
      again.delete(id)
      if (!box.markRemote(id, state, seq)) return
      // The hub stored nothing: the number goes back when no later row has one (U-R1A-33B-4).
      if ((state === 'queue_full' || state === 'refused') && dest !== undefined) box.returnNumber(id, dest)
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
      // Only a row's first put can give its number back: an earlier put with no answer may be
      // stored at the hub, and a number the receiver may see is never given to another row.
      const back = box.envelopeOf(m.id) === undefined ? m.to : undefined
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
          move(m.id, 'queue_full', undefined, back)
          continue
        }
      } else if (status === 400 || status === 403) {
        move(m.id, 'refused', undefined, back)
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
    const n = body.n
    if (n === undefined) {
      // v:1 (an older sender): as before U-R1A-33B-4, no order rule.
      store(c.from, body, c.id)
      return record()
    }
    // Order: store, THEN the order row, THEN the nonce (record), THEN (pullOnce) the cursor; a stop
    // in between is repaired at the next take (receive answers repeat by id, hold ignores a second insert).
    const next = box.orderNext(c.from, body.to)
    if (next === undefined || n === next) {
      store(c.from, body, c.id)
      box.setOrderNext(c.from, body.to, n + 1)
      release(c.from, body.to)
    } else if (n > next) {
      if (box.hold(c.from, body.to, n, JSON.stringify(body), now()) === 'full') refuse('held_full')
    } else if (box.has(body.id)) {
      repeat()
    } else {
      // Its gap was reported already (or it was refused at store before): dropped.
      audit({ event: 'mail.late', from: c.from.slice(0, 300), to: body.to.slice(0, 300), n, id: body.id.slice(0, 300) })
      try {
        box.lateNotice(c.from, body.to)
      } catch (e) {
        if (!(e instanceof MailError)) throw e
        audit({ event: 'mail.refused', from: c.from.slice(0, 300), id: c.id.slice(0, 300), denied: 'mailbox', status: e.status })
      }
    }
    record()
  }

  /** One checked body from computer `from` into the mailbox; a refusal or a repeat is one audit line (id `id`). */
  function store(from: string, body: Body, id: string): void {
    const { n: _n, ...input } = body
    let stored: 'stored' | 'repeat'
    try {
      stored = box.receive({ ...input, from: `machine:${from}/${body.from}` })
    } catch (e) {
      if (!(e instanceof MailError)) throw e
      audit({ event: 'mail.refused', from: from.slice(0, 300), id: id.slice(0, 300), denied: 'mailbox', status: e.status })
      return
    }
    if (stored === 'repeat') audit({ event: 'mail.repeat', from: from.slice(0, 300), id: id.slice(0, 300) })
  }

  /** The held copies of one pair that are next in order, stored lowest first; the order moves past each. */
  function release(from: string, to: string): void {
    let next = box.orderNext(from, to)
    for (const h of box.heldFor(from, to)) {
      if (next === undefined || h.n > next) break
      if (h.n === next) {
        const body = JSON.parse(h.body) as Body
        store(from, body, body.id)
        box.setOrderNext(from, to, ++next)
      }
      // Released, or below next (stored before a stop left its row): the row goes.
      box.unhold(from, to, h.n)
    }
  }

  /** Every pair whose oldest held copy waited GAP_HOLD_MS: one mail.gap line, the notice, then the held copies in order. */
  function releaseGaps(): void {
    for (const p of box.heldPairs()) {
      if (p.oldestMs > now() - GAP_HOLD_MS) continue
      for (;;) {
        release(p.from, p.to)
        const held = box.heldFor(p.from, p.to)
        if (held.length === 0 || Math.min(...held.map((h) => h.heldMs)) > now() - GAP_HOLD_MS) break
        const first = box.orderNext(p.from, p.to) ?? held[0].n
        const last = held[0].n - 1
        audit({ event: 'mail.gap', from: p.from.slice(0, 300), to: p.to.slice(0, 300), missing_from: first, missing_to: last })
        box.closeGap(p.from, p.to, first, last)
      }
    }
  }

  async function pullOnce(): Promise<number> {
    releaseGaps()
    if (now() < quietUntil) return 0
    let handled = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      let { status, data } = await call(TAKE, JSON.stringify(epochOff ? { ack: cursor } : { ack: cursor, epoch: epoch ?? '' }))
      if (!epochOff && status === 400 && data?.error === 'mail_invalid') {
        // An older hub refuses the epoch key: the same page with { ack } (the old risk stays).
        epochOff = true
        audit({ event: 'mail.hub_epoch', supported: false })
        ;({ status, data } = await call(TAKE, JSON.stringify({ ack: cursor })))
      }
      if (status !== 200 || !Array.isArray(data?.copies)) {
        stop('pull', status)
        break
      }
      const durable = Object.hasOwn(data, 'epoch')
      if (durable) {
        const named = data.epoch
        if (typeof named !== 'string' || !EPOCH.test(named)) {
          stop('pull', status)
          break
        }
        if (named !== epoch) {
          // Another queue life: its numbers start again, so the cursor does too.
          if (epoch !== undefined) audit({ event: 'mail.hub_epoch', changed: true })
          box.setHubCursor(named, 0)
          cursor = 0
          epoch = named
        }
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
        if (durable) box.setHubCursor(epoch!, cursor)
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
