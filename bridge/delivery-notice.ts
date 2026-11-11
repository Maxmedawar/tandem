/**
 * delivery-notice.ts: how an agent with mail learns of it when no tool call is coming (plan
 * section 3, "How a message reaches an agent"). One fixed line, noticeLine(n), is typed into a
 * live session only when the input gate (./input-gate.ts) admits an agent's text there: a settled
 * idle prompt. A working, unknown or approval screen holds it; nothing else is ever typed, and
 * message text, senders and ids never are. The agent reads the mail with `mail_read`.
 *
 * Hook and notice agents are treated alike: the line wakes an idle hook agent, whose own hooks then
 * hand the mail over (claim and read are each one UPDATE, so a message arrives once). A shell
 * (deliveryClass 'none') and relay sessions are never typed into. mailbox.noticeFor types the
 * line once per newest queued message across every process sharing the file; mail the agent never
 * reads gives no second line.
 */
import { audit } from './audit.ts'
import { admitInput } from './input-gate.ts'
import type { Mailbox } from './mailbox.ts'
import { getLive, liveSessionNames } from './sessions.ts'

/** The only text the notice ever types. */
export function noticeLine(n: number): string {
  return `Tandem: ${n} messages waiting. Call mail_read.`
}

/** One pass over the live sessions; the line is started, never awaited, so a long turn holds no pass. */
export async function noticePass(box: Mailbox): Promise<{ typed: string[]; held: string[] }> {
  const typed: string[] = []
  const held: string[] = []
  for (const name of liveSessionNames()) {
    const session = getLive(name)
    if (!session || name.startsWith('relay-')) continue
    const cls = (session as { deliveryClass?: () => string }).deliveryClass
    if (typeof cls !== 'function' || cls.call(session) === 'none') continue
    const p = box.pending(name)
    if (p.fyi + p.ask + p.interrupt === 0) continue
    const { verdict } = await admitInput(session, 'agent', 'type')
    if (verdict !== 'enter') {
      held.push(name)
      continue
    }
    const n = box.noticeFor(name)
    if (n === 0) continue
    audit({ event: 'mail.notice', name, engine: session.engine, n })
    session.send(noticeLine(n)).catch(() => audit({ event: 'mail.notice', name, failed: true }))
    typed.push(name)
  }
  return { typed, held }
}

/** A pass every `everyMs` (unref'd); a pass still running when the timer fires is skipped. Returns stop. */
export function startNotices(box: Mailbox, everyMs = 5000): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    noticePass(box)
      .catch(() => console.error('tandem mail notice: pass failed'))
      .finally(() => {
        running = false
      })
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
