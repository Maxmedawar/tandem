# Skills sync: does Syncthing work with every public service off?

Question: can the unchanged Syncthing release binary keep one folder the same on
two computers when global discovery, local discovery, relays, NAT mapping, STUN,
usage reports, crash reports and upgrades are all off, and each side only knows
the other's device ID and one fixed address that Tandem hands it?

Harness: `spike/syncthing/run.sh` (settings template `spike/syncthing/config.xml`),
run as `PODMAN_CONNECTION=<connection> sh spike/syncthing/run.sh` on a Linux
podman machine. Every container and network it makes is named `tandem-st-*` and
is removed on every exit path.

## Answer

From run (1):

```
case A: PASS connected directly (tcp-server 10.89.0.4:22000) in 0 s; 100 files and the symlink equal in 2 s; proxy: canary only; udp: no rows
case B: FAIL never connected within 120 s; proxy: canary only; udp: no rows
outcome: direct where reachable, hub link elsewhere (U-R1B-82)
```

Outcome branch: A passes and B fails. Syncthing connects directly between
computers that can reach each other's sync port; computers that cannot (each
behind its own NAT with no port forward) sync over Tandem's hub link (U-R1B-82).
U-R1B-79 to U-R1B-84 build on this outcome.

## Cases and numbers

Both cases run the same test. Side 1 holds folder `skills` with `demo/` (one
`SKILL.md` and 99 files of 4 KiB random bytes, 100 files) and a symlink
`link -> demo`; side 2 starts empty. Both share `skills` with each other. The
clock starts when both Syncthing REST APIs answer (both processes running with
the folder shared). Pass rule: within 120 s, connected directly over TCP (not a
relay), both folders equal (same paths, same sha256, the symlink a symlink with
the same target) and the proxy log holds nothing but the canary.

| | Case A | Case B |
|---|---|---|
| Layout | one `--internal` network: both sides and the proxy | each side on its own `--internal` network behind its own router (iptables MASQUERADE); the two routers and the proxy on a third `--internal` network; no port forward |
| Address each side is handed | the other side's container address, `tcp://<ip>:22000` | the other router's address on the third network, `tcp://<router ip>:22000` |
| Connected | yes, at the first poll: 0 s (1 s resolution); side 1 saw `tcp-server`, side 2 saw `tcp-client` | never, in 120 s (83 polls) |
| Folders equal | 2 s (run 2: 3 s); side 2 holds 100 files with equal sha256 and `./link -> demo` as a symlink | not applicable |
| Proxy log | 1 line, the canary `CONNECT tandem-canary.invalid:443` | 1 line, the canary |
| UDP sockets (`/proc/net/udp`, `/proc/net/udp6`, rows after the header) | 0 in every poll, both sides | 0 in every poll (83), both sides |
| Why it failed | | a plain TCP connect from side 1 to its handed address got `ECONNREFUSED`: the peer's router has nothing on 22000, and with relays, discovery and STUN off there is no other path |
| Verdict | PASS | FAIL (expected) |

Run (2), right after, printed `release: cached, checksum ok` and the same two
verdicts.

## Release pin

The newest commit on Syncthing's main branch (`ed2e0fd`, 2026-11-09) has no
release. The newest release, v2.1.7 (2026-10-21), is 6 commits behind it. The
spike uses the v2.1.7 release binary unchanged, because Tandem will ship and run
a published, checksummed binary, never a build of an unreleased commit.
`run.sh` downloads `syncthing-linux-<arch>-v2.1.7.tar.gz` from the GitHub
release once into `${SPIKE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/tandem-spike}`
and checks its sha256 against GitHub's release digest before every use:

- arm64 `48e456690cd2b97e7d26b02b5ac35f62a3b36172267b144cfeaf02c993ab955c`
- amd64 `2edc416e7ed136b7c858ed5f3f02a3b8316589605e54c380228ceea7acbf0142`

A mismatch stops the run (exit 1). The CLI used is what v2.1.7 `--help` shows:
`syncthing generate --home=DIR` (keys and a first config), `syncthing device-id
--home=DIR`, `syncthing serve --home=DIR --no-browser --no-restart`.

## Settings

All set in `config.xml`, then read back from each running Syncthing through its
REST API (`/rest/config/options`, `/rest/config/devices/<peer>`,
`/rest/config/gui`, `/rest/config/folders/skills`) with a random API key; every
value read back as set, in both cases, on both sides. Names were checked against
https://docs.syncthing.net/users/config.html. That page is labelled "Written
for v2.1.0" (docs build v2.1.0-26-gf020590); the docs repository has no tag
newer than v2.1.0, so it is the current page for the 2.1 releases, v2.1.7
included.

| Setting in config.xml | Value | Docs confirm the name | Note |
|---|---|---|---|
| `options/globalAnnounceEnabled` | false | yes | |
| `options/localAnnounceEnabled` | false | yes | |
| `options/relaysEnabled` | false | yes | |
| `options/natEnabled` | false | yes | covers UPnP and NAT-PMP |
| `options/stunKeepaliveStartS` | 0 | yes | 0 disables STUN; there is no separate STUN switch |
| `options/urAccepted` | -1 | yes | -1 means no usage reports |
| `options/crashReportingEnabled` | false | yes | |
| `options/autoUpgradeIntervalH` | 0 | yes | plus env `STNOUPGRADE=1` |
| `options/listenAddress` | `tcp://0.0.0.0:22000` | yes | TCP only, no QUIC; the REST read-back calls it `listenAddresses` (a list) |
| `device/address` (peer) | `tcp://<peer ip>:22000`, one, never `dynamic` | yes | REST: `addresses` |
| `device@introducer` (peer) | false | yes | |
| `device/autoAcceptFolders` (peer) | false | yes | |
| `gui/address` | `127.0.0.1:8384` | yes | GUI and REST API only inside the container |

`STNOUPGRADE` is not on the config page; v2.1.7 `serve --help` lists it as the
environment form of `--no-upgrade`. The run prints it from `/proc/<pid>/environ`
of each `syncthing` process, next to `HTTP_PROXY` and `HTTPS_PROXY`, and fails
if `all_proxy` is set (Syncthing would route peer traffic through it).

## What the proxy cannot see, and what checks it

Each Syncthing container gets `HTTP_PROXY` and `HTTPS_PROXY` pointing at a Node
proxy that logs one line per request and forwards nothing. Before Syncthing
starts, one canary `CONNECT` from a Syncthing container must reach that log, so
the proxy path is proven live. This catches every HTTP(S) call: global discovery,
the relay pool list (relay addresses are learned from it or from discovery),
upgrade checks, usage and crash reports.

A proxy cannot see UDP: local discovery broadcasts, STUN, UPnP and NAT-PMP, and
QUIC are all UDP. The run reads `/proc/net/udp` and `/proc/net/udp6` in both
Syncthing containers on every poll and once more at the end; any row after the
header fails the case. All rows stayed at 0. A poll every 1-2 s can miss a
socket that opens and closes between polls; the listeners and keepalive sockets
these features need stay open, so they would show. All networks are
`--internal`, so a call the checks missed would fail rather than leave the
machine.
