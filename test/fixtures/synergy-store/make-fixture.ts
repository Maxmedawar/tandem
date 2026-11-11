// Builds test/fixtures/synergy-store/{fabric.sqlite3,expected.json} with Synergy's own code.
//
// Usage: node --experimental-strip-types test/fixtures/synergy-store/make-fixture.ts <synergy dir> <out dir>
//   <synergy dir>  a checkout of Synergy at 8fc22da with `npm ci` done and fabricd/bin/fabricd built
//   <out dir>      a new folder whose resolved path starts /private/tmp/r1a42- (/tmp/r1a42- on Linux)
//
// The store is made the way Synergy's local host makes it, minus serving peers: fabricd (the
// JetStream bus) with an empty, unenrolled mesh folder, and a SQLiteFabricClient on that bus.
// Every call goes through Synergy's MCP tools and its RPC router, as the hub's one user would.
// Content is synthetic plain English. expected.json holds Synergy's own answers.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SYNERGY_COMMIT = '8fc22da'
const SUBJECT = 'fixture-owner'
const CLOCK_START = '2026-11-11T00:00:00.000Z'
const MAX_BYTES = 1_048_576

const fail = (why: string): never => {
  console.log(`make-fixture: FAIL ${why}`)
  process.exit(1)
}

const [synergyArg, outArg] = process.argv.slice(2)
if (!synergyArg || !outArg) fail('usage: make-fixture.ts <synergy dir> <out dir>')
const synergyDir = resolve(synergyArg)
const outResolved = join(realpathSync(dirname(resolve(outArg))), basename(outArg))
const outPrefix = process.platform === 'darwin' ? '/private/tmp/r1a42-' : '/tmp/r1a42-'
if (!outResolved.startsWith(outPrefix)) fail(`out dir must resolve under ${outPrefix}`)
if (existsSync(outResolved)) fail('out dir must be a new folder')
const fabricd = join(synergyDir, 'fabricd', 'bin', 'fabricd')
if (!existsSync(fabricd)) fail('fabricd/bin/fabricd is missing in the synergy dir')
mkdirSync(outResolved, { mode: 0o700 })
mkdirSync(join(outResolved, 'mesh'), { mode: 0o700 })

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const databasePath = join(outResolved, 'fabric.sqlite3')
const fromSynergy = (path: string) => import(pathToFileURL(join(synergyDir, path)).href)
const { startFabricdHost } = await fromSynergy('bridge/fabric/fabricd-host.ts')
const { SQLiteFabricClient } = await fromSynergy('bridge/fabric/sqlite-fabric-client.ts')
const { configureFabricTools } = await fromSynergy('src/fabric/mcp-tools.ts')
const { routeFabricRpc, FABRIC_MCP_TRUST } = await fromSynergy('bridge/fabric/rpc-router.ts')

let tick = Date.parse(CLOCK_START)
const now = () => tick++

const host = await startFabricdHost({ binaryPath: fabricd, storeDir: join(outResolved, 'bus'), meshDir: join(outResolved, 'mesh') })
const client = new SQLiteFabricClient({ databasePath, now, bus: host.bus })

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
const tools = new Map<string, Handler>()
const registered = await configureFabricTools({ registerTool: (name: string, _definition: unknown, handler: Handler) => { tools.set(name, handler) } }, {
  enabled: '1',
  oauthSubject: SUBJECT,
  rpc: async (path: string, body: unknown) => {
    const answer = await routeFabricRpc({ trust: FABRIC_MCP_TRUST, client, method: 'POST', path, body })
    if (answer.status !== 200) throw new Error(`status ${answer.status}`)
    return answer.body
  },
})
if (!registered) fail('Synergy registered no fabric tools')

const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const handler = tools.get(name) ?? fail(`no tool ${name}`)
  const value = JSON.parse((await handler(args)).content[0].text)
  if (value && typeof value === 'object' && 'error' in value) fail(`${name} answered ${value.error}`)
  return value
}

// Projects: one with two member agents, one plain, one archived at the end.
const garden = await call('project_create', { displayName: 'Fixture garden watering plan', memberAgentIds: ['agent-builder', 'agent-reviewer'] })
const pantry = await call('project_create', { displayName: 'Fixture pantry restock list' })
const shed = await call('project_create', { displayName: 'Fixture shed tidy up' })

