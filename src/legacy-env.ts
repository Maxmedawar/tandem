/**
 * The compatibility shim for settings renamed to the TANDEM_ prefix (U-R1A-CCMNAMES). Every reader
 * of a renamed setting goes through setting(): the new name wins when set and not blank; else the
 * old name still works and prints one stderr line per old name per process (never the value). A
 * later release removes the old names. This file is the only place in core that spells them.
 */

/** New name -> old name. */
export const RENAMED: Readonly<Record<string, string>> = Object.freeze({
  TANDEM_CWD_ALLOWLIST: 'CCM_CWD_ALLOWLIST',
  TANDEM_DEFAULT_CWD: 'CCM_DEFAULT_CWD',
  TANDEM_FABRIC_DB_PATH: 'CCM_FABRIC_DB_PATH',
  TANDEM_FABRIC_ENABLED: 'CCM_FABRIC_ENABLED',
})

const warned = new Set<string>()
const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== ''

export function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  if (!Object.hasOwn(RENAMED, name)) throw new Error(`setting(): ${name} is not a renamed setting`)
  const value = env[name]
  if (present(value)) return value
  const oldName = RENAMED[name]!
  const oldValue = env[oldName]
  if (!present(oldValue)) return undefined
  if (!warned.has(oldName)) {
    warned.add(oldName)
    process.stderr.write(`tandem: ${oldName} is deprecated; set ${name} instead\n`)
  }
  return oldValue
}
