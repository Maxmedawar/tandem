#!/bin/sh
# check-tree.sh: fail the tree if it holds anything that must not reach the public repo.
#
# Usage: sh scripts/check-tree.sh [--words FILE] [--icons DIR] [--range REVS] [PATH...]
#
# Checks the git repo of the current directory (run it from the repo's top; this
# script may live elsewhere) and only committed content: the tree at HEAD, limited
# to PATHs (default .), and the commits in REVS. Uncommitted changes are not checked.
#   SECRET  gitleaks (default rules, inline gitleaks:allow and any committed
#           .gitleaksignore or .gitleaks.toml not honoured) on the HEAD tree and on the
#           commits in REVS
#   WORD    a word from FILE in a file's content or path at HEAD
#   PATH    a forbidden path at HEAD: top-level ee/ or private/, .env and .env.*
#           (not .env.example), .dev.vars, *.pem, *.p12, *.key, *.fig, anything uxercon
#   ICON    a quoted string at HEAD equal to the path data (d="...") of an SVG in DIR,
#           compared with blanks and commas removed
# HEAD files are read as raw blobs: .gitattributes (export-ignore, binary, encodings)
# changes nothing, and a symlink is checked as its target text, never followed.
#   COMMIT  a commit in REVS whose message holds a word or a secret, or whose author
#           or committer name or email holds a word
# FILE: one fixed string per line, case-insensitive; # lines and blank lines ignored.
#       Default ~/.config/tandem/forbidden-words.txt
# DIR:  default ~/design-assets/icons/uxercon-free/SVG
# REVS: default origin/main..HEAD, or HEAD (every commit) when origin/main is absent.
#
# Output: one line per finding, "<TYPE> <file or short sha> <detail>", then
# "check-tree: PASS" (exit 0) or "check-tree: FAIL (<n> findings)" (exit 1).
# Missing word list, icon folder or gitleaks, or no git repo: one line
# "check-tree: ERROR <what>", exit 2. No line ever carries a list word: a word is
# named by its line number in FILE ("word #3"), a path holding a word is printed as
# blob:<7-char blob sha>, an author or committer holding one only as the commit sha.
#
# Pre-push call (the pinned private copy):
#   cd <core clone> && sh <synergy>/private/publish/check-tree.sh --words <synergy>/private/publish/forbidden-words.txt .
set -u
set -f
LC_ALL=C
export LC_ALL
TAB=$(printf '\t')

die() { echo "check-tree: ERROR $*"; exit 2; }

words=$HOME/.config/tandem/forbidden-words.txt
icons=$HOME/design-assets/icons/uxercon-free/SVG
range=
while [ $# -gt 0 ]; do
  case $1 in
    --words|--icons|--range)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in --words) words=$2 ;; --icons) icons=$2 ;; --range) range=$2 ;; esac
      shift 2 ;;
    --) shift; break ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || set -- .

command -v gitleaks >/dev/null 2>&1 || die "gitleaks not found"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repo"
[ -z "$(git rev-parse --show-prefix)" ] || die "run from the top of the repo"
git rev-parse --verify -q HEAD >/dev/null || die "no commit at HEAD"
[ -f "$words" ] && [ -r "$words" ] || die "word list missing or unreadable (--words)"
[ -d "$icons" ] || die "icon folder missing (--icons)"
if [ -z "$range" ]; then
  if git rev-parse --verify -q origin/main >/dev/null; then range=origin/main..HEAD; else range=HEAD; fi
fi

t=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$t"' EXIT
trap 'exit 2' HUP INT TERM
out=$t/findings
: > "$out"
add() { printf '%s\n' "$*" >> "$out"; }
g() { git -c core.quotePath=false "$@"; }

# Word list as "<line number><TAB><word>"; $t/wl holds the bare words.
awk '{ sub(/\r$/, ""); sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") } /^#/ || /^$/ { next } { print NR "\t" $0 }' "$words" > "$t/words"
[ -s "$t/words" ] || die "word list has no words (--words)"
cut -f2- "$t/words" > "$t/wl"

# A path, or blob:<sha> when the path itself holds a list word.
shown() { # rev path [blob sha]
  if printf '%s\n' "$2" | grep -i -F -q -f "$t/wl"; then
    printf 'blob:%.7s' "${3:-$(g --literal-pathspecs ls-tree "$1" -- "$2" | awk '{ print $3 }')}"
  else
    printf '%s' "$2"
  fi
}