// Rooms: 4 rooms, 10 events each. [type, body, reply to (index in the same room), extra input]
type Post = [string, string, number?, Record<string, unknown>?]
const rooms: Array<[string, string, Post[]]> = [
  [garden.projectId, 'fixture-room-watering', [
    ['task', 'Check the drip lines along the north bed before the weekend heat arrives.'],
    ['question', 'Should the tomato row get water twice a day while the heat wave lasts?'],
    ['answer', 'Twice a day is too much; one deep soak at dawn keeps the roots strong.', 1],
    ['decision', 'Water the raised beds at six in the morning and skip the evening round.'],
    ['discovery', 'The rain barrel overflow pipe is cracked near the bottom seam.'],
    ['task', 'Replace the cracked overflow pipe with the spare length from the garage shelf.', undefined, { toAgentId: 'agent-builder' }],
    ['progress', 'The new overflow pipe is cut to length and fitted, waiting for the sealant to cure.', 5],
    ['claim', 'I will measure soil moisture in the herb corner every second day.'],
    ['blocked', 'The timer valve on the east hose will not open after the battery swap.'],
    ['handoff', 'Handing the valve repair to the next shift with notes taped to the shed door.'],
  ]],
  [garden.projectId, 'fixture-room-seedlings', [
    ['message', 'Pepper seedlings sprouted on day nine under the grow light.'],
    ['question', 'How tall should the squash starts be before moving them outdoors?'],
    ['answer', 'Wait for three true leaves and harden them off over one week.', 1],
    ['artifact', 'Uploaded the seed tray map showing which cells hold basil and which hold dill.', undefined, { artifactRefs: ['fixture-ref-seed-tray-map'] }],
    ['discovery', 'Damping off appeared in two cells of the lettuce tray after the cold night.'],
    ['decision', 'Remove the affected lettuce cells and run a small fan to dry the surface.', 4],
    ['progress', 'Transplanted eight kale starts into the cold frame this afternoon.'],
    ['system', 'Weekly seedling count recorded: forty one healthy, three weak, two lost.'],
    ['task', 'Label every pot with sowing date and variety before Friday.'],
    ['message', 'Labels are done in waterproof pencil so the rain will not smear them.', undefined, { correlationId: 'fixture-corr-labels' }],
  ]],
  [pantry.projectId, 'fixture-room-restock', [
    ['task', 'Count the jars of rice, lentils and oats on the bottom shelf.'],
    ['progress', 'Rice has two jars left, lentils one, oats are nearly empty.', 0],
    ['decision', 'Buy oats in the large sack next time since the small bags run out every week.'],
    ['question', 'Do we still need baking soda or did the last order cover it?'],
    ['answer', 'One unopened box sits behind the flour, so no baking soda this round.', 3],
    ['message', 'The freezer has room for four more loaves of bread after the defrost.'],
    ['claim', 'I will compile the restock order and post it here on Thursday evening.'],
    ['artifact', 'The restock order lists twelve items grouped by aisle for a faster trip.'],
    ['blocked', 'The bulk store is closed for inventory until Monday.'],
    ['handoff', 'The restock order moves to Monday; the printed copy is on the fridge.'],
  ]],
  [pantry.projectId, 'fixture-room-shelves', [
    ['task', 'Clear the top shelf of expired spice tins and wipe it down.'],
    ['discovery', 'Three spice tins expired last spring and one jar of paprika has clumped.'],
    ['decision', 'Group spices alphabetically on the turntable so they are easier to find.'],
    ['question', 'Can the tall cereal boxes fit on the middle shelf if the divider is removed?'],
    ['answer', 'With the divider out the cereal boxes fit standing upright with room to spare.', 3],
    ['progress', 'Divider removed and stored in the hallway closet.'],
    ['message', 'Canned tomatoes now sit on the left side, beans on the right.'],
    ['system', 'Shelf review complete: nineteen items kept, seven discarded, four moved.'],
    ['question', 'Should the snack drawer move closer to the door for quick grabs?'],
    ['answer', 'Keep the snack drawer where it is so the walkway stays clear.', 8],
  ]],
]
const posted = new Map<string, string[]>()
let postNumber = 0
for (const [projectId, room, posts] of rooms) {
  const ids: string[] = []
  for (const [type, body, replyTo, extra] of posts) {
    postNumber += 1
    const event = await call('room_post', {
      projectId, room, type, body,
      idempotencyKey: `fixture-post-${String(postNumber).padStart(2, '0')}`,
      ...(replyTo === undefined ? {} : { replyTo: ids[replyTo] }),
      ...extra,
    })
    ids.push(event.id)
  }
  posted.set(`${projectId} ${room}`, ids)
}

