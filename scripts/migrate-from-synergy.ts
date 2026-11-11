// migrate-from-synergy: a one-way copy of a Synergy fabric store (projects, rooms, memories) into a
// new core store, re-keyed from Synergy's owner to core's single user `owner`.
//
// Usage: node --experimental-strip-types scripts/migrate-from-synergy.ts --from <file> --to <file> --from-subject <id>
//   --from          a checkpointed copy of Synergy's fabric.sqlite3. It is read once; only a private copy
//                   of its bytes is opened, read-only.
//   --to            the new core store. Absent: written. Present: compared, never changed.
//   --from-subject  the OAuth subject of Synergy's hub user (every Synergy id derives from it). No default.
// Output: one `migrate: <table> <rows>` line per table, `migrate: project <projectId> bus watermark <n|none>`
// per project, then `migrate: PASS migrated` or `migrate: PASS already migrated (no change)` (rc 0),
// `migrate: REFUSED <reason>` (rc 1) or `migrate: ERROR <step>` (rc 2). It never prints a memory text,
// room body, query or name.
//
// Synergy's rooms were durable on its bus and `room_events` was the bus's projection; core has no bus, so
// the copied rows become the record (`bus_sequence` cleared, the bus bookkeeping left behind). A path
// inside the live Tandem home (the account's real home, not $HOME) is refused before any fs call on it.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SQLiteFabricClient } from '../bridge/fabric/sqlite-fabric-client.ts'
import { fabricCallerFor } from '../src/fabric/mcp-tools.ts'

// Vitest does not know the node:sqlite builtin; a native require keeps the real one.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
type Database = InstanceType<typeof DatabaseSync>
type Row = Record<string, unknown>

const SCHEMA_VERSION = 12
/** Copied and re-keyed, parents before the rows that reference them. */
const COPIED = [
  'projects', 'project_members', 'room_events', 'room_stream_state', 'room_stream_agent_floor',
  'memories', 'memory_vectors', 'memory_embedding_config', 'fabric_owner',
] as const
/** Known and left behind: short-lived state, and the bus's own bookkeeping. */
const NOT_COPIED = ['idempotency', 'room_cursors', 'room_rate_windows', 'room_bus_watermark', 'room_bus_fence']
/** Rebuilt from the copied memories, never copied. */
const FTS = ['memory_fts', 'memory_fts_data', 'memory_fts_idx', 'memory_fts_content', 'memory_fts_docsize', 'memory_fts_config']
const KNOWN = new Set<string>([...COPIED, ...NOT_COPIED, ...FTS, 'sqlite_sequence'])

export interface MigrateOptions {
  readonly from: string
  readonly to: string
  readonly fromSubject: string
  /** The live Tandem home whose paths are refused. Default: defaultLiveHome(). */
  readonly liveHome?: string
  readonly now?: () => number
}

export interface MigrateResult {
  readonly status: 'migrated' | 'already migrated (no change)'
  readonly counts: { readonly rooms: number; readonly events: number; readonly memories: number; readonly projects: number }
  /** Source rows per copied table, and the memory_fts rows rebuilt from them. */
  readonly tables: ReadonlyArray<readonly [table: string, rows: number]>
  /** Per project, how far Synergy's projection had consumed its bus (undefined: never read). */
  readonly watermarks: ReadonlyArray<readonly [projectId: string, sequence: string | undefined]>
}

/** The account's real home, not $HOME (tests replace $HOME). */
export function defaultLiveHome(): string {
  return join(userInfo().homedir, '.tandem')
}

function refuse(reason: string): never {
  throw new Error(`REFUSED ${reason}`)
}

/** Runs one step; anything but a refusal becomes `ERROR <name>`, with no detail that could carry content. */
function step<T>(name: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Error && /^(REFUSED|ERROR) /.test(error.message)) throw error
    throw new Error(`ERROR ${name}`)
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fold = (path: string) => (process.platform === 'darwin' ? path.toLowerCase() : path)
const inside = (base: string, path: string) => {
  const rel = relative(fold(base), fold(path))
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

/** The real path of `path`, or of its deepest existing ancestor with the rest appended. */
function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const up = dirname(path)
    return up === path ? path : join(real(up), basename(path))
  }
}

/** Refuses a path in the live home: first as written, then by its real path. */
function guard(from: string, to: string, liveHome: string): { from: string; to: string } {
  const home = resolve(liveHome)
  const paths = { from: resolve(from), to: resolve(to) }
  for (const [flag, path] of Object.entries(paths)) {
    if (inside(home, path)) refuse(`--${flag} is inside the live Tandem home`)
  }
  if (fold(paths.from) === fold(paths.to)) refuse('--from and --to are the same file')
  const realHome = real(home)
  const reals = { from: real(paths.from), to: real(paths.to) }
  for (const [flag, path] of Object.entries(reals)) {
    if (inside(realHome, path) || inside(home, path)) refuse(`--${flag} resolves inside the live Tandem home`)
  }
  if (fold(reals.from) === fold(reals.to)) refuse('--from and --to are the same file')
  return paths
}

