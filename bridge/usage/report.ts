/**
 * report.ts: the answer of the `usage` tool (src/mcp-server.ts, and the hub's through
 * bridge/hub-rpc.ts): per account of every agent on the owner's computers, the 5-hour and 7-day
 * shares and reset times, the plan, tokens and cost, each reading's age and the computer the share
 * reading came from. Read only: it reads this computer's store (bridge/usage/store.ts) and what the
 * other computers sent inside their signed presence (bridge/hub-presence.ts readRemoteUsage).
 *
 * Merge: every remote time counts on this computer's clock from no later than its arrival. The
 * share reading of an account is the freshest one of any computer (a tie: this computer, then the
 * lower id); tokens and cost are summed over the computers that have numbers (each computer's
 * ccusage reads only its own logs). A window past its reset reads used null (unknown), never 0. A
 * reading over STALE_MS old is stale and the notices say so. most_room names per agent the account
 * with the most room: 100 minus the higher share, fresh readings only.
 *
 * refresh: true first re-reads this computer's drops and rollouts (collectUsage), then tokens when
 * the newest token row is at least REFRESH_MIN_MS old (read from state.db, so the gate holds across
 * the bridge and every stdio server), waiting at most REFRESH_WAIT_MS for them. Other computers'
 * readings come with their next presence push. Every string in an answer is a name, a reason or one
 * of the notice templates: no session text, path or model. `now` is the only clock.
 */
import { hostname } from 'node:os'
import { deriveBridgeId } from '../hub-link.ts'
import { readRemoteUsage, usageWire, type UsageWire } from '../hub-presence.ts'
import type { Harness } from '../harness-registry.ts'
import { CCUSAGE_AGENTS, REFRESH_MIN_MS, refreshTokens, type TokenOptions } from './ccusage.ts'
import { collectUsage } from './collector.ts'
import { STALE_MS, tokenRows } from './store.ts'

export const REFRESH_WAIT_MS = 30_000

export type Remote = { computer: string; receivedMs: number; rows: UsageWire[] }
export type UsageWindow = { used: number | null; resets_at: number | null }
export type UsageAccount = {
  agent: string; account: string; computer: string | null; at: number | null; ageMs: number | null; stale: boolean
  five_hour: UsageWindow; seven_day: UsageWindow; plan: string | null; room: number | null
  tokens: { today: number; total: number } | null; cost_usd: { today: number; total: number } | null
  tokens_at: number | null; tokens_age_ms: number | null; tokens_computers: string[]; tokens_note: string | null; limit_note: string | null
}
export type MostRoom = { agent: string; account: string | null; computer: string | null; room: number | null }
export type UsageAnswer = { computer: string; at: number; accounts: UsageAccount[]; most_room: MostRoom[]; notices: string[] }
export type UsageReport = { read(o?: { refresh?: boolean }): Promise<UsageAnswer> }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const mins = (ms: number) => Math.floor(ms / 60_000)
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'
}

