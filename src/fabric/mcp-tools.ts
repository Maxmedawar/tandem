import { z, type ZodTypeAny } from 'zod'
import {
  MAX_ARTIFACT_REFS,
  MAX_DISPLAY_NAME_BYTES,
  MAX_IDENTIFIER_BYTES,
  MAX_MEMORY_SEARCH_LIMIT,
  MAX_MEMORY_TEXT_BYTES,
  MAX_PROJECT_MEMBER_AGENT_IDS,
  MAX_QUERY_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_RETENTION_DAYS,
  MAX_ROOM_EVENT_BODY_BYTES,
  MAX_ROOM_READ_LIMIT,
  MAX_TTL_HOPS,
} from './types.ts'
import { isFabricFlagEnabled } from './feature.ts'
import {
  FABRIC_BRIDGE_READY_PATH,
  FABRIC_BRIDGE_READY_PROTOCOL,
  type FabricRpcBody,
  type TrustedFabricCallerEnvelope,
} from './rpc-contract.ts'

export interface FabricToolDefinition {
  readonly title: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, ZodTypeAny>>
}

export type FabricToolResult = { content: Array<{ type: 'text'; text: string }> }
export type FabricToolHandler = (args: Record<string, unknown>) => Promise<FabricToolResult>

export interface FabricToolServer {
  registerTool(name: string, definition: FabricToolDefinition, handler: FabricToolHandler): unknown
}

export interface ConfigureFabricToolsOptions {
  readonly enabled: unknown
  readonly oauthSubject?: unknown
  readonly configuredOwnerId?: unknown
  /** Memory has one home computer, so a call names no computer: the path and the body only. */
  readonly rpc: (path: string, body: FabricRpcBody) => Promise<unknown>
  /** Default true: list the tools only when /fabric/_ready answers. False lists them at once
   *  (a call reaching no home then answers why). */
  readonly readiness?: boolean
}

const identifier = z.string().min(1).max(MAX_IDENTIFIER_BYTES)
const roomEventType = z.enum(['message', 'question', 'answer', 'decision', 'discovery', 'task', 'claim', 'progress', 'blocked', 'handoff', 'artifact', 'system'])
const memoryScope = z.enum(['user', 'project', 'agent'])
const memoryKind = z.enum(['preference', 'fact', 'decision', 'constraint', 'discovery', 'procedure', 'handoff', 'summary'])
const importance = z.number().finite().min(0).max(1)
const confidence = z.number().finite().min(0).max(1).optional()

/** U-R1A-47: how far an agent's calls reach. Stated limits: every session shares one fabric agent id
 *  (36A G7), and agents on a computer that is not the memory home get no memory tools under "project"
 *  until forwarded calls carry the agent. */
const SCOPE = ' An agent inside a Tandem session sees only projects whose workspaceRef holds its session\'s folder and must name one of them as projectId (project_list shows them), unless the owner sets memory_scope = "all"; memory text is masked for secrets when saved.'

