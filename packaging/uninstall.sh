#!/bin/sh
# Removes Tandem.
#
# It stops the runtime, removes what the installer put on this machine, and
# leaves the fabric's own data alone unless asked. That default is deliberate:
# uninstalling an application should not be how someone loses a project's
# memory, and reinstalling should pick up where they left off.
#
#   packaging/uninstall.sh            remove the software
#   packaging/uninstall.sh --purge    remove the software and this fabric's data
set -eu

state="${TANDEM_HOME:-$HOME/.tandem}"
service="${TANDEM_SERVICE-tandem}"
case "$service" in
  ''|[!abcdefghijklmnopqrstuvwxyz]*|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) service="" ;;
esac
if [ -z "$service" ] || [ "${#service}" -gt 31 ]; then
  printf '%s\n' "tandem: TANDEM_SERVICE must be a short lower-case name" >&2
  exit 1
fi
label="com.$service.runtime"
unit="$service.service"
purge=0
[ "${1:-}" = "--purge" ] && purge=1

say() { printf '%s\n' "$*"; }

# The service is stopped and its definition removed, wherever the installer
# put it: a launchd agent on macOS, a systemd user unit on Linux.
if [ "$(uname -s)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$state/agents/$label.plist"
else
  systemctl --user disable --now "$unit" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$unit"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# Only a link this installer made is removed, so a `tandem` someone else put
# there is left where it is.
if [ -L "$HOME/.local/bin/tandem" ]; then
  case "$(readlink "$HOME/.local/bin/tandem")" in
    "$state"/*) rm -f "$HOME/.local/bin/tandem" ;;
  esac
fi

rm -rf "$state/versions" "$state/current" "$state/run"
rmdir "$state/agents" 2>/dev/null || true

if [ "$purge" -eq 1 ]; then
  # The device key goes too. Re-enrolling after this is a new device to
  # everyone else on the fabric, which is the point of asking for --purge.
  rm -rf "$state/fabric" "$state/runtime.log"
  rmdir "$state" 2>/dev/null || true
  say "Tandem and this fabric's data have been removed."
else
  say "Tandem has been removed. This fabric's data is still in $state/fabric."
  say "Reinstalling picks up where you left off; add --purge to remove it."
fi
