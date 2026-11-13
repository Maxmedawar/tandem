/**
 * sessions.ts — the live DrivableSession registry, live-session listing, and
 * the cwd-allowlist security helpers (the trust boundary the reviewer scrutinizes).
 *
 * A "session" is an interactive harness-file agent TUI running in a tmux
 * session named "ccm-<name>", or an agent attached through the adapter its
 * built-in harness file names (Hermes; not tmux-hosted). listSessions()
 * reports ONLY sessions Tandem currently OWNS and can safely address
 * (binding — Phase 2 correction E): live ccm-* tmux sessions whose
 * `@tandem_engine`/`@tandem_owner` provenance tags match THIS installation (see ./ownership.ts and ./terminal-session.ts
 * readSessionProvenance), each tagged with its engine. A tmux session with
 * missing or mismatched provenance is NEVER listed as drivable, even if its
 * name matches the ccm-* prefix. There is no history surface: Tandem does not
 * scan or report ~/.claude/projects (or any other engine's local history) —
 * doing so would leak past prompts/paths this process never owned or created.
 *
 * The allowlist helpers (buildAllowlist / isCwdAllowed) are exported here and
 * consumed by bridge/index.ts and bridge/relay.ts. Rules (SECURITY):
 *   - realpath-canonicalize candidate + roots before comparing (defeats symlink
 *     and `..` escapes).
 *   - compare by the volume's own spelling (volumePath, realpath(3)): on a case-insensitive volume
 *     a case variant is the same folder, on a case-sensitive one a different one; nothing lower-cases.
 *   - no implicit roots: CCM_CWD_ALLOWLIST must explicitly name every allowed
 *     root and an unset/blank value fails closed.
 *   - prefix match uses a TRAILING SEPARATOR so "/srv/code" does not match
 *     "/srv/code-evil" (prefix-confusion guard).
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { TmuxBusyError, type DrivableSession, type EngineId } from './drivable.ts'
import { enabledEngineIds, loadedHarnesses } from './engine-registry.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'
import { attachCommand, readSessionProvenance, tmux, TMUX_FIELD_SEP } from './terminal-session.ts'

const HOME = homedir()
const SESSION_PREFIX = 'ccm-'

/** A tmux engine tag is valid provenance when it names a loaded harness file without `adapter`
 *  (the built-in claude, codex and shell files included). An adapter agent is never tmux-hosted,
 *  so a tmux session tagged with an adapter file's name is never valid provenance. */
function isTmuxEngineTag(tag: string): boolean {
  const harness = loadedHarnesses().get(tag)
  return harness !== undefined && harness.adapter === undefined
}

const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/
const RELAY_NAME_RE = /^relay-/

export interface SessionInfo {
  /** session name, without the ccm- prefix. */
  id: string
  engine: EngineId
  project: string
  cwd: string
  live: boolean
  updatedAt: number
  /** how the owner attaches to watch/type (a tmux attach command). */
  attachHint: string
}

// ---- allowlist (the security boundary) ------------------------------------

/**
 * Resolve to an absolute, symlink-canonical path. For a path that doesn't yet
 * exist, realpath the deepest existing ancestor and re-append the rest, so a
 * not-yet-created child of an allowlisted (possibly symlinked) root still
 * canonicalizes under that root.
 */
export function safeResolve(p: string, home = HOME): string {
  let abs = resolve(p.replace(/^~(?=$|\/)/, home))
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(abs)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(abs)
      if (parent === abs) return tail.length ? join(abs, ...tail.reverse()) : abs
      // basename/dirname handle the filesystem root correctly. Slicing by
      // `parent.length + 1` turned `/allowed` into `llowed` because `/` already
      // contains the separator.
      tail.push(basename(abs))
      abs = parent
    }
  }
}

/**
 * safeResolve, then the spelling the volume itself holds for the part that exists (realpath(3)), the
 * rest re-appended: the same algorithm as bridge/limits.ts `real()` (copied: limits.ts imports this
 * file). So the volume's case rules decide whether two spellings are one folder.
 */
