#!/bin/sh
# hub-deploy.sh: deploy the Tandem hub (hub/) to Cloudflare under a NEW Worker name.
#
# Usage: sh packaging/hub-deploy.sh --name <worker> [--dry-run] [--secrets-dir <dir>]
#
# A real run, in this order, stopping at the first failure:
#   1 wrangler whoami                      (you are logged in)
#   2 wrangler deployments list --name     (must FAIL: no Worker of that name yet)
#   3 wrangler kv namespace create OAUTH_KV_<name>
#   4 the two secrets (made once, kept in the secrets folder, reused on a retry) and the
#     generated config: hub/wrangler.jsonc with the new name, absolute paths and the KV id
#   5 wrangler secret put TANDEM_HUB_PASSWORD and TANDEM_HUB_LINK_TOKEN (values on stdin)
#   6 wrangler deploy --config <generated>  (the Durable Object migrations apply here)
# hub/wrangler.jsonc is never written. --dry-run skips 1, 2, 3 and 5, writes no secret and only
# builds the bundle (wrangler deploy --dry-run) in a private temporary folder.
set -eu
umask 077

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
wrangler=${TANDEM_WRANGLER:-$repo/hub/node_modules/.bin/wrangler}
usage='usage: sh packaging/hub-deploy.sh --name <worker> [--dry-run] [--secrets-dir <dir>]'

say() { printf 'hub-deploy: %s\n' "$*"; }
refuse() { printf 'hub-deploy: %s\n' "$1" >&2; exit "${2:-1}"; }

name="" dry=0 secrets=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name) [ "$#" -ge 2 ] || refuse "--name needs a value; $usage"; name=$2; shift 2 ;;
    --secrets-dir) [ "$#" -ge 2 ] || refuse "--secrets-dir needs a value; $usage"; secrets=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) refuse "unknown option $1; $usage" 2 ;;
  esac
done
[ -n "$name" ] || refuse "--name is required; $usage"
[ "$name" != "cloud-code-mcp" ] || refuse "cloud-code-mcp is the old hub; this script never deploys over it"
rest=${name#tandem-}
bad_name="the Worker name must match ^tandem-[a-z0-9-]{1,40}\$"
[ "$rest" != "$name" ] || refuse "$bad_name"
case "$rest" in ''|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) refuse "$bad_name" ;; esac
[ "${#rest}" -le 40 ] || refuse "$bad_name"
[ -n "$secrets" ] || secrets="$HOME/.tandem-next/hub-deploy/$name"
command -v node >/dev/null 2>&1 || refuse "node is required (Node 22 or newer)"

# wrangler reads no config from the folder it starts in: the repo top has none.
cd "$repo"

# Writes the generated config $1: hub/wrangler.jsonc with name, main, alias and $schema made
# absolute to hub/, and the OAUTH_KV binding's id = $2. Everything else (durable_objects,
# migrations, vars, flags) is copied as it is.
gen_config() {
  TANDEM_GEN_HUB="$repo/hub" TANDEM_GEN_OUT="$1" TANDEM_GEN_KV="$2" TANDEM_GEN_NAME="$name" node -e '
    const fs = require("node:fs"), path = require("node:path");
    const hub = process.env.TANDEM_GEN_HUB, out = process.env.TANDEM_GEN_OUT;
    const strings = /("(?:\\.|[^"\\])*")/.source;
    const text = fs.readFileSync(path.join(hub, "wrangler.jsonc"), "utf8")
      .replace(new RegExp(strings + "|//[^\\n]*|/\\*[\\s\\S]*?\\*/", "g"), (m, s) => s ?? "")
      .replace(new RegExp(strings + "|,(?=\\s*[}\\]])", "g"), (m, s) => s ?? "");
    const c = JSON.parse(text);
    c.name = process.env.TANDEM_GEN_NAME;
    c.main = path.resolve(hub, c.main);
    if (c.$schema) c.$schema = path.resolve(hub, c.$schema);
    for (const k of Object.keys(c.alias ?? {})) c.alias[k] = path.resolve(hub, c.alias[k]);
    const kv = (c.kv_namespaces ?? []).find((b) => b.binding === "OAUTH_KV");
    if (!kv) throw new Error("hub/wrangler.jsonc has no OAUTH_KV binding");
    kv.id = process.env.TANDEM_GEN_KV;
    fs.writeFileSync(out + ".tmp", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(out + ".tmp", out);
  '
}

