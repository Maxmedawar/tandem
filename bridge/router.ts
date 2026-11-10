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
 * TerminalSession lifecycle via keystroke injection + pane scraping), or an
 * attached Hermes writable-agent id (a loopback HTTP gateway, not tmux). We
 * NEVER run `claude -p` / headless and NEVER set ANTHROPIC_API_KEY, so Claude
 * usage stays on the user's interactive subscription. The autonomous capability
 * is the zero-API two-session relay, which stays Claude-only and unaffected by
 * engine selection.
 *
 * ENGINE RESOLUTION ORDER (binding — Phase 2 correction E): every open_session
 * call resolves and validates the engine (unknown id → 400, disabled → 403,
 * enabled-but-unavailable executable → 503) via engine-registry.ts BEFORE any
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
 *   - Only ccm-* tmux sessions (claude/codex/shell) or an allowlisted Hermes
 *     agent id are drivable.
 *   - tmux send-keys is injection-safe (-l literal + -- end-of-options).
 *   - Audit log: every spawn / send / interrupt / close / relay control appends
 *     metadata only to a private ~/.tandem/bridge.log. Prompt, command, task,
 *     goal, context, report, output, and request-body values are replaced with
 *     byte counts. A failed audit write surfaces to stderr.
 *
 * Config (env): TANDEM_CWD_ALLOWLIST / TANDEM_DEFAULT_CWD are mapped to the
 * engine's CCM_* names by the entrypoint before this module loads.
 * TANDEM_ENABLED_ENGINES opts non-default engines in (see engine-registry.ts).
 */

import { homedir } from 'node:os'
import { validateModel, validateEffort, TerminalSession } from './terminal-session.ts'
import type { EngineId } from './drivable.ts'
import {
  resolveEngine,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
} from './engine-registry.ts'
import { ClaudeSession } from './engines/claude.ts'
import { CodexSession } from './engines/codex.ts'
import { ShellSession } from './engines/shell.ts'
import { HermesSession, loadHermesConfig } from './engines/hermes.ts'
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

  // GET /sessions
  if (m === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
    const limit = req.query.get('limit') ? Number(req.query.get('limit')) : undefined
    const project = req.query.get('project') ?? undefined
    return ok(await listSessions({ limit, project }))
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
    if (m === 'POST' && action === 'send') return handleSend(name, req)
    if (m === 'GET' && action === 'read') return handleRead(name, req)
    if (m === 'POST' && action === 'interrupt') return handleInterrupt(name)
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
    if (m === 'GET' && action === 'read') return handleRelayRead(loopId, req)
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
  // effect (binding — Phase 2 correction E). Defaults to "claude" (the only
  // engine enabled by default); codex/shell/hermes require explicit opt-in via
  // TANDEM_ENABLED_ENGINES.
  const rawEngine = req.body['engine'] !== undefined ? String(req.body['engine']) : undefined
  let engine: EngineId
  try {
    ;({ id: engine } = await resolveEngine(rawEngine))
  } catch (e) {
    if (e instanceof UnknownEngineError) return err(400, e.message)
    if (e instanceof EngineDisabledError) return err(403, e.message)
    if (e instanceof EngineUnavailableError) return err(503, e.message)
    return err(500, e instanceof Error ? e.message : String(e))
  }

  // An engine mismatch on name reuse is rejected before any further work,
  // regardless of which engine's open path would otherwise run.
  const liveExisting = getLive(name)
  if (liveExisting && liveExisting.engine !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: liveExisting.engine })
    return err(409, `session "${name}" already exists with engine "${liveExisting.engine}"`)
  }

  if (engine === 'hermes') {
    return handleOpenHermes(name, req)
  }
  return handleOpenTmux(engine, name, req)
}

/** open_session for the `hermes` engine: attach to an existing, explicitly
 *  allowlisted writable agent id. No spawn, no cwd, no model/effort — Hermes
 *  rejects all three (binding — Phase 2 correction E). */