export function volumePath(p: string, home = HOME): string {
  let abs = safeResolve(p, home)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(abs), ...tail.reverse())
    } catch {
      const parent = dirname(abs)
      if (parent === abs) return join(abs, ...tail.reverse())
      tail.push(basename(abs))
      abs = parent
    }
  }
}

/** Build only explicit allowlist roots. Missing or blank configuration fails closed. */
export function buildAllowlist(
  envValue = process.env.CCM_CWD_ALLOWLIST,
  home = HOME,
): string[] {
  if (!envValue?.trim()) return []
  return envValue
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => volumePath(p, home))
}

/** True if `candidate` resolves to an allowlisted root or a descendant of one.
 *  Prefix comparison uses a trailing separator so "/srv/code" does NOT match
 *  "/srv/code-evil". */
export function isCwdAllowed(candidate: string, allowlist: string[]): boolean {
  let real: string
  try {
    real = volumePath(candidate)
  } catch {
    return false
  }
  for (const root of allowlist) {
    if (real === root) return true
    const prefix = root.endsWith(sep) ? root : root + sep
    if (real.startsWith(prefix)) return true
  }
  return false
}

// ---- live DrivableSession registry -----------------------------------------
// Stores the generic DrivableSession contract, not a raw TerminalSession or an
// adapter constructed on demand (binding — Phase 1 plan review amendment #2).

const registry = new Map<string, DrivableSession>()

export function getLive(name: string): DrivableSession | undefined {
  return registry.get(name)
}

export function registerLive(session: DrivableSession): void {
  registry.set(session.id, session)
}

export function unregisterLive(name: string): void {
  registry.delete(name)
}

export function liveSessionNames(): string[] {
  return [...registry.keys()]
}

// ---- tmux live listing (provenance-checked) --------------------------------
// tmux runs through terminal-session.ts's one runner, on Tandem's own socket.

export interface LiveListingDependencies {
  ownerIdProvider?: OwnerIdProvider
  tmuxFn?: (args: string[]) => Promise<string>
  provenanceReader?: (name: string) => Promise<{ engine: string; owner: string }>
}

interface LiveTmuxSession {
  name: string // without prefix
  target: string // ccm-<name>
  engine: EngineId
  cwd: string
  createdAt: number
}

/**
 * Enumerate live ccm-* tmux sessions THIS installation actually owns and can
 * safely address. A raw `ccm-*` tmux session name is not sufficient proof —
 * anyone on the same OS user account could hand-create one (see
 * ./ownership.ts). A session is only included when its `@tandem_engine` tag is
 * the name of a loaded harness file without `adapter` AND its `@tandem_owner` tag exactly matches
 * this installation's durable owner id (binding — Phase 2 correction E:
 * "Missing/mismatched tmux provenance must never appear as drivable").
 */
export async function listLiveTmuxSessions(
  deps: LiveListingDependencies = {},
): Promise<LiveTmuxSession[]> {
  const ownerIdProvider = deps.ownerIdProvider ?? makeOwnerIdProvider()
  const tmuxFn = deps.tmuxFn ?? tmux
  const provenanceReader = deps.provenanceReader ?? readSessionProvenance
  let raw: string
  try {
    // A newline inside a folder name becomes `_` (tmux substitutes it), so a cwd cannot start a second row.
    raw = await tmuxFn(['list-sessions', '-F', ['#{session_name}', '#{session_created}', '#{s/\n/_/:pane_current_path}'].join(TMUX_FIELD_SEP)])
  } catch (e) {
    // U-R1A-19B: a passing failure is not "no sessions". No server, a refused socket folder, a too-long
    // path or no tmux program list nothing, as before.
    if (e instanceof TmuxBusyError) throw e
    return []
  }
  const candidates: { name: string; created: string; cwd: string }[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // The cwd is last and takes the rest of the line (a folder name may hold the separator).
    const parts = line.split(TMUX_FIELD_SEP)
    if (parts.length < 3) continue
    const [name, created] = parts
    const cwd = parts.slice(2).join(TMUX_FIELD_SEP)
    if (!name || !name.startsWith(SESSION_PREFIX)) continue
    const bareName = name.slice(SESSION_PREFIX.length)
    if (!SESSION_NAME_RE.test(bareName) || RELAY_NAME_RE.test(bareName)) continue
    candidates.push({ name: bareName, created, cwd })
  }
  if (candidates.length === 0) return []

  const expectedOwner = await ownerIdProvider()
  const out: LiveTmuxSession[] = []
  for (const c of candidates) {
    const provenance = await provenanceReader(c.name)
    if (!provenance.owner || provenance.owner !== expectedOwner) continue
    if (!isTmuxEngineTag(provenance.engine)) continue
    out.push({
      name: c.name,
      target: SESSION_PREFIX + c.name,
      engine: provenance.engine as EngineId,
      cwd: c.cwd || HOME,
      createdAt: Number(c.created) * 1000 || Date.now(),
    })
  }
  return out
}

