/**
 * engine-registry.ts — which engines are known, which are enabled, and whether
 * an enabled engine's executable is actually present (binding — Phase 2 outline:
 * "strict known-id parsing, Claude-only default, explicit opt-in for other
 * engines, injectable executable detection, typed disabled/unavailable errors,
 * engine resolver, and capability report").
 *
 * ENGINE BOUNDARY (spec "Safety defaults"): `claude` is enabled unconditionally
 * — it is the sole DEFAULT engine and cannot be disabled via config in this MVP.
 * `codex`, `shell`, and `hermes` are disabled unless explicitly named in
 * TANDEM_ENABLED_ENGINES (comma- or colon-separated).
 *
 * ORDERING (binding — Phase 2 correction E): the router MUST resolve enablement
 * and executable availability BEFORE cwd resolution, tmux lookup, spawn, or any
 * network side effect — resolveEngine() below does only that: no filesystem
 * access beyond an executable-presence check (injectable, so tests never shell
 * out to a real `which`), no tmux, no network.
 *
 * `claude` keeps its built-in NAME (here, in fleet routing, on by default) but
 * runs from its built-in harness file, harnesses/claude.toml, through the one
 * harness engine (engines/harness-engine.ts).
 *
 * `claude` is exempt from the executable-presence check: Phase 1 never
 * preflighted it (a missing `claude` binary surfaces at spawn/warmup, exactly
 * as before), and unlike codex — a genuinely new, opt-in engine — adding a real
 * `which claude` subprocess call to the hot path of EVERY open_session
 * (including reusing an already-live session) would be both a needless
 * regression risk in production and a source of environment-dependent flake in
 * tests. codex/shell/hermes have no such Phase 1 baseline to preserve.
 * ponytail: U-R1A-13 drops this exemption.
 */
import { execFile } from 'node:child_process'
import {
  CODEX_DESCRIPTOR,
  SHELL_DESCRIPTOR,
  type BuiltinEngineId,
  type EngineDescriptor,
  type EngineId,
} from './drivable.ts'
import { loadHarnesses, type Harness } from './harness-registry.ts'

export const KNOWN_ENGINE_IDS: readonly BuiltinEngineId[] = ['claude', 'codex', 'shell', 'hermes']

export function isBuiltinEngine(id: string): id is BuiltinEngineId {
  return (KNOWN_ENGINE_IDS as readonly string[]).includes(id)
}

let harnessCache: Map<string, Harness> | undefined

/**
 * The loaded harness files by name (harnesses/SCHEMA.md), read once per process. Each refused
 * file writes one stderr line. The built-in claude file stays (claude runs from it; an owner
 * claude.toml is refused by the loader). A file named codex, shell or hermes is skipped with a
 * stderr line: those three keep their code engines until U-R1A-12/13/16.
 */
export function loadedHarnesses(): Map<string, Harness> {
  if (harnessCache) return harnessCache
  const { harnesses, errors } = loadHarnesses()
  for (const e of errors) process.stderr.write(`[bridge] harness file refused: ${e.file}: ${e.reason}\n`)
  for (const [name, h] of harnesses) {
    if (!isBuiltinEngine(name) || (name === 'claude' && h.source === 'builtin')) continue
    harnesses.delete(name)
    process.stderr.write(`[bridge] harness file skipped: ${h.file}: "${name}" keeps its built-in engine\n`)
  }
  harnessCache = harnesses
  return harnesses
}

/** Tests: the next loadedHarnesses() reads the files again. */
export function resetHarnessCache(): void {
  harnessCache = undefined
}

/** Code engines' tmux descriptors, keyed by id. `claude` runs from its harness
 *  file instead; `hermes` has none — it is not tmux-hosted (see engines/hermes.ts). */
const TMUX_DESCRIPTORS: Partial<Record<BuiltinEngineId, EngineDescriptor>> = {
  codex: CODEX_DESCRIPTOR,
  shell: SHELL_DESCRIPTOR,
}

/** Thrown when a caller-supplied engine id isn't one of KNOWN_ENGINE_IDS. */
export class UnknownEngineError extends Error {}

/** Thrown when a known engine id was not explicitly enabled. */
export class EngineDisabledError extends Error {}

/** Thrown when an enabled engine's required executable was not found. */
export class EngineUnavailableError extends Error {}

/** Strict known-id parsing: case-insensitive match against KNOWN_ENGINE_IDS,
 *  otherwise a clear UnknownEngineError (never a silent fallback to claude). */
export function parseEngineId(value: string): BuiltinEngineId {
  const v = value.trim().toLowerCase()
  if (isBuiltinEngine(v)) return v
  throw new UnknownEngineError(`unknown engine: "${value}". Supported engines: ${KNOWN_ENGINE_IDS.join(', ')}.`)
}

/** Parse TANDEM_ENABLED_ENGINES into the explicit opt-in set of BUILT-IN engines
 *  (fleet frames and capabilityReport carry only these). `claude` is
 *  ALWAYS included — it is the sole default-enabled engine and this MVP has no
 *  mechanism to disable it. Unset/blank enables no other engine. An entry that
 *  names a loaded harness file is skipped here (resolveEngine reads it). */
export function buildEnabledEngines(envValue = process.env.TANDEM_ENABLED_ENGINES): Set<BuiltinEngineId> {
  const enabled = new Set<BuiltinEngineId>(['claude'])
  if (!envValue?.trim()) return enabled
  for (const raw of envValue.split(/[,:]/)) {
    const t = raw.trim()
    if (!t) continue
    if (!isBuiltinEngine(t.toLowerCase()) && loadedHarnesses().has(t.toLowerCase())) continue
    enabled.add(parseEngineId(t))
  }
  return enabled
}

