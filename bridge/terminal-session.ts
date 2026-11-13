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
 * attach (attachHint(): `tmux -S <Tandem's socket> attach -t '=ccm-<name>'`) to watch or type
 * alongside. Every tmux call runs on Tandem's own socket (tmuxSocketPath()), never the default one.
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
 * (<transcriptsDir> = TANDEM_HOME/transcripts, else ~/.tandem/transcripts; folder 0700, logs 0600).
 * The append-only log's byte length is the cursor. readSince(offset) reads one page from a
 * byte offset (readLogPage: every page fits through the hub) and strips ANSI for a
 * human-readable slice. spawn and close also note the session for its agent's own
 * transcript pointer (./transcripts/index.ts).
 */

import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import { chmod, open, mkdir } from 'node:fs/promises'
import { cpus, homedir, loadavg } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { tandemHome } from './tandem-home.ts'
import { RE2JS } from 're2js'
import { CLAUDE_DESCRIPTOR, SendOutcomeUnknownError, SessionGoneError, TmuxBusyError, type EngineDescriptor } from './drivable.ts'
import { HIGHLIGHTS, NEVER, SKIPS_UPDATE, UPDATE_TEXT, type Dialog } from './harness-registry.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'
import { KillSwitchError, killSwitchOn } from './kill-switch.ts'
import { mintCallerToken, revokeCallerToken } from './caller-tokens.ts'
import { noteSessionClose, noteSessionStart, TRANSCRIPTS_DIR } from './transcripts/index.ts'

const HOME = homedir()

/** tmux session-name prefix. Only ccm-* sessions are drivable by the bridge,
 *  regardless of engine — the engine identity lives in the @tandem_engine tag. */
const SESSION_PREFIX = 'ccm-'

/** Session names must be tmux/file safe. */
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/

/** The footer string Claude Code shows ONLY while a turn is running (used only
 *  by report-cleaning below; the authoritative check is CLAUDE_DESCRIPTOR). */
const CLAUDE_WORKING_MARKER = 'esc to interrupt'

const POLL_MS = 750
/** Between the typed text and Enter: codex 0.167.1 takes an Enter that lands right after typed
 *  text as a newline (its paste detection), so the text is never submitted. Core waits 200 ms. */
const SUBMIT_PAUSE_MS = 200
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

/**
 * TANDEM_ALLOW_BYPASS=1 only lets the relay start (relay.ts refuses without it), and the router
 * starts a relay only in a limits-file `permission_skip` folder; the relay's two Claude Code
 * sessions start with `--dangerously-skip-permissions` (`allowBypass: true`). It adds nothing to an
 * opened session: that starts with its harness file's `skip_prompts_args` only when its real cwd is
 * in a `permission_skip` folder (bridge/limits.ts, engines/harness-engine.ts).
 *
 * SECURITY: skipping prompts ONLY suppresses the agent's in-session tool-permission prompts. It
 * does not change the admitted starting cwd: the cwd allowlist is enforced BEFORE spawn (in spawn()
 * below AND again in router.handleOpen), and the pane is created with `-c <validated real cwd>`.
 * The allowlist is an admission gate, not an OS sandbox, so the spawned process still has the
 * reach of its OS user. `allowBypass` is Claude-only; every other engine rejects it rather than
 * silently ignoring it.
 */
export function bypassPermissionsEnabled(): boolean {
  return (process.env.TANDEM_ALLOW_BYPASS ?? '').trim() === '1'
}

/**
 * The legacy TANDEM_SKIP_PERMISSIONS variable used to enable bypass BY DEFAULT
 * (opt-out). It no longer has any effect (see above). If a host still sets it,
 * warn to stderr rather than silently ignoring it, so the change in behavior is
 * visible instead of surprising.
 */
export function warnLegacySkipPermissionsIfSet(): void {
  if (process.env.TANDEM_SKIP_PERMISSIONS === undefined) return
  process.stderr.write(
    '[bridge] TANDEM_SKIP_PERMISSIONS is ignored and does not enable bypass. ' +
      "Agents start with their prompts off only in the limits file's permission_skip folders " +
      '(the relay also needs TANDEM_ALLOW_BYPASS=1).\n',
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
  /** Which first-run dialogs warmup may answer (`[[dialogs]]` rows of the descriptor): `safe` =
   *  trust and update, `safe-and-bypass` = those and bypass. Absent = `none`. The router sets it from
   *  the limits gate it already ran; reuse and adoption never run warmup, so never answer. */
  dialogAnswers?: DialogAnswers
  /** The start appends the harness file's skip_prompts_args (the router sets it only for a
   *  permission_skip folder); recorded in the session's start-flag tag. */
  skipPrompts?: boolean
  /** The binding folder re-check run right before new-session on the real start folder: a refusal
   *  text, or undefined. The router passes the limits file's folder (and permission_skip) checks. */
  folderCheck?: (realCwd: string) => string | undefined
  /** Which engine's tmux lifecycle to run. Defaults to CLAUDE_DESCRIPTOR; relay.ts
   *  passes the built-in claude harness file's descriptor. */
  descriptor?: EngineDescriptor
  /** Injectable owner-id provider — tests supply one bound to a temp state dir
   *  so the real `~/.tandem/owner-id` is never touched. */
  ownerIdProvider?: OwnerIdProvider
}

export type DialogAnswers = 'none' | 'safe' | 'safe-and-bypass'

/** Warmup met a first-run dialog it may not answer: the spawn killed its own tmux session. */
export class NeedsOwnerError extends Error {}

/** The folder re-check right before new-session refused the start: no session exists. */
export class FolderRefusedError extends Error {}

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
  /** More log bytes follow this page: read again from `cursor`. */
  more: boolean
}

/** A log page is at most this many bytes. */
const LOG_PAGE_BYTES = 65_536
/** ...and its text at most this many bytes as JSON. The hub counts every frame character as 4 bytes
 *  against 1,048,576, so a frame holds 262,144 characters; base64 makes the JSON body 4/3 longer, so
 *  a 98,304-byte page text keeps the frame near 131,500 characters, half the limit. */
const LOG_PAGE_JSON_BYTES = 98_304

