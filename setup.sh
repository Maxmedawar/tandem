#!/usr/bin/env bash
# Tandem setup: the R1a hub on Cloudflare (r1a), or the old Tailscale hub, device, or local stdio.
set -euo pipefail
umask 077

cd "$(dirname "$0")"
ROOT="$(pwd)"
STATE_ROOT="${TANDEM_STATE_DIR:-${HOME}/.tandem}"
PUBLIC_HOST="127.0.0.1"
PUBLIC_PORT="${TANDEM_PORT:-8787}"
FLEET_HOST="127.0.0.1"
FLEET_PORT="${TANDEM_FLEET_PORT:-8788}"
FLEET_HTTPS_PORT="${TANDEM_FLEET_HTTPS_PORT:-8443}"
VERIFY_TRIES="${TANDEM_SETUP_VERIFY_TRIES:-15}"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  printf '%s\n' \
    "Usage:" \
    "  ./setup.sh r1a --name tandem-<name> [--dry-run] [--secrets-dir <dir>]" \
    "                                 deploy your own hub under a new Worker name (packaging/hub-deploy.sh)" \
    "" \
    "The old Tailscale path:" \
    "  ./setup.sh hub                 configure the always-on OAuth/Tailscale hub" \
    "  ./setup.sh invite              create an independent device invitation" \
    "  ./setup.sh device [bundle]     enroll this Tailscale device once" \
    "  ./setup.sh desktop             write a local stdio connector" \
    "" \
    "Non-interactive setup requires TANDEM_CWD_ALLOWLIST. Claude is enabled by" \
    "default. Add only deliberate extras with TANDEM_ENABLED_ENGINES."
}

ROLE="${1:-${TANDEM_SETUP_MODE:-}}"
case "$ROLE" in
  r1a) ROLE="r1a" ;;
  ""|h|hub|tailscale|t) ROLE="hub" ;;
  invite|i) ROLE="invite" ;;
  device|d) ROLE="device" ;;
  desktop) ROLE="desktop" ;;
  quick|q|web|w)
    die "Cloudflare quick tunnels and URL bearer tokens were removed. Use './setup.sh hub' with Tailscale."
    ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; die "unknown setup role '${ROLE}'" ;;
esac

case "$ROLE" in
  hub|invite|device) printf '%s\n' "setup: this is the old Tailscale path; the R1a path is ./setup.sh r1a (see README)" >&2 ;;
esac
say "tandem setup: ${ROLE}"

command -v node >/dev/null 2>&1 || die "Node 22.6 or newer is required."
NODE_OK="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=6)?"yes":"no")')"
[ "$NODE_OK" = "yes" ] || die "Node $(node -v) is too old. Tandem requires Node 22.6 or newer."

validate_port() {
  case "$2" in ''|*[!0-9]*) die "$1 must be an integer from 1 to 65535." ;; esac
  [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || die "$1 must be an integer from 1 to 65535."
}

secure_directory() {
  mkdir -p "$1"
  [ ! -L "$1" ] || die "Protected state directories may not be symbolic links."
  [ -d "$1" ] && [ -O "$1" ] || die "Protected state directory ownership is unsafe."
  chmod 700 "$1"
}

