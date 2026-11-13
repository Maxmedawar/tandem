#!/bin/sh
# cutover.sh: install the new Tandem build beside the old one, and remove it again.
#
# Usage:
#   sh scripts/cutover.sh install [--dry-run] [--no-start] [--home <dir>] [--name <computer>]
#        [--port <n>] [--archive <file>] [--hub-url <url> --hub-token-file <file>]
#        [--folder <path>]... [--agent <name>]...
#   sh scripts/cutover.sh status [--home <dir>]
#   sh scripts/cutover.sh rollback [--home <dir>] [--purge]
#
# The new build gets its own service (tandem-next: launchd label com.tandem-next.runtime, systemd
# unit tandem-next.service), its own home (default ~/.tandem-next) and its own computer name
# (default <hostname>-next). The old install - its service com.tandem.runtime / tandem.service,
# its home ~/.tandem and its `tandem` command - is only looked at (test -e / test -L), never read,
# stopped or changed. This script calls no service manager itself except the read-only
# `launchctl list` / `systemctl --user is-active` of `status`: install.sh, uninstall.sh and the
# launcher do, for tandem-next only.
#
# Every refusal is checked before anything is written: one stderr line `cutover: <reason>`, rc 1.
# Unknown subcommand or option: usage on stderr, rc 2. --dry-run runs the same checks (read-only)
# and prints what it would do; it writes nothing and runs nothing.
set -eu
umask 077
LC_ALL=C
export LC_ALL

# Nothing inherited picks the home, the service, the hub or the store.
unset TANDEM_HOME TANDEM_SERVICE TANDEM_HUB_LINK_URL TANDEM_HUB_LINK_TOKEN TANDEM_HUB_LINK_ID
unset TANDEM_ARCHIVE TANDEM_NO_START TANDEM_NO_LIMITS
for name in $(env | sed -n 's/^\(CCM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
service=tandem-next

say() { printf 'cutover: %s\n' "$*"; }
refuse() { printf 'cutover: %s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<'USAGE'
usage: sh scripts/cutover.sh install [--dry-run] [--no-start] [--home <dir>] [--name <computer>]
         [--port <n>] [--archive <file>] [--hub-url <url> --hub-token-file <file>]
         [--folder <path>]... [--agent <name>]...
       sh scripts/cutover.sh status [--home <dir>]
       sh scripts/cutover.sh rollback [--home <dir>] [--purge]
USAGE
  exit 2
}
# A value as one single-quoted shell word.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
lower() { printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'; }

if [ "$(uname -s)" = "Darwin" ]; then
  darwin=1
  old_svc=com.tandem.runtime
  new_svc="com.$service.runtime"
else
  darwin=0
  old_svc=tandem.service
  new_svc="$service.service"
fi

# An absolute path without repeated or trailing slashes.
absolute() {
  case "$1" in /*) p=$1 ;; *) p="$(pwd)/$1" ;; esac
  printf '%s' "$p" | sed -e 's#//*#/#g' -e 's#\(.\)/$#\1#'
}
# The path with its existing part through `pwd -P` (links and letter case as the disk has them).
resolved() {
  p=$1
  rest=""
  while [ ! -d "$p" ]; do
    rest="/${p##*/}$rest"
    p=${p%/*}
    [ -n "$p" ] || p=/
  done
  printf '%s%s' "$(cd "$p" && pwd -P)" "$rest" | sed 's#//*#/#g'
}
# Is $1 the folder $2 or inside it, letter case ignored.
within() {
  a=$(lower "$1")
  b=$(lower "$2")
  [ "$a" = "$b" ] && return 0
  case "$a" in "$b"/*) return 0 ;; esac
  return 1
}

# The home rule: never the old home ~/.tandem (of $HOME or of this account, whatever $HOME says),
# nor anything inside it. Compared as written first, so the account's own ~/.tandem is refused
# before any file call on it, then with the existing part resolved.
check_home() {
  case "$home/" in
    */./*|*/../*) refuse "home $home must not hold . or .. parts" ;;
  esac
  account=$(node -e 'process.stdout.write(require("os").userInfo().homedir)') || refuse "cannot tell this account's home"
  for old in "$(absolute "$HOME")/.tandem" "$(absolute "$account")/.tandem"; do
    within "$home" "$old" && refuse "home $home is the old Tandem home or inside it"
  done
  real=$(resolved "$home")
  for base in "$HOME" "$account"; do
    within "$real" "$(resolved "$(absolute "$base")")/.tandem" && refuse "home $home is the old Tandem home or inside it"
  done
  return 0
}

host=$(hostname -s 2>/dev/null || uname -n)
host=${host%%.*}
slug=$(lower "$host" | sed -e 's/[^a-z0-9-][^a-z0-9-]*/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-58)

sub=${1:-}
[ $# -gt 0 ] && shift
home="$HOME/.tandem-next"
case "$sub" in
  install|status|rollback) ;;
  *) usage ;;
esac

dry=0
nostart=0
purge=0
name="$slug-next"
port=8797
archive=""
hub_url=""
token_file=""
limit_args=""
folders=0
agents=0
while [ $# -gt 0 ]; do
  case "$sub:$1" in
    *:--home) [ $# -ge 2 ] || usage; home=$2; shift ;;
    install:--dry-run) dry=1 ;;
    install:--no-start) nostart=1 ;;
    install:--name) [ $# -ge 2 ] || usage; name=$2; shift ;;
    install:--port) [ $# -ge 2 ] || usage; port=$2; shift ;;
    install:--archive) [ $# -ge 2 ] || usage; archive=$(absolute "$2"); shift ;;
    install:--hub-url) [ $# -ge 2 ] || usage; hub_url=$2; shift ;;
    install:--hub-token-file) [ $# -ge 2 ] || usage; token_file=$2; shift ;;
    install:--folder) [ $# -ge 2 ] || usage; limit_args="$limit_args --folder $(quote "$2")"; folders=$((folders + 1)); shift ;;
    install:--agent) [ $# -ge 2 ] || usage; limit_args="$limit_args --agent $(quote "$2")"; agents=$((agents + 1)); shift ;;
    rollback:--purge) purge=1 ;;
    *) usage ;;
  esac
  shift
