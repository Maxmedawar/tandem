/**
 * readers/claude.ts: finds and reads one Claude Code session's own history file, ported from
 * Synergy bridge/sessions.ts (`extractText`, `readHistoryFile`). Claude Code keeps each session in
 * `<root>/<slug of its cwd>/<session id>.jsonl`. Only the session's own slug folders are read: never
 * the root, never another project's folder (Tandem never lists agents' history).
 */
import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Message } from '../index.ts'

export const agent = 'claude'

const created = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs)

/** Claude Code's project folder name: every character outside A-Z a-z 0-9 becomes `-`. */
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

/** The earliest `*.jsonl` in the cwd's slug folders created at or after `sinceMs - 2000`, not taken. */
export async function locate(root: string, cwd: string, sinceMs: number, taken: Set<string>): Promise<string | undefined> {
  const folders = new Set<string>()
  try {
    folders.add(join(root, slug(await realpath(cwd))))
  } catch {
    /* the folder is gone: its given spelling only */
  }
  folders.add(join(root, slug(cwd)))
  let best: { path: string; at: number } | undefined
  for (const dir of folders) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const path = join(dir, n)
      if (!n.endsWith('.jsonl') || taken.has(path)) continue
      try {
        const st = await lstat(path)
        const at = created(st)
        if (st.isFile() && at >= sinceMs - 2000 && (!best || at < best.at)) best = { path, at }
      } catch {
        /* gone since the listing */
      }
    }
  }
  return best?.path
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join(' ')
      .trim()
  }
  return ''
}

/** The user and assistant texts in order; bad lines and empty texts skipped. Never throws. */
export async function readMessages(path: string): Promise<{ id: string; cwd: string; messages: Message[] }> {
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
    if (!cwd && typeof o['cwd'] === 'string') cwd = o['cwd'] as string
    const role = o['type']
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractText((o['message'] as { content?: unknown } | undefined)?.content)
    if (text) messages.push({ role, text })
  }
  return { id: basename(path).replace(/\.jsonl$/, ''), cwd, messages }
}