# Commits in the range (read first: gitleaks passes a range git cannot read).
g log --format='@@check-tree-commit %H%n%B' $range > "$t/msgs" 2>/dev/null || die "cannot read range $range"
g log --format="%H$TAB%an$TAB%ae$TAB%cn$TAB%ce" $range > "$t/people" 2>/dev/null || die "cannot read range $range"

# SECRET: gitleaks, default rules only (a config or ignore file in the repo is not read).
printf '[extend]\nuseDefault = true\n' > "$t/gitleaks.toml"
printf '{{range .}}{{.RuleID}}\t{{.Commit}}\t{{.File}}\t{{.StartLine}}\n{{end}}' > "$t/report.tmpl"
leaks() { # mode report args...
  m=$1; rep=$2; shift 2
  gitleaks "$m" "$@" --no-banner --redact --config "$t/gitleaks.toml" --gitleaks-ignore-path "$t/none" \
    --ignore-gitleaks-allow --max-archive-depth 8 --report-format template --report-template "$t/report.tmpl" --report-path "$rep" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && [ -s "$rep" ] && return 0
  die "gitleaks $m failed (exit $rc)"
}
# HEAD blobs in PATHs, raw, one folder per blob: $t/tree/<sha>/<file name> (the
# name keeps gitleaks' file-type rules; the folder defeats its folder allowlists).
# $t/map: <sha><TAB><path>. Every gitleaks run starts in $t, so no file in the repo
# is read as a .gitleaksignore.
# $t/flat/<sha>: the blob with blanks, line breaks, commas and backslashes removed (ICON).
for p in "$@"; do
  [ -n "$(g ls-tree -r --name-only HEAD -- "$p" 2>/dev/null | head -n 1)" ] || die "a PATH matches nothing at HEAD"
