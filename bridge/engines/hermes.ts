/**
 * engines/hermes.ts — the `hermes` DrivableSession adapter.
 *
 * Hermes is NOT tmux-hosted: it drives an already-running Hermes WebUI agent
 * over a small loopback-only HTTP surface (`POST /api/auth/login`,
 * `POST /api/chat/start`, `GET /api/session`) instead of keystroke injection
 * into a pane. There is no spawn concept — Tandem does not create Hermes
 * agents, it only ATTACHES to an existing, explicitly allowlisted WRITABLE
 * agent id (binding — Phase 2 correction E). Messaging channels, channel
 * discovery, arbitrary session listing, and remembered personal session
 * history are all deliberately absent (spec "Excluded from this MVP" + Phase 2
 * correction D).
 *
 * This ports the PROVEN Hermes WebUI wire contract (cookie-session login,
 * chat/start + session-poll turn shape) rather than inventing a simplified
 * one, while keeping Tandem's stricter scope and bounds:
 *
 * OPENED THROUGH ITS HARNESS FILE: harnesses/hermes.toml names this adapter
 * (`adapter = "hermes"`), bridge/harness-registry.ts maps that name to
 * openHermes() below, and the router opens any adapter agent through that
 * table without naming one. For Hermes, start means attach to the running
 * agent and check that it answers.
 *
 * BOUNDED AND ALLOWLISTED TWICE (binding — Phase 2 correction D):
 *   - the writable-agent id allowlist is enforced in openHermes() AND again in
 *     attach() — either check alone refusing is enough to keep an agent
 *     undrivable;
 *   - every agent id is validated against a strict bounded charset/length
 *     rule BEFORE any network call;
 *   - the base URL is canonicalized and restricted to a loopback host
 *     (exactly 127.0.0.1, [::1] or localhost; a *.localhost name is refused,
 *     it can resolve off the machine), with credentials/query/fragment
 *     rejected outright;
 *   - a redirect is never followed (it could name a host that is not loopback);
 *   - every fetch (login, send, read, and the one 401 retry) is raced against
 *     an AbortSignal timeout — a slow/wedged Hermes gateway can never hang a
 *     turn past the bound;
 *   - every response is capped, enforced WHILE STREAMING when a real
 *     Response body is available (never "read it all, then check
 *     .length") — the identical cap also applies to injected test responses;
 *   - every JSON response is shape-validated before use;
 *   - a prompt over 8,000 characters is REJECTED (never silently truncated),
 *     and an invalid/negative/non-integer/over-limit read cursor is REJECTED
 *     rather than silently clamped;
 *   - cwd/model/effort are Claude-only concepts — send() rejects model/effort.
 *
 * No password, cookie, owner id, or raw response body is ever placed in a
 * thrown error or returned to a caller — only short, generic diagnostic text.
 * The login request never sends an Origin or Referer header.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DrivableSession, EngineId, ReadOptions, ReadResult, SendOptions, SendResult } from '../drivable.ts'
import type { AdapterOpenResult } from '../harness-registry.ts'

const DEFAULT_TIMEOUT_MS = 15_000
/** One open's answer check (login and session read) ends within this, whatever the request timeout. */
const HERMES_OPEN_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 // 256 KiB — a chat reply, not a file transfer
const MAX_PROMPT_LENGTH = 8_000
const MAX_CURSOR = 1_000_000
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const LIVE_DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on'])

export interface HermesConfig {
  /** Canonicalized loopback origin + optional path prefix, no trailing slash. */
  baseUrl: string
  /** Explicitly allowlisted writable agent ids. Empty ⇒ no agent is drivable. */
  writableAgents: Set<string>
  requestTimeoutMs: number
  maxResponseBytes: number
  /** Path to a file holding the Hermes WebUI login password (one line).
   *  Default `~/.hermes/hermes-webui-password.txt`, overridable via
   *  `TANDEM_HERMES_PASSWORD_PATH`. */
  passwordPath: string
  /** When true (`TANDEM_HERMES_DISABLE_LIVE`), blocks use of the real global
   *  `fetch` before any password read or network contact. An injected test
   *  `fetchImpl` is never blocked by this flag. */
  liveDisabled: boolean
}

/** Reads the Hermes WebUI password from `path`. Test-injectable so no test
 *  ever touches real home state or a real password file. */
export type HermesPasswordReader = (path: string) => Promise<string>

