#!/bin/sh
# lint-agents.sh: fail the tree if an agent gets special treatment outside its harness file.
#
# Usage: sh scripts/lint-agents.sh [ROOT]   (ROOT default .)
#
# NAMES: the base names of ROOT/harnesses/*.toml except shell, plus the agents that have no
# file yet: grok gemini antigravity hermes opencode pi.
#   A  code: in a *.ts file (not *.test.ts) under bridge/, src/ or hub/src/, a line that is not
#      a comment (its first non-blank characters are not //, * or /*) holds a whole quoted
#      string equal to a NAME ('n', "n" or n between backticks). bridge/transcripts/readers/ is
#      exempt: one history reader per agent format.
#   B  favoured default: in README.md, SETUP.md, .env.example, src/mcp-server.ts or
#      hub/src/mcp.ts, a NAME and the word "default" (each a whole word, any case) share one
#      sentence of a line (no . or ; between them).
#   C  .env.example's TANDEM_ENABLED_ENGINES= line has a value: no agent is on by default.
# ALLOW (below): one "path|fixed text|owner" per line. A hit passes when an entry has its path
# and its line contains that text. An entry that matches nothing prints
# "lint-agents: stale <entry>" and does not fail.
#
# Output: "<A|B|C> <path>:<line>" per failure, then "lint-agents: PASS" (exit 0) or
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

allow() {
  cat <<'EOF'
bridge/engines/hermes.ts|= 'hermes'|U-R1A-16
bridge/engines/hermes.ts|engine "hermes"|U-R1A-16
bridge/router.ts|=== 'hermes'|U-R1A-16
bridge/router.ts|engine "hermes"|U-R1A-16
bridge/router.ts|engine: 'hermes'|U-R1A-16
bridge/sessions.ts|session.engine === 'hermes'|U-R1A-16
bridge/sessions.ts|? 'hermes'|U-R1A-16
bridge/harness-registry.ts|adapter?: 'hermes'|U-R1A-16
bridge/harness-registry.ts|adapter !== 'hermes'|U-R1A-16
hub/src/mcp.ts|"hermes"|U-R1A-16
bridge/terminal-session.ts|descriptor.id !== 'claude'|gap
bridge/terminal-session.ts|descriptor.id === 'claude'|U-R1A-18
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
  while ((getline line < file) > 0) {
    ln++
    if (isA && line !~ /^[ \t]*(\/\/|\*|\/\*)/ && line ~ ra) hit("A", file, ln, line)
    if ((file in b) && sentenceB(line)) hit("B", file, ln, line)
    if (file == ".env.example" && line ~ /^TANDEM_ENABLED_ENGINES=/) {
      v = substr(line, 24); gsub(/[ \t"'"'"']/, "", v)
      if (v != "") hit("C", file, ln, line)
    }
  }
  close(file)
}
END {
  for (i = 1; i <= na; i++) if (rows[i] != "" && !used[i]) print "lint-agents: stale " rows[i]
  if (fails) { print "lint-agents: FAIL (" fails ")"; exit 1 }
  print "lint-agents: PASS"
}'
