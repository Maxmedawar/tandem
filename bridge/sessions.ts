/**
 * sessions.ts — the live DrivableSession registry, live-session listing, and
 * the cwd-allowlist security helpers (the trust boundary the reviewer scrutinizes).
 *
 * A "session" is an interactive engine (claude/codex/shell) TUI running in a
 * tmux session named "ccm-<name>", or an attached Hermes writable-agent id
 * (not tmux-hosted). listSessions() reports ONLY sessions Tandem currently
 * OWNS and can safely address (binding — Phase 2 correction E): live ccm-*
 * tmux sessions whose `@tandem_engine`/`@tandem_owner` provenance tags match
 * THIS installation (see ./ownership.ts and ./terminal-session.ts
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
 *   - no implicit roots: CCM_CWD_ALLOWLIST must explicitly name every allowed
 *     root and an unset/blank value fails closed.
 *   - prefix match uses a TRAILING SEPARATOR so "/srv/code" does not match
 *     "/srv/code-evil" (prefix-confusion guard).
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { DrivableSession, EngineId } from './drivable.ts'
import { enabledEngineIds, loadedHarnesses } from './engine-registry.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'
import { readSessionProvenance } from './terminal-session.ts'

const HOME = homedir()
const SESSION_PREFIX = 'ccm-'

/** Built-in engine ids that are tmux-hosted (i.e. can appear as a ccm-* tmux session).
 *  `hermes` is intentionally excluded — it is never tmux-hosted, so a tmux
 *  session claiming `@tandem_engine=hermes` is never valid provenance. */
const TMUX_ENGINE_IDS = new Set<EngineId>(['claude', 'codex', 'shell'])

/** A tmux engine tag is valid provenance when it names a tmux built-in or a loaded harness file. */
function isTmuxEngineTag(tag: string): boolean {
  return TMUX_ENGINE_IDS.has(tag) || loadedHarnesses().has(tag)
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
    .map((p) => safeResolve(p, home))
}

/** True if `candidate` resolves to an allowlisted root or a descendant of one.
 *  Prefix comparison uses a trailing separator so "/srv/code" does NOT match
 *  "/srv/code-evil". */
export function isCwdAllowed(candidate: string, allowlist: string[]): boolean {
  let real: string
  try {
    real = safeResolve(candidate)
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

function tmux(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

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
 * a known tmux-hosted engine id or a loaded harness name AND its `@tandem_owner` tag exactly matches
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
    raw = await tmuxFn(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_path}'])
  } catch {
    return [] // tmux absent or no server running
  }
  const candidates: { name: string; created: string; cwd: string }[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [name, created, cwd] = line.split('\t')
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
 * sessions Tandem did not create. Sorted newest first, limited.
 */
export async function listSessions(
  opts: {
    limit?: number
    project?: string
    allowlist?: string[]
    enabledEngines?: Set<EngineId>
    listingDependencies?: LiveListingDependencies
  } = {},
): Promise<{ sessions: SessionInfo[] }> {
  const limit = opts.limit ?? 20
  const allowlist = opts.allowlist ?? buildAllowlist()
  // Built-ins plus the enabled harness names, so harness sessions list (U-R1A-11).
  const enabledEngines = opts.enabledEngines ?? enabledEngineIds()
  const live = await listLiveTmuxSessions(opts.listingDependencies)

  // Registry entries are sessions this running bridge already admitted. This
  // is also the only source for Hermes, which has no tmux inventory and is
  // deliberately never discovered by listing a gateway or personal files.
  const registered = (
    await Promise.all(
      [...registry.values()].map(async (session) => ({ session, alive: await session.isAlive().catch(() => false) })),
    )
  )
    .filter(({ session, alive }) => alive && enabledEngines.has(session.engine) && !RELAY_NAME_RE.test(session.id))
    .map(({ session }): SessionInfo => ({
      id: session.id,
      engine: session.engine,
      project: session.engine === 'hermes'
        ? 'hermes'
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
      attachHint: `tmux attach -t '=${s.target}'`,
    }))

  const all = [...registered, ...adoptedCandidates]

  const filtered = opts.project
    ? all.filter((s) => s.cwd.includes(opts.project as string) || s.project === opts.project)
    : all

  filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions: filtered.slice(0, limit) }
}
