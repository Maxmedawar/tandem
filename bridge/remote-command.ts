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
 * Known gaps (stated): B's answer is not signed back, so the hub could alter the answer A sees
 * (it cannot make B act: B checks A's signature and its own control_from). A fabric call forwarded
 * through the hub still counts as the owner's at the memory home (U-R1A-34, U-R1A-36A). The nonce is
 * recorded before the command runs: a command cut off mid-run is never run again (at most once).
 */
import { audit } from './audit.ts'
import { openDeviceKey, type DeviceKey } from './device-keys.ts'
import { EnvelopeError, openEnvelope, openReplayStore, signEnvelope } from './envelope.ts'
import { hubProofHeader, type HubLinkConfig } from './hub-link.ts'
import { limitsSnapshot, thisId, trustedKey } from './limits.ts'
import { route } from './router.ts'

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
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩\u{e0000}-\u{e007f}]|\p{Cs}/u

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
  let opened: { body: string }
  const seen = openReplayStore({ now })
  try {
    opened = openEnvelope(raw, { sender: { id: from, publicKey }, self: opts.self ?? thisId(), seen, now: now() })
  } catch (e) {
    if (!(e instanceof EnvelopeError)) throw e
    return done({ status: 401, body: { error: 'envelope', reason: e.reason } })
  } finally {
    seen.close()
  }
  cmd = commandOf(opened.body)
  if (!cmd) return done({ status: 400, body: { error: 'command_invalid' } })
  if (!limitsSnapshot().control_from.includes(from)) {
    return done({ status: 403, body: { error: `control_from: ${from} may not act on this computer (limits file)` } })
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
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    return { status: answer.status, body: parsed }
  } catch {
    return { status: 503, body: { error: 'hub unreachable' } }
  }
}
