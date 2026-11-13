/**
 * U-R1A-44, gate A1.14: a builder and reviewer relay on Claude Code and on Codex; both loops finish,
 * and a `quiet` turn ends the turn. Opt-in: runs only with TANDEM_LIVE=1 (every row is skipped
 * otherwise), in the live-conformance shape: the real HOME (so the signed-in `claude` and `codex`
 * work), a private TMUX_TMPDIR and a temp TANDEM_HOME, both set by the caller and checked here.
 *
 * Each row is a two-line task (the builder writes NOTES.txt holding the lines `alpha` and `beta`)
 * that ends when the reviewer answers `quiet` on its own line; at most 4 turns per row. Before
 * anything is typed, a probe session of the agent is read: a sign-in screen fails the row with
 * "needs sign-in" and nothing is typed. The Claude row drives bridge/relay.ts (startRelay) directly;
 * bridge/relay.ts opens Claude sessions only, so the Codex row runs the same builder/reviewer turns
 * on two Codex TerminalSessions (their sends end on `quiet`, the markerless engine's still pane).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

const LIVE = process.env.TANDEM_LIVE === '1'
const MAX_TURNS = 4
const ROW_MS = 20 * 60_000
const SIGN_IN = /\b(sign[ -]?in|log[ -]?in|login method|authenticate|api key|choose (?:an? )?account)\b/i
const QUIET_LINE = /^\W*quiet\W*$/im
const TASK = 'Create the file NOTES.txt in the current folder holding exactly two lines: alpha, then beta. Nothing else.'
const REVIEW = [
  'You are the reviewer of a builder working in this same folder. Reply with ONE short instruction for the builder,',
  'or, when NOTES.txt in this folder holds exactly the two lines alpha and beta, reply with the single word quiet on its own line',
  '(and, for the relay, DONE on the next line). Do not edit files yourself.',
].join(' ')

const tag = randomBytes(3).toString('hex')
let BOX = ''
let mods: {
  relay: typeof import('../../bridge/relay.ts')
  limits: typeof import('../../bridge/limits.ts')
  loadedHarnesses: typeof import('../../bridge/engine-registry.ts').loadedHarnesses
  harnessDescriptor: typeof import('../../bridge/engines/harness-engine.ts').harnessDescriptor
  TerminalSession: typeof import('../../bridge/terminal-session.ts').TerminalSession
  agentEntry: typeof import('../fixtures/limits.ts').agentEntry
  writeLimits: typeof import('../fixtures/limits.ts').writeLimits
}
const opened: Array<{ close(): Promise<void> }> = []

if (LIVE) {
  // The caller's private folders; never the live runtime's home or tmux.
  const th = process.env.TANDEM_HOME
  const tmuxDir = process.env.TMUX_TMPDIR
  if (!th || !tmuxDir) throw new Error('relay.live: TANDEM_HOME and TMUX_TMPDIR must be set to private folders')
  const live = resolve(homedir(), '.tandem')
  if (resolve(th) === live || resolve(th).startsWith(live + sep)) throw new Error('relay.live: TANDEM_HOME is the live runtime home')
  delete process.env.TMUX
  delete process.env.TANDEM_HUB_LINK_URL
  delete process.env.TANDEM_HUB_LINK_TOKEN
  BOX = realpathSync(mkdtempSync(join(tmuxDir, 'r1a44-relay-')))
  process.env.TANDEM_ALLOW_BYPASS = '1'
  process.env.TANDEM_ENABLED_ENGINES = 'claude,codex'
  process.env.CCM_CWD_ALLOWLIST = BOX
  process.env.TANDEM_CWD_ALLOWLIST = BOX
  mods = {
    relay: await import('../../bridge/relay.ts'),
    limits: await import('../../bridge/limits.ts'),
    loadedHarnesses: (await import('../../bridge/engine-registry.ts')).loadedHarnesses,
    harnessDescriptor: (await import('../../bridge/engines/harness-engine.ts')).harnessDescriptor,
    TerminalSession: (await import('../../bridge/terminal-session.ts')).TerminalSession,
    agentEntry: (await import('../fixtures/limits.ts')).agentEntry,
    writeLimits: (await import('../fixtures/limits.ts')).writeLimits,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A work folder for one row, allowed by the limits file with prompts off (the relay needs permission_skip). */
