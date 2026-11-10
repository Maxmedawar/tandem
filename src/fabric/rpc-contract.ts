/** Set only by TunnelDO when CloudCodeMcp uses its private Fabric RPC prefix. */
export const FABRIC_MCP_TRUST = 'oauth-mcp-fabric-v1' as const

/** Tunnel-only bridge health contract used before the MCP surface is registered. */
export const FABRIC_BRIDGE_READY_PATH = '/fabric/_ready' as const
export const FABRIC_BRIDGE_READY_PROTOCOL = 'tandem-fabric-rpc-v1' as const

/** Authority fields derived from authenticated OAuth facts, never MCP tool input. */
export interface TrustedFabricCallerEnvelope {
  readonly ownerId: string
  readonly deviceId: string
  readonly agentId: string
}

export interface FabricRpcBody {
  readonly caller: TrustedFabricCallerEnvelope
  readonly input: Readonly<Record<string, unknown>>
}