/** Strict bounded agent-id validation, run BEFORE any network call. */
export function validateHermesAgentId(id: string): string {
  const v = id.trim()
  if (!AGENT_ID_RE.test(v)) {
    throw new Error(`invalid Hermes agent id (allowed: A-Z a-z 0-9 . _ -, max 128 chars): "${id}"`)
  }
  return v
}

/** Comma- or colon-separated allowlist.
 *  Unset/blank ⇒ empty set ⇒ no Hermes agent is drivable (fail closed). */
export function buildHermesWritableAgents(envValue = process.env.TANDEM_HERMES_WRITABLE_AGENTS): Set<string> {
  const set = new Set<string>()
  if (!envValue?.trim()) return set
  for (const raw of envValue.split(/[,:]/)) {
    const t = raw.trim()
    if (!t) continue
    set.add(validateHermesAgentId(t))
  }
  return set
}

/** Canonicalize + validate a Hermes base URL: http/https only, loopback host
 *  only, no credentials/query/fragment. The host must be EXACTLY 127.0.0.1,
 *  [::1] or localhost after the URL parser's own normal form (127.1 parses to
 *  127.0.0.1, LOCALHOST to localhost): any *.localhost name, "localhost." and
 *  hostname-suffix tricks ("notlocalhost.example") are refused. */
export function canonicalizeHermesBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid Hermes base URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hermes base URL must be http:// or https://')
  }
  if (url.username || url.password) {
    throw new Error('Hermes base URL must not contain credentials')
  }
  if (url.search) {
    throw new Error('Hermes base URL must not contain a query string')
  }
  if (url.hash) {
    throw new Error('Hermes base URL must not contain a fragment')
  }
  const host = url.hostname.toLowerCase()
  // Node's WHATWG URL implementation currently preserves brackets in
  // `hostname` for IPv6 literals (`[::1]`), while other implementations may
  // expose the bare address. Normalize only that syntactic wrapper before the
  // exact loopback comparison.
  const normalizedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const isLoopback = normalizedHost === '127.0.0.1' || normalizedHost === '::1' || normalizedHost === 'localhost'
  if (!isLoopback) {
    throw new Error('Hermes base URL host must be loopback (127.0.0.1, [::1] or localhost)')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

function defaultHermesPasswordPath(): string {
  return join(homedir(), '.hermes', 'hermes-webui-password.txt')
}

/** Default password reader: reads and trims the file at `path`. Errors
 *  (missing file, empty file) surface the path, never the file contents. */
async function defaultPasswordReader(path: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // The router can return adapter errors to a remote caller. Do not leak the
    // host username or home layout through a raw ENOENT message.
    throw new Error('Hermes password file could not be read')
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Hermes password file is empty')
  }
  return trimmed
}

function parseLiveDisableFlag(value: string | undefined): boolean {
  if (!value) return false
  return LIVE_DISABLE_VALUES.has(value.trim().toLowerCase())
}

/** Load Hermes config from env. Returns undefined when unconfigured (no base
 *  URL) — callers must treat that as "Hermes unavailable", not a spawn error. */
export function loadHermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig | undefined {
  const rawBaseUrl = env.TANDEM_HERMES_BASE_URL?.trim()
  if (!rawBaseUrl) return undefined
  const baseUrl = canonicalizeHermesBaseUrl(rawBaseUrl)
  const writableAgents = buildHermesWritableAgents(env.TANDEM_HERMES_WRITABLE_AGENTS)
  const timeoutRaw = Number(env.TANDEM_HERMES_TIMEOUT_MS)
  const requestTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS
  const capRaw = Number(env.TANDEM_HERMES_MAX_RESPONSE_BYTES)
  const maxResponseBytes = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_MAX_RESPONSE_BYTES
  const passwordPath = env.TANDEM_HERMES_PASSWORD_PATH?.trim() || defaultHermesPasswordPath()
  const liveDisabled = parseLiveDisableFlag(env.TANDEM_HERMES_DISABLE_LIVE)
  return { baseUrl, writableAgents, requestTimeoutMs, maxResponseBytes, passwordPath, liveDisabled }
}

/** Reject rather than clamp: an invalid cursor is a caller bug, not something
 *  to silently paper over (binding — Phase 2 correction D). */
function validateReadCursor(cursor: number | undefined): number {
  if (cursor === undefined) return 0
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > MAX_CURSOR) {
    throw new Error(`invalid Hermes read cursor: ${cursor}`)
  }
  return cursor
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** Read a fetch Response body up to `maxBytes`, enforcing the cap WHILE
 *  STREAMING whenever a real streaming body is available (real `fetch()`
 *  Responses, and any injected test double that exposes a ReadableStream
 *  `.body`) — never "await response.text() then check .length". Only a
 *  minimal fallback (a test double with no `.body` at all) reads via
 *  `.text()`, and even then the SAME cap is enforced before the text is ever
 *  returned to a caller. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Hermes response exceeded the ${maxBytes}-byte limit`)
    }
    return text
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`Hermes response exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

