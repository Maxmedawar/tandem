/**
 * U-R1A-45: packaging/hub-deploy.sh deploys the hub (hub/) under a NEW Worker name: it checks the
 * login, refuses a name that already has a Worker, creates the OAuth KV namespace, puts the two
 * secrets and deploys, in that order. `--dry-run` only builds the bundle.
 *
 * Everything runs in one box (BOX): HOME is BOX/home and wrangler is a stub (TANDEM_WRANGLER) that
 * appends one line per call to BOX/w.log: its argv joined by spaces, a tab, and the BYTE COUNT of
 * its stdin (never the bytes). The real openssl makes the secrets. No real wrangler runs here.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'r1a45-')))
const HOME = join(BOX, 'home')
const TMP = join(BOX, 'tmp')
const STUB = join(BOX, 'stubs', 'wrangler')
const LOG = join(BOX, 'w.log')
const repo = fileURLToPath(new URL('..', import.meta.url))
const script = join(repo, 'packaging', 'hub-deploy.sh')
const hubConfig = join(repo, 'hub', 'wrangler.jsonc')
const KV = '0123456789abcdef0123456789abcdef'
const OLD_LINE = 'setup: this is the old Tailscale path; the R1a path is ./setup.sh r1a (see README)'

mkdirSync(join(BOX, 'stubs'))
writeFileSync(STUB, `#!/bin/sh
bytes=$(wc -c | tr -d ' ')
printf '%s\\t%s\\n' "$*" "$bytes" >> "$STUB_LOG"
case "$1 $2" in
  "whoami "*) echo "You are logged in with an API Token, associated with the email someone@example.com." ;;
  "deployments list")
    if [ "\${STUB_EXISTS:-0}" = 1 ]; then echo "Created: 2026-11-12T00:00:00Z"; exit 0; fi
    if [ "\${STUB_LIST_ERR:-0}" = 1 ]; then echo "fetch failed" >&2; exit 1; fi
    echo "not found" >&2; exit 1 ;;
  "kv namespace")
    if [ "\${STUB_KV_FAIL:-0}" = 1 ]; then echo "kv namespace create failed" >&2; exit 1; fi
    printf '[[kv_namespaces]]\\nbinding = "OAUTH_KV"\\nid = "${KV}"\\n' ;;
  "deploy "*) echo "Deployed tandem-x triggers"; echo "  https://tandem-x.example.workers.dev" ;;
esac
exit 0
`)
chmodSync(STUB, 0o755)

afterAll(() => {
  chmodSync(BOX, 0o700)
  rmSync(BOX, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(HOME, { mode: 0o700 })
  mkdirSync(TMP, { mode: 0o700 })
  writeFileSync(LOG, '')
})

type Run = { status: number | null; out: string; err: string; all: string }
function run(cmd: string[], extra: Record<string, string> = {}): Run {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME, TMPDIR: TMP, TANDEM_WRANGLER: STUB, STUB_LOG: LOG, ...extra },
    timeout: 60_000,
  })
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const deploy = (args: string[], extra: Record<string, string> = {}) => run(['sh', script, ...args], extra)
const calls = () =>
  readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [argv, bytes] = line.split('\t')
    return { argv, bytes: Number(bytes) }
  })
const argvs = () => calls().map((c) => c.argv)
const secretsDir = join(HOME, '.tandem-hub', 'tandem-x')
const generated = join(secretsDir, 'wrangler.jsonc')
const mode = (p: string) => statSync(p).mode & 0o777
/** JSONC to JSON: comments and trailing commas out, strings kept as they are. */
const jsonc = (text: string) =>
  JSON.parse(
    text
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s: string | undefined) => s ?? '')
      .replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (_m, s: string | undefined) => s ?? ''),
  )
const DRY = /^deploy --dry-run --outdir (\S+)\/out --config (\S+)\/wrangler\.jsonc$/