async function handleOpenHermes(name: string, req: RpcRequest): Promise<RpcResult> {
  if (req.body['cwd'] !== undefined) return err(400, 'cwd is not supported for engine "hermes"')
  if (req.body['model'] !== undefined) return err(400, 'model is not supported for engine "hermes"')
  if (req.body['effort'] !== undefined) return err(400, 'effort is not supported for engine "hermes"')

  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', reused: true })
    return ok({ name: existing.id, engine: 'hermes', attachHint: existing.attachHint(), reused: true })
  }

  // A tmux-hosted session may have survived a bridge restart without yet being
  // re-adopted into the in-memory registry. Never let a Hermes attachment claim
  // that live session's name and hide/misroute it. Any ccm-<name> collision is a
  // conflict, including an untagged one.
  if (await TerminalSession.exists(name)) {
    const existingEngine = await TerminalSession.engineTagOf(name)
    audit({
      route: 'POST /sessions/open',
      name,
      engine: 'hermes',
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

  const config = loadHermesConfig()
  if (!config) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', denied: 'not-configured' })
    return err(503, 'Hermes is not configured (set TANDEM_HERMES_BASE_URL)')
  }
  // Allowlist enforced HERE (registry/router) AND again inside HermesSession.attach
  // (binding — Phase 2 correction D: "enforce the writable-agent id allowlist in
  // both the registry/router and the Hermes adapter").
  if (!config.writableAgents.has(name)) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', denied: 'not-writable-allowlisted' })
    return err(403, `Hermes agent "${name}" is not on the writable-agent allowlist`)
  }
  try {
    const session = HermesSession.attach({ agentId: name, config })
    registerLive(session)
    audit({ route: 'POST /sessions/open', name: session.id, engine: 'hermes' })
    return ok({ name: session.id, engine: 'hermes', attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `failed to attach Hermes agent: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** open_session for claude/codex/shell: the shared tmux lifecycle, generalized
 *  from Phase 1's Claude-only path. model/effort remain Claude-only. */
async function handleOpenTmux(engine: 'claude' | 'codex' | 'shell', name: string, req: RpcRequest): Promise<RpcResult> {
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

  // A same-named ccm-* tmux session tagged with a DIFFERENT engine is a 409
  // conflict, distinct from a provenance/cwd adoption failure (403) — checked
  // before attempting adoption so the caller gets the precise reason.
  const existingTag = await TerminalSession.engineTagOf(name)
  if (existingTag !== undefined && existingTag !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: existingTag })
    return err(409, `session "${name}" already exists with engine "${existingTag}"`)
  }

  // Re-adopt a ccm-* session that survived a bridge restart (re-validates
  // provenance tags + cwd).
  const adopted =
    engine === 'claude'
      ? await ClaudeSession.attachExisting(name, ALLOWLIST)
      : engine === 'codex'
        ? await CodexSession.attachExisting(name, ALLOWLIST)
        : await ShellSession.attachExisting(name, ALLOWLIST)
  if (adopted) {
    registerLive(adopted)
    audit({ route: 'POST /sessions/open', name, engine, cwd: adopted.cwd, adopted: true })
    return ok({ name: adopted.id, engine, cwd: adopted.cwd, attachHint: adopted.attachHint(), reused: true })
  }
  const stillExists =
    engine === 'claude'
      ? await ClaudeSession.exists(name)
      : engine === 'codex'
        ? await CodexSession.exists(name)
        : await ShellSession.exists(name)
  if (stillExists) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'adopt-provenance-or-cwd' })
    return err(
      403,
      `existing session "${name}" has a cwd outside the allowlist or unrecognized provenance; refusing to adopt`,
    )
  }

  try {
    const session =
      engine === 'claude'
        ? await ClaudeSession.spawn({ name, cwd, allowlist: ALLOWLIST, model, effort })
        : engine === 'codex'
          ? await CodexSession.spawn({ name, cwd, allowlist: ALLOWLIST })
          : await ShellSession.spawn({ name, cwd, allowlist: ALLOWLIST })
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

async function handleSend(name: string, req: RpcRequest): Promise<RpcResult> {
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

  audit({ route: 'POST /sessions/:name/send', name, engine: session.engine, cwd: session.cwd, text, model, effort })

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

async function handleInterrupt(name: string): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) return err(409, `session "${name}" is not live`)
  audit({ route: 'POST /sessions/:name/interrupt', name, engine: session.engine, cwd: session.cwd })
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
