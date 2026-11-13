#!/bin/sh
# linux-run.sh: run vitest in the tandem-test image (test/env/Containerfile) on a real git
# clone of a committed revision, so tests that need a repository (git grep, check-tree) and
# gitleaks run as on a developer machine.
#
# Usage: sh scripts/dev/linux-run.sh --out DIR [--rev REF] [--podman-data DIR] (--full | FILE...)
#   --out DIR  a folder this run makes (it must not exist); holds repo.bundle and linux.log
#   --rev REF  the branch, tag or HEAD to test (default HEAD; git bundle needs a name, not a
#              bare sha); uncommitted changes are never tested
#   --podman-data DIR  the XDG_DATA_HOME the podman machine `tandem` lives under (used to start
#              and stop it; at least 10 GB must be free there)
#   --full     the whole suite; else the named test files
# The caller takes and releases the fleetbus heavy slot; this script takes the podman lock
# /tmp/tandem-podman.lock (mkdir), starts the podman machine `tandem` if it is stopped and
# stops it again only then, and removes the lock only if it made it.
# Prints HEAD=<sha>, NODE=<version>, vitest's Test Files and Tests lines, every FAIL line, and
# LINUX-RC=<vitest exit code>; the full output is in DIR/linux.log. Exit: vitest's code, or 2
# when the run could not start (lock held, no disk, no image, bad arguments).
set -u
die() { echo "linux-run: ERROR $*"; exit 2; }

out='' rev=HEAD full=0 data=''
while [ $# -gt 0 ]; do
  case $1 in
    --out) [ $# -ge 2 ] || die "--out needs a folder"; out=$2; shift 2 ;;
    --rev) [ $# -ge 2 ] || die "--rev needs a branch, tag or HEAD"; rev=$2; shift 2 ;;
    --podman-data) [ $# -ge 2 ] || die "--podman-data needs a folder"; data=$2; shift 2 ;;
    --full) full=1; shift ;;
    --) shift; break ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ -n "$out" ] || die "--out DIR is required"
if [ "$full" = 1 ]; then [ $# -eq 0 ] || die "--full takes no files"; else [ $# -gt 0 ] || die "name test files or --full"; fi

top=$(git rev-parse --show-toplevel) || die "not inside a git work tree"
sha=$(git -C "$top" rev-parse --verify "$rev^{commit}") || die "no commit $rev"
for f in "$@"; do git -C "$top" cat-file -e "$sha:$f" 2>/dev/null || die "$f is not in $sha"; done

if [ -n "$data" ]; then
  [ -d "$data" ] || die "$data is not a folder (not mounted?)"
  free=$(df -k "$data" | awk 'NR==2 {print int($4 / 1048576)}')
  [ "${free:-0}" -ge 10 ] || die "under 10 GB free under $data"
fi
machine() { if [ -n "$data" ]; then XDG_DATA_HOME="$data" podman machine "$@"; else podman machine "$@"; fi; }

mkdir "$out" || die "cannot make $out (it must not exist)"
lock=/tmp/tandem-podman.lock made_lock=0 started=0
cleanup() {
  if [ "$started" = 1 ]; then machine stop tandem >/dev/null 2>&1 || echo "linux-run: podman machine stop failed"; fi
  if [ "$made_lock" = 1 ]; then rmdir "$lock" || echo "linux-run: rmdir $lock failed"; fi
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
mkdir "$lock" 2>/dev/null || die "podman lock $lock is held by another run"
made_lock=1

if ! podman machine list --format '{{.Name}} {{.Running}}' | grep -q '^tandem\*\{0,1\} true$'; then
  machine start tandem >/dev/null || die "podman machine start tandem failed"
  started=1
fi
podman --connection tandem image exists tandem-test || die "image tandem-test missing (podman --connection tandem build -t tandem-test test/env)"

git -C "$top" bundle create "$out/repo.bundle" "$rev" 2>/dev/null || die "git bundle of $rev failed (name a branch, tag or HEAD)"
echo "HEAD=$sha"
# Inside: clone the bundle (a real repository with history), check out the commit, install, test.
inner='set -u
cat > /tmp/repo.bundle && git clone -q --no-checkout /tmp/repo.bundle /w && cd /w && git checkout -q --detach "$0" || { echo "LINUX-RC=2"; exit 2; }
npm ci --no-audit --no-fund >/dev/null && (cd hub && npm ci --no-audit --no-fund >/dev/null) || { echo "npm ci failed"; echo "LINUX-RC=2"; exit 2; }
echo "NODE=$(node --version)"
npx vitest run "$@" --reporter=verbose
rc=$?
echo "LINUX-RC=$rc"
exit $rc'
podman --connection tandem run --rm -i tandem-test sh -c "$inner" "$sha" "$@" < "$out/repo.bundle" > "$out/linux.log" 2>&1
rc=$?
perl -pe 's/\e\[[0-9;]*m//g' "$out/linux.log" | grep -E '^NODE=|^ *Test Files |^ *Tests |^ FAIL |^LINUX-RC='
grep -q '^LINUX-RC=' "$out/linux.log" || echo "LINUX-RC=$rc"
exit $rc