describe('(45) h: a real run against the stub', () => {
  it('(45) h1 whoami, deployments list, kv create, two secret puts and deploy, in that order', () => {
    const r = deploy(['--name', 'tandem-x'])
    expect(r.status, r.all).toBe(0)
    expect(argvs()).toEqual([
      'whoami',
      'deployments list --name tandem-x',
      'kv namespace create OAUTH_KV_tandem_x',
      `secret put TANDEM_HUB_PASSWORD --name tandem-x --config ${generated}`,
      `secret put TANDEM_HUB_LINK_TOKEN --name tandem-x --config ${generated}`,
      `deploy --config ${generated}`,
    ])
    expect(calls()[3].bytes).toBeGreaterThanOrEqual(24)
    expect(calls()[4].bytes).toBeGreaterThanOrEqual(16)
    expect(r.out).toContain('hub-deploy: deployed tandem-x')
    expect(r.out).toContain('hub-deploy: connector URL https://tandem-x.example.workers.dev/mcp')
    expect(r.out).toContain(`hub-deploy: owner password file ${secretsDir}/hub-password`)
    expect(r.out).toContain(`hub-deploy: link token file ${secretsDir}/link-token (give it to scripts/cutover.sh --hub-token-file)`)
  })

  it('(45) h2 both secrets are 0600 files in a 0700 folder and appear in no log or output line', () => {
    const r = deploy(['--name', 'tandem-x'])
    expect(r.status, r.all).toBe(0)
    expect(mode(secretsDir)).toBe(0o700)
    const password = readFileSync(join(secretsDir, 'hub-password'), 'utf8')
    const token = readFileSync(join(secretsDir, 'link-token'), 'utf8')
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    for (const f of ['hub-password', 'link-token', 'wrangler.jsonc']) expect(mode(join(secretsDir, f))).toBe(0o600)
    for (const value of [password, token]) {
      expect(readFileSync(LOG, 'utf8')).not.toContain(value)
      expect(r.out).not.toContain(value)
      expect(r.err).not.toContain(value)
      expect(readFileSync(generated, 'utf8')).not.toContain(value)
    }
    expect(calls()[3].bytes).toBe(password.length)
    expect(calls()[4].bytes).toBe(token.length)
  })

  it('(45) h3 the generated config: the new name, the KV id, the Durable Object setup as in hub/wrangler.jsonc', () => {
    const before = readFileSync(hubConfig)
    const r = deploy(['--name', 'tandem-x'])
    expect(r.status, r.all).toBe(0)
    const hub = jsonc(before.toString('utf8'))
    const made = JSON.parse(readFileSync(generated, 'utf8'))
    expect(made.name).toBe('tandem-x')
    expect(made.kv_namespaces).toEqual([{ binding: 'OAUTH_KV', id: KV }])
    expect(made.durable_objects).toEqual(hub.durable_objects)
    expect(made.migrations).toEqual(hub.migrations)
    expect(made.main).toBe(join(repo, 'hub', hub.main))
    expect(made.alias.zod).toBe(join(repo, 'hub', 'node_modules', 'zod'))
    expect(made.vars).toEqual(hub.vars)
    expect(readFileSync(hubConfig).equals(before)).toBe(true)
  })

  it('(45) h4 a retry with the same name reuses the kept secrets; a Worker already there is refused', () => {
    expect(deploy(['--name', 'tandem-x']).status).toBe(0)
    const password = readFileSync(join(secretsDir, 'hub-password'), 'utf8')
    const token = readFileSync(join(secretsDir, 'link-token'), 'utf8')
    writeFileSync(LOG, '')
    const refused = deploy(['--name', 'tandem-x'], { STUB_EXISTS: '1' })
    expect(refused.status).toBe(1)
    expect(refused.all).toContain('hub-deploy: a Worker named tandem-x already exists; pick a new name')
    expect(argvs()).toEqual(['whoami', 'deployments list --name tandem-x'])
    chmodSync(join(secretsDir, 'link-token'), 0o644)
    writeFileSync(LOG, '')
    // A retry after a run that stopped before its deploy: the Worker is still not there.
    const again = deploy(['--name', 'tandem-x'])
    expect(again.status, again.all).toBe(0)
    expect(readFileSync(join(secretsDir, 'hub-password'), 'utf8')).toBe(password)
    expect(readFileSync(join(secretsDir, 'link-token'), 'utf8')).toBe(token)
    expect(mode(join(secretsDir, 'link-token'))).toBe(0o600)
    expect(calls()[3].bytes).toBe(password.length)
    expect(calls()[4].bytes).toBe(token.length)
  })

  it('(45) h5 --dry-run: one wrangler deploy --dry-run in a private folder that is gone after; nothing kept', () => {
    const r = deploy(['--name', 'tandem-x', '--dry-run'])
    expect(r.status, r.all).toBe(0)
    const lines = argvs()
    expect(lines).toHaveLength(1)
    const m = DRY.exec(lines[0])
    expect(m, lines[0]).not.toBeNull()
    expect(m![1]).toBe(m![2])
    expect(m![1].startsWith(`${TMP}/`)).toBe(true)
    expect(existsSync(m![1])).toBe(false)
    expect(readdirSync(TMP)).toEqual([])
    expect(existsSync(join(HOME, '.tandem-hub'))).toBe(false)
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('hub-deploy: dry run: nothing was created')
  })
})

