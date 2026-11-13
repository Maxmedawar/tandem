#!/bin/sh
# Stranger test for the R1a README (gate A9.7): one run = a fresh private home folder on this
# computer holding only the clone and its README; every command of the run goes through `exec`
# and is logged; `judge` decides, independently of the run's own notes, whether it reached a
# working local hub and one session, and how long it took.
#
# Usage: sh check.sh                     the scripted run: the README block run as written, judged, cleaned
#        sh check.sh prepare <run>       make run <run> (0-9 or scripted): folder, clone, README, clock
#        sh check.sh exec <run> '<cmd>'  run one command in the run's home (the stranger's only tool)
#        sh check.sh judge <run>         PASS or FAIL, seconds, commands, and the READS list
#        sh check.sh clean <run>         stop what the run started and remove its folder
# STRANGER_README=<file> replaces the README in a prepared run (negative control only).
# STRANGER_EVIDENCE=<dir> is where judge copies the run's log (default: ../evidence beside the clone, if it exists).
set -eu

repo=$(cd "$(dirname "$0")/../../.." && pwd)
self="$repo/test/e2e/stranger-r1a/check.sh"
tmp=$(cd /tmp && pwd -P)

usage() {
  echo "usage: sh check.sh [prepare|exec|judge|clean] <run 0-9|scripted> ['<command>']" >&2
  exit 2
}
die() {
  echo "check.sh: $*" >&2
  exit 1
}

# The README's first-commands block, extracted exactly as the README test of U-R1A-45 does.
block() {
  awk '/<!-- r1a-first-commands -->/{f=1;next}/<!-- \/r1a-first-commands -->/{f=0}f' "$1" | sed -n '/^```/,/^```/p' | grep -v '^```'
}

setrun() {
  case "${1:-}" in
    [0-9] | scripted) run=$1 ;;
    *) usage ;;
  esac
  dir="$tmp/r1a46-s$run"
  home="$dir/home"
}

