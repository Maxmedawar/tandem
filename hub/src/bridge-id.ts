/**
 * bridge-id — pure helpers for deriving and sanitizing a bridge's identity.
 *
 * A `bridge_id` names which Mac a tunnel socket belongs to (e.g. "mini",
 * "macbook"). It is emitted by the bridge (CCM_BRIDGE_ID env or a hostname-slug
 * fallback) and captured by the TunnelDO at connect time. This module is kept
 * free of `cloudflare:workers` imports so it can be unit-tested in the plain-node
 * vitest env AND shared by the bridge (Node) side — the same split as
 * src/frame-size.ts.
 */

/** Id used when a bridge connects without a usable bridge_id (old bridge / empty). */
export const DEFAULT_BRIDGE_ID = 'default'

/** Max length of a bridge_id slug (keeps hibernation tags small). */
const MAX_BRIDGE_ID_LEN = 64

/**
 * Slug rule: lowercase; any char outside [a-z0-9._-] -> '-'; collapse repeated
 * '-'; trim leading/trailing '-'; cap at 64 chars (re-trimming any '-' the cut
 * leaves dangling). May return '' for all-garbage input — callers decide the
 * fallback.
 */
export function slugifyBridgeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BRIDGE_ID_LEN)
    .replace(/-+$/g, '')
}

/**
 * DO side: turn an inbound `?bridge_id=` value into a safe, non-empty id.
 * Missing/blank/garbage -> DEFAULT_BRIDGE_ID. The DO never trusts the bridge to
 * have sanitized.
 */
export function sanitizeBridgeId(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_BRIDGE_ID
  return slugifyBridgeId(raw) || DEFAULT_BRIDGE_ID
}
