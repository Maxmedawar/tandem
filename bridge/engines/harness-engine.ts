/**
 * engines/harness-engine.ts — the one engine that runs any CLI agent from its harness file
 * (harnesses/SCHEMA.md), the built-in claude, codex and shell files included. A thin binding of
 * the shared TerminalAdapterSession (./terminal-adapter.ts): the file gives the argv, the screen
 * rules and the interrupt keys, so a new agent is one file and no code.
 *
 * Gates (enabled, `shell` for a shell program, program found) live in engine-registry.ts;
 * model/effort/bypass stay Claude-only and are refused, never ignored.
 */
import { clearTurn, installHook, removeHook, turnState } from '../delivery-hooks.ts'
import type { EngineDescriptor, ReadOptions, ReadResult } from '../drivable.ts'
import { createStateReader, isPromptEmpty, readScreen, type ReadState } from '../harness-detect.ts'
import type { Harness } from '../harness-registry.ts'
import { spawnArgv, TerminalSession, type DialogAnswers, type SpawnOptions as TerminalSpawnOptions } from '../terminal-session.ts'
import { TerminalAdapterSession, type TerminalSessionLike } from './terminal-adapter.ts'

/** A terminal that can also show its current screen. */
export type HarnessTerminal = TerminalSessionLike & { screen(): Promise<string> }

export interface HarnessSpawnOptions {
  name: string
  cwd: string
  allowlist: string[]
  /** Claude only (the harness named `claude`); any other harness refuses them. */
  model?: string
  effort?: string
  allowBypass?: boolean
  /** Append the file's `skip_prompts_args`: the router sets it only when the real cwd is in a
   *  limits-file `permission_skip` folder (bridge/limits.ts). */
  skipPrompts?: boolean
  /** Which of the file's `[[dialogs]]` warmup may answer (terminal-session.ts SpawnOptions); absent = `none`. */
  dialogAnswers?: DialogAnswers
}

/**
 * The descriptor a harness file makes. argv is `/usr/bin/env -- <programPath> ...args`, so
 * tmux always gets 3+ arguments and never runs `sh -c` (decision D7); no program found throws
 * (the registry answers 503 before this runs). With an `idle` rule the screen rules say ready
 * and working; without one the agent is markerless, so its turns end `quiet` once the screen
 * holds still for `states.debounce_ms` (5000 ms when the file has no `states` table).
 * With `skipPrompts` the file's `skip_prompts_args` follow its args. The file's `[[dialogs]]` rows
 * ride along for warmup.
 */
export function harnessDescriptor(h: Harness, opts: { skipPrompts?: boolean } = {}): EngineDescriptor {
  if (!h.programPath) throw new Error(`harness "${h.name}": program "${h.program}" was not found`)
  const argv = ['/usr/bin/env', '--', h.programPath, ...h.args, ...(opts.skipPrompts ? h.skip_prompts_args : [])]
  const minStableMs = h.states?.debounce_ms ?? 5000
  const dialogs = h.dialogs ? { dialogs: h.dialogs } : {}
  if (h.states?.idle?.length) {
    return {
      id: h.name,
      argv,
      isReady: (pane: string) => readScreen(h, pane) === 'idle',
      isWorking: (pane: string) => readScreen(h, pane) !== 'idle',
      minStableMs,
      ...dialogs,
    }
  }
  return { id: h.name, argv, minStableMs, ...dialogs }
}

export class HarnessSession extends TerminalAdapterSession {
  private readonly harness: Harness
  private readonly screenSource: HarnessTerminal
  private readonly reader: ReturnType<typeof createStateReader>
  private readonly interruptKeys: readonly string[] | undefined

  constructor(harness: Harness, terminal: HarnessTerminal) {
    super(harness.name, terminal)
    this.harness = harness
    this.screenSource = terminal
    this.reader = createStateReader(harness)
    const keys = harness.keys?.interrupt
    this.interruptKeys = typeof keys === 'string' ? [keys] : keys
  }

  /** The file's `keys.interrupt` when set, else the terminal's default (Escape, then C-c); a hook agent's turn file then goes. */
  async interrupt(): Promise<void> {
    await this.screenSource.interrupt(this.interruptKeys)
    if (this.harness.delivery === 'hook') clearTurn(this.id)
  }

  /**
   * The input gate's read (bridge/input-gate.ts): ONE screen capture, its state by the file's
   * rules with no debounce, and the file's `states.debounce_ms` (0 without `states`). Not the
   * debounced `reader`: its last value can carry an old idle across a screen it never saw.
   * A hook agent's idle screen reads working while its hooks say the turn is still going
   * (bridge/delivery-hooks.ts): an agent may show no marker while it streams a reply.
   */
  async inputState(): Promise<{ state: ReadState; screen: string; debounceMs: number }> {
    const screen = await this.screenSource.screen()
    let state = readScreen(this.harness, screen)
    if (state === 'idle' && this.harness.delivery === 'hook' && turnState(this.id) === 'working') state = 'working'
    return { state, screen, debounceMs: this.harness.states?.debounce_ms ?? 0 }
  }

  /** The input gate's empty-prompt check (bridge/input-gate.ts): the file's states.empty_prompt, else the code rule. */
  promptEmpty(screen: string): boolean {
    return isPromptEmpty(this.harness, screen)
  }

  /** How mail reaches this session (bridge/delivery-notice.ts): the file's `delivery`; a shell never gets mail typed. */
  deliveryClass(): 'hook' | 'notice' | 'none' {
    return this.harness.kind === 'shell' ? 'none' : this.harness.delivery
  }

  /** Closes the terminal, then removes a hook agent's delivery files. */
  async close(): Promise<void> {
    await super.close()
    if (this.harness.delivery === 'hook') {
      try { removeHook(this.id) } catch { /* the files go with the next start of this name */ }
    }
  }

  /** The terminal page plus `agentState`, read from the current screen by the file's rules. */
  async read(options?: ReadOptions): Promise<ReadResult> {
    const page = await super.read(options)
    return { ...page, agentState: this.reader.observe(await this.screenSource.screen()) }
  }

  static async spawn(
    harness: Harness,
    opts: HarnessSpawnOptions,
    spawnFn: (opts: TerminalSpawnOptions) => Promise<HarnessTerminal> = TerminalSession.spawn,
  ): Promise<HarnessSession> {
    let descriptor = harnessDescriptor(harness, opts)
    spawnArgv(descriptor, opts) // a refused or bad flag throws before anything starts
    // A hook agent gets its own settings file (spawn only: adoption writes nothing).
    if (harness.delivery === 'hook') descriptor = { ...descriptor, argv: [...(descriptor.argv ?? []), ...installHook(harness, opts.name)] }
    return new HarnessSession(harness, await spawnFn({ ...opts, descriptor }))
  }

  static async attachExisting(
    harness: Harness,
    name: string,
    allowlist: string[],
    attachFn: (name: string, allowlist: string[]) => Promise<HarnessTerminal | undefined> = (n, a) =>
      TerminalSession.attachExisting(n, a, harnessDescriptor(harness)),
  ): Promise<HarnessSession | undefined> {
    const terminal = await attachFn(name, allowlist)
    return terminal ? new HarnessSession(harness, terminal) : undefined
  }

  static async exists(name: string, existsFn: (name: string) => Promise<boolean> = TerminalSession.exists): Promise<boolean> {
    return existsFn(name)
  }
}
