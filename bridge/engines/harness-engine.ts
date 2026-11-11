/**
 * engines/harness-engine.ts — the one engine that runs any CLI agent from its harness file
 * (harnesses/SCHEMA.md). A thin binding of the shared TerminalAdapterSession
 * (./terminal-adapter.ts), like engines/shell.ts: the file gives the argv and the screen
 * rules, so a new agent is one file and no code.
 *
 * Gates (enabled, `shell` for a shell program, program found) live in engine-registry.ts;
 * model/effort/bypass stay Claude-only and are refused, never ignored.
 */
import type { EngineDescriptor, ReadOptions, ReadResult } from '../drivable.ts'
import { createStateReader, readScreen } from '../harness-detect.ts'
import type { Harness } from '../harness-registry.ts'
import { TerminalSession, type SpawnOptions as TerminalSpawnOptions } from '../terminal-session.ts'
import { TerminalAdapterSession, type TerminalSessionLike } from './terminal-adapter.ts'

/** A terminal that can also show its current screen. */
export type HarnessTerminal = TerminalSessionLike & { screen(): Promise<string> }

export interface HarnessSpawnOptions {
  name: string
  cwd: string
  allowlist: string[]
}

/**
 * The descriptor a harness file makes. argv is `/usr/bin/env -- <programPath> ...args`, so
 * tmux always gets 3+ arguments and never runs `sh -c` (decision D7). With an `idle` rule the
 * screen rules say ready and working; without one the agent is markerless (5000 ms), so its
 * turns end `quiet`.
 */
export function harnessDescriptor(h: Harness): EngineDescriptor {
  if (!h.programPath) throw new Error(`harness "${h.name}": program "${h.program}" was not found`)
  const argv = ['/usr/bin/env', '--', h.programPath, ...h.args]
  if (h.states?.idle?.length) {
    return {
      id: h.name,
      argv,
      isReady: (pane: string) => readScreen(h, pane) === 'idle',
      isWorking: (pane: string) => readScreen(h, pane) !== 'idle',
      minStableMs: h.states.debounce_ms,
    }
  }
  return { id: h.name, argv, minStableMs: 5000 }
}

export class HarnessSession extends TerminalAdapterSession {
  private readonly screenSource: HarnessTerminal
  private readonly reader: ReturnType<typeof createStateReader>

  constructor(harness: Harness, terminal: HarnessTerminal) {
    super(harness.name, terminal)
    this.screenSource = terminal
    this.reader = createStateReader(harness)
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
    return new HarnessSession(harness, await spawnFn({ ...opts, descriptor: harnessDescriptor(harness) }))
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
