import type { TunnelDO } from './tunnel-do'
import type { TandemMcp } from './mcp'

export interface Env {
  /** Per-account singleton DO that owns the Mac bridge WebSocket. */
  TUNNEL: DurableObjectNamespace<TunnelDO>
  /** McpAgent Durable Object (from the `agents` package). */
  MCP_OBJECT: DurableObjectNamespace<TandemMcp>
  /** Global login-attempt counter for the /authorize password gate. */
  LOGIN_THROTTLE: DurableObjectNamespace
  /** KV used by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace
  /** Shared secret the Mac bridge presents on /__tunnel/connect. */
  TANDEM_HUB_LINK_TOKEN: string
  /** Shared password gating the OAuth /authorize step (the browser login form).
   *  Set via `wrangler secret put TANDEM_HUB_PASSWORD`. OPTIONAL at the type level so
   *  the handler must FAIL CLOSED when it is unset — never auto-approve. */
  TANDEM_HUB_PASSWORD?: string
  /** Comma-separated allowlist of redirect_uri ORIGINS an OAuth code may return to
   *  (anti-phishing). Default `https://claude.ai,https://claude.com`. Client
   *  registration AND authorize both reject off-allowlist redirect origins. */
  TANDEM_ALLOWED_REDIRECT_ORIGINS?: string
  /** Operator's preferred machine when several bridges are connected and a tool
   *  call omits `machine` (e.g. "laptop"). Distinct from the DEFAULT_BRIDGE_ID
   *  constant in src/bridge-id.ts, which is the untagged-socket fallback id. */
  TANDEM_DEFAULT_MACHINE?: string
}

/** Fixed name for the single tunnel DO instance (one Mac, one bridge). */
export const TUNNEL_SINGLETON_NAME = 'singleton'
