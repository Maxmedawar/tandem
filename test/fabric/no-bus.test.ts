/**
 * Gate A1.10: rooms and memory with no Go helper, through a kill.
 *
 * The store's holder is a separate Node process that is killed with SIGKILL,
 * as a crash or a lost machine would kill it: no flush, no close. The test
 * process then opens the same database and asks whether everything that was
 * acknowledged is still there, exactly once.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createLocalFabricHost, type LocalFabricHost } from '../../bridge/fabric/local-fabric-host.ts'
import { createCallerContext } from '../../src/fabric/capabilities.ts'
import type { CallerContext, FabricCapability } from '../../src/fabric/types.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const capabilities: FabricCapability[] = [
  'project:create', 'project:members', 'project:read', 'project:archive',
  'room:post', 'room:read', 'memory:write', 'memory:read', 'memory:delete',
]

const context = (agentId: string, projectId?: string, actorType: 'agent' | 'owner' = 'agent'): CallerContext =>
  createCallerContext({ ownerId: 'owner-a', deviceId: `device-${agentId}`, agentId, projectId, actorType, capabilities })

/**
 * The child. It opens the store, creates the project when given `-`, does its
 * work, prints `ready`, and then stays alive until it is killed. It prints
 * `ack <id> <body>` only after a post's promise has resolved; a post that
 * rejects, a rate-limit refusal included, prints nothing.
 */
function childSource(): string {
  const host = pathToFileURL(join(repoRoot, 'bridge', 'fabric', 'local-fabric-host.ts')).href
  const caps = pathToFileURL(join(repoRoot, 'src', 'fabric', 'capabilities.ts')).href
  return `
import { writeSync } from 'node:fs'
import { createLocalFabricHost } from ${JSON.stringify(host)}
import { createCallerContext } from ${JSON.stringify(caps)}

const capabilities = ${JSON.stringify(capabilities)}
const context = (agentId, projectId, actorType = 'agent') =>
  createCallerContext({ ownerId: 'owner-a', deviceId: 'device-' + agentId, agentId, projectId, actorType, capabilities })
const say = line => { writeSync(1, line + '\\n') }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

setInterval(() => {}, 60_000)
const [mode, projectArg, ...args] = process.argv.slice(2)
const host = await createLocalFabricHost(process.env)
if (!host) throw new Error('fabric is not enabled in the child')
const projectId = projectArg === '-'
  ? (await host.client.createProject(context('agent-a', undefined, 'owner'), { displayName: 'Alpha' })).projectId
  : projectArg
say('project ' + projectId)
const agent = context('agent-a', projectId)

if (mode === 'post') {
  const [count, paceMs, prefix] = args
  for (let index = 0; index < Number(count); index += 1) {
    const body = prefix + ' event ' + index
    try {
      const event = await host.client.postRoomEvent(agent, {
        room: 'main', type: 'message', body, idempotencyKey: prefix + '-k' + index,
      })
      say('ack ' + event.id + ' ' + body)
    } catch {
      // Not acknowledged: nothing is printed.
    }
    if (Number(paceMs) > 0) await sleep(Number(paceMs))
  }
} else if (mode === 'remember') {
  const record = await host.client.remember(agent, {
    scope: 'project', kind: 'decision', text: args[0], importance: 0.9,
  })
  say('ack ' + record.id + ' memory')
} else if (mode !== 'open') {
  throw new Error('unknown mode')
}
say('ready')
`
}

interface Ack { readonly id: string; readonly body: string }

interface Child {
  readonly lines: string[]
  readonly acks: Ack[]
  readonly projectId: string
  waitFor(done: () => boolean, label: string): Promise<void>
  kill(): Promise<void>
}

let scriptPath = ''
let scriptDirectory = ''
const directories = new Set<string>()
const children = new Set<ChildProcess>()
const hosts = new Set<LocalFabricHost>()

beforeAll(() => {
  scriptDirectory = mkdtempSync(join(tmpdir(), 'tandem-no-bus-script-'))
  chmodSync(scriptDirectory, 0o700)
  scriptPath = join(scriptDirectory, 'holder.mjs')
  writeFileSync(scriptPath, childSource(), { mode: 0o600 })
})

afterAll(() => {
  rmSync(scriptDirectory, { recursive: true, force: true })
})

afterEach(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  children.clear()
  for (const host of hosts) {
    try { host.close() } catch { /* already closed */ }
  }
  hosts.clear()
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

function fabricDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tandem-no-bus-'))
  chmodSync(directory, 0o700)
  directories.add(directory)
  return directory
}

