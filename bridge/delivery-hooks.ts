/**
 * delivery-hooks.ts: how mail reaches an agent whose harness file says `delivery = "hook"` (plan
 * section 3, "How a message reaches an agent"). Nothing here types a key into any session.
 *
 * At spawn, installHook writes one settings file for that session, `<TANDEM_HOME, else
 * ~/.tandem>/delivery/<name>.settings.json` (folder 0700, file 0600), and returns the harness file's
 * `hook` option and that path for the agent's argv. The agent's own settings, hooks and config
 * folders are never read or written. Every hook command is this file run as a script:
 *
 *   '<node>' --experimental-strip-types '<this file>' '<event>' '<name>' '<state.db>' '<delivery dir>'
 *
 * UserPromptSubmit marks the turn working. PostToolUse hands over the mail due at a tool call
 * (fyi, interrupt), Stop the mail due when idle (asks too) and keeps the turn going once; at most
 * 10 messages and 8 KiB of message text per run (one larger message goes alone), each labelled as
 * untrusted data with its sender and a fresh nonce, then acked. A run whose stdin names a
 * sub-agent (`agent_id`, Claude and Codex) hands over nothing: the mail waits for the main agent.
 * The hooks keep `<name>.turn` (working or idle), which the input gate reads through turnState, so
 * an agent that shows no marker while it streams is never read idle mid-reply.
 * A harness file with `hook_format = "config-overrides"` (Codex, U-R1A-26) gets no settings file:
 * the same commands, plus an Interrupt hook that ends the turn, come back as one `hook` option per
 * value with the trust record Codex needs for them (its own config folder is never touched).
 * A hook run always exits 0; on any error it prints nothing to stdout and one line, with no
 * message text and no path, to stderr. A message claimed but not printed stays delivering
 * (mailbox recover() makes it maybe_delivered at the next bridge start). While this computer's kill
 * switch is on (bridge/kill-switch.ts) a hook run hands nothing over and prints nothing.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Harness } from './harness-registry.ts'
import { killSwitchOn } from './kill-switch.ts'
import type { Message, Point } from './mailbox.ts'

/** A harness file's `hook` value: the option that loads one settings file (harnesses/SCHEMA.md). */
export const HOOK_OPTION = /^--[a-z][a-z0-9-]{0,31}$/
/** A session name on this computer (bridge/mailbox.ts). */
const NAME = /^[A-Za-z0-9._-]{1,256}$/
/** What a single-quoted shell word cannot hold safely. */
const UNSAFE = /['\u0000-\u001f\u007f]/
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'] as const
const PER_RUN = 10
/** Message text one hook answer may hold (Codex spills a Stop reason over about 10 KB to a file). */
const PER_RUN_BYTES = 8192
const MAX_STDIN = 1024 * 1024
/** A turn file counts this long after the time it records: Stop does not run when a person interrupts a turn. */
const TURN_FRESH_MS = 15 * 60_000

const tandemHome = () => resolve(process.env.TANDEM_HOME || join(homedir(), '.tandem'))

/** Refuses (throws naming the path and the reason) a folder that is a symlink, another user's, or open to group or world. */
function checkDir(dir: string): void {
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`${dir}: a symlink; refused`)
  if (!st.isDirectory()) throw new Error(`${dir}: not a folder; refused`)
  if (st.uid !== process.getuid!()) throw new Error(`${dir}: not owned by this user; refused`)
  if (st.mode & 0o077) throw new Error(`${dir}: group or world access (mode ${(st.mode & 0o777).toString(8)}); refused`)
}

/** `<TANDEM_HOME, else $HOME/.tandem>/delivery`, worked out at each call; it and TANDEM_HOME made 0700 when missing, checked, never repaired. */
export function deliveryDir(): string {
  const home = tandemHome()
  const dir = join(home, 'delivery')
  try {
    lstatSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    mkdirSync(home, { recursive: true, mode: 0o700 })
    try { mkdirSync(dir, { mode: 0o700 }) } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2 }
  }
  checkDir(dir)
  return dir
}

