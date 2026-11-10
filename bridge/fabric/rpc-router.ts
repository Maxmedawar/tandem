import { types as nodeUtilTypes } from 'node:util'
import {
  createCallerContext,
  FabricAuthError,
  FabricScopeError,
} from '../../src/fabric/capabilities.ts'
import type { FabricClient } from '../../src/fabric/client.ts'
import {
  FABRIC_BRIDGE_READY_PATH,
  FABRIC_BRIDGE_READY_PROTOCOL,
  FABRIC_MCP_TRUST,
  type TrustedFabricCallerEnvelope,
} from '../../src/fabric/rpc-contract.ts'
import type {
  FabricCapability,
  MemoryScope,
} from '../../src/fabric/types.ts'
import {
  FabricValidationError,
  assertIdentifier,
  validateCreateProjectInput,
  validateMemoryId,
  validatePostRoomEventInput,
  validateProjectId,
  validatePromoteRoomEventInput,
  validateReadRoomInput,
  validateRememberInput,
  validateSearchMemoryInput,
} from '../../src/fabric/validation.ts'

export { FABRIC_MCP_TRUST }

export interface FabricRpcRouteRequest {
  readonly trust?: string
  readonly client?: FabricClient
  readonly method: string
  readonly path: string
  readonly body: unknown
}

export interface FabricRpcRouteResult {
  readonly status: number
  readonly body: unknown
}

const OWNER_CAPABILITIES: readonly FabricCapability[] = Object.freeze([
  'project:create', 'project:members', 'project:read', 'project:archive',
  'memory:read', 'memory:read:user', 'memory:write', 'memory:write:user', 'memory:delete',
  'room:read', 'room:post',
])

const ROUTES = new Set([
  '/fabric/project/create', '/fabric/project/list', '/fabric/project/get', '/fabric/project/archive',
  '/fabric/room/post', '/fabric/room/read',
  '/fabric/memory/remember', '/fabric/memory/search', '/fabric/memory/get',
  '/fabric/memory/forget', '/fabric/memory/promote',
])

/**
 * The only bridge ingress for public Fabric operations. The caller envelope is
 * accepted solely on the dedicated authenticated TunnelDO frame surface, then
 * converted into a trusted OWNER context inside this private process.
 */
export async function routeFabricRpc(request: FabricRpcRouteRequest): Promise<FabricRpcRouteResult> {
  if (request.trust !== FABRIC_MCP_TRUST || request.method !== 'POST') {
    return denied()
  }
  if (request.path === FABRIC_BRIDGE_READY_PATH) {
    return request.client
      ? ok({ ready: true, protocol: FABRIC_BRIDGE_READY_PROTOCOL })
      : { status: 503, body: { error: 'fabric_unavailable' } }
  }
  if (!ROUTES.has(request.path)) return denied()
  if (!request.client) return { status: 503, body: { error: 'fabric_unavailable' } }

  try {
    const envelope = trustedEnvelope(request.body)
    const caller = envelope.caller
    const input = exactObject('input', envelope.input, inputKeys(request.path))
    const client = request.client

    switch (request.path) {
      case '/fabric/project/create': {
        validateCreateProjectInput(input)
        return ok(await client.createProject(caller, input))
      }
      case '/fabric/project/list':
        return ok(await client.listProjects(caller))
      case '/fabric/project/get': {
        validateProjectId(input.projectId)
        return ok(await client.getProject(caller, input.projectId))
      }
      case '/fabric/project/archive': {
        validateProjectId(input.projectId)
        return ok(await client.archiveProject(caller, input.projectId))
      }
      case '/fabric/room/post': {
        validateProjectId(input.projectId)
        const scoped = ownerContext(callerIdentity(caller), input.projectId)
        const operation = withoutProjectId(input)
        validatePostRoomEventInput(operation)
        return ok(await client.postRoomEvent(scoped, operation))
      }
      case '/fabric/room/read': {
        validateProjectId(input.projectId)
        const scoped = ownerContext(callerIdentity(caller), input.projectId)
        const operation = withoutProjectId(input)
        validateReadRoomInput(operation)
        return ok(await client.readRoom(scoped, operation))
      }
      case '/fabric/memory/remember': {
        const projectId = optionalProjectId(input.projectId)
        const scoped = ownerContext(callerIdentity(caller), projectId)
        const operation = withoutProjectId(input)
        const scope = operation.scope as MemoryScope | undefined
        if (scope === 'user') operation.authorship = 'owner'
        validateRememberInput(operation)
        return ok(await client.remember(scoped, operation))
      }
      case '/fabric/memory/search': {
        const projectId = optionalProjectId(input.projectId)
        const scoped = ownerContext(callerIdentity(caller), projectId)
        const operation = withoutProjectId(input)
        validateSearchMemoryInput(operation)
        return ok(await client.searchMemory(scoped, operation))
      }
      case '/fabric/memory/get': {
        const projectId = optionalProjectId(input.projectId)
        validateMemoryId(input.id)
        return ok(await client.getMemory(ownerContext(callerIdentity(caller), projectId), input.id))
      }
      case '/fabric/memory/forget': {
        const projectId = optionalProjectId(input.projectId)
        validateMemoryId(input.id)
        await client.forgetMemory(ownerContext(callerIdentity(caller), projectId), input.id)
        return ok({ ok: true })
      }
      case '/fabric/memory/promote': {
        validateProjectId(input.projectId)
        const scoped = ownerContext(callerIdentity(caller), input.projectId)
        const operation = withoutProjectId(input)
        validatePromoteRoomEventInput(operation)
        return ok(await client.promoteRoomEvent(scoped, operation))
      }
      default:
        return denied()
    }
  } catch (error) {
    if (error instanceof FabricValidationError) return { status: 400, body: { error: 'fabric_request_invalid' } }
    if (error instanceof FabricAuthError || error instanceof FabricScopeError) return denied()
    return { status: 503, body: { error: 'fabric_unavailable' } }
  }
}

