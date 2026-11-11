/**
 * drivable.ts — the generic session contract shared by every engine (Phase 1
 * wired only `claude` through it; Phase 2 adds `codex`/`shell` tmux descriptors
 * and the separate HTTP-based `hermes` adapter without changing this shape).
 *
 * Tandem keeps ownership and allowlist checks OUTSIDE this contract (in
 * router.ts and the per-engine spawn path), never inside an adapter.
 *
 * BOUNDED TURN CONTRACT (binding — see .claude/specs/tailscale-fleet-mvp.md
 * "Phase 1 plan review decision" #1): send() returns the generic bounded
 * SendResult {status, report, cursor}. There is no Claude-only `sendAndWait`
 * escape hatch — every interactive engine (and the later fleet RPC) implements
 * this SAME bounded contract, so the router never needs engine-specific code
 * to know whether a turn finished or is still running. `status: "running"`
 * means the caller should call read()/poll to keep observing the turn — NOT
 * call send() again with the same prompt; send() again means a NEW instruction.
 */

/** The four engines with code of their own. */
export type BuiltinEngineId = 'claude' | 'codex' | 'shell' | 'hermes'

/** A built-in id or the name of a loaded harness file (harnesses/SCHEMA.md). */
export type EngineId = string

/** Per-turn overrides a caller may pass to send(). Claude-only — every other
 *  engine's adapter MUST reject a request that sets either field rather than
 *  silently ignoring it (binding — Phase 2 correction C). */
export interface SendOptions {
  model?: string
  effort?: string
}

/** The bounded result of a single send() call — status:'running' means the
 *  engine's configured soft cap elapsed, not that the turn failed; the caller
 *  calls read()/poll to keep observing it, NOT send() again with the same
 *  prompt. 'done' means the engine's working marker cleared and the pane held
 *  still; 'quiet' means a markerless engine (codex, shell) printed nothing for
 *  its stability window and gave no completion signal. Both end the turn.
 *  Never hangs indefinitely. */
export interface SendResult {
  status: 'done' | 'running' | 'quiet'
  report: string
  cursor: number
}

export interface ReadOptions {
  /** Byte/offset cursor from a previous SendResult/ReadResult; omit for 0. */
  cursor?: number
}

export interface ReadResult {
  text: string
  cursor: number
  idle: boolean
  /** Same split as SendResult: 'quiet' is idle without a completion signal.
   *  Optional because engines without a pane (hermes) do not report it yet. */
  state?: 'working' | 'done' | 'quiet'
  /** A harness engine's state read from its screen by its `states` rules (bridge/harness-detect.ts). */
  agentState?: 'working' | 'idle' | 'waiting_for_approval' | 'unknown'
  /** More log bytes follow this page: read again from `cursor` (idle stays false until the last page). */
  more?: boolean
}

/**
 * The one contract the router drives every session through, regardless of
 * engine. Required operations mirror the spec exactly; `attachHint` is a
 * Tandem-specific addition (every current tmux-hosted engine — claude/codex/
 * shell — has a human-actionable "how do I look at this" hint; hermes returns
 * a description string instead of a tmux command since there is no pane).
 */
export interface DrivableSession {
  readonly id: string
  readonly engine: EngineId
  readonly cwd: string
  isAlive(): Promise<boolean>
  isWorking(): Promise<boolean>
  send(text: string, options?: SendOptions): Promise<SendResult>
  read(options?: ReadOptions): Promise<ReadResult>
  interrupt(): Promise<void>
  close(): Promise<void>
  /** Human hint for watching/joining the session live (e.g. a tmux attach command). */
  attachHint(): string
}

/**
 * An engine descriptor: the pure, engine-specific matchers used to interpret a
 * tmux-hosted engine's terminal output, plus the spawn/readiness policy. Only
 * `claude`, `codex`, and `shell` use descriptors — `hermes` is not tmux-hosted
 * and has no descriptor.
 *
 * MARKERLESS ENGINES (binding — Phase 2 correction B): `isWorking`/`isReady`
 * may be ABSENT. "Fail conservatively" means avoid false completion, not
 * "never falsely report running" — at the bounded soft cap, uncertainty always
 * resolves to `status:"running"`, never a guessed `"done"`. When a descriptor
 * has no marker, completion/readiness is decided PURELY by pane stability (see
 * terminal-session.ts `stepStability`): the pane must be byte-stable for at
 * least `minStableMs` before a turn (or spawn warmup) is considered finished.
 * Changing output always resets the stability window, exactly like the
 * marker-based path.
 */
