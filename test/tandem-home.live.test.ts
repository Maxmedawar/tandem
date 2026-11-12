/**
 * U-R1A-HOMEPATH live probe (TANDEM_LIVE=1 only; skipped otherwise). A live run keeps the real HOME
 * (agent logins), so test/setup-home.ts must still give it a made tandem-test-th- TANDEM_HOME under
 * the test temp root. This file writes one audit line, one events line and the owner id through
 * Tandem's own writers and finds them in that folder. It imports no router, session, tmux or
 * harness code: no agent program, model turn or sign-in can start. Its guard runs before any write,
 * and it reads only files under the made folder.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { tandemHome } from '../bridge/tandem-home.ts'
import { audit } from '../bridge/audit.ts'
import { emitCompletion } from '../bridge/events.ts'
import { loadOrCreateOwnerId } from '../bridge/ownership.ts'

const MARK = 'r1a-homepath-live-probe'

describe.skipIf(process.env.TANDEM_LIVE !== '1')('(HOMEPATH) live: Tandem writers land in the made TANDEM_HOME', () => {
  it('(HOMEPATH) L1 audit, events and owner-id go to a tandem-test-th- folder in tmpdir(), outside the real home', async () => {
    // GUARD FIRST: any of these false throws before anything is written.
    const th = process.env.TANDEM_HOME
    if (th === undefined) throw new Error('TANDEM_HOME is not set')
    if (!basename(th).startsWith('tandem-test-th-')) throw new Error('TANDEM_HOME is not a made tandem-test-th- folder')
    if (dirname(th) !== tmpdir()) throw new Error('TANDEM_HOME is not directly in tmpdir()')
    const rel = relative(realpathSync(userInfo().homedir), realpathSync(th))
    if (rel === '' || !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) throw new Error('TANDEM_HOME is inside the real home')
    if (tandemHome() !== resolve(th)) throw new Error('tandemHome() is not the made TANDEM_HOME')
    if (process.env.TANDEM_DONE_WEBHOOK !== undefined || process.env.TANDEM_NTFY_TOPIC !== undefined) throw new Error('a webhook or ntfy topic is set')

    audit({ event: MARK })
    emitCompletion({ type: 'session', id: MARK, cursor: 0, summary: MARK, silent: true })
    await loadOrCreateOwnerId()

    const read = (name: string) => readFileSync(join(th, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(read('bridge.log').some((l) => l.event === MARK), 'audit line in TANDEM_HOME/bridge.log').toBe(true)
    expect(read('events.log').some((l) => l.id === MARK), 'events line in TANDEM_HOME/events.log').toBe(true)
    expect(statSync(join(th, 'owner-id')).mode & 0o777, 'TANDEM_HOME/owner-id mode').toBe(0o600)
    console.log(`LIVE-TH ${th}`)
  })
})
