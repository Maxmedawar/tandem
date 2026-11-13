/**
 * U-R1A-17B: a missing limits file turns every hub command and read off (fail closed). A test that
 * sends hub frames and is not about the limits file calls hubFieldsOn() before its first frame: it
 * writes limits.toml with `hub_commands` and every `hub_reads` key on, and the same bytes as the
 * applied copy, into the test's TANDEM_HOME (a new folder 0700, files 0600). Nothing else is allowed by it.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function hubFieldsOn(home = process.env.TANDEM_HOME): void {
  if (!home) throw new Error('hubFieldsOn: TANDEM_HOME is not set')
  const text = 'hub_commands = true\nhub_reads = { screens = true, transcripts = true, memory = true }\n'
  mkdirSync(home, { recursive: true, mode: 0o700 })
  for (const name of ['limits.toml', 'limits.applied.toml']) {
    writeFileSync(join(home, name), text, { mode: 0o600 })
    chmodSync(join(home, name), 0o600)
  }
}