/** POST/GET with a hard AbortSignal timeout and a bounded response read.
 *  Rethrows AbortError as-is so callers can distinguish "timed out" from
 *  "server/shape error". Never sets Origin or Referer — callers must not add
 *  them either. */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string; headers: Headers }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // A redirect is never followed: it could name any host, and the base URL's loopback rule
    // would not cover it. The 3xx answer comes back as it is and fails the caller's status check.
    const res = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal })
    const text = await readBounded(res, maxBytes)
    return { status: res.status, text, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

/** Capture only the FIRST name=value pair of the FIRST Set-Cookie header —
 *  never Path/HttpOnly/SameSite/Expires attributes, never a second cookie.
 *  Prefers the safe `getSetCookie()` array (Node/undici, avoids the
 *  comma-joining ambiguity of multiple Set-Cookie headers) and falls back to
 *  `.get('set-cookie')` for any minimal test double that only implements
 *  that. */
function extractSessionCookie(headers: Headers): string | undefined {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const raw =
    typeof withGetSetCookie.getSetCookie === 'function'
      ? withGetSetCookie.getSetCookie()[0]
      : (headers.get('set-cookie') ?? undefined)
  if (!raw) return undefined
  const pair = raw.split(';')[0]?.trim()
  return pair || undefined
}

interface HermesMessage {
  role: string
  content: string
}

interface HermesSessionState {
  messages: HermesMessage[]
  activeStream: boolean
}

function validateMessage(item: unknown): HermesMessage {
  if (typeof item !== 'object' || item === null) {
    throw new Error('Hermes response did not match the expected shape')
  }
  const m = item as Record<string, unknown>
  if (m.role !== undefined && typeof m.role !== 'string') {
    throw new Error('Hermes response did not match the expected shape')
  }
  let content = ''
  if (typeof m.content === 'string') {
    content = m.content
  } else if (Array.isArray(m.content)) {
    const parts: string[] = []
    for (const block of m.content) {
      if (typeof block !== 'object' || block === null) {
        throw new Error('Hermes response did not match the expected shape')
      }
      const text = (block as Record<string, unknown>).text
      if (text !== undefined && typeof text !== 'string') {
        throw new Error('Hermes response did not match the expected shape')
      }
      if (typeof text === 'string' && text) parts.push(text)
    }
    content = parts.join(' ').trim()
  } else {
    throw new Error('Hermes response did not match the expected shape')
  }
  return { role: typeof m.role === 'string' ? m.role : '', content }
}

/** Validates `{ session: { messages: [...], active_stream_id?: string|null } }`. */
function parseSessionResponse(raw: string): HermesSessionState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Hermes returned a non-JSON response')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Hermes response did not match the expected shape')
  }
  const session = (parsed as Record<string, unknown>).session
  if (typeof session !== 'object' || session === null) {
    throw new Error('Hermes response did not match the expected shape')
  }
  const s = session as Record<string, unknown>
  if (!Array.isArray(s.messages)) {
    throw new Error('Hermes response did not match the expected shape')
  }
  if (
    s.active_stream_id !== undefined &&
    s.active_stream_id !== null &&
    typeof s.active_stream_id !== 'string'
  ) {
    throw new Error('Hermes response did not match the expected shape')
  }
  return {
    messages: s.messages.map(validateMessage),
    activeStream: Boolean(s.active_stream_id),
  }
}

/** Renders only newly-observed messages as plain text. The network response
 *  they were parsed from is already bounded by `maxResponseBytes` (enforced
 *  WHILE STREAMING in `readBounded`), so rendered output is bounded too. */
function renderMessages(messages: HermesMessage[]): string {
  return messages
    .map((m) => (m.content ? (m.role ? `[${m.role}] ${m.content}` : m.content) : ''))
    .filter(Boolean)
    .join('\n')
}

export interface HermesSessionOptions {
  agentId: string
  config: HermesConfig
  /** Injectable fetch — tests never make a real network call. */
  fetchImpl?: typeof fetch
  /** Injectable password reader — tests never touch a real password file. */
  passwordReader?: HermesPasswordReader
}

