#!/bin/sh
# Builds a self-contained Tandem runtime tree and packs it for distribution.
#
# The output is everything a machine needs to run Tandem and nothing else: the
# launcher, the runtime sources and the built-in harness files, the runtime's
# dependencies, and a manifest naming what is inside and under which licence. It
# carries no repository history, no development configuration, and no credential
# of any kind - `test/release-contents.test.ts` is what holds that, because a
# leak of that sort is not visible by looking at a tarball.
#
# Usage: packaging/build-release.sh [output-directory]
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=${1:-"$repo_root/dist/release"}
version=$(node -e "process.stdout.write(require('$repo_root/package.json').version)")

# The machine being built for, which is this one unless told otherwise.
# Cross-building matters because an owner's machines are not all the same:
# a Mac, another Mac, and a Linux box under WSL is an ordinary set. Linux calls
# 64-bit ARM aarch64; a release calls it arm64, on every side.
host="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
[ "$host" = "linux-aarch64" ] && host=linux-arm64
platform="${TANDEM_TARGET:-$host}"
case "$platform" in
  darwin-arm64)  node_platform=darwin-arm64 ;;
  darwin-x86_64) node_platform=darwin-x64 ;;
  linux-x86_64)  node_platform=linux-x64 ;;
  linux-arm64|linux-aarch64) platform=linux-arm64; node_platform=linux-arm64 ;;
  *) echo "unsupported target: $platform" >&2; exit 1 ;;
esac
cross=0
[ "$platform" != "$host" ] && cross=1

stage="$out_dir/tandem-$version-$platform"

# A release carries the code it was built from, so a known-vulnerable
# dependency in it is a known-vulnerable dependency in the product. The scan
# runs here rather than only in review, because a release is where it stops
# being a repository's problem and becomes a user's.
if [ "${TANDEM_SKIP_AUDIT:-0}" != "1" ]; then
  # `set -e` would take an assignment's failing substitution as a reason to
  # exit, which killed this gate before it could report anything: an offline
  # build machine and a real advisory both aborted the build silently. The `if`
  # is what makes the status recoverable.
  if audit_output=$( cd "$repo_root" && npm audit --omit=dev --audit-level=high 2>&1 ); then
    audit_output=""
  else
    # An unreachable registry and a real advisory both exit non-zero, and they
    # are different problems: one blocks the release, the other means the check
    # did not run. Reporting them as the same thing would teach whoever hits it
    # to skip the gate.
    case "$audit_output" in
      *ENOTFOUND*|*ECONNREFUSED*|*ETIMEDOUT*|*EAI_AGAIN*|*"network"*)
        echo "release warning: the advisory check could not reach the registry; it did not run" >&2
        ;;
      *)
        echo "release blocked: a production dependency has a high or critical advisory" >&2
        echo "run 'npm audit --omit=dev' to see it, or TANDEM_SKIP_AUDIT=1 to build anyway" >&2
        exit 1
        ;;
    esac
  fi
fi

echo "building Tandem $version for $platform"
rm -rf "$stage"
mkdir -p "$stage/runtime" "$stage/bin" "$stage/libexec"

