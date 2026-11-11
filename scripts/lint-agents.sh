#!/bin/sh
# lint-agents.sh: fail the tree if an agent gets special treatment outside its harness file.
#
# Usage: sh scripts/lint-agents.sh [ROOT]   (ROOT default .)
#
# NAMES: the base names of ROOT/harnesses/*.toml except shell, plus a fixed list that holds
# whether or not a file exists (so an agent's code still fails if its file goes): grok gemini
# antigravity hermes opencode pi.
# ADAPTERS: the values x of the `adapter = "<x>"` lines in ROOT/harnesses/*.toml (each a
# lowercase name: letters, digits and -) whose adapter file bridge/engines/<x>.ts exists.
#   A  code: in a *.ts file (not *.test.ts) under bridge/, src/ or hub/src/, a line that is not
#      a comment (its first non-blank characters are not //, * or /*) holds a whole quoted
#      string equal to a NAME ('n', "n" or n between backticks). bridge/transcripts/readers/ is
#      exempt: one history reader per agent format. In bridge/engines/<x>.ts with x in ADAPTERS
#      (the adapter file a built-in harness file names), a line passes when x is the only NAME
#      it holds in quotes; any other quoted NAME there still fails.
#   B  favoured default: in README.md, SETUP.md, .env.example, src/mcp-server.ts or
#      hub/src/mcp.ts, a NAME and the word "default" (each a whole word, any case) share one
#      sentence of a line (no . or ; between them).
#   C  .env.example's TANDEM_ENABLED_ENGINES= line has a value: no agent is on by default.
#   D  a harness file's `adapter = "<x>"` line whose bridge/engines/<x>.ts is missing (or whose
#      x is not such a name): "D harnesses/<file>:<line>".
#   E  an agent harness file (every harnesses/*.toml except shell.toml and a file with an
#      `adapter =` line) with no `empty_prompt` key inside its [states] table (after the
#      `[states]` line, before the next line starting with `[`; a comment never counts):
#      "E harnesses/<file>:<line of [states], or 1 when it has none>". So a new agent cannot ship
#      without an empty-prompt rule.
#   F  an agent harness file whose [states] `empty_prompt` holds a pattern that does not end at
#      \z (a '...' string ending \z, or a "..." string ending \\z; read decoded, as RE2 reads it:
#      a final z after an odd run of backslashes), or holds no pattern (an empty, unclosed or
#      non-array value): "F harnesses/<file>:<line of the empty_prompt key>", one per key; the
#      array may span lines.
# ALLOW (below): one "path|fixed text|owner" per line. A hit passes when an entry has its path
# and its line contains that text. An entry that matches nothing prints
# "lint-agents: stale <entry>" and does not fail.
#
# Output: "<A|B|C|D|E|F> <path>:<line>" per failure, then "lint-agents: PASS" (exit 0) or
# "lint-agents: FAIL (<n>)" (exit 1). ROOT or ROOT/harnesses missing:
# "lint-agents: ERROR <what>" (exit 2).
set -u
LC_ALL=C
export LC_ALL

ROOT=${1:-.}
if [ ! -d "$ROOT" ]; then echo "lint-agents: ERROR no ROOT folder: $ROOT"; exit 2; fi
if [ ! -d "$ROOT/harnesses" ]; then echo "lint-agents: ERROR no harnesses/ folder in $ROOT"; exit 2; fi
cd "$ROOT" || { echo "lint-agents: ERROR cannot enter $ROOT"; exit 2; }

NAMES='grok|gemini|antigravity|hermes|opencode|pi'
for f in harnesses/*.toml; do
  [ -f "$f" ] || continue
  n=${f##*/}
  n=${n%.toml}
  [ "$n" = shell ] || NAMES="$n|$NAMES"
done