describe('(45) a: audit cases', () => {
  it('(45) a1 the default secrets folder is outside ~/.tandem-next (cutover.sh owns and purges that one)', () => {
    const r = deploy(['--name', 'tandem-x'])
    expect(r.status, r.all).toBe(0)
    expect(existsSync(join(HOME, '.tandem-hub', 'tandem-x', 'link-token'))).toBe(true)
    expect(existsSync(join(HOME, '.tandem-next'))).toBe(false)
  })

  it('(45) a2 deployments list fails for another reason than "no such Worker": step 2 failed, nothing made', () => {
    const r = deploy(['--name', 'tandem-x'], { STUB_LIST_ERR: '1' })
    expect(r.status, r.all).toBe(1)
    expect(r.err).toContain('hub-deploy: step 2 failed')
    expect(argvs()).toEqual(['whoami', 'deployments list --name tandem-x'])
    expect(existsSync(join(HOME, '.tandem-hub'))).toBe(false)
  })

  it('(45) a3 a relative --secrets-dir is refused before any wrangler call (it would land in the repo)', () => {
    const r = deploy(['--name', 'tandem-x', '--secrets-dir', 'r1a45-rel'])
    expect(r.status, r.all).toBe(1)
    expect(r.err).toContain('hub-deploy: --secrets-dir must be an absolute path')
    expect(argvs()).toEqual([])
    expect(existsSync(join(repo, 'r1a45-rel'))).toBe(false)
  })
})

describe('(45) r: refusals', () => {
  it('(45) r1 --name cloud-code-mcp is refused before any wrangler call', () => {
    const r = deploy(['--name', 'cloud-code-mcp'])
    expect(r.status).toBe(1)
    expect(r.err.trimEnd()).toBe('hub-deploy: cloud-code-mcp is the old hub; this script never deploys over it')
    expect(argvs()).toEqual([])
  })

  it('(45) r2 a Worker of that name already exists: refused after whoami and the list, nothing made', () => {
    const r = deploy(['--name', 'tandem-x'], { STUB_EXISTS: '1' })
    expect(r.status).toBe(1)
    expect(r.all).toContain('hub-deploy: a Worker named tandem-x already exists; pick a new name')
    expect(argvs()).toEqual(['whoami', 'deployments list --name tandem-x'])
    expect(existsSync(join(HOME, '.tandem-hub'))).toBe(false)
  })

  it('(45) r3 names off the rule and a missing --name are refused before any wrangler call', () => {
    for (const args of [['--name', 'Tandem-x'], ['--name', 'tandem_'], ['--name', 'x-tandem'], ['--name', `tandem-${'a'.repeat(41)}`], ['--name', 'tandem-'], [], ['--dry-run']]) {
      const r = deploy(args)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.err.trimEnd().split('\n')).toHaveLength(1)
      expect(r.err).toMatch(/^hub-deploy: /)
    }
    expect(argvs()).toEqual([])
  })

  it('(45) r4 kv namespace create fails: step 3 failed, no secret put, no deploy', () => {
    const r = deploy(['--name', 'tandem-x'], { STUB_KV_FAIL: '1' })
    expect(r.status).toBe(1)
    expect(r.all).toContain('hub-deploy: step 3 failed')
    expect(argvs()).toEqual(['whoami', 'deployments list --name tandem-x', 'kv namespace create OAUTH_KV_tandem_x'])
  })

  it('(45) r5 an unknown option: rc 2, no wrangler call', () => {
    const r = deploy(['--name', 'tandem-x', '--force'])
    expect(r.status).toBe(2)
    expect(r.err).toMatch(/^hub-deploy: /)
    expect(argvs()).toEqual([])
  })
})

