/**
 * engines/terminal-adapter.ts — the ONE reusable DrivableSession adapter every
 * tmux-hosted engine (claude/codex/shell) binds to. Extracted from Phase 1's
 * Claude-only adapter (binding — Phase 2 outline: "Extract the current Claude
 * adapter's shared terminal contract behavior into one reusable terminal
 * adapter, then make thin Claude, Codex, and shell bindings with injectable
 * factories"). No engine-specific tmux/spawn behavior lives here — that stays
 * in terminal-session.ts, unchanged regardless of which descriptor drives it.
 *
 * TESTABILITY (binding — Phase 1 plan review amendment #6, still binding):
 * every constructor here takes a `TerminalSessionLike`-compatible dependency,
 * so contract tests inject a fake and never spawn a real tmux process.
 */
import type {
  DrivableSession,
  EngineId,
  ReadOptions,
  ReadResult,
  SendOptions,
  SendResult,
} from '../drivable.ts'

/** The subset of TerminalSession's public instance API the adapter depends on.
 *  A real TerminalSession satisfies this structurally — no adapter needed on
 *  the production path. Tests implement it directly with a fake. */
export interface TerminalSessionLike {
  readonly name: string
  readonly cwd: string
  readonly ready: boolean
  readonly readinessWarning: string | undefined
  attachHint(): string
  isAlive(): Promise<boolean>
  isCurrentlyWorking(): Promise<boolean>
  send(text: string): Promise<SendResult>
  readSince(cursor: number): Promise<ReadResult>
  applyControls(controls: { model?: string; effort?: string }): Promise<string[]>
  interrupt(): Promise<void>
  close(): Promise<void>
}

/**
 * Generic tmux-terminal-backed DrivableSession. `engine` is fixed per instance
 * (set by the thin per-engine subclass); model/effort overrides on send() are
 * ONLY meaningful for `claude` — every other engine REJECTS them rather than
 * silently ignoring them (binding — Phase 2 correction C).
 */
export class TerminalAdapterSession implements DrivableSession {
  readonly engine: EngineId
  private readonly terminal: TerminalSessionLike

  constructor(engine: EngineId, terminal: TerminalSessionLike) {
    this.engine = engine
    this.terminal = terminal
  }

  get id(): string {
    return this.terminal.name
  }

  get cwd(): string {
    return this.terminal.cwd
  }

  /** True once the TUI reached its prompt on spawn — a spawn diagnostic read
   *  directly off a freshly-spawned session, not part of the generic
   *  DrivableSession contract, but useful to every tmux-hosted engine alike. */
  get ready(): boolean {
    return this.terminal.ready
  }

  /** Human-actionable reason when NOT ready (see `ready`). */
  get readinessWarning(): string | undefined {
    return this.terminal.readinessWarning
  }

  attachHint(): string {
    return this.terminal.attachHint()
  }

  isAlive(): Promise<boolean> {
    return this.terminal.isAlive()
  }

  isWorking(): Promise<boolean> {
    return this.terminal.isCurrentlyWorking()
  }

  /** Applies per-turn model/effort overrides (Claude only) as an in-session
   *  slash preamble BEFORE the prompt, then sends. Any other engine REJECTS a
   *  request that sets either field (binding — Phase 2 correction C: "no
   *  silent option loss"). */
  async send(text: string, options?: SendOptions): Promise<SendResult> {
    if (options?.model !== undefined || options?.effort !== undefined) {
      if (this.engine !== 'claude') {
        throw new Error(`model/effort are Claude-only options; not supported for engine "${this.engine}"`)
      }
      await this.terminal.applyControls({ model: options.model, effort: options.effort })
    }
    return this.terminal.send(text)
  }

  read(options?: ReadOptions): Promise<ReadResult> {
    return this.terminal.readSince(options?.cursor ?? 0)
  }

  interrupt(): Promise<void> {
    return this.terminal.interrupt()
  }

  close(): Promise<void> {
    return this.terminal.close()
  }
}
