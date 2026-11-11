/**
 * transcripts/redact.ts: masks secrets in text before it is stored, hashed or searched
 * (./search.ts). Each match becomes `[secret:<kind>]`. Patterns are compiled once and run only
 * through re2js (linear time on hostile text). `env` masks the exact value (12+ characters) of
 * every environment variable whose name holds a secret word, read at each call. No output, no
 * throw, no network.
 */
import { RE2JS } from 're2js'

const WORDS = ['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'CREDENTIAL']

interface Kind {
  kind: string
  re: RE2JS
  /** The group that is masked (0: the whole match). */
  group: number
  /** Matched on the copy with A-Z lowercased (same length, so every index holds): re2js runs `(?i)` far slower. */
  lower: boolean
  /** A match is impossible unless one of these is in the text: a pattern runs only when one is. */
  need: string[]
}

const kind = (k: string, source: string, need: string[], group = 0, lower = false): Kind => ({ kind: k, re: RE2JS.compile(source), group, lower, need })

/** Order matters: a specific kind before a general one. */
const KINDS: Kind[] = [
  kind('private-key', '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\\z)', ['PRIVATE KEY-----']),
  kind('aws-key', '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', ['AKIA', 'ASIA']),
  kind('github-token', '\\bgh[pousr]_[A-Za-z0-9]{36,255}\\b', ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']),
  kind('github-token', '\\bgithub_pat_[A-Za-z0-9_]{22,255}\\b', ['github_pat_']),
  kind('anthropic-key', '\\bsk-ant-[A-Za-z0-9_-]{20,}', ['sk-ant-']),
  kind('openai-key', '\\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}', ['sk-']),
  kind('slack-token', '\\bxox[abposr]-[A-Za-z0-9-]{10,}', ['xox']),
  kind('google-key', '\\bAIza[0-9A-Za-z_-]{35}', ['AIza']),
  kind('stripe-key', '\\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}', ['k_live_', 'k_test_']),
  kind('jwt', '\\beyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+', ['eyJ']),
  // A value already masked starts with `[`, so it is never masked twice.
  kind('bearer', 'authorization:\\s*bearer\\s+([^\\s"\'\\[][^\\s"\']*)', ['bearer'], 1, true),
  kind('url-password', '[A-Za-z][A-Za-z0-9+.-]*://[^\\s:/@]+:([^\\s/@\\[][^\\s/@]*)@', ['://'], 1),
  // The name must not follow `[`: a marker's own `[secret:` is never a name.
  kind(
    'assignment',
    `(?:^|[^a-z0-9_.\\[-])[a-z0-9_.-]*(?:${WORDS.join('|').toLowerCase()})[a-z0-9_.-]*["']?\\s*[=:]\\s*["']?([^\\s"'\\[][^\\s"']{7,})`,
    WORDS.map((w) => w.toLowerCase()),
    1,
    true,
  ),
]

/** Replaces every match's group with the kind's marker; returns the text and the count. */
function mask(text: string, k: Kind): [string, number] {
  const subject = k.lower ? text.replace(/[A-Z]+/g, (c) => c.toLowerCase()) : text
  if (!k.need.some((n) => subject.includes(n))) return [text, 0]
  const m = k.re.matcher(subject)
  let out = ''
  let last = 0
  let count = 0
  while (m.find()) {
    const start = m.start(k.group)
    const end = m.end(k.group)
    if (start >= last && end > start) {
      out += text.slice(last, start) + `[secret:${k.kind}]`
      last = end
      count++
    }
  }
  return count ? [out + text.slice(last), count] : [text, 0]
}

export function redact(text: string): { text: string; masked: number } {
  let out = typeof text === 'string' ? text : ''
  let masked = 0
  try {
    const values = new Set<string>()
    // Names first: reading every value is the slow part of process.env.
    for (const name of Object.keys(process.env)) {
      const upper = name.toUpperCase()
      if (!WORDS.some((w) => upper.includes(w))) continue
      const value = process.env[name]
      if (value && value.length >= 12) values.add(value)
    }
    // Longest first, so a value inside another is not masked out of it first.
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      const parts = out.split(value)
      if (parts.length > 1) {
        masked += parts.length - 1
        out = parts.join('[secret:env]')
      }
    }
    for (const k of KINDS) {
      const [next, count] = mask(out, k)
      out = next
      masked += count
    }
    return { text: out, masked }
  } catch {
    // Never return text that may hold an unmasked secret.
    return { text: '[secret:unreadable]', masked: masked + 1 }
  }
}
