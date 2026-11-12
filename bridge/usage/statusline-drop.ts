/**
 * statusline-drop.ts: the statusLine command Tandem puts in a Claude session's settings file
 * (bridge/delivery-hooks.ts installHook, harness field `usage = "statusline"`). Claude runs it at
 * each status update with the session's status as JSON on stdin:
 *
 *   '<node>' --experimental-strip-types '<this file>' '<account>' '<drop dir>' ['<chain file>']
 *
 * It keeps only `rate_limits.five_hour` and `.seven_day` (used share 0-100 and reset time in Unix
 * seconds) and the time, written to `<drop dir>/<account>.json` (folder 0700, file 0600, through a
 * rename); nothing else from the input is kept. An input with no valid window leaves the earlier
 * file as it was. Then it runs the owner's own statusLine command, saved in the chain file at
 * session start, with the same stdin bytes, and passes its stdout through unchanged: that is the
 * only thing this script prints on stdout. It always exits 0; on an error it writes one stderr line
 * with no input text and no path. Node built-ins only: it runs at every status update.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const MAX_STDIN = 1024 * 1024
const MAX_CHAIN = 64 * 1024
const CHAIN_MS = 10_000
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,63}$/
const WINDOWS = ['five_hour', 'seven_day'] as const

type Window = { used_percentage: number; resets_at: number }

/** All of stdin, or undefined (and the rest drained) once it passes 1 MiB. */
async function readStdin(): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length
    if (size <= MAX_STDIN) chunks.push(chunk as Buffer)
  }
  return size > MAX_STDIN ? undefined : Buffer.concat(chunks)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The valid windows of the input, numbers only; undefined when there is none. */
function windowsOf(input: Buffer): Partial<Record<(typeof WINDOWS)[number], Window>> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(input.toString('utf8')) } catch { return undefined }
  if (!isObject(parsed) || !isObject(parsed.rate_limits)) return undefined
  const limits = parsed.rate_limits
  const out: Partial<Record<(typeof WINDOWS)[number], Window>> = {}
  for (const k of WINDOWS) {
    const w = limits[k]
    if (!isObject(w)) continue
    const { used_percentage: used, resets_at: resets } = w
    if (finite(used) && used >= 0 && used <= 100 && finite(resets) && resets > 0) out[k] = { used_percentage: used, resets_at: resets }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The drop folder, made 0700 when missing; refused when a symlink, another user's or open to group or world. */
function dropDir(dir: string): void {
  try { lstatSync(dir) } catch { mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  const st = lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) throw Object.assign(new Error('refused'), { code: 'EREFUSED' })
}

function writeDrop(dir: string, account: string, windows: Partial<Record<(typeof WINDOWS)[number], Window>>): void {
  dropDir(dir)
  const file = join(dir, `${account}.json`)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify({ at: Date.now(), rate_limits: windows })}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** The owner's own command from the chain file (a regular file of this user's, at most 64 KiB), run with the same stdin. */
function runChain(chain: string, input: Buffer): void {
  const st = lstatSync(chain)
  if (!st.isFile() || st.uid !== process.getuid!() || st.size > MAX_CHAIN) throw Object.assign(new Error('refused'), { code: 'EREFUSED' })
  const command = readFileSync(chain, 'utf8')
  const r = spawnSync('/bin/sh', ['-c', command], { input, timeout: CHAIN_MS, maxBuffer: MAX_CHAIN, stdio: ['pipe', 'pipe', 'ignore'] })
  if (r.stdout && r.stdout.length > 0) {
    const out = r.stdout.subarray(0, MAX_CHAIN)
    for (let done = 0; done < out.length;) done += writeSync(1, out, done)
  }
}

function fail(e: unknown): void {
  const code = (e as { code?: unknown } | undefined)?.code
  writeSync(2, `tandem usage statusline: failed (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'error'})\n`)
}

async function main([account, dir, chain]: string[]): Promise<void> {
  const input = await readStdin()
  let failed = false
  try {
    const windows = input && windowsOf(input)
    if (windows && account && ACCOUNT.test(account) && dir && isAbsolute(dir)) writeDrop(dir, account, windows)
  } catch (e) {
    failed = true
    fail(e)
  }
  try {
    if (chain && isAbsolute(chain)) runChain(chain, input ?? Buffer.alloc(0))
  } catch (e) {
    if (!failed) fail(e)
  }
}

main(process.argv.slice(2)).catch(() => { /* nothing more to say */ }).finally(() => {
  process.exitCode = 0
})