describe('(45) s: setup.sh', () => {
  it('(45) s1 ./setup.sh r1a --name tandem-x --dry-run runs hub-deploy.sh: the same one dry-run call', () => {
    const r = run(['bash', join(repo, 'setup.sh'), 'r1a', '--name', 'tandem-x', '--dry-run'])
    expect(r.status, r.all).toBe(0)
    const lines = argvs()
    expect(lines).toHaveLength(1)
    expect(DRY.test(lines[0]), lines[0]).toBe(true)
    expect(r.out).toContain('hub-deploy: dry run: nothing was created')
    expect(readdirSync(TMP)).toEqual([])
  })

  it('(45) s2 ./setup.sh hub prints the old-path line first on stderr', () => {
    const r = run(['bash', join(repo, 'setup.sh'), 'hub'], { TANDEM_CWD_ALLOWLIST: '' })
    expect(r.status).not.toBe(0)
    expect(r.err.split('\n')[0]).toBe(OLD_LINE)
    expect(r.all).toContain('TANDEM_CWD_ALLOWLIST is required')
    expect(existsSync(join(HOME, '.tandem'))).toBe(false)
    expect(argvs()).toEqual([])
  })
})

describe('(45) d: docs', () => {
  it('(45) d1 README: one marker pair around one fenced sh block; every tailscale mention under the old setup', () => {
    const text = readFileSync(join(repo, 'README.md'), 'utf8')
    const lines = text.split('\n')
    const open = lines.flatMap((l, i) => (l === '<!-- r1a-first-commands -->' ? [i] : []))
    const close = lines.flatMap((l, i) => (l === '<!-- /r1a-first-commands -->' ? [i] : []))
    expect(open).toHaveLength(1)
    expect(close).toHaveLength(1)
    expect(text.split('r1a-first-commands').length - 1).toBe(2)
    const inside = lines.slice(open[0] + 1, close[0])
    const fences = inside.filter((l) => l.startsWith('```'))
    expect(fences).toEqual(['```sh', '```'])
    const old = lines.indexOf('## Old setup (Tailscale)')
    expect(old).toBeGreaterThan(close[0])
    const next = lines.findIndex((l, i) => i > old && l.startsWith('## '))
    const end = next === -1 ? lines.length : next
    const outside = lines.flatMap((l, i) => (/tailscale/i.test(l) && (i < old || i >= end) ? [`${i + 1}: ${l}`] : []))
    expect(outside).toEqual([])
  })

  it('(45) d2 SETUP.md names setup.sh r1a before its first tailscale', () => {
    const text = readFileSync(join(repo, 'SETUP.md'), 'utf8')
    const r1a = text.indexOf('setup.sh r1a')
    const ts = text.search(/tailscale/i)
    expect(r1a).toBeGreaterThan(-1)
    expect(ts).toBeGreaterThan(-1)
    expect(r1a).toBeLessThan(ts)
  })
})