function trustedEnvelope(value: unknown): { caller: ReturnType<typeof ownerContext>; input: unknown } {
  try {
    const envelope = exactObject('fabricEnvelope', value, ['caller', 'input'])
    return {
      caller: trustedCaller(exactObject('caller', envelope.caller, ['ownerId', 'deviceId', 'agentId'])),
      input: envelope.input,
    }
  } catch {
    throw new FabricAuthError()
  }
}

function trustedCaller(value: Record<string, unknown>) {
  assertIdentifier('ownerId', value.ownerId)
  assertIdentifier('deviceId', value.deviceId)
  assertIdentifier('agentId', value.agentId)
  return ownerContext(value as unknown as TrustedFabricCallerEnvelope)
}

function callerIdentity(caller: ReturnType<typeof ownerContext>): TrustedFabricCallerEnvelope {
  return { ownerId: caller.ownerId, deviceId: caller.deviceId, agentId: caller.agentId }
}

function ownerContext(identity: TrustedFabricCallerEnvelope, projectId?: string) {
  return createCallerContext({
    ...identity,
    ...(projectId === undefined ? {} : { projectId }),
    actorType: 'owner',
    capabilities: OWNER_CAPABILITIES,
  })
}

function optionalProjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  validateProjectId(value)
  return value
}

function withoutProjectId(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'projectId'))
}

function exactObject(field: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new FabricValidationError(field)
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new FabricValidationError(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) throw new FabricValidationError(field)
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) throw new FabricValidationError(field)
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch (error) {
    if (error instanceof FabricValidationError) throw error
    throw new FabricValidationError(field)
  }
}

function inputKeys(path: string): readonly string[] {
  switch (path) {
    case '/fabric/project/create': return ['displayName', 'repoRef', 'workspaceRef', 'memberAgentIds', 'retention']
    case '/fabric/project/list': return []
    case '/fabric/project/get':
    case '/fabric/project/archive': return ['projectId']
    case '/fabric/room/post': return ['projectId', 'room', 'type', 'body', 'idempotencyKey', 'toAgentId', 'replyTo', 'correlationId', 'artifactRefs', 'ttlHops']
    case '/fabric/room/read': return ['projectId', 'room', 'cursor', 'limit']
    case '/fabric/memory/remember': return ['projectId', 'scope', 'kind', 'text', 'importance', 'confidence', 'supersedes']
    case '/fabric/memory/search': return ['projectId', 'scope', 'query', 'limit']
    case '/fabric/memory/get':
    case '/fabric/memory/forget': return ['projectId', 'id']
    case '/fabric/memory/promote': return ['projectId', 'roomEventId', 'kind', 'importance', 'confidence', 'idempotencyKey']
    default: return []
  }
}

function ok(body: unknown): FabricRpcRouteResult { return { status: 200, body } }
function denied(): FabricRpcRouteResult { return { status: 403, body: { error: 'fabric_operation_denied' } } }
