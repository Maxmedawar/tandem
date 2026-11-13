/**
 * transcripts/redact.ts: masks secrets in text before it is stored, hashed or searched
 * (./search.ts). Each match becomes `[secret:<kind>]`. Patterns are compiled once and run only
 * through re2js (linear time on hostile text). `env` masks the exact value of every environment
 * variable whose name holds a secret word, read at each call. No output, no throw, no network.
 *
 * Matching runs on a folded copy of the text (compatibility forms such as full-width letters
 * folded to their plain form, invisible characters dropped), so a look-alike spelling or a
 * zero-width character inside a secret does not hide it; the text returned keeps every other
 * character as it was. All matches are found on the one copy and overlapping ones become one
 * marker, so no part of a secret is left beside a marker. An `env` value is also matched in any
 * letter case, across line breaks and spaces, and in its base64, URL-encoded and JSON-escaped
 * forms. A value under 12 characters is masked from 4 characters up, only where it stands alone
 * (no letter or digit beside it).
 */
import { RE2JS } from 're2js'

const WORDS = ['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'CREDENTIAL']
const ENV_MIN = 4
const ENV_ANYWHERE = 12
/** Short values that are settings, not secrets: masking them would hide ordinary words. */
const PLAIN = new Set(['true', 'false', 'none', 'null', 'enabled', 'disabled'])

/**
 * Raised whenever redact() starts masking more. The fabric store (bridge/fabric/sqlite-fabric-client.ts)
 * masks its stored rows again when the version it recorded is lower; U-R1A-39B does the same for the
 * transcript index.
 */
export const REDACT_VERSION = 1

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

/**
 * Order matters: where matches overlap, the marker names the first kind listed. `env` comes before all.
 * No pattern holds a choice of fixed words (`(?:live|test)`): for such a pattern re2js looks through
 * the whole rest of the text at every match, which took 40 s to 116 s on 1 MB of matches
 * (U-R1A-39-R1). A choice becomes a character class or one pattern per word.
 */
const KINDS: Kind[] = [
  kind('private-key', '-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|\\z)', ['PRIVATE KEY']),
  kind('aws-key', '\\bA[KS]IA[0-9A-Z]{16}\\b', ['AKIA', 'ASIA']),
  kind('github-token', '\\bgh[pousr]_[A-Za-z0-9]{36,255}\\b', ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']),
  kind('github-token', '\\bgithub_pat_[A-Za-z0-9_]{22,255}\\b', ['github_pat_']),
  kind('anthropic-key', '\\bsk-ant-[A-Za-z0-9_-]{20,}', ['sk-ant-']),
  kind('openai-key', '\\bsk-[A-Za-z0-9_-]{20,}', ['sk-']),
  kind('slack-token', '\\bxox[abposr]-[A-Za-z0-9-]{10,}', ['xox']),
  kind('google-key', '\\bAIza[0-9A-Za-z_-]{35}', ['AIza']),
  ...['live', 'test'].map((mode) => kind('stripe-key', `\\b[rs]k_${mode}_[0-9A-Za-z]{16,}`, [`k_${mode}_`])),
  kind('jwt', '\\beyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+', ['eyJ']),
  // A header in any spelling (`Authorization: Bearer x`, `"authorization": "Basic x"`), then a bare `Bearer <long value>`.
  ...['bearer', 'basic', 'token'].map((scheme) => kind('bearer', `authorization["']?\\s*[:=]\\s*["']?${scheme}\\s+([^\\s"']+)`, ['authorization'], 1, true)),
  kind('bearer', '\\bbearer\\s+([a-z0-9._~+/=-]{20,})', ['bearer'], 1, true),
  // Through the last `@` before the host's end, so a password holding `@` is masked whole.
  kind('url-password', '[A-Za-z][A-Za-z0-9+.-]*://[^\\s:/@]+:([^\\s/]+)@', ['://'], 1),
  // The value: a quoted string (spaces allowed) or everything up to the next white space.
  ...WORDS.map((w) => kind('assignment', `${w.toLowerCase()}[a-z0-9_.-]*["']?\\s*[=:]\\s*("[^"\\n]{8,}"|'[^'\\n]{8,}'|[^\\s]{8,})`, [w.toLowerCase()], 1, true)),
]
const ENV_RANK = -1

/** A marker already in the text. In the matching copy its inside is blanked, so its own words (`secret`, a kind's name) never match. */
const MARKER = /\[secret:[a-z-]+\]/g
/** Stands in the matching copy for text already settled (a marker's inside, a private key block): no pattern's word, never white space. */
const SETTLED = '\u0001'
/** As long as the shortest value masked after a name, so a value that is only a key block is still a value. */
const SETTLED_RUN = 8
/** Invisible characters: format characters (zero-width, soft hyphen, direction marks), joiners, variation selectors. */
const INVISIBLE = /[\p{Cf}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u
const lowerAZ = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase())

/** The matching copy: plain forms, no invisible characters. `at[i]` is where copy character i came from (absent: the text itself). */
function fold(text: string): { s: string; at?: number[] } {
  if (!/[^\x00-\x7f]/.test(text)) return { s: text }
  const parts: string[] = []
  const at: number[] = []
  let run = 0
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) < 128) {
      at.push(i++)
      continue
    }
    parts.push(text.slice(run, i))
    const c = String.fromCodePoint(text.codePointAt(i)!)
    if (!INVISIBLE.test(c)) {
      const plain = c.normalize('NFKC')
      parts.push(plain)
      for (let k = 0; k < plain.length; k++) at.push(i)
    }
    i += c.length
    run = i
  }
  parts.push(text.slice(run))
  return { s: parts.join(''), at }
}

