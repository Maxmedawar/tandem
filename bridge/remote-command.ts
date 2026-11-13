/**
 * remote-command.ts: an agent on one computer opens, types into, reads or closes a session on
 * another, only as that computer's limits file allows (U-R1A-36B, U-R1A-36E; plan row A3.13, threat T28).
 *
 * A side (sendRemoteCommand, in the agent's own stdio server): the command is signed by this
 * computer's device key in an envelope of kind `command` (bridge/envelope.ts, tag
 * `tandem-command-v1`, so no command passes as mail or presence) to the target computer, body
 * exactly `{ v: 1, kind: "command", op, args, caller }`, and POSTed to the hub's /__tunnel/command
 * with the link bearer and a `tandem-proof` over the exact bytes. The hub checks that both
 * computers are in the roster it holds, caps commands per target computer (60 in 60 s, 429
 * target_busy) and passes the envelope, unread, to the target's bridge socket. A device key that
 * cannot be opened is 500 `device key unavailable on this computer` and nothing is sent.
 *
 * B side (handleRemoteCommand, called by bridge/hub-rpc.ts for POST /remote/command): the sender is
 * the envelope's signer, checked against this computer's own verified roster, never the hub's
 * `tandem-command-from` header (not read here) and never the body. Order: body shape 400, unknown
 * sender 401, the envelope's own checks 401 (`to`, `time` in a 60 s window with 60 s of skew,
 * `signature` under the command tag, `replay` by nonce in state.db), command shape 400, then the
 * sender's rights in the applied limits file (bridge/limits.ts rightsOf: `control_from` or the
 * right's own `control_from_<right>` list): open needs `open`, send with text `send`, send with
 * empty text (the router's poll: it returns the session's screen) `read`, close `close`, status any
 * one right; a send with text answers the turn's output (`report`, `cursor`) only to a sender that
 * also holds `read`, else only that it was typed (status, name, engine, state, attachHint); no right at all is the `control_from` 403, a missing one its own 403. Then route()
 * with `from: 'agent'`, so every local gate holds as it does for an agent here (kill switch 423,
 * session_cap 429, the limits file 403, the input gate's agent rules); a remote read is refused
 * 423 here too while the kill switch is on (route() lets a local read through). A close and a
 * status still answer while the switch is on: they stop a session or report. One audit line per
 * command, never its text. `now` is the one clock (the replay store's too).
 *
 * At most once, with a receipt: the nonce is only looked up while the envelope is checked, and is
 * recorded (with a receipt `received` in state.db's `command_receipt`) only for a command that is
 * about to run: one refused by its shape or by the rights uses up no nonce and stores nothing, so a
 * computer not listed cannot fill state.db, and a mail envelope passed here stays new for the mail
 * carrier. When route() answers, the receipt becomes `done` with the status and, for open and close,
 * the body (never a send's or a poll's: that is a session's text; one over 16,384 characters is left
 * out too). Receipts are kept 600 s. The same envelope again is 401 `replay` with that receipt
 * (`{ state: "received" }`: it is running or was cut off, and is never run again).
 *
 * Status (op `status`, args `{ id }`, the nonce of an earlier command): answers only the sender's
 * own receipt for that id (404 none, 202 received, 200 done), never another computer's, and never
 * session text. Its own nonce is recorded (it cannot be replayed); it stores no receipt. The A side
 * asks it exactly once, only when the first answer may hide a command that ran (no answer, 502,
 * 504, or 503 `bridge_offline` without `requested`: the target's socket closed after the frame
 * was sent); it never asks in a loop, and a lost status answer is not asked again.
 *
 * Known gaps (stated): the rights trust a computer, not a session on it; `caller` is a label. B's
 * answer is not signed back (a status answer neither), so the hub could alter the answer A sees
 * (it cannot make B act: B checks A's signature and its own rights). The hub's cap lives in its
 * Durable Object's memory: a restart forgets it. A fabric call forwarded through the hub still
 * counts as the owner's at the memory home (U-R1A-34, U-R1A-36A). What the A side gets is data
 * from the hub: hidden characters are replaced and an answer over 1,048,576 characters is not
 * passed on.
 */
import { join } from 'node:path'
import { tandemHome } from './tandem-home.ts'
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { EnvelopeError, openEnvelope, openReplayStore, signEnvelope } from './envelope.ts'
import { hubProofHeader, readHubAnswer, type HubLinkConfig } from './hub-link.ts'
import { KILL_SWITCH_ON, killSwitchOn } from './kill-switch.ts'
import { rightsOf, thisId, trustedKey, type Right } from './limits.ts'
import { route } from './router.ts'
import { DatabaseSync } from './sqlite-file.ts'

