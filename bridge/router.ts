/**
 * router.ts — local RPC router (the TRUST BOUNDARY).
 *
 * Network transport stays outside this module. Tandem's MCP servers call
 * `route()` directly in-process, keeping the route table, handlers, name
 * validation, relay-owned isolation, cwd admission, and audit policy inside
 * one explicit trust boundary.
 *
 * ENGINE-AWARE (Phase 2): a drivable "session" is either a REAL interactive
 * claude/codex/shell TUI in a tmux session "ccm-<name>" (driven by the shared
 * TerminalSession lifecycle via keystroke injection + pane scraping; claude, codex
 * and every other harness-file agent through engines/harness-engine.ts), or an
 * agent attached through the adapter its built-in harness file names (ADAPTERS
 * in harness-registry.ts; Hermes, over loopback HTTP, not tmux). We
 * NEVER run `claude -p` / headless and NEVER set ANTHROPIC_API_KEY, so Claude
 * usage stays on the user's interactive subscription. The autonomous capability
 * is the zero-API two-session relay, which stays Claude-only and unaffected by
 * engine selection.
 *
 * ENGINE RESOLUTION ORDER (binding — Phase 2 correction E): every open_session
 * call resolves and validates the engine (unknown id → 400, disabled → 403,
 * enabled-but-unavailable: no file loaded or no program → 503) via engine-registry.ts BEFORE any
 * cwd resolution, tmux lookup, spawn, or network side effect. An engine
 * mismatch on session-NAME reuse (a name already open under a different
 * engine) is rejected with 409 before any further work too.
 *
 * SECURITY RAILS:
 *   - cwd ALLOWLIST (buildAllowlist / isCwdAllowed / safeResolve from
 *     sessions.ts). Any cwd outside the allowlist is rejected with a clean 403.
 *     Paths are realpath-canonicalized before the check so `..` / symlink escapes
 *     can't slip through, and the prefix comparison uses a trailing separator so
 *     "/srv/code" does NOT match "/srv/code-evil".
 *   - LIMITS FILE (limits.ts): after those env switches, opens and relay starts also need the
 *     limits file's agents (pinned program), shell, folders and, for prompts off, permission_skip.
 *     It is read at start and only applied at this computer; nothing remote widens it.
 *   - Only ccm-* tmux sessions (harness-file agents) or an agent an adapter
 *     attached (its own allowlist, e.g. Hermes's writable agent ids) are drivable.
 *   - tmux send-keys is injection-safe (-l literal + -- end-of-options).
 *   - INPUT GATE (input-gate.ts): typed input (send text with its per-send model/effort, and
 *     interrupt keys) enters a session only as the input gate allows, by who is typing:
 *     RpcRequest.from, set on the request by the in-process caller and read once in route(),
 *     never from the body; no value is the owner (every caller today is the owner's client or
 *     cannot be told apart from one; a per-session caller token arrives with U-R1A-36). The
 *     owner types at any time except while the session waits for approval (409); an agent types
 *     only at a settled idle prompt, else it is held (200, status held, nothing typed or queued),
 *     and never interrupts (403). Poll mode, read, open, close and the relay routes type nothing
 *     and are not gated. What the gate does not stop is listed where it runs, in handleSend.
 *   - Audit log: every spawn / send / read / interrupt / close / relay control appends
 *     metadata only to a private ~/.tandem/bridge.log. Prompt, command, task,
 *     goal, context, report, output, and request-body values are replaced with
 *     byte counts. A failed audit write surfaces to stderr.
 *
 * Config (env): TANDEM_CWD_ALLOWLIST / TANDEM_DEFAULT_CWD are mapped to the
 * engine's CCM_* names by the entrypoint before this module loads.
 * TANDEM_ENABLED_ENGINES opts engines in; none is on by default (see engine-registry.ts).
 */

