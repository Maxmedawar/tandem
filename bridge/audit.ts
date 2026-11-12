/**
 * Private, metadata-only audit logging.
 *
 * Content, credentials, network identity, and local-path values are replaced
 * with UTF-8 byte counts before serialization. This is a second line of
 * defense around callers: adding a sensitive field to a future audit call must
 * not silently persist its contents.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tandemHome } from './tandem-home.ts'

const CONTENT_FIELDS = new Set([
  'text',
  'message',
  'task',
  'goal',
  'context',
  'prompt',
  'report',
  'output',
  'summary',
  'handoff',
  'reason',
  'error',
  'body',
  'cwd',
  'path',
  'project',
  'nonce',
  'token',
  'fleetToken',
  'password',
  'cookie',
  'authorization',
  'url',
  'host',
  'hostname',
  'username',
  'ip',
  'tailnet',
  'deviceName',
  'topic',
])

export interface AuditOptions {
  /** Test seam. Production always uses ~/.tandem. */
  directory?: string
  /** Test seam for observing a failed write without replacing stderr. */
  onError?: (message: string) => void
}

export function redactAuditFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!CONTENT_FIELDS.has(key)) {
      safe[key] = value
      continue
    }
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
      safe[`${key}Bytes`] = Buffer.byteLength(serialized, 'utf8')
    } catch {
      // Circular or otherwise unserializable values stay redacted too.
      safe[`${key}Bytes`] = null
    }
  }
  return safe
}

export function audit(fields: Record<string, unknown>, opts: AuditOptions = {}): void {
  const directory = opts.directory ?? tandemHome()
  const logPath = join(directory, 'bridge.log')
  let line = ''
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), ...redactAuditFields(fields) }) + '\n'
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Tighten pre-existing state as well as newly-created state.
    chmodSync(directory, 0o700)
    appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
    chmodSync(logPath, 0o600)
  } catch {
    // Do not echo filesystem errors: they commonly contain the private log path.
    const safeLine = line || JSON.stringify({ ts: new Date().toISOString(), event: 'audit.serialization_failed' }) + '\n'
    const message = `[bridge] AUDIT WRITE FAILED: ${safeLine}`
    if (opts.onError) opts.onError(message)
    else process.stderr.write(message)
  }
}
