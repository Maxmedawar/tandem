/**
 * U-R1A-36E: the hub's cap on commands per target computer (src/command-cap.ts): at most 60 in any
 * rolling 60 s per target, held in memory (a Durable Object restart forgets it). The counting is a
 * pure module (no cloudflare:workers import) so it runs in this plain-node vitest, as
 * src/tunnel-routing.ts does; tunnel-do.ts calls take() in remoteCommand right before forward.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMAND_WINDOW_MS, CommandCap, MAX_COMMANDS_PER_TARGET } from '../src/command-cap.ts'

const fake = (start = 1_000_000) => {
  const clock = { t: start }
  return { clock, cap: new CommandCap(() => clock.t) }
}

describe('(36E) the per-target command cap', () => {
  it('(36E) (h1) 60 take("beta") within 60 s are true, the 61st is false', () => {
    const { clock, cap } = fake()
    for (let i = 0; i < 60; i++) {
      expect([i, cap.take('beta')]).toEqual([i, true])
      clock.t += 900
    }
    expect(clock.t - 1_000_000).toBeLessThan(60_000)
    expect(cap.take('beta')).toBe(false)
  })

  it('(36E) (h2) take("alpha") is true while beta is full', () => {
    const { cap } = fake()
    for (let i = 0; i < 60; i++) cap.take('beta')
    expect(cap.take('beta')).toBe(false)
    expect(cap.take('alpha')).toBe(true)
    expect(cap.take('beta')).toBe(false)
  })

  it('(36E) (h3) at first + 60,001 ms one more take is true; a false take records nothing', () => {
    const { clock, cap } = fake()
    const first = clock.t
    expect(cap.take('beta')).toBe(true)
    clock.t += 10_000
    for (let i = 0; i < 59; i++) expect(cap.take('beta')).toBe(true)
    // Refused several times: none of them is recorded.
    for (let i = 0; i < 5; i++) expect(cap.take('beta')).toBe(false)
    clock.t = first + 60_000
    expect(cap.take('beta')).toBe(true)
    expect(cap.take('beta')).toBe(false)
    // Moving past the first time freed exactly one slot (taken above); the next 59 free at first + 10,000 + 60,000.
    clock.t = first + 60_001
    expect(cap.take('beta')).toBe(false)
    clock.t = first + 10_000 + 60_000
    for (let i = 0; i < 59; i++) expect([i, cap.take('beta')]).toEqual([i, true])
    expect(cap.take('beta')).toBe(false)
  })

  it('(36E) (h3) a fresh cap: the slot of the first time is free at first + 60,001 ms', () => {
    const { clock, cap } = fake()
    const first = clock.t
    expect(cap.take('beta')).toBe(true)
    clock.t += 1_000
    for (let i = 0; i < 59; i++) expect(cap.take('beta')).toBe(true)
    expect(cap.take('beta')).toBe(false)
    clock.t = first + 60_001
    expect(cap.take('beta')).toBe(true)
    expect(cap.take('beta')).toBe(false)
  })

  it('(36E) (h4) the constants are 60 and 60,000; the module holds no cloudflare: import', () => {
    expect([MAX_COMMANDS_PER_TARGET, COMMAND_WINDOW_MS]).toEqual([60, 60_000])
    const text = readFileSync(fileURLToPath(new URL('../src/command-cap.ts', import.meta.url)), 'utf8')
    expect(text.includes('cloudflare:')).toBe(false)
  })
})