function startChild(directory: string, args: string[]): Child {
  const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath, ...args], {
    env: {
      CCM_FABRIC_ENABLED: 'true',
      CCM_FABRIC_DB_PATH: join(directory, 'fabric.sqlite3'),
      HOME: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const lines: string[] = []
  const acks: Ack[] = []
  let pending = ''
  let stderr = ''
  let exited = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }

  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) {
      lines.push(line)
      if (line.startsWith('ack ')) {
        const [, id, ...body] = line.split(' ')
        acks.push({ id: id!, body: body.join(' ') })
      }
    }
    notify()
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => { stderr += chunk })
  const exit = new Promise<void>(resolve => {
    child.once('exit', () => { exited = true; notify(); resolve() })
  })

  const failure = (why: string) => {
    const reason = stderr.split('\n').find(line => /error/i.test(line) && !/ExperimentalWarning/.test(line))
    return new Error(`${why}; child stderr: ${reason ?? stderr.slice(0, 500)}`)
  }

  return {
    lines,
    acks,
    get projectId() {
      const line = lines.find(entry => entry.startsWith('project '))
      if (!line) throw new Error('child printed no project')
      return line.slice('project '.length)
    },
    waitFor(done, label) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(failure(`timed out waiting for ${label}`)) }, 30_000)
        const check = () => {
          if (done()) {
            clearTimeout(timer); listeners.delete(check); resolve()
          } else if (exited) {
            clearTimeout(timer); listeners.delete(check); reject(failure(`child exited before ${label}`))
          }
        }
        listeners.add(check)
        check()
      })
    },
    async kill() {
      // A kill that did nothing would turn every case here into an orderly
      // restart, so the exit is waited for on the process object.
      if (exited || child.exitCode !== null || child.signalCode !== null) throw failure('child exited before the kill')
      child.kill('SIGKILL')
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        exit,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('child survived SIGKILL for 10 s')), 10_000)
        }),
      ]).finally(() => clearTimeout(timer))
      expect(child.signalCode).toBe('SIGKILL')
    },
  }
}

async function reopen(directory: string): Promise<LocalFabricHost> {
  const host = await createLocalFabricHost({
    CCM_FABRIC_ENABLED: 'true',
    CCM_FABRIC_DB_PATH: join(directory, 'fabric.sqlite3'),
  })
  expect(host).toBeDefined()
  hosts.add(host!)
  return host!
}

const isReady = (child: Child) => () => child.lines.includes('ready')

