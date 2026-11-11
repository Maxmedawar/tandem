/**
 * terminal-session.ts — drive a REAL interactive engine TUI (or shell) inside
 * tmux, parameterized by an EngineDescriptor (./drivable.ts). Phase 1 only used
 * this for `claude`; Phase 2 generalizes it so `codex` and `shell` reuse the
 * SAME tmux lifecycle — spawn, warmup/readiness, injection, idle detection,
 * interrupt, close — with zero per-engine duplication of that lifecycle.
 *
 * BILLING (see spec §1b): for `claude` we manipulate the owner's real
 * interactive TUI via terminal keystrokes — NOT `claude -p` / headless — so
 * usage stays on their subscription windows. The bridge SPAWNS a fresh
 * interactive process inside a tmux session ("tmux new-session -d -s ccm-<name>
 * <engine>") and drives it by injecting keys + scraping the pane. The owner can
 * "tmux attach -t ccm-<name>" to watch or type alongside.
 *
 * IDLE DETECTION — marker-based (claude) vs markerless (codex/shell):
 *   Claude has a proven footer marker: "esc to interrupt" PRESENT means working;
 *   ABSENT plus N stable polls means idle (see EngineDescriptor.isWorking).
 *   Codex/shell have no invented marker (binding — Phase 2 correction B: a
 *   guessed marker risks FALSE completion the moment the real UI text changes).
 *   Their idle/ready state is decided ENTIRELY by pane-stability: the pane must
 *   be byte-stable for >= descriptor.minStableMs before a turn/warmup counts as
 *   done/ready (see stepStability below). Both paths share one state machine so
 *   "changing output is working" holds uniformly, marker or not.
 *
 * INJECTION SAFETY: text is injected with
 *   tmux send-keys -t <tgt> -l -- <text>     (literal; -- ends option parsing)
 * then a SEPARATE
 *   tmux send-keys -t <tgt> Enter
 * The user's text is passed as an execFile argv element, never interpolated into
 * a shell string, so it can never be reinterpreted as tmux key names or shell
 * metacharacters. NOTE: for the `shell` engine, the whole POINT of send() is
 * that the injected text is executed AS a shell command by the pane's real
 * shell once it hits Enter — that is the feature (arbitrary OS-user command
 * execution beginning in the allowlisted cwd), not a vulnerability of this
 * file. The cwd admission check is not an OS sandbox.
 *
 * PROVENANCE (binding — Phase 2 correction A, see ./ownership.ts): every
 * spawned session is tagged with tmux user options `@tandem_engine` (which
 * descriptor spawned it) and `@tandem_owner` (this installation's durable
 * random owner id). attachExisting() refuses to adopt a same-named session
 * unless BOTH tags match exactly — an `@tandem_engine` tag alone is not proof
 * Tandem created the session.
 *
 * TRANSCRIPT + CURSOR: on spawn we attach
 *   tmux pipe-pane -o -t <tgt> 'cat >> <transcriptsDir>/<name>.log'
 * The append-only log's byte length is the cursor. readSince(offset) reads from a
 * byte offset and strips ANSI for a human-readable slice.
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { cpus, homedir, loadavg } from 'node:os'
import { join, sep } from 'node:path'
import { CLAUDE_DESCRIPTOR, type EngineDescriptor } from './drivable.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'

const HOME = homedir()
const TRANSCRIPTS_DIR = join(HOME, '.tandem', 'transcripts')

/** tmux session-name prefix. Only ccm-* sessions are drivable by the bridge,
 *  regardless of engine — the engine identity lives in the @tandem_engine tag. */
const SESSION_PREFIX = 'ccm-'

/** Session names must be tmux/file safe. */
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/

/** The footer string Claude Code shows ONLY while a turn is running (used only
 *  by report-cleaning below; the authoritative check is CLAUDE_DESCRIPTOR). */
const CLAUDE_WORKING_MARKER = 'esc to interrupt'

/** Trust-folder prompt shown on first run in an un-trusted directory (claude only). */
const TRUST_PROMPT_MARKER = 'trust this folder'

const POLL_MS = 750
// Soft cap for a single send() wait, configurable via env TANDEM_WAIT_MS (ms).
// At the cap, send() returns status:'running' so the caller can poll/read again
// without resending the prompt. The proven idle/done detection below is
// unchanged; only this bound is tunable.
const SEND_SOFT_CAP_MS =
  Number(process.env.TANDEM_WAIT_MS) > 0 ? Number(process.env.TANDEM_WAIT_MS) : 25_000
const SEND_HARD_CAP_MS = 180_000 // a send() can never hang past this
const SPAWN_WARMUP_MS = 20_000 // max wait for the TUI to become ready on spawn
const PANE_WIDTH = 200
const PANE_HEIGHT = 50

/** Marker on the first-run "Bypass Permissions mode" acceptance dialog (distinct
 *  from the normal "bypass permissions on (shift+tab…)" running footer). Claude only. */
const BYPASS_ACCEPT_MARKER = 'yes, i accept'

