/**
 * The Tandem home folder: TANDEM_HOME when it is a non-empty string, else ~/.tandem, always through
 * resolve() and worked out at each call. Every path inside a Tandem home is built from this one
 * function, so a run that sets TANDEM_HOME (a test, a second install) moves all of them. It is the
 * only place in bridge/, src/ and scripts/ where a `.tandem` literal builds a path
 * (test/tandem-home.test.ts guards that); the one exemption is scripts/migrate-from-synergy.ts
 * defaultLiveHome(), which names the real account's ~/.tandem so the migration refuses to write there.
 * A leaf module: node:os and node:path only, so every writer (audit.ts included) can import it.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function tandemHome(dir: string | undefined = process.env.TANDEM_HOME): string {
  return dir ? resolve(dir) : resolve(join(homedir(), '.tandem'))
}
