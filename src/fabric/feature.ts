/** Worker-safe fail-closed parsing shared by the Cloudflare and Node adapters. */
export function isFabricFlagEnabled(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase())
}