import { homedir } from 'node:os'
import { validateModel, validateEffort, TerminalSession } from './terminal-session.ts'
import type { DrivableSession, EngineId } from './drivable.ts'
import { ADAPTERS, type AdapterOpenResult, type Harness } from './harness-registry.ts'
import {
  resolveEngine,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
} from './engine-registry.ts'
import { HarnessSession } from './engines/harness-engine.ts'
import {
  buildAllowlist,
  isCwdAllowed,
  safeResolve,
  getLive,
  registerLive,
  unregisterLive,
  listSessions,
} from './sessions.ts'
import * as relay from './relay.ts'
import { emitCompletion, summarize } from './events.ts'
import { audit } from './audit.ts'
import { limitsGate } from './limits.ts'
import { admitInput, type InputAction, type InputFrom, type InputVerdict } from './input-gate.ts'
import type { ReadState } from './harness-detect.ts'

// ---- config ---------------------------------------------------------------

const HOME = homedir()
/** The explicit allowlist is built once from env at startup. */
const ALLOWLIST = buildAllowlist()
/** If no default is configured, use the first explicitly allowlisted root. */
const DEFAULT_CWD = process.env.CCM_DEFAULT_CWD ?? ALLOWLIST[0] ?? HOME

export function getAllowlist(): string[] {
  return ALLOWLIST
}