done
g ls-tree -r HEAD -- "$@" > "$t/ls" || die "git ls-tree failed"
awk -F'\t' '{ split($1, m, " ") } m[2] == "blob" { print m[3] "\t" $2 }' "$t/ls" > "$t/map"
mkdir "$t/tree" "$t/flat"
# ponytail: one git cat-file per blob (about 100 here, 1 s); use --batch if trees grow large.
while IFS="$TAB" read -r b p; do
  [ -d "$t/tree/$b" ] && continue
  f=$t/tree/$b/${p##*/}
  mkdir "$t/tree/$b" && g cat-file blob "$b" > "$f" && tr -d ' \t\r\n,\\' < "$f" > "$t/flat/$b" || die "cannot read blob $b"
done < "$t/map"
gitdir=$(git rev-parse --absolute-git-dir) || die "no git dir"
(cd "$t/tree" && leaks dir "$t/r-dir" .) || exit 2
awk -F'\t' 'NR == FNR { f = $3; sub(/^\.\//, "", f); sub(/\/.*/, "", f); r[f] = r[f] $1 " line " $4 "\n"; next }
  ($1 in r) { n = split(r[$1], x, "\n"); for (i = 1; i < n; i++) print $1 "\t" $2 "\t" x[i] }' "$t/r-dir" "$t/map" |
  while IFS="$TAB" read -r b p d; do add "SECRET $(shown HEAD "$p" "$b") $d"; done
(cd "$t" && leaks git "$t/r-git" "$gitdir" "--log-opts=$range") || exit 2
while IFS="$TAB" read -r rule c file line; do
  add "SECRET $(printf '%.7s' "$c") $rule in $(shown "$c" "$file") line $line"
done < "$t/r-git"
(cd "$t" && leaks stdin "$t/r-msg" < "$t/msgs") || exit 2
awk -F'\t' 'NR == FNR { if ($0 ~ /^@@check-tree-commit /) s = substr($0, 21, 7); at[FNR] = s; next }
  { print "COMMIT " at[$4] " message has a secret (" $1 ")" }' "$t/msgs" "$t/r-msg" >> "$out"

# COMMIT: list words in messages, authors and committers.
awk -F'\t' 'NR == FNR { n[NR] = $1; w[NR] = tolower($2); c = NR; next }
  /^@@check-tree-commit / { s = substr($0, 21, 7); next }
  { l = tolower($0); for (i = 1; i <= c; i++) if (index(l, w[i]) && !((s, i) in seen)) { seen[s, i]; print "COMMIT " s " message has word #" n[i] } }' \
  "$t/words" "$t/msgs" >> "$out"
awk -F'\t' 'NR == FNR { n[NR] = $1; w[NR] = tolower($2); c = NR; next }
  { a = tolower($2 "\t" $3); m = tolower($4 "\t" $5)
    for (i = 1; i <= c; i++) {
      if (index(a, w[i])) print "COMMIT " substr($1, 1, 7) " author has word #" n[i]
      if (index(m, w[i])) print "COMMIT " substr($1, 1, 7) " committer has word #" n[i]
    } }' "$t/words" "$t/people" >> "$out"

# WORD: list words in file contents and paths at HEAD.
# onmap: shas on stdin -> "<sha><TAB><path>" for every HEAD path of those shas.
onmap() { awk -F'\t' 'NR == FNR { h[$1]; next } $1 in h' - "$t/map"; }
while IFS="$TAB" read -r n w; do
  g -C "$t/tree" grep --no-index -l -a -i -F -e "$w" > "$t/wh"
  [ $? -le 1 ] || die "git grep failed"
  sed 's/^"//; s/\/.*//' "$t/wh" | onmap |
    while IFS="$TAB" read -r b p; do add "WORD $(shown HEAD "$p" "$b") word #$n"; done
done < "$t/words"
g ls-tree -r --name-only HEAD -- "$@" > "$t/paths"
awk -F'\t' 'NR == FNR { n[NR] = $1; w[NR] = tolower($2); c = NR; next }
  { l = tolower($0); for (i = 1; i <= c; i++) if (index(l, w[i])) print n[i] "\t" $0 }' "$t/words" "$t/paths" |
  while IFS="$TAB" read -r n p; do add "WORD $(shown HEAD "$p") word #$n in path"; done

# PATH: forbidden paths at HEAD.
awk '{ p = tolower($0); b = p; sub(/.*\//, "", b) }
  p ~ /^(ee|private)\// || b == ".env" || (b ~ /^\.env\./ && b != ".env.example") || b == ".dev.vars" ||
  b ~ /\.(pem|p12|key|fig)$/ || index(p, "uxercon") { print }' "$t/paths" |
  while IFS= read -r p; do add "PATH $(shown HEAD "$p") forbidden path"; done

# ICON: quoted ("...", '...' or `...`) M... strings at HEAD equal to a library d="..."
# value (40+ chars), both sides with blanks, line breaks and commas removed, so
# reformatting the path data does not hide it.
find "$icons" -type f \( -name '*.svg' -o -name '*.SVG' \) -exec grep -o -h -E '(^|[[:space:]])d="[^"]{40,}"' {} + |
  sed 's/^[[:space:]]*d="//; s/"$//' | tr -d ' \t\r,' | sort -u > "$t/lib"
[ -s "$t/lib" ] || die "icon folder has no path data (--icons)"
q="[\"'\`]"
grep -r -o -a -E "$q[Mm][-0-9.A-Za-z]{19,}$q" "$t/flat" > "$t/cand"
[ $? -le 1 ] || die "grep failed"
# "$t/flat/<sha>:<quoted match>"
awk -v p="$t/flat/" '{ s = substr($0, length(p) + 1); i = index(s, ":"); print substr(s, 1, i - 1) "\t" substr(s, i + 2, length(s) - i - 2) }' \
  "$t/cand" > "$t/pairs"
cut -f2 "$t/pairs" | sort -u > "$t/vals"
comm -12 "$t/lib" "$t/vals" > "$t/hits"
awk -F'\t' 'NR == FNR { h[$0]; next } ($2 in h) { print $1 }' "$t/hits" "$t/pairs" | sort -u | onmap |
  while IFS="$TAB" read -r b p; do add "ICON $(shown HEAD "$p" "$b") library icon path data"; done

n=$(wc -l < "$out" | tr -d ' ')
cat "$out"
if [ "$n" -eq 0 ]; then echo "check-tree: PASS"; exit 0; fi
echo "check-tree: FAIL ($n findings)"
exit 1