export class HermesSession implements DrivableSession {
  readonly engine: EngineId = 'hermes'
  /** Not applicable — Hermes sessions are not directory-scoped (correction E:
   *  Hermes rejects cwd). Kept as '' only to satisfy the shared contract. */
  readonly cwd = ''
  private readonly agentId: string
  private readonly config: HermesConfig
  private readonly fetchImpl: typeof fetch
  /** True only when the caller explicitly injected a fetchImpl (tests). Used
   *  to gate TANDEM_HERMES_DISABLE_LIVE — that flag must never block an
   *  injected test fetch. */
  private readonly isInjectedFetch: boolean
  private readonly passwordReader: HermesPasswordReader
  private cookie: string | undefined
  private constructor(
    agentId: string,
    config: HermesConfig,
    fetchImpl: typeof fetch,
    isInjectedFetch: boolean,
    passwordReader: HermesPasswordReader,
  ) {
    this.agentId = agentId
    this.config = config
    this.fetchImpl = fetchImpl
    this.isInjectedFetch = isInjectedFetch
    this.passwordReader = passwordReader
  }

  get id(): string {
    return this.agentId
  }

  /** Attach to an existing, explicitly allowlisted writable Hermes agent.
   *  There is no `spawn` — Tandem never creates a Hermes agent. Throws if the
   *  id is malformed or not on the allowlist (checked first by openHermes()). */
  static attach(opts: HermesSessionOptions): HermesSession {
    const agentId = validateHermesAgentId(opts.agentId)
    if (!opts.config.writableAgents.has(agentId)) {
      throw new Error(`Hermes agent "${agentId}" is not on the writable-agent allowlist`)
    }
    return new HermesSession(
      agentId,
      opts.config,
      opts.fetchImpl ?? fetch,
      opts.fetchImpl !== undefined,
      opts.passwordReader ?? defaultPasswordReader,
    )
  }

  attachHint(): string {
    return `Hermes agent "${this.agentId}" (loopback-only HTTP gateway, no tmux pane to attach to)`
  }

