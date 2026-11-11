import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DrivableSession, EngineId } from '../bridge/drivable.ts'
import { resetHarnessCache } from '../bridge/engine-registry.ts'
import { listSessions, registerLive, unregisterLive } from '../bridge/sessions.ts'

const registered: string[] = []

function fakeSession(id: string, engine: EngineId, cwd = ''): DrivableSession {
  return {
    id,
    engine,
    cwd,
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: 'done', report: '', cursor: 0 }),
    read: async () => ({ text: '', cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => engine === 'hermes' ? `Hermes agent "${id}"` : `tmux attach -t ccm-${id}`,
  }
}

afterEach(() => {
  for (const id of registered.splice(0)) unregisterLive(id)
  vi.unstubAllEnvs()
  resetHarnessCache()
})

// U-R1A-11: an owner harness file `fake-agent` in a temporary TANDEM_HOME.
const HOME = mkdtempSync(join(tmpdir(), 'r1a11-listing-'))
afterAll(() => rmSync(HOME, { recursive: true, force: true }))
mkdirSync(join(HOME, 'harnesses'))
chmodSync(join(HOME, 'harnesses'), 0o700)
writeFileSync(join(HOME, 'harnesses', 'fake-agent.toml'), 'name = "fake-agent"\nprogram = "fake-agent"\nhas_prompts = false\n', { mode: 0o600 })

describe('listSessions privacy and admission filters', () => {
  it('includes an explicitly attached live Hermes registry session without discovering gateway history', async () => {
    const session = fakeSession('agent-a', 'hermes')
    registerLive(session)
    registered.push(session.id)
    const result = await listSessions({
      enabledEngines: new Set(['claude', 'hermes']),
      allowlist: ['/allowed'],
      listingDependencies: { tmuxFn: async () => '' },
    })
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'agent-a', engine: 'hermes', project: 'hermes', live: true }),
    ])
  })

  it('excludes raw tmux rows for disabled engines, disallowed cwd, bad provenance, and relay internals', async () => {
    const rows = [
      'ccm-good\t100\t/allowed/project',
      'ccm-disabled\t101\t/allowed/project',
      'ccm-outside\t102\t/private/project',
      'ccm-bad-owner\t103\t/allowed/project',
      'ccm-relay-loop-lead\t104\t/allowed/project',
    ].join('\n')
    const provenance: Record<string, { engine: string; owner: string }> = {
      good: { engine: 'claude', owner: 'owner-a' },
      disabled: { engine: 'codex', owner: 'owner-a' },
      outside: { engine: 'claude', owner: 'owner-a' },
      'bad-owner': { engine: 'claude', owner: 'owner-b' },
    }
    const result = await listSessions({
      enabledEngines: new Set(['claude']),
      allowlist: ['/allowed'],
      listingDependencies: {
        ownerIdProvider: async () => 'owner-a',
        tmuxFn: async () => rows,
        provenanceReader: async (name) => provenance[name] ?? { engine: '', owner: '' },
      },
    })
    expect(result.sessions.map((s) => s.id)).toEqual(['good'])
  })

  it('deduplicates a registered tmux session against the restart inventory row', async () => {
    const session = fakeSession('same', 'claude', '/allowed/project')
    registerLive(session)
    registered.push(session.id)
    const result = await listSessions({
      enabledEngines: new Set(['claude']),
      allowlist: ['/allowed'],
      listingDependencies: {
        ownerIdProvider: async () => 'owner-a',
        tmuxFn: async () => 'ccm-same\t100\t/allowed/project',
        provenanceReader: async () => ({ engine: 'claude', owner: 'owner-a' }),
      },
    })
    expect(result.sessions.filter((s) => s.id === 'same')).toHaveLength(1)
  })

  describe('harness sessions (U-R1A-11)', () => {
    const rows = [
      'ccm-fa-live\t200\t/allowed/project',
      'ccm-nobody\t201\t/allowed/project',
      'ccm-cl\t202\t/allowed/project',
    ].join('\n')
    const provenance: Record<string, { engine: string; owner: string }> = {
      'fa-live': { engine: 'fake-agent', owner: 'owner-a' },
      nobody: { engine: 'no-such-agent', owner: 'owner-a' },
      cl: { engine: 'claude', owner: 'owner-a' },
    }
    const listingDependencies = {
      ownerIdProvider: async () => 'owner-a',
      tmuxFn: async () => rows,
      provenanceReader: async (name: string) => provenance[name] ?? { engine: '', owner: '' },
    }
    function withHarness(enabled: string | undefined) {
      vi.stubEnv('TANDEM_HOME', HOME)
      vi.stubEnv('TANDEM_ENABLED_ENGINES', enabled)
      resetHarnessCache()
      const session = fakeSession('fa-reg', 'fake-agent', '/allowed/project')
      registerLive(session)
      registered.push(session.id)
    }

    it('a fake-agent session with the owner tag lists when enabled (live row and registered session)', async () => {
      withHarness('fake-agent')
      const result = await listSessions({ allowlist: ['/allowed'], listingDependencies })
      expect(result.sessions.map((s) => [s.id, s.engine]).sort()).toEqual([
        ['cl', 'claude'],
        ['fa-live', 'fake-agent'],
        ['fa-reg', 'fake-agent'],
      ])
    })

    it('a fake-agent session does not list when disabled', async () => {
      withHarness(undefined)
      const result = await listSessions({ allowlist: ['/allowed'], listingDependencies })
      expect(result.sessions.map((s) => s.id)).toEqual(['cl'])
    })

    it('a tag naming no harness and no built-in never lists, even in the enabled set', async () => {
      withHarness('fake-agent')
      const result = await listSessions({
        allowlist: ['/allowed'],
        enabledEngines: new Set(['claude', 'fake-agent', 'no-such-agent']),
        listingDependencies,
      })
      expect(result.sessions.map((s) => s.id)).not.toContain('nobody')
      expect(result.sessions.map((s) => s.id).sort()).toEqual(['cl', 'fa-live', 'fa-reg'])
    })

    it('claude rows are unchanged', async () => {
      withHarness(undefined)
      const result = await listSessions({ allowlist: ['/allowed'], listingDependencies })
      expect(result.sessions).toEqual([
        {
          id: 'cl',
          engine: 'claude',
          project: 'project',
          cwd: '/allowed/project',
          live: true,
          updatedAt: 202_000,
          attachHint: "tmux attach -t '=ccm-cl'",
        },
      ])
    })
  })
})