/** Where a page of `buf` that stops before `len` may end: after its last newline, else at a UTF-8
 *  character boundary, and never before its first whole character. A character is at most 4 bytes,
 *  so its boundary is at most 3 bytes back; none there means the bytes are not UTF-8: cut at `len`. */
function pageEnd(buf: Buffer, len: number): number {
  const nl = buf.lastIndexOf(0x0a, len - 1)
  if (nl >= 0) return nl + 1
  for (let end = len; end > 0 && end >= len - 3; end--) if ((buf[end]! & 0xc0) !== 0x80) return end
  if (len > 3) return len
  let end = 1
  while (end < 4 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end++
  return end
}

/** Where a page that reaches the file's end ends: before a lead byte whose character has fewer bytes
 *  than it needs (it is still being written; read from there it comes whole once complete), else at
 *  `len`. Bytes that can never complete a character (a lone continuation byte, 0xF8-0xFF, a lead
 *  followed by a non-continuation byte) are returned as they are. */
function wholeEnd(buf: Buffer, len: number): number {
  for (let i = len - 1; i >= 0 && i >= len - 4; i--) {
    const b = buf[i]!
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xc0 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf7 ? 4 : 1
    return len - i < need ? i : len
  }
  return len
}

/**
 * One page of an append-only log from byte offset `from`: at most 65,536 bytes; when more bytes
 * remain it ends after its last newline (none: at a UTF-8 boundary); halved (same boundary rules,
 * at least one character) until its text is at most 98,304 bytes as JSON. `next` is the offset
 * after the page. `from` at or past the end, or a missing file: no text, `next` = the file size
 * (0 if missing). Synchronous, so relay.readSince and the router's relay read stay synchronous.
 */
export function readLogPage(path: string, from: number): { text: string; next: number; more: boolean } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { text: '', next: 0, more: false }
  }
  try {
    const size = fstatSync(fd).size
    const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0
    if (start >= size) return { text: '', next: size, more: false }
    // One byte past the page, so a cut there can see whether it splits a character.
    const buf = Buffer.alloc(Math.min(LOG_PAGE_BYTES + 1, size - start))
    const read = readSync(fd, buf, 0, buf.length, start)
    let len = Math.min(read, LOG_PAGE_BYTES)
    // At the file's end a character still being written is held back (U-R1A-19B): `end` stops before it.
    const end = start + len < size ? size : start + wholeEnd(buf, len)
    len = start + len < size ? pageEnd(buf, len) : end - start
    let text = buf.toString('utf8', 0, len)
    while (Buffer.byteLength(JSON.stringify(text)) > LOG_PAGE_JSON_BYTES) {
      len = pageEnd(buf, Math.max(1, Math.floor(len / 2)))
      text = buf.toString('utf8', 0, len)
    }
    return { text, next: start + len, more: start + len < end }
  } finally {
    closeSync(fd)
  }
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

/** The bridge's secret settings. A tmux client that starts the server hands it its environment,
 *  and every session inherits that, so no tmux call gets them; process.env keeps them. A session's
 *  caller token (bridge/caller-tokens.ts) is one too: each session gets only its own, by `-e`. */
const BRIDGE_SECRET_SETTINGS = ['TANDEM_OWNER_PASSWORD', 'TANDEM_HUB_LINK_TOKEN', 'TANDEM_FLEET_TOKEN', 'TANDEM_CALLER_TOKEN']

/** Field separator for tmux formats. tmux rewrites control characters in its output (3.4 prints
 *  a tab as `_`), and a session name can never hold `:`, so `|:|` survives and ends a name. */
export const TMUX_FIELD_SEP = '|:|'

/** Tandem's own tmux socket, `<TANDEM_HOME, else ~/.tandem>/tmux/tandem`, worked out at each call
 *  (never the user's default socket). Throws when the path is over 100 bytes (a Unix socket path
 *  holds about 104). */
export function tmuxSocketPath(home: string | undefined = process.env.TANDEM_HOME): string {
  const path = join(tandemHome(home), 'tmux', 'tandem')
  if (Buffer.byteLength(path) > 100) throw new Error(`tmux socket path too long: ${path}`)
  return path
}

/** The socket for the next tmux call. A missing TANDEM_HOME and `tmux/` are made 0700; a `tmux/`
 *  that is a symlink, not a folder, not this user's, or has a group/world bit is refused with
 *  nothing made or repaired and no tmux call. */
function prepareTmuxSocket(): string {
  const sock = tmuxSocketPath()
  const dir = dirname(sock)
  let st: Stats
  try {
    st = lstatSync(dir)
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    st = lstatSync(dir)
  }
  const refuse = (why: string) => new Error(`tmux socket folder refused: ${dir} (${why})`)
  if (st.isSymbolicLink()) throw refuse('a symlink')
  if (!st.isDirectory()) throw refuse('not a folder')
  if (process.getuid && st.uid !== process.getuid()) throw refuse('not owned by this user')
  if (st.mode & 0o077) throw refuse(`mode ${(st.mode & 0o777).toString(8)} has group/world bits`)
  return sock
}