const definitions = {
  project_create: {
    title: 'Create project',
    description: 'Create a Fabric project owned by the authenticated owner.' + SCOPE,
    inputSchema: {
      displayName: z.string().min(1).max(MAX_DISPLAY_NAME_BYTES),
      repoRef: z.string().min(1).max(MAX_REFERENCE_BYTES).optional(),
      workspaceRef: z.string().min(1).max(MAX_REFERENCE_BYTES).optional(),
      memberAgentIds: z.array(identifier).max(MAX_PROJECT_MEMBER_AGENT_IDS).optional(),
      retention: z.object({
        roomEventTtlHops: z.number().int().positive().max(MAX_TTL_HOPS).optional(),
        roomRetentionDays: z.number().int().positive().max(MAX_RETENTION_DAYS).optional(),
      }).strict().optional(),
    },
  },
  project_list: {
    title: 'List projects',
    description: 'List projects visible to the authenticated owner.' + SCOPE,
    inputSchema: {},
  },
  project_get: {
    title: 'Get project',
    description: 'Get one owned project.' + SCOPE,
    inputSchema: { projectId: identifier },
  },
  project_archive: {
    title: 'Archive project',
    description: 'Archive one owned project.' + SCOPE,
    inputSchema: { projectId: identifier },
  },
  room_post: {
    title: 'Post room event',
    description: 'Post a retained event to an owned project room.' + SCOPE,
    inputSchema: {
      projectId: identifier,
      room: identifier,
      type: roomEventType,
      body: z.string().min(1).max(MAX_ROOM_EVENT_BODY_BYTES),
      idempotencyKey: identifier,
      toAgentId: identifier.optional(),
      replyTo: identifier.optional(),
      correlationId: identifier.optional(),
      artifactRefs: z.array(z.string().min(1).max(MAX_REFERENCE_BYTES)).max(MAX_ARTIFACT_REFS).optional(),
      ttlHops: z.number().int().positive().max(MAX_TTL_HOPS).optional(),
    },
  },
  room_read: {
    title: 'Read room events',
    description: 'Read retained events from an owned project room. Adopt the returned continuation only after success; retrying the input cursor replays the same unread page.' + SCOPE,
    inputSchema: {
      projectId: identifier,
      room: identifier,
      cursor: identifier.optional(),
      limit: z.number().int().positive().max(MAX_ROOM_READ_LIMIT).optional(),
    },
  },
  memory_remember: {
    title: 'Remember',
    description: 'Store an owner, project, or owner-actor memory with provenance.' + SCOPE,
    inputSchema: {
      projectId: identifier.optional(),
      scope: memoryScope,
      kind: memoryKind,
      text: z.string().min(1).max(MAX_MEMORY_TEXT_BYTES),
      importance,
      confidence,
      supersedes: identifier.optional(),
    },
  },
  memory_search: {
    title: 'Search memory',
    description: 'Search memory visible to the authenticated owner.' + SCOPE,
    inputSchema: {
      projectId: identifier.optional(),
      scope: memoryScope.optional(),
      query: z.string().max(MAX_QUERY_BYTES),
      limit: z.number().int().positive().max(MAX_MEMORY_SEARCH_LIMIT).optional(),
    },
  },
  memory_get: {
    title: 'Get memory',
    description: 'Get one memory visible to the authenticated owner.' + SCOPE,
    inputSchema: { projectId: identifier.optional(), id: identifier },
  },
  memory_forget: {
    title: 'Forget memory',
    description: 'Tombstone one memory visible to the authenticated owner.' + SCOPE,
    inputSchema: { projectId: identifier.optional(), id: identifier },
  },
  memory_promote: {
    title: 'Promote room event',
    description: 'Promote one retained room event into project memory.' + SCOPE,
    inputSchema: {
      projectId: identifier,
      roomEventId: identifier,
      kind: memoryKind,
      importance,
      confidence,
      idempotencyKey: identifier,
    },
  },
} as const satisfies Record<string, FabricToolDefinition>

const paths: Record<keyof typeof definitions, string> = {
  project_create: '/fabric/project/create',
  project_list: '/fabric/project/list',
  project_get: '/fabric/project/get',
  project_archive: '/fabric/project/archive',
  room_post: '/fabric/room/post',
  room_read: '/fabric/room/read',
  memory_remember: '/fabric/memory/remember',
  memory_search: '/fabric/memory/search',
  memory_get: '/fabric/memory/get',
  memory_forget: '/fabric/memory/forget',
  memory_promote: '/fabric/memory/promote',
}

