/**
 * U-R1A-17 end to end: one local hub and one real bridge whose limits file sits in its own
 * TANDEM_HOME (startBridge writes it there, allowing the shell in the bridge's work folder). With
 * shell and claude both enabled and a fake claude found on PATH, shell opens and claude is refused
 * by the limits file, since it is not in `agents`. Skipped only when wrangler or tmux is missing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hub, missing, rand, signIn, startBridge, startHub, stopBridge, stopHub, type Bridge } from './hub-harness.ts'

const title = missing
  ? `limits file on a bridge behind a local hub (skipped: ${missing} missing)`
  : 'limits file on a bridge behind a local hub'

const WAIT = 120_000
const ID = 'r1a17-alpha'
type Json = Record<string, any>

let client: Client | undefined
let bridge: Bridge | undefined
let tandemHome = ''
let bin = ''

async function tool(name: string, args: Record<string, unknown>): Promise<Json> {
  try {
    const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: WAIT })
    const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ''
    if (result.isError) return { toolError: text }
    return JSON.parse(text) as Json
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

describe.skipIf(Boolean(missing))(title, () => {
  beforeAll(async () => {
    tandemHome = mkdtempSync('/tmp/r1a17-th-')
    bin = mkdtempSync('/tmp/r1a17-bin-')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await startHub('/tmp/r1a17-')
    bridge = await startBridge(ID, {
      TANDEM_HOME: tandemHome,
      TANDEM_ENABLED_ENGINES: 'shell,claude',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    })
    const token = await signIn()
    client = new Client({ name: 'r1a17-e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
  }, 150_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    try {
      await stopBridge(bridge)
    } finally {
      await stopHub()
      for (const dir of [tandemHome, bin]) if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('the bridge read the limits file in its TANDEM_HOME: shell opens in its work folder; claude (enabled, found, not in agents) is refused with limits:', async () => {
    const name = `r1a17-${rand(6)}`
    const opened = await tool('open_session', { name, cwd: bridge!.folder, engine: 'shell', machine: ID })
    expect(opened).toMatchObject({ name, engine: 'shell' })

    const refused = await tool('open_session', { name: `${name}-c`, cwd: bridge!.folder, engine: 'claude', machine: ID })
    expect(refused.error).toMatch(/^limits: agent "claude" is not in the limits file's agents/)

    expect(await tool('close_session', { name, machine: ID })).toMatchObject({ ok: true, name, engine: 'shell' })
  }, WAIT)
})
