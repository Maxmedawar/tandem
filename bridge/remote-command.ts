/**
 * remote-command.ts: an agent on one computer opens, types into or closes a session on another,
 * only as that computer's limits file allows (U-R1A-36B; plan row A3.13, threat T28).
 *
 * A side (sendRemoteCommand, in the agent's own stdio server): the command is signed by this
 * computer's device key in an envelope (bridge/envelope.ts) to the target computer, body exactly
 * `{ v: 1, kind: "command", op, args, caller }`, and POSTed to the hub's /__tunnel/command with the
 * link bearer and a `tandem-proof` over the exact bytes. The hub checks that both computers are in
 * the roster it holds and passes the envelope, unread, to the target's bridge socket.
 *
 * B side (handleRemoteCommand, called by bridge/hub-rpc.ts for POST /remote/command): the sender is
 * the envelope's signer, checked against this computer's own verified roster, never the hub's
 * `tandem-command-from` header (not read here) and never the body. Order: body shape 400, unknown
 * sender 401, the envelope's own checks 401 (`to`, `time` in the default 300 s window, `signature`,
 * `replay` by nonce in state.db), command shape 400, the sender not in the applied limits file's
 * `control_from` 403; then route() with `from: 'agent'`, so every local gate holds as it does for an
 * agent here (kill switch 423, session_cap 429, the limits file 403, the input gate's agent rules).
 * One audit line per command, never its text. `now` is the one clock (the replay store's too).
 *
 * At most once, with a receipt: the nonce is only looked up while the envelope is checked, and is
 * recorded (with a receipt `received` in state.db's `command_receipt`) only for a command that is
 * about to run: one refused by its shape or by control_from uses up no nonce and stores nothing, so
 * a computer not listed cannot fill state.db, and a mail envelope passed here stays new for the mail
 * carrier. When route() answers, the receipt becomes `done` with the status and, for open and close,
 * the body (never a send's: that is a session's text; one over 16,384 characters is left out too).
 * The same envelope again is 401 `replay` with that receipt
 * (`{ state: "received" }`: it is running or was cut off, and is never run again), kept for as
 * long as the envelope could pass the time check. Send with empty text is the router's poll mode:
 * a listed computer reads the transcript of any session here that is not the relay's.
 *
 * Known gaps (stated): B's answer is not signed back, so the hub could alter the answer A sees
 * (it cannot make B act: B checks A's signature and its own control_from). A fabric call forwarded
 * through the hub still counts as the owner's at the memory home (U-R1A-34, U-R1A-36A). The A side
 * does not ask again for a lost answer; what it does get is data from the hub: hidden characters
 * are replaced and an answer over 1,048,576 characters is not passed on.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { CLOCK_SKEW_MS, DEFAULT_MAX_AGE_MS, EnvelopeError, openEnvelope, openReplayStore, signEnvelope } from './envelope.ts'
import { hubProofHeader, type HubLinkConfig } from './hub-link.ts'
import { limitsSnapshot, thisId, trustedKey } from './limits.ts'
import { route } from './router.ts'

// Vitest does not know about this Node 22 builtin; native require keeps the real node:sqlite (as envelope.ts).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type RemoteOp = 'open' | 'send' | 'close'
type Args = Record<string, string>
type Answer = { status: number; body: unknown }

const PATH = '/__tunnel/command'
/** An open on the other computer can take as long as the hub waits (110 s), plus the way there. */
const TIMEOUT_MS = 120_000
/** A computer id (bridge/envelope.ts ID). */
const COMPUTER = /^[a-z0-9._-]{1,64}$/
/** An agent caller: its session name (bridge/caller-tokens.ts). */
const CALLER = /^session:[A-Za-z0-9._-]{1,256}$/
/** The keys each op's args take: required, then optional. */
const ARGS: Record<RemoteOp, { need: string[]; may: string[] }> = {
  open: { need: ['engine'], may: ['name', 'cwd'] },
  send: { need: ['name', 'text'], may: [] },
  close: { need: ['name'], may: [] },
}
/** C0 controls but tab and newline, DEL, C1 controls, bidi controls, tag characters, a lone surrogate. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]|\p{Cs}/u
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu')
/** The longest receipt body kept, and the longest answer passed to an agent (characters). */
const MAX_RECEIPT_BODY = 16_384
const MAX_ANSWER = 1_048_576

type Receipt = { state: 'received' } | { state: 'done'; status: number; body?: unknown }

