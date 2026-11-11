/**
 * U-R1A-28: every delivered message is labelled untrusted with its sender and grants nothing.
 * The hostile fixtures in test/fixtures/hostile-messages/ go down every path a message reaches an
 * agent: the hook (settings-file form for Claude, config-overrides form for Codex), the 27A notice
 * line and `mail_read`. Three rules close the U-R1A-25 audit gaps: no delivery inside a sub-agent
 * (a hook stdin with `agent_id`), one hook answer holds at most 8 KiB of message text (or one
 * message alone), and bidi control characters are refused at send. The 27B audit's G2: mail
 * presses a session's interrupt key at most once per 10 s window (startNotices).
 *
 * tmux runs only on a private socket: before any import TMUX is unset and TMUX_TMPDIR is a new
 * r1a28- folder; TANDEM_HOME, HOME (the audit log) and empty CLAUDE_CONFIG_DIR and CODEX_HOME live
 * in it too. afterAll kills that folder's tmux servers (after `test -S`) and removes it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.sh', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/hostile-messages/', import.meta.url))
const BUILTIN = fileURLToPath(new URL('../harnesses/', import.meta.url))
const BOX = mkdtempSync(join(tmpdir(), 'r1a28-'))
delete process.env.TMUX
process.env.TMUX_TMPDIR = BOX
const TH = join(BOX, 'tandem')
process.env.TANDEM_HOME = TH
const HOME = join(BOX, 'home')
const WORK = join(BOX, 'work')
for (const d of [HOME, WORK, join(BOX, 'claude-config'), join(BOX, 'codex-home'), join(BOX, 'bin')]) mkdirSync(d)
process.env.HOME = HOME
process.env.CLAUDE_CONFIG_DIR = join(BOX, 'claude-config')
process.env.CODEX_HOME = join(BOX, 'codex-home')

const dh = await import('../bridge/delivery-hooks.ts')
const { noticePass, startNotices } = await import('../bridge/delivery-notice.ts')
const { openMailbox, MailError, UNTRUSTED_MAIL } = await import('../bridge/mailbox.ts')
const { HarnessSession } = await import('../bridge/engines/harness-engine.ts')
const { registerLive, unregisterLive } = await import('../bridge/sessions.ts')
const { loadHarnesses } = await import('../bridge/harness-registry.ts')
const { applyLimits, limitsSnapshot } = await import('../bridge/limits.ts')
const { writeLimits } = await import('./fixtures/limits.ts')
const { buildMcpServer } = await import('../src/mcp-server.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

writeLimits(TH, { interrupt_from: ['owner'] })
applyLimits()
const LIMITS_BEFORE = structuredClone(limitsSnapshot())

const box = openMailbox()

afterAll(() => {
  box.close()
  for (const sock of [join(BOX, `tmux-${process.getuid!()}`, 'default'), join(TH, 'tmux', 'tandem')]) {
    if (spawnSync('test', ['-S', sock]).status === 0) spawnSync('tmux', ['-S', sock, 'kill-server'])
  }
  rmSync(BOX, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fixtures by number ('01' to '09'), read as UTF-8. */
const FX: Record<string, string> = Object.fromEntries(readdirSync(FIXTURES).map((f) => [f.slice(0, 2), readFileSync(join(FIXTURES, f), 'utf8')]))
const SENT = ['01', '02', '03', '04', '05', '06', '07']
const firstLine = (t: string) => t.split('\n').find((l) => l !== '')!

const ALICE = 'session:alice'
const send = (to: string, text: string, from = ALICE, level: 'fyi' | 'ask' | 'interrupt' = 'fyi') => box.send({ from, to, level, text }).id
const stateOf = (id: string, from = ALICE) => box.sent(from, 500).find((m) => m.id === id)?.state
function refusal(fn: () => unknown): { status?: number; message?: string } {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(MailError)
    return { status: (e as InstanceType<typeof MailError>).status, message: (e as Error).message }
  }
  return {}
}