/** The copy with white space dropped, for `env` values split over lines. `at[i]` is its index in the copy. */
function squeeze(s: string): { s: string; at: number[] } {
  const parts: string[] = []
  const at: number[] = []
  let run = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 32 && c < 128) {
      at.push(i)
      continue
    }
    if (c <= 32 || /\s/.test(s[i]!)) {
      parts.push(s.slice(run, i))
      run = i + 1
    } else at.push(i)
  }
  parts.push(s.slice(run))
  return { s: parts.join(''), at }
}

const alnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/** Every form an `env` value may be written in, folded as the text is. */
function envForms(): Set<string> {
  const forms = new Set<string>()
  // Names first: reading every value is the slow part of process.env.
  for (const name of Object.keys(process.env)) {
    const upper = name.toUpperCase()
    if (!WORDS.some((w) => upper.includes(w))) continue
    const value = process.env[name]
    if (!value) continue
    const bytes = Buffer.from(value, 'utf8')
    for (const form of [value, bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
      const f = squeeze(lowerAZ(fold(form).s)).s
      if (f.length >= ENV_MIN && !PLAIN.has(f)) forms.add(f)
    }
  }
  return forms
}

type Span = [start: number, end: number, rank: number]

export function redact(text: string): { text: string; masked: number } {
  const input = typeof text === 'string' ? text : ''
  try {
    const { s: folded, at } = fold(input)
    let s = folded.includes('[secret:') ? folded.replace(MARKER, (m) => `[${SETTLED.repeat(m.length - 2)}]`) : folded
    let low = lowerAZ(s)
    const found: Span[] = []

    const forms = envForms()
    if (forms.size) {
      const sq = squeeze(low)
      for (const form of forms) {
        for (let i = sq.s.indexOf(form); i >= 0; i = sq.s.indexOf(form, i + form.length)) {
          const start = sq.at[i]!
          const end = sq.at[i + form.length - 1]! + 1
          // A short value only where it stands alone.
          if (form.length < ENV_ANYWHERE && ((start > 0 && alnum(s.charCodeAt(start - 1))) || (end < s.length && alnum(s.charCodeAt(end))))) continue
          found.push([start, end, ENV_RANK])
        }
      }
    }
    // After the private key pass, `s` is a shorter copy: `back[i]` is where its character i stands in the folded copy.
    let back: number[] | undefined
    KINDS.forEach((k, rank) => {
      const subject = k.lower ? low : s
      if (!k.need.some((n) => subject.includes(n))) return
      const before = found.length
      const m = k.re.matcher(subject)
      while (m.find()) {
        if (m.end(k.group) <= m.start(k.group)) continue
        const start = back ? back[m.start(k.group)]! : m.start(k.group)
        const end = back ? back[m.end(k.group) - 1]! + 1 : m.end(k.group)
        // Only markers and punctuation: already masked, never masked again.
        const piece = folded.slice(start, end)
        if (piece.includes('[secret:') && !/[\p{L}\p{N}]/u.test(piece.replace(MARKER, ''))) continue
        found.push([start, end, rank])
      }
      // A private key block is settled whole: the other patterns search a copy that holds a few
      // settled characters in its place (a value that runs into the block still joins it), so
      // their time does not grow with the block.
      if (rank === 0 && found.length > before) {
        const parts: string[] = []
        back = []
        let last = 0
        for (const [start, end] of found.slice(before)) {
          for (let i = last; i < start; i++) back.push(i)
          const stand = Math.min(SETTLED_RUN, end - start)
          parts.push(s.slice(last, start), SETTLED.repeat(stand))
          back.push(start)
          for (let i = 1; i < stand; i++) back.push(end - 1)
          last = end
        }
        for (let i = last; i < s.length; i++) back.push(i)
        s = parts.join('') + s.slice(last)
        low = lowerAZ(s)
      }
    })
    if (!found.length) return { text: input, masked: 0 }

    // Overlapping or touching matches become one marker, named by the first kind listed.
    found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    const merged: Span[] = []
    for (const r of found) {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1])
        last[2] = Math.min(last[2], r[2])
      } else merged.push([r[0], r[1], r[2]])
    }
    // Back to the text: a range covers every character its copy characters came from.
    const from = (i: number) => (at ? at[i]! : i)
    const until = (end: number) => {
      if (!at) return end
      let j = end
      while (j < at.length && at[j] === at[end - 1]) j++
      return j < at.length ? at[j]! : input.length
    }
    let out = ''
    let last = 0
    for (const [start, end, rank] of merged) {
      out += input.slice(last, from(start)) + `[secret:${rank === ENV_RANK ? 'env' : KINDS[rank]!.kind}]`
      last = until(end)
    }
    return { text: out + input.slice(last), masked: merged.length }
  } catch {
    // Never return text that may hold an unmasked secret.
    return { text: '[secret:unreadable]', masked: 1 }
  }
}