/**
 * Claude permission bypass (`--dangerously-skip-permissions`) is OFF by default —
 * an unattended session must not silently gain the power to run any tool without
 * a human present to approve it. Enable it only with TANDEM_ALLOW_BYPASS=1.
 *
 * SECURITY: even when enabled, this ONLY suppresses Claude Code's in-session
 * tool-permission prompts. It does not change the admitted starting cwd: the
 * cwd allowlist is enforced BEFORE spawn (in spawn() below AND again in
 * router.handleOpen), and the pane is created with `-c <validated real cwd>`.
 * The allowlist is an admission gate, not an OS sandbox, so the spawned process
 * still has the reach of its OS user. Bypass is Claude-only; every other engine
 * rejects an explicit bypass request rather than silently ignoring it.
 */
export function bypassPermissionsEnabled(): boolean {
  return (process.env.TANDEM_ALLOW_BYPASS ?? '').trim() === '1'
}

/**
 * The legacy TANDEM_SKIP_PERMISSIONS variable used to enable bypass BY DEFAULT
 * (opt-out). It no longer has any effect — only TANDEM_ALLOW_BYPASS=1 enables
 * bypass. If a host still sets it, warn to stderr rather than silently ignoring
 * it, so the change in behavior is visible instead of surprising.
 */
export function warnLegacySkipPermissionsIfSet(): void {
  if (process.env.TANDEM_SKIP_PERMISSIONS === undefined) return
  process.stderr.write(
    '[bridge] TANDEM_SKIP_PERMISSIONS is ignored and does not enable bypass. ' +
      'Set TANDEM_ALLOW_BYPASS=1 to run Claude with --dangerously-skip-permissions.\n',
  )
}

/** Accepted `--effort` levels (mirrors `claude --effort`). Claude only. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Accepted model ALIASES; a full model id (claude-*) is also accepted as-is. Claude only. */
export const MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku'] as const

/** Validate/normalize a model value; throws a CLEAR error if unsupported (never
 *  silently ignored). Accepts an alias or a full `claude-*` id (incl. `[1m]`). */
export function validateModel(model: string): string {
  const m = model.trim()
  if (!m) throw new Error('model must be a non-empty string')
  if ((MODEL_ALIASES as readonly string[]).includes(m.toLowerCase())) return m.toLowerCase()
  if (/^claude-[a-z0-9._[\]-]+$/i.test(m)) return m
  throw new Error(
    `unsupported model: "${model}". Use an alias (${MODEL_ALIASES.join(', ')}) or a full claude-* model id.`,
  )
}

/** Validate/normalize an effort value; throws a CLEAR error if unsupported. */
export function validateEffort(effort: string): EffortLevel {
  const e = effort.trim().toLowerCase()
  if ((EFFORT_LEVELS as readonly string[]).includes(e)) return e as EffortLevel
  throw new Error(`unsupported effort: "${effort}". Use one of: ${EFFORT_LEVELS.join(', ')}.`)
}

export interface SpawnOptions {
  name: string
  cwd: string
  /** Allowlist roots; cwd is validated against this before spawning. */
  allowlist: string[]
  /** Optional model alias/id → session-scoped `claude --model`. Claude only; any
   *  other engine's spawn() REJECTS this rather than silently ignoring it. */
  model?: string
  /** Optional effort level → session-scoped `claude --effort`. Claude only; see `model`. */
  effort?: string
  /** Override the bypass-permissions default for this spawn (else env/default).
   *  Claude only; see `model`. */
  allowBypass?: boolean
  /** Which engine's tmux lifecycle to run. Defaults to CLAUDE_DESCRIPTOR so
   *  relay.ts (which never sets this) is completely unaffected by Phase 2. */
  descriptor?: EngineDescriptor
  /** Injectable owner-id provider — tests supply one bound to a temp state dir
   *  so the real `~/.tandem/owner-id` is never touched. */
  ownerIdProvider?: OwnerIdProvider
}

export interface SendResult {
  report: string
  cursor: number
  /** 'done' = the engine's working marker cleared and the pane held still;
   *  'quiet' = a markerless engine's pane held still with no completion signal. */
  status: 'done' | 'running' | 'quiet'
}

