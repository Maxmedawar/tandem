# Parity list: Synergy bridge and test files

This list has one row for every file under `bridge/` and `test/` in Synergy, the private repo, at the revision below, and says what happens to it before any port starts; `scripts/dev/check-parity.sh` checks it.
Fates: core means this repo already does the job (Where names the core files; Notes name each behaviour core lacks with the unit that ports it, or say no gap found); port means the named unit carries it over; retire means nothing in core will do the job (Where names the unit that deletes it, or says not carried over; Notes give the reason); private means it stays in the private repo.
A test file takes its source file's fate, except that test cases core lacks are a port row naming the unit that brings them; a fixture or helper follows the tests that use it.
A Notes cell that starts with GAP: names a needed behaviour that no plan unit covers yet, with the closest unit in Where.

Synergy revision: 7412e30

## Bridge files

| Synergy path | Fate | Where | Notes |
|---|---|---|---|
| `bridge/NOTES-terminal.md` | port | U-R1A-09 | The terminal notes move to `docs/dev/NOTES-terminal.md`. |
| `bridge/cli/enroll.ts` | retire | U-R1B-73 | Joins a computer to the Go mesh through a control address; the hub link and the signed roster (U-R1A-31) replace the mesh. |
| `bridge/cli/status.ts` | port | U-R1A-40 | The status command behind tandem status. |
| `bridge/codex-history.ts` | port | U-R1A-37 | Becomes the Codex transcript reader. |
| `bridge/control-socket.ts` | port | U-R1A-40 | The owner-only control socket, without the enroll operation. |
| `bridge/drivable.ts` | core | `bridge/drivable.ts` | Lacks the two errors that tell a gone session from a tmux call that failed for a moment, ported by U-R1A-19 with the tmux resilience cases. The relay name guard: no gap found (`bridge/router.ts` refuses relay names). |
| `bridge/engines-tmux.ts` | retire | U-R1B-73 | Guesses the agent in tmux panes Tandem did not start; core reads its own provenance tag and drives only its own sessions. |
| `bridge/engines.ts` | core | `bridge/engine-registry.ts`, `bridge/drivable.ts` | Plan section 3 retires it because core's registry, and later harness files, do its job. Core lacks the Grok entry (harness file, U-R1A-14) and the Gemini entry, now the Antigravity CLI (U-R1A-15); per-agent interrupt keys and first-run prompts move to the harness file keys and states (U-R1A-08, U-R1A-10). |
| `bridge/fabric/fabricd-bus.ts` | retire | U-R1B-73 | Client of the Go bus; room events go to SQLite instead (U-R1A-21). |
| `bridge/fabric/fabricd-host.ts` | retire | U-R1B-73 | Starts and supervises the Go helper, which is not brought over. |
| `bridge/fabric/local-fabric-host.ts` | port | U-R1A-20, U-R1A-21 | Carried over by U-R1A-20; U-R1A-21 removes its need for the Go bus. |
| `bridge/fabric/memory/embedding.ts` | port | U-R1A-20 | Part of the memory engine. |
| `bridge/fabric/memory/ranker.ts` | port | U-R1A-20 | Part of the memory engine; U-R1B-14 extends it later. |
| `bridge/fabric/memory/vector-store.ts` | port | U-R1A-20 | Part of the memory engine. |
| `bridge/fabric/mesh-fabric.ts` | retire | U-R1B-73 | Cross-computer fabric over the Go mesh; the hub link replaces the mesh (U-R1A-23 passes memory calls to the home computer). |
| `bridge/fabric/rpc-router.ts` | port | U-R1A-20 | Routes fabric calls arriving from the hub. |
| `bridge/fabric/sqlite-fabric-client.ts` | port | U-R1A-20 | The SQLite store for rooms, memory and projects. |
| `bridge/hermes-adapter.ts` | core | `bridge/engines/hermes.ts` | Driving an allowlisted Hermes agent: no gap found (core's adapter wins, plan section 3; U-R1A-16 keeps it). Not carried on purpose: reading channel conversations from the Hermes files, listing every gateway session, and routing by a colon in the name, which core leaves out. |
| `bridge/index.ts` | port | U-R1A-06, U-R1A-07 | U-R1A-06 carries the hub link (dial with the secret in a header, frames, heartbeat, reconnect) and U-R1A-07 the handling of hub requests; fabric start-up and its content-free audit lines go with U-R1A-20 and U-R1A-21, the status document with U-R1A-40. The rest is retired: its own session routes, drive-any-pane and the Hermes channel routing, since `bridge/router.ts` does that job. |
| `bridge/pair-env.ts` | private | U-R1B-02 | GAP: it is the bridge half of the private browser-extension pairing (plan section 3 lists it as Tailscale, which it is not). The new hub drops the extension routes and core's spawn sets no extra session environment, so the pairing has no home after U-R1B-73; closest unit U-R1B-02. |
| `bridge/reconnect.ts` | port | U-R1A-06 | Backoff and stale-socket rules for the hub link. |
| `bridge/relay.ts` | core | `bridge/relay.ts` | No gap found: core's relay has every part of this one, plus the task queue, parking and the bypass guard. |
| `bridge/sessions.ts` | core | `bridge/sessions.ts` | GAP: list_sessions in core has no agent filter, and the hub tool that U-R1A-04 ports still sends one; closest unit U-R1A-07. Claude and Codex history in the list is replaced by the transcript readers (U-R1A-37). Not carried: listing panes Tandem did not start, guessing their agent, and the default allowlist of the home folder (core's provenance check and empty allowlist win). |
| `bridge/status.ts` | port | U-R1A-40 | The status document and its socket. |
| `bridge/terminal-session.ts` | core | `bridge/terminal-session.ts`, `bridge/engines/terminal-adapter.ts` | Lacks, ported by U-R1A-19: a check before each send, read and interrupt that types nothing when tmux cannot confirm the session is alive, without dropping it; a 200 ms pause between the pasted text and Enter so Claude Code takes Enter as submit. Per-agent interrupt keys come from harness files (U-R1A-08, U-R1A-10). Not carried: driving panes Tandem did not start, agent guessing, and the pairing variable at spawn (see the `bridge/pair-env.ts` row). |
| `bridge/tmux.ts` | core | `bridge/terminal-session.ts`, `bridge/sessions.ts` | Core's tmux calls live in these two files. Lacks, all ported by U-R1A-19: retry of a tmux call that failed to start (up to 3 retries); a session list that tells no server from a failed call; a has-session probe that tells gone from a passing failure; a printable list separator that survives tmux 3.6 rewriting tabs. Exact session targets: no gap found. |

## Test files

| Synergy path | Fate | Where | Notes |
|---|---|---|---|
| `test/allowlist.test.ts` | core | `test/allowlist.test.ts` | No gap found: core has the child folder, colon list, traversal and prefix cases. The home-folder default case is not carried, since core refuses every folder until the owner lists one. |
| `test/auth-gate.test.ts` | port | U-R1A-04 | Login gate cases, into the hub tests. |
| `test/bridge-id.test.ts` | port | U-R1A-04, U-R1A-06 | The hub-side id cleaning cases go with the hub (U-R1A-04), the bridge-side id cases with the hub link (U-R1A-06). |
| `test/ccm-fire.test.ts` | private | U-R1B-02 | Tests the stop hook script of the private browser-extension pairing; U-R1B-02's move list does not name it yet (see the `bridge/pair-env.ts` row). |
| `test/codex-history.test.ts` | port | U-R1A-37 | The rollout and index parsing cases, for the Codex transcript reader. The agent-guess cases are not carried; the list filter case waits on the gap in the `bridge/sessions.ts` row. |
| `test/control-socket.test.ts` | port | U-R1A-40 | The control socket cases, without the enroll ones (enroll is retired). |
| `test/engines.test.ts` | port | U-R1A-11, U-R1A-12, U-R1A-13 | The per-agent cases (program, working and ready markers, interrupt keys, trust prompt) become harness file cases for Claude, Codex and shell, and for Grok and Antigravity in U-R1A-14 and U-R1A-15. The agent-guess cases are not carried. |
| `test/ext-mailbox.test.ts` | private | U-R1B-02 | Plan section 3 keeps the extension mailbox private. |
| `test/fabric/auth-project.test.ts` | port | U-R1A-20 | Project ownership cases. |
| `test/fabric/bridge-fabric-resilience.test.ts` | port | U-R1A-20, U-R1A-21 | Bridge start-up survives a fabric failure and writes content-free audit lines; it lands where core starts the fabric. |
| `test/fabric/bridge-fabric-rpc.test.ts` | port | U-R1A-20, U-R1A-22 | Fabric calls only through the authenticated hub path; the tool half follows U-R1A-22. |
| `test/fabric/capabilities.test.ts` | port | U-R1A-20 | Capability and validation cases. |
| `test/fabric/fabric-client-contract.test.ts` | port | U-R1A-20 | The contract runs on the SQLite and in-memory clients; its Go helper adapter is dropped with the bus. |
| `test/fabric/fabric-mcp-tools.test.ts` | port | U-R1A-20 | Room, memory and project tool registration cases. |
| `test/fabric/fabricd-bus.test.ts` | retire | U-R1B-73 | Tests the Go bus client, which is retired. |
| `test/fabric/fabricd-contract.test.ts` | retire | U-R1B-73 | Checks the wire contract with the Go helper, which is retired. |
| `test/fabric/fabricd-host.test.ts` | retire | U-R1B-73 | Tests the Go helper host, which is retired. |
| `test/fabric/fake-fabric-client.ts` | port | U-R1A-20 | Helper name used by the contract tests. |
| `test/fabric/fake-room-bus.ts` | port | U-R1A-20 | Bus double used by the phase 3 repair cases; the bus contract stays in core behind SQLite (U-R1A-21). |
| `test/fabric/in-memory-fabric-client.ts` | port | U-R1A-20 | In-memory client used by the contract, room and memory tests. |
| `test/fabric/invisibility.test.ts` | port | U-R1A-20, U-R1A-22 | Checks that the hub source keeps SQLite out of Cloudflare; its paths become `hub/src/` (U-R1A-04). |
| `test/fabric/local-fabric-host.test.ts` | port | U-R1A-20 | Local fabric host cases. |
| `test/fabric/memory-validation.test.ts` | port | U-R1A-20 | Memory input validation cases. |
| `test/fabric/phase2-memory-engine.test.ts` | port | U-R1A-20 | Memory engine cases. |
| `test/fabric/phase2-memory-eval.test.ts` | port | U-R1A-20 | Memory quality cases; they need Synergy's `bench/memory-eval.ts`, which U-R1A-20's file list does not name. |
| `test/fabric/phase2-vector-store.test.ts` | port | U-R1A-20 | Vector store cases. |
| `test/fabric/phase3-bus-repair.test.ts` | port | U-R1A-20 | The SQLite projection cases against the bus double. |
| `test/fabric/phase3-room-bus.test.ts` | retire | U-R1B-73 | Room storage on the Go bus; U-R1A-21's no-bus test covers rooms that survive a restart. |
| `test/fabric/phase4-mesh-fabric.test.ts` | retire | U-R1B-73 | Tests the Go mesh fabric, which is retired. |
| `test/fabric/phase6-crash-recovery.test.ts` | port | U-R1A-21 | The kill and recovery cases, rewritten against the SQLite store without the Go helper. |
| `test/fabric/room-contract.test.ts` | port | U-R1A-20 | Room contract cases. |
| `test/fabric/room-read-delivery.test.ts` | port | U-R1A-20 | A rejected large room read does not consume unread events. |
| `test/fabric/sqlite-fabric-client.test.ts` | port | U-R1A-20 | SQLite store cases. |
| `test/fixtures/codex/session_index.jsonl` | port | U-R1A-37 | Fixture for the Codex reader cases. |
| `test/fixtures/codex/sessions/2026/03/20/rollout-2026-03-20T11-39-29-019d0c8b-9bd8-78e3-a070-60e8d761b632.jsonl` | port | U-R1A-37 | Fixture for the Codex reader cases. |
| `test/fixtures/hermes/gateway_state.json` | retire | U-R1B-73 | Feeds only the channel-listing cases, which are not carried. |
| `test/fixtures/hermes/password.txt` | retire | U-R1B-73 | Core's Hermes cases inject the password reader, so no password file is needed. |
| `test/fixtures/hermes/sessions.json` | retire | U-R1B-73 | Feeds only the channel-listing cases, which are not carried. |
| `test/frame-size.test.ts` | port | U-R1A-04 | Frame size cases, into the hub tests. |
| `test/grok-gemini.test.ts` | port | U-R1A-14, U-R1A-15 | U-R1A-14 brings the Grok cases and U-R1A-15 the Gemini ones as Antigravity; the two list filter cases wait on the gap in the `bridge/sessions.ts` row. |
| `test/hermes-adapter.test.ts` | core | `test/engines/hermes.test.ts` | No gap found: login without Origin, one retry after 401, loopback only, the live-call guard and the pre-send cursor all have core cases. The channel and name-routing cases are not carried (see the `bridge/hermes-adapter.ts` row). |
| `test/install-lifecycle.test.ts` | port | U-R1A-38 | Install, upgrade, rollback and removal cases. |
| `test/installed-product.test.ts` | port | U-R1A-38 | Not in U-R1A-38's file list; carried with the packaging, without the bundled Go helper case. |
| `test/interrupt-keys.test.ts` | port | U-R1A-11 | The case that Claude's interrupt sends Escape, then C-c about 150 ms later; core has no case for it, and the keys move to Claude's harness file. |
| `test/login-throttle.test.ts` | port | U-R1A-04 | Login limit cases, into the hub tests. |
| `test/machine-resolve.test.ts` | port | U-R1A-04 | Computer name resolution cases, into the hub tests. |
| `test/pair-env.test.ts` | private | U-R1B-02 | Follows `bridge/pair-env.ts`. |
| `test/protocol.test.ts` | port | U-R1A-04 | Frame protocol cases, into the hub tests. |
| `test/reconnect.test.ts` | port | U-R1A-06 | Backoff and stale-socket cases for the hub link. |
| `test/release-contents.test.ts` | port | U-R1A-38 | Release content cases; the proprietary licence case is dropped, since decision record 0006 is void. |
| `test/release-signing.test.ts` | port | U-R1A-38 | Release signing cases. |
| `test/security-fixes.test.ts` | port | U-R1A-19, U-R1A-07 | GAP: no unit brings the cases that refuse relay names on every session route with 409, or an audit line for each read (core has the guard but no case, and no read audit); closest unit U-R1A-07. U-R1A-19 brings the two-line single-submit and dead-pane 409 cases. Not carried: drive-any-pane, driving outside the allowlist, and Hermes channel routing. |
| `test/sessions-claude-history.test.ts` | port | U-R1A-37 | The injected history root and folder decoding cases move to the Claude transcript reader; the skip-the-walk cases fall away, since core's list never reads history. |
| `test/sessions.test.ts` | port | U-R1A-07 | GAP: no unit brings the agent filter case (see the `bridge/sessions.ts` row); closest unit U-R1A-07. The hidden relay row case is covered by `test/session-listing.test.ts` in core; the cases for panes Tandem did not start and agent guessing are not carried. |
| `test/setup.ts` | port | U-R1A-16 | The suite-wide switch that turns live Hermes calls off during tests; core has no such setup file. |
| `test/status-server.test.ts` | port | U-R1A-40 | Status socket cases. |
| `test/terminal-session.test.ts` | port | U-R1A-19 | Brings the ANSI stripping cases, the real tmux transcript, capture and C-c interrupt cases, and the six aliveness probe cases. Core already covers exact targets, send cursor, quiet against done and provenance. Not carried: drive-any-pane, the pairing variable at spawn, and instant idle after a done send. |
| `test/tmux-delimiter.test.ts` | port | U-R1A-19 | Printable list separator cases for tmux 3.6. |
| `test/tmux-resilience.test.ts` | port | U-R1A-19 | No send-keys while aliveness is unconfirmed; has-session alive while the list is empty is not gone; send, read and interrupt answer 503 and keep the session on a passing failure; a first drive answers 503, not 409. The exact-target call site cases are covered by `test/terminal-session.test.ts` in core. |
| `test/tmux-retry.test.ts` | port | U-R1A-19 | Retry on a tmux call that failed to start, and empty against failed listing. |
| `test/tunnel-header.test.ts` | port | U-R1A-06, U-R1A-04 | The header dial case with the hub link (U-R1A-06) and the wrong-token refusal with the hub (U-R1A-04); the enroll cases retire with `bridge/cli/enroll.ts`. |
| `test/tunnel-routing.test.ts` | port | U-R1A-04 | Tunnel routing cases, into the hub tests. |
| `test/url-token.test.ts` | port | U-R1A-04 | The cases that refuse a secret in the tunnel route address; the extension mailbox route cases stay private with it (U-R1B-02). |