const auditLog = join(HOME, '.tandem', 'bridge.log')
const auditLines = (): Record<string, unknown>[] =>
  existsSync(auditLog) ? readFileSync(auditLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/* ---- the hook, both forms ---- */

function harness(name: string, delivery: 'hook' | 'notice', extra: Record<string, unknown> = {}): Json {
  return {
    name, program: '/usr/bin/true', programPath: '/usr/bin/true', args: [], skip_prompts_args: [], resume: [], fork: [],
    has_prompts: false, delivery, ...(delivery === 'hook' ? { hook: '--settings' } : {}), permission_hook: false,
    reports_context: false, source: 'owner', file: join(BOX, `${name}.toml`), kind: 'agent', ...extra,
  }
}
type Event = 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'Interrupt'
/** The settings-file form: the commands from the file installHook wrote. */
function installSettings(name: string): Record<Exclude<Event, 'Interrupt'>, string> {
  const json = JSON.parse(readFileSync(dh.installHook(harness(name, 'hook'), name)[1]!, 'utf8'))
  return {
    UserPromptSubmit: json.hooks.UserPromptSubmit[0].hooks[0].command,
    PostToolUse: json.hooks.PostToolUse[0].hooks[0].command,
    Stop: json.hooks.Stop[0].hooks[0].command,
  }
}
/** The config-overrides form (an in-test harness): the commands parsed back from the override values. */
function installOverrides(name: string): Record<Event, string> {
  const argv = dh.installHook(harness(name, 'hook', { hook: '--config', hook_format: 'config-overrides' }), name)
  const cmds = {} as Record<Event, string>
  for (const [i, e] of (['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'] as const).entries()) {
    cmds[e] = (parse(argv[2 * i + 1]!) as Json).hooks[e][0].hooks[0].command
  }
  return cmds
}
function run(cmd: string, stdin: unknown): { status: number | null; stdout: string } {
  const r = spawnSync('sh', ['-c', cmd], { input: JSON.stringify(stdin), encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, stdout: r.stdout }
}
/** Claude-shaped stdin (test/delivery-hooks.test.ts). */
const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, session_id: 'r1a28-sid', cwd: WORK, ...extra })
/** Codex-shaped stdin (test/delivery-codex.test.ts row e). */
const codexBase = (event: string) => ({ session_id: 'r1a28-sid', turn_id: 'r1a28-turn', transcript_path: null, cwd: WORK, hook_event_name: event, model: 'gpt-r1a28', permission_mode: 'default' })
const codexPost = (extra: Record<string, unknown> = {}) => ({ ...codexBase('PostToolUse'), tool_name: 'shell', tool_input: { command: ['echo', 'r1a28'] }, tool_response: 'r1a28', tool_use_id: 'r1a28-call', ...extra })
const codexStop = () => ({ ...codexBase('Stop'), stop_hook_active: false, last_assistant_message: 'done' })

/** Every key at any depth of a parsed answer. */
function keysDeep(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return []
  return Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)])
}
const BANNED = ['permissionDecision', 'continue', 'suppressOutput', 'systemMessage', 'updatedMCPToolOutput']

