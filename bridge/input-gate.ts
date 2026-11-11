/**
 * input-gate.ts: the input gate (plan section 3). Who is typing decides when typed input (send
 * text with its per-send controls, and interrupt keys) may enter a session; route() in
 * ./router.ts asks the gate right before it types anything.
 *
 * The owner types at any time except while the session waits for approval: text or interrupt
 * keys there would answer the prompt, and only a person answers one. An agent types only at a
 * settled idle prompt; otherwise its input is held: nothing is typed and nothing is queued (the
 * sender sends again later; queuing is the mailbox's). An agent never interrupts.
 *
 * The state comes from one fresh screen capture read by the agent's harness-file rules with no
 * debounce (HarnessSession.inputState). A session that cannot show its screen reads `unknown`,
 * which counts as idle for the owner and as busy for an agent.
 */
import type { ReadState } from './harness-detect.ts'

export type InputFrom = 'owner' | 'agent'
export type InputAction = 'type' | 'interrupt'
export type InputVerdict = 'enter' | 'held' | 'refused'
export interface InputRead { state: ReadState; screen: string; debounceMs: number }

/** The table. Anything but the owner gets an agent's rules. */
export function decideInput(from: InputFrom, action: InputAction, state: ReadState): InputVerdict {
  if (from === 'owner') return state === 'waiting_for_approval' ? 'refused' : 'enter'
  if (action === 'interrupt') return 'refused'
  return state === 'idle' ? 'enter' : 'held'
}

const POLL_MS = 250
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Screens compare without trailing whitespace, per line and at the end. */
const settled = (screen: string) => screen.replace(/[ \t]+$/gm, '').trimEnd()

const READ_MS = 2000
const UNREAD: InputRead = { state: 'unknown', screen: '', debounceMs: 0 }

/** One read. A session with no inputState, a read that fails, or one with no answer in 2000 ms
 *  is a screen the session cannot show: unknown. So no read can keep the gate waiting. */
function readInput(session: object): Promise<InputRead> {
  const s = session as { inputState?: () => Promise<InputRead> }
  if (typeof s.inputState !== 'function') return Promise.resolve(UNREAD)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<InputRead>((resolve) => {
    timer = setTimeout(() => resolve(UNREAD), READ_MS)
  })
  return Promise.race([s.inputState().catch(() => UNREAD), late]).finally(() => clearTimeout(timer))
}

/**
 * The verdict for one input. The owner and every interrupt: one read, then the table. An agent's
 * text: a first read that is not idle is held at once; at idle the screen is read again every
 * 250 ms and the text enters once the same screen has read idle for the file's debounce_ms (the
 * last read is the re-check right before typing). A changed idle screen restarts that wait; a
 * read that is not idle, or debounce_ms + 1000 ms in all, is held. Nothing waits longer than
 * that plus one poll and two reads of 2000 ms at most (the first, and the one under way).
 */
export async function admitInput(session: object, from: InputFrom, action: InputAction): Promise<{ verdict: InputVerdict; state: ReadState }> {
  const start = Date.now()
  const first = await readInput(session)
  const verdict = decideInput(from, action, first.state)
  if (from === 'owner' || action !== 'type' || verdict !== 'enter') return { verdict, state: first.state }
  let screen = settled(first.screen)
  let since = Date.now()
  for (;;) {
    await sleep(POLL_MS)
    const read = await readInput(session)
    if (read.state !== 'idle') return { verdict: 'held', state: read.state }
    const now = Date.now()
    const shown = settled(read.screen)
    if (shown !== screen) {
      screen = shown
      since = now
    } else if (now - since >= first.debounceMs) {
      return { verdict: 'enter', state: 'idle' }
    }
    if (now - start >= first.debounceMs + 1000) return { verdict: 'held', state: 'idle' }
  }
}