// Memories: 30 rows over user, project and agent scope and all 8 kinds.
type Remember = [string | undefined, 'user' | 'project' | 'agent', string, number, string]
const remembers: Remember[] = [
  [undefined, 'user', 'preference', 0.6, 'Prefers metric units for every garden measurement.'],
  [undefined, 'user', 'fact', 0.5, 'The house sits in a zone where the last frost usually lands in mid April.'],
  [undefined, 'user', 'constraint', 0.8, 'Never spray anything on the vegetable beds within a week of harvest.'],
  [undefined, 'user', 'procedure', 0.55, 'To reset the irrigation timer hold the left button for ten seconds.'],
  [undefined, 'user', 'summary', 0.45, 'Spring chores so far: compost turned, fences mended, trellis painted.'],
  [undefined, 'user', 'decision', 0.65, 'Weekend mornings are reserved for outdoor chores, evenings for planning.'],
  [undefined, 'user', 'discovery', 0.4, 'Coffee grounds sprinkled around the hostas kept slugs away for a month.'],
  [undefined, 'user', 'handoff', 0.35, 'Notes for the house sitter: feed the cat at seven and water the ferns on Sunday.'],
  [undefined, 'user', 'fact', 0.3, 'The old garden hose in the basement leaks at the brass coupling.'],
  [undefined, 'agent', 'procedure', 0.5, 'Before each planning session list open chores sorted by season.'],
  [undefined, 'agent', 'preference', 0.42, 'Summaries should lead with the chore that is most overdue.'],
  [garden.projectId, 'agent', 'discovery', 0.47, 'Soil moisture readings above forty percent mean the beds can skip a watering.'],
  [garden.projectId, 'agent', 'handoff', 0.38, 'Left the moisture meter calibration halfway; finish it with the buffer solution.'],
  [garden.projectId, 'project', 'decision', 0.7, 'Drip irrigation replaces the sprinkler on all vegetable beds this season.'],
  [garden.projectId, 'project', 'fact', 0.51, 'The north bed gets about five hours of direct sun in midsummer.'],
  [garden.projectId, 'project', 'constraint', 0.75, 'Water usage must stay under two hundred liters a day during the drought order.'],
  [garden.projectId, 'project', 'procedure', 0.56, 'Flush the drip filter every two weeks by opening the end cap for a minute.'],
  [garden.projectId, 'project', 'summary', 0.41, 'Garden status: drip lines installed, timer pending repair, seedlings on track.'],
  [garden.projectId, 'project', 'preference', 0.33, 'Tomatoes are staked with bamboo rather than cages.'],
  [garden.projectId, 'project', 'discovery', 0.52, 'Marigolds planted between the peppers cut the aphid count noticeably.'],
  [garden.projectId, 'project', 'fact', 0.44, 'Rainwater from the barrel covers about a third of the weekly watering in spring.'],
  [pantry.projectId, 'project', 'fact', 0.49, 'The pantry holds roughly forty jars when every shelf is full.'],
  [pantry.projectId, 'project', 'procedure', 0.46, 'Rotate older cans to the front whenever new groceries are shelved.'],
  [pantry.projectId, 'project', 'decision', 0.6, 'Shop for the pantry every second Saturday.'],
  [pantry.projectId, 'project', 'constraint', 0.71, 'Keep peanut products on the top shelf, away from the snack drawer.'],
  [pantry.projectId, 'project', 'summary', 0.37, 'Pantry review: grains low, canned goods steady, spices refreshed.'],
  [pantry.projectId, 'project', 'handoff', 0.31, 'The restock list is half written; finish the cleaning supplies section.'],
  [shed.projectId, 'project', 'fact', 0.39, 'The shed roof was resealed last autumn and should last five years.'],
]
const memoryIds: string[] = []
for (const [projectId, scope, kind, importance, text] of remembers) {
  const record = await call('memory_remember', { ...(projectId === undefined ? {} : { projectId }), scope, kind, importance, text })
  memoryIds.push(record.id)
}
if (new Set(memoryIds).size !== remembers.length) fail('two memories merged; make the texts more distinct')
// One superseded (the every-second-Saturday rule), one promoted from a room event, one forgotten.
await call('memory_remember', {
  projectId: pantry.projectId, scope: 'project', kind: 'decision', importance: 0.66,
  text: 'Shop for the pantry on the first and third Saturday of each month.', supersedes: memoryIds[23],
})
await call('memory_promote', {
  projectId: garden.projectId, roomEventId: posted.get(`${garden.projectId} fixture-room-watering`)![3],
  // A template, not a quoted literal: the secret scan's generic rule reads `...Key: '<literal>'` as a credential.
  kind: 'decision', importance: 0.58, idempotencyKey: `fixture-promote-${1}`,
})
await call('memory_forget', { id: memoryIds[8] })
await call('project_archive', { projectId: shed.projectId })
const projects = (await call('project_list')) as Array<{ projectId: string; displayName: string; archivedAt?: string }>