function rowFolder(row: string): string {
  const work = join(BOX, row)
  mkdirSync(work, { recursive: true })
  const h = mods.loadedHarnesses()
  mods.writeLimits(process.env.TANDEM_HOME!, {
    folders: [BOX], permission_skip: [BOX],
    agents: { claude: mods.agentEntry(h.get('claude')!), codex: mods.agentEntry(h.get('codex')!) },
  })
  mods.limits.applyLimits()
  return work
}

/** Opens one session of `agent` in `cwd` with prompts off; a sign-in screen closes it and fails the row, nothing typed. */
async function openChecked(agent: 'claude' | 'codex', name: string, cwd: string) {
  const h = mods.loadedHarnesses().get(agent)
  if (!h) throw new Error(`${agent}: harness file not loaded`)
  const s = await mods.TerminalSession.spawn({ name, cwd, allowlist: [BOX], descriptor: mods.harnessDescriptor(h, { skipPrompts: true }), allowBypass: true })
  opened.push(s)
  const end = Date.now() + 60_000
  let screen = ''
  while (Date.now() < end) {
    screen = await s.screen()
    if (SIGN_IN.test(screen)) {
      await s.close()
      throw new Error(`${agent}: needs sign-in`)
    }
    if (!(await s.isCurrentlyWorking()) && screen.trim() !== '') break
    await sleep(1000)
  }
  return s
}

const notesRight = (work: string) =>
  existsSync(join(work, 'NOTES.txt')) && readFileSync(join(work, 'NOTES.txt'), 'utf8').trim().split(/\r?\n/).map((l) => l.trim()).join('|') === 'alpha|beta'

afterAll(async () => {
  for (const s of opened) await s.close().catch(() => {})
})

describe.skipIf(!LIVE)('(44) A1.14 builder and reviewer relay, live', () => {
  it('(44) R1 claude pair through bridge/relay.ts: the reviewer answers quiet within 4 turns', async () => {
    const work = rowFolder('claude')
    // The sign-in check, before the relay types anything.
    const probe = await openChecked('claude', `r1a44-probe-c-${tag}`, work)
    await probe.close()
    const { loopId } = await mods.relay.startRelay({ goal: TASK, context: REVIEW, cwd: work, maxTurns: MAX_TURNS, allowlist: [BOX] })
    const end = Date.now() + ROW_MS
    let log = ''
    while (Date.now() < end) {
      const page = mods.relay.readSince(loopId, 0)
      log = page?.text ?? log
      const info = mods.relay.info(loopId)
      if (!info || !info.running || info.parked) break
      await sleep(5000)
    }
    const turns = (log.match(/^\[WORKER\]/gm) ?? []).length
    mods.relay.stop(loopId)
    expect(turns, log.slice(-4000)).toBeLessThanOrEqual(MAX_TURNS)
    const lead = log.split(/^\[(?:LEAD|WORKER|SYS)\]/m)
    expect(lead.some((block) => QUIET_LINE.test(block)), log.slice(-4000)).toBe(true)
    expect(notesRight(work)).toBe(true)
  }, ROW_MS + 120_000)

  it('(44) R2 codex pair: builder and reviewer turns end quiet; the reviewer answers quiet within 4 turns', async () => {
    const work = rowFolder('codex')
    const reviewer = await openChecked('codex', `r1a44-rev-x-${tag}`, work)
    const builder = await openChecked('codex', `r1a44-bld-x-${tag}`, work)
    let ask = `${REVIEW}\n\nGOAL: ${TASK}\n\nReply now with your first instruction for the builder.`
    const statuses: string[] = []
    let finished = false
    for (let turn = 1; turn <= MAX_TURNS && !finished; turn++) {
      const review = await reviewer.send(ask)
      statuses.push(`reviewer:${review.status}`)
      if (QUIET_LINE.test(review.report)) {
        finished = true
        break
      }
      const built = await builder.send(review.report.trim())
      statuses.push(`builder:${built.status}`)
      ask = `The builder ran your instruction and reported:\n"""\n${built.report.trim()}\n"""\nReview it against the GOAL (${TASK}). Reply with the next single instruction, or quiet on its own line when the goal is met.`
    }
    if (!finished) {
      const last = await reviewer.send(ask)
      statuses.push(`reviewer:${last.status}`)
      finished = QUIET_LINE.test(last.report)
    }
    expect(finished, statuses.join(' ')).toBe(true)
    // Every turn ended by itself: a send that came back `running` hit the wait cap, not the end of the turn.
    expect(statuses.filter((s) => s.endsWith(':running')), statuses.join(' ')).toEqual([])
    expect(notesRight(work)).toBe(true)
  }, ROW_MS + 120_000)
})