# ADAPTERS (space-separated, a space at each end) and LINT_D (one D line per bad adapter line).
ADAPTERS=' '
LINT_D=''
for f in harnesses/*.toml; do
  [ -f "$f" ] || continue
  hits=$(awk '/^[ \t]*adapter[ \t]*=[ \t]*"/ { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); print FNR "|" v }' "$f")
  while IFS='|' read -r ln x; do
    [ -n "$ln" ] || continue
    case $x in
      ''|-*|*[!a-z0-9-]*) ok=no ;;
      *) if [ -f "bridge/engines/$x.ts" ]; then ok=yes; else ok=no; fi ;;
    esac
    if [ "$ok" = yes ]; then ADAPTERS="$ADAPTERS$x "; else LINT_D="${LINT_D}D $f:$ln
"; fi
  done <<HITS
$hits
HITS
done
export ADAPTERS LINT_D

# LINT_E and LINT_F (one E or F line per finding, E lines of all files first): rules E and F.
# The awk reads one file; its strings are scanned by hand so a bracket or # inside a quoted
# pattern is pattern text.
LINT_E=''
LINT_F=''
for f in harnesses/*.toml; do
  [ -f "$f" ] || continue
  [ "${f##*/}" = shell.toml ] && continue
  hits=$(awk -v f="$f" '
  BEGIN { q = sprintf("%c", 39); dq = sprintf("%c", 34); bs = sprintf("%c", 92) }
  { sub(/\r$/, "") }
  /^[ \t]*adapter[ \t]*=/ { adapter = 1 }
  # inside the empty_prompt value: scan chars from pos on this line until the array closes
  col {
    s = $0; i = 1
  }
  !col && /^[ \t]*\[/ {
    st = ($0 ~ /^[ \t]*\[states\][ \t]*(#.*)?$/)
    if (st && !hdr) hdr = FNR
    next
  }
  !col && st && /^[ \t]*empty_prompt[ \t]*=/ {
    has = 1; key = FNR; bad = 0; np = 0; depth = 0; col = 1
    s = $0; sub(/^[^=]*=/, "", s); i = 1
  }
  col {
    n = length(s)
    while (i <= n && col) {
      c = substr(s, i, 1)
      if (c == "#") break
      if (c == "[") depth++
      else if (depth <= 0 && c != " " && c != "\t") { bad = 1; col = 0 }
      else if (c == "]") { depth--; if (depth <= 0) col = 0 }
      else if (c == q || c == dq) {
        # v = the decoded text: a basic string drops the backslash of each escape
        j = i + 1; v = ""
        while (j <= n && substr(s, j, 1) != c) {
          if (c == dq && substr(s, j, 1) == bs) j++
          v = v substr(s, j, 1); j++
        }
        np++
        # ends at \z: a final z after an odd run of backslashes (an even run is escaped ones)
        k = length(v) - 1
        while (k > 0 && substr(v, k, 1) == bs) k--
        if (substr(v, length(v)) != "z" || (length(v) - 1 - k) % 2 == 0) bad = 1
        i = j
      }
      i++
    }
    # no pattern, or not an array, counts as no pattern ending at \z
    if (!col && (bad || !np)) fl = fl "F " f ":" key "\n"
  }
  END {
    if (adapter) exit
    if (!has) print "E " f ":" (hdr ? hdr : 1)
    if (col) fl = fl "F " f ":" key "\n"
    printf "%s", fl
  }' "$f")
  while IFS= read -r line; do
    case $line in
      E*) LINT_E="${LINT_E}$line
" ;;
      F*) LINT_F="${LINT_F}$line
" ;;
    esac
  done <<HITS
$hits
HITS
done
export LINT_E LINT_F

allow() {
  cat <<'EOF'
bridge/terminal-session.ts|descriptor.id !== 'claude'|gap
bridge/terminal-session.ts|descriptor.id === 'claude'|gap
bridge/fleet-protocol.ts|ENGINE_IDS|U-R1B-37
bridge/engine-registry.ts|KNOWN_ENGINE_IDS|U-R1B-37
bridge/drivable.ts|BuiltinEngineId|U-R1B-37
bridge/drivable.ts|id: 'claude'|gap
bridge/drivable.ts|executable: 'claude'|gap
bridge/drivable.ts|id: 'codex'|gap
bridge/drivable.ts|executable: 'codex'|gap
bridge/engines/terminal-adapter.ts|this.engine !== 'claude'|gap
bridge/router.ts|engine === 'claude'|gap
bridge/router.ts|session.engine !== 'claude'|gap
bridge/router.ts|resolveEngine('claude')|gap
bridge/relay.ts|get('claude')|gap
src/mcp-server.ts|Claude-only session model: alias (default|opus|sonnet|haiku)|gap
src/mcp-server.ts|Claude-only: override model for this turn (default|opus|sonnet|haiku|gap
EOF
}
LINT_ALLOW=$(allow)
export LINT_ALLOW

{
  for d in bridge src hub/src; do
    [ -d "$d" ] && find "$d" -type f -name '*.ts' ! -name '*.test.ts' ! -path 'bridge/transcripts/readers/*'
  done | sort
  for f in README.md SETUP.md .env.example; do [ -f "$f" ] && echo "$f"; done
} | awk -v names="$NAMES" '
BEGIN {
  q = sprintf("%c", 39); bq = sprintf("%c", 96)
  ra = q "(" names ")" q "|\"(" names ")\"|" bq "(" names ")" bq
  word = "(^|[^a-z0-9_])(" names ")([^a-z0-9_]|$)"
  dflt = "(^|[^a-z0-9_])default([^a-z0-9_]|$)"
  b["README.md"] = b["SETUP.md"] = b[".env.example"] = b["src/mcp-server.ts"] = b["hub/src/mcp.ts"] = 1
  adapters = ENVIRON["ADAPTERS"]
  na = split(ENVIRON["LINT_ALLOW"], rows, "\n")
  for (i = 1; i <= na; i++) {
    r = rows[i]
    if (r == "") continue
    p = index(r, "|"); apath[i] = substr(r, 1, p - 1); rest = substr(r, p + 1)
    t = rest; while ((p = index(t, "|")) > 0) t = substr(t, p + 1)
    atext[i] = substr(rest, 1, length(rest) - length(t) - 1)
  }
  fails = 0
}
function hit(rule, file, ln, line,    i, ok) {
  ok = 0
  for (i = 1; i <= na; i++) if (apath[i] == file && index(line, atext[i]) > 0) { used[i] = 1; ok = 1 }
  if (!ok) { print rule " " file ":" ln; fails++ }
}
function sentenceB(line,    s, n, i, parts) {
  n = split(tolower(line), parts, "[.;]")
  for (i = 1; i <= n; i++) if (parts[i] ~ word && parts[i] ~ dflt) return 1
  return 0
}
{
  file = $0; isA = (file ~ /\.ts$/); ln = 0
  # own: x when this file is bridge/engines/<x>.ts and x is in ADAPTERS; its quoted x is dropped for A.
  own = ""
  if (file ~ /^bridge\/engines\/[a-z0-9-]+\.ts$/) {
    own = substr(file, 16, length(file) - 18)
    if (index(adapters, " " own " ") == 0) own = ""
  }
  while ((getline line < file) > 0) {
    ln++
    t = line
    if (own != "") { gsub(q own q, "", t); gsub("\"" own "\"", "", t); gsub(bq own bq, "", t) }
    if (isA && line !~ /^[ \t]*(\/\/|\*|\/\*)/ && t ~ ra) hit("A", file, ln, line)
    if ((file in b) && sentenceB(line)) hit("B", file, ln, line)
    if (file == ".env.example" && line ~ /^TANDEM_ENABLED_ENGINES=/) {
      v = substr(line, 24); gsub(/[ \t"'"'"']/, "", v)
      if (v != "") hit("C", file, ln, line)
    }
  }
  close(file)
}
END {
  nd = split(ENVIRON["LINT_D"], dl, "\n")
  for (i = 1; i <= nd; i++) if (dl[i] != "") { print dl[i]; fails++ }
  nd = split(ENVIRON["LINT_E"] ENVIRON["LINT_F"], dl, "\n")
  for (i = 1; i <= nd; i++) if (dl[i] != "") { print dl[i]; fails++ }
  for (i = 1; i <= na; i++) if (rows[i] != "" && !used[i]) print "lint-agents: stale " rows[i]
  if (fails) { print "lint-agents: FAIL (" fails ")"; exit 1 }
  print "lint-agents: PASS"
}'
