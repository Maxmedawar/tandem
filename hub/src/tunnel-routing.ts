/**
 * tunnel-routing — pure decision logic for the multi-host TunnelDO.
 *
 * The DO owns real (hibernatable) WebSockets and cannot be unit-tested in the
 * plain-node vitest env because src/tunnel-do.ts imports `cloudflare:workers`.
 * So every routing/eviction decision lives here as a pure function over a plain
 * {bridgeId, isOpen}[] array, and the DO methods are thin adapters that read each
 * socket's `bid:` hibernation tag into that array, call one of these, then act on
 * the returned index/indices — the same isolation split as src/frame-size.ts and
 * src/bridge-id.ts.
 */

/** A connected (or recently-closed) bridge socket, reduced to what routing needs. */
export interface SocketInfo {
  /** Already-sanitized id read back from the socket's `bid:` hibernation tag. */
  bridgeId: string
  /** ws.readyState === OPEN. */
  isOpen: boolean
}

/**
 * Which socket to route an RPC to. Returns an INDEX into `sockets`, or -1 if none.
 *
 * - target given (truthy): the first OPEN socket whose bridgeId === target, else -1.
 * - no target: preserves the old getActiveSocket() exactly — the first OPEN socket
 *   (covers both "single open" and the "multiple open -> first open" fallback);
 *   -1 if none are open.
 *
 * Exact string equality on bridgeId — the caller sanitizes the target first.
 * Never throws.
 */
export function selectSocketIndex(sockets: SocketInfo[], target?: string): number {
  if (target) {
    return sockets.findIndex((s) => s.isOpen && s.bridgeId === target)
  }
  return sockets.findIndex((s) => s.isOpen)
}

/**
 * Which existing sockets a newly-connecting `incomingBridgeId` must close.
 * Same-tag only: indices of OPEN sockets whose bridgeId === incomingBridgeId
 * (the same machine reconnecting replaces itself). Sockets for OTHER bridge_ids
 * are left untouched; already-closed sockets are skipped.
 */
export function socketsToEvict(sockets: SocketInfo[], incomingBridgeId: string): number[] {
  const out: number[] = []
  for (let i = 0; i < sockets.length; i++) {
    const s = sockets[i]
    if (s.isOpen && s.bridgeId === incomingBridgeId) out.push(i)
  }
  return out
}

/** Deduped bridge_ids of all OPEN sockets, first-seen order preserved. */
export function dedupeConnectedIds(sockets: SocketInfo[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sockets) {
    if (!s.isOpen) continue
    if (seen.has(s.bridgeId)) continue
    seen.add(s.bridgeId)
    out.push(s.bridgeId)
  }
  return out
}
