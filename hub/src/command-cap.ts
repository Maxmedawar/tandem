/**
 * command-cap.ts: the hub's cap on signed commands per target computer (U-R1A-36E). At most
 * MAX_COMMANDS_PER_TARGET commands to one computer in any rolling COMMAND_WINDOW_MS; one more is
 * refused (tunnel-do.ts answers 429 target_busy and sends no frame). Only commands that passed the
 * hub's own checks (roster, target online) are counted, whatever the target then answers.
 *
 * Held in memory only, in the TunnelDO instance: a Durable Object restart or eviction forgets the
 * counts (stated limit). A pure module with no Workers import, so the hub's plain-node tests load
 * it, as src/tunnel-routing.ts and src/frame-size.ts.
 */
export const MAX_COMMANDS_PER_TARGET = 60
export const COMMAND_WINDOW_MS = 60_000

export class CommandCap {
  private readonly times = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** True and one time recorded when `to` has room in the window; false and nothing recorded when it is full. */
  take(to: string): boolean {
    const now = this.now()
    const kept = (this.times.get(to) ?? []).filter((t) => t > now - COMMAND_WINDOW_MS)
    if (kept.length >= MAX_COMMANDS_PER_TARGET) {
      this.times.set(to, kept)
      return false
    }
    kept.push(now)
    this.times.set(to, kept)
    return true
  }
}
