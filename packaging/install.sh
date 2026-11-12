#!/bin/sh
# Installs Tandem.
#
#   curl -fsSL https://get.tandem.computer | sh
#
# It unpacks a release beside the ones already installed, verifies it against
# the digest that was published with it, points `current` at it, and starts the
# runtime. Nothing else is installed: no network client, no message broker, no
# database, and nothing for the person running this to configure afterwards.
#
# Running it again upgrades. The previous version is left in place, so a
# rollback is a symlink and a restart rather than a download.
set -eu

state="${TANDEM_HOME:-$HOME/.tandem}"
target=""
versions="$state/versions"
current="$state/current"
agents="$state/agents"
label="com.tandem.runtime"
archive="${TANDEM_ARCHIVE:-}"
base_url="${TANDEM_BASE_URL:-https://get.tandem.computer}"

say() { printf '%s\n' "$*"; }
fail() { printf 'tandem: %s\n' "$*" >&2; exit 1; }

# macOS and Linux keep services in different places. The difference is
# confined to two functions at the bottom; everything between here and there
# is the same on both.
case "$(uname -s)" in
  Darwin) host_os=darwin ;;
  Linux)  host_os=linux ;;
  *) fail "this installer supports macOS and Linux" ;;
esac

umask 077

work=$(mktemp -d "${TMPDIR:-/tmp}/tandem-install.XXXXXX")
# Staging directories are cleaned up too. Without this an interrupted install
# leaves a hidden tree inside versions/ forever, and repeated failures pile
# them up where nobody looks.
staging=""
previous=""
cleanup() {
  rm -rf "$work"
  [ -n "$staging" ] && rm -rf "$staging"
  # A previous version set aside mid-swap is restored rather than discarded:
  # failing an upgrade must not be how someone loses the version they had.
  if [ -n "$previous" ] && [ -d "$previous" ] && [ ! -d "$target" ]; then
    mv "$previous" "$target" 2>/dev/null || true
  fi
  [ -n "$previous" ] && rm -rf "$previous"
  return 0
}
trap cleanup EXIT INT TERM

if [ -n "$archive" ]; then
  say "installing from $archive"
  cp "$archive" "$work/tandem.tar.gz"
  [ -f "$archive.sha256" ] && cp "$archive.sha256" "$work/tandem.tar.gz.sha256"
else
  # Linux calls 64-bit ARM aarch64; releases are named arm64, as the build names them.
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  [ "$platform" = "linux-aarch64" ] && platform=linux-arm64
  say "downloading Tandem for $platform"
  curl -fsSL "$base_url/tandem-latest-$platform.tar.gz" -o "$work/tandem.tar.gz" ||
    fail "could not download Tandem"
  curl -fsSL "$base_url/tandem-latest-$platform.tar.gz.sha256" -o "$work/tandem.tar.gz.sha256" ||
    fail "could not download the release digest"
fi

# The digest is checked before anything is unpacked. An archive that does not
# match is not a slow download or a mirror being odd; it is not the release.
if [ -f "$work/tandem.tar.gz.sha256" ]; then
  expected=$(cut -d' ' -f1 < "$work/tandem.tar.gz.sha256")
  actual=$(shasum -a 256 "$work/tandem.tar.gz" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || fail "the download does not match its published digest"
else
  [ -n "$archive" ] || fail "no digest was published with this release"
  say "warning: installing a local archive with no digest"
fi

tar -xzf "$work/tandem.tar.gz" -C "$work" || fail "the download could not be unpacked"
# -mindepth 1 because the working directory is itself named tandem-something,
# and without it the search finds the directory it was told to search.
tree_count=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'tandem-*' | wc -l | tr -d ' ')
[ "$tree_count" = "1" ] || fail "the download does not look like a Tandem release"
tree=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'tandem-*')

# A release contains no symlinks - the build removes them - so any link here
# was added afterwards. Links are invisible to a file listing and would carry
# an added file's attack through a different inode type: a link at
# runtime/bridge/node_modules resolves for every bare import from that
# directory and runs whatever is at its target. Refused before anything in the
# tree is read, so no check below reads through a link to a file outside it.
if [ -n "$(find "$tree" -type l | head -n 1)" ]; then
  fail "the release contains a link it should not"
fi