const columns = (database: Database, table: string) =>
  (database.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map(row => String(row.name))

function rowsOf(database: Database, table: string): Row[] {
  const statement = database.prepare(`SELECT * FROM "${table}" ORDER BY ${table === 'room_events' ? 'sequence' : 'rowid'}`)
  // A 63-bit integer (vec_rowid) throws as a number; BigInts round-trip every integer exactly.
  statement.setReadBigInts(true)
  return statement.all() as Row[]
}

const canonical = (row: Row) => JSON.stringify(row, (_key, value: unknown) =>
  typeof value === 'bigint' ? `${value}n` : value instanceof Uint8Array ? `x${Buffer.from(value).toString('hex')}` : value)

/** user_version, integrity, known tables only, and every owner_id is Synergy's owner. */
function checkSource(database: Database, ownerId: string): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as Row).user_version)
  if (version !== SCHEMA_VERSION) refuse(`source schema version ${version}, expected ${SCHEMA_VERSION}`)
  const quick = database.prepare('PRAGMA quick_check').all() as Row[]
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') refuse('source quick_check failed')
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length > 0) refuse(`source foreign_key_check found ${foreignKeys.length} rows`)
  const tables = (database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all() as Row[]).map(row => String(row.name))
  for (const table of tables) if (!KNOWN.has(table)) refuse(`unknown table ${table}`)
  const others = new Set<string>()
  for (const table of tables) {
    if (FTS.includes(table) || table === 'sqlite_sequence' || !columns(database, table).includes('owner_id')) continue
    for (const row of database.prepare(`SELECT DISTINCT owner_id FROM "${table}" WHERE owner_id IS NOT ?`).all(ownerId) as Row[]) {
      others.add(String(row.owner_id))
    }
  }
  if (others.size > 0) refuse(`${others.size} other owner${others.size === 1 ? '' : 's'} in the source (rows not owned by --from-subject)`)
}

/** Builds the store at `partial`: core's schema, every copied row in one transaction, then core opens it. */
function writeStore(partial: string, rows: ReadonlyMap<string, Row[]>, now: () => number): void {
  new SQLiteFabricClient({ databasePath: partial, now }).close()
  const database = new DatabaseSync(partial)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('BEGIN IMMEDIATE')
    try {
      // Core's open wrote its default; the source's own row replaces it.
      database.exec('DELETE FROM memory_embedding_config')
      for (const table of COPIED) {
        const list = rows.get(table) ?? []
        if (list.length === 0) continue
        const names = Object.keys(list[0])
        const insert = database.prepare(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        for (const row of list) insert.run(...(names.map(name => row[name]) as never[]))
      }
      // As SCHEMA_V7 builds it: every memory not forgotten.
      database.exec('INSERT INTO memory_fts(memory_id, text) SELECT id, text FROM memories WHERE deleted_at IS NULL ORDER BY rowid')
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    database.close()
  }
  // Core's own open: schema, quick_check and key checks.
  new SQLiteFabricClient({ databasePath: partial, now }).close()
}

/** Every copied source row, re-keyed, is present and equal in the store at `path`. */
function holdsEveryRow(path: string, rows: ReadonlyMap<string, Row[]>): boolean {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    for (const table of COPIED) {
      const present = new Set(rowsOf(database, table).map(canonical))
      for (const row of rows.get(table) ?? []) if (!present.has(canonical(row))) return false
    }
    return true
  } finally {
    database.close()
  }
}