  /** POST /api/auth/login with { password }. Never sends Origin or Referer.
   *  Captures only the first name=value pair of Set-Cookie. Never surfaces
   *  the password or cookie value in a thrown error. */
  private async login(): Promise<string> {
    const password = await this.passwordReader(this.config.passwordPath)
    const { status, headers } = await boundedFetch(
      `${this.config.baseUrl}/api/auth/login`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) },
      this.config.requestTimeoutMs,
      this.config.maxResponseBytes,
      this.fetchImpl,
    )
    if (status < 200 || status >= 300) {
      throw new Error(`Hermes login failed with status ${status}`)
    }
    const cookie = extractSessionCookie(headers)
    if (!cookie) {
      throw new Error('Hermes login response did not include a session cookie')
    }
    return cookie
  }

  /** Fetch with the cached session cookie, logging in first if there is none
   *  yet and retrying exactly once (clear cookie, re-login, retry the SAME
   *  request) on a 401. Blocks any use of the real global fetch before
   *  password reading or network contact when TANDEM_HERMES_DISABLE_LIVE is
   *  set and no fetch was injected. */
  private async authedFetch(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
    if (this.config.liveDisabled && !this.isInjectedFetch) {
      throw new Error('Hermes live network access is disabled (TANDEM_HERMES_DISABLE_LIVE)')
    }
    let cookie = this.cookie
    if (!cookie) {
      cookie = await this.login()
      this.cookie = cookie
    }
    const url = `${this.config.baseUrl}${path}`
    const headers = { ...(init.headers as Record<string, string> | undefined), cookie }
    let result = await boundedFetch(url, { ...init, headers }, this.config.requestTimeoutMs, this.config.maxResponseBytes, this.fetchImpl)
    if (result.status === 401) {
      this.cookie = undefined
      cookie = await this.login()
      this.cookie = cookie
      const retryHeaders = { ...(init.headers as Record<string, string> | undefined), cookie }
      result = await boundedFetch(url, { ...init, headers: retryHeaders }, this.config.requestTimeoutMs, this.config.maxResponseBytes, this.fetchImpl)
    }
    return { status: result.status, text: result.text }
  }

  /** GET /api/session?session_id=<id>&messages=1, shape-validated. */
  private async fetchSessionState(): Promise<HermesSessionState> {
    const path = `/api/session?session_id=${encodeURIComponent(this.agentId)}&messages=1`
    const { status, text } = await this.authedFetch(path, { method: 'GET' })
    if (status < 200 || status >= 300) {
      throw new Error(`Hermes session read failed with status ${status}`)
    }
    return parseSessionResponse(text)
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.fetchSessionState()
      return true
    } catch {
      return false
    }
  }

  /** Queries the real, live active_stream_id state on every call — never a
   *  permanently stale local flag. */
  async isWorking(): Promise<boolean> {
    try {
      const { activeStream } = await this.fetchSessionState()
      return activeStream
    } catch {
      return false
    }
  }

  /** model/effort are Claude-only (binding — Phase 2 correction C): reject
   *  rather than silently ignore. An over-length prompt is REJECTED before
   *  any read/login/network call, never silently truncated. First reads the
   *  session to capture the pre-send message-count cursor, then POSTs
   *  /api/chat/start; a successful start returns status:"running" with that
   *  pre-send cursor so the caller's next read() sees exactly the messages
   *  this turn adds. A soft timeout (AbortError) at either step is reported
   *  as the generic bounded status:"running", never left to hang or thrown
   *  as an opaque error. */
  async send(text: string, options?: SendOptions): Promise<SendResult> {
    if (options?.model !== undefined || options?.effort !== undefined) {
      throw new Error('model/effort are Claude-only options; not supported for engine "hermes"')
    }
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Hermes prompt exceeds the ${MAX_PROMPT_LENGTH}-character limit`)
    }
    let preSendCursor: number
    try {
      const { messages } = await this.fetchSessionState()
      preSendCursor = messages.length
    } catch (e) {
      if (isAbortError(e)) {
        throw new Error('Hermes pre-send session read timed out; the prompt was not sent')
      }
      throw e
    }
    try {
      const { status } = await this.authedFetch('/api/chat/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: this.agentId, message: text }),
      })
      if (status < 200 || status >= 300) {
        throw new Error(`Hermes chat/start failed with status ${status}`)
      }
      return { status: 'running', report: '', cursor: preSendCursor }
    } catch (e) {
      if (isAbortError(e)) return { status: 'running', report: '', cursor: preSendCursor }
      throw e
    }
  }

  /** Renders only messages newer than the supplied count cursor and returns
   *  the new message count as the next cursor. Rejects an invalid cursor
   *  rather than clamping/ignoring it. idle reflects the absence of a live
   *  active_stream_id. */
  async read(options?: ReadOptions): Promise<ReadResult> {
    const cursor = validateReadCursor(options?.cursor)
    const { messages, activeStream } = await this.fetchSessionState()
    const text = renderMessages(messages.slice(cursor))
    return { text, cursor: messages.length, idle: !activeStream }
  }

  /** No in-flight terminal turn to interrupt at this level — send() is already
   *  bounded by its own request timeout. No-op, kept for contract symmetry. */
  async interrupt(): Promise<void> {}

  /** No teardown: Tandem did not create this agent and must not destroy it. */
  async close(): Promise<void> {}
}

/**
 * The adapter's open (ADAPTERS in bridge/harness-registry.ts): attach to the running Hermes agent
 * `name` and check that it answers. Tandem starts nothing there. Refusals carry the HTTP status,
 * a short error (no password, cookie or URL) and the audit line's `denied`; nothing is registered
 * by a refusal. The answer check is one login and one session read, each under the request
 * timeout, and is blocked by TANDEM_HERMES_DISABLE_LIVE. The whole check ends within HERMES_OPEN_MS
 * (30 s): past it the open answers 503 `open-timeout` and a late result is dropped (nothing is
 * registered), so the router's per-name chain of opens always drains (k queued opens: k x 30 s).
 */
export async function openHermes(name: string): Promise<AdapterOpenResult> {
  let config: HermesConfig | undefined
  try {
    config = loadHermesConfig(process.env)
  } catch (e) {
    return { status: 503, error: e instanceof Error ? e.message : String(e), denied: 'bad-config' }
  }
  if (!config) return { status: 503, error: 'Hermes is not configured (set TANDEM_HERMES_BASE_URL)', denied: 'not-configured' }
  if (!config.writableAgents.has(name)) {
    return { status: 403, error: `Hermes agent "${name}" is not on the writable-agent allowlist`, denied: 'not-writable-allowlisted' }
  }
  const session = HermesSession.attach({ agentId: name, config })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), HERMES_OPEN_MS)
  })
  const alive = await Promise.race([session.isAlive(), late]).finally(() => clearTimeout(timer))
  if (alive === 'late') return { status: 503, error: `Hermes agent "${session.id}" did not answer within 30 s`, denied: 'open-timeout' }
  if (!alive) return { status: 503, error: `Hermes agent "${session.id}" did not answer`, denied: 'no-answer' }
  return { session }
}
