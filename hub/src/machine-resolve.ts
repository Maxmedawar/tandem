/**
 * machine-resolve — pure policy for picking which Mac an MCP tool call targets.
 *
 * The TunnelDO owns routing by an explicit `x-ccm-bridge-id` header and keeps its
 * no-header path (first open socket) unchanged. THIS module is the client-side
 * policy the MCP layer layers on top: when a tool call omits `machine`, decide
 * the effective target from the connected list + the operator default; and turn
 * the DO's raw error bodies into readable messages for the model.
 *
 * Kept free of `cloudflare:workers` imports so it can be unit-tested in the
 * plain-node vitest env AND stay thin-wiring-only in mcp.ts — the same split as
 * src/frame-size.ts, src/bridge-id.ts and src/tunnel-routing.ts.
 */

/** Outcome of resolving a no-`machine` call against the connected machines. */
export type Resolution =
  | { kind: 'ok'; target: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; connected: string[] }

/**
 * Resolve the effective target when the caller gave no `machine`.
 * - 0 connected   -> none (nothing to run on).
 * - 1 connected   -> that one (default is irrelevant).
 * - many connected -> the default if it is online, else ambiguous (caller picks).
 *
 * `connected` are already-sanitized ids from the DO /__status route; `defaultId`
 * is the (already-sanitized) operator default. Plain string equality. Never throws.
 */
export function resolveDefaultMachine(connected: string[], defaultId: string): Resolution {
  if (connected.length === 0) return { kind: 'none' }
  if (connected.length === 1) return { kind: 'ok', target: connected[0] }
  if (connected.includes(defaultId)) return { kind: 'ok', target: defaultId }
  return { kind: 'ambiguous', connected }
}

/** Readable error for an explicitly-requested machine that is not connected. */
export function formatOfflineMessage(requested: string, connected: string[]): string {
  if (connected.length === 0) {
    return `Machine "${requested}" is not connected. No machines are currently connected.`
  }
  return (
    `Machine "${requested}" is not connected. Connected machines: ${connected.join(', ')}. ` +
    `Pass machine=<one of these>.`
  )
}

/** Readable error when several machines are connected and none is the default. */
export function formatAmbiguousMessage(connected: string[], defaultId: string): string {
  return (
    `Multiple machines are connected (${connected.join(', ')}) and the default ` +
    `"${defaultId}" is not among them. Pass machine=<one of these>.`
  )
}

/** True when `parsed` is the DO's {error:'bridge_offline', requested?, connected?} body. */
export function isOfflineError(
  parsed: unknown,
): parsed is { error: 'bridge_offline'; requested?: string; connected?: string[] } {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { error?: unknown }).error === 'bridge_offline'
  )
}