describe('fabric with no bus: a holder that was killed rather than stopped', () => {
  it('keeps every post that was acknowledged before the kill, in order', async () => {
    const directory = fabricDirectory()
    const child = startChild(directory, ['post', '-', '12', '0', 'a'])
    await child.waitFor(isReady(child), '12 acknowledged posts')
    expect(child.acks).toHaveLength(12)
    await child.kill()

    const host = await reopen(directory)
    const read = await host.client.readRoom(context('agent-a', child.projectId, 'owner'), { room: 'main', limit: 50 })
    expect(read.events.map(event => event.body)).toEqual(child.acks.map(ack => ack.body))
  }, 60_000)

  it('does not double-store a post retried after a kill with the same idempotency key', async () => {
    const directory = fabricDirectory()
    const first = startChild(directory, ['post', '-', '1', '0', 'b'])
    await first.waitFor(isReady(first), 'the first post')
    expect(first.acks).toHaveLength(1)
    await first.kill()

    const retry = startChild(directory, ['post', first.projectId, '1', '0', 'b'])
    await retry.waitFor(isReady(retry), 'the retried post')
    expect(retry.acks).toHaveLength(1)
    expect(retry.acks[0]!.id).toBe(first.acks[0]!.id)
    await retry.kill()

    const host = await reopen(directory)
    const read = await host.client.readRoom(context('agent-a', first.projectId, 'owner'), { room: 'main' })
    expect(read.events.map(event => event.body)).toEqual(['b event 0'])
  }, 60_000)

  it('survives being killed repeatedly while posts are in flight', async () => {
    const directory = fabricDirectory()
    const acknowledged: string[] = []
    const attempted: string[] = []
    let projectId = '-'

    for (let round = 0; round < 3; round += 1) {
      const child = startChild(directory, ['post', projectId, '60', '20', `round${round}`])
      for (let index = 0; index < 60; index += 1) attempted.push(`round${round} event ${index}`)
      await child.waitFor(() => child.acks.length >= 2, 'two acknowledgements')
      await child.kill()
      acknowledged.push(...child.acks.map(ack => ack.body))
      projectId = child.projectId
    }

    // Bounded on both sides: nothing interrupted would make this an orderly
    // restart, and nothing acknowledged would leave nothing to assert.
    expect(acknowledged.length).toBeLessThan(attempted.length)
    expect(acknowledged.length).toBeGreaterThan(0)

    const host = await reopen(directory)
    const read = await host.client.readRoom(context('agent-a', projectId, 'owner'), { room: 'main', limit: 500 })
    const bodies = read.events.map(event => event.body)
    expect(read.events.length).toBeLessThan(500)
    for (const body of acknowledged) {
      expect(bodies.filter(entry => entry === body), `${body} is not present exactly once`).toHaveLength(1)
    }
    expect(new Set(bodies).size).toBe(bodies.length)
    for (const body of bodies) expect(attempted).toContain(body)
  }, 120_000)

  it('reopens a store after two kills with no clean close in between', async () => {
    const directory = fabricDirectory()
    const first = startChild(directory, ['post', '-', '1', '0', 'd'])
    await first.waitFor(isReady(first), 'the post before the crash')
    await first.kill()
    const second = startChild(directory, ['open', first.projectId])
    await second.waitFor(isReady(second), 'the reopened store')
    await second.kill()

    const host = await reopen(directory)
    const owner = context('agent-a', first.projectId, 'owner')
    expect((await host.client.readRoom(owner, { room: 'main' })).events.map(event => event.body)).toEqual(['d event 0'])
    await host.client.postRoomEvent(context('agent-a', first.projectId), {
      room: 'main', type: 'message', body: 'after the crashes', idempotencyKey: 'd-after',
    })
    expect((await host.client.readRoom(owner, { room: 'main' })).events.map(event => event.body))
      .toEqual(['d event 0', 'after the crashes'])
  }, 60_000)

  it('finds a memory saved before the kill', async () => {
    const directory = fabricDirectory()
    const child = startChild(directory, ['remember', '-', 'the store is the authority'])
    await child.waitFor(isReady(child), 'the saved memory')
    expect(child.acks).toHaveLength(1)
    await child.kill()

    const host = await reopen(directory)
    const found = await host.client.searchMemory(context('agent-a', child.projectId, 'owner'), { query: 'authority' })
    expect(found.records.map(record => record.text)).toContain('the store is the authority')
  }, 60_000)

  it('leaves nothing beside the database but SQLite\'s own files', async () => {
    const directory = fabricDirectory()
    const child = startChild(directory, ['post', '-', '3', '0', 'f'])
    await child.waitFor(isReady(child), 'three posts')
    await child.kill()
    const host = await reopen(directory)
    await host.client.postRoomEvent(context('agent-a', child.projectId), {
      room: 'main', type: 'message', body: 'after reopen', idempotencyKey: 'f-after',
    })
    host.close()
    expect(() => host.close()).not.toThrow()

    const entries = readdirSync(directory)
    expect(entries).toContain('fabric.sqlite3')
    expect(entries).not.toContain('bus')
    expect(entries).not.toContain('mesh')
    for (const entry of entries) expect(entry).toMatch(/^fabric\.sqlite3(-wal|-shm|-journal)?$/)
  }, 60_000)

  it('reopens a store whose holder was killed inside a write', async () => {
    // The paced rounds above are killed while the holder sleeps between
    // posts. Here it posts back to back and the kill comes 0-3 ms after an
    // acknowledgement, inside the next post's transaction most rounds. The
    // rollback journal left beside the database proves a kill landed there;
    // the next child and the final reopen must recover from it.
    const directory = fabricDirectory()
    const journal = join(directory, 'fabric.sqlite3-journal')
    const rounds: Array<{ prefix: string, projectId: string, acked: string[] }> = []
    let killedInsideWrite = 0
    for (let round = 0; round < 30 && killedInsideWrite < 3; round += 1) {
      const prefix = `g${round}`
      const child = startChild(directory, ['post', '-', '60', '0', prefix])
      await child.waitFor(() => child.acks.length >= 2, 'two acknowledgements')
      // A timer would fire just after the next acknowledgement arrives, so
      // every kill would land at the same point between two posts. A spin
      // of a different length each round does not follow the child.
      const until = performance.now() + (round * 0.37) % 3
      while (performance.now() < until) { /* spin */ }
      await child.kill()
      if (existsSync(journal)) killedInsideWrite += 1
      rounds.push({ prefix, projectId: child.projectId, acked: child.acks.map(ack => ack.body) })
    }
    expect(killedInsideWrite).toBeGreaterThan(0)

    const host = await reopen(directory)
    for (const { prefix, projectId, acked } of rounds) {
      const read = await host.client.readRoom(context('agent-a', projectId, 'owner'), { room: 'main', limit: 500 })
      const bodies = read.events.map(event => event.body)
      for (const body of acked) {
        expect(bodies.filter(entry => entry === body), `${body} is not present exactly once`).toHaveLength(1)
      }
      expect(new Set(bodies).size).toBe(bodies.length)
      for (const body of bodies) expect(body.startsWith(`${prefix} event `)).toBe(true)
    }
  }, 120_000)
})