# The runtime itself. Only what runs: no tests, no benchmarks, no development
# configuration, and no dotfiles. The bridge imports two hub files (the frame
# protocol and the bridge id), and the harness registry reads the built-in
# harness files from the folder beside it.
echo "  runtime"
( cd "$repo_root" && find bridge src -type f -name '*.ts' ! -name '*.test.ts' -exec sh -c '
    for file do mkdir -p "$0/${file%/*}" && cp "$file" "$0/$file" || exit 1; done' "$stage/runtime" {} + )
mkdir -p "$stage/runtime/hub/src"
cp "$repo_root/hub/src/protocol.ts" "$repo_root/hub/src/bridge-id.ts" "$repo_root/hub/src/devices.ts" "$stage/runtime/hub/src/"
cp -R "$repo_root/harnesses" "$stage/runtime/harnesses"
cp "$repo_root/package.json" "$stage/runtime/package.json"

# The runtime's own dependencies, installed into the release rather than
# fetched on the target. A release that had to reach a package registry the
# first time it started would not be the one-thing install this is for, and it
# would make a machine's first run depend on a network that may not be there.
# They are copied from the tree the lockfile already resolved rather than
# installed again, so building a release does not depend on a package registry
# being reachable and two builds of the same commit carry the same bytes.
echo "  dependencies"
node - "$repo_root" "$stage/runtime" <<'NODE'
const [, , repoRoot, runtimeDir] = process.argv
const { execFileSync } = require('node:child_process')
const { cpSync, existsSync, mkdirSync } = require('node:fs')
const { join, relative } = require('node:path')

const listed = execFileSync('npm', ['ls', '--omit=dev', '--omit=optional', '--all', '--parseable'], {
  cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
})
const packages = listed.split('\n')
  .map(line => line.trim())
  .filter(line => line.includes(`${join(repoRoot, 'node_modules')}/`))

if (packages.length === 0) {
  console.error('no production dependencies resolved; run npm install first')
  process.exit(1)
}
for (const source of packages) {
  const target = join(runtimeDir, relative(repoRoot, source))
  mkdirSync(join(target, '..'), { recursive: true })
  // dereference: a symlink out of the release is not something to ship, and a
  // hoisted tree is full of them.
  cpSync(source, target, { recursive: true, dereference: true, force: true })
}
if (!existsSync(join(runtimeDir, 'node_modules'))) {
  console.error('dependencies were not copied')
  process.exit(1)
}
NODE

# npm's bin directory holds links to packages this release never executes.
rm -rf "$stage/runtime/node_modules/.bin"
find "$stage/runtime/node_modules" -type l -delete 2>/dev/null || true

# Dependencies ship their own tests, fixtures, examples, and documentation, and
# a release should carry the code it runs and the licences it must reproduce.
# The fixtures are the reason this matters rather than only the size: a package
# that ships a sample private key would put one inside a Tandem release.
echo "  pruning"
find "$stage/runtime/node_modules" \
  \( -type d \( -name test -o -name tests -o -name __tests__ -o -name example \
     -o -name examples -o -name doc -o -name docs -o -name benchmark -o -name benchmarks \
     -o -name .github -o -name coverage -o -name fixtures -o -name __fixtures__ \) \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$stage/runtime/node_modules" -type f \
  \( -name '*.map' -o -name '*.ts.map' -o -name '*.test.js' -o -name '*.spec.js' \
     -o -name '*.md' -o -name '.npmignore' -o -name '.editorconfig' -o -name '.eslintrc*' \
     -o -name 'tsconfig*.json' -o -name '*.tsbuildinfo' \) \
  ! -iname 'LICENSE*' ! -iname 'COPYING*' ! -iname 'NOTICE*' \
  -delete 2>/dev/null || true

# The runtime is TypeScript on Node, and the promise is that a person installs
# one thing. So Node ships inside the release rather than being something they
# are told to go and get.
#
# TANDEM_NODE_BINARY names one to bundle; without it, the Node running this
# build is used, which on macOS links only against system frameworks and is
# therefore portable to any machine of the same architecture. A release built
# with TANDEM_BUNDLE_NODE=0, or one whose Node licence was not found, records
# that it needs one on the target, and the installer refuses to install it onto
# a machine that has none. A cross build cannot copy this machine's Node, so it
# ships none.
bundled_node=""
bundled_node_version=""
if [ "${TANDEM_BUNDLE_NODE:-1}" != "0" ]; then
  if [ "$cross" = "1" ]; then
    echo "  node runtime (skipped: a cross build cannot bundle this machine's Node)" >&2
  else
    candidate=${TANDEM_NODE_BINARY:-$(command -v node || true)}
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      # Redistributing Node means redistributing its licence, which aggregates
      # V8, OpenSSL, ICU, libuv, zlib and others. A build that cannot find it
      # does not ship Node - refusing here is the difference between a packaging
      # gap and a licence violation.
      node_license=${TANDEM_NODE_LICENSE:-}
      if [ -z "$node_license" ]; then
        node_dir=$(CDPATH='' cd -- "$(dirname -- "$candidate")" && pwd)
        for guess in "$node_dir/../LICENSE" "$node_dir/LICENSE" "$node_dir/../share/doc/node/LICENSE"; do
          # Existence is not evidence. A prefix can hold an unrelated LICENSE,
          # and shipping that as Node's attribution is worse than none - it
          # looks like attribution.
          [ -f "$guess" ] && grep -q "Node.js is licensed" "$guess" 2>/dev/null &&
            { node_license=$guess; break; }
        done
      fi
      if [ -n "$node_license" ] && [ -f "$node_license" ]; then
        echo "  node runtime"
        cp "$candidate" "$stage/libexec/node"
        chmod 0755 "$stage/libexec/node"
        cp "$node_license" "$stage/LICENSE.node.txt"
        bundled_node="libexec/node"
        bundled_node_version=$("$candidate" -p "process.versions.node")
      else
        echo "  node runtime (skipped: its LICENSE was not found; set TANDEM_NODE_LICENSE)" >&2
      fi
    else
      echo "  node runtime (skipped: none found to bundle)"
    fi
  fi
fi

# Tokens and cost per account come from ccusage (MIT), shipped as its unchanged native binary: the
# pinned version for this release's platform, checked against its digest before it is used
# (packaging/helpers/ccusage/PIN.md). A cross build fetches the target's binary. The release ships
# it, so a build that cannot get it stops.
echo "  ccusage helper"
if ! sh "$repo_root/packaging/helpers/ccusage/fetch.sh" "$node_platform" "$stage/libexec/ccusage"; then
  echo "release blocked: the ccusage helper could not be fetched" >&2
  exit 1
fi
cp "$repo_root/packaging/helpers/ccusage/LICENSE" "$stage/LICENSE.ccusage.txt"

echo "  launcher"
cp "$repo_root/packaging/tandem" "$stage/bin/tandem"
chmod 0755 "$stage/bin/tandem"

echo "  docs"
cp "$repo_root/README.md" "$stage/README.md"
cp "$repo_root/SECURITY.md" "$stage/SECURITY.md"
cp "$repo_root/packaging/uninstall.sh" "$stage/uninstall.sh"
chmod 0755 "$stage/uninstall.sh"

# The licence, and one line per bundled package naming its version and its
# licence, read from the package itself so the list cannot drift from what ships.
echo "  notices"
cp "$repo_root/LICENSE" "$stage/LICENSE.txt"
node - "$stage/runtime/node_modules" "$bundled_node_version" <<'NODE' > "$stage/THIRD_PARTY_NOTICES.md"
const [, , modules, nodeVersion] = process.argv
const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

function packageDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => entry.name.startsWith('@')
      ? readdirSync(join(dir, entry.name), { withFileTypes: true })
        .filter(scoped => scoped.isDirectory())
        .map(scoped => ({ name: `${entry.name}/${scoped.name}`, dir: join(dir, entry.name, scoped.name) }))
      : [{ name: entry.name, dir: join(dir, entry.name) }])
    .flatMap(pkg => [pkg, ...packageDirs(join(pkg.dir, 'node_modules'))])
}