const inputKeys: Record<keyof typeof definitions, readonly string[]> = {
  project_create: ['displayName', 'repoRef', 'workspaceRef', 'memberAgentIds', 'retention'],
  project_list: [],
  project_get: ['projectId'],
  project_archive: ['projectId'],
  room_post: ['projectId', 'room', 'type', 'body', 'idempotencyKey', 'toAgentId', 'replyTo', 'correlationId', 'artifactRefs', 'ttlHops'],
  room_read: ['projectId', 'room', 'cursor', 'limit'],
  memory_remember: ['projectId', 'scope', 'kind', 'text', 'importance', 'confidence', 'supersedes'],
  memory_search: ['projectId', 'scope', 'query', 'limit'],
  memory_get: ['projectId', 'id'],
  memory_forget: ['projectId', 'id'],
  memory_promote: ['projectId', 'roomEventId', 'kind', 'importance', 'confidence', 'idempotencyKey'],
}

/**
 * Register tools only after explicit enablement and trusted owner derivation.
 * Returning false means Fabric remains absent from the MCP tool list.
 */
export async function configureFabricTools(
  server: FabricToolServer,
  options: ConfigureFabricToolsOptions,
): Promise<boolean> {
  if (!isFabricFlagEnabled(options.enabled)) return false
  const caller = await deriveTrustedOwner(options.oauthSubject, options.configuredOwnerId)
  if (!caller) return false
  if (options.readiness !== false) {
    try {
      const readiness = await options.rpc(FABRIC_BRIDGE_READY_PATH, Object.freeze({
        caller,
        input: Object.freeze({}),
      }))
      if (!isHealthyBridgeReadiness(readiness)) return false
    } catch {
      return false
    }
  }

  for (const name of Object.keys(definitions) as Array<keyof typeof definitions>) {
    server.registerTool(name, definitions[name], async args => {
      try {
        const input = pickDefined(args, inputKeys[name])
        const result = await options.rpc(paths[name], Object.freeze({ caller, input: Object.freeze(input) }))
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'fabric_unavailable' }) }] }
      }
    })
  }
  return true
}

function isHealthyBridgeReadiness(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return Object.keys(record).length === 2 &&
      record.ready === true && record.protocol === FABRIC_BRIDGE_READY_PROTOCOL
  } catch {
    return false
  }
}

async function deriveTrustedOwner(
  oauthSubjectValue: unknown,
  configuredOwnerId: unknown,
): Promise<TrustedFabricCallerEnvelope | undefined> {
  const oauthSubjectAbsent = oauthSubjectValue === undefined
  const oauthSubject = usableIdentity(oauthSubjectValue)
  if (!oauthSubjectAbsent && oauthSubject === undefined) return undefined
  const fallback = oauthSubjectAbsent ? usableIdentity(configuredOwnerId) : undefined
  const source = oauthSubject !== undefined ? `oauth:${oauthSubject}` : fallback === undefined ? undefined : `configured:${fallback}`
  if (source === undefined) return undefined
  return callerFromSource(source)
}

/** The caller the tools derive for OAuth subject `subject` (the hub's link route sets it for its one user). */
export function fabricCallerFor(subject: string): Promise<TrustedFabricCallerEnvelope> {
  return callerFromSource(`oauth:${subject}`)
}

async function callerFromSource(source: string): Promise<TrustedFabricCallerEnvelope> {
  const [ownerId, deviceId, agentId] = await Promise.all([
    domainSeparatedIdentity('owner', source, 'owner-'),
    domainSeparatedIdentity('device', source, 'mcp-device-'),
    domainSeparatedIdentity('actor', source, 'mcp-owner-'),
  ])
  return Object.freeze({ ownerId, deviceId, agentId })
}

/**
 * Each identifier is hashed under its own domain-separated label so that
 * knowing one derived identifier (ownerId, deviceId, agentId) never yields
 * the others by prefix substitution — the digests are independent, not a
 * shared hash reused with different output prefixes.
 */
async function domainSeparatedIdentity(label: string, source: string, outputPrefix: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cloud-code-mcp:fabric-${label}:v1\0${source}`))
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${outputPrefix}${hex}`
}

function usableIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized.length === 0 || new TextEncoder().encode(normalized).length > MAX_IDENTIFIER_BYTES || /[\x00-\x1f\x7f]/.test(normalized)) return undefined
  return normalized
}

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}