/** Writes `file` (0600) through a new temporary file and a rename, so a reader never sees half of it. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

const settingsFile = (dir: string, name: string) => join(dir, `${name}.settings.json`)
const turnFile = (dir: string, name: string) => join(dir, `${name}.turn`)

/**
 * Writes `<delivery dir>/<name>.settings.json` for a hook harness and returns `[harness.hook, its
 * path]` for the agent's argv. The state.db path is the mailbox's rule, resolved now, so the hook
 * never depends on the session's own environment. Throws (nothing written) for a bad name or option,
 * a refused folder, or a command part holding `'` or a control character. A turn file left from an
 * earlier session of the same name goes.
 */
export function installHook(harness: Harness, name: string): string[] {
  if (harness.delivery !== 'hook' || typeof harness.hook !== 'string' || !HOOK_OPTION.test(harness.hook)) {
    throw new Error(`harness "${harness.name}": no hook option to deliver through`)
  }
  if (!NAME.test(name)) throw new Error('bad session name for a delivery hook')
  const home = tandemHome()
  const script = fileURLToPath(import.meta.url)
  const db = join(home, 'state.db')
  const dir = join(home, 'delivery')
  if ([process.execPath, script, name, db, dir].some((p) => UNSAFE.test(p))) {
    throw new Error('a hook command part holds a quote or a control character; refused')
  }
  deliveryDir()
  const q = (s: string) => `'${s}'`
  const command = (event: string) => [q(process.execPath), '--experimental-strip-types', q(script), q(event), q(name), q(db), q(dir)].join(' ')
  if (harness.hook_format === 'config-overrides') {
    rmSync(turnFile(dir, name), { force: true })
    return configOverrides(harness.hook, command)
  }
  const hook = (event: string) => [{ type: 'command', command: command(event), timeout: 10 }]
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: hook('UserPromptSubmit') }],
      PostToolUse: [{ matcher: '*', hooks: hook('PostToolUse') }],
      Stop: [{ hooks: hook('Stop') }],
    },
  }
  const file = settingsFile(dir, name)
  rmSync(turnFile(dir, name), { force: true })
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
  return [harness.hook, file]
}

/**
 * Codex's trust hash for one command hook (codex-rs/hooks discovery.rs `hook_hash`): sha256 of the
 * compact JSON, keys sorted, of the event label, the matcher when set and the one handler.
 */
export function codexHookHash(label: string, handler: { command: string; timeout: number; additionalContextLimit?: number }, matcher?: string): string {
  const h = {
    ...(handler.additionalContextLimit === undefined ? {} : { additionalContextLimit: handler.additionalContextLimit }),
    async: false, command: handler.command, timeout: handler.timeout, type: 'command',
  }
  const id = { event_name: label, hooks: [h], ...(matcher === undefined ? {} : { matcher }) }
  return `sha256:${createHash('sha256').update(JSON.stringify(id)).digest('hex')}`
}

/**
 * The hooks as `--config` values, each after `option`, the last one trusting exactly these four
 * handlers (key `/<session-flags>/config.toml:<label>:0:0`). A JSON string is a TOML basic string
 * for every command part installHook lets through. PostToolUse's limit 0 keeps the mail inline.
 */
function configOverrides(option: string, command: (event: string) => string): string[] {
  const rows = [
    { event: 'UserPromptSubmit', label: 'user_prompt_submit', timeout: 10 },
    { event: 'PostToolUse', label: 'post_tool_use', timeout: 10, matcher: '*', additionalContextLimit: 0 },
    { event: 'Stop', label: 'stop', timeout: 10 },
    { event: 'Interrupt', label: 'interrupt', timeout: 3 },
  ]
  const out: string[] = []
  const trust: string[] = []
  for (const { event, label, timeout, matcher, additionalContextLimit } of rows) {
    const c = command(event)
    const limit = additionalContextLimit === undefined ? '' : `,additionalContextLimit=${additionalContextLimit}`
    out.push(option, `hooks.${event}=[{${matcher === undefined ? '' : `matcher=${JSON.stringify(matcher)},`}hooks=[{type="command",command=${JSON.stringify(c)},timeout=${timeout}${limit}}]}]`)
    const hash = codexHookHash(label, { command: c, timeout, additionalContextLimit }, matcher)
    trust.push(`${JSON.stringify(`/<session-flags>/config.toml:${label}:0:0`)}={trusted_hash=${JSON.stringify(hash)}}`)
  }
  return [...out, option, `hooks.state={${trust.join(',')}}`]
}

