/**
 * readers/codex.ts: finds and reads one Codex session's own rollout file, ported from Synergy
 * bridge/codex-history.ts (`messageText`, `isRealMessage`, `readRollout`, `collectRollouts`).
 * Codex keeps each session in `<root>/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; its first line is
 * `session_meta` with the session's id and cwd. Only that first line of a recent rollout is read
 * to find a session's file (Tandem never lists agents' history).
 */
import type { Stats } from 'node:fs'
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Message } from '../index.ts'

export const agent = 'codex'

const created = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs)
/** A session_meta line carries Codex's instructions; past this many bytes it is not one. */
const FIRST_LINE_MAX = 4 * 1024 * 1024

/** rollout-*.jsonl paths under root (anchored on the base name, so a `rollout-` folder never matches). */
async function collectRollouts(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = (await readdir(root, { recursive: true })) as string[]
  } catch {
    return []
  }
  return entries.filter((p) => p.endsWith('.jsonl') && basename(p).startsWith('rollout-')).map((p) => join(root, p))
}

/** The file's first line, read in 64 KiB steps, never past FIRST_LINE_MAX. */
async function firstLine(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65_536)
    for (let at = 0; at < FIRST_LINE_MAX; ) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, at)
      if (bytesRead === 0) break
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
      chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : bytesRead)))
      if (nl >= 0) break
      at += bytesRead
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** The earliest rollout created at or after `sinceMs - 2000` whose session_meta cwd is `cwd` or its realpath, not taken. */
export async function locate(root: string, cwd: string, sinceMs: number, taken: Set<string>): Promise<string | undefined> {
  const cwds = new Set([cwd])
  try {
    cwds.add(await realpath(cwd))
  } catch {
    /* the folder is gone: its given spelling only */
  }
  const recent: { path: string; at: number }[] = []
  for (const path of await collectRollouts(root)) {
    if (taken.has(path)) continue
    try {
      const st = await lstat(path)
      if (st.isFile() && created(st) >= sinceMs - 2000) recent.push({ path, at: created(st) })
    } catch {
      /* gone since the listing */
    }
  }
  recent.sort((a, b) => a.at - b.at)
  for (const { path } of recent) {
    try {
      const o = JSON.parse(await firstLine(path)) as { type?: unknown; payload?: { cwd?: unknown } }
      if (o?.type === 'session_meta' && typeof o.payload?.cwd === 'string' && cwds.has(o.payload.cwd)) return path
    } catch {
      /* not a rollout we can read */
    }
  }
  return undefined
}

/** The concatenated text of a codex message content array. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join(' ')
    .trim()
}

/** A user/assistant message that is real conversation, not the environment/permissions preamble. */
function isRealMessage(text: string): boolean {
  if (!text) return false
  return !text.startsWith('<environment_context') && !text.startsWith('<permissions')
}

/** readRollout's rules: session_meta id and cwd; user and assistant messages, preamble skipped. Never throws. */
export async function readMessages(path: string): Promise<{ id: string; cwd: string; messages: Message[] }> {
  let id = ''
  let cwd = ''
  const messages: Message[] = []
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    /* no file: no messages */
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const payload = (o['payload'] ?? {}) as Record<string, unknown>
    if (o['type'] === 'session_meta') {
      if (typeof payload['id'] === 'string') id = payload['id'] as string
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string
    } else if (o['type'] === 'response_item' && payload['type'] === 'message') {
      const role = payload['role']
      if (role !== 'user' && role !== 'assistant') continue
      const text = messageText(payload['content'])
      if (isRealMessage(text)) messages.push({ role, text })
    }
  }
  // The id from the file name (rollout-<time>-<uuid>.jsonl) when session_meta has none.
  if (!id) id = basename(path).match(/rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/)?.[1] ?? ''
  return { id, cwd, messages }
}