// ---- listing ----------------------------------------------------------------

/**
 * List sessions for the MCP `list_sessions` tool: LIVE, provenance-verified
 * ccm-* tmux sessions ONLY (with attach hint and engine). No history, no
 * sessions Tandem did not create. Sorted newest first, limited. Never throws for a tmux reason
 * (U-R1A-19B): a passing failure of the list or of a registered session's probe adds `tmuxBusy: true`,
 * and a registered session whose probe failed that way is kept (a passing failure hides nothing).
 */
export async function listSessions(
  opts: {
    limit?: number
    project?: string
    allowlist?: string[]
    enabledEngines?: Set<EngineId>
    listingDependencies?: LiveListingDependencies
  } = {},
): Promise<{ sessions: SessionInfo[]; tmuxBusy?: true }> {
  const limit = opts.limit ?? 20
  const allowlist = opts.allowlist ?? buildAllowlist()
  // Built-ins plus the enabled harness names, so harness sessions list (U-R1A-11).
  const enabledEngines = opts.enabledEngines ?? enabledEngineIds()
  let tmuxBusy = false
  let live: LiveTmuxSession[] = []
  try {
    live = await listLiveTmuxSessions(opts.listingDependencies)
  } catch (e) {
    if (!(e instanceof TmuxBusyError)) throw e
    tmuxBusy = true
  }

  // Registry entries are sessions this running bridge already admitted. This
  // is also the only source for adapter agents (Hermes), which have no tmux
  // inventory and are deliberately never discovered by listing a gateway or
  // personal files. An adapter session has cwd '' and is labelled by its engine.
  const registered = (
    await Promise.all(
      [...registry.values()].map(async (session) => ({
        session,
        alive: await session.isAlive().catch((e) => {
          if (!(e instanceof TmuxBusyError)) return false
          tmuxBusy = true
          return true
        }),
      })),
    )
  )
    .filter(({ session, alive }) => alive && enabledEngines.has(session.engine) && !RELAY_NAME_RE.test(session.id))
    .map(({ session }): SessionInfo => ({
      id: session.id,
      engine: session.engine,
      project: session.cwd === ''
        ? session.engine
        : session.cwd.split('/').filter(Boolean).pop() ?? session.cwd,
      cwd: session.cwd,
      live: true,
      updatedAt: Date.now(),
      attachHint: session.attachHint(),
    }))

  const registeredIds = new Set(registered.map((s) => s.id))
  const adoptedCandidates: SessionInfo[] = live
    .filter(
      (s) =>
        !registeredIds.has(s.name) &&
        enabledEngines.has(s.engine) &&
        isCwdAllowed(s.cwd, allowlist),
    )
    .map((s) => ({
      id: s.name,
      engine: s.engine,
      project: s.cwd.split('/').filter(Boolean).pop() ?? s.cwd,
      cwd: s.cwd,
      live: true,
      updatedAt: s.createdAt,
      attachHint: attachCommand(s.name),
    }))

  const all = [...registered, ...adoptedCandidates]

  const filtered = opts.project
    ? all.filter((s) => s.cwd.includes(opts.project as string) || s.project === opts.project)
    : all

  filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  const sessions = filtered.slice(0, limit)
  return tmuxBusy ? { sessions, tmuxBusy: true } : { sessions }
}
