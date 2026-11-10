#!/bin/sh
# check-parity.sh: check that the parity list has one valid row for every Synergy
# file under bridge/ and test/ at the revision the list names.
#
# Usage: sh scripts/dev/check-parity.sh [--synergy DIR] [--list FILE]
#   DIR   the Synergy clone, default <repo root>/../synergy
#   FILE  the list, default <repo root>/docs/dev/PARITY.md
#
# The revision comes from the list's "Synergy revision: <rev>" line; the expected
# paths are `git -C DIR ls-tree -r --name-only <rev> -- bridge test`. Only lines that
# start with "| `" are rows: | `<synergy path>` | <fate> | <where> | <notes> |
#
# Output: one line per finding, "<TYPE> <synergy path>":
#   MISSING  an expected path has no row
#   EXTRA    a row for a path that is not expected
#   DUP      a path has more than one row
#   EMPTY    a row without exactly 4 cells, or with a blank cell
#   FATE     a fate other than core, port, retire, private
#   WHERE    a core row with no backticked path or one missing at HEAD, or a port
#            row with no unit ID (U-R1A-nn or U-R1B-nn)
# then "check-parity: PASS (<n> rows)" (exit 0) or "check-parity: FAIL (<n> findings)"
# (exit 1). No list, DIR not a git repo, no revision line, an unknown revision, or
# not inside a git repo: one line "check-parity: ERROR <what>", exit 2.
set -u
set -f
LC_ALL=C
export LC_ALL
TAB=$(printf '\t')

die() { echo "check-parity: ERROR $*"; exit 2; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repo"
syn=$top/../synergy
list=$top/docs/dev/PARITY.md
while [ $# -gt 0 ]; do
  case $1 in
    --synergy|--list)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in --synergy) syn=$2 ;; --list) list=$2 ;; esac
      shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -f "$list" ] && [ -r "$list" ] || die "list missing or unreadable: $list"
git -C "$syn" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $syn"
rev=$(sed -n 's/\r$//; s/^Synergy revision:[ ]*\([^ ]*\)[ ]*$/\1/p' "$list" | head -n 1)
[ -n "$rev" ] || die "no Synergy revision line in $list"
git -C "$syn" rev-parse --verify -q "$rev^{commit}" >/dev/null || die "unknown revision $rev in $syn"

t=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$t"' EXIT
trap 'exit 2' HUP INT TERM

git -C "$syn" -c core.quotePath=false ls-tree -r --name-only "$rev" -- bridge test > "$t/want" \
  || die "ls-tree failed for $rev in $syn"

# Row checks in list order. $t/have gets one path per row; $t/core gets
# "<synergy path><TAB><core path>" for each backticked path in a core row's Where.
awk -v have="$t/have" -v core="$t/core" '
  { sub(/\r$/, "") }
  substr($0, 1, 3) != "| `" { next }
  {
    rest = substr($0, 4); i = index(rest, "`")
    path = i ? substr(rest, 1, i - 1) : ""
    print path > have
    body = substr($0, 2); sub(/[ \t]+$/, "", body)
    if (substr(body, length(body), 1) == "|") body = substr(body, 1, length(body) - 1)
    n = split(body, c, "|"); bad = (n != 4)
    for (k = 1; k <= n; k++) { gsub(/^[ \t]+|[ \t]+$/, "", c[k]); if (c[k] == "") bad = 1 }
    if (bad) { print "EMPTY " path; next }
    fate = c[2]; where = c[3]
    if (fate !~ /^(core|port|retire|private)$/) { print "FATE " path; next }
    if (fate == "core") {
      m = 0
      while (match(where, /`[^`]+`/)) {
        m++; print path "\t" substr(where, RSTART + 1, RLENGTH - 2) > core
        where = substr(where, RSTART + RLENGTH)
      }
      if (!m) print "WHERE " path
    } else if (fate == "port" && where !~ /U-R1[AB]-[0-9][0-9]/) print "WHERE " path
  }
' "$list" > "$t/found"
touch "$t/have" "$t/core"

while IFS=$TAB read -r sp cp; do
  git -C "$top" cat-file -e "HEAD:$cp" 2>/dev/null || echo "WHERE $sp"
done < "$t/core" | uniq >> "$t/found"

sort "$t/want" > "$t/want.s"
sort "$t/have" > "$t/have.s"
uniq -d "$t/have.s" | sed 's/^/DUP /' >> "$t/found"
sort -u "$t/have.s" > "$t/have.u"
comm -13 "$t/want.s" "$t/have.u" | sed 's/^/EXTRA /' >> "$t/found"
comm -23 "$t/want.s" "$t/have.u" | sed 's/^/MISSING /' >> "$t/found"

cat "$t/found"
n=$(wc -l < "$t/found" | tr -d ' ')
if [ "$n" -eq 0 ]; then
  echo "check-parity: PASS ($(wc -l < "$t/have" | tr -d ' ') rows)"
  exit 0
fi
echo "check-parity: FAIL ($n findings)"
exit 1