if [ "$dry" = 1 ]; then
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/hub-deploy.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM
  gen_config "$tmp/wrangler.jsonc" 00000000000000000000000000000000
  "$wrangler" deploy --dry-run --outdir "$tmp/out" --config "$tmp/wrangler.jsonc" </dev/null
  rm -rf "$tmp"
  trap - EXIT INT TERM
  say "dry run: nothing was created"
  exit 0
fi

made=""
fail() {
  say "step $1 failed: $2" >&2
  if [ -n "$made" ]; then say "already made, remove it if you give up on $name:$made" >&2; fi
  exit 1
}

# 1 logged in (plain whoami exits 0 when it is not, so its words are read too).
who=$("$wrangler" whoami </dev/null 2>&1) || fail 1 "wrangler whoami (log in with: $wrangler login)"
case "$who" in *"not authenticated"*) fail 1 "wrangler whoami: not logged in (log in with: $wrangler login)" ;; esac

# 2 no Worker of that name yet.
if "$wrangler" deployments list --name "$name" </dev/null >/dev/null 2>&1; then
  refuse "a Worker named $name already exists; pick a new name"
fi

# 3 the OAuth KV namespace, and its id from wrangler's output (toml `id = "..."` or json `"id": "..."`).
ns="OAUTH_KV_$(printf '%s' "$name" | tr '-' '_')"
kv_out=$("$wrangler" kv namespace create "$ns" </dev/null 2>&1) || fail 3 "wrangler kv namespace create $ns"
kv_id=$(printf '%s\n' "$kv_out" | sed -n 's/.*id"\{0,1\}[ ]*[=:][ ]*"\([0-9a-f]\{32\}\)".*/\1/p' | head -n 1)
[ -n "$kv_id" ] || fail 3 "wrangler kv namespace create $ns (no namespace id in its output)"
made="$made KV namespace $ns (wrangler kv namespace delete --namespace-id $kv_id)"

# 4 the secrets folder, the two secrets (kept when there) and the generated config.
mkdir -p "$secrets"
chmod 700 "$secrets"
# $1 file, $2 length, $3 the command that prints at least that many good characters.
make_secret() {
  if [ -f "$1" ]; then return 0; fi
  part=$(mktemp "$1.XXXXXX")
  sh -c "$3" | head -c "$2" > "$part"
  [ "$(wc -c < "$part" | tr -d ' ')" = "$2" ] || { rm -f "$part"; fail 4 "making $1"; }
  chmod 600 "$part"
  mv -f "$part" "$1"
}
make_secret "$secrets/hub-password" 32 "openssl rand -base64 96 | tr -dc 'A-Za-z0-9'"
make_secret "$secrets/link-token" 48 "openssl rand -hex 24"
config="$secrets/wrangler.jsonc"
gen_config "$config" "$kv_id" || fail 4 "writing $config"

# 5 the secrets, before the first deploy (wrangler makes the Worker for its first secret).
for key in TANDEM_HUB_PASSWORD TANDEM_HUB_LINK_TOKEN; do
  case "$key" in TANDEM_HUB_PASSWORD) file="$secrets/hub-password" ;; *) file="$secrets/link-token" ;; esac
  put=$("$wrangler" secret put "$key" --name "$name" --config "$config" < "$file" 2>&1) || { printf '%s\n' "$put" >&2; fail 5 "wrangler secret put $key"; }
  case "$made" in *"Worker $name"*) ;; *) made="$made; Worker $name (wrangler delete --name $name)" ;; esac
done

# 6 deploy: the Durable Object migrations (v1, v2) apply on this first deploy.
out=$("$wrangler" deploy --config "$config" </dev/null 2>&1) || { printf '%s\n' "$out" >&2; fail 6 "wrangler deploy"; }
printf '%s\n' "$out"
url=$(printf '%s\n' "$out" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1 || true)
say "deployed $name"
if [ -n "$url" ]; then
  say "Worker URL $url"
  say "connector URL $url/mcp"
else
  say "Worker URL not found in wrangler's output; read it in the Cloudflare dashboard, the connector URL is <it>/mcp"
fi
say "owner password file $secrets/hub-password"
say "link token file $secrets/link-token (give it to scripts/cutover.sh --hub-token-file)"
