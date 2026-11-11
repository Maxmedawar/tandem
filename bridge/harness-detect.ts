/**
 * harness-detect.ts: reads an agent's state from its screen with the `states` rules of its
 * harness file (harnesses/SCHEMA.md). The rules are data and this is the one reader, so a new
 * agent needs no code. Patterns run only through re2js (linear time), so a slow or hostile
 * pattern cannot stall the bridge.
 */
import { RE2JS } from 're2js'
import type { Harness, StateName } from './harness-registry.ts'

export type ReadState = StateName | 'unknown'

type States = NonNullable<Harness['states']>
type Compiled = [StateName, RE2JS[]][]

const WINDOW_LINES = 40
/** The loader keeps only the pattern strings; each `states` object is compiled once. */
const compiledSets = new WeakMap<States, Compiled>()

function compiled(states: States): Compiled {
  let set = compiledSets.get(states)
  if (!set) {
    set = states.precedence.map((s) => [s, (states[s] ?? []).map((p) => RE2JS.compile(p, RE2JS.MULTILINE))])
    compiledSets.set(states, set)
  }
  return set
}

/** The last 40 lines, each without a trailing `\r`, once trailing blank lines are dropped. ANSI is left as is. */
function windowOf(screen: string): string {
  const lines = screen.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  while (lines.length > 0 && lines[lines.length - 1]!.trimEnd() === '') lines.pop()
  return lines.slice(-WINDOW_LINES).join('\n')
}

/** The first state in `precedence` with a matching pattern; no rules or no match is `unknown`. */
function readWindow(states: Harness['states'], window: string): ReadState {
  if (!states) return 'unknown'
  for (const [state, patterns] of compiled(states)) {
    if (patterns.some((re) => re.matcher(window).find())) return state
  }
  return 'unknown'
}

/** Pure, no debounce. */
export function readScreen(harness: Pick<Harness, 'states'>, screen: string): ReadState {
  return readWindow(harness.states, windowOf(screen))
}

/**
 * A raw `idle` is returned only once the window text has stayed the same for `debounce_ms`
 * (an agent's screen can look idle while it is busy); until then the previous result stands
 * (`unknown` at first). Every other state is returned at once.
 */
export function createStateReader(harness: Pick<Harness, 'states'>, now: () => number = Date.now): { observe(screen: string): ReadState } {
  let last: ReadState = 'unknown'
  let seen: string | undefined
  let since = 0
  return {
    observe(screen: string): ReadState {
      const window = windowOf(screen)
      const t = now()
      if (window !== seen) { seen = window; since = t }
      const raw = readWindow(harness.states, window)
      if (raw !== 'idle' || t - since >= harness.states!.debounce_ms) last = raw
      return last
    },
  }
}