export interface ReadResult {
  text: string
  cursor: number
  idle: boolean
  state: 'working' | 'done' | 'quiet'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Exact tmux targets. A bare `-t ccm-x` falls back to a prefix match (or a
 *  window name), so with ccm-x gone it would drive ccm-x-long. `=` forces an
 *  exact session name; pane/window commands also need the trailing `:` so
 *  tmux reads the name as a session. */
function sessionTarget(name: string): string {
  return `=${SESSION_PREFIX}${name}`
}

function paneTarget(name: string): string {
  return `${sessionTarget(name)}:`
}

/** Run tmux with an argv array (never a shell string). Resolves stdout. */
function tmux(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

/** Read a spawned session's `@tandem_engine` / `@tandem_owner` tmux user options
 *  in one round trip. Empty strings mean "tag absent" (tmux prints nothing for
 *  an unset user option in `display-message`, never throws). */
async function readProvenanceTags(name: string): Promise<{ engine: string; owner: string }> {
  try {
    const raw = await tmux(['display-message', '-p', '-t', paneTarget(name), '#{@tandem_engine}\t#{@tandem_owner}'])
    const [engine = '', owner = ''] = raw.replace(/\n$/, '').split('\t')
    return { engine, owner }
  } catch {
    return { engine: '', owner: '' }
  }
}

/** Public: the `@tandem_engine` / `@tandem_owner` provenance tags of an
 *  existing ccm-<name> tmux session (bare name, no prefix). Used by
 *  sessions.ts's list_sessions to decide whether a live ccm-* tmux session was
 *  actually created by THIS installation (binding — Phase 2 correction E:
 *  "missing/mismatched tmux provenance must never appear as drivable") — never
 *  by reading the `@tandem_engine` tag alone. */
export async function readSessionProvenance(name: string): Promise<{ engine: string; owner: string }> {
  return readProvenanceTags(name)
}

/**
 * Strip ANSI escape sequences (CSI, OSC, single-char ESC) from a UTF-8 string.
 * The transcript MUST be decoded as UTF-8 first so box-drawing / status glyphs
 * survive; stripping happens on the decoded string.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC: ESC ] ... (BEL | ESC \)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ ... final-byte
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // other two-char ESC sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r/g, '')
  )
}

/** A cwd-allowlist check mirroring sessions.ts (kept local so this module has no
 *  hard dependency cycle). The authoritative helpers live in sessions.ts; spawn
 *  callers should pass the same allowlist they built there. */
function isUnder(real: string, root: string): boolean {
  if (real === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return real.startsWith(prefix)
}

/** True if `cwd` resolves under any allowlist root (trailing-sep prefix guard). */
function isCwdAllowedLocal(cwd: string, allowlist: string[]): boolean {
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    return false
  }
  return allowlist.some((root) => {
    try {
      return isUnder(real, realpathSync(root))
    } catch {
      return false
    }
  })
}

/** Pure adoption policy extracted from attachExisting so provenance refusal is
 *  regression-testable without launching or driving tmux. */
export function canAdoptTerminalSession(
  provenance: { engine: string; owner: string },
  expectedEngine: EngineDescriptor['id'],
  expectedOwner: string,
  cwd: string,
  allowlist: string[],
): boolean {
  return (
    provenance.engine === expectedEngine &&
    provenance.owner.length > 0 &&
    provenance.owner === expectedOwner &&
    isCwdAllowedLocal(cwd, allowlist)
  )
}

/** Shared "why isn't this pane ready" formatter used by both describeReadiness
 *  (marker-based) and describeMarkerlessReadiness (stability-based) — the two
 *  differ only in HOW they decide "not ready", not in how they explain it. */
function formatUnreadyMessage(pane: string, load1: number, cpuCount: number, name: string): string {
  const where = pane.trim().length === 0 ? 'the pane is still blank' : 'the prompt never appeared'
  const overloaded = cpuCount > 0 && load1 > cpuCount * 1.5
  if (overloaded) {
    return (
      `session "${name}" did not reach the prompt: ${where} and the machine is overloaded ` +
      `(load ${load1.toFixed(1)} on ${cpuCount} CPUs). The interactive TUI is CPU-starved and ` +
      `can't finish its first render. Wait for the load to drop (e.g. macOS Spotlight/photo ` +
      `indexing to finish) and/or close stale sessions, then retry.`
    )
  }
  return (
    `session "${name}" did not reach the prompt: ${where} after warmup. The TUI may not have ` +
    `initialized — attach a real terminal once to kick it: tmux attach -t ${SESSION_PREFIX}${name}`
  )
}

/**
 * Diagnose why a freshly-spawned MARKER-BASED pane (claude) is not usable yet —
 * turns the #1 silent failure ("session won't boot / no banner / commands don't
 * go through") into a clear, actionable message.
 *
 * Returns null when the pane shows the prompt (ready), otherwise a human-readable
 * reason. The classic failure observed in the field: a BLANK pane under HIGH
 * system load — the interactive TUI is CPU-starved (e.g. macOS Spotlight /
 * mediaanalysisd indexing, or too many live sessions) and never finishes its
 * first render, so warmup never sees the prompt and any later send() injects into
 * a dead TUI. `claude -p` still works in that state because it's a short burst,
 * which is exactly why "the bridge looks broken but claude is fine" is confusing.
 *
 * Pure (load/cpu are injected) so it is unit-testable without a real machine.
 */
export function describeReadiness(
  pane: string,
  load1: number,
  cpuCount: number,
  name: string,
): string | null {
  if (pane.includes('❯')) return null
  return formatUnreadyMessage(pane, load1, cpuCount, name)
}

/**
 * The markerless-engine (codex/shell) equivalent of describeReadiness: called
 * only once the caller has ALREADY determined (via pane-stability, not a
 * guessed marker) that warmup timed out without reaching a stable prompt.
 * Pure, same reasoning as describeReadiness minus the claude-specific "❯" check.
 */
export function describeMarkerlessReadiness(
  pane: string,
  load1: number,
  cpuCount: number,
  name: string,
): string {
  return formatUnreadyMessage(pane, load1, cpuCount, name)
}

/** Stability-tracking state threaded through stepStability() across polls. */
export interface StabilityState {
  stablePolls: number
  lastPane: string
}

export const INITIAL_STABILITY_STATE: StabilityState = { stablePolls: 0, lastPane: '' }

/** How many consecutive POLL_MS-spaced observations the pane must be unchanged
 *  before a descriptor's minStableMs policy is satisfied. The first observation
 *  occurs at elapsed time zero, so a positive duration needs one more observation
 *  than the number of intervals. */
export function requiredStablePolls(descriptor: EngineDescriptor, pollMs = POLL_MS): number {
  if (descriptor.minStableMs <= 0) return 1
  return Math.ceil(descriptor.minStableMs / pollMs) + 1
}

/**
 * Pure state-machine step shared by send()'s completion loop AND markerless
 * warmup: given the newly captured pane text and the previous state, decides
 * whether the engine is "working" (marker-based; always false when the
 * descriptor has no isWorking) and whether it is now idle (not working AND
 * stable for >= `required` consecutive polls). Exported so captured/synthetic
 * pane sequences are unit-testable without tmux (binding — Phase 2 correction
 * B: no live Codex/shell process required in automated tests). "Changing
 * output is working" holds even without a marker: any pane change resets
 * stablePolls to 1 (or 0 while a marker reports working).
 */
export function stepStability(
  pane: string,
  prev: StabilityState,
  descriptor: EngineDescriptor,
  required: number,
): { working: boolean; idle: boolean; state: StabilityState } {
  const working = descriptor.isWorking ? descriptor.isWorking(pane) : false
  const trimmed = pane.trimEnd()
  const stablePolls = !working && trimmed === prev.lastPane ? prev.stablePolls + 1 : working ? 0 : 1
  const idle = !working && stablePolls >= required
  return { working, idle, state: { stablePolls, lastPane: trimmed } }
}

export class TerminalSession {
  private readonly _name: string
  private readonly _cwd: string
  private readonly logPath: string
  private readonly descriptor: EngineDescriptor
  /** Set by warmup(): did the TUI reach its prompt? */
  private _ready = false
  /** Set by warmup() when NOT ready: an actionable reason (load/blank/attach). */
  private _readinessWarning: string | undefined

  // Explicit field assignment (NOT TS "parameter properties") — the bridge runs
  // under `node --experimental-strip-types`, whose strip-only mode rejects the
  // `private x: T` constructor-parameter shorthand.
  private constructor(name: string, cwd: string, logPath: string, descriptor: EngineDescriptor) {
    this._name = name
    this._cwd = cwd
    this.logPath = logPath
    this.descriptor = descriptor
  }

  get name(): string {
    return this._name
  }

  get cwd(): string {
    return this._cwd
  }

  get engine(): EngineDescriptor['id'] {
    return this.descriptor.id
  }

  /** True once the TUI has shown its prompt (warmup saw its ready condition). */
  get ready(): boolean {
    return this._ready
  }

  /** When not ready, a human-actionable reason warmup recorded (else undefined). */
  get readinessWarning(): string | undefined {
    return this._readinessWarning
  }

  get tmuxTarget(): string {
    return paneTarget(this._name)
  }

  /** Quoted so zsh does not expand the leading `=` when pasted. */
  attachHint(): string {
    return `tmux attach -t '${sessionTarget(this._name)}'`
  }

  /**
   * Spawn a fresh interactive engine (or, for a descriptor with no executable,
   * the pane's default login shell) inside a new tmux session. The cwd is
   * validated against the allowlist (the caller should pass an already-realpath'd
   * cwd and the matching allowlist from sessions.ts). Attaches a pipe-pane
   * transcript, tags the session with provenance (@tandem_engine/@tandem_owner),
   * and waits for the engine to become ready.
  */
  static async spawn(opts: SpawnOptions): Promise<TerminalSession> {
    const { name, allowlist } = opts
    const requestedCwd = opts.cwd
    const descriptor = opts.descriptor ?? CLAUDE_DESCRIPTOR
    if (!SESSION_NAME_RE.test(name)) {
      throw new Error(`invalid session name: ${name}`)
    }
    // No silent option loss (binding — Phase 2 correction C): a non-Claude
    // engine REJECTS model/effort/bypass rather than quietly ignoring them.
    if (descriptor.id !== 'claude') {
      if (opts.model !== undefined || opts.effort !== undefined) {
        throw new Error(`model/effort are Claude-only options; not supported for engine "${descriptor.id}"`)
      }
      if (opts.allowBypass !== undefined) {
        throw new Error(`bypass is a Claude-only option; not supported for engine "${descriptor.id}"`)
      }
    }
    if (!existsSync(requestedCwd) || !statSync(requestedCwd).isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${requestedCwd}`)
    }
    const cwd = realpathSync(requestedCwd)
    if (!isCwdAllowedLocal(cwd, allowlist)) {
      throw new Error(`cwd not allowed: ${requestedCwd}`)
    }

    const target = SESSION_PREFIX + name
    // Refuse to clobber an existing session of the same name.
    if (await TerminalSession.tmuxSessionExists(name)) {
      throw new Error(`tmux session already exists: ${target}`)
    }

    // Resolve the durable owner id BEFORE creating any tmux state, so a failure
    // here (e.g. unwritable state dir) never leaves an orphaned/untagged session.
    const ownerIdProvider = opts.ownerIdProvider ?? makeOwnerIdProvider()
    const ownerId = await ownerIdProvider()

    await mkdir(TRANSCRIPTS_DIR, { recursive: true })
    const logPath = join(TRANSCRIPTS_DIR, `${name}.log`)
    // Truncate any stale transcript so the byte cursor starts clean.
    await (await open(logPath, 'w')).close()

    // Build the engine argv. The real cwd was already allowlist-checked above
    // (and again in router.handleOpen). These flags do not change the admitted
    // start directory. The cwd gate is not an OS sandbox: the process retains
    // the filesystem reach of its OS user. Validation (model/effort) runs here,
    // pre-spawn, so a bad value fails clearly instead of launching a
    // misconfigured session.
    const engineArgv: string[] = []
    if (descriptor.argv) {
      // A harness engine: its argv verbatim, never one command string (decision D7).
      engineArgv.push(...descriptor.argv)
    } else if (descriptor.executable) {
      engineArgv.push(descriptor.executable)
      if (descriptor.id === 'claude') {
        warnLegacySkipPermissionsIfSet()
        const skip = opts.allowBypass ?? bypassPermissionsEnabled()
        if (skip) engineArgv.push('--dangerously-skip-permissions')
        if (opts.model !== undefined) engineArgv.push('--model', validateModel(opts.model))
        if (opts.effort !== undefined) engineArgv.push('--effort', validateEffort(opts.effort))
      }
    } else {
      // Shell engine: the pane's default login shell — SHELL env if set, else a
      // portable fallback. Never a shell STRING; this is one argv element handed
      // straight to tmux/execFile, so it can't be reinterpreted.
      const shellBin = (process.env.SHELL ?? '').trim() || '/bin/sh'
      engineArgv.push(shellBin, '-l')
    }

    // Inject text injection-safe — but here the args are all bridge-controlled
    // (constants + validated flags), so this is a normal new-session. The engine
    // binary (or login shell) runs INSIDE the pane; the cwd is set via -c.
    await tmux([
      'new-session',
      '-d',
      '-s',
      target,
      '-x',
      String(PANE_WIDTH),
      '-y',
      String(PANE_HEIGHT),
      '-c',
      cwd,
      ...engineArgv,
    ])

    // Provenance tags (binding — Phase 2 correction A): required before a later
    // restart may ever consider this session adoptable. Set right after create,
    // before the transcript pipe, so a crash in between leaves, at worst, a
    // correctly-tagged session with a short transcript gap — never a mistagged
    // one that could be adopted without real provenance.
    await tmux(['set-option', '-t', paneTarget(name), '@tandem_engine', descriptor.id])
    await tmux(['set-option', '-t', paneTarget(name), '@tandem_owner', ownerId])

    // Attach the append-only transcript pipe. Single-quote the redirect target;
    // the path is bridge-controlled (transcripts dir + validated name).
    const safeLog = logPath.replace(/'/g, `'\\''`)
    await tmux(['pipe-pane', '-o', '-t', paneTarget(name), `cat >> '${safeLog}'`])

    const session = new TerminalSession(name, cwd, logPath, descriptor)
    await session.warmup()
    return session
  }

  /**
   * Re-attach to an existing ccm-* session the bridge previously created.
   *
   * SECURITY (provenance + allowlist re-validation at the trust boundary):
   * adoption is the only path into the registry that does not run spawn's
   * allowlist gate, and (binding — Phase 2 correction A) an `@tandem_engine` tag
   * alone is not proof Tandem created the session — anyone on the same OS user
   * account could hand-create a matching tmux session. We therefore require, IN
   * ORDER and WITHOUT sending any keys if any check fails:
   *   1. the session's `@tandem_engine` tag exactly matches the requested engine;
   *   2. its `@tandem_owner` tag exactly matches this installation's durable
   *      owner id (see ./ownership.ts);
   *   3. the session's REAL cwd (read from tmux `pane_current_path`) is still
   *      inside the SAME allowlist spawn uses.
   * Any missing/mismatched provenance, or a disallowed cwd, refuses adoption
   * (returns undefined) — mirroring spawn's fail-closed behavior.
   */
  static async attachExisting(
    name: string,
    allowlist: string[],
    descriptor: EngineDescriptor = CLAUDE_DESCRIPTOR,
    ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
  ): Promise<TerminalSession | undefined> {
    if (!SESSION_NAME_RE.test(name)) return undefined
    if (!(await TerminalSession.tmuxSessionExists(name))) return undefined

    const provenance = await readProvenanceTags(name)
    const expectedOwner = await ownerIdProvider()

    const logPath = join(TRANSCRIPTS_DIR, `${name}.log`)
    // Read the cwd tmux recorded for the session (the session's actual pane cwd).
    let cwd = HOME
    try {
      cwd = (await tmux(['display-message', '-p', '-t', paneTarget(name), '#{pane_current_path}'])).trim() || HOME
    } catch {
      /* keep default */
    }
    // Re-validate the ADOPTED cwd against the allowlist — do not drive a session
    // whose real cwd is outside the boundary.
    if (!canAdoptTerminalSession(provenance, descriptor.id, expectedOwner, cwd, allowlist)) {
      return undefined
    }
    return new TerminalSession(name, cwd, logPath, descriptor)
  }

  /** Public: does a ccm-<name> tmux session exist? (name is the bare name.) */
  static async exists(name: string): Promise<boolean> {
    return TerminalSession.tmuxSessionExists(name)
  }

  /** Public: the `@tandem_engine` tag of an existing ccm-<name> session, or
   *  undefined if the session doesn't exist or was never tagged. Used by the
   *  router to distinguish "name taken by a DIFFERENT engine" (409) from a
   *  provenance/cwd adoption failure (403) — reading the tag alone reveals
   *  nothing the caller didn't already know (it supplied the name). */
  static async engineTagOf(name: string): Promise<string | undefined> {
    if (!(await TerminalSession.tmuxSessionExists(name))) return undefined
    const { engine } = await readProvenanceTags(name)
    return engine || undefined
  }

  /** True if THIS session's tmux target is still alive. */
  async isAlive(): Promise<boolean> {
    return TerminalSession.tmuxSessionExists(this._name)
  }

  /** True if a turn is currently running. Marker-based engines check the pane
   *  once. Markerless engines return false only after the pane has remained
   *  unchanged across their full stability window; any change returns true
   *  immediately. This intentionally makes a markerless read/status call wait
   *  before claiming idle rather than guessing from one short quiet interval. */
  async isCurrentlyWorking(): Promise<boolean> {
    let pane = await this.capture()
    if (this.descriptor.isWorking) return this.descriptor.isWorking(pane)
    const required = requiredStablePolls(this.descriptor)
    for (let observation = 1; observation < required; observation += 1) {
      await sleep(POLL_MS)
      const next = await this.capture()
      if (next.trimEnd() !== pane.trimEnd()) return true
      pane = next
    }
    return false
  }

  private static async tmuxSessionExists(name: string): Promise<boolean> {
    try {
      await tmux(['has-session', '-t', sessionTarget(name)])
      return true
    } catch {
      return false
    }
  }

  /** The pane's current screen (what a harness engine's state rules read). */
  screen(): Promise<string> {
    return this.capture()
  }

  /** capture-pane current visible content (ANSI already resolved by tmux -p). */
  private async capture(): Promise<string> {
    try {
      return await tmux(['capture-pane', '-p', '-t', this.tmuxTarget])
    } catch {
      return ''
    }
  }

  private isWorking(pane: string): boolean {
    return this.descriptor.isWorking ? this.descriptor.isWorking(pane) : false
  }

  /**
   * Wait for the engine to be ready. Marker-based descriptors (claude) dismiss
   * the first-run trust/bypass dialogs and wait for `isReady`. Markerless
   * descriptors (codex/shell) optionally submit `warmupPrompt` once, then wait
   * for the pane to be byte-stable for >= minStableMs (binding — Phase 2
   * correction B) — never a guessed readiness marker.
   */
  private async warmup(): Promise<void> {
    if (this.descriptor.isReady) {
      await this.warmupMarkerBased(this.descriptor.isReady)
      return
    }
    await this.warmupMarkerless()
  }

  private async warmupMarkerBased(isReady: (pane: string) => boolean): Promise<void> {
    const deadline = Date.now() + SPAWN_WARMUP_MS
    // Claude's own dialogs only: another agent's trust dialog never gets a key it was not sent.
    const isClaude = this.descriptor.id === 'claude'
    let trusted = false
    let bypassAccepted = false
    while (Date.now() < deadline) {
      const pane = await this.capture()
      const lower = pane.toLowerCase()
      if (isClaude && !trusted && lower.includes(TRUST_PROMPT_MARKER)) {
        // Confirm "Yes, I trust this folder" (the highlighted default) with Enter.
        await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])
        trusted = true
        await sleep(POLL_MS)
        continue
      }
      // First-run "Bypass Permissions mode" acceptance dialog (only when
      // --dangerously-skip-permissions is used AND the host hasn't accepted it
      // before / lacks settings.skipDangerousModePermissionPrompt). Best-effort:
      // the affirmative ("Yes, I accept") sits below the default "No, exit", so
      // move down once and confirm. Hosts that auto-skip this never hit it.
      if (isClaude && !bypassAccepted && lower.includes(BYPASS_ACCEPT_MARKER)) {
        await tmux(['send-keys', '-t', this.tmuxTarget, 'Down'])
        await sleep(150)
        await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])
        bypassAccepted = true
        await sleep(POLL_MS)
        continue
      }
      // Ready = the descriptor's readiness marker present and not working.
      if (isReady(pane) && !this.isWorking(pane)) {
        this._ready = true
        return
      }
      await sleep(POLL_MS)
    }
    // Don't hard-fail: the session may still be usable (e.g. a human attaches and
    // kicks the TUI), so we keep it. But DO record WHY it isn't ready so the caller
    // can surface an actionable message instead of silently driving a blank pane —
    // the #1 "sessions not working" symptom (a CPU-starved TUI under heavy load).
    const finalPane = await this.capture()
    const warning = describeReadiness(finalPane, loadavg()[0], cpus().length, this._name)
    if (warning === null) {
      // Became ready right at the deadline.
      this._ready = true
      return
    }
    this._ready = false
    this._readinessWarning = warning
    process.stderr.write(`[bridge] ${warning}\n`)
  }

  private async warmupMarkerless(): Promise<void> {
    if (this.descriptor.warmupPrompt) {
      await this.injectMultiline(this.descriptor.warmupPrompt)
      await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])
    }
    const deadline = Date.now() + SPAWN_WARMUP_MS
    let state = INITIAL_STABILITY_STATE
    const required = requiredStablePolls(this.descriptor)
    while (Date.now() < deadline) {
      const pane = await this.capture()
      const step = stepStability(pane, state, this.descriptor, required)
      state = step.state
      // Require non-blank content too: an all-empty pane can look "stable"
      // (unchanged) while genuinely never having rendered anything yet — avoid
      // false readiness on a pane that simply hasn't started printing.
      if (step.idle && pane.trim().length > 0) {
        this._ready = true
        return
      }
      await sleep(POLL_MS)
    }
    const finalPane = await this.capture()
    this._ready = false
    this._readinessWarning = describeMarkerlessReadiness(finalPane, loadavg()[0], cpus().length, this._name)
    process.stderr.write(`[bridge] ${this._readinessWarning}\n`)
  }

  /**
   * Inject a (possibly multi-line) body into the input box WITHOUT submitting it.
   * Each line is sent as a discrete literal `-l --` argv element; between lines a
   * dedicated literal-newline keystroke (`send-keys -l -- "\n"`) inserts a SOFT
   * newline in the input box. No Enter is pressed here, so nothing is submitted —
   * the caller presses Enter exactly once afterward to submit the whole body as a
   * single prompt. Empty `text` injects nothing.
   */
  private async injectMultiline(text: string): Promise<void> {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // Dedicated literal newline = soft line break in the TUI input box.
        await tmux(['send-keys', '-t', this.tmuxTarget, '-l', '--', '\n'])
      }
      const line = lines[i]
      if (line.length > 0) {
        await tmux(['send-keys', '-t', this.tmuxTarget, '-l', '--', line])
      }
    }
  }

  /**
   * Inject text (injection-safe), submit with Enter, then wait for the turn to
   * complete. Returns status:'done' with the harvested report once idle, or
   * status:'running' if the soft cap (~25s) elapses first. A hard cap
   * (default 180s) guarantees send() can never hang forever.
   *
   * MULTI-LINE SAFETY (see bridge/NOTES-terminal.md "Multi-line input"): relay
   * seeds, wrapped worker reports, and operator injections contain EMBEDDED
   * newlines. We MUST NOT submit them line-by-line (first line firing a turn
   * before the rest is typed, then a stray Enter submitting a partial prompt).
   * Empirically (Claude Code v2.1.157) the TUI treats a literal `\n` inside the
   * input box as a SOFT newline, not a submit — but to be robust against terminal
   * / version variance we type each line as its own literal `-l --` argv and
   * insert the line break with a DEDICATED `send-keys -l -- "\n"` (a discrete
   * literal newline keystroke) between lines, never as part of a key-name-
   * interpretable blob. Only the FINAL standalone `Enter` keypress submits, so a
   * multi-line message is always exactly one prompt, one turn, one submit.
   */
  async send(text: string): Promise<SendResult> {
    const startCursor = this.cursor()

    await this.injectMultiline(text)
    // Separate Enter keypress submits the prompt (the single submit for the whole
    // multi-line body).
    await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])

    const softDeadline = Date.now() + SEND_SOFT_CAP_MS
    const hardDeadline = Date.now() + SEND_HARD_CAP_MS

    // Give the spinner/output a moment to appear so we don't read the
    // pre-output "looks idle" window as completion.
    await sleep(POLL_MS)

    let state = INITIAL_STABILITY_STATE
    const required = requiredStablePolls(this.descriptor)
    for (;;) {
      const pane = await this.capture()
      const step = stepStability(pane, state, this.descriptor, required)
      state = step.state

      if (step.idle) {
        // Only a marker can say the turn finished; a markerless pane that held
        // still only says it went quiet.
        return { ...(await this.reportSince(startCursor)), status: this.descriptor.isWorking ? 'done' : 'quiet' }
      }
      if (Date.now() >= hardDeadline) {
        // Hard timeout: surface whatever we have and let the caller poll/read.
        return { ...(await this.reportSince(startCursor)), status: 'running' }
      }
      if (Date.now() >= softDeadline) {
        // Nothing was delivered, so the cursor stays where the turn began.
        return { report: '', cursor: startCursor, status: 'running' }
      }
      await sleep(POLL_MS)
    }
  }

  /**
   * Apply per-turn model/effort overrides to this LIVE session via its in-session
   * slash controls (`/effort <v>`, `/model <v>`), submitted as a preamble BEFORE
   * the next prompt. Values are validated (throws clearly on unsupported). Claude
   * only — callers must not invoke this for another engine. Returns the controls
   * applied (e.g. ["effort=high","model=opus"]).
   *
   * NOTE (Claude Code behavior): these in-session controls also persist as the
   * saved default for NEW sessions. For strictly session-scoped control with no
   * global side effect, set model/effort at OPEN time instead — they map to the
   * session-scoped `claude --model` / `--effort` flags.
   */
  async applyControls(controls: { model?: string; effort?: string }): Promise<string[]> {
    const applied: string[] = []
    if (controls.effort !== undefined) {
      const e = validateEffort(controls.effort)
      await this.submitControl(`/effort ${e}`)
      applied.push(`effort=${e}`)
    }
    if (controls.model !== undefined) {
      const m = validateModel(controls.model)
      await this.submitControl(`/model ${m}`)
      applied.push(`model=${m}`)
    }
    return applied
  }

  /**
   * Submit a single slash control line (e.g. "/effort high") and let the TUI apply
   * it. A slash control is a UI action, not a model turn — it doesn't raise the
   * working marker — so we just inject, Enter, and pause briefly to let the
   * autocomplete's exact match resolve and the setting take effect.
   */
  private async submitControl(line: string): Promise<void> {
    await this.injectMultiline(line)
    await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])
    await sleep(POLL_MS)
  }

  /** Current transcript byte length = the read cursor. */
  private cursor(): number {
    try {
      return statSync(this.logPath).size
    } catch {
      return 0
    }
  }

  /**
   * Read the ANSI-stripped transcript slice since a byte offset, plus the new
   * cursor and whether the session is currently idle. Synchronous-ish: reads the
   * file from `cursor` to EOF.
   */
  async readSince(cursor: number): Promise<ReadResult> {
    const size = this.cursor()
    const text = stripAnsi(await this.readRaw(cursor, size))
    const working = await this.isCurrentlyWorking()
    const state = working ? 'working' : this.descriptor.isWorking ? 'done' : 'quiet'
    return { text, cursor: size, idle: !working, state }
  }

  /** Read raw transcript bytes in [from, to) as UTF-8. */
  private async readRaw(from: number, to: number): Promise<string> {
    const start = Math.max(0, Math.min(from, to))
    if (to <= start) return ''
    const fh = await open(this.logPath, 'r')
    try {
      const buf = Buffer.alloc(to - start)
      await fh.read(buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      await fh.close()
    }
  }

  /**
   * Harvest a human-readable report once the turn is idle. The raw transcript
   * delta is extremely noisy — the TUI repaints the whole screen every frame and
   * interleaves animated spinner frames ("✻ Boondoggling…", "✳ Churned for 2s",
   * progress lines). The settled final screen (capture-pane) is the cleanest
   * representation of "what happened", so we use that as the report, cleaned of
   * the input-box chrome and footer. If capture-pane is empty we fall back to a
   * de-duplicated, spinner-filtered slice of the transcript delta. The full raw
   * (ANSI-stripped) transcript is always available via readSince() for review.
   */
  private async reportSince(cursor: number): Promise<{ report: string; cursor: number }> {
    // Fix the end offset BEFORE reading: bytes that land while the report is
    // read stay past the returned cursor, so the next readSince() gets them.
    const size = this.cursor()
    const fromPane = this.cleanReportLines((await this.capture()).split('\n'))
    const report =
      fromPane || (size > cursor ? this.cleanReportLines(stripAnsi(await this.readRaw(cursor, size)).split('\n')) : '')
    // The report is a cleaned view, not the raw bytes; say what it cut and where to read them.
    const cut = size > cursor ? `[${size - cursor} transcript bytes cut from this report; read from cursor ${cursor} to see them]` : ''
    return { report: [report, cut].filter(Boolean).join('\n'), cursor: size }
  }

  /** Drop blank/duplicate lines, spinner frames, progress lines, the input box,
   *  the bordered rules, and the status footer. The Claude-specific patterns
   *  below are harmless no-ops for codex/shell output, which doesn't contain
   *  Claude Code's exact spinner glyphs/footer text. */
  private cleanReportLines(lines: string[]): string {
    const out: string[] = []
    for (const line of lines) {
      const t = line.trimEnd()
      const trimmed = t.trim()
      if (!trimmed) continue
      // Bordered horizontal rules around the input box.
      if (/^[─-]{4,}$/.test(trimmed)) continue
      // Spinner frames: a leading status glyph then a "…"-terminated gerund or a
      // "<verb>ed for Ns" completion line.
      if (/^[✻✶✳✺✷✸✹✢✣·*●○◦]\s/.test(trimmed) && /(…|for \d+s|\bup\b|tokens)/.test(trimmed)) continue
      // The empty input prompt / "esc to interrupt" footer / auto-mode footer.
      if (trimmed === '❯' || trimmed.startsWith('❯ ←')) continue
      if (trimmed.includes('auto mode on (shift+tab')) continue
      if (trimmed.includes(CLAUDE_WORKING_MARKER)) continue
      if (out.length && out[out.length - 1] === t) continue
      out.push(t)
    }
    return out.join('\n').trim()
  }

  /** Interrupt a running turn: Escape (Claude Code's "esc to interrupt"), then
   *  a C-c as a fallback if the TUI is wedged. Works uniformly for codex/shell
   *  since Ctrl-C is the standard terminal interrupt signal for any foreground
   *  process, not a Claude-specific behavior. */
  async interrupt(): Promise<void> {
    try {
      await tmux(['send-keys', '-t', this.tmuxTarget, 'Escape'])
    } catch {
      /* fallthrough to C-c */
    }
    await sleep(150)
    try {
      await tmux(['send-keys', '-t', this.tmuxTarget, 'C-c'])
    } catch {
      /* best effort */
    }
  }

  /** Kill the tmux session. Idempotent. */
  async close(): Promise<void> {
    try {
      await tmux(['kill-session', '-t', sessionTarget(this._name)])
    } catch {
      /* already gone */
    }
  }
}