/**
 * The variables a stdio start of src/stdio-server.ts reads (U-R1A-36C: `git grep` of its start
 * files), sorted. Names only: Codex copies these from its own environment into the server's, so
 * TANDEM_CALLER_TOKEN reaches it while no value ever sits on a command line.
 */
export const MCP_ENV_NAMES: readonly string[] = [
  'CCM_CWD_ALLOWLIST', 'CCM_DEFAULT_CWD', 'CCM_FABRIC_DB_PATH', 'CCM_FABRIC_ENABLED', 'TANDEM_CALLER_TOKEN', 'TANDEM_CONFIG_FILE',
  'TANDEM_CWD_ALLOWLIST', 'TANDEM_DEFAULT_CWD', 'TANDEM_HOME', 'TANDEM_HUB_LINK_ID', 'TANDEM_HUB_LINK_TOKEN', 'TANDEM_HUB_LINK_URL',
]

/**
 * For a harness file with `mcp_env = "config-overrides"` (an agent that starts its MCP servers with
 * a filtered environment, harnesses/SCHEMA.md): Tandem's own stdio server `tandem` for this one
 * session, as three `hook` values (command, args, env_vars). An owner's own `tandem` entry is
 * replaced for that session by this one (the same program). Any other harness: nothing. A command
 * part holding `'` or a control character, or a missing src/stdio-server.ts, throws (nothing starts).
 */
export function mcpOverrides(harness: Harness): string[] {
  if (harness.mcp_env !== 'config-overrides') return []
  const option = harness.hook
  if (harness.hook_format !== 'config-overrides' || typeof option !== 'string' || !HOOK_OPTION.test(option)) {
    throw new Error(`harness "${harness.name}": mcp_env "config-overrides" needs a config-overrides hook`)
  }
  const stdio = fileURLToPath(new URL('../src/stdio-server.ts', import.meta.url))
  if ([process.execPath, stdio].some((p) => UNSAFE.test(p))) throw new Error('an MCP server command part holds a quote or a control character; refused')
  let found = false
  try { found = statSync(stdio).isFile() } catch { /* missing */ }
  if (!found) throw new Error('src/stdio-server.ts is missing; refused')
  return [
    option, `mcp_servers.tandem.command=${JSON.stringify(process.execPath)}`,
    option, `mcp_servers.tandem.args=${JSON.stringify(['--experimental-strip-types', stdio])}`,
    option, `mcp_servers.tandem.env_vars=${JSON.stringify(MCP_ENV_NAMES)}`,
  ]
}

/** Removes the session's settings and turn files. */
export function removeHook(name: string): void {
  if (!NAME.test(name)) return
  const dir = join(tandemHome(), 'delivery')
  checkDir(dir)
  rmSync(settingsFile(dir, name), { force: true })
  rmSync(turnFile(dir, name), { force: true })
}

/** Removes the session's turn file (Tandem pressed its interrupt key: no Stop hook runs). A bad name or a refused folder: nothing. */
export function clearTurn(name: string): void {
  try {
    if (!NAME.test(name)) return
    const dir = join(tandemHome(), 'delivery')
    checkDir(dir)
    rmSync(turnFile(dir, name), { force: true })
  } catch {
    /* nothing to clear */
  }
}

/**
 * The turn state the session's hooks last wrote; undefined when there is none, it is a symlink,
 * another user's or not readable, or its recorded time is over 15 minutes old (or ahead of now), so
 * a turn a person interrupted (no Stop) never holds the agent working for good.
 */
export function turnState(name: string): 'working' | 'idle' | undefined {
  try {
    if (!NAME.test(name)) return undefined
    const dir = join(tandemHome(), 'delivery')
    checkDir(dir)
    const file = turnFile(dir, name)
    const st = lstatSync(file)
    if (!st.isFile() || st.uid !== process.getuid!()) return undefined
    const { state, at } = JSON.parse(readFileSync(file, 'utf8')) as { state?: unknown; at?: unknown }
    const age = Date.now() - (typeof at === 'string' ? Date.parse(at) : NaN)
    if (!(age >= -60_000 && age <= TURN_FRESH_MS)) return undefined
    return state === 'working' || state === 'idle' ? state : undefined
  } catch {
    return undefined
  }
}