/** Runs one tmux process with argv only (execTmux below). Injectable so the retry is testable. */
export type TmuxExec = (
  argv: string[],
  opts: { maxBuffer: number; env: NodeJS.ProcessEnv; timeout: number; killSignal: NodeJS.Signals },
  cb: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => void

const execTmux: TmuxExec = (argv, opts, cb) => {
  execFile('tmux', argv, opts, (error, stdout, stderr) => cb(error, String(stdout), String(stderr)))
}

/** A tmux that failed to START with one of these is retried; one that ran and exited non-zero is not. */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'])
const TMUX_RETRY_WAITS_MS = [50, 100, 150]
/** U-R1A-19B: every tmux call is killed after this long (a timeout is a passing failure, never retried).
 *  Synergy's runner has no timeout; this number is Tandem's own. */
const TMUX_CALL_TIMEOUT_MS = 10_000
/** has-session's one retry after a failed call, 40 ms later (Synergy's ALIVE_ENUM_RETRIES, ALIVE_ENUM_RETRY_MS). */
const ALIVE_PROBE_RETRY_MS = 40

/** How a tmux call failed (U-R1A-19B). no_server and no_session mean the session is not there; call_failed
 *  (tmux ran, or could not start, while the server may be up) and timeout are passing failures. */
export type TmuxFailureKind = 'no_server' | 'no_session' | 'call_failed' | 'timeout'

/** Synergy's two patterns (bridge/tmux.ts), the texts tmux 3.4 and 3.6b print: no socket file is
 *  `error connecting to <socket> (No such file or directory)`, a socket with nothing listening is
 *  `no server running on <socket>`, server up and the exact session absent is `can't find session: <name>`.
 *  Added (U-R1A-36F): list-panes on a server with zero sessions says `no current target`, no session.
 *  Anything else (`server exited unexpectedly`, `lost server`, `duplicate session`, `error connecting to
 *  <socket> (Permission denied)`) is call_failed. */
const NO_SERVER = /no server running|error connecting to .* \(no such file or directory\)/i
const NO_SESSION = /can't find session|session not found|no such session|no current target/i

function textKind(text: string): TmuxFailureKind {
  if (NO_SERVER.test(text)) return 'no_server'
  if (NO_SESSION.test(text)) return 'no_session'
  return 'call_failed'
}

/** The one classifier: the kind tmux() set on its error, else (an error that did not come from tmux(),
 *  or a bare `{ stderr }`) its stderr or message read by the same patterns. */
export function tmuxFailureKind(e: unknown): TmuxFailureKind {
  const own = (e as { tmuxFailure?: unknown } | null | undefined)?.tmuxFailure
  if (own === 'no_server' || own === 'no_session' || own === 'call_failed' || own === 'timeout') return own
  return textKind(String((e as { stderr?: unknown } | null | undefined)?.stderr ?? (e as Error | null | undefined)?.message ?? e))
}

/** The error for one failed tmux call, kind decided once: a string code is a start failure (ENOENT, no
 *  tmux program, is no_server; the rest call_failed), then a killed call is the timeout, then stderr.
 *  The message is `tmux <cmd> failed: <stderr, else the code>`, never error.message (it holds the
 *  whole argv, a caller token included). A passing failure is a TmuxBusyError. */
function tmuxError(cmd: string, error: Error & { code?: unknown; killed?: unknown }, stderr: string): Error {
  const code = error.code
  const kind: TmuxFailureKind =
    typeof code === 'string' ? (code === 'ENOENT' ? 'no_server' : 'call_failed') : error.killed === true ? 'timeout' : textKind(stderr)
  const detail =
    stderr ||
    (typeof code === 'string' ? `spawn failed: ${code}` : kind === 'timeout' ? `timed out after ${TMUX_CALL_TIMEOUT_MS} ms` : `exited with code ${String(code)}`)
  const message = `tmux ${cmd} failed: ${detail}`
  const e = kind === 'call_failed' || kind === 'timeout' ? new TmuxBusyError(message, kind) : new Error(message)
  return Object.assign(e, { code, tmuxFailure: kind })
}

/** The one tmux runner (bridge/sessions.ts uses it too): argv only, never a shell string;
 *  `-S <Tandem's socket>` first; the environment minus the bridge's secret settings. Resolves stdout. */
export async function tmux(args: string[], exec: TmuxExec = execTmux): Promise<string> {
  if (args[0] === 'new-session' && args.includes('-e')) return startCarryingToken(args, exec)
  return runTmux(args, exec)
}

/** U-R1A-36F: a server keeps its starting client's argv for life, so a `-e` (a caller token) never
 *  starts it. (1) `start-server ; set-option -s exit-empty off` with no token; (2) the new-session with
 *  `-N` (never start a server): a server gone since (1) fails it with "no server running", then (1)-(2)
 *  run once more, then the open fails; (3) success or failure, `exit-empty on` again, so the server
 *  still exits with its last session (no idle server is left). */
async function startCarryingToken(args: string[], exec: TmuxExec): Promise<string> {
  const noServer = (e: unknown) => tmuxFailureKind(e) === 'no_server'
  let created = false
  try {
    for (let attempt = 0; ; attempt++) {
      await runTmux(['start-server', ';', 'set-option', '-s', 'exit-empty', 'off'], exec)
      try {
        const out = await runTmux(['-N', ...args], exec)
        created = true
        return out
      } catch (e) {
        if (attempt >= 1 || !noServer(e)) throw e
      }
    }
  } finally {
    try {
      await runTmux(['set-option', '-s', 'exit-empty', 'on'], exec)
    } catch (e) {
      // Before a new session the open's own error is the one to report. U-R1A-19B: after a new session
      // the session is kept (its token valid); the server only stays up after its last session.
      if (created && !noServer(e)) {
        process.stderr.write(
          `[bridge] tmux: exit-empty on failed after a new session (${tmuxFailureKind(e)}); the tmux server stays up after its last session until the next open\n`,
        )
      }
    }
  }
}

async function runTmux(args: string[], exec: TmuxExec): Promise<string> {
  const argv = ['-S', prepareTmuxSocket(), ...args]
  const env = { ...process.env }
  for (const name of BRIDGE_SECRET_SETTINGS) delete env[name]
  const cmd = args[0] === '-N' ? args[1]! : args[0]!
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        exec(argv, { maxBuffer: 16 * 1024 * 1024, env, timeout: TMUX_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
          if (error) reject(tmuxError(cmd, error, stderr))
          else resolve(stdout)
        })
      })
    } catch (e) {
      const code = (e as { code?: unknown }).code
      const transient = typeof code === 'string' && TRANSIENT_SPAWN_CODES.has(code)
      if (!transient || attempt >= TMUX_RETRY_WAITS_MS.length) throw e
      await sleep(TMUX_RETRY_WAITS_MS[attempt])
    }
  }
}

/** A Tandem-socket server already running keeps the global environment it started with: drop the
 *  bridge's secret settings from it before a new session inherits them. No server: nothing to do. */
async function scrubServerSecrets(): Promise<void> {
  const argv = BRIDGE_SECRET_SETTINGS.flatMap((name, i) => [...(i ? [';'] : []), 'set-environment', '-g', '-u', name])
  try {
    await tmux(argv)
  } catch (e) {
    if (tmuxFailureKind(e) !== 'no_server') throw e
  }
}