/** buildEnabledEngines plus the loaded harness names TANDEM_ENABLED_ENGINES lists. */
export function enabledEngineIds(envValue = process.env.TANDEM_ENABLED_ENGINES): Set<EngineId> {
  const enabled = new Set<EngineId>(buildEnabledEngines(envValue))
  for (const raw of (envValue ?? '').split(/[,:]/)) {
    const t = raw.trim().toLowerCase()
    if (loadedHarnesses().has(t)) enabled.add(t)
  }
  return enabled
}

/** Injectable executable-presence check — tests supply a fake so the registry
 *  never shells out to a real `which` (binding — Phase 2 correction G:
 *  automated tests may not launch a real engine executable). */
export type ExecutableDetector = (executable: string) => Promise<boolean>

/** Default detector: `which <bin>` succeeds iff the binary resolves on PATH.
 *  macOS/Linux only, matching the rest of this repo's setup assumptions. */
export const detectExecutableOnPath: ExecutableDetector = (executable) =>
  new Promise((resolve) => {
    execFile('which', [executable], (error) => resolve(!error))
  })

export interface ResolveEngineOptions {
  enabledEngines?: Set<EngineId>
  detectExecutable?: ExecutableDetector
}

export interface EngineResolution {
  readonly id: EngineId
  /** Present for the code tmux engines (codex/shell); absent for hermes and harness engines. */
  readonly descriptor?: EngineDescriptor
  /** Present for a harness engine, claude included (bridge/engines/harness-engine.ts builds its descriptor). */
  readonly harness?: Harness
}

/**
 * Resolve and validate a caller-supplied engine id (or `undefined` → "claude", its built-in harness file).
 * Order: parse → enabled → executable-available. Throws typed errors on the
 * FIRST failing check and does nothing else — no cwd/tmux/network access, so
 * the router can call this before any side effect (binding — Phase 2
 * correction E). A loaded harness name needs its name enabled, and `shell` too
 * when its program is a shell (kind = shell); no programPath is unavailable.
 */
export async function resolveEngine(
  rawId: string | undefined,
  opts: ResolveEngineOptions = {},
): Promise<EngineResolution> {
  const name = (rawId ?? '').trim().toLowerCase()
  const harness = name && !isBuiltinEngine(name) ? loadedHarnesses().get(name) : undefined
  if (harness) {
    const enabled = opts.enabledEngines ?? enabledEngineIds()
    if (!enabled.has(name)) {
      throw new EngineDisabledError(`engine "${name}" is disabled. Enable it by adding it to TANDEM_ENABLED_ENGINES.`)
    }
    if (harness.kind === 'shell' && !enabled.has('shell')) {
      throw new EngineDisabledError(
        `engine "${name}" runs a shell or interpreter, so it also needs "shell" in TANDEM_ENABLED_ENGINES.`,
      )
    }
    if (!harness.programPath) {
      throw new EngineUnavailableError(`engine "${name}" is enabled but its program "${harness.program}" was not found.`)
    }
    return { id: name, harness }
  }
  const id = rawId === undefined || rawId === '' ? 'claude' : parseEngineId(rawId)
  const enabled = opts.enabledEngines ?? buildEnabledEngines()
  if (!enabled.has(id)) {
    throw new EngineDisabledError(
      `engine "${id}" is disabled. Enable it by adding it to TANDEM_ENABLED_ENGINES.`,
    )
  }
  if (id === 'claude') {
    // No presence check (see the module doc); a missing claude starts `/usr/bin/env -- claude` and fails at spawn.
    const claude = loadedHarnesses().get('claude')
    if (!claude) throw new EngineUnavailableError('engine "claude" is enabled but its built-in harness file harnesses/claude.toml did not load.')
    return { id, harness: claude }
  }
  const descriptor = TMUX_DESCRIPTORS[id]
  if (descriptor?.executable) {
    const detect = opts.detectExecutable ?? detectExecutableOnPath
    const available = await detect(descriptor.executable)
    if (!available) {
      throw new EngineUnavailableError(
        `engine "${id}" is enabled but its executable "${descriptor.executable}" was not found on PATH.`,
      )
    }
  }
  return { id, descriptor }
}

export interface EngineCapability {
  engine: EngineId
  enabled: boolean
  /** False when disabled. When enabled: false only if a required executable is
   *  missing (codex); always true when enabled for claude (exempt — see the
   *  module doc comment), shell (no fixed executable), and hermes (availability
   *  is a runtime loopback/config concern handled by its own adapter, not this
   *  registry). */
  available: boolean
}

/** Capability report across every known engine — used by device registration
 *  (Phase 3) and useful standalone for diagnostics today. Never throws; an
 *  unavailable/disabled engine is just reported as such. */
export async function capabilityReport(opts: ResolveEngineOptions = {}): Promise<EngineCapability[]> {
  const enabled = opts.enabledEngines ?? buildEnabledEngines()
  const detect = opts.detectExecutable ?? detectExecutableOnPath
  const out: EngineCapability[] = []
  for (const id of KNOWN_ENGINE_IDS) {
    const isEnabled = enabled.has(id)
    let available = false
    if (isEnabled) {
      const descriptor = TMUX_DESCRIPTORS[id]
      available = descriptor?.executable ? await detect(descriptor.executable) : true
    }
    out.push({ engine: id, enabled: isEnabled, available })
  }
  return out
}