[ -f "$tree/manifest.json" ] || fail "the release has no manifest"

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tree/manifest.json" | head -n 1)
[ -n "$version" ] || fail "the release manifest names no version"
# This becomes a path that gets removed, so it may be a version and nothing
# else. Quoting stops command injection; it does not stop traversal.
case "$version" in
  *[!0-9A-Za-z._-]*|*..*|'') fail "the release manifest names an implausible version" ;;
esac

# Going back to an older version is repointing `current` at one that was kept,
# never installing an old release over a newer one: an old release is still
# validly signed, so accepting it would let anyone replay a superseded build.
# The same version again is allowed; that is how an install is repaired.
if [ -f "$current/manifest.json" ]; then
  installed=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$current/manifest.json" | head -n 1)
  if [ -n "$installed" ] && [ "$installed" != "$version" ] &&
     [ "$(printf '%s\n%s\n' "$version" "$installed" | sort -V | head -n 1)" = "$version" ]; then
    fail "this release ($version) is older than the one installed ($installed)"
  fi
fi

# A release that carries its own Node installs onto a machine that has nothing.
# One that does not is refused here rather than at the first start, so nobody
# ends up with a runtime that cannot run.
if grep -q '"requiresSystemNode": *true' "$tree/manifest.json"; then
  command -v node >/dev/null 2>&1 ||
    fail "this build needs Node on the machine; use a release that bundles it"
fi

# The manifest is checked against its signature, and every file against the
# manifest. One signature therefore covers the whole tree.
#
# The public key is here, in the installer, rather than in the archive: a key
# shipped alongside what it signs proves nothing. Verification uses the system
# openssl, never a binary out of the archive being checked.
signing_key="$work/tandem-release.pub"
cat > "$signing_key" <<'PUBKEY'
TANDEM_RELEASE_PUBLIC_KEY
PUBKEY

# Asks whether this installer carries a real key, rather than whether a
# placeholder is still present - the placeholder's own name would otherwise be
# substituted along with it when a release bakes the key in.
if grep -q "BEGIN PUBLIC KEY" "$signing_key"; then
  # An installer that carries a key takes signed releases and nothing else,
  # local archive or not: otherwise removing the signature and rebuilding the
  # digests would make any changed tree installable.
  [ -f "$tree/manifest.json.sig" ] || fail "this release carries no signature"
  command -v openssl >/dev/null 2>&1 || fail "openssl is required to verify this release"
  openssl dgst -sha256 -verify "$signing_key" -signature "$tree/manifest.json.sig" "$tree/manifest.json" \
    >/dev/null 2>&1 || fail "this release is not signed by Tandem"
elif [ -z "$archive" ]; then
  # A downloaded release must be signed. Only the repository's own installer,
  # which carries no key, takes an unsigned local archive: that is how a build
  # from source is installed.
  fail "this release carries no signature"
fi

# The chain runs signature -> manifest -> digest list -> files. The middle link
# is what makes the signature mean anything: without it the per-file list is
# unsigned, and rewriting it to match altered contents would pass every check.
expected_files=$(sed -n 's/.*"filesSha256": *"\([0-9a-f]*\)".*/\1/p' "$tree/manifest.json" | head -n 1)
[ -n "$expected_files" ] || fail "the release manifest does not cover its contents"
actual_files=$(shasum -a 256 "$tree/FILES.sha256" | cut -d' ' -f1)
[ "$expected_files" = "$actual_files" ] || fail "the release contents do not match its manifest"

( cd "$tree" && shasum -a 256 -c FILES.sha256 >/dev/null 2>&1 ) ||
  fail "the release contents do not match its manifest"

# Checking the listed files is only half of it. `shasum -c` has nothing to say
# about a file that is present but unlisted, and an added file is enough on its
# own: Node resolves a bare import from the importing file's directory upward,
# so an added `runtime/src/node_modules/<name>` shadows the real dependency and
# runs as the owner at every boot. A release is what its manifest lists, and
# nothing else.
# The three names below are excluded by path, not by basename: a basename match
# would leave an unverified slot anywhere in the tree for a file that happened
# to be called one of them.
release_files() {
  ( cd "$tree" && find . \( -type f -o -type l \) |
    sed 's|^\./||' |
    grep -v -x -e manifest.json -e FILES.sha256 -e manifest.json.sig )
}

release_files | sort > "$work/present.txt"
cut -c 67- "$tree/FILES.sha256" | sort > "$work/listed.txt"
if [ -n "$(comm -3 "$work/present.txt" "$work/listed.txt" | head -n 1)" ]; then
  fail "the release contents do not match the files its manifest lists"
fi

