/**
 * engine-registry.ts — which engines are known, which are enabled, and whether an enabled
 * engine can run: its program is present, or its file names an adapter.
 *
 * NO AGENT IS ON BY DEFAULT: an engine runs only when TANDEM_ENABLED_ENGINES (comma- or
 * colon-separated) names it, and an open must name its engine. Every agent runs from its harness
 * file (harnesses/SCHEMA.md), the built-in ones included: a terminal agent through the one harness
 * engine (engines/harness-engine.ts), needing the file's program on PATH (`programPath`); an
 * adapter agent through the adapter its built-in file names (ADAPTERS in harness-registry.ts),
 * with no program. The built-in ids keep their names here because fleet frames carry them; each
 * has a built-in file, and one whose file is not loaded is unavailable.
 *
 * ORDERING (binding — Phase 2 correction E): the router MUST resolve enablement and program
 * availability BEFORE cwd resolution, tmux lookup, spawn, or any network side effect —
 * resolveEngine() below does only that: the program lookup reads folders (never a subprocess),
 * no tmux, no network.
 */
import type { BuiltinEngineId, EngineId } from './drivable.ts'
import { loadHarnesses, type Harness } from './harness-registry.ts'

export const KNOWN_ENGINE_IDS: readonly BuiltinEngineId[] = ['claude', 'codex', 'shell', 'hermes']

export function isBuiltinEngine(id: string): id is BuiltinEngineId {
  return (KNOWN_ENGINE_IDS as readonly string[]).includes(id)
}

let harnessCache: Map<string, Harness> | undefined

/**
 * The loaded harness files by name (harnesses/SCHEMA.md), read once per process. Each refused
 * file writes one stderr line (an owner file named like a built-in is refused by the loader).
 */
export function loadedHarnesses(): Map<string, Harness> {
  if (harnessCache) return harnessCache
  const { harnesses, errors } = loadHarnesses()
  for (const e of errors) process.stderr.write(`[bridge] harness file refused: ${e.file}: ${e.reason}\n`)
  harnessCache = harnesses
  return harnesses
}

/** Tests: the next loadedHarnesses() reads the files again. */
export function resetHarnessCache(): void {
  harnessCache = undefined
}

/** Thrown when a caller-supplied engine id is missing or isn't known. */
export class UnknownEngineError extends Error {}

/** Thrown when a known engine id was not explicitly enabled. */
export class EngineDisabledError extends Error {}

/** Thrown when an enabled engine cannot run: its program was not found, or no file is loaded for it. */
export class EngineUnavailableError extends Error {}

/** Strict known-id parsing: case-insensitive match against KNOWN_ENGINE_IDS,
 *  otherwise a clear UnknownEngineError (never a silent fallback) naming the built-in ids and
 *  every loaded harness name, sorted, each once. */
export function parseEngineId(value: string): BuiltinEngineId {
  const v = value.trim().toLowerCase()
  if (isBuiltinEngine(v)) return v
  const names = [...new Set([...KNOWN_ENGINE_IDS, ...loadedHarnesses().keys()])].sort()
  throw new UnknownEngineError(`unknown engine: "${value}". Supported engines: ${names.join(', ')}.`)
}

/** Parse TANDEM_ENABLED_ENGINES into the explicit opt-in set of BUILT-IN engines (fleet frames
 *  and capabilityReport carry only these). Unset/blank enables nothing. An entry that names a
 *  loaded harness file is skipped here (enabledEngineIds reads it). */
export function buildEnabledEngines(envValue = process.env.TANDEM_ENABLED_ENGINES): Set<BuiltinEngineId> {
  const enabled = new Set<BuiltinEngineId>()
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

export interface ResolveEngineOptions {
  enabledEngines?: Set<EngineId>
}

export interface EngineResolution {
  readonly id: EngineId
  /** The harness file the engine runs from. */
  readonly harness: Harness
}

/**
 * Resolve and validate a caller-supplied engine id. Order: given → known → enabled → file loaded
 * → (an adapter file: done) → program found. Throws typed errors on the FIRST failing check and
 * does nothing else — no cwd/tmux/network access, so the router can call this before any side
 * effect (binding — Phase 2 correction E). A harness needs its name enabled; a terminal one also
 * `shell` when its program is a shell (kind = shell), and its `programPath`. An adapter file has
 * no program: its adapter makes its own checks when the router opens it.
 */
export async function resolveEngine(
  rawId: string | undefined,
  opts: ResolveEngineOptions = {},
): Promise<EngineResolution> {
  const enabled = opts.enabledEngines ?? enabledEngineIds()
  const name = (rawId ?? '').trim().toLowerCase()
  if (!name) {
    const names = [...enabled].sort()
    throw new UnknownEngineError(`engine is required. Enabled: ${names.length ? names.join(', ') : 'none'}`)
  }
  const harness = loadedHarnesses().get(name)
  if (!harness) parseEngineId(rawId!) // an unknown name throws here
  if (!enabled.has(name)) {
    throw new EngineDisabledError(`engine "${name}" is disabled. Enable it by adding it to TANDEM_ENABLED_ENGINES.`)
  }
  if (!harness) throw new EngineUnavailableError(`engine "${name}" has no harness file loaded`)
  if (harness.adapter !== undefined) return { id: name, harness }
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

export interface EngineCapability {
  engine: EngineId
  enabled: boolean
  /** Enabled, its built-in file loaded, and that file names an adapter or its program was found. */
  available: boolean
}

/** Capability report across every known engine — used by device registration (Phase 3) and
 *  useful standalone for diagnostics. Never throws; an unavailable/disabled engine is just
 *  reported as such. */
export async function capabilityReport(opts: ResolveEngineOptions = {}): Promise<EngineCapability[]> {
  const enabled = opts.enabledEngines ?? buildEnabledEngines()
  return KNOWN_ENGINE_IDS.map((id) => {
    const harness = loadedHarnesses().get(id)
    const available = enabled.has(id) && harness !== undefined && (harness.adapter !== undefined || harness.programPath !== undefined)
    return { engine: id, enabled: enabled.has(id), available }
  })
}