/** A bridge-generated session name when the client doesn't supply one. */
function generateName(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

/** Session names must be tmux/file safe (mirrors TerminalSession.spawn's guard). */
const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * Relay-owned session names (relay.ts names its internal lead/worker sessions
 * `relay-<loopId>-lead` / `relay-<loopId>-worker`). They satisfy NAME_RE, so the
 * generic session-control routes would otherwise let a remote caller reach INTO
 * the relay's two TUIs out-of-band of the relay protocol. The relay is a separate
 * capability surface; its sessions are drivable ONLY through the /relay/* routes.
 */
const RELAY_NAME_RE = /^relay-/

export function isRelayOwned(name: string): boolean {
  return RELAY_NAME_RE.test(name)
}

// ---- RPC routing ----------------------------------------------------------

export interface RpcRequest {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown>
  /** Who is typing, for the input gate (input-gate.ts): set by the in-process caller, never taken
   *  from the body. No value is the owner. */
  from?: InputFrom
}

export interface RpcResult {
  status: number
  body: unknown
}

function ok(body: unknown): RpcResult {
  return { status: 200, body }
}
function err(status: number, message: string): RpcResult {
  return { status, body: { error: message } }
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** listSessions' default limit, applied after an agent filter as on an unfiltered list. */
const DEFAULT_LIST_LIMIT = 20

/** Rows of `engine` (`terminal` means `shell`), then the caller's limit. No engine or `all` keeps every row. */
export function filterSessionsByEngine<T extends { engine?: string }>(
  sessions: T[],
  engine: string | undefined,
  limit: number,
): T[] {
  if (!engine || engine === 'all') return sessions.slice(0, limit)
  const wanted = engine === 'terminal' ? 'shell' : engine
  return sessions.filter((session) => session.engine === wanted).slice(0, limit)
}

/**
 * Test/entry seam: run the router with a minimal request shape. The MCP server
 * calls this for every tool invocation.
 */
export async function routeForTest(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  rawQuery = '',
): Promise<RpcResult> {
  return route({ method, path, query: new URLSearchParams(rawQuery), body })
}

export async function route(req: RpcRequest): Promise<RpcResult> {
  const parts = pathParts(req.path)
  const m = req.method.toUpperCase()
  // Who is typing, read once here for the input gate; nothing in the body can say it.
  const from: InputFrom = req.from ?? 'owner'

  // GET /sessions, optionally one agent's rows (?engine=); the limit applies after the filter.
  if (m === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
    const limit = req.query.get('limit') ? Number(req.query.get('limit')) : undefined
    const project = req.query.get('project') ?? undefined
    const engine = req.query.get('engine') ?? undefined
    if (!engine || engine === 'all') return ok(await listSessions({ limit, project }))
    const { sessions, ...rest } = await listSessions({ limit: Number.MAX_SAFE_INTEGER, project })
    return ok({ ...rest, sessions: filterSessionsByEngine(sessions, engine, limit ?? DEFAULT_LIST_LIMIT) })
  }

  // POST /sessions/open
  if (m === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'open') {
    return handleOpen(req)
  }

  // .../sessions/:name/<action>
  if (parts.length === 3 && parts[0] === 'sessions') {
    const name = decodeURIComponent(parts[1])
    const action = parts[2]
    // Relay-owned sessions are isolated from the generic session routes.
    if (isRelayOwned(name)) {
      audit({ route: `${m} /sessions/:name/${action}`, name, denied: 'relay-owned' })
      return err(409, `session "${name}" is relay-owned; use the relay routes`)
    }
    // Typed input takes a JSON object for a body: any other value (null, an array, a string, a
    // number) is refused here, before a handler reads a key of it.
    if (m === 'POST' && (action === 'send' || action === 'interrupt')) {
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return err(400, 'body must be a JSON object')
    }
    // Reads are audited once, live or not, never with text. A send with empty text is the
    // poll mode (it returns the transcript), so it is a read.
    if (m === 'POST' && action === 'send' && !String(req.body?.['text'] ?? '')) {
      audit({ route: 'POST /sessions/:name/send', name, read: true })
    }
    if (m === 'GET' && action === 'read') audit({ route: 'GET /sessions/:name/read', name })
    if (m === 'POST' && action === 'send') return handleSend(name, req, from)
    if (m === 'GET' && action === 'read') return handleRead(name, req)
    if (m === 'POST' && action === 'interrupt') return handleInterrupt(name, from)
    if (m === 'POST' && action === 'close') return handleClose(name)
  }

  // POST /relay/start
  if (m === 'POST' && parts.length === 2 && parts[0] === 'relay' && parts[1] === 'start') {
    return handleRelayStart(req)
  }

  // .../relay/:loopId/<action>
  if (parts.length === 3 && parts[0] === 'relay') {
    const loopId = decodeURIComponent(parts[1])
    const action = parts[2]
    if (m === 'GET' && action === 'read') {
      audit({ route: 'GET /relay/:loopId/read', loopId })
      return handleRelayRead(loopId, req)
    }
    if (m === 'POST' && action === 'stop') {
      audit({ route: 'POST /relay/:loopId/stop', loopId })
      return ok(relay.stop(loopId))
    }
    if (m === 'POST' && action === 'inject') {
      const message = String(req.body['message'] ?? '')
      if (!message) return err(400, 'message is required')
      audit({ route: 'POST /relay/:loopId/inject', loopId, text: message })
      return ok(relay.inject(loopId, message))
    }
    if (m === 'POST' && action === 'enqueue') {
      const task = String(req.body['task'] ?? req.body['message'] ?? '')
      if (!task.trim()) return err(400, 'task is required')
      audit({ route: 'POST /relay/:loopId/enqueue', loopId, task })
      return ok(relay.enqueue(loopId, task))
    }
  }

  return err(404, `no route for ${m} ${req.path}`)
}

// ---- session handlers -----------------------------------------------------

async function handleOpen(req: RpcRequest): Promise<RpcResult> {
  const rawName = req.body['name'] !== undefined ? String(req.body['name']) : generateName()
  const name = rawName.trim()
  if (!NAME_RE.test(name)) {
    return err(400, `invalid session name (allowed: A-Z a-z 0-9 . _ -): ${name}`)
  }
  // The relay- namespace is reserved for relay.ts's internal sessions.
  if (isRelayOwned(name)) {
    audit({ route: 'POST /sessions/open', name, denied: 'relay-owned' })
    return err(409, `session name "${name}" is reserved for the relay; use the relay routes`)
  }

  // Resolve + validate the engine FIRST — before any cwd/tmux/network side
  // effect (binding — Phase 2 correction E). No engine is on by default and an
  // open must name one (400 naming the enabled ones); each engine needs explicit
  // opt-in via TANDEM_ENABLED_ENGINES.
  const rawEngine = req.body['engine'] !== undefined ? String(req.body['engine']) : undefined
  let engine: EngineId
  let harness: Harness
  try {
    ;({ id: engine, harness } = await resolveEngine(rawEngine))
  } catch (e) {
    return engineError(e)
  }

  // An engine mismatch on name reuse is rejected before any further work,
  // regardless of which engine's open path would otherwise run.
  const liveExisting = getLive(name)
  if (liveExisting && liveExisting.engine !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: liveExisting.engine })
    return err(409, `session "${name}" already exists with engine "${liveExisting.engine}"`)
  }

  if (harness.adapter !== undefined) return handleOpenAdapter(engine, name, req, harness)
  return handleOpenTmux(engine, name, req, harness)
}

