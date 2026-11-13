import { isAbsolute } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import type { CallerContext, FabricCapability } from './types.ts'
import { assertIdentifier, FabricValidationError } from './validation.ts'
import { isFabricFlagEnabled } from './feature.ts'
import { setting } from '../legacy-env.ts'

const trustedContexts = new WeakSet<object>()
const KNOWN_CAPABILITIES = new Set<FabricCapability>(['project:create','project:members','project:read','project:archive','memory:read','memory:read:user','memory:write','memory:write:user','memory:delete','room:read','room:post','task:claim','session:control','session:open','shell:execute','device:add','device:revoke'])
export const MAX_CAPABILITY_COUNT = KNOWN_CAPABILITIES.size

class ImmutableCapabilitySet implements ReadonlySet<FabricCapability> {
  readonly #values: Set<FabricCapability>
  constructor(values: Iterable<FabricCapability>) { this.#values = new Set(values); Object.freeze(this) }
  get size() { return this.#values.size }
  has(value: FabricCapability) { return this.#values.has(value) }
  entries() { return this.#values.entries() }
  keys() { return this.#values.keys() }
  values() { return this.#values.values() }
  forEach(callback: (value: FabricCapability, value2: FabricCapability, set: ReadonlySet<FabricCapability>) => void, thisArg?: unknown) {
    for (const value of this.#values) callback.call(thisArg, value, value, this)
  }
  [Symbol.iterator]() { return this.values() }
  readonly [Symbol.toStringTag] = 'ImmutableCapabilitySet'
}

export type CallerContextInput = Omit<CallerContext, 'capabilities' | 'actorType'> & {
  readonly capabilities: readonly FabricCapability[] | ReadonlySet<FabricCapability>
  readonly actorType?: 'agent' | 'owner'
}

/** Trusted ingress boundary. It validates and snapshots all authorization data. */
export function createCallerContext(input: unknown): CallerContext {
  const data = callerContextData(input)
  assertIdentifier('ownerId', data.ownerId)
  assertIdentifier('deviceId', data.deviceId)
  assertIdentifier('agentId', data.agentId)
  if (data.projectId !== undefined) assertIdentifier('projectId', data.projectId)
  if (data.actorType !== undefined && data.actorType !== 'agent' && data.actorType !== 'owner') throw new FabricValidationError('callerContext')
  if (data.folder !== undefined && (typeof data.folder !== 'string' || data.folder.length === 0 || !isAbsolute(data.folder) || data.folder.includes('\0'))) {
    throw new FabricValidationError('callerContext')
  }
  const supplied = capabilityValues(data.capabilities)
  if (supplied.some(capability => typeof capability !== 'string' || !KNOWN_CAPABILITIES.has(capability as FabricCapability))) throw new FabricValidationError('callerContext')
  const capabilities = new ImmutableCapabilitySet(supplied)
  const context: CallerContext = Object.freeze({
    ownerId: data.ownerId as string,
    deviceId: data.deviceId as string,
    agentId: data.agentId as string,
    ...(data.projectId === undefined ? {} : { projectId: data.projectId as string }),
    actorType: (data.actorType as 'agent' | 'owner' | undefined) ?? 'agent',
    capabilities,
    ...(data.folder === undefined ? {} : { folder: data.folder as string }),
  })
  trustedContexts.add(context)
  return context
}

const CALLER_KEYS = new Set(['ownerId','deviceId','agentId','projectId','actorType','capabilities','folder'])
function callerContextData(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeUtilTypes.isProxy(input)) throw new FabricValidationError('callerContext')
  try {
    const prototype=Object.getPrototypeOf(input)
    if(prototype!==Object.prototype&&prototype!==null)throw new FabricValidationError('callerContext')
    const descriptors=Object.getOwnPropertyDescriptors(input)
    const keys=Reflect.ownKeys(descriptors)
    if(keys.some(key=>typeof key!=='string'||!CALLER_KEYS.has(key)))throw new FabricValidationError('callerContext')
    for(const key of ['ownerId','deviceId','agentId','capabilities'])if(!Object.prototype.hasOwnProperty.call(descriptors,key))throw new FabricValidationError('callerContext')
    if(Object.values(descriptors).some(descriptor=>!('value' in descriptor)))throw new FabricValidationError('callerContext')
    return Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,descriptor.value]))
  } catch(error) {
    if(error instanceof FabricValidationError)throw error
    throw new FabricValidationError('callerContext')
  }
}
function capabilityValues(value: unknown): FabricCapability[] {
  try {
    if(typeof value==='object'&&value!==null&&nodeUtilTypes.isProxy(value))throw new FabricValidationError('callerContext')
    if(Array.isArray(value)){
      const length=value.length
      if(!Number.isSafeInteger(length)||length<0||length>MAX_CAPABILITY_COUNT)throw new FabricValidationError('callerContext')
      const descriptors=Object.getOwnPropertyDescriptors(value) as Record<string,PropertyDescriptor>
      if(descriptors.length?.value!==length||Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||(key!=='length'&&!/^(0|[1-9]\d*)$/.test(key)))||Object.values(descriptors).some(descriptor=>!('value' in descriptor)))throw new FabricValidationError('callerContext')
      return Array.from({length},(_,index)=>descriptors[String(index)]?.value as FabricCapability)
    }
    if(value instanceof Set){
      const size=Object.getOwnPropertyDescriptor(Set.prototype,'size')?.get?.call(value)
      if(typeof size!=='number'||size>MAX_CAPABILITY_COUNT)throw new FabricValidationError('callerContext')
      return [...Set.prototype.values.call(value)] as FabricCapability[]
    }
  } catch(error) {
    if(error instanceof FabricValidationError)throw error
    throw new FabricValidationError('callerContext')
  }
  throw new FabricValidationError('callerContext')
}

export function isFabricEnabled(env: Record<string, string | undefined> = process.env): boolean { return isFabricFlagEnabled(setting(env, 'TANDEM_FABRIC_ENABLED')) }

/** Public errors are intentionally generic and carry no target or caller identifiers. */
export class FabricAuthError extends Error { constructor() { super('fabric operation is not authorized'); this.name = 'FabricAuthError' } }
export class FabricScopeError extends Error { constructor() { super('fabric resource is not accessible'); this.name = 'FabricScopeError' } }
export class FabricAccessError extends FabricScopeError { constructor() { super(); this.name = 'FabricAccessError' } }

export function isTrustedCallerContext(ctx: CallerContext): boolean { return trustedContexts.has(ctx as object) }
export function assertTrustedContext(ctx: CallerContext): void { if (!isTrustedCallerContext(ctx)) throw new FabricAuthError() }
export function hasCapability(ctx: CallerContext, capability: FabricCapability): boolean {
  return isTrustedCallerContext(ctx) && ctx.capabilities.has(capability)
}
export function assertCapability(ctx: CallerContext, capability: FabricCapability): void {
  if (!hasCapability(ctx, capability)) throw new FabricAuthError()
}
export function assertProjectScope(ctx: CallerContext, projectId: string): void {
  if (!isTrustedCallerContext(ctx) || ctx.projectId !== projectId) throw new FabricAccessError()
}