export type RemoteOp = 'open' | 'send' | 'close'
/** `status` is the A side's own ask after a lost answer, never an agent's tool input. */
type Op = RemoteOp | 'status'
type Args = Record<string, string>
type Answer = { status: number; body: unknown }

const PATH = '/__tunnel/command'
/** An open on the other computer can take as long as the hub waits (110 s), plus the way there. */
const TIMEOUT_MS = 120_000
/** The one status call after a lost answer. */
const STATUS_TIMEOUT_MS = 15_000
/** A command lives 60 s and may come 60 s early (the mail window is 300 s). */
const COMMAND_MAX_AGE_MS = 60_000
const COMMAND_MAX_SKEW_MS = 60_000
/** How long a command's receipt is kept, from its ts. */
const RECEIPT_KEEP_MS = 600_000
/** An envelope nonce (bridge/envelope.ts NONCE): what `status` asks by. */
const NONCE = /^[A-Za-z0-9_-]{22}$/
/** A computer id (bridge/envelope.ts ID). */
const COMPUTER = /^[a-z0-9._-]{1,64}$/
/** An agent caller: its session name (bridge/caller-tokens.ts). */
const CALLER = /^session:[A-Za-z0-9._-]{1,256}$/
/** The keys each op's args take: required, then optional. */
const ARGS: Record<Op, { need: string[]; may: string[] }> = {
  open: { need: ['engine'], may: ['name', 'cwd'] },
  send: { need: ['name', 'text'], may: [] },
  close: { need: ['name'], may: [] },
  status: { need: ['id'], may: [] },
}
/** What a computer holding some rights but not the one needed is told. */
const REFUSED: Record<Exclude<Right, 'ask'>, string> = {
  open: 'may not open sessions here',
  send: 'may not type into sessions here',
  close: 'may not close sessions here',
  read: 'may not read sessions here',
}
/** What a send with text answers a computer holding `send` but not `read`: that it was typed, never the session's output. */
const SEND_ACK = ['status', 'name', 'engine', 'state', 'attachHint']
/** C0 controls but tab and newline, DEL, C1 controls, bidi controls, tag characters, a lone surrogate. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]|\p{Cs}/u
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu')
/** The longest receipt body kept, and the longest answer passed to an agent (characters). */
const MAX_RECEIPT_BODY = 16_384
const MAX_ANSWER = 1_048_576

type Receipt = { state: 'received' } | { state: 'done'; status: number; body?: unknown }

