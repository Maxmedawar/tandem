/**
 * ownership.ts — provenance for restart adoption (Phase 2 binding correction A).
 *
 * An `@tandem_engine` tmux tag ALONE is not enough to prove a tmux session was
 * created by THIS Tandem installation: anyone on the same OS user account could
 * hand-create a session named "ccm-<name>" with a matching tag and have it
 * silently adopted as drivable on the next bridge restart. We ALSO tag every
 * spawned session with a durable, installation-local, random owner id and
 * require an EXACT match on both tags before adoption.
 *
 * TRUST MODEL: this is a same-OS-user trust boundary. The owner id is a
 * durable PROVENANCE MARKER — proof "this Tandem process (or an earlier run of
 * it) created this session" — not a claim of isolation from other processes
 * running as the same OS user. Anything running as that same user can already
 * read the owner-id file; the goal is to stop accidental/incidental adoption of
 * a same-named tmux session that Tandem did not create, not to defend against a
 * hostile co-tenant on the same account.
 *
 * The id is never logged and never returned to a caller — it exists only to be
 * written into a tmux session's user option and compared against on adoption.
 */
import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tandemHome } from './tandem-home.ts'

export type OwnerIdProvider = () => Promise<string>

/** Default Tandem state directory: TANDEM_HOME, else ~/.tandem (test-injectable via `stateDir`). */
export function defaultStateDir(): string {
  return tandemHome()
}

function ownerIdPath(stateDir: string): string {
  return join(stateDir, 'owner-id')
}

/**
 * Load the durable owner id for `stateDir`, creating it atomically (mode 0600)
 * if absent. Uses cryptographically random bytes. Concurrent first-run creates
 * from two processes are resolved by whichever atomic rename lands last; both
 * candidates are equally valid random ids, so this never produces a corrupt or
 * partial file — a later restart of either process converges on whatever value
 * won the rename.
 */
export async function loadOrCreateOwnerId(stateDir: string = defaultStateDir()): Promise<string> {
  const path = ownerIdPath(stateDir)
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/.test(existing)) {
      throw new Error('Tandem owner-id file is malformed')
    }
    await chmod(path, 0o600)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  const id = randomBytes(32).toString('hex')
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(tmpPath, 'wx', 0o600)
  try {
    await handle.writeFile(id, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(tmpPath, 0o600)
  try {
    // link() publishes the complete candidate atomically and, unlike rename(),
    // never overwrites a winner created by another first-run process.
    await link(tmpPath, path)
    await chmod(path, 0o600)
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winner = (await readFile(path, 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/.test(winner)) {
      throw new Error('Tandem owner-id file is malformed')
    }
    await chmod(path, 0o600)
    return winner
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

/**
 * A provider bound to `stateDir`, memoizing the id for the lifetime of the
 * returned closure (one disk read/create per process, not per spawn/adopt
 * call). Production code uses the zero-arg default; tests inject their own
 * provider (or a fresh closure over a temp `stateDir`) so no test ever touches
 * the real `~/.tandem` state.
 */
export function makeOwnerIdProvider(stateDir: string = defaultStateDir()): OwnerIdProvider {
  let cached: Promise<string> | undefined
  return () => {
    if (!cached) cached = loadOrCreateOwnerId(stateDir)
    return cached
  }
}