/** resolveEngine's typed errors as router answers: unknown or missing 400, disabled 403, no file or program 503. */
function engineError(e: unknown): RpcResult {
  if (e instanceof UnknownEngineError) return err(400, e.message)
  if (e instanceof EngineDisabledError) return err(403, e.message)
  if (e instanceof EngineUnavailableError) return err(503, e.message)
  return err(500, e instanceof Error ? e.message : String(e))
}

/** open_session for an adapter agent (its built-in harness file names `adapter`): attach through
 *  ADAPTERS[harness.adapter], which checks the agent answers. No spawn, no cwd, no model/effort,
 *  and outside the limits file (bridge/limits.ts pins programs; an adapter agent has none). */
async function handleOpenAdapter(engine: EngineId, name: string, req: RpcRequest, harness: Harness): Promise<RpcResult> {
  for (const field of ['cwd', 'model', 'effort']) {
    if (req.body[field] !== undefined) return err(400, `${field} is not supported for engine "${engine}"`)
  }

  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, engine, reused: true })
    return ok({ name: existing.id, engine, attachHint: existing.attachHint(), reused: true })
  }

  // A tmux-hosted session may have survived a bridge restart without yet being
  // re-adopted into the in-memory registry. Never let an adapter attachment claim
  // that live session's name and hide/misroute it. Any ccm-<name> collision is a
  // conflict, including an untagged one.
  if (await TerminalSession.exists(name)) {
    const existingEngine = await TerminalSession.engineTagOf(name)
    audit({
      route: 'POST /sessions/open',
      name,
      engine,
      denied: 'tmux-name-conflict',
      ...(existingEngine ? { existingEngine } : {}),
    })
    return err(
      409,
      existingEngine
        ? `session "${name}" already exists with engine "${existingEngine}"`
        : `session "${name}" already exists as a tmux session`,
    )
  }

  let opened: AdapterOpenResult
  try {
    opened = await ADAPTERS[harness.adapter!](name)
  } catch (e) {
    return err(500, `failed to attach: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!('session' in opened)) {
    audit({ route: 'POST /sessions/open', name, engine, denied: opened.denied })
    return err(opened.status, opened.error)
  }
  registerLive(opened.session)
  audit({ route: 'POST /sessions/open', name: opened.session.id, engine })
  return ok({ name: opened.session.id, engine, attachHint: opened.session.attachHint() })
}

/** open_session for harness engines (claude, codex and shell included): the shared tmux
 *  lifecycle, generalized from Phase 1's Claude-only path. model/effort remain Claude-only. */
async function handleOpenTmux(engine: EngineId, name: string, req: RpcRequest, harness: Harness): Promise<RpcResult> {
  // Per-session model/effort (optional, Claude only — binding Phase 2 correction
  // C: no silent option loss for codex/shell). Validated up front so a bad value
  // fails as a clean 400 rather than a generic 500 from spawn.
  let model: string | undefined
  let effort: string | undefined
  if (engine === 'claude') {
    try {
      if (req.body['model'] !== undefined) model = validateModel(String(req.body['model']))
      if (req.body['effort'] !== undefined) effort = validateEffort(String(req.body['effort']))
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e))
    }
  } else {
    if (req.body['model'] !== undefined) return err(400, `model is not supported for engine "${engine}"`)
    if (req.body['effort'] !== undefined) return err(400, `effort is not supported for engine "${engine}"`)
  }

  // Idempotent: reuse a session already live under this name (engine already
  // confirmed to match by the caller, handleOpen).
  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, engine, cwd: existing.cwd, reused: true })
    return ok({ name: existing.id, engine, cwd: existing.cwd, attachHint: existing.attachHint(), reused: true })
  }

  // A live, already-admitted session can be reused without re-applying a cwd
  // admission check. Fresh spawn and restart adoption still require the
  // explicit allowlist below. Keeping this after option validation also means
  // unsupported controls never become silent no-ops on reuse.
  const cwdInput = req.body['cwd'] !== undefined ? String(req.body['cwd']) : DEFAULT_CWD
  if (!isCwdAllowed(cwdInput, ALLOWLIST)) {
    return err(403, `cwd not allowed: ${cwdInput}`)
  }
  const cwd = safeResolve(cwdInput)

  // The limits file (bridge/limits.ts) is the ceiling over the env switches above: the agent
  // (pinned program, an owner file's sha256, shell) and the folder, before any tmux call.
  const gate = limitsGate()
  const denied = gate.agent(harness) ?? gate.folder(cwd)
  if (denied) {
    audit({ route: 'POST /sessions/open', name, engine, cwd, denied: 'limits' })
    return err(403, denied)
  }

  // A same-named ccm-* tmux session tagged with a DIFFERENT engine is a 409
  // conflict, distinct from a provenance/cwd adoption failure (403) — checked
  // before attempting adoption so the caller gets the precise reason.
  const existingTag = await TerminalSession.engineTagOf(name)
  if (existingTag !== undefined && existingTag !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: existingTag })
    return err(409, `session "${name}" already exists with engine "${existingTag}"`)
  }

  // Re-adopt a ccm-* session that survived a bridge restart (re-validates
  // provenance tags + cwd). Built-in engines keep their ids as tags, so live ones
  // started before they ran from their harness files are adopted too.
  const adopted = await HarnessSession.attachExisting(harness, name, ALLOWLIST)
  if (adopted) {
    const outside = gate.folder(adopted.cwd)
    if (outside) {
      audit({ route: 'POST /sessions/open', name, engine, cwd: adopted.cwd, denied: 'limits' })
      return err(403, outside)
    }
    registerLive(adopted)
    audit({ route: 'POST /sessions/open', name, engine, cwd: adopted.cwd, adopted: true })
    return ok({ name: adopted.id, engine, cwd: adopted.cwd, attachHint: adopted.attachHint(), reused: true })
  }
  if (await HarnessSession.exists(name)) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'adopt-provenance-or-cwd' })
    return err(
      403,
      `existing session "${name}" has a cwd outside the allowlist or unrecognized provenance; refusing to adopt`,
    )
  }

  try {
    const session = await HarnessSession.spawn(harness, {
      name, cwd, allowlist: ALLOWLIST, model, effort, skipPrompts: gate.skipPrompts(cwd),
    })
    registerLive(session)
    audit({ route: 'POST /sessions/open', name: session.id, engine, cwd, model, effort, ready: session.ready })
    // Surface readiness: when the TUI did NOT reach its prompt (the classic
    // CPU-starved / blank-pane boot failure), include an actionable warning so the
    // caller doesn't silently drive a dead session believing it opened cleanly.
    return ok({
      name: session.id,
      engine,
      cwd: session.cwd,
      attachHint: session.attachHint(),
      ready: session.ready,
      ...(session.readinessWarning ? { warning: session.readinessWarning } : {}),
    })
  } catch (e) {
    return err(500, `failed to open session: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const WAITING_FOR_APPROVAL = 'waiting_for_approval: the session waits for a person to approve or deny; nothing was typed'
const AGENT_INTERRUPT = 'input gate: an agent may not interrupt a session'

/** The answer when the input gate keeps input out, with its one audit line (`line` carries from and state). */
function inputGateAnswer(
  verdict: Exclude<InputVerdict, 'enter'>,
  action: InputAction,
  name: string,
  session: DrivableSession,
  line: Record<string, unknown> & { from: InputFrom; state: ReadState },
): RpcResult {
  if (verdict === 'held') {
    audit({ ...line, held: true })
    return ok({ status: 'held', name, engine: session.engine, state: line.state, attachHint: session.attachHint() })
  }
  audit({ ...line, denied: 'input-gate' })
  if (line.from !== 'owner' && action === 'interrupt') return { status: 403, body: { error: AGENT_INTERRUPT, state: line.state } }
  return { status: 409, body: { error: WAITING_FOR_APPROVAL, state: line.state } }
}

async function handleSend(name: string, req: RpcRequest, from: InputFrom): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) return err(409, `session "${name}" is not live; call open_session first`)
  const text = String(req.body['text'] ?? '')

  // POLL MODE: empty text means "don't send a new instruction, just fetch new
  // output since the cursor". This folds the former read_session into this one
  // tool so the normal path never needs a separate poll tool. (Per-send
  // model/effort overrides are ignored here — there is no turn to apply them to.)
  if (!text) {
    const cursor = req.body['cursor'] !== undefined ? Number(req.body['cursor']) : 0
    return readSession(name, cursor)
  }

  // Optional per-send model/effort override — Claude-only (binding — Phase 2
  // correction C: no silent option loss for codex/shell/hermes). Validate up
  // front → clean 400, never a generic error from deep inside the adapter.
  let model: string | undefined
  let effort: string | undefined
  if (req.body['model'] !== undefined || req.body['effort'] !== undefined) {
    if (session.engine !== 'claude') {
      return err(400, `model/effort are Claude-only options; not supported for engine "${session.engine}"`)
    }
    try {
      if (req.body['model'] !== undefined) model = validateModel(String(req.body['model']))
      if (req.body['effort'] !== undefined) effort = validateEffort(String(req.body['effort']))
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e))
    }
  }

  // THE INPUT GATE (input-gate.ts), after the 409 and 400 checks above and before anything is
  // typed; a per-send model/effort control is typed input, so it is gated with its text. Not
  // stopped here: text sent a moment before a prompt appears; a prompt the rules miss or read as
  // working; an unrecognized screen of an agent with rules (an update or trust menu reads
  // unknown, so owner text enters it; U-R1A-18B answers those at warmup); the relay's own lead
  // and worker sends, which call TerminalSession, not route() (both run with prompts off; U-R1B-54).
  const { verdict, state } = await admitInput(session, from, 'type')
  const line = { route: 'POST /sessions/:name/send', name, engine: session.engine, cwd: session.cwd, text, model, effort, from, state }
  if (verdict !== 'enter') return inputGateAnswer(verdict, 'type', name, session, line)
  audit(line)

  try {
    // session.send() is already BOUNDED by the engine's soft cap (TANDEM_WAIT_MS):
    // it returns status:'done' (or 'quiet' for a markerless engine) with the
    // report once idle, or status:'running' at the cap so the caller can
    // poll/read again without resending the prompt. Never an infinite loop.
    // Per-turn model/effort overrides (if any) are applied by the adapter itself.
    const result = await session.send(text, { model, effort })
    if (result.status !== 'running') {
      // Turn ended — EMIT a completion event (push), not just return it.
      emitCompletion({ type: 'session', id: name, status: result.status, cursor: result.cursor, summary: summarize(result.report), cwd: session.cwd })
    }
    return ok({
      status: result.status,
      name,
      engine: session.engine,
      report: result.report,
      cursor: result.cursor,
      attachHint: session.attachHint(),
    })
  } catch (e) {
    return err(500, `send failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Shared read used by GET /sessions/:name/read AND send poll-mode. Emits a
 *  completion event when a previously-running turn is observed to have finished
 *  (now idle AND produced fresh output since the cursor). */
async function readSession(name: string, cursor: number): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) {
    // Not live: nothing to stream. idle:true so a poll loop terminates cleanly.
    return ok({ text: '', cursor, idle: true, live: false })
  }
  try {
    const page = await session.read({ cursor })
    if (page.idle && page.text.trim().length > 0) {
      // A quiet turn end must read as quiet, never as done.
      emitCompletion({ type: 'session', id: name, status: page.state === 'quiet' ? 'quiet' : 'done', cursor: page.cursor, summary: summarize(page.text), cwd: session.cwd })
    }
    return ok({ ...page, live: true, engine: session.engine, attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleRead(name: string, req: RpcRequest): Promise<RpcResult> {
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  return readSession(name, cursor)
}

async function handleInterrupt(name: string, from: InputFrom): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) return err(409, `session "${name}" is not live`)
  // Interrupt keys are typed input: they can answer a prompt (a deny key is often Escape).
  const { verdict, state } = await admitInput(session, from, 'interrupt')
  const line = { route: 'POST /sessions/:name/interrupt', name, engine: session.engine, cwd: session.cwd, from, state }
  if (verdict !== 'enter') return inputGateAnswer(verdict, 'interrupt', name, session, line)
  audit(line)
  await session.interrupt()
  return ok({ ok: true, name, engine: session.engine })
}

async function handleClose(name: string): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) {
    // Already gone is success (idempotent).
    return ok({ ok: true, name, alreadyClosed: true })
  }
  audit({ route: 'POST /sessions/:name/close', name, engine: session.engine, cwd: session.cwd })
  await session.close()
  unregisterLive(name)
  return ok({ ok: true, name, engine: session.engine })
}

// ---- relay handlers -------------------------------------------------------

async function handleRelayStart(req: RpcRequest): Promise<RpcResult> {
  const goal = String(req.body['goal'] ?? '')
  if (!goal) return err(400, 'goal is required')
  const cwdInput = req.body['cwd'] !== undefined ? String(req.body['cwd']) : DEFAULT_CWD
  if (!isCwdAllowed(cwdInput, ALLOWLIST)) return err(403, `cwd not allowed: ${cwdInput}`)
  const cwd = safeResolve(cwdInput)
  // The relay runs two Claude Code sessions: claude must be enabled and found, as for an open.
  let relayHarness: Harness | undefined
  try {
    ;({ harness: relayHarness } = await resolveEngine('claude'))
  } catch (e) {
    return engineError(e)
  }
  // The limits file holds for both sessions: their agent, the folder, and permission_skip, since
  // the relay starts them with their prompts off (startRelay keeps its TANDEM_ALLOW_BYPASS guard).
  const gate = limitsGate()
  const denied = gate.agent(relayHarness) ?? gate.folder(cwd) ?? gate.permissionSkip(cwd)
  if (denied) {
    audit({ route: 'POST /relay/start', cwd, denied: 'limits' })
    return err(403, denied)
  }
  const maxTurns = req.body['maxTurns'] !== undefined ? Number(req.body['maxTurns']) : undefined
  const context = req.body['context'] !== undefined ? String(req.body['context']) : undefined

  audit({ route: 'POST /relay/start', cwd, goal })
  try {
    const { loopId, leadName, workerName } = await relay.startRelay({
      goal,
      cwd,
      maxTurns,
      context,
      allowlist: ALLOWLIST,
    })
    return ok({ status: 'running', loopId, leadName, workerName, cursor: 0 })
  } catch (e) {
    if (e instanceof relay.RelayConfigError) return err(400, e.message)
    return err(500, `failed to start relay: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function handleRelayRead(loopId: string, req: RpcRequest): RpcResult {
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  const page = relay.readSince(loopId, cursor)
  if (!page) return err(404, `unknown loopId: ${loopId}`)
  return ok(page)
}
