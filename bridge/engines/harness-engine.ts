/**
 * engines/harness-engine.ts — the one engine that runs any CLI agent from its harness file
 * (harnesses/SCHEMA.md), the built-in claude, codex and shell files included. A thin binding of
 * the shared TerminalAdapterSession (./terminal-adapter.ts): the file gives the argv, the screen
 * rules and the interrupt keys, so a new agent is one file and no code.
 *
 * Gates (enabled, `shell` for a shell program, program found) live in engine-registry.ts;
 * model/effort/bypass stay Claude-only and are refused, never ignored.
 */
import type { EngineDescriptor, ReadOptions, ReadResult } from '../drivable.ts'
import { createStateReader, readScreen } from '../harness-detect.ts'
import type { Harness } from '../harness-registry.ts'
import { spawnArgv, TerminalSession, type SpawnOptions as TerminalSpawnOptions } from '../terminal-session.ts'
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
}

/**
 * The descriptor a harness file makes. argv is `/usr/bin/env -- <programPath> ...args`, so
 * tmux always gets 3+ arguments and never runs `sh -c` (decision D7); no program found throws
 * (the registry answers 503 before this runs). With an `idle` rule the screen rules say ready
 * and working; without one the agent is markerless, so its turns end `quiet` once the screen
 * holds still for `states.debounce_ms` (5000 ms when the file has no `states` table).
 * With `skipPrompts` the file's `skip_prompts_args` follow its args.
 */
export function harnessDescriptor(h: Harness, opts: { skipPrompts?: boolean } = {}): EngineDescriptor {
  if (!h.programPath) throw new Error(`harness "${h.name}": program "${h.program}" was not found`)
  const argv = ['/usr/bin/env', '--', h.programPath, ...h.args, ...(opts.skipPrompts ? h.skip_prompts_args : [])]
  const minStableMs = h.states?.debounce_ms ?? 5000
  if (h.states?.idle?.length) {
    return {
      id: h.name,
      argv,
      isReady: (pane: string) => readScreen(h, pane) === 'idle',
      isWorking: (pane: string) => readScreen(h, pane) !== 'idle',
      minStableMs,
    }
  }
  return { id: h.name, argv, minStableMs }
}

export class HarnessSession extends TerminalAdapterSession {
  private readonly screenSource: HarnessTerminal
  private readonly reader: ReturnType<typeof createStateReader>
  private readonly interruptKeys: readonly string[] | undefined

  constructor(harness: Harness, terminal: HarnessTerminal) {
    super(harness.name, terminal)
    this.screenSource = terminal
    this.reader = createStateReader(harness)
    const keys = harness.keys?.interrupt
    this.interruptKeys = typeof keys === 'string' ? [keys] : keys
  }

  /** The file's `keys.interrupt` when set, else the terminal's default (Escape, then C-c). */
  interrupt(): Promise<void> {
    return this.screenSource.interrupt(this.interruptKeys)
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
    const descriptor = harnessDescriptor(harness, opts)
    spawnArgv(descriptor, opts) // a refused or bad flag throws before anything starts
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