export interface EngineDescriptor {
  readonly id: EngineId
  /** The binary tmux spawns inside the pane. Absent = spawn the pane's default
   *  login shell instead of a named executable (shell engine only). */
  readonly executable?: string
  /** The full argv tmux runs, used verbatim when set (a harness engine). Never one command
   *  string (decision D7): it starts `/usr/bin/env --`, so tmux gets 3+ arguments and no `sh -c`. */
  readonly argv?: readonly string[]
  /** True while pane text indicates a turn is actively running. Absent =
   *  markerless — working/idle is inferred purely from pane-stability. */
  isWorking?(paneText: string): boolean
  /** True once pane text indicates the engine reached its idle/ready prompt.
   *  Absent = markerless — readiness is inferred from pane-stability too. */
  isReady?(paneText: string): boolean
  /** For markerless engines only: a single literal line submitted once right
   *  after spawn (before waiting for stability) to force one harmless prompt
   *  cycle past any startup banner/MOTD, so the FIRST stable read is the real
   *  idle prompt rather than a banner that merely paused mid-render. */
  readonly warmupPrompt?: string
  /** Minimum duration (ms) the pane must be byte-stable before a markerless
   *  engine's turn (or spawn warmup) is considered done/ready. Also applies to
   *  marker-based engines as the stability window AFTER the marker clears, so
   *  every descriptor states its policy explicitly rather than a raw poll
   *  count. Phase 2 correction B floors: codex >= 5000, shell >= 1500. */
  readonly minStableMs: number
  /** First-run dialogs warmup may answer: a harness file's `[[dialogs]]` rows (harnesses/SCHEMA.md).
   *  Absent = none: warmup answers no dialog. */
  readonly dialogs?: readonly {
    readonly name: string
    readonly kind: 'trust' | 'update' | 'bypass'
    readonly match: readonly string[]
    readonly answer: string
    readonly highlight?: '❯' | '›' | '>'
    readonly key?: string
  }[]
}

/** Mirrors terminal-session.ts's WORKING_MARKER / ready-prompt checks exactly —
 *  kept here as pure, independently testable functions per the engine contract.
 *  minStableMs=2250 (3 * the 750ms poll interval) preserves Phase 1's exact
 *  IDLE_STABLE_POLLS=3 behavior. */
export const CLAUDE_DESCRIPTOR: EngineDescriptor = {
  id: 'claude',
  executable: 'claude',
  isWorking: (paneText: string) => paneText.includes('esc to interrupt'),
  isReady: (paneText: string) => paneText.includes('❯'),
  minStableMs: 2250,
}

/**
 * Codex has no proven, stable footer marker to key off — inventing one would
 * risk a false "done" the moment Codex's real UI changes. Working/idle is
 * decided ENTIRELY by pane stability (binding — Phase 2 correction B): a turn
 * is done only once the pane has been byte-stable for >= 5s, conservative
 * enough that a brief lull between tool calls doesn't read as completion.
 */
export const CODEX_DESCRIPTOR: EngineDescriptor = {
  id: 'codex',
  executable: 'codex',
  minStableMs: 5000,
}

/**
 * Shell has no fixed prompt string (PS1 varies per user/shell/theme), so it is
 * markerless like Codex, with a shorter conservative stability window (>= 1.5s)
 * since ordinary commands return fast and a long wait would make simple shell
 * turns feel broken. `warmupPrompt` sends a harmless POSIX no-op once at spawn
 * so warmup settles past any MOTD banner before judging stability.
 */
export const SHELL_DESCRIPTOR: EngineDescriptor = {
  id: 'shell',
  warmupPrompt: ':',
  minStableMs: 1500,
}