/** U-R1A-25's answer for one message, checked whole; returns the label text. */
function checkAnswer(stdout: string, event: 'PostToolUse' | 'Stop', name: string, id: string, fixture: string): string {
  expect(stdout.endsWith('\n')).toBe(true)
  expect(stdout.indexOf('\n')).toBe(stdout.length - 1)
  const out = JSON.parse(stdout)
  let text: string
  if (event === 'Stop') {
    expect(Object.keys(out)).toEqual(['decision', 'reason'])
    expect(out.decision).toBe('block')
    text = out.reason
  } else {
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(Object.keys(out.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext'])
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    text = out.hookSpecificOutput.additionalContext
  }
  const keys = keysDeep(out)
  for (const k of BANNED) expect(keys, k).not.toContain(k)
  const lines = text.split('\n')
  expect(lines[0]).toBe(`Tandem mail: 1 message(s) for session ${name}. ${UNTRUSTED_MAIL}`)
  const head = lines[1]!.match(/^<<<tandem-mail ([0-9a-f]{32}) 1\/1 from=session:alice level=fyi id=(\S+) sent=(\S+)>>>$/)
  expect(head, lines[1]).not.toBeNull()
  expect(head![2]).toBe(id)
  const nonce = head![1]!
  expect(fixture).not.toContain(nonce)
  const end = `<<<end tandem-mail ${nonce} 1/1>>>`
  expect(lines.at(-1)).toBe(end)
  expect(text.slice(lines[0]!.length + 1 + lines[1]!.length + 1, text.length - end.length - 1)).toBe(fixture)
  return text
}
const contextOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext

describe('(a) send: bidi controls and escapes refused; 01-07 accepted', () => {
  it('08 -> 400 bidi, nothing saved, one audit line; every bidi control alone refused; 09 -> 400 control character; 01-07 queued', () => {
    const before = auditLines().length
    expect(refusal(() => send('r1a28-08', FX['08']!))).toEqual({ status: 400, message: 'text: a bidi control character; nothing was saved' })
    expect(box.pending('r1a28-08')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    const lines = auditLines().slice(before)
    expect(lines).toEqual([expect.objectContaining({ event: 'mail.send', to: 'r1a28-08', state: 'denied', status: 400 })])
    for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(refusal(() => send('r1a28-08', `a${String.fromCodePoint(cp)}b`)), cp.toString(16)).toEqual({ status: 400, message: 'text: a bidi control character; nothing was saved' })
    }
    expect(box.pending('r1a28-08')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    expect(refusal(() => send('r1a28-09', FX['09']!))).toEqual({ status: 400, message: 'text: a control character (only newline and tab are allowed); nothing was saved' })
    expect(box.pending('r1a28-09')).toEqual({ fyi: 0, ask: 0, interrupt: 0 })
    for (const n of SENT) {
      const id = send(`r1a28-a${n}`, FX[n]!)
      expect(stateOf(id), n).toBe('queued')
      expect(box.read(`r1a28-a${n}`, 10).map((m) => m.text)).toEqual([FX[n]])
    }
  })
})

let auditAtB = 0

describe('(b) HOOK path, settings-file form: each fixture alone, PostToolUse and Stop', () => {
  it('one JSON line, exact keys, the label from UNTRUSTED_MAIL, the real header and end marker around the unchanged fixture', () => {
    auditAtB = auditLines().length
    for (const n of SENT) {
      const name = `r1a28-${n}`
      const cmds = installSettings(name)
      const id = send(name, FX[n]!)
      const r = run(cmds.PostToolUse, claude('PostToolUse', { tool_name: 'Bash' }))
      expect(r.status).toBe(0)
      const text = checkAnswer(r.stdout, 'PostToolUse', name, id, FX[n]!)
      if (n === '01' || n === '02') {
        const fake = firstLine(FX[n]!)
        expect(text.indexOf(text.split('\n')[1]!)).toBeLessThan(text.indexOf(fake))
      }
      expect(stateOf(id)).toBe('delivered')
      const id2 = send(name, FX[n]!)
      const s = run(cmds.Stop, claude('Stop', { stop_hook_active: false }))
      expect(s.status).toBe(0)
      checkAnswer(s.stdout, 'Stop', name, id2, FX[n]!)
      expect(stateOf(id2)).toBe('delivered')
    }
  }, 120_000)
})

describe('(c) HOOK path, config-overrides form: 01, 02, 03 with Codex-shaped stdin', () => {
  it('the same answer through the commands installHook returns for hook_format config-overrides', () => {
    for (const n of ['01', '02', '03']) {
      const name = `r1a28-c${n}`
      const cmds = installOverrides(name)
      const id = send(name, FX[n]!)
      const r = run(cmds.PostToolUse, codexPost())
      expect(r.status).toBe(0)
      checkAnswer(r.stdout, 'PostToolUse', name, id, FX[n]!)
      const id2 = send(name, FX[n]!)
      const s = run(cmds.Stop, codexStop())
      expect(s.status).toBe(0)
      checkAnswer(s.stdout, 'Stop', name, id2, FX[n]!)
      expect([stateOf(id), stateOf(id2)]).toEqual(['delivered', 'delivered'])
    }
  }, 60_000)
})

describe('(d) MAIL_READ path', () => {
  it('the inbox answer for 01-07: { untrusted: UNTRUSTED_MAIL, messages }, 7 from session:alice, each text byte-equal to its fixture', async () => {
    const name = 'r1a28-read'
    for (const n of SENT) send(name, FX[n]!)
    const server = await buildMcpServer(undefined, undefined, box)
    const client = new Client({ name: 'r1a28', version: '0.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    try {
      const result = await client.callTool({ name: 'mail_read', arguments: { name } })
      const got = JSON.parse((result.content as { text: string }[])[0]!.text)
      expect(Object.keys(got).sort()).toEqual(['messages', 'untrusted'])
      expect(got.untrusted).toBe(UNTRUSTED_MAIL)
      expect(got.messages).toHaveLength(7)
      expect(got.messages.map((m: Json) => m.from)).toEqual(Array(7).fill(ALICE))
      expect(got.messages.map((m: Json) => m.level)).toEqual(Array(7).fill('fyi'))
      got.messages.forEach((m: Json, i: number) => expect(Buffer.from(m.text, 'utf8').equals(Buffer.from(FX[SENT[i]!]!, 'utf8')), SENT[i]).toBe(true))
    } finally {
      await client.close()
      await server.close()
    }
  })
})

/* ---- the notice path over the fake agent ---- */

const SOCK = join(TH, 'tmux', 'tandem')
const STATES = {
  working: ['^fake is thinking\\z'], idle: ['^fake>\\z'], waiting_for_approval: ['\\(y/n\\)\\z'],
  debounce_ms: 300, precedence: ['waiting_for_approval', 'working', 'idle'],
}
function screenOf(name: string): string {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'capture-pane', '-p', '-J', '-S', '-', '-t', `=ccm-${name}:`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
const noticeLines = (name: string) => screenOf(name).split('\n').filter((l) => l.startsWith('reply: Tandem:'))

describe('(e) NOTICE path', () => {
  it('01-07 queued: one pass types exactly `Tandem: 7 messages waiting. Call mail_read.`; no fixture line reaches the screen', async () => {
    const name = 'r1a28-notice'
    const s = await HarnessSession.spawn(
      { ...harness('r1a28-fake', 'notice'), program: FAKE, programPath: FAKE, has_prompts: true, states: STATES },
      { name, cwd: WORK, allowlist: [WORK] },
    )
    registerLive(s)
    try {
      const end = Date.now() + 30_000
      while (Date.now() < end && (await s.inputState()).state !== 'idle') await sleep(150)
      expect((await s.inputState()).state).toBe('idle')
      for (const n of SENT) send(name, FX[n]!)
      expect(await noticePass(box)).toEqual({ typed: [name], held: [] })
      const until = Date.now() + 15_000
      while (Date.now() < until && noticeLines(name).length < 1) await sleep(100)
      await sleep(800)
      expect(noticeLines(name)).toEqual(['reply: Tandem: 7 messages waiting. Call mail_read.'])
      const screen = screenOf(name)
      for (const n of SENT) expect(screen.includes(firstLine(FX[n]!)), n).toBe(false)
      expect(box.pending(name).fyi).toBe(7)
    } finally {
      unregisterLive(name)
      await s.close()
    }
  }, 60_000)
})

describe('(f) GRANTS NOTHING', () => {
  it('limits unchanged; session:evil still 403 on interrupt; no fixture ever counted as Interrupt; only mail.send and mail.notice audit lines', () => {
    expect(limitsSnapshot()).toStrictEqual(LIMITS_BEFORE)
    expect(refusal(() => send('r1a28-01', 'stop', 'session:evil', 'interrupt'))).toEqual({
      status: 403, message: 'interrupt_from: session:evil may not send Interrupt (limits file); nothing was saved',
    })
    for (const n of SENT) {
      expect(box.interruptFor(`r1a28-${n}`), n).toBe(false)
      expect(box.interruptFor(`r1a28-a${n}`), n).toBe(false)
    }
    for (const name of ['r1a28-c01', 'r1a28-c02', 'r1a28-c03', 'r1a28-read', 'r1a28-notice']) expect(box.interruptFor(name), name).toBe(false)
    const during = auditLines().slice(auditAtB)
    expect(during.length).toBeGreaterThan(0)
    expect([...new Set(during.map((l) => l.event))].sort()).toEqual(['mail.notice', 'mail.send'])
  })
})

describe('(g) SUB-AGENT (gap 3): a hook run with agent_id claims nothing and prints nothing', () => {
  it('settings-file form: PostToolUse and Stop with agent_id print nothing, the fyi stays queued, the turn reads working; without it or null: delivered', () => {
    const name = 'r1a28-sub'
    const cmds = installSettings(name)
    expect(run(cmds.Stop, claude('Stop', { stop_hook_active: false })).stdout).toBe('')
    expect(dh.turnState(name)).toBe('idle')
    const id = send(name, 'r1a28 sub fyi')
    const post = run(cmds.PostToolUse, claude('PostToolUse', { tool_name: 'Bash', agent_id: 'a1' }))
    expect([post.status, post.stdout]).toEqual([0, ''])
    expect(stateOf(id)).toBe('queued')
    expect(dh.turnState(name)).toBe('working')
    const stop = run(cmds.Stop, claude('Stop', { stop_hook_active: false, agent_id: 'a1' }))
    expect([stop.status, stop.stdout]).toEqual([0, ''])
    expect(stateOf(id)).toBe('queued')
    expect(dh.turnState(name)).toBe('working')
    expect(contextOf(run(cmds.PostToolUse, claude('PostToolUse', { agent_id: null })).stdout)).toContain('r1a28 sub fyi')
    expect(stateOf(id)).toBe('delivered')
    const id2 = send(name, 'r1a28 sub fyi 2')
    expect(contextOf(run(cmds.PostToolUse, claude('PostToolUse')).stdout)).toContain('r1a28 sub fyi 2')
    expect(stateOf(id2)).toBe('delivered')
  }, 60_000)

  it('config-overrides form: PostToolUse with agent_id and agent_type prints nothing, still queued; without them delivered', () => {
    const name = 'r1a28-subc'
    const cmds = installOverrides(name)
    const id = send(name, 'r1a28 subc fyi')
    const r = run(cmds.PostToolUse, codexPost({ agent_id: 'a1', agent_type: 'worker' }))
    expect([r.status, r.stdout]).toEqual([0, ''])
    expect(stateOf(id)).toBe('queued')
    expect(contextOf(run(cmds.PostToolUse, codexPost()).stdout)).toContain('r1a28 subc fyi')
    expect(stateOf(id)).toBe('delivered')
  }, 60_000)
})

describe('(h) BUDGET (gap 6): one hook answer holds at most 8192 bytes of message text, or one message alone', () => {
  const pad = (head: string, bytes: number) => head + 'x'.repeat(bytes - Buffer.byteLength(head))
  const blocks = (text: string) => [...text.matchAll(/^<<<tandem-mail [0-9a-f]{32} \d+\/\d+ /gm)].length

  it('10 of 500 bytes: all 10 in one answer, no `more` line', () => {
    const name = 'r1a28-h1'
    const cmds = installSettings(name)
    const ids = Array.from({ length: 10 }, (_, i) => send(name, pad(`h1 #${i} `, 500), 'owner'))
    const text = contextOf(run(cmds.PostToolUse, claude('PostToolUse')).stdout)
    expect(blocks(text)).toBe(10)
    expect(text).not.toContain('more message(s)')
    expect(ids.every((id) => stateOf(id, 'owner') === 'delivered')).toBe(true)
  })

  it('10 of fixture 06 (16384 bytes): 1 and `9 more`, then 1 and `8 more`', () => {
    const name = 'r1a28-h2'
    const cmds = installSettings(name)
    const ids = Array.from({ length: 10 }, () => send(name, FX['06']!, 'owner'))
    const first = contextOf(run(cmds.PostToolUse, claude('PostToolUse')).stdout)
    expect(first.split('\n')[0]).toBe(`Tandem mail: 1 message(s) for session ${name}. ${UNTRUSTED_MAIL}`)
    expect(blocks(first)).toBe(1)
    expect(first.split('\n').at(-1)).toBe('9 more message(s) wait for the next tool call or turn end.')
    expect(ids.map((id) => stateOf(id, 'owner'))).toEqual(['delivered', ...Array(9).fill('queued')])
    const second = contextOf(run(cmds.PostToolUse, claude('PostToolUse')).stdout)
    expect(blocks(second)).toBe(1)
    expect(second.split('\n').at(-1)).toBe('8 more message(s) wait for the next tool call or turn end.')
    expect(ids.map((id) => stateOf(id, 'owner'))).toEqual(['delivered', 'delivered', ...Array(8).fill('queued')])
  })

  it('3 of 4000 bytes then 1 of 500: 2 (8000 bytes) and `2 more`', () => {
    const name = 'r1a28-h3'
    const cmds = installSettings(name)
    const ids = [...[0, 1, 2].map((i) => send(name, pad(`h3 #${i} `, 4000), 'owner')), send(name, pad('h3 small ', 500), 'owner')]
    const text = contextOf(run(cmds.PostToolUse, claude('PostToolUse')).stdout)
    expect(text.split('\n')[0]).toBe(`Tandem mail: 2 message(s) for session ${name}. ${UNTRUSTED_MAIL}`)
    expect(blocks(text)).toBe(2)
    expect(text.split('\n').at(-1)).toBe('2 more message(s) wait for the next tool call or turn end.')
    expect(ids.map((id) => stateOf(id, 'owner'))).toEqual(['delivered', 'delivered', 'queued', 'queued'])
  })

  it('claim(.., 10, 0) and claim(.., 10, 1048577) throw the exact 400; nothing claimed', () => {
    const name = 'r1a28-h4'
    const id = send(name, 'h4', 'owner')
    for (const bad of [0, 1048577]) {
      expect(refusal(() => box.claim(name, 'tool_call', 10, bad)), String(bad)).toEqual({ status: 400, message: 'maxBytes: a whole number 1 to 1048576' })
    }
    expect(stateOf(id, 'owner')).toBe('queued')
    expect(box.claim(name, 'tool_call', 10, 1048576).map((m) => m.id)).toEqual([id])
  })
})

describe('(i) RELAY and unknown names', () => {
  it('mail to relay-x refused at send (unchanged); a hook run as relay-x or a name with no mail prints nothing', () => {
    expect(refusal(() => send('relay-x', FX['01']!))).toEqual({
      status: 400, message: 'to: a session name on this computer (A-Z a-z 0-9 . _ -, 1 to 256 bytes, not relay-); nothing was saved',
    })
    for (const name of ['relay-x', 'r1a28-nobody']) {
      const cmds = installSettings(name)
      for (const [c, e] of [[cmds.PostToolUse, 'PostToolUse'], [cmds.Stop, 'Stop']] as const) {
        const r = run(c, claude(e, { stop_hook_active: false }))
        expect([r.status, r.stdout], `${name} ${e}`).toEqual([0, ''])
      }
    }
  }, 30_000)
})

/* ---- G2 (27B audit): the interrupt cool-down ---- */

/** A registered stand-in reading `working`: counts key presses and typed text. */
function standIn(id: string, engine: string) {
  const presses = { n: 0 }
  const typed: string[] = []
  registerLive({
    id, engine, cwd: WORK, deliveryClass: () => 'notice',
    inputState: async () => ({ state: 'working', screen: 'x', debounceMs: 0 }),
    interrupt: async () => { presses.n++ },
    send: async (text: string) => { typed.push(text); return { status: 'done', report: '', cursor: 0 } },
  } as Json)
  return { presses, typed }
}

describe('(j) G2: mail presses a session\'s interrupt key at most once per 10 s window', () => {
  const T = 1_800_000_000_000

  it('two Interrupt mails 1 s apart: one press, the second stays queued; at 10 s one more press', async () => {
    let t = T
    const b = openMailbox({ path: join(BOX, 'g2', 'state.db'), now: () => t })
    const name = 'r1a28-g2'
    const st = standIn(name, 'r1a28-fake')
    const stop = startNotices(b, 20)
    try {
      b.send({ from: 'owner', to: name, level: 'interrupt', text: 'one' })
      await sleep(300)
      expect(st.presses.n).toBe(1)
      t = T + 1_000
      b.send({ from: 'owner', to: name, level: 'interrupt', text: 'two' })
      await sleep(300)
      expect(st.presses.n).toBe(1)
      t = T + 9_999
      await sleep(300)
      expect(st.presses.n).toBe(1)
      expect(b.pending(name).interrupt).toBe(2)
      t = T + 10_000
      await sleep(300)
      expect(st.presses.n).toBe(2)
      await sleep(300)
      expect(st.presses.n).toBe(2)
      expect(st.typed).toEqual([])
    } finally {
      stop()
      unregisterLive(name)
      b.close()
    }
  }, 30_000)

  it('claude, grok, copilot, cursor-agent (interrupt key C-c): five Interrupt mails inside 10 s give one press each', async () => {
    const { harnesses } = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, 'no-owner'), path: join(BOX, 'bin') })
    const engines = ['claude', 'grok', 'copilot', 'cursor-agent']
    for (const e of engines) {
      const key = harnesses.get(e)?.keys?.interrupt
      expect([key].flat(), e).toContain('C-c')
    }
    let t = T
    const b = openMailbox({ path: join(BOX, 'g2c', 'state.db'), now: () => t })
    const stands = engines.map((e) => ({ name: `r1a28-g2-${e}`, ...standIn(`r1a28-g2-${e}`, e) }))
    const stop = startNotices(b, 20)
    try {
      for (let k = 0; k < 5; k++) {
        t = T + k * 2_400
        for (const s of stands) b.send({ from: 'owner', to: s.name, level: 'interrupt', text: `stop ${k}` })
        await sleep(200)
      }
      expect(stands.map((s) => s.presses.n)).toEqual([1, 1, 1, 1])
    } finally {
      stop()
      for (const s of stands) unregisterLive(s.name)
      b.close()
    }
  }, 30_000)
})