const lines = packageDirs(modules).map(({ name, dir }) => {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const license = typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN'
  return `- ${name} ${manifest.version}: ${license}`
})
lines.sort()
if (nodeVersion) lines.push(`- Node.js ${nodeVersion}: see LICENSE.node.txt`)
process.stdout.write([
  '# Third-party notices',
  '',
  'This release bundles the components below. Each package\'s own licence file',
  'ships in its folder under runtime/node_modules.',
  '',
  ...lines,
  '',
].join('\n'))
NODE
echo "- ccusage 20.0.49 (libexec/ccusage, native helper): MIT, see LICENSE.ccusage.txt" >> "$stage/THIRD_PARTY_NOTICES.md"

# The manifest is what an installer verifies and what a licence review reads.
# Every file is listed with its digest, so an installed tree can be checked
# against what was published rather than trusted because it arrived.
echo "  manifest"
# Written aside and moved into place: a digest list that hashed itself while it
# was being written would never match afterwards. Hashed in batches rather than
# one process per file, and sorted by path (the second field to the line's end).
( cd "$stage" && find . -type f ! -name manifest.json ! -name FILES.sha256 -exec shasum -a 256 {} + |
  sed 's|^\([0-9a-f]*\)  \./|\1  |' | LC_ALL=C sort -k 2 ) > "$out_dir/FILES.sha256.tmp"
mv "$out_dir/FILES.sha256.tmp" "$stage/FILES.sha256"

files_digest=$(shasum -a 256 "$stage/FILES.sha256" | cut -d' ' -f1)

