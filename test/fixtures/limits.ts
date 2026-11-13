/**
 * Test helper for the limits file (bridge/limits.ts): write one from an object, and make an
 * `agents` entry from a loaded harness. Callers apply it with applyLimits().
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { stringify } from 'smol-toml'
import type { Harness } from '../../bridge/harness-registry.ts'

/**
 * Writes `<dir>/limits.toml` from `fields`, with `hub_commands` and each `hub_reads` key on unless
 * `fields` sets them (an absent hub field reads off, U-R1A-44 F1); returns the file's path.
 */
export function writeLimits(dir: string, fields: Record<string, unknown>): string {
  const reads = fields.hub_reads
  const hub = {
    hub_commands: true,
    hub_reads: reads === undefined || (typeof reads === 'object' && reads !== null && !Array.isArray(reads))
      ? { screens: true, transcripts: true, memory: true, ...(reads as object | undefined) }
      : reads,
  }
  return writeLimitsAsGiven(dir, { ...hub, ...fields, hub_reads: hub.hub_reads })
}

/** Writes `<dir>/limits.toml` from exactly `fields` (folder 0700, file 0600); returns the file's path. */
export function writeLimitsAsGiven(dir: string, fields: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'limits.toml')
  writeFileSync(file, stringify(fields), { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

/** The `agents` entry for a loaded harness: the real path of its program, plus that file's sha256 for an owner file. */
export function agentEntry(h: Harness): { program: string; sha256?: string } {
  if (!h.programPath) throw new Error(`harness "${h.name}": its program was not found`)
  const program = realpathSync(h.programPath)
  if (h.source !== 'owner') return { program }
  return { program, sha256: createHash('sha256').update(readFileSync(program)).digest('hex') }
}