prepare_state_root() {
  case "$STATE_ROOT" in /*) ;; *) die "TANDEM_STATE_DIR must be an absolute path." ;; esac
  STATE_ROOT="$(TANDEM_RESOLVE_STATE="$STATE_ROOT" node -e 'process.stdout.write(require("node:path").resolve(process.env.TANDEM_RESOLVE_STATE))')"
  [ "$STATE_ROOT" != "/" ] || die "TANDEM_STATE_DIR may not be a filesystem root."
  case "$STATE_ROOT" in "$ROOT"|"$ROOT"/*) die "TANDEM_STATE_DIR must stay outside the repository." ;; esac
  secure_directory "$STATE_ROOT"
}

validate_setup_values() {
  [ -n "${TANDEM_CWD_ALLOWLIST:-}" ] || {
    if [ -t 0 ]; then
      read -r -p "Exact project roots this device may start sessions in (colon-separated): " TANDEM_CWD_ALLOWLIST
      export TANDEM_CWD_ALLOWLIST
    fi
  }
  [ -n "${TANDEM_CWD_ALLOWLIST:-}" ] || die "TANDEM_CWD_ALLOWLIST is required and may not be empty."
  TANDEM_VALIDATE_ALLOWLIST="$TANDEM_CWD_ALLOWLIST" node -e '
    const path = require("node:path"); const fs = require("node:fs");
    const roots = process.env.TANDEM_VALIDATE_ALLOWLIST.split(":");
    if (!roots.length || roots.some((root) => !path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root || !fs.statSync(root).isDirectory())) process.exit(1);
  ' || die "Every allowlist entry must be an existing absolute directory, and filesystem roots are refused."

  case "${TANDEM_ENABLED_ENGINES:-}" in
    *$'\n'*|*$'\r'*|*' '*|*[!a-z,:_-]*) die "TANDEM_ENABLED_ENGINES contains invalid characters." ;;
  esac
  TANDEM_VALIDATE_ENGINES="${TANDEM_ENABLED_ENGINES:-}" node --experimental-strip-types --input-type=module -e '
    import { buildEnabledEngines } from "./bridge/engine-registry.ts";
    try { buildEnabledEngines(process.env.TANDEM_VALIDATE_ENGINES); } catch { process.exit(1); }
  ' || die "TANDEM_ENABLED_ENGINES may contain only codex, shell, or hermes. Claude is already enabled."
  if printf '%s' ",${TANDEM_ENABLED_ENGINES:-}," | grep -Eq '[:,]shell[:,]'; then
    warn "shell grants callers OS-user command execution from an admitted cwd. It is not a sandbox."
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  fi
}

config_digest() {
  TANDEM_HASH_FILE="$1" node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.env.TANDEM_HASH_FILE)).digest("hex"));
  '
}

write_config_from_env() {
  TANDEM_WRITE_CONFIG_FILE="$1" node --experimental-strip-types --input-type=module -e '
    import { writeProtectedRuntimeConfig } from "./src/runtime-config.ts";
    const values = {};
    for (const [key, value] of Object.entries(process.env)) if (key.startsWith("TANDEM_CONFIG_VALUE_")) values[key.slice(20)] = value;
    await writeProtectedRuntimeConfig(process.env.TANDEM_WRITE_CONFIG_FILE, values);
  '
}

install_dependencies() {
  say "Installing dependencies..."
  npm install --silent
}

find_tailscale() {
  local app_bin="${TANDEM_TS_APP_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
  if command -v tailscale >/dev/null 2>&1; then TS_BIN="tailscale"
  elif [ -x "$app_bin" ]; then TS_BIN="$app_bin"
  else
    die "Tailscale is required. Install the standalone app or CLI, run 'tailscale up', then retry."
  fi
  local status_out status_rc
  status_out="$("$TS_BIN" status 2>&1)" && status_rc=0 || status_rc=$?
  if [ "$status_rc" -ne 0 ]; then
    case "$status_out" in
      *Logged*out*|*NeedsLogin*|*not*logged*in*) die "Tailscale is not logged in. Run 'tailscale up', then retry." ;;
      *stopped*|*failed*to*connect*|*Tailscale*running*) die "The Tailscale daemon is not running. Start it, run 'tailscale up', then retry." ;;
      *) die "Tailscale status failed. Fix the local Tailscale installation, then retry." ;;
    esac
  fi
}

tailscale_hostname() {
  "$TS_BIN" status --json 2>/dev/null | node -e '
    const fs=require("node:fs");
    try { const j=JSON.parse(fs.readFileSync(0,"utf8")); const n=String(j.Self?.DNSName??"").replace(/\.$/,""); if (!n.endsWith(".ts.net")) process.exit(1); process.stdout.write(n); } catch { process.exit(1); }
  '
}

pid_is_running() {
  [ -f "$1" ] || return 1
  local pid
  pid="$(sed -n '1p' "$1" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

wait_for_local_health() {
  local port="$1"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

setup_desktop() {
  validate_setup_values
  install_dependencies
  local desktop_dir="${STATE_ROOT}/desktop"
  local connector="${desktop_dir}/connector.json"
  prepare_state_root
  secure_directory "$desktop_dir"
  TANDEM_CONFIG_VALUE_TANDEM_CWD_ALLOWLIST="$TANDEM_CWD_ALLOWLIST" \
  TANDEM_CONFIG_VALUE_TANDEM_ENABLED_ENGINES="${TANDEM_ENABLED_ENGINES:-}" \
    write_config_from_env "${desktop_dir}/config.json"
  TANDEM_CONNECTOR_FILE="$connector" TANDEM_STDIO_PATH="${ROOT}/src/stdio-server.ts" TANDEM_CONFIG_FILE="${desktop_dir}/config.json" node --experimental-strip-types --input-type=module -e '
    import { writeProtectedFile } from "./src/runtime-config.ts";
    const connector={mcpServers:{tandem:{command:"node",args:["--experimental-strip-types",process.env.TANDEM_STDIO_PATH],env:{TANDEM_CONFIG_FILE:process.env.TANDEM_CONFIG_FILE}}}};
    await writeProtectedFile(process.env.TANDEM_CONNECTOR_FILE, JSON.stringify(connector,null,2)+"\n");
  '
  say "Desktop connector written to ${connector}"
  say "No listener or tunnel was started. Your MCP client spawns Tandem over stdio."
}

setup_hub() {
  validate_port TANDEM_PORT "$PUBLIC_PORT"
  validate_port TANDEM_FLEET_PORT "$FLEET_PORT"
  validate_port TANDEM_FLEET_HTTPS_PORT "$FLEET_HTTPS_PORT"
  [ "$FLEET_HTTPS_PORT" != "443" ] || die "TANDEM_FLEET_HTTPS_PORT must differ from public Funnel port 443."
  validate_setup_values
  find_tailscale
  command -v tmux >/dev/null 2>&1 || die "tmux is required to drive terminal engines."
  command -v curl >/dev/null 2>&1 || die "curl is required for setup verification."
  install_dependencies
  prepare_state_root

  local hub_dir="${STATE_ROOT}/hub"
  local config_file="${hub_dir}/config.json"
  local password_file="${hub_dir}/owner-password"
  local pid_file="${hub_dir}/hub.pid"
  local log_file="${hub_dir}/hub.log"
  local marker_file="${hub_dir}/provisioned"
  local active_config_hash_file="${hub_dir}/active-config.sha256"
  local enrollment_file="${hub_dir}/device-enrollment.json"
  local enrollment_state="${STATE_ROOT}/fleet/enrollments"
  local new_install=0 started=0 funnel_changed=0 serve_changed=0
  [ -f "$marker_file" ] || new_install=1
  secure_directory "$hub_dir"
  secure_directory "${STATE_ROOT}/fleet"
  secure_directory "$enrollment_state"

  local ts_host public_url private_url fleet_token owner_password
  ts_host="$(tailscale_hostname)" || die "Could not determine this device's stable Tailscale DNS name."
  public_url="https://${ts_host}/mcp"
  private_url="wss://${ts_host}:${FLEET_HTTPS_PORT}/"

  if [ -f "$config_file" ]; then
    fleet_token="$(TANDEM_READ_CONFIG="$config_file" node --experimental-strip-types --input-type=module -e 'import {readProtectedRuntimeConfig} from "./src/runtime-config.ts"; const c=await readProtectedRuntimeConfig(process.env.TANDEM_READ_CONFIG); process.stdout.write(c.TANDEM_FLEET_TOKEN??"")')"
  else
    fleet_token="$(generate_secret)"
  fi
  [ "${#fleet_token}" -ge 16 ] || die "Existing protected hub configuration is invalid."
  if [ ! -f "$password_file" ]; then
    owner_password="$(generate_secret)"
    TANDEM_SECRET_FILE="$password_file" TANDEM_SECRET_VALUE="$owner_password" node --experimental-strip-types --input-type=module -e 'import {writeProtectedFile} from "./src/runtime-config.ts"; await writeProtectedFile(process.env.TANDEM_SECRET_FILE, process.env.TANDEM_SECRET_VALUE+"\n")'
    unset owner_password
  fi

  TANDEM_CONFIG_VALUE_TANDEM_PUBLIC_URL="$public_url" \
  TANDEM_CONFIG_VALUE_TANDEM_HOST="$PUBLIC_HOST" \
  TANDEM_CONFIG_VALUE_TANDEM_PORT="$PUBLIC_PORT" \
  TANDEM_CONFIG_VALUE_TANDEM_CWD_ALLOWLIST="$TANDEM_CWD_ALLOWLIST" \
  TANDEM_CONFIG_VALUE_TANDEM_ENABLED_ENGINES="${TANDEM_ENABLED_ENGINES:-}" \
  TANDEM_CONFIG_VALUE_TANDEM_FLEET_TOKEN="$fleet_token" \
  TANDEM_CONFIG_VALUE_TANDEM_FLEET_HOST="$FLEET_HOST" \
  TANDEM_CONFIG_VALUE_TANDEM_FLEET_PORT="$FLEET_PORT" \
  TANDEM_CONFIG_VALUE_TANDEM_PRIVATE_URL="$private_url" \
  TANDEM_CONFIG_VALUE_TANDEM_OWNER_PASSWORD_FILE="$password_file" \
  TANDEM_CONFIG_VALUE_TANDEM_OAUTH_STATE_DIR="${STATE_ROOT}/oauth" \
  TANDEM_CONFIG_VALUE_TANDEM_ENROLLMENT_STATE_DIR="$enrollment_state" \
    write_config_from_env "$config_file"
  unset fleet_token
  local desired_config_hash
  desired_config_hash="$(config_digest "$config_file")"

  rollback() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
      warn "Setup failed. Rolling back changes from this attempt."
      if [ "$new_install" -eq 1 ]; then
        [ "$serve_changed" -eq 0 ] || "$TS_BIN" serve --bg --https="$FLEET_HTTPS_PORT" off >/dev/null 2>&1 || true
        [ "$funnel_changed" -eq 0 ] || "$TS_BIN" funnel --bg --https=443 off >/dev/null 2>&1 || true
        rm -f "$enrollment_file"
      fi
      if [ "$started" -eq 1 ] && pid_is_running "$pid_file"; then kill "$(sed -n '1p' "$pid_file")" 2>/dev/null || true; fi
      [ "$started" -eq 0 ] || rm -f "$pid_file"
    fi
    trap - EXIT
    exit "$rc"
  }
  trap rollback EXIT

  local active_config_hash=""
  if [ -f "$active_config_hash_file" ] && [ ! -L "$active_config_hash_file" ] && [ -O "$active_config_hash_file" ]; then
    active_config_hash="$(sed -n '1p' "$active_config_hash_file" 2>/dev/null || true)"
  fi
  if pid_is_running "$pid_file" && [ "$active_config_hash" = "$desired_config_hash" ] && curl -fsS --max-time 2 "http://127.0.0.1:${PUBLIC_PORT}/health" >/dev/null 2>&1; then
    say "Hub process is already healthy. Reusing it."
  else
    if pid_is_running "$pid_file"; then
      say "Hub configuration changed. Restarting the recorded Tandem process."
      kill "$(sed -n '1p' "$pid_file")" 2>/dev/null || true
      for _ in $(seq 1 20); do pid_is_running "$pid_file" || break; sleep 0.1; done
    fi
    rm -f "$pid_file"
    TANDEM_CONFIG_FILE="$config_file" node --experimental-strip-types src/server.ts >"$log_file" 2>&1 &
    local hub_pid=$!
    printf '%s\n' "$hub_pid" > "$pid_file"
    chmod 600 "$pid_file" "$log_file"
    started=1
    wait_for_local_health "$PUBLIC_PORT" || die "The hub did not become healthy. Review the protected hub log."
    TANDEM_SECRET_FILE="$active_config_hash_file" TANDEM_SECRET_VALUE="$desired_config_hash" node --experimental-strip-types --input-type=module -e 'import {writeProtectedFile} from "./src/runtime-config.ts"; await writeProtectedFile(process.env.TANDEM_SECRET_FILE, process.env.TANDEM_SECRET_VALUE+"\n")'
  fi

  say "Publishing only the OAuth/MCP port through Tailscale Funnel..."
  "$TS_BIN" funnel --bg "$PUBLIC_PORT" >/dev/null 2>&1 || die "Tailscale Funnel could not publish the public MCP listener."
  funnel_changed=1
  say "Publishing only the fleet port through tailnet-only Tailscale Serve..."
  "$TS_BIN" serve --bg --https="$FLEET_HTTPS_PORT" "http://127.0.0.1:${FLEET_PORT}" >/dev/null 2>&1 || die "Tailscale Serve could not publish the private fleet listener."
  serve_changed=1

  local public_ok=0 private_ok=0
  local public_verify_origin="https://${ts_host}"
  local private_verify_ws="$private_url"
  local private_verify_health="https://${ts_host}:${FLEET_HTTPS_PORT}/health"
  if [ "${NODE_ENV:-}" = "test" ] && [ "${TANDEM_SETUP_TEST_LOOPBACK:-0}" = "1" ]; then
    public_verify_origin="http://127.0.0.1:${PUBLIC_PORT}"
    private_verify_ws="ws://127.0.0.1:${FLEET_PORT}/"
    private_verify_health="http://127.0.0.1:${FLEET_PORT}/health"
  fi
  for _ in $(seq 1 "$VERIFY_TRIES"); do
    if curl -fsS --max-time 5 "${public_verify_origin}/health" >/dev/null 2>&1 && \
       curl -fsS --max-time 5 "${public_verify_origin}/.well-known/oauth-authorization-server" | grep -q 'authorization_endpoint'; then public_ok=1; break; fi
    sleep 2
  done
  [ "$public_ok" -eq 1 ] || die "Public Funnel health or OAuth metadata verification failed."

  TANDEM_VERIFY_FLEET_URL="$private_verify_ws" node --experimental-strip-types --input-type=module -e '
    import { WebSocket } from "ws";
    const result = await new Promise((resolve) => { const ws=new WebSocket(process.env.TANDEM_VERIFY_FLEET_URL); const done=(ok)=>{ws.terminate();resolve(ok)}; ws.once("unexpected-response",(_r,res)=>done(res.statusCode===401)); ws.once("open",()=>done(false)); ws.once("error",()=>done(false)); setTimeout(()=>done(false),5000); });
    if (!result) process.exit(1);
  ' && private_ok=1
  [ "$private_ok" -eq 1 ] || die "Private Serve accepted an unauthenticated WebSocket or could not be verified."
  curl -fsS --max-time 5 "$private_verify_health" | grep -q '"localDevice":true' \
    || die "Private Serve could not verify the hub's local device registration."

  TANDEM_CONFIG_FILE="$config_file" node --experimental-strip-types src/enrollment-cli.ts create "$enrollment_file" >/dev/null
  TANDEM_CONNECTOR_FILE="${hub_dir}/connector.json" TANDEM_CONNECTOR_URL="$public_url" node --experimental-strip-types --input-type=module -e '
    import {writeProtectedFile} from "./src/runtime-config.ts";
    await writeProtectedFile(process.env.TANDEM_CONNECTOR_FILE, JSON.stringify({name:"tandem",url:process.env.TANDEM_CONNECTOR_URL},null,2)+"\n");
  '
  printf 'ready\n' > "$marker_file"
  chmod 600 "$marker_file"
  trap - EXIT

  say "Tandem hub is ready."
  printf 'MCP URL: %s\n' "$public_url"
  printf 'Owner consent password: stored in %s\n' "$password_file"
  printf 'First device: securely copy %s, then run ./setup.sh device <copied-bundle>\n' "$enrollment_file"
  printf 'The invitation expires in 15 minutes and can be consumed once. The enrolled device does not expire.\n'
  printf 'Run ./setup.sh invite once for every additional device. No credential was printed.\n'
}

setup_invite() {
  [ "$#" -le 1 ] || die "Usage: ./setup.sh invite"
  prepare_state_root
  local hub_dir="${STATE_ROOT}/hub"
  local config_file="${hub_dir}/config.json"
  local invitations_dir="${hub_dir}/invitations"
  [ -f "$config_file" ] || die "The Tandem hub is not configured. Run './setup.sh hub' first."
  secure_directory "$invitations_dir"
  local bundle_file="${invitations_dir}/device-enrollment-$(generate_secret | cut -c1-12).json"
  TANDEM_CONFIG_FILE="$config_file" node --experimental-strip-types src/enrollment-cli.ts create "$bundle_file" >/dev/null
  say "Independent device invitation created."
  printf 'Invitation file: %s\n' "$bundle_file"
  printf 'Securely copy it to one device and run ./setup.sh device <copied-bundle> within 15 minutes.\n'
  printf 'Once enrolled, that device stays authorized and reconnects automatically. Repeat ./setup.sh invite for more devices.\n'
}

setup_device() {
  find_tailscale
  command -v tmux >/dev/null 2>&1 || die "tmux is required to drive terminal engines."
  install_dependencies
  prepare_state_root
  local device_dir="${STATE_ROOT}/device"
  local config_file="${device_dir}/config.json"
  local ready_file="${device_dir}/ready"
  local pid_file="${device_dir}/device.pid"
  local log_file="${device_dir}/device.log"
  secure_directory "$device_dir"

  if [ ! -f "$config_file" ]; then
    validate_setup_values
    local bundle="${2:-${TANDEM_ENROLLMENT_FILE:-}}"
    [ -n "$bundle" ] || die "A protected one-time enrollment bundle is required for the first device setup."
    [ -f "$bundle" ] || die "The enrollment bundle does not exist."
    local device_id="${TANDEM_DEVICE_ID:-}"
    if [ -z "$device_id" ]; then device_id="device-$(generate_secret | cut -c1-10)"; fi
    local device_name="${TANDEM_DEVICE_NAME:-device}"
    TANDEM_SETUP_DEVICE_ID="$device_id" \
    TANDEM_SETUP_DEVICE_NAME="$device_name" \
    TANDEM_SETUP_ALLOWLIST="$TANDEM_CWD_ALLOWLIST" \
    TANDEM_SETUP_ENABLED_ENGINES="${TANDEM_ENABLED_ENGINES:-}" \
    TANDEM_SETUP_DEVICE_CONFIG="$config_file" \
    TANDEM_SETUP_READY_FILE="$ready_file" \
      node --experimental-strip-types src/enrollment-cli.ts consume "$bundle"
  else
    say "Using the existing protected device configuration."
  fi

  if pid_is_running "$pid_file" && [ -f "$ready_file" ]; then
    say "Tandem device is already registered and running."
    return
  fi
  rm -f "$ready_file" "$pid_file"
  TANDEM_CONFIG_FILE="$config_file" node --experimental-strip-types src/device-server.ts >"$log_file" 2>&1 &
  local device_pid=$!
  printf '%s\n' "$device_pid" > "$pid_file"
  chmod 600 "$pid_file" "$log_file"
  for _ in $(seq 1 20); do
    if [ -f "$ready_file" ]; then
      say "Device registered with the hub and reported its enabled capabilities."
      return
    fi
    kill -0 "$device_pid" 2>/dev/null || break
    sleep 1
  done
  kill "$device_pid" 2>/dev/null || true
  rm -f "$pid_file" "$config_file" "$ready_file"
  die "Device registration failed. The invitation was burned and no fleet credential was retained. Create a new invitation on the hub."
}

setup_r1a() {
  shift
  [ "$#" -ge 1 ] || die "Usage: ./setup.sh r1a --name tandem-<name> [--dry-run] [--secrets-dir <dir>]"
  sh "${ROOT}/packaging/hub-deploy.sh" "$@"
  printf '%s\n' \
    "Next, on each computer: install Tandem and link it to this hub (README, \"Add a computer\"):" \
    '  sh packaging/build-release.sh "$HOME/tandem-release"' \
    '  TANDEM_ARCHIVE="$(ls "$HOME"/tandem-release/*.tar.gz)" TANDEM_NO_START=1 TANDEM_NO_LIMITS=1 sh packaging/install.sh'
}

case "$ROLE" in
  r1a) setup_r1a "$@" ;;
  hub) setup_hub ;;
  invite) setup_invite "$@" ;;
  device) setup_device "$@" ;;
  desktop) setup_desktop ;;
esac