node - "$stage" "$version" "$platform" "$bundled_node" "$files_digest" <<'NODE' > "$stage/manifest.json"
const [, , stage, version, platform, bundledNode, filesDigest] = process.argv
const { readFileSync } = require('node:fs')
const files = readFileSync(`${stage}/FILES.sha256`, 'utf8').trim().split('\n')
  .filter(Boolean)
  .map(line => {
    const [digest, ...rest] = line.split('  ')
    return { path: rest.join('  '), sha256: digest }
  })
process.stdout.write(`${JSON.stringify({
  product: 'Tandem',
  version,
  platform,
  statusSocket: '~/.tandem/run/status.sock',
  // False means the release carries its own Node and installs onto a machine
  // that has nothing. True means the installer must find one on the target.
  requiresSystemNode: bundledNode === '',
  components: [
    { name: 'tandem', role: 'launcher and control CLI' },
    { name: 'runtime', role: 'the background runtime' },
    ...(bundledNode === '' ? [] : [{ name: bundledNode, role: 'bundled Node runtime' }]),
  ],
  // The digest of the digest list. The signature covers this manifest, this
  // covers FILES.sha256, and that covers every file - so one signature is a
  // statement about the whole tree. Without this link the per-file list is
  // unsigned, and rewriting it to match altered contents would pass.
  filesSha256: filesDigest,
  thirdParty: 'THIRD_PARTY_NOTICES.md',
  license: 'LICENSE.txt',
  files,
}, null, 2)}\n`)
NODE

# A release is signed over its manifest, and the manifest covers every file by
# digest, so one signature is a statement about the whole tree. ECDSA P-256
# because that is what the system toolchain on a target machine can verify: an
# installer must check a signature using tooling that is already there, never
# using a binary out of the archive it is checking.
#
# Without a key this produces an unsigned release, which the installer will
# take only when explicitly pointed at a local archive. Releases published for
# download are signed.
if [ -n "${TANDEM_SIGNING_KEY:-}" ]; then
  echo "  signature"
  [ -f "$TANDEM_SIGNING_KEY" ] || { echo "signing key not found" >&2; exit 1; }
  openssl dgst -sha256 -sign "$TANDEM_SIGNING_KEY" -out "$stage/manifest.json.sig" "$stage/manifest.json"
  # Written beside the release, never inside it: a key shipped alongside what
  # it signs proves nothing, and a file added after the digest list would be
  # unlisted anyway - which the installer refuses.
  openssl ec -in "$TANDEM_SIGNING_KEY" -pubout -out "$out_dir/manifest.pub" 2>/dev/null

  # The installer that ships with a release carries the key that release was
  # signed with. The one in the repository keeps a placeholder, so rotating a
  # key is a rebuild rather than an edit, and a test can substitute its own.
  awk -v keyfile="$out_dir/manifest.pub" '
    /TANDEM_RELEASE_PUBLIC_KEY/ { while ((getline line < keyfile) > 0) print line; next }
    { print }
  ' "$repo_root/packaging/install.sh" > "$out_dir/install.sh"
  chmod 0755 "$out_dir/install.sh"
else
  echo "  signature (skipped: TANDEM_SIGNING_KEY is unset)"
fi

echo "  tarball"
# macOS stores extended attributes alongside files in an archive, as AppleDouble
# "._name" entries. Another Mac folds them back in on extraction; Linux does
# not - it writes them out as thousands of extra files, which is a release that
# no longer matches the list it was signed over. Stripped from the tree and
# suppressed in the archive, because a release should be the same bytes
# wherever it lands.
xattr -cr "$stage" 2>/dev/null || true
( cd "$out_dir" && COPYFILE_DISABLE=1 tar --no-mac-metadata \
    -czf "tandem-$version-$platform.tar.gz" "tandem-$version-$platform" 2>/dev/null ||
  COPYFILE_DISABLE=1 tar -czf "tandem-$version-$platform.tar.gz" "tandem-$version-$platform" )
# Named by the archive alone: the digest file is published, and the build
# machine's output path is not part of the release.
( cd "$out_dir" && shasum -a 256 "tandem-$version-$platform.tar.gz" > "tandem-$version-$platform.tar.gz.sha256" )

echo "built $out_dir/tandem-$version-$platform.tar.gz"