done
home=$(absolute "$home")
check_home

# Read-only: the next service's state, the label or unit as given.
service_state() {
  if [ "$darwin" = 1 ]; then
    if launchctl list "$1" >/dev/null 2>&1; then echo loaded; else echo "not loaded"; fi
  else
    if systemctl --user is-active --quiet "$1" >/dev/null 2>&1; then echo active; else echo inactive; fi
  fi
}
# One named value of the next home's tandem.env, as cutover wrote it.
env_value() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$home/tandem.env" 2>/dev/null | head -n 1; }

if [ "$sub" = status ]; then
  say "old $old_svc: $(service_state "$old_svc")"
  if [ -f "$home/.cutover" ] && [ -e "$home/current" ]; then
    version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$home/current/manifest.json" 2>/dev/null | head -n 1)
    hub=$(env_value TANDEM_HUB_LINK_URL)
    say "next $home: installed ${version:-unknown}; computer $(env_value TANDEM_HUB_LINK_ID); port $(env_value TANDEM_PORT); hub ${hub:-none}; $new_svc $(service_state "$new_svc")"
  else
    say "next $home: not installed"
  fi
  exit 0
fi

if [ "$sub" = rollback ]; then
  if [ ! -e "$home" ] && [ ! -L "$home" ]; then
    say "nothing to roll back"
    exit 0
  fi
  [ -f "$home/.cutover" ] || refuse "$home was not made by cutover; nothing removed"
  TANDEM_HOME="$home" TANDEM_SERVICE="$service" sh "$here/packaging/uninstall.sh" </dev/null >&2
  rm -f "$home/tandem.env"
  if [ "$purge" = 1 ]; then
    chmod -R u+w "$home"
    rm -rf "$home"
    say "removed $home"
  else
    say "removed; data kept in $home (add --purge to remove it)"
  fi
  exit 0
fi

# install: every refusal, in order, before anything is written.
if [ -e "$home" ] || [ -L "$home" ]; then
  [ -f "$home/.cutover" ] || refuse "home $home exists and was not made by cutover"
  if [ -e "$home/current" ] || [ -L "$home/current" ]; then refuse "already installed: run rollback first"; fi
fi
case "$name" in
  ''|[!a-z0-9]*|*[!a-z0-9-]*) refuse "computer name $name must be lower-case letters, digits and -, 1 to 63 characters" ;;
esac
[ "${#name}" -le 63 ] || refuse "computer name $name must be lower-case letters, digits and -, 1 to 63 characters"
[ "$name" != "$slug" ] || refuse "computer name $name is this computer's own name; the old install uses it"
case "$port" in
  ''|*[!0-9]*) refuse "port $port must be a number from 1024 to 65535" ;;
esac
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  refuse "port $port must be a number from 1024 to 65535"
fi
if node -e '
  const s = require("net").connect({ host: "127.0.0.1", port: Number(process.argv[1]) })
  s.on("connect", () => { s.destroy(); process.exit(0) })
  s.on("error", () => process.exit(1))
  setTimeout(() => process.exit(1), 2000)
' "$port"; then
  refuse "port $port is in use on 127.0.0.1"