/** One use of state.db's `command_receipt` (the file exists: the replay store made it, mode 0600). */
function receipts<T>(use: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join(tandemHome(), 'state.db'))
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS command_receipt (
        from_id TEXT NOT NULL, nonce TEXT NOT NULL, status INTEGER, body TEXT, expires_ms INTEGER NOT NULL,
        PRIMARY KEY (from_id, nonce))`)
    return use(db)
  } finally {
    db.close()
  }
}

/** The receipt of the command `from` signed with `nonce`, if one is kept. */
function receiptOf(from: string, nonce: string): Receipt | undefined {
  const row = receipts((db) => db.prepare('SELECT status, body FROM command_receipt WHERE from_id = ? AND nonce = ?').get(from, nonce)) as
    | { status: number | null; body: string | null }
    | undefined
  if (!row) return undefined
  if (row.status === null) return { state: 'received' }
  return { state: 'done', status: Number(row.status), ...(row.body === null ? {} : { body: JSON.parse(row.body) as unknown }) }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The command body when it is exactly the shape (keys, types, op, args, caller, no hidden character), else undefined. */
function commandOf(text: string): { op: Op; args: Args; caller: string } | undefined {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlain(b) || Object.keys(b).sort().join() !== 'args,caller,kind,op,v') return undefined
  if (b.v !== 1 || b.kind !== 'command' || typeof b.op !== 'string' || !Object.hasOwn(ARGS, b.op)) return undefined
  if (typeof b.caller !== 'string' || !CALLER.test(b.caller) || !isPlain(b.args)) return undefined
  const { need, may } = ARGS[b.op as Op]
  const args = b.args
  const keys = Object.keys(args)
  if (!need.every((k) => keys.includes(k)) || !keys.every((k) => need.includes(k) || may.includes(k))) return undefined
  if (!keys.every((k) => typeof args[k] === 'string' && !HIDDEN.test(args[k] as string))) return undefined
  if (b.op === 'status' && !NONCE.test(args.id as string)) return undefined
  return { op: b.op as Op, args: args as Args, caller: b.caller }
}

/**
 * A command from another computer, as the hub passed it (`{ envelope }`). `trusted` gives a
 * computer's key (default this computer's verified roster; a throw is none), `self` this computer's
 * id (default thisId()), `now` the clock of every check and of the replay store.
 */
export async function handleRemoteCommand(
  body: unknown,
  opts: { now?: () => number; trusted?: (id: string) => string | undefined; self?: string } = {},
): Promise<Answer> {
  const now = opts.now ?? Date.now
  const trusted = opts.trusted ?? trustedKey
  let from: unknown
  let cmd: { op: Op; args: Args; caller: string } | undefined
  let mayRead = false
  const done = (answer: Answer): Answer => {
    audit({
      event: 'remote.command',
      from: typeof from === 'string' ? from.slice(0, 64) : undefined,
      caller: cmd?.caller,
      op: cmd?.op,
      name: cmd?.args.name,
      status: answer.status,
    })
    return answer
  }
  if (!isPlain(body) || Object.keys(body).join() !== 'envelope' || typeof body.envelope !== 'string') {
    return done({ status: 400, body: { error: 'command_invalid' } })
  }
  const raw = body.envelope
  try {
    from = (JSON.parse(raw) as { from?: unknown }).from
  } catch {
    from = undefined
  }
  let publicKey: string | undefined
  if (typeof from === 'string' && COMPUTER.test(from)) {
    try {
      publicKey = trusted(from)
    } catch {
      publicKey = undefined
    }
  }
  if (typeof from !== 'string' || publicKey === undefined) return done({ status: 401, body: { error: 'envelope', reason: 'unknown_sender' } })
  const sender = from
  let nonce = ''
  const replay = (): Answer => {
    const receipt = receiptOf(sender, nonce)
    return done({ status: 401, body: { error: 'envelope', reason: 'replay', ...(receipt ? { receipt } : {}) } })
  }
  const seen = openReplayStore({ now })
  try {
    let opened: { body: string; ts: number }
    // The nonce is only looked up here (as the mail carrier does) and recorded below, for a command about to run.
    let record = (): boolean => false
    const peek = {
      remember: (id: string, n: string, expiresAt: number) => {
        nonce = n
        record = () => seen.remember(id, n, expiresAt)
        return !seen.has(id, n)
      },
    }
    try {
      opened = openEnvelope(raw, {
        sender: { id: sender, publicKey }, self: opts.self ?? thisId(), seen: peek, now: now(),
        kind: 'command', maxAgeMs: COMMAND_MAX_AGE_MS, maxSkewMs: COMMAND_MAX_SKEW_MS,
      })
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e
      return e.reason === 'replay' ? replay() : done({ status: 401, body: { error: 'envelope', reason: e.reason } })
    }
    cmd = commandOf(opened.body)
    if (!cmd) return done({ status: 400, body: { error: 'command_invalid' } })
    // The rights, read once from the applied limits file: a refusal uses no nonce and stores nothing.
    const rights = rightsOf(sender)
    const need: Exclude<Right, 'ask'> | undefined =
      cmd.op === 'status' ? undefined : cmd.op === 'send' ? (cmd.args.text === '' ? 'read' : 'send') : cmd.op
    if (rights.length === 0) {
      return done({ status: 403, body: { error: `control_from: ${sender} may not act on this computer (limits file)` } })
    }
    if (need !== undefined && !rights.includes(need)) {
      return done({ status: 403, body: { error: `control_from_${need}: ${sender} ${REFUSED[need]} (limits file)` } })
    }
    mayRead = rights.includes('read')
    if (!record()) return replay()
    if (cmd.op !== 'status') {
      receipts((db) => {
        db.prepare('DELETE FROM command_receipt WHERE expires_ms < ?').run(now())
        db.prepare('INSERT OR REPLACE INTO command_receipt (from_id, nonce, expires_ms) VALUES (?, ?, ?)').run(sender, nonce, opened.ts + RECEIPT_KEEP_MS)
      })
    }
  } finally {
    seen.close()
  }
  const { op, args } = cmd
  if (op === 'status') {
    // Only this sender's own receipt is looked up: another computer's is never found.
    const receipt = receiptOf(sender, args.id)
    if (!receipt) return done({ status: 404, body: { error: 'command_status: no receipt for that id' } })
    return receipt.state === 'received' ? done({ status: 202, body: receipt }) : done({ status: 200, body: receipt })
  }
  const finish = (status: number, kept: string | null) =>
    receipts((db) => db.prepare('UPDATE command_receipt SET status = ?, body = ? WHERE from_id = ? AND nonce = ?').run(status, kept, sender, nonce))
  if (op === 'send' && args.text === '' && killSwitchOn()) {
    // A remote read is refused while the switch is on (route() lets a local read through).
    audit({ route: 'POST /sessions/:name/send', name: args.name, denied: 'kill-switch' })
    finish(423, null)
    return done({ status: 423, body: { error: KILL_SWITCH_ON } })
  }
  const name = encodeURIComponent(args.name ?? '')
  const call =
    op === 'open'
      ? { path: '/sessions/open', body: { ...args } }
      : op === 'send'
        ? { path: `/sessions/${name}/send`, body: { text: args.text } }
        : { path: `/sessions/${name}/close`, body: {} }
  const result = await route({ method: 'POST', path: call.path, query: new URLSearchParams(), body: call.body, from: 'agent' })
  const kept = JSON.stringify(result.body)
  finish(result.status, op !== 'send' && kept !== undefined && kept.length <= MAX_RECEIPT_BODY ? kept : null)
  // Typing is not reading: without the read right a send that was typed answers only that it was (no report, no cursor).
  const b = result.body
  if (op === 'send' && !mayRead && result.status < 300 && isPlain(b)) {
    return done({ status: result.status, body: Object.fromEntries(SEND_ACK.filter((k) => Object.hasOwn(b, k)).map((k) => [k, b[k]])) })
  }
  return done({ status: result.status, body: result.body })
}

/**
 * Signs `input` as this computer (`config.bridgeId`, key `opts.key` else this computer's device key)
 * for computer `input.to` and POSTs it to the hub's /__tunnel/command as the mail carrier makes a
 * call. Answers the hub's status and JSON body; no answer in 120 s is 503 hub unreachable; a key
 * that cannot be opened is 500. When the answer may hide a command that ran (no answer, 502, 504,
 * or 503 `bridge_offline` without `requested`), asks B once for that command's receipt and answers
 * it (a send's as `{ state: "done" }`); else, or when that ask fails, the first answer.
 */
export async function sendRemoteCommand(
  config: Pick<HubLinkConfig, 'url' | 'token' | 'bridgeId'>,
  input: { to: string; op: RemoteOp; args: Args; caller: string },
  opts: { key?: DeviceKey; now?: () => number } = {},
): Promise<Answer> {
  const now = opts.now ?? Date.now
  let key: DeviceKey
  try {
    key = opts.key ?? openDeviceKey()
  } catch {
    return { status: 500, body: { error: 'device key unavailable on this computer' } }
  }
  // What comes back is data from the hub (not signed by the other computer): no hidden character reaches the agent.
  const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(HIDDEN_ALL, '\ufffd'))
  /** One signed command to the hub: its answer, its nonce, and whether it may have run at B all the same. */
  const post = async (op: Op, args: Args, timeoutMs: number): Promise<{ answer: Answer; nonce: string; maybe: boolean }> => {
    let nonce = ''
    try {
      const command = JSON.stringify({ v: 1, kind: 'command', op, args, caller: input.caller })
      const signed = signEnvelope(key, { from: config.bridgeId, to: input.to, body: command }, now(), 'command')
      nonce = signed.nonce
      const sent = JSON.stringify({ to: input.to, envelope: JSON.stringify(signed) })
      const answer = await fetch(config.url.replace(/^ws(s?):\/\//, 'http$1://') + PATH, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'tandem-proof': hubProofHeader(key, { url: config.url, method: 'POST', path: PATH, id: config.bridgeId, body: sent }),
        },
        body: sent,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const bytes = await readHubAnswer(answer)
      const lost = answer.status === 502 || answer.status === 504
      if (bytes === undefined) return { answer: { status: answer.status, body: { error: 'answer too large' } }, nonce, maybe: lost }
      const text = bytes.toString('utf8')
      if (text.length > MAX_ANSWER) return { answer: { status: answer.status, body: { error: 'answer too large' } }, nonce, maybe: lost }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { error: text.slice(0, 200) }
      }
      // The hub's socket to B closed after the frame was sent; its refusal before sending names `requested`.
      const cut = answer.status === 503 && isPlain(parsed) && Object.keys(parsed).join() === 'error' && parsed.error === 'bridge_offline'
      return { answer: { status: answer.status, body: clean(parsed) }, nonce, maybe: lost || cut }
    } catch {
      return { answer: { status: 503, body: { error: 'hub unreachable' } }, nonce, maybe: nonce !== '' }
    }
  }
  const first = await post(input.op, input.args, TIMEOUT_MS)
  if (!first.maybe) return first.answer
  const asked = await post('status', { id: first.nonce }, STATUS_TIMEOUT_MS)
  const r = asked.answer.body
  if (asked.answer.status === 200 && isPlain(r) && r.state === 'done' && typeof r.status === 'number') {
    return { status: r.status, body: Object.hasOwn(r, 'body') ? r.body : { state: 'done' } }
  }
  if (asked.answer.status === 202) return { status: 202, body: { state: 'received' } }
  return first.answer
}