/**
 * Every key Tandem presses in a session goes through here (U-R1A-19B). A tmux that never started (a
 * spawn failure: an errno code) pressed nothing and stays a TmuxBusyError. One that ran and failed for
 * a passing reason, or was killed by the timeout, may have pressed its keys: SendOutcomeUnknownError,
 * so no caller is invited to send them again. A gone session's error is unchanged.
 */
async function sendKeys(args: string[]): Promise<void> {
  try {
    await tmux(['send-keys', ...args])
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const neverStarted = typeof code === 'string' && !code.startsWith('ERR_')
    if (e instanceof TmuxBusyError && !neverStarted) throw Object.assign(new SendOutcomeUnknownError(e.message, e.tmuxFailure), { code })
    throw e
  }
}

/**
 * U-R1A-19B: is ccm-<name> there? `has-session -t =ccm-<name>` (exact). Exit 0 is alive; no session or
 * no server is gone (Tandem's own socket runs exit-empty on, so no server means no session; Synergy, on
 * the shared default socket, read no server as passing). A failed call is asked once more 40 ms later,
 * then throws its TmuxBusyError; a timeout throws at once. Any other failure (a refused socket folder)
 * reads as gone, as before.
 */
export async function probeAlive(name: string, exec: TmuxExec = execTmux): Promise<'alive' | 'gone'> {
  for (let attempt = 0; ; attempt++) {
    try {
      await tmux(['has-session', '-t', sessionTarget(name)], exec)
      return 'alive'
    } catch (e) {
      if (!(e instanceof TmuxBusyError)) return 'gone'
      if (e.tmuxFailure === 'timeout' || attempt >= 1) throw e
      await sleep(ALIVE_PROBE_RETRY_MS)
    }
  }
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The command that attaches a terminal to ccm-<name> on Tandem's socket, every part single-quoted
 *  so sh, bash and zsh read it as typed (zsh would expand a bare leading `=`). */
export function attachCommand(name: string): string {
  return `tmux -S ${shellQuote(tmuxSocketPath())} attach -t ${shellQuote(sessionTarget(name))}`
}

/** Read a spawned session's `@tandem_engine` / `@tandem_owner` tmux user options
 *  in one round trip. Empty strings mean "tag absent" (tmux prints nothing for
 *  an unset user option in `display-message`, never throws). */
async function readProvenanceTags(name: string): Promise<{ engine: string; owner: string }> {
  try {
    const raw = await tmux(['display-message', '-p', '-t', paneTarget(name), `#{@tandem_engine}${TMUX_FIELD_SEP}#{@tandem_owner}`])
    const fields = raw.replace(/\n$/, '').split(TMUX_FIELD_SEP)
    // Exactly two fields, else a tag holds the separator: read as absent (never adopted or listed).
    if (fields.length !== 2) return { engine: '', owner: '' }
    const [engine, owner] = fields
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
    real = realpathSync.native(cwd)
  } catch {
    return false
  }
  return allowlist.some((root) => {
    try {
      return isUnder(real, realpathSync.native(root))
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
    `initialized — attach a real terminal once to kick it: ${attachCommand(name)}`
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

const dialogPatterns = new WeakMap<Dialog, RE2JS[]>()
function patternsOf(d: Dialog): RE2JS[] {
  let set = dialogPatterns.get(d)
  if (!set) {
    set = d.match.map((p) => RE2JS.compile(p, RE2JS.MULTILINE))
    dialogPatterns.set(d, set)
  }
  return set
}

const isAnswer = (t: string, d: Dialog) => t === d.answer || t.startsWith(`${d.answer} (`)

/** A box row: the trimmed line starts and ends with `│` (both borders); its text between them,
 *  trimmed. Any other line: trimmed. */
function unbox(line: string): string {
  const t = line.trim()
  return isBoxRow(t) ? t.slice(1, -1).trim() : t
}
const isBoxRow = (t: string) => t.length >= 2 && t.startsWith('│') && t.endsWith('│')

/** Key mode's start form: the trimmed line, after one optional HIGHLIGHTS marker and its spaces,
 *  starts `[k]` and spaces; the key and the rest, else undefined. */
function startForm(line: string): { key: string; rest: string } | undefined {
  let t = unbox(line)
  const mark = HIGHLIGHTS.find((m) => t.startsWith(m))
  if (mark !== undefined) t = t.slice(mark.length).trimStart()
  const m = /^\[([a-z0-9])\]\s+(.*)$/.exec(t)
  return m ? { key: m[1]!, rest: m[2]! } : undefined
}

/** An option line of `d`: its text, trimmed (a box row: the text between its borders, see unbox),
 *  after an optional highlight marker and an optional `N. ` (key mode: before a trailing whitespace and the key), equals the answer or starts with
 *  the answer and ` (`. Key mode also reads the start form: `[key] ` (after an optional marker)
 *  then the answer. */
function isAnswerLine(line: string, d: Dialog): boolean {
  let t = unbox(line)
  if (d.highlight !== undefined && t.startsWith(d.highlight)) t = t.slice(d.highlight.length).trimStart()
  t = t.replace(/^\d+\.\s*/, '')
  if (d.key !== undefined) {
    const start = startForm(line)
    if (start?.key === d.key && isAnswer(start.rest, d)) return true
    t = t.replace(new RegExp(`\\s+${d.key}$`), '')
  }
  return isAnswer(t, d)
}

/** The dialogs on screen: every `match` pattern matches the screen and an answer line is present. */
export function shownDialogs(pane: string, dialogs: readonly Dialog[] = []): Dialog[] {
  const lines = pane.split('\n')
  return dialogs.filter((d) => patternsOf(d).every((re) => re.matcher(pane).find()) && lines.some((l) => isAnswerLine(l, d)))
}

/** The one key this screen poll may send to dialog `d`, else undefined. A block is the run of
 *  non-blank lines, not starting `─`, around the answer line. Select mode (`highlight`): Enter only
 *  when the marker is on the answer line, else one Down/Up toward it (the list may wrap, so never a
 *  blind Down+Enter). Key mode (`key`): the key only when the answer line shows it (ends with
 *  whitespace and the key, or starts `[key] `) and no other line of its block shows it. */
export function dialogKey(pane: string, d: Dialog): string | undefined {
  const lines = pane.split('\n')
  const at = lines.findIndex((l) => isAnswerLine(l, d))
  if (at < 0) return undefined
  // A box row holding only spaces is blank: it ends a block as a blank line does.
  const inBlock = (i: number) => unbox(lines[i] ?? '') !== '' && !/^\s*─/.test(lines[i]!)
  if (d.key !== undefined) {
    const end = new RegExp(`\\s${d.key}$`)
    const shows = (i: number) => end.test(lines[i]!.trimEnd()) || end.test(unbox(lines[i]!)) || startForm(lines[i]!)?.key === d.key
    if (!shows(at)) return undefined
    for (let i = at - 1; inBlock(i); i--) if (shows(i)) return undefined
    for (let i = at + 1; inBlock(i); i++) if (shows(i)) return undefined
    return d.key
  }
  const highlighted = (i: number) => unbox(lines[i]!).startsWith(d.highlight!)
  for (let i = at; inBlock(i); i--) if (highlighted(i)) return i === at ? 'Enter' : 'Down'
  for (let i = at + 1; inBlock(i); i++) if (highlighted(i)) return 'Up'
  return undefined
}

/** A dialog's option row: after unbox, it starts with a HIGHLIGHTS marker, `N. ` or `[k] `, ends with
 *  whitespace and one key character, or holds `y/n`. */
function isOptionRow(line: string): boolean {
  const t = unbox(line)
  return HIGHLIGHTS.some((m) => t.startsWith(m)) || /^\d+\.\s/.test(t) || /^\[[a-z0-9]\]\s/.test(t) || /\s[a-z0-9]$/.test(t) || /y\/n/i.test(t)
}

/** The pane with every update banner's lines removed. A banner is a notice row holding `update
 *  available` plus at most one more row, either boxed alone (a `╭` line, 1 or 2 `│ … │` rows, a `╰`
 *  line) or plain (1 or 2 non-blank lines with a blank line or the pane's edge above and below),
 *  with no option row in it and none as the next non-blank line under it (a dialog's own heading is
 *  not a banner). It is never a dialog: nothing is typed for it. */
export function withoutUpdateBanners(pane: string): string {
  const lines = pane.split('\n')
  const blank = (i: number) => (lines[i] ?? '').trim() === ''
  const banner = (rows: number[]) => {
    let next = rows[rows.length - 1]! + 1
    if ((lines[next] ?? '').trim().startsWith('╰')) next++
    while (next < lines.length && blank(next)) next++
    return /update available/i.test(unbox(lines[rows[0]!]!)) && ![...rows, next].some((r) => r < lines.length && isOptionRow(lines[r]!))
  }
  const drop = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('╭')) {
      for (const n of [1, 2]) {
        const rows = Array.from({ length: n }, (_, k) => i + 1 + k)
        if (rows.every((r) => isBoxRow((lines[r] ?? '').trim())) && (lines[i + n + 1] ?? '').trim().startsWith('╰') && banner(rows)) {
          for (let r = i; r <= i + n + 1; r++) drop.add(r)
          break
        }
      }
    }
    if (blank(i) || !blank(i - 1)) continue
    let end = i
    while (end < lines.length && !blank(end)) end++
    const rows = Array.from({ length: end - i }, (_, k) => i + k)
    if (rows.length <= 2 && banner(rows)) for (const r of rows) drop.add(r)
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

const allowsDialog = (answers: DialogAnswers, kind: Dialog['kind']) =>
  kind === 'bypass' ? answers === 'safe-and-bypass' : answers !== 'none'

/** At most this many arrows per dialog per start. */
const MAX_DIALOG_ARROWS = 8
/** An answered dialog still shown up to this long after its Enter or key gets no key and is not
 *  `needs owner` (Gemini keeps its trust dialog up about 250 ms while it restarts). */
const ANSWER_GRACE_MS = 1000

/** Warmup's dialog progress for one start. */
interface DialogWatch {
  /** The screen the last key was sent on: no next key until the screen changed. */
  movedOn?: string
  /** Dialogs that got their Enter or key. */
  answered: Set<string>
  /** When each answered dialog got its Enter or key (Date.now()). */
  answeredAt: Map<string, number>
  arrows: Map<string, number>
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

/**
 * The argv tmux runs for `descriptor` (never one command string, decision D7). The real cwd is
 * allowlist-checked separately (in spawn and router.handleOpen); these flags do not change the
 * admitted start directory, and the cwd gate is not an OS sandbox: the process keeps the reach of
 * its OS user. Called first in spawn, so a refused or bad flag fails before any cwd, tmux or file
 * access instead of launching a misconfigured session.
 *
 * No silent option loss (binding — Phase 2 correction C): a non-Claude engine REJECTS
 * model/effort/bypass rather than quietly ignoring them. Claude's flags follow its argv, whether
 * that is CLAUDE_DESCRIPTOR's executable (the default) or the claude harness file's argv (the
 * harness engine and the relay). No side effect: spawn writes the legacy-variable warning.
 * Bypass is added only for `allowBypass: true`, which only the relay passes: TANDEM_ALLOW_BYPASS no
 * longer adds a flag to an opened session, which starts with its harness file's skip_prompts_args
 * only in a limits-file `permission_skip` folder (bridge/limits.ts, engines/harness-engine.ts).
 */
export function spawnArgv(
  descriptor: EngineDescriptor,
  opts: Pick<SpawnOptions, 'model' | 'effort' | 'allowBypass'>,
): string[] {
  if (descriptor.id !== 'claude') {
    if (opts.model !== undefined || opts.effort !== undefined) {
      throw new Error(`model/effort are Claude-only options; not supported for engine "${descriptor.id}"`)
    }
    if (opts.allowBypass !== undefined) {
      throw new Error(`bypass is a Claude-only option; not supported for engine "${descriptor.id}"`)
    }
  }
  const engineArgv: string[] = []
  if (descriptor.argv) {
    // A harness engine: its argv verbatim, never one command string (decision D7).
    engineArgv.push(...descriptor.argv)
  } else if (descriptor.executable) {
    engineArgv.push(descriptor.executable)
  } else {
    // Shell engine: the pane's default login shell — SHELL env if set, else a
    // portable fallback. Never a shell STRING; this is one argv element handed
    // straight to tmux/execFile, so it can't be reinterpreted.
    const shellBin = (process.env.SHELL ?? '').trim() || '/bin/sh'
    engineArgv.push(shellBin, '-l')
  }
  if (descriptor.id === 'claude') {
    const skip = opts.allowBypass === true
    if (skip) engineArgv.push('--dangerously-skip-permissions')
    if (opts.model !== undefined) engineArgv.push('--model', validateModel(opts.model))
    if (opts.effort !== undefined) engineArgv.push('--effort', validateEffort(opts.effort))
  }
  return engineArgv
}

export class TerminalSession {
  private readonly _name: string
  private readonly _cwd: string
  private readonly logPath: string
  private readonly descriptor: EngineDescriptor
  private readonly dialogAnswers: DialogAnswers
  /** The start-flag tag: '1' started with its prompts off, '0' not, undefined untagged (adopted without a valid tag). */
  private readonly _skipTag: '1' | '0' | undefined
  /** Set by warmup(): did the TUI reach its prompt? */
  private _ready = false
  /** Set by warmup() when NOT ready: an actionable reason (load/blank/attach). */
  private _readinessWarning: string | undefined

  // Explicit field assignment (NOT TS "parameter properties") — the bridge runs
  // under `node --experimental-strip-types`, whose strip-only mode rejects the
  // `private x: T` constructor-parameter shorthand.
  private constructor(
    name: string,
    cwd: string,
    logPath: string,
    descriptor: EngineDescriptor,
    dialogAnswers: DialogAnswers = 'none',
    skipTag?: '1' | '0',
  ) {
    this._name = name
    this._cwd = cwd
    this.logPath = logPath
    this.descriptor = descriptor
    this.dialogAnswers = dialogAnswers
    this._skipTag = skipTag
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

  /** The start-flag tag: the router re-checks a reused or adopted session by it. */
  get skipTag(): '1' | '0' | undefined {
    return this._skipTag
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

  /** Tandem's socket and the exact target, quoted for pasting into sh, bash or zsh. */
  attachHint(): string {
    return attachCommand(this._name)
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
    // The kill switch (bridge/kill-switch.ts): nothing starts while it is on (opens and both relay sessions spawn here).
    if (killSwitchOn()) throw new KillSwitchError()
    // Flags are refused or validated here, before any cwd, tmux or file access.
    const engineArgv = spawnArgv(descriptor, opts)
    // Once per spawn (spawnArgv has no side effect; a harness engine calls it twice).
    if (descriptor.id === 'claude') warnLegacySkipPermissionsIfSet()
    if (!existsSync(requestedCwd) || !statSync(requestedCwd).isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${requestedCwd}`)
    }
    const cwd = realpathSync.native(requestedCwd)
    if (!isCwdAllowedLocal(cwd, allowlist)) {
      throw new Error(`cwd not allowed: ${requestedCwd}`)
    }

    const target = SESSION_PREFIX + name
    // A refused or too-long socket path fails here, naming it, before any tmux call or file write.
    prepareTmuxSocket()
    // Refuse to clobber an existing session of the same name.
    if (await TerminalSession.tmuxSessionExists(name)) {
      throw new Error(`tmux session already exists: ${target}`)
    }

    // Resolve the durable owner id BEFORE creating any tmux state, so a failure
    // here (e.g. unwritable state dir) never leaves an orphaned/untagged session.
    const ownerIdProvider = opts.ownerIdProvider ?? makeOwnerIdProvider()
    const ownerId = await ownerIdProvider()

    await mkdir(TRANSCRIPTS_DIR, { recursive: true, mode: 0o700 })
    await chmod(TRANSCRIPTS_DIR, 0o700)
    const logPath = join(TRANSCRIPTS_DIR, `${name}.log`)
    // Truncate any stale transcript so the byte cursor starts clean.
    await (await open(logPath, 'w', 0o600)).close()
    await chmod(logPath, 0o600)

    // Inject text injection-safe — but here the args are all bridge-controlled
    // (constants + validated flags), so this is a normal new-session. The engine
    // binary (or login shell) runs INSIDE the pane; the cwd is set via -c.
    const startedAtMs = Date.now()
    await scrubServerSecrets()
    // The binding folder check, right before new-session: this realpath is the -c folder.
    // Remaining window: (1) between this realpath and the tmux server's chdir for -c (one tmux call)
    // a parent folder swapped for a symlink still moves the start, and a folder removed there starts in
    // tmux's fallback folder (the home folder) while the session records the checked one; (2) the program file at the checked
    // real path can be replaced in place between the limits gate's sha256 read and the exec; (3) the
    // relay's start runs harnessDescriptor(claude) on the found path, not on a checked real path
    // (relay.ts). Closing (1) and (2) needs a start by file descriptor, which tmux does not offer.
    let startCwd: string
    try {
      startCwd = realpathSync.native(requestedCwd)
    } catch {
      throw new FolderRefusedError(`cwd not allowed: ${requestedCwd}`)
    }
    if (!isCwdAllowedLocal(startCwd, allowlist)) throw new FolderRefusedError(`cwd not allowed: ${requestedCwd}`)
    const refused = opts.folderCheck?.(startCwd)
    if (refused !== undefined) throw new FolderRefusedError(refused)
    const skip = opts.skipPrompts === true || opts.allowBypass === true
    // This session's own caller token, for its pane's process only (never the server's global
    // environment, never this process's env); a spawn that fails from here on revokes it.
    const callerToken = mintCallerToken(name, startCwd)
    let created = false
    try {
      await tmux([
        'new-session',
        '-d',
        '-s',
        target,
        '-e',
        `TANDEM_CALLER_TOKEN=${callerToken}`,
        '-x',
        String(PANE_WIDTH),
        '-y',
        String(PANE_HEIGHT),
        '-c',
        startCwd,
        ...engineArgv,
        // In the same tmux call: the pane's process has the token by now, so it leaves the session
        // environment, where `tmux show-environment -t` would hand it to any process of this user.
        ';',
        'set-environment',
        '-t',
        sessionTarget(name),
        '-u',
        'TANDEM_CALLER_TOKEN',
        // The start-flag tag, in the same call: no session Tandem made lives untagged. Never written
        // anywhere else; a failure here leaves the session untagged (never reused outside permission_skip).
        ';',
        'set-option',
        '-t',
        paneTarget(name),
        '@tandem_skip',
        skip ? '1' : '0',
      ])
      created = true
      // The switch turned on since the check above: engage() may have listed the sessions before this
      // one existed, so it is ended here (the file is written before the list, so one of the two sees it).
      if (killSwitchOn()) {
        await tmux(['kill-session', '-t', sessionTarget(name)]).catch(() => {})
        throw new KillSwitchError()
      }
      noteSessionStart({ name, agent: descriptor.id, cwd: startCwd, startedAtMs })

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

      const session = new TerminalSession(name, startCwd, logPath, descriptor, opts.dialogAnswers ?? 'none', skip ? '1' : '0')
      try {
        await session.warmup()
      } catch (e) {
        if (e instanceof NeedsOwnerError || e instanceof KillSwitchError) await session.close()
        throw e
      }
      return session
    } catch (e) {
      // U-R1A-19B: an open that fails once its session exists ends that session (its token goes below).
      // Never after a failed new-session: a `duplicate session` is another session's.
      // ponytail: a new-session killed by the timeout may leave a session this cannot tell is its own,
      // and a kill-session that itself fails leaves the session; both stay as they are.
      if (created) await tmux(['kill-session', '-t', sessionTarget(name)]).catch(() => {})
      try {
        revokeCallerToken(name)
      } catch {
        /* the spawn's own error is the one to report */
      }
      throw e
    }
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
    // Read the cwd tmux recorded for the session (the session's actual pane cwd): one trailing
    // newline removed, nothing trimmed; an empty or failed read adopts nothing (no HOME default).
    let cwd: string
    try {
      cwd = (await tmux(['display-message', '-p', '-t', paneTarget(name), '#{pane_current_path}'])).replace(/\n$/, '')
    } catch {
      return undefined
    }
    if (cwd === '') return undefined
    // Re-validate the ADOPTED cwd against the allowlist — do not drive a session
    // whose real cwd is outside the boundary.
    if (!canAdoptTerminalSession(provenance, descriptor.id, expectedOwner, cwd, allowlist)) {
      return undefined
    }
    // The start-flag tag: exactly `1` or `0`, anything else is untagged; a failed read adopts nothing.
    let skipTag: '1' | '0' | undefined
    try {
      const raw = (await tmux(['display-message', '-p', '-t', paneTarget(name), '#{@tandem_skip}'])).replace(/\n$/, '')
      skipTag = raw === '1' || raw === '0' ? raw : undefined
    } catch {
      return undefined
    }
    return new TerminalSession(name, cwd, logPath, descriptor, 'none', skipTag)
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

  /** True if THIS session's tmux target is still alive (probeAlive); a passing failure throws TmuxBusyError. */
  async isAlive(): Promise<boolean> {
    return (await probeAlive(this._name)) === 'alive'
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
   * Wait for the engine to be ready. Marker-based descriptors wait for `isReady`. Markerless
   * descriptors (codex/shell) optionally submit `warmupPrompt` once, then wait for the pane to be
   * byte-stable for >= minStableMs (binding — Phase 2 correction B) — never a guessed readiness
   * marker. Both first answer a first-run dialog of the descriptor's `dialogs` (answerDialog), before
   * the ready check, so a dialog wins over any state; one it may not answer throws NeedsOwnerError.
   */
  private async warmup(): Promise<void> {
    if (this.descriptor.isReady) {
      await this.warmupMarkerBased(this.descriptor.isReady)
      return
    }
    await this.warmupMarkerless()
  }

  private needsOwner(d: Dialog, reason: string): NeedsOwnerError {
    return new NeedsOwnerError(
      `needs owner: ${this.descriptor.id} shows its first-run ${d.kind} dialog "${d.name}" in ${this._cwd} (${reason}); ` +
        'Tandem typed no answer. Open it there yourself once, then open the session again.',
    )
  }

  /**
   * One warmup poll's dialog step: true when a dialog is on screen (a key was sent, or warmup waits
   * for the screen to change or the answer to be highlighted). One key per poll, and no next key
   * until the screen changed since the last one; at most 8 arrows and one Enter or key per dialog.
   * Throws NeedsOwnerError, sending no key, when `dialogAnswers` does not allow the dialog's kind,
   * when NEVER matches the screen, when the screen shows update text (update banners removed) and the
   * dialog is not an `update` one that skips, or when a dialog is still shown more than
   * ANSWER_GRACE_MS after its Enter or key (within it: no key, wait). Two
   * dialogs at once get no key. The screen is read again right before the key: the key goes only when
   * that read shows the same one dialog with the same key, else nothing is sent and the next poll decides.
   */
  private async answerDialog(pane: string, watch: DialogWatch): Promise<boolean> {
    const shown = shownDialogs(pane, this.descriptor.dialogs)
    if (shown.length === 0) return false
    if (pane === watch.movedOn || shown.length > 1) return true
    const d = shown[0]!
    if (watch.answered.has(d.name)) {
      if (Date.now() - (watch.answeredAt.get(d.name) ?? 0) <= ANSWER_GRACE_MS) return true
      throw this.needsOwner(d, "it is still shown after Tandem's answer")
    }
    if (!allowsDialog(this.dialogAnswers, d.kind)) throw this.needsOwner(d, `the limits file lets Tandem answer no ${d.kind} dialog here`)
    if (NEVER.test(pane)) throw this.needsOwner(d, 'the screen asks for a sign-in or a purchase')
    // Checked here too: a descriptor need not come from the loader. An update is only ever skipped.
    if (UPDATE_TEXT.test(d.answer) || (UPDATE_TEXT.test(withoutUpdateBanners(pane)) && !(d.kind === 'update' && SKIPS_UPDATE.test(d.answer)))) {
      throw this.needsOwner(d, 'the screen asks about an update, which Tandem only skips')
    }
    const key = dialogKey(pane, d)
    if (key === undefined) return true
    const arrow = key === 'Down' || key === 'Up'
    const arrows = watch.arrows.get(d.name) ?? 0
    if (arrow && arrows >= MAX_DIALOG_ARROWS) return true
    // No dialog is answered while the kill switch is on: the start fails and spawn ends the session.
    if (killSwitchOn()) throw new KillSwitchError()
    // Read again: a dialog that has gone (or changed) gets no key. The window left is one tmux call.
    const again = await this.capture()
    const still = shownDialogs(again, this.descriptor.dialogs)
    if (still.length !== 1 || still[0]!.name !== d.name || dialogKey(again, d) !== key) return true
    if (arrow) watch.arrows.set(d.name, arrows + 1)
    else watch.answered.add(d.name)
    await sendKeys(['-t', this.tmuxTarget, key])
    if (!arrow) watch.answeredAt.set(d.name, Date.now())
    watch.movedOn = pane
    return true
  }

  /** At the warmup deadline a dialog still on screen fails the start. */
  private failIfDialogShown(pane: string): void {
    const shown = shownDialogs(pane, this.descriptor.dialogs)
    if (shown.length > 0) throw this.needsOwner(shown[0]!, 'it is still shown when the warmup ended')
  }

  private async warmupMarkerBased(isReady: (pane: string) => boolean): Promise<void> {
    const deadline = Date.now() + SPAWN_WARMUP_MS
    const watch: DialogWatch = { answered: new Set(), answeredAt: new Map(), arrows: new Map() }
    while (Date.now() < deadline) {
      const pane = await this.capture()
      if (await this.answerDialog(pane, watch)) {
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
    this.failIfDialogShown(finalPane)
    // Ready only on the descriptor's own positive idle.
    const warning = isReady(finalPane) && !this.isWorking(finalPane)
      ? null
      : describeMarkerlessReadiness(finalPane, loadavg()[0], cpus().length, this._name)
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
    if (this.descriptor.warmupPrompt) await this.typeAndSubmit(this.descriptor.warmupPrompt)
    const deadline = Date.now() + SPAWN_WARMUP_MS
    let state = INITIAL_STABILITY_STATE
    const required = requiredStablePolls(this.descriptor)
    const watch: DialogWatch = { answered: new Set(), answeredAt: new Map(), arrows: new Map() }
    while (Date.now() < deadline) {
      const pane = await this.capture()
      if (await this.answerDialog(pane, watch)) {
        await sleep(POLL_MS)
        continue
      }
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
    this.failIfDialogShown(finalPane)
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
        await sendKeys(['-t', this.tmuxTarget, '-l', '--', '\n'])
      }
      const line = lines[i]
      if (line.length > 0) {
        await sendKeys(['-t', this.tmuxTarget, '-l', '--', line])
      }
    }
  }

  /** Every typed-then-submitted text goes through here: type it, pause, then one Enter. While the
   *  kill switch is on it throws KillSwitchError before any tmux call (send, so every send_to_session,
   *  mail notice and relay turn, and applyControls all come here). */
  private async typeAndSubmit(text: string): Promise<void> {
    if (killSwitchOn()) throw new KillSwitchError()
    // U-R1A-19B: nothing is typed unless has-session says alive (a passing failure throws TmuxBusyError).
    if ((await probeAlive(this._name)) === 'gone') throw new SessionGoneError(SESSION_PREFIX + this._name)
    await this.injectMultiline(text)
    await sleep(SUBMIT_PAUSE_MS)
    await sendKeys(['-t', this.tmuxTarget, 'Enter'])
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

    // Separate Enter keypress submits the prompt (the single submit for the whole
    // multi-line body).
    await this.typeAndSubmit(text)

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
    await this.typeAndSubmit(line)
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
   * Read one ANSI-stripped page of the transcript from a byte offset (readLogPage),
   * plus the cursor after it, whether more pages follow, and whether the session is
   * currently idle.
   */
  async readSince(cursor: number): Promise<ReadResult> {
    const page = readLogPage(this.logPath, cursor)
    // While more pages follow, the turn is not reported idle: poll loops keep reading, and the
    // router's completion event fires once, on the last page.
    const working = page.more || (await this.isCurrentlyWorking())
    const state = working ? 'working' : this.descriptor.isWorking ? 'done' : 'quiet'
    return { text: stripAnsi(page.text), cursor: page.next, idle: !working, state, more: page.more }
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

  /** Interrupt a running turn: each key in order, 150 ms apart. The default is
   *  Escape (Claude Code's "esc to interrupt"), then a C-c as a fallback if the
   *  TUI is wedged; Ctrl-C is the standard terminal interrupt for any foreground
   *  process. A harness session passes its file's `keys.interrupt`. */
  async interrupt(keys: readonly string[] = ['Escape', 'C-c']): Promise<void> {
    // U-R1A-19B: a gone session gets no key (as before, when its keys failed); a passing failure throws.
    if ((await probeAlive(this._name)) === 'gone') return
    // Every key is still tried (best effort). Then: a key whose outcome is unknown throws that; when no
    // key's tmux even started, nothing was pressed and its TmuxBusyError is thrown.
    let unknown: SendOutcomeUnknownError | undefined
    let neverStarted: TmuxBusyError | undefined
    let started = 0
    for (const [i, key] of keys.entries()) {
      if (i > 0) await sleep(150)
      try {
        await sendKeys(['-t', this.tmuxTarget, key])
        started++
      } catch (e) {
        if (e instanceof SendOutcomeUnknownError) unknown ??= e
        else if (e instanceof TmuxBusyError) neverStarted ??= e
        else started++
      }
    }
    if (unknown) throw unknown
    if (neverStarted && started === 0) throw neverStarted
  }

  /** Kill the tmux session, revoke its caller token, then record its transcript pointer one last
   *  time. Idempotent. */
  async close(): Promise<void> {
    try {
      await tmux(['kill-session', '-t', sessionTarget(this._name)])
    } catch {
      /* already gone */
    }
    try {
      revokeCallerToken(this._name)
    } catch {
      /* state.db unreadable: the row stays until this name is spawned again (caller-tokens.ts) */
    }
    await noteSessionClose(this._name)
  }
}