// A room_read of every room, so the projection holds every event the bus took.
const roomReads: Array<{ projectId: string; room: string; eventIds: string[] }> = []
for (const [projectId, room] of rooms) {
  const read = await call('room_read', { projectId, room, limit: 500 })
  const eventIds = (read.events as Array<{ id: string }>).map(event => event.id)
  if (JSON.stringify(eventIds) !== JSON.stringify(posted.get(`${projectId} ${room}`))) fail(`room_read of ${room} differs from what was posted`)
  roomReads.push({ projectId, room, eventIds })
}

// 20 searches: owner-level, garden and pantry.
const searchInputs: Array<Record<string, unknown>> = [
  { query: 'frost date for planting' },
  { query: 'irrigation timer reset button' },
  { query: 'slugs hostas coffee grounds' },
  { query: 'house sitter cat ferns' },
  { query: 'metric units measurement' },
  { query: 'old hose leaks at the coupling' },
  { scope: 'agent', query: 'planning session open chores' },
  { scope: 'user', query: 'outdoor chores on weekend mornings', limit: 5 },
  { projectId: garden.projectId, query: 'drip irrigation sprinkler' },
  { projectId: garden.projectId, query: 'hours of sun on the north bed' },
  { projectId: garden.projectId, query: 'water usage drought limit' },
  { projectId: garden.projectId, query: 'aphids marigolds peppers' },
  { projectId: garden.projectId, query: 'moisture meter calibration' },
  { projectId: garden.projectId, scope: 'project', query: 'rain barrel weekly watering' },
  { projectId: garden.projectId, query: 'water the raised beds at six' },
  { projectId: pantry.projectId, query: 'shop for the pantry on saturday' },
  { projectId: pantry.projectId, query: 'peanut products top shelf' },
  { projectId: pantry.projectId, query: 'rotate older cans' },
  { projectId: pantry.projectId, query: 'grains low canned goods spices' },
  { projectId: pantry.projectId, query: 'restock list cleaning supplies' },
]
const searches: Array<{ input: Record<string, unknown>; top5: string[] }> = []
for (const input of searchInputs) {
  const result = await call('memory_search', input)
  searches.push({ input, top5: (result.records as Array<{ id: string }>).slice(0, 5).map(record => record.id) })
}
const clockEnd = new Date(tick).toISOString()

client.close()
await host.close()
if (host.child.exitCode === null) fail('fabricd still running after close')
if (host.child.signalCode !== null) fail(`fabricd stopped by ${host.child.signalCode}`)
const leftovers = readdirSync(outResolved).filter(name => /^fabric\.sqlite3-(wal|shm|journal)$/.test(name))
if (leftovers.length > 0) fail(`left beside the store: ${leftovers.join(' ')}`)

// The file itself: rows projected from the bus, watermarks, memory counts.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const database = new DatabaseSync(databasePath, { readOnly: true })
const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n)
const busRows = count('SELECT count(*) AS n FROM room_events WHERE bus_sequence IS NOT NULL')
const watermarkRows = count('SELECT count(*) AS n FROM room_bus_watermark')
const live = count('SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL')
const forgotten = count('SELECT count(*) AS n FROM memories WHERE deleted_at IS NOT NULL')
const events = count('SELECT count(*) AS n FROM room_events')
database.close()
if (busRows !== 40 || events !== 40) fail(`expected 40 bus-projected events, found ${busRows} of ${events}`)
if (watermarkRows === 0) fail('no room_bus_watermark rows')
if (live + forgotten !== 30 || forgotten !== 1) fail(`expected 30 memories with 1 forgotten, found ${live} live and ${forgotten} forgotten`)

const bytes = readFileSync(databasePath)
if (bytes.length > MAX_BYTES) fail(`fabric.sqlite3 is ${bytes.length} bytes, over ${MAX_BYTES}`)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const expected = {
  synergyCommit: SYNERGY_COMMIT,
  clock: { start: CLOCK_START, stepMs: 1, end: clockEnd },
  subject: SUBJECT,
  sha256,
  projects: projects.map(project => ({ projectId: project.projectId, displayName: project.displayName, archived: project.archivedAt !== undefined })),
  rooms: roomReads,
  memories: { live, forgotten },
  searches,
}
copyFileSync(databasePath, join(fixtureDir, 'fabric.sqlite3'))
if (createHash('sha256').update(readFileSync(join(fixtureDir, 'fabric.sqlite3'))).digest('hex') !== sha256) fail('copy differs')
writeFileSync(join(fixtureDir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`)
console.log(`make-fixture: PASS ${sha256}`)