/** One use of state.db's `command_receipt` (the file exists: the replay store made it, mode 0600). */
function receipts<T>(use: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join(resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem')), 'state.db'))
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
function commandOf(text: string): { op: RemoteOp; args: Args; caller: string } | undefined {
  let b: unknown
  try {
    b = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlain(b) || Object.keys(b).sort().join() !== 'args,caller,kind,op,v') return undefined
  if (b.v !== 1 || b.kind !== 'command' || typeof b.op !== 'string' || !Object.hasOwn(ARGS, b.op)) return undefined
  if (typeof b.caller !== 'string' || !CALLER.test(b.caller) || !isPlain(b.args)) return undefined
  const { need, may } = ARGS[b.op as RemoteOp]
  const args = b.args
  const keys = Object.keys(args)
  if (!need.every((k) => keys.includes(k)) || !keys.every((k) => need.includes(k) || may.includes(k))) return undefined
  if (!keys.every((k) => typeof args[k] === 'string' && !HIDDEN.test(args[k] as string))) return undefined
  return { op: b.op as RemoteOp, args: args as Args, caller: b.caller }
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
  let cmd: { op: RemoteOp; args: Args; caller: string } | undefined
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
      opened = openEnvelope(raw, { sender: { id: sender, publicKey }, self: opts.self ?? thisId(), seen: peek, now: now() })
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e
      return e.reason === 'replay' ? replay() : done({ status: 401, body: { error: 'envelope', reason: e.reason } })
    }
    cmd = commandOf(opened.body)
    if (!cmd) return done({ status: 400, body: { error: 'command_invalid' } })
    if (!limitsSnapshot().control_from.includes(sender)) {
      return done({ status: 403, body: { error: `control_from: ${sender} may not act on this computer (limits file)` } })
    }
    if (!record()) return replay()
    receipts((db) => {
      db.prepare('DELETE FROM command_receipt WHERE expires_ms < ?').run(now())
      db.prepare('INSERT OR REPLACE INTO command_receipt (from_id, nonce, expires_ms) VALUES (?, ?, ?)').run(sender, nonce, opened.ts + DEFAULT_MAX_AGE_MS + CLOCK_SKEW_MS)
    })
  } finally {
    seen.close()
  }
  const { op, args } = cmd
  const name = encodeURIComponent(args.name ?? '')
  const call =
    op === 'open'
      ? { path: '/sessions/open', body: { ...args } }
      : op === 'send'
        ? { path: `/sessions/${name}/send`, body: { text: args.text } }
        : { path: `/sessions/${name}/close`, body: {} }
  const result = await route({ method: 'POST', path: call.path, query: new URLSearchParams(), body: call.body, from: 'agent' })
  const kept = JSON.stringify(result.body)
  receipts((db) =>
    db.prepare('UPDATE command_receipt SET status = ?, body = ? WHERE from_id = ? AND nonce = ?').run(result.status, op !== 'send' && kept !== undefined && kept.length <= MAX_RECEIPT_BODY ? kept : null, sender, nonce),
  )
  return done({ status: result.status, body: result.body })
}

/**
 * Signs `input` as this computer (`config.bridgeId`, key `opts.key` else this computer's device key)
 * for computer `input.to` and POSTs it to the hub's /__tunnel/command as the mail carrier makes a
 * call. Answers the hub's status and JSON body; no answer in 120 s (or no key) is 503 hub unreachable.
 */
export async function sendRemoteCommand(
  config: Pick<HubLinkConfig, 'url' | 'token' | 'bridgeId'>,
  input: { to: string; op: RemoteOp; args: Args; caller: string },
  opts: { key?: DeviceKey; now?: () => number } = {},
): Promise<Answer> {
  const now = opts.now ?? Date.now
  try {
    const key = opts.key ?? openDeviceKey()
    const command = JSON.stringify({ v: 1, kind: 'command', op: input.op, args: input.args, caller: input.caller })
    const envelope = JSON.stringify(signEnvelope(key, { from: config.bridgeId, to: input.to, body: command }, now()))
    const sent = JSON.stringify({ to: input.to, envelope })
    const answer = await fetch(config.url.replace(/^ws(s?):\/\//, 'http$1://') + PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'tandem-proof': hubProofHeader(key, { url: config.url, method: 'POST', path: PATH, id: config.bridgeId, body: sent }),
      },
      body: sent,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await answer.text()
    if (text.length > MAX_ANSWER) return { status: answer.status, body: { error: 'answer too large' } }
    // What comes back is data from the hub (not signed by the other computer): no hidden character reaches the agent.
    const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(HIDDEN_ALL, '\ufffd'))
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    return { status: answer.status, body: clean(parsed) }
  } catch {
    return { status: 503, body: { error: 'hub unreachable' } }
  }
}