/** The answer from this computer's rows and the other computers' (pure). */
export function buildReport(input: { now: number; computer: string; local: UsageWire[]; remote: Remote[] }): UsageAnswer {
  const { now, computer } = input
  type Seen = { computer: string; row: UsageWire; at: number | null; tokensAt: number | null }
  const byAccount = new Map<string, Seen[]>()
  const add = (s: Seen) => {
    const key = JSON.stringify([s.row.agent, s.row.account])
    byAccount.set(key, [...(byAccount.get(key) ?? []), s])
  }
  for (const row of input.local) add({ computer, row, at: row.at, tokensAt: row.tokens_at })
  for (const r of input.remote) {
    const upTo = (t: number | null) => (t === null ? null : Math.min(t, r.receivedMs))
    for (const row of r.rows) add({ computer: r.computer, row, at: upTo(row.at), tokensAt: upTo(row.tokens_at) })
  }
  const rank = (s: Seen) => (s.computer === computer ? '' : `~${s.computer}`)

  const accounts: UsageAccount[] = []
  for (const seen of byAccount.values()) {
    const { agent, account } = seen[0].row
    const share = seen.filter((s) => s.at !== null).sort((a, b) => b.at! - a.at! || cmp(rank(a), rank(b)))[0]
    const win = (used: number | null, resets: number | null): UsageWindow => ({ used: resets === null || resets <= now ? null : used, resets_at: resets })
    const five = share ? win(share.row.five_used, share.row.five_resets) : { used: null, resets_at: null }
    const seven = share ? win(share.row.seven_used, share.row.seven_resets) : { used: null, resets_at: null }
    const withNumbers = seen.filter((s) => s.row.tokens_today !== null).sort((a, b) => cmp(a.computer, b.computer))
    const failed = seen.filter((s) => s.row.reason !== null).sort((a, b) => cmp(a.computer, b.computer))
    // The oldest token reading counted (so the age never overstates freshness); with no numbers, the oldest failed run.
    const timed = (withNumbers.length > 0 ? withNumbers : seen).map((s) => s.tokensAt).filter((t): t is number => t !== null)
    const tokensAt = timed.length > 0 ? Math.min(...timed) : null
    const sum = (k: 'tokens_today' | 'tokens_total' | 'cost_today' | 'cost_total') => withNumbers.reduce((n, s) => n + (s.row[k] as number), 0)
    const ageMs = share ? now - share.at! : null
    const tokensAge = tokensAt === null ? null : now - tokensAt
    const stale = ageMs !== null ? ageMs > STALE_MS : tokensAge !== null && tokensAge > STALE_MS
    const shares = [five.used, seven.used].filter((u): u is number => u !== null)
    accounts.push({
      agent, account,
      computer: share ? share.computer : null, at: share ? share.at : null, ageMs, stale,
      five_hour: five, seven_day: seven, plan: share ? share.row.plan : null,
      room: !stale && shares.length > 0 ? 100 - Math.max(...shares) : null,
      tokens: withNumbers.length > 0 ? { today: sum('tokens_today'), total: sum('tokens_total') } : null,
      cost_usd: withNumbers.length > 0 ? { today: sum('cost_today'), total: sum('cost_total') } : null,
      tokens_at: tokensAt, tokens_age_ms: tokensAge,
      tokens_computers: withNumbers.map((s) => s.computer),
      tokens_note: failed.length > 0 ? `tokens: not available on ${failed.map((s) => `${s.computer}: ${s.row.reason}`).join(', ')}` : null,
      limit_note: CCUSAGE_AGENTS[agent]?.limit === false ? 'limit: not available' : null,
    })
  }
  accounts.sort((a, b) => cmp(a.agent, b.agent) || cmp(a.account, b.account))

  const most_room: MostRoom[] = []
  for (const agent of [...new Set(accounts.map((a) => a.agent))]) {
    let best: UsageAccount | undefined
    for (const a of accounts) if (a.agent === agent && a.room !== null && (best === undefined || a.room > best.room!)) best = a
    most_room.push(best ? { agent, account: best.account, computer: best.computer, room: best.room } : { agent, account: null, computer: null, room: null })
  }

  const notices: string[] = []
  for (const a of accounts) {
    if (a.stale && a.ageMs !== null) notices.push(`stale: ${a.agent} account ${a.account} (read on ${a.computer}) has not reported for ${mins(a.ageMs)} min; its shares may be out of date`)
    else if (a.stale) notices.push(`stale: ${a.agent} account ${a.account} tokens were last read ${mins(a.tokens_age_ms!)} min ago`)
    for (const [name, w] of [['five_hour', a.five_hour], ['seven_day', a.seven_day]] as const) {
      if (a.at !== null && w.resets_at !== null && w.resets_at <= now) notices.push(`unknown: ${a.agent} account ${a.account} ${name} passed its reset; its share is unknown until the next reading`)
    }
  }
  for (const m of most_room) {
    if (m.room === null && accounts.find((a) => a.agent === m.agent)!.limit_note === null) notices.push(`room: no ${m.agent} account has a fresh share`)
  }
  return { computer, at: now, accounts, most_room, notices }
}

/** The usage report of this computer; `remote` and the clock are seams for tests. */
export function createUsageReport(opts: {
  now?: () => number; computer?: string; harnesses?: Iterable<Harness>; ccusage?: TokenOptions
  remote?: () => Remote[]; refreshWaitMs?: number
} = {}): UsageReport {
  const now = opts.now ?? Date.now
  const computer = opts.computer ?? deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname())
  const remote = opts.remote ?? (() => readRemoteUsage({ self: computer }))
  return {
    async read(o = {}) {
      const late: string[] = []
      if (o.refresh) {
        let limits: string | undefined
        try {
          collectUsage(now(), opts.harnesses)
        } catch (e) {
          limits = `refresh: limits could not be re-read (${codeOf(e)})`
        }
        const rows = tokenRows()
        const newest = rows.length === 0 ? undefined : Math.max(...rows.map((r) => r.read_ms))
        // Another process read them under a minute ago: no run (the gate is the store's, not this process's).
        if (newest === undefined || now() - newest >= REFRESH_MIN_MS) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const waited = new Promise<'late'>((resolve) => {
            timer = setTimeout(() => resolve('late'), opts.refreshWaitMs ?? REFRESH_WAIT_MS)
            timer.unref()
          })
          // The pass that outlives the wait keeps running and records when done.
          const outcome = await Promise.race([refreshTokens(now(), { ...opts.ccusage, ...(opts.harnesses ? { harnesses: opts.harnesses } : {}) }), waited])
          clearTimeout(timer)
          if (outcome === 'late') late.push('refresh: tokens are still being read; each token reading shows its age')
        }
        if (limits) late.push(limits)
      }
      // As who_is_up's others: a remote read that fails gives none and one stderr line; this computer's rows still answer.
      let others: Remote[] = []
      try {
        others = remote()
      } catch (e) {
        process.stderr.write(`usage: other computers' readings could not be read (${codeOf(e)})\n`)
      }
      const answer = buildReport({ now: now(), computer, local: usageWire(now()), remote: others })
      answer.notices.push(...late)
      return answer
    },
  }
}