export async function migrateFromSynergy(options: MigrateOptions): Promise<MigrateResult> {
  const { from, to, fromSubject } = options
  for (const [flag, value] of [['--from', from], ['--to', to], ['--from-subject', fromSubject]] as const) {
    if (typeof value !== 'string' || value.trim() === '') refuse(`missing ${flag}`)
  }
  const now = options.now ?? Date.now
  const paths = guard(from, to, options.liveHome ?? defaultLiveHome())

  const [synergy, core] = await Promise.all([fabricCallerFor(fromSubject), fabricCallerFor('owner')])
  const rekeyed = new Map([[synergy.ownerId, core.ownerId], [synergy.deviceId, core.deviceId], [synergy.agentId, core.agentId]])

  const scratch = mkdtempSync(join(tmpdir(), 'tandem-migrate-'))
  try {
    // Read: a regular file, no write-ahead log beside it, its bytes once into the private folder.
    let fromStat
    try { fromStat = lstatSync(paths.from) } catch { refuse('--from does not exist') }
    if (!fromStat.isFile()) refuse('--from is not a regular file')
    let walBytes = 0
    try { walBytes = statSync(`${paths.from}-wal`).size } catch { /* no log beside it */ }
    if (walBytes > 0) refuse('an unmerged write-ahead log is beside the source; give a checkpointed copy')
    const sourceCopy = join(scratch, 'source.sqlite3')
    const sourceSha = step('read source', () => {
      const bytes = readFileSync(paths.from)
      writeFileSync(sourceCopy, bytes, { mode: 0o600, flag: 'wx' })
      return sha256(bytes)
    })

    const source = step('read source', () => {
      const database = new DatabaseSync(sourceCopy, { readOnly: true })
      try {
        checkSource(database, synergy.ownerId)
        const rows = new Map<string, Row[]>(COPIED.map(table => [table, rowsOf(database, table).map(row => {
          const copied: Row = {}
          for (const [column, value] of Object.entries(row)) copied[column] = typeof value === 'string' ? rekeyed.get(value) ?? value : value
          if (table === 'room_events') copied.bus_sequence = null
          return copied
        })]))
        const watermark = database.prepare('SELECT bus_sequence FROM room_bus_watermark WHERE owner_id = ? AND project_id = ?')
        watermark.setReadBigInts(true)
        const watermarks = (rows.get('projects') ?? []).map(project => {
          const projectId = String(project.project_id)
          const found = watermark.get(synergy.ownerId, projectId) as Row | undefined
          return [projectId, found === undefined ? undefined : String(found.bus_sequence)] as const
        })
        const rooms = Number((database.prepare('SELECT count(*) AS n FROM (SELECT DISTINCT project_id, room FROM room_events)').get() as Row).n)
        return { rows, watermarks, rooms }
      } finally {
        database.close()
      }
    })
    if (step('read source', () => sha256(readFileSync(paths.from))) !== sourceSha) throw new Error('ERROR source changed while it was read')

    const memories = source.rows.get('memories') ?? []
    const result = {
      counts: {
        rooms: source.rooms,
        events: source.rows.get('room_events')?.length ?? 0,
        memories: memories.length,
        projects: source.rows.get('projects')?.length ?? 0,
      },
      tables: [
        ...COPIED.map(table => [table, source.rows.get(table)?.length ?? 0] as const),
        ['memory_fts', memories.filter(memory => memory.deleted_at === null).length] as const,
      ],
      watermarks: source.watermarks,
    }

    let toStat
    try { toStat = lstatSync(paths.to) } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw new Error('ERROR read target')
    }
    if (toStat !== undefined) {
      if (!toStat.isFile()) refuse('--to exists and is not a regular file')
      const targetCopy = join(scratch, 'target.sqlite3')
      step('read target', () => writeFileSync(targetCopy, readFileSync(paths.to), { mode: 0o600, flag: 'wx' }))
      try {
        new SQLiteFabricClient({ databasePath: targetCopy, now }).close()
      } catch {
        refuse('target exists and is not a Tandem store; migrate into a new path')
      }
      if (!step('compare target', () => holdsEveryRow(targetCopy, source.rows))) refuse('target exists and differs; migrate into a new path')
      return { status: 'already migrated (no change)', ...result }
    }

    const folder = dirname(paths.to)
    step('make the --to folder', () => mkdirSync(folder, { recursive: true, mode: 0o700 }))
    if ((statSync(folder).mode & 0o077) !== 0) refuse('the --to folder is open to other users; use a private (0700) folder')
    const partial = `${paths.to}.partial-${process.pid}`
    try {
      step('write target', () => {
        rmSync(partial, { force: true })
        writeStore(partial, source.rows, now)
        if (existsSync(paths.to)) throw new Error('ERROR --to appeared while it was written')
        renameSync(partial, paths.to)
      })
    } finally {
      rmSync(partial, { force: true })
      rmSync(`${partial}-journal`, { force: true })
    }
    return { status: 'migrated', ...result }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(argv: string[]): Promise<number> {
  let values: { from?: string; to?: string; 'from-subject'?: string }
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { from: { type: 'string' }, to: { type: 'string' }, 'from-subject': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }))
  } catch {
    console.log('migrate: REFUSED unknown or malformed arguments (use --from, --to and --from-subject)')
    return 1
  }
  try {
    const result = await migrateFromSynergy({ from: values.from ?? '', to: values.to ?? '', fromSubject: values['from-subject'] ?? '' })
    for (const [table, rows] of result.tables) console.log(`migrate: ${table} ${rows}`)
    for (const [projectId, sequence] of result.watermarks) console.log(`migrate: project ${projectId} bus watermark ${sequence ?? 'none'}`)
    console.log(`migrate: PASS ${result.status}`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('REFUSED ')) {
      console.log(`migrate: ${message}`)
      return 1
    }
    console.log(`migrate: ${message.startsWith('ERROR ') ? message : 'ERROR unexpected'}`)
    return 2
  }
}

const runAsCli = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}
if (runAsCli()) process.exitCode = await main(process.argv.slice(2))
