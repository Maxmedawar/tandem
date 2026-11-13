# R1a gate (U-R1A-44)

The release gate for R1a: what is merged into `int/r1a`, how each gate row was judged, the units a
public push must clear first, what waits for the owner, and the known limits. Nothing here is pushed
or deployed; the owner's own steps are listed in section 5.

## 1. Header

- int/r1a: PENDING (filled at G4: the gated sha)
- date: PENDING (G4)
- batch suite, macOS (G2): PENDING (root passed/skipped/failed; hub passed/failed; hub deploy dry run rc)
- full suite, Linux (G3): PENDING (passed/skipped/failed; LINUX-RC)

## 2. Merge list

Merged before the gate (84): U-R1A-01 d7d7eab, 02 58863a6, 03 7a962fd, 04 5f12065, 05 727f460, 06 e8b40cd, 07 18c0782, 08 470cdaa, 09 bd666ad, 10 459cbce, 11 e05769e, 12 51eec32, 13 a3b342c, 14 038904b, 15 0c7cd0d, 16 7933ad2, 17 88560d0, 18 bd19b2d, 19 9108c3d, 20 7b4b527, 21 1fb017d, 22 7fb1df7, 23 f66511e, 24 cd05640, 25 017bde0, 26 ef921fb, 28 5e82634, 29 485f9da, 30 9a2a9cc, 31 2b456bb, 32 ce38a57, 34 9a83528, 35 8a8be90, 37 1378919, 38 d6b430f, 39 535a675, 40 f75b53a, 41 82ee830, 42 d784c82, 43 bf4b3a4, 47 cce6d8d, 48 0738180, 49 85bf6fb, 50 85cda58, 51 68e69c1, 52 582adcf, 53 7c0a385 (companion half bd28eb9 on the companion repo's int/step1), 54 f4aea91; TESTHOME-T 3d8deb4, TESTHOME-T2 b62ab9c, 33A 68d8d00, 18B 93b0b47, 14L 3ebef76, 15L 8236ebc, 31B-1 df7f7fe, 31B-2 2ee133c, 31C-1 7a86b52, 31C-2 357af83, 27A f95bdeb, 27B 7a64df0, 18D-1 f624f2b, 18D-2 f1a89c9, 33B-1 68c9561, 33B-2 4b9cb4a, 33B-3 6fc2b88, 36A d2e810d, 36B 7074709, 36D 094a948, 35B de06e3c, 36C 701ca4a, NODEWARN ee1b667, 36E cff2aa3, 33B-4H 7df3a0b, 36F 64288ee, 17B 3ef65c0, 19B bac53f6, 18C-1 0f3a9c3, HOMEPATH bfd28df, STATUSREADS 0a6c031, 40P (companion repo int/step1 8e0aef7); U-R1B-ANCHOR-3 503f115, ANCHOR-4 f0cce34, 08 562f795, 09 31692f6, GEMINI a28941b, CURSOR a61fe81, SCHEMA-DIALOGS 034713c, COPILOT 2743059, CLINE e56e247, DROID e2c8f67, GOOSE b7574f7, LINT-EMPTY 996849c, ANCHOR-1 b4bc2ab, ANCHOR-2 1d4fbaf, COPILOT-LAYOUT 67e17be; director units ruled before U-R1A-44: U-R1B-COPILOT-WORKING d18b31f, U-R1B-CLAUDE-MENU 38133e2; U-R1B-SCHEMA-DIALOGS-2 208c5bf. Split parents 27, 33, 36 are covered by their parts (27A/B, 33A/33B-1..4, 36A-F).

Merged at G0 (the five in-flight units): U-R1A-47H dc3b9d0, U-R1A-33B-4 2599e1e, U-R1A-18C-2 b719635, U-R1A-FLAKES d7fe361, U-R1A-LINUXENV 8e86124.

Merged after the list was written (before the gate): U-R1A-47I fc64cae, U-R1A-33B-5 e26bf6a, U-R1A-33B-6 9996d3e, U-R1A-CCMNAMES 51f7093.

Merged from this unit: build/r1a-44 (PENDING: G1 merge sha).

Not in this gate: U-R1A-21B and U-R1A-39B (R1b timing rows, not built), U-R1A-45, U-R1A-46.

## 3. Gate results

One line per gate row; G4 replaces each PENDING with PASS, FAIL, HELD <M-item> or N/A and its evidence line.

- A0.3 (02, 44): check-tree over the push range PASS; check-tree test file: PENDING
- A1.3 (04, 44, FLAKES): batch suite 0 failed on both hosts; hub suite 0 failed; hub deploy dry run rc=0: PENDING
- A1.9 (standing): N/A on int/r1a (lint-schema lands with U-R1B-13 on int/r1b; G5 runs it there): PENDING
- A1.17 (05, 44): hub env-names test and check-tree of hub; core half (CCM_ settings) via U-R1A-CCMNAMES: PENDING
- A1.1 (16, 14L, 15L): hermes, grok and antigravity engine tests; lint-agents; grok and antigravity live rows: PENDING
- A1.2 (16): hermes engine test; lint-agents PASS: PENDING
- A1.4, A1.10 (21): no-bus test; the 100k fabric memory bench: PENDING
- A1.6 (10): harness engine and MCP server tests: PENDING
- A1.14 (44): relay live rows (claude pair, codex pair) both pass: PENDING
- A1.18 (23): memory-home e2e: PENDING
- A1.19 (47, 47H): memory-scope test: PENDING
- A1.20 (22): tools-list test: PENDING
- A2.7 (09): harness-detect test: PENDING
- A2.8 (19): terminal-session test: PENDING
- A3.1, A3.5, A3.11, A3.14 (27A): delivery-notice and mailbox tests: PENDING
- A3.2 (33B-3): hub-presence and presence-two-computers tests: PENDING
- A3.3 (24): mailbox test: PENDING
- A3.4 (34): rooms-gating test: PENDING
- A3.6 (28): mailbox-hostile test: PENDING
- A3.9 (36A): agent-caller test: PENDING
- A3.10 (35): kill-switch test: PENDING
- A3.12, A3.15, A3.16 (33B-2): hub-mail, mail-two-computers and mailbox tests: PENDING
- A3.13 (36B): remote-command and agent-two-computers tests: PENDING
- A4.8, A4.27 (48, 17B): limits-cli and limits-hub tests: PENDING
- A4.10 (06): hub-link test: PENDING
- A4.11 (07): hub-rpc test and hub-local e2e: PENDING
- A4.12 (30): envelope test: PENDING
- A4.13, A4.21 (31): roster test: PENDING
- A4.28 (44): local-only e2e (macOS) and its Linux row: PENDING
- A5.2 (40P, STATUSREADS): menu bar print and release contents (companion repo); status test; real-fleet half HELD (M6): PENDING
- A5.14 (18D-1, 18C-2): empty-prompt, relay-gate, hermes and delivery-notice tests; empty-prompt live row: PENDING
- A6.1 (37): transcripts tests: PENDING
- A6.3, A6.13, A6.14 (39): transcript search test: PENDING
- A10.1 (42): migrate test: PENDING
- A10.2 (43, HOMEPATH): cutover test Linux row; cutover install dry run under the stub PATH and a temp HOME: PENDING
- A10.3 (03): check-parity PASS: PENDING
- A11.1, A11.2 (51): ccusage and read-only usage tests; the Linux strace and logging-proxy half from unit evidence: PENDING
- A11.3, A11.4 (52): usage report test and usage-two-computers e2e: PENDING
- A11.5 (53): usage status test; menu bar build (companion repo); screenshot HELD (Screen Recording permission): PENDING
- A11.6 (54): syncthing spike in the test container, pinned binaries: PENDING

## 4. Security list

Rule (plan row U-R1A-44): every unit whose class is HIGH, or whose row names a secret, token, login,
signature or loopback check, is on this list; each must be merged and audited before a public push.
One line each: unit, merge sha (or not built), why.

- U-R1A-02 58863a6 HIGH
- U-R1A-04 5f12065 login (hub dry-run deploy, no login)
- U-R1A-05 727f460 HIGH
- U-R1A-06 e8b40cd HIGH
- U-R1A-08 470cdaa HIGH
- U-R1A-17 88560d0 HIGH
- U-R1A-18 bd19b2d HIGH
- U-R1A-28 5e82634 HIGH
- U-R1A-30 9a2a9cc HIGH
- U-R1A-31 2b456bb HIGH
- U-R1A-33 split parent: covered by 33A and 33B-1..4 HIGH
- U-R1A-35 8a8be90 HIGH
- U-R1A-36 split parent: covered by its parts below HIGH
- U-R1A-39 535a675 HIGH
- U-R1A-47 cce6d8d HIGH
- U-R1A-49 85bf6fb HIGH
- U-R1A-51 68e69c1 token (tokens per account)
- U-R1A-TESTHOME-T 3d8deb4 HIGH
- U-R1A-TESTHOME-T2 b62ab9c HIGH
- U-R1A-18B 93b0b47 HIGH
- U-R1A-31B-1 df7f7fe HIGH
- U-R1A-31B-2 2ee133c HIGH
- U-R1A-31C-1 7a86b52 HIGH
- U-R1A-31C-2 357af83 HIGH
- U-R1A-27A f95bdeb HIGH
- U-R1A-27B 7a64df0 HIGH
- U-R1A-18D-1 f624f2b HIGH
- U-R1A-18D-2 f1a89c9 HIGH
- U-R1A-33B-1 68c9561 HIGH
- U-R1A-33B-2 4b9cb4a HIGH
- U-R1A-33B-3 6fc2b88 HIGH
- U-R1A-36A d2e810d HIGH
- U-R1A-36B 7074709 HIGH
- U-R1A-35B de06e3c HIGH
- U-R1A-36C 701ca4a HIGH
- U-R1A-NODEWARN ee1b667 token / login wording in its row
- U-R1A-36E cff2aa3 HIGH
- U-R1A-33B-4H 7df3a0b HIGH
- U-R1A-33B-4 2599e1e HIGH
- U-R1A-36F 64288ee HIGH
- U-R1A-17B 3ef65c0 HIGH
- U-R1A-47H dc3b9d0 HIGH
- U-R1A-18C-1 0f3a9c3 HIGH
- U-R1A-18C-2 b719635 HIGH
- U-R1A-52 582adcf token (tokens and cost report)
- U-R1A-HOMEPATH bfd28df HIGH
- U-R1A-48 0738180 HIGH
- U-R1A-43 bf4b3a4 HIGH
- U-R1A-39B not built (R1b) secret (masking), not built (R1b)
- U-R1B-ANCHOR-3 503f115 HIGH
- U-R1B-ANCHOR-4 f0cce34 HIGH
- U-R1B-SCHEMA-DIALOGS-2 208c5bf HIGH
- U-R1B-SCHEMA-DIALOGS 034713c HIGH
- U-R1B-ANCHOR-1 b4bc2ab HIGH
- U-R1B-ANCHOR-2 1d4fbaf HIGH
- U-R1B-COPILOT-LAYOUT 67e17be HIGH
- U-R1B-COPILOT-WORKING d18b31f HIGH (director unit, ruled before U-R1A-44)
- U-R1B-CLAUDE-MENU 38133e2 HIGH (director unit, ruled before U-R1A-44)

Added after the list was computed (each merged into int/r1a before the gate; not counted in the 58 above):

- U-R1A-47I fc64cae HIGH (secrets at rest; merged after the list was computed)
- U-R1A-33B-5 e26bf6a HIGH (mail loss never silent; merged after the list was computed)
- U-R1A-33B-6 9996d3e follow-up of 33B-5 (system notices share one cap; class to confirm at G4; merged after the list was computed)
- U-R1A-CCMNAMES 51f7093 push condition (A1.17 core half; merged after the list was computed)

Push conditions (also on this list):

- Per-machine link tokens (U-R1A-31B-1; the U-R1A-07 audit ruling): every computer links with its own token.
- U-R1A-46 passes 3 of 3.
- A1.17 core half: no CCM_ setting name read by core (U-R1A-CCMNAMES, merged; its old-name warning path is checked at G4).
- Q-21: an applied limits file without hub_commands or hub_reads reads them off (fixed in this unit, F1).

## 5. Held for the owner, and the cutover checklist

Held (none fails the gate):

- A5.2 real-fleet half: compare the menu bar with `tandem status --json` on the cut-over fleet. Needs the new runtime running, which exists only after the cutover (M6). The gate never reads or probes the live runtime.
- Hub deploy and the second connector (U-R1A-45 page; M5).
- Cutover and the 7-day run (M6, A3.7).
- Public push (M4), after U-R1A-46 passes 3 of 3, the security list above and the A1.17 core half.
- M3 relicense MIT to Apache-2.0 (the prepared switch patch). F2 of this unit makes NOTICE and THIRD-PARTY-NOTICES ship in releases and the npm package once it is applied, and refuses a release with an Apache LICENSE and no NOTICE.
- U-R1B-04 gaps 3-4 (asset origins; the upstream of hub/src/protocol.ts) to the G2 checklist.
- A11.5 screenshot of the open menu (Screen Recording permission).
- Any live row that hits a sign-in screen (M7).

Cutover checklist:

- After cutover on each computer, open each live agent once on tandem-next (U-R1A-18C-1: sessions started before the merge are untagged, so the first open after a restart answers 409 unless the folder is in permission_skip; agents start by their real path).
- Sessions on tmux's default socket drop out of the new build's list (U-R1A-19): adopt them, or keep the old bridge for them.

## 6. Known limits

- U-R1A-19B gaps (owner U-R1A-19B follow-up): G1 a read after a passing probe still answers 200 when the capture fails; G2 an interrupt that partly fails answers 200; G3 the harness engine's turn file is not cleared when interrupt throws; G4 the kill switch's keys bypass sendKeys; G5 PARITY.md lacks send_outcome_unknown.
- U-R1A-02 audit, push-range gaps (owner: the publish step, U-R1A-46): words, forbidden paths and icons were checked at HEAD only (check-tree now reads the push range; re-check at the push); words split across lines, look-alike letters, UTF-16 text, words inside archives, secrets in .svg/.png/.pdf/package-lock.json, optimiser-rewritten icons.
- U-R1B-COPILOT-WORKING G1 (owner U-R1B-COPILOT-WORKING): a copilot screen with more than 10 lines and a second '/ commands' row reads idle, but its prompt reads not empty, so the input gate still holds.
- U-R1B-CLAUDE-MENU accepted limits (owner U-R1B-CLAUDE-MENU; needs a real Claude menu capture in a live row): G1/G2 a menu with a blank row or a placeholder box and a footer stays idle and empty, as at its base; G3 a bare-glyph box with a row directly above and a footer reads waiting (owner text refused until the screen changes), kept as built.
- A1.14 Codex row (owner U-R1A-44): bridge/relay.ts opens Claude sessions only, so the Codex pair runs the relay's builder/reviewer turns on two Codex sessions in the test rather than through bridge/relay.ts.