/** The label: a first line, one block per message closed by a new random nonce, and a last line when more mail is due. */
function label(name: string, messages: Message[], more: number, untrusted: string): string {
  const nonce = randomBytes(16).toString('hex')
  const k = messages.length
  const lines = [`Tandem mail: ${k} message(s) for session ${name}. ${untrusted}`]
  messages.forEach((m, i) => {
    lines.push(`<<<tandem-mail ${nonce} ${i + 1}/${k} from=${m.from} level=${m.level} id=${m.id} sent=${new Date(m.sentAt).toISOString()}>>>`)
    lines.push(m.text)
    lines.push(`<<<end tandem-mail ${nonce} ${i + 1}/${k}>>>`)
  })
  if (more > 0) lines.push(`${more} more message(s) wait for the next tool call or turn end.`)
  return lines.join('\n')
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length
    if (size > MAX_STDIN) return undefined
    chunks.push(chunk as Buffer)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** One hook run: `[event, name, state.db, delivery dir]`. */
async function runHook([event, name, db, dir]: string[]): Promise<void> {
  const input = (await readStdin()) as Record<string, unknown> | undefined
  if (!input || !(EVENTS as readonly string[]).includes(event!) || !name || !NAME.test(name) || !db || !dir) return
  // A sub-agent's tool call: its context is not the main agent's, and the main turn is running.
  const subAgent = input.agent_id !== undefined && input.agent_id !== null
  const point: Point | undefined =
    subAgent ? undefined : event === 'PostToolUse' ? 'tool_call' : event === 'Stop' && input.stop_hook_active !== true ? 'idle' : undefined
  let printed = false
  try {
    if (point && stateDbExists(db)) {
      // The store's modules read the limits file at import: this computer's, beside its state.db.
      process.env.TANDEM_HOME = dirname(db)
      // The kill switch (bridge/kill-switch.ts) on: claim and print nothing (a Stop answer would keep
      // the agent going); the turn file below is still written.
      if (killSwitchOn()) return
      const { openMailbox, due, UNTRUSTED_MAIL } = await import('./mailbox.ts')
      const box = openMailbox({ path: db })
      try {
        const messages = box.claim(name, point, PER_RUN, PER_RUN_BYTES)
        if (messages.length > 0) {
          const pending = box.pending(name)
          const more = (['fyi', 'ask', 'interrupt'] as const).filter((l) => due(l, point)).reduce((n, l) => n + pending[l], 0)
          const text = label(name, messages, more, UNTRUSTED_MAIL)
          const out = event === 'Stop'
            ? { decision: 'block', reason: text }
            : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }
          writeAll(`${JSON.stringify(out)}\n`)
          printed = true
          box.ack(messages.map((m) => m.id))
        }
      } finally {
        box.close()
      }
    }
  } finally {
    // A Stop that handed over nothing, or an Interrupt, ends the turn; anything else keeps it going.
    const state = !subAgent && ((event === 'Stop' && !printed) || event === 'Interrupt') ? 'idle' : 'working'
    checkDir(dir)
    writeAtomic(turnFile(dir, name), JSON.stringify({ state, at: new Date().toISOString() }))
  }
}

/**
 * All of `text` to stdout before the ack: a non-blocking pipe takes a part (or EAGAIN) while its
 * reader is behind, so the rest is tried again; the agent's hook timeout ends a reader that never reads.
 */
function writeAll(text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let done = 0; done < bytes.length;) {
    try {
      done += writeSync(1, bytes, done)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
      Atomics.wait(pause, 0, 0, 5)
    }
  }
}

/** A regular file of this user's: the store exists (the hook never creates one). */
function stateDbExists(db: string): boolean {
  try {
    const st = lstatSync(db)
    return st.isFile() && st.uid === process.getuid!()
  } catch {
    return false
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  // The hook's only stderr is its own one line: notices the store's modules print at import are dropped.
  process.stderr.write = (() => true) as typeof process.stderr.write
  runHook(process.argv.slice(2)).catch((e: unknown) => {
    const code = (e as { code?: unknown }).code
    writeSync(2, `tandem delivery hook: failed (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'})\n`)
  }).finally(() => {
    process.exitCode = 0
  })
}