fi
[ -z "$hub_url" ] || [ -n "$token_file" ] || refuse "--hub-url needs --hub-token-file"
[ -z "$token_file" ] || [ -n "$hub_url" ] || refuse "--hub-token-file needs --hub-url"
link_url=""
if [ -n "$hub_url" ]; then
  bad_url="hub URL must be https://<host> or http://127.0.0.1:<port> or http://localhost:<port>"
  case "$hub_url" in
    https://*) rest=${hub_url#https://}; scheme=wss ;;
    http://127.0.0.1:*|http://localhost:*) rest=${hub_url#http://}; scheme=ws ;;
    *) refuse "$bad_url" ;;
  esac
  rest=${rest%/}
  case "$rest" in
    ''|*[!A-Za-z0-9.:-]*|[!A-Za-z0-9]*) refuse "$bad_url" ;;
  esac
  if [ "$scheme" = ws ]; then
    case "${rest#*:}" in ''|*[!0-9]*) refuse "$bad_url" ;; esac
  fi
  # The hub link dials WebSockets: wss:// for https, ws:// on loopback (bridge/hub-link.ts).
  link_url="$scheme://$rest"
  tf=$(absolute "$token_file")
  if [ -L "$tf" ] || [ ! -f "$tf" ] || [ -z "$(find "$tf" -prune -type f -perm 0600 -user "$(id -u)" 2>/dev/null)" ]; then
    refuse "token file $token_file must be a regular file of mode 0600 owned by you"
  fi
  # 16 to 512 characters after one trailing newline, of a set that is safe inside tandem.env.
  bytes=$(wc -c < "$tf" | tr -d ' ')
  newlines=$(tr -cd '\n' < "$tf" | wc -c | tr -d ' ')
  others=$(tr -d 'A-Za-z0-9._~+/=\n-' < "$tf" | wc -c | tr -d ' ')
  token_ok=0
  if [ "$others" = 0 ] && { [ "$newlines" = 0 ] || { [ "$newlines" = 1 ] && [ -z "$(tail -c 1 "$tf" | tr -d '\n')" ]; }; }; then
    length=$((bytes - newlines))
    [ "$length" -ge 16 ] && [ "$length" -le 512 ] && token_ok=1
  fi
  [ "$token_ok" = 1 ] || refuse "token file $token_file must hold 16 to 512 characters of A-Z a-z 0-9 . _ ~ + / = -"
fi

if [ "$darwin" = 1 ]; then svc_file="$home/agents/$new_svc.plist"; else svc_file="$HOME/.config/systemd/user/$new_svc"; fi
if [ -e "$HOME/.tandem/current" ] && [ -L "$HOME/.local/bin/tandem" ]; then old="installed ($old_svc)"; else old="not found"; fi
say "home $home"
say "service $service ($new_svc)"
say "computer $name"
say "port $port"
say "hub ${hub_url:-none}"
say "limits $folders folder(s), $agents agent(s)"
say "old: $old; not touched"

if [ "$dry" = 1 ]; then
  if [ -n "$archive" ]; then
    say "would install $archive"
  else
    say "would build a release from $here at $(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fi
  say "would write $svc_file"
  if [ "$nostart" = 1 ]; then say "would not start it"; else say "would start $new_svc"; fi
  say "dry run: nothing was changed"
  exit 0
fi

work=""
trap '[ -z "$work" ] || rm -rf "$work"' EXIT INT TERM
mkdir -p "$home"
chmod 0700 "$home"
printf 'made by scripts/cutover.sh at %s from %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)" > "$home/.cutover"
chmod 0600 "$home/.cutover"

if [ -z "$archive" ]; then
  work=$(mktemp -d "${TMPDIR:-/tmp}/tandem-cutover.XXXXXX")
  sh "$here/packaging/build-release.sh" "$work" >&2
  archive=$(find "$work" -maxdepth 1 -name '*.tar.gz' | head -n 1)
fi
TANDEM_HOME="$home" TANDEM_SERVICE="$service" TANDEM_NO_START=1 TANDEM_NO_LIMITS=1 TANDEM_ARCHIVE="$archive" \
  sh "$here/packaging/install.sh" </dev/null >&2

# tandem.env: the launcher sources it after the environment, so these win over anything inherited
# (a CCM_FABRIC_DB_PATH naming the old store included). The token goes from the file to this file
# through the shell's own printf, never through an argument list.
store="$home/fabric/fabric.sqlite3"
tmp="$home/.tandem.env.$$"
{
  printf "TANDEM_SERVICE='%s'\n" "$service"
  printf "TANDEM_HUB_LINK_ID='%s'\n" "$name"
  printf "TANDEM_PORT='%s'\n" "$port"
  printf 'CCM_FABRIC_DB_PATH=%s\n' "$(quote "$store")"
  if [ -n "$link_url" ]; then
    token=$(cat "$tf")
    printf "TANDEM_HUB_LINK_URL='%s'\n" "$link_url"
    printf "TANDEM_HUB_LINK_TOKEN='%s'\n" "$token"
    token=""
  fi
} > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$home/tandem.env"

# The limits file and its applied copy: `limits init` is their only writer.
eval "set -- $limit_args"
TANDEM_HOME="$home" "$home/current/bin/tandem" limits init "$@" </dev/null >&2

if [ "$nostart" = 1 ]; then
  say "installed, not started"
else
  TANDEM_HOME="$home" "$home/current/bin/tandem" start </dev/null >&2
  say "installed"
fi
