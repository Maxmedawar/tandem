/**
 * The one place that makes sure a SQLite database file exists, 0600, before `new DatabaseSync`.
 *
 * POSIX rule: closing ANY descriptor of a file drops every fcntl lock this process holds on it,
 * including the locks SQLite's open connections hold. Opening and closing a plain descriptor of a
 * database this process already has open (a second openMailbox, a who_is_up presence read, a
 * replay-store open) lets another process take the lock that says it is the only user, and then
 * checkpoint or remove the WAL under this one. So only a MISSING file is opened (to make it 0600,
 * never under the process umask): a file this call just made has no other descriptor in this
 * process, so closing it drops no lock. An existing file is only chmod-ed by path.
 *
 * A same-user process can still swap the path between the lstat and the open: O_NOFOLLOW keeps a
 * symlink from being followed and O_EXCL keeps a file that appeared meanwhile from being reopened.
 * Folders are not this helper's job: each caller keeps its own folder rule.
 */
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'

/*
 * U-R1A-NODEWARN: this is the only runtime module that loads node:sqlite. Node 22 prints
 * `ExperimentalWarning: SQLite is an experimental feature ...` on stderr when it loads. Before the
 * load, the process's current 'warning' listeners (Node's own printer among them) are replaced by
 * one filter that drops only that warning and hands every other warning to them, in order. Marked,
 * so a second evaluation of this module in the same process installs nothing more. With no
 * listeners (--no-warnings) the filter passes to nobody, as before. Later listeners are left alone.
 */
const MARK = Symbol.for('tandem.sqlite-warning-filter')
if (!process.listeners('warning').some((l) => (l as unknown as Record<symbol, unknown>)[MARK])) {
  const replaced = process.listeners('warning')
  process.removeAllListeners('warning')
  const filter = function (this: unknown, w: Error): void {
    if (w.name === 'ExperimentalWarning' && String(w.message).startsWith('SQLite is an experimental feature')) return
    for (const f of replaced) f.call(process, w)
  }
  ;(filter as unknown as Record<symbol, unknown>)[MARK] = true
  process.on('warning', filter)
}

// Vitest does not know about this Node 22 builtin, and a static import would load it before the filter.
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
export const DatabaseSync = sqlite.DatabaseSync
export type DatabaseSync = import('node:sqlite').DatabaseSync

function refuse(code: 'ELOOP' | 'EFTYPE'): never {
  const e = new Error(code === 'ELOOP' ? 'database file refused: it is a symlink' : 'database file refused: not a regular file') as NodeJS.ErrnoException
  e.code = code
  throw e
}

export function ensureDbFile(path: string): void {
  for (let tries = 0; ; tries++) {
    const st = lstatSync(path, { throwIfNoEntry: false })
    if (st) {
      if (st.isSymbolicLink()) refuse('ELOOP')
      if (!st.isFile()) refuse('EFTYPE')
      chmodSync(path, 0o600)
      return
    }
    let fd: number
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (e) {
      // Another process made it between the lstat and the open: back to the exists branch, once.
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && tries === 0) continue
      throw e
    }
    try {
      fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
    return
  }
}
