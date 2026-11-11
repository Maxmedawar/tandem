/**
 * A room_read whose answer is too big for one hub frame consumes nothing: the same
 * cursor with a smaller limit returns the first unread event.
 *
 * The rpc goes through the bridge's real hub handler (handleHubRequest with a fabric
 * host); the stub then applies the hub's frame rule (hub/src/frame-size.ts: every frame
 * character counts as 4 bytes against 1,048,576), answering payload_too_large as the hub does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleHubRequest } from '../../bridge/hub-rpc.ts'
import { createLocalFabricHost, type LocalFabricHost } from '../../bridge/fabric/local-fabric-host.ts'
import {
  configureFabricTools,
  type FabricToolDefinition,
  type FabricToolHandler,
  type FabricToolResult,
} from '../../src/fabric/mcp-tools.ts'
import { FABRIC_MCP_TRUST, type FabricRpcBody } from '../../src/fabric/rpc-contract.ts'
import { MAX_ROOM_EVENT_BODY_BYTES } from '../../src/fabric/types.ts'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame } from '../../hub/src/protocol.ts'

/** The hub's limit (hub/src/frame-size.ts WS_MAX_FRAME_BYTES), counted at 4 bytes a character. */
const HUB_FRAME_BYTES = 1_048_576

class TestToolServer {
  readonly tools = new Map<string, { definition: FabricToolDefinition; handler: FabricToolHandler }>()

  registerTool(name: string, definition: FabricToolDefinition, handler: FabricToolHandler): void {
    this.tools.set(name, { definition, handler })
  }
}

const folders = new Set<string>()
const hosts = new Set<LocalFabricHost>()

afterEach(() => {
  for (const host of hosts) host.close()
  hosts.clear()
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  folders.clear()
})

function resultBody<T>(result: FabricToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

describe('room_read delivery acknowledgement', () => {
  it('does not consume unread events when the hub refuses a legal large answer, so retrying the same cursor is lossless', async () => {
    const folder = mkdtempSync('/tmp/r1a22-delivery-')
    folders.add(folder)
    const host = await createLocalFabricHost({ CCM_FABRIC_ENABLED: '1', CCM_FABRIC_DB_PATH: join(folder, 'fabric.sqlite3') })
    if (!host) throw new Error('no fabric host')
    hosts.add(host)
    const server = new TestToolServer()
    let requestSequence = 0
    let refusedRequestId: string | undefined

    await configureFabricTools(server, {
      enabled: '1',
      oauthSubject: 'owner',
      rpc: async (path: string, body: FabricRpcBody) => {
        const requestId = `delivery-${++requestSequence}`
        const frame: CcmHttpRequestFrame = {
          type: CCM_FRAME_TYPES.httpRequest,
          request_id: requestId,
          method: 'POST',
          path,
          headers: { 'content-type': ['application/json'] },
          body_base64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
          trusted_surface: FABRIC_MCP_TRUST,
        }
        const responseFrame = await handleHubRequest(frame, host)
        if (JSON.stringify(responseFrame).length * 4 > HUB_FRAME_BYTES) {
          refusedRequestId = responseFrame.request_id
          return { error: 'payload_too_large' }
        }
        return JSON.parse(Buffer.from(responseFrame.body_base64 ?? '', 'base64').toString('utf8')) as unknown
      },
    })

    const invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const tool = server.tools.get(name)
      if (!tool) throw new Error(`missing test tool ${name}`)
      return resultBody<T>(await tool.handler(args))
    }

    const project = await invoke<{ projectId: string }>('project_create', { displayName: 'Delivery regression' })
    const initial = await invoke<{ events: unknown[]; cursor: string }>('room_read', {
      projectId: project.projectId,
      room: 'main',
    })
    expect(initial.events).toEqual([])

    const body = 'x'.repeat(MAX_ROOM_EVENT_BODY_BYTES)
    for (let index = 0; index < 16; index++) {
      const posted = await invoke<{ id: string }>('room_post', {
        projectId: project.projectId,
        room: 'main',
        type: 'message',
        body: `${index.toString().padStart(2, '0')}${body.slice(2)}`,
        idempotencyKey: `delivery-event-${index}`,
      })
      expect(posted.id).toMatch(/^event-/)
    }

    expect(await invoke('room_read', {
      projectId: project.projectId,
      room: 'main',
      cursor: initial.cursor,
      limit: 16,
    })).toEqual({ error: 'payload_too_large' })
    expect(refusedRequestId).toBe(`delivery-${requestSequence}`)

    const retry = await invoke<{ events: Array<{ body: string }>; cursor: string }>('room_read', {
      projectId: project.projectId,
      room: 'main',
      cursor: initial.cursor,
      limit: 1,
    })
    expect(retry.events.map(event => event.body.slice(0, 2))).toEqual(['00'])

    const duplicateRetry = await invoke<{ events: Array<{ body: string }>; cursor: string }>('room_read', {
      projectId: project.projectId,
      room: 'main',
      cursor: initial.cursor,
      limit: 1,
    })
    expect(duplicateRetry.events.map(event => event.body.slice(0, 2))).toEqual(['00'])
    expect(duplicateRetry.cursor).toBe(retry.cursor)

    const advanced = await invoke<{ events: Array<{ body: string }>; cursor: string }>('room_read', {
      projectId: project.projectId,
      room: 'main',
      cursor: retry.cursor,
      limit: 1,
    })
    expect(advanced.events.map(event => event.body.slice(0, 2))).toEqual(['01'])

    expect(await invoke<Array<{ projectId: string }>>('project_list', {})).toEqual([
      expect.objectContaining({ projectId: project.projectId }),
    ])
    expect(await invoke<{ projectId: string }>('project_get', { projectId: project.projectId })).toEqual(
      expect.objectContaining({ projectId: project.projectId }),
    )
    const remembered = await invoke<{ id: string }>('memory_remember', {
      projectId: project.projectId,
      scope: 'project',
      kind: 'fact',
      text: 'related reads remain available',
      importance: 0.7,
    })
    expect(await invoke<{ records: Array<{ id: string }> }>('memory_search', {
      projectId: project.projectId,
      query: 'related reads',
    })).toEqual({ records: [expect.objectContaining({ id: remembered.id })] })
    expect(await invoke<{ id: string }>('memory_get', {
      projectId: project.projectId,
      id: remembered.id,
    })).toEqual(expect.objectContaining({ id: remembered.id }))
  })
})