# One command in the run's home: an empty environment but for the names below, a PATH of the
# run's own stubs (launchctl, systemctl) and links (node, npm, npx, tmux) plus the system folders,
# a new process group recorded in <dir>/pgids, stdin closed, a 600 s limit, and the sandbox
# profile <dir>/sandbox.sb (no reads, writes or unix sockets under /Users, /Volumes, /private/tmp
# or /private/var/folders except the run folder and the node/tmux install; no launchctl, security,
# osascript or sudo; signals stay open: each exec is its own sandbox, and a later call must stop
# what an earlier one started, e.g. the README's `kill "$(cat hub.pid)"`). Output goes to $2.
inbox() {
  path="$dir/stub-bin:$dir/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  got=$(env -i PATH="$path" /bin/sh -c 'command -v launchctl; command -v systemctl')
  [ "$got" = "$dir/stub-bin/launchctl
$dir/stub-bin/systemctl" ] || die "service-manager stubs not first on PATH: $got"
  env -i HOME="$home" USER=stranger LOGNAME=stranger SHELL=/bin/sh TERM=dumb PATH="$path" \
    TMPDIR="$dir/tmp" TMUX_TMPDIR="$dir/tmux" \
    "$dir/bin/node" -e '
      const { spawn } = require("node:child_process")
      const fs = require("node:fs")
      const [cmd, out, pgids, cwd] = process.argv.slice(1)
      const fd = fs.openSync(out, "w")
      const child = spawn("/usr/bin/sandbox-exec", ["-f", pgids.replace(/pgids$/, "sandbox.sb"), "/bin/sh", "-c", cmd], { cwd, detached: true, stdio: ["ignore", fd, fd] })
      fs.appendFileSync(pgids, child.pid + "\n")
      const timer = setTimeout(() => {
        fs.appendFileSync(out, "check.sh: command stopped after 600 s\n")
        try { process.kill(-child.pid, "SIGTERM") } catch {}
      }, 600000)
      child.on("exit", (code, signal) => {
        clearTimeout(timer)
        process.exit(code ?? 128 + (require("node:os").constants.signals[signal] ?? 1))
      })
    ' "$1" "$2" "$dir/pgids" "$home"
}

prepare() {
  [ -e "$dir" ] && die "run $run exists: $dir (clean it first)"
  readme="${STRANGER_README:-$repo/README.md}"
  [ -f "$readme" ] || die "no README at $readme"
  port=$(block "$readme" | sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$port" ] || die "no hub port in the README block"
  node -e 'const s = require("node:net").connect(Number(process.argv[1]), "127.0.0.1"); s.on("connect", () => process.exit(1)); s.on("error", () => process.exit(0))' "$port" ||
    die "port $port is busy on this computer: the judge could not tell the run's hub from another"
  nodebin=$(node -p 'require("node:fs").realpathSync(process.execPath)')
  tmuxbin=$(command -v tmux) || die "tmux is not installed"
  umask 077
  mkdir "$dir"
  mkdir "$home" "$home/tandem" "$dir/bin" "$dir/stub-bin" "$dir/tmp" "$dir/tmux"
  git -C "$repo" archive HEAD | tar -xf - -C "$home/tandem"
  if [ -n "${STRANGER_README:-}" ]; then cp "$readme" "$home/tandem/README.md"; fi
  cp "$home/tandem/README.md" "$home/README.md"
  cp "$home/tandem/README.md" "$dir/readme.md"
  ln -s "$nodebin" "$dir/bin/node"
  for t in npm npx; do
    ln -s "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$(dirname "$nodebin")/$t")" "$dir/bin/$t"
  done
  ln -s "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$tmuxbin")" "$dir/bin/tmux"
  for t in launchctl systemctl; do
    printf '#!/bin/sh\nprintf "%%s %%s\\n" "$(basename "$0")" "$*" >> "%s/stub-bin/calls.log"\nexit 0\n' "$dir" > "$dir/stub-bin/$t"
    chmod 0755 "$dir/stub-bin/$t"
  done
  nodetop=$(dirname "$(dirname "$nodebin")")
  tmuxtop=$(dirname "$(dirname "$(readlink "$dir/bin/tmux")")")
  for t in "$nodetop" "$tmuxtop"; do
    case "$t" in /) die "install folder $t would open the whole disk to the run" ;; esac
    case "$HOME/" in "$t"/*) die "install folder $t would open this computer's home to the run" ;; esac
  done
  cat > "$dir/sandbox.sb" <<SB
(version 1)
(allow default)
(deny file-read-data file-read-xattr file-write* network-outbound (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read-data file-read-xattr (subpath "$nodetop") (subpath "$tmuxtop"))
(allow file-read-data file-read-xattr file-write* network-outbound (subpath "$dir"))
(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/security") (literal "/usr/bin/osascript") (literal "/usr/bin/sudo"))
SB
  : > "$dir/log.txt"
  : > "$dir/pgids"
  start=$(date +%s)
  echo "$start" > "$dir/start"
  echo "STRANGER-PREPARED $run start=$start"
}

execute() {
  [ -f "$dir/start" ] || die "run $run is not prepared"
  n=$(($(grep -c '^=== ' "$dir/log.txt" || true) + 1))
  out="$dir/out.$n"
  rc=0
  inbox "$1" "$out" || rc=$?
  cat "$out"
  {
    echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) rc=$rc"
    echo "\$ $1"
    head -n 200 "$out"
  } >> "$dir/log.txt"
  rm -f "$out"
  return "$rc"
}

judge() {
  [ -f "$dir/start" ] || die "run $run is not prepared"
  last=$(block "$dir/readme.md" | tail -n 1)
  port=$(block "$dir/readme.md" | sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' | head -n 1)
  status=$(printf '%s\n' "$last" | sed -n 's/.*&& \(TANDEM_HOME=.* --json\) |.*/\1/p')
  failed=""
  inbox "cd tandem && $last" "$dir/judge.i" >/dev/null 2>&1 || failed="$failed i"
  inbox "node -e 'fetch(\"http://127.0.0.1:$port/\").then(() => process.exit(0), () => process.exit(1))'" "$dir/judge.ii" >/dev/null 2>&1 ||
    failed="$failed ii"
  if [ -z "$status" ] || ! inbox "cd tandem && $status | node -e 'const d = JSON.parse(require(\"node:fs\").readFileSync(0, \"utf8\")); const n = d.computers.filter((c) => c.self).flatMap((c) => c.sessions).filter((s) => s.state !== \"gone\" && s.state !== \"closed\").length; process.exit(n >= 1 ? 0 : 1)'" "$dir/judge.iii" >/dev/null 2>&1; then
    failed="$failed iii"
  fi
  seconds=$(($(date +%s) - $(cat "$dir/start")))
  [ "$seconds" -lt 900 ] || failed="$failed iv"
  commands=$(grep -c '^=== ' "$dir/log.txt" || true)
  # Outside the run: a command naming a path outside the run folder, or one the sandbox refused.
  # Never a README step, so it fails the run (the sandbox already kept the content out).
  outside=$(awk -v d="$dir" '
    /^\$ / { cmd = $0; c = cmd; while ((i = index(c, d)) > 0) c = substr(c, 1, i - 1) substr(c, i + length(d))
             if (c ~ /(\/Users|\/Volumes|\/private|\/tmp|\/var\/folders|\/home|\/root)([\/[:space:]"'\'';&|)]|$)/) print cmd; next }
    /Operation not permitted/ && cmd != "" { print cmd; cmd = "" }' "$dir/log.txt" | uniq)
  [ -z "$outside" ] || failed="$failed outside"
  if [ -z "$failed" ]; then
    verdict="STRANGER-RUN $run PASS seconds=$seconds commands=$commands"
  else
    verdict="STRANGER-RUN $run FAIL$failed seconds=$seconds commands=$commands"
  fi
  # For the director to rule on: commands that read a file of the clone (README.md or a file the
  # README names is the director's call), then the outside commands above. A list, not a verdict.
  reads=$(grep '^\$ ' "$dir/log.txt" | grep -E '(^|[^[:alnum:]_-])(cat|less|more|head|tail|grep|sed|awk|vi|vim|nano|find|ls -R)([^[:alnum:]_-]|$)' |
    grep -E 'tandem([^-]|$)' || true)
  report=$(printf '%s\nREADS:\n%s\n%s\n' "$verdict" "$reads" "$outside" | grep -v '^$')
  printf '%s\n' "$report"
  evid="${STRANGER_EVIDENCE:-$repo/../evidence}"
  if [ -d "$evid" ]; then
    { printf '%s\n' "$report"; echo "--- log"; cat "$dir/log.txt"; } > "$evid/TANDEM-U-R1A-46-run$run.txt"
  fi
  [ -z "$failed" ]
}

clean() {
  [ -e "$dir" ] || return 0
  # The run's process groups (recorded at exec), its tmux servers (their own sockets under the
  # run folder), then any process left whose arguments name the run folder.
  if [ -f "$dir/pgids" ]; then
    while read -r g; do
      if ps -A -o pgid= | grep -q -x "[[:space:]]*$g"; then kill -TERM "-$g" 2>/dev/null || true; fi
    done < "$dir/pgids"
  fi
  find "$dir" -type s 2>/dev/null | while read -r s; do tmux -S "$s" kill-server 2>/dev/null || true; done
  i=0
  while ps -A -o pid=,args= | grep -F "$dir/" | grep -v -e 'check.sh' -e 'grep -F' > "$tmp/r1a46-clean.$$"; do
    i=$((i + 1))
    if [ "$i" -gt 10 ]; then
      while read -r p a; do
        case "$a" in *"$dir/"*) kill -TERM "$p" 2>/dev/null || true ;; esac
      done < "$tmp/r1a46-clean.$$"
    fi
    [ "$i" -gt 20 ] && break
    sleep 1
  done
  rm -f "$tmp/r1a46-clean.$$"
  chmod -R u+w "$dir"
  rm -rf "$dir"
}

scripted() {
  setrun scripted
  trap 'sh "$self" clean scripted' EXIT
  sh "$self" prepare scripted
  block "$dir/readme.md" > "$home/first.sh"
  sh "$self" exec scripted 'cd tandem && sh -e ../first.sh' || true
  rc=0
  verdict=$(sh "$self" judge scripted) || rc=$?
  printf '%s\n' "$verdict"
  sh "$self" clean scripted
  trap - EXIT
  line=$(printf '%s\n' "$verdict" | head -n 1)
  if [ "$rc" = 0 ]; then
    echo "STRANGER-SCRIPTED PASS seconds=$(printf '%s\n' "$line" | sed -n 's/.*seconds=\([0-9]*\).*/\1/p')"
  else
    echo "STRANGER-SCRIPTED FAIL $line"
    exit 1
  fi
}

case "${1:-}" in
  "") scripted ;;
  prepare) setrun "${2:-}"; prepare ;;
  exec) [ $# -eq 3 ] || usage; setrun "$2"; execute "$3" ;;
  judge) setrun "${2:-}"; judge ;;
  clean) setrun "${2:-}"; clean ;;
  *) usage ;;
esac
