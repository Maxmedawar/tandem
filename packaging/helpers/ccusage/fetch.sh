#!/bin/sh
# fetch.sh [<platform>] <out-file>: writes the pinned ccusage native helper (PIN.md) to <out-file>,
# mode 0755. <platform> is darwin-arm64, darwin-x64, linux-arm64 or linux-x64 (build-release.sh's
# node_platform); omitted = this machine. The npm tarball is checked against the sha512 integrity
# written below before anything is taken out of it, and cached at <repo>/.cache/helpers/; a cached
# tarball is used only when it still matches. A mismatch exits 1 and leaves no file. Only
# `package/bin/ccusage` is extracted. Prints nothing on success.
set -eu

version=20.0.49
case $# in
  1) platform=""; out=$1 ;;
  2) platform=$1; out=$2 ;;
  *) echo "usage: fetch.sh [<platform>] <out-file>" >&2; exit 2 ;;
esac
if [ -z "$platform" ]; then
  arch=$(uname -m)
  case "$arch" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; esac
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$arch"
fi
case "$platform" in
  darwin-arm64) integrity='sha512-nEYFIyA1WaAOLPTw5JHFShgQbkDArravcGzEopVz/rIWJuZmfMvE4CCJ111A0thCn72TzJi3/q+ByNOfGGXh/Q==' ;;
  darwin-x64)   integrity='sha512-OOrqJ7T3Uxee+J8+nyui0SAszxHY93J/T4gU0X8HgrP7qEXw7dioR46XjAyXtoryZMF+t87FbPye/FJ6qdRrWg==' ;;
  linux-arm64)  integrity='sha512-c1/4mP5kRNnq65HIoG6F5gvzETAYoocVuDO5N6gaP0n4vR5g58iIe2KVkoERemmKsXVWpI0cp6bsLYfTvFFmRQ==' ;;
  linux-x64)    integrity='sha512-MITIo4RpJuskZqpk80VrZ8uE6QsN3uJFY3R0NXO2jZOB1qL7MqVkYuGQC0lFqsTp5ux6UC/nOa+ZubaP3ED/nQ==' ;;
  *) echo "ccusage helper: no build for $platform" >&2; exit 1 ;;
esac
url="https://registry.npmjs.org/@ccusage/ccusage-$platform/-/ccusage-$platform-$version.tgz"

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
cache="$repo/.cache/helpers"
tgz="$cache/ccusage-$platform-$version.tgz"

matches() {
  node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs");
    process.exit("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64") === process.argv[2] ? 0 : 1)' "$1" "$integrity"
}

mkdir -p "$cache"
if ! { [ -f "$tgz" ] && matches "$tgz"; }; then
  rm -f "$tgz"
  part="$tgz.$$.part"
  trap 'rm -f "$part"' EXIT
  curl -fsSL --proto '=https' -o "$part" "$url"
  if ! matches "$part"; then
    rm -f "$part"
    echo "ccusage helper: digest mismatch" >&2
    exit 1
  fi
  mv "$part" "$tgz"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/ccusage-helper.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xzf "$tgz" -C "$work" package/bin/ccusage
cp "$work/package/bin/ccusage" "$out.$$.tmp"
chmod 0755 "$out.$$.tmp"
mv "$out.$$.tmp" "$out"