target="$versions/$version"
staging="$versions/.$version.incoming.$$"
say "installing $version"

# Copied aside and moved into place. Removing the target first would delete the
# tree the running version is executing from whenever the same version is
# installed again - which is the documented way to repair an install - and a
# copy that then failed would leave a dangling `current` with nothing to fall
# back to. The runtime loads parts of itself lazily, so it is reading from that
# directory the whole time.
# Nothing is written under the state folder before this point, so a refused
# release leaves the machine as it found it.
mkdir -p "$versions" "$agents" "$state/run"
chmod 0700 "$state" "$versions" "$agents" "$state/run"
rm -rf "$staging"
cp -R "$tree" "$staging" || { rm -rf "$staging"; fail "the release could not be unpacked into place"; }
chmod -R go-rwx "$staging"

# Stopped only once the new tree is complete, so an install that failed above
# has left the previous one running rather than nothing.
if [ "$host_os" = "darwin" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
else
  systemctl --user stop tandem.service 2>/dev/null || true
fi

previous="$versions/.$version.previous.$$"
rm -rf "$previous"
[ -e "$target" ] && mv "$target" "$previous"
mv "$staging" "$target"
staging=""
rm -rf "$previous"
previous=""

ln -sfn "$target" "$current"

# The limits file says what sessions here may do; with none, nothing is allowed. Asked once, on the
# terminal when there is one (curl | sh in a terminal), else written allowing nothing; kept on a reinstall.
if [ -e "$state/limits.toml" ] || [ -e "$state/limits.applied.toml" ]; then
  say "keeping the limits file in $state"
elif [ -t 1 ] && ( : </dev/tty ) 2>/dev/null; then
  if ! "$current/bin/tandem" limits init </dev/tty; then
    say "warning: the limits file was not written; run 'tandem limits init'"
  fi
else
  if ! "$current/bin/tandem" limits init </dev/null; then
    say "warning: the limits file was not written; run 'tandem limits init'"
  fi
fi

if [ "$host_os" = "darwin" ]; then
  cat > "$agents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$current/bin/tandem</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$state/runtime.log</string>
  <key>StandardErrorPath</key><string>$state/runtime.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>TANDEM_HOME</key><string>$state</string></dict>
</dict>
</plist>
PLIST
  chmod 0600 "$agents/$label.plist"
else
  # A user service, not a system one: Tandem runs as the person who installed
  # it and touches nothing outside their home, so it needs no root.
  units="$HOME/.config/systemd/user"
  mkdir -p "$units"
  cat > "$units/tandem.service" <<UNIT
[Unit]
Description=Tandem runtime
After=network-online.target

[Service]
Type=simple
ExecStart="$current/bin/tandem" run
Restart=on-failure
RestartSec=10
Environment="TANDEM_HOME=$state"
StandardOutput=append:$state/runtime.log
StandardError=append:$state/runtime.log

[Install]
WantedBy=default.target
UNIT
  chmod 0600 "$units/tandem.service"
fi

# A runtime that cannot start respawns on a timer, and its log is where that
# shows up. Rotated here so an install onto a machine that has been
# crash-looping does not inherit an unbounded file.
if [ -f "$state/runtime.log" ]; then
  log_bytes=$(wc -c < "$state/runtime.log" | tr -d ' ')
  if [ "$log_bytes" -gt 10485760 ]; then
    mv "$state/runtime.log" "$state/runtime.log.1"
    chmod 0600 "$state/runtime.log.1" 2>/dev/null || true
  fi
fi

# Starting is skipped when asked. A machine already running something that
# holds the same fabric should not have a second runtime brought up underneath
# it; installing and starting are separate decisions there.
if [ "${TANDEM_NO_START:-0}" = "1" ]; then
  :
elif [ "$host_os" = "darwin" ]; then
  launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist" 2>/dev/null ||
    launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null || true
else
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now tandem.service 2>/dev/null || true
fi

# The launcher goes somewhere already on a normal PATH, without sudo.
mkdir -p "$HOME/.local/bin"
ln -sfn "$current/bin/tandem" "$HOME/.local/bin/tandem"

say ""
if [ "${TANDEM_NO_START:-0}" = "1" ]; then
  say "Tandem $version is installed. Start it with 'tandem start'."
else
  say "Tandem $version is installed and running."
fi
say ""
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "  add ~/.local/bin to your PATH to use the tandem command" ;;
esac
say ""
say "Everything else happens from your agent."
