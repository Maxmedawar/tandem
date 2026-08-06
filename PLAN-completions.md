# PLAN — completions reader for the tandem MCP bridge

Status: SPEC ONLY. Nothing built. No bridge rebuild/restart, no tmux action taken.

## 1. Observed reality (measured, not assumed)

### Record schema — `~/.tandem/completions/log.jsonl`
One JSON object per line, exactly 4 string keys, uniform across all 147 lines (0 parse failures):

```
{"session_id":"<claude uuid>","brand":"<basename of cwd>","cwd":"<abs path>","finished_at":"<ISO-8601 Z, second precision>"}
```

- `~/.tandem/completions/latest.json` holds the single most recent record, same shape.
- File is append-only, currently 147 lines / 22 KB, span 2026-07-21T11:15:29Z → 2026-07-26T17:16:14Z.
- `finished_at` is **monotonically non-decreasing** in file order → tail-read + lexicographic string compare is a valid cursor.
- **147 records / 53 distinct `session_id`s.** The Stop hook fires at the end of *every assistant turn*, not once per session. Max repeats for one session: 14. So a "completion record" = **turn end**, not session end. Brand skew: `dev` 82, `slack-bot` 16, `seo-ops` 11, rest ≤ 8.
- No session *name* field. There is no tmux/`ccm-<name>` identifier in the record — only the Claude `session_id` UUID and `cwd`.

### Producer — `~/.claude/settings.json` Stop hook
`hooks.Stop[0].hooks[0].command = ~/.tandem/hooks/session-complete.sh`.
Infinite-loop guard: **present** — line 4 reads `stop_hook_active` from the hook payload and `exit 0`s when true. (Belt and braces: the script never emits a blocking JSON decision and always exits 0, so it cannot re-trigger a turn regardless.)

### Consumer surface — where the tool would land
- `src/mcp-server.ts` — single shared tool surface (6 tools), used by BOTH `src/http-mcp.ts` (Streamable-HTTP + TANDEM_TOKEN) and `src/stdio-server.ts`. Registering once here covers both transports.
- Every tool body calls `routeForTest(method, path, body, rawQuery)` → `bridge/router.ts` `route()`, which dispatches on `pathParts`. Handlers return `ok(body)` / `err(status, msg)`.
- `bridge/sessions.ts` `listSessions()` returns `{sessions: SessionInfo[]}` where live entries have `id = tmux session name`, plus `cwd`, `project`, `updatedAt`, `live`, `attachHint`.

## 2. Design decision — **(a) new `completions` MCP tool**

Rejected: (b) folding last-completion state into `list_sessions`.

**Why (a):**

1. **Round-trips for "what finished since I last looked."** (a) answers it in **one** call: `completions{since:<last cursor>}` returns exactly the new records and hands back a fresh cursor. (b) makes the director fetch the whole session list and diff it against remembered state — the tool returns *current* state, not *deltas*, so "since I last looked" is reconstructed client-side, or by re-reading and eyeballing. That is 1 call + human diffing per check, and it degrades as the session list grows.
2. **No reliable join key.** Completion records identify a session by Claude `session_id` UUID; `list_sessions` identifies it by tmux name. The only overlapping field is `cwd` — and 82 of 147 records share `cwd=/Users/yaqubramzan/dev`. Folding in would mis-attribute completions to the wrong session in the single busiest directory. (a) has no such coupling.
3. **Different lifetimes.** `list_sessions` is dominated by live tmux state; completions outlive the session (a finished session has no tmux entry at all, so its completion would have nowhere to attach under (b) — precisely the record the director most wants).
4. **Blast radius.** (a) is additive and read-only; (b) mutates a tool the live claude.ai conversation is already calling.

## 3. Tool spec

`completions` (read-only; no BLAST_RADIUS write warning needed beyond the standing prefix)

| arg | type | default | meaning |
|---|---|---|---|
| `since` | string, optional | — | ISO-8601 `Z` timestamp (or a prior `cursor`). Returns records with `finished_at > since`. |
| `session` | string, optional | — | Filter to one `session_id` (exact) or one `brand`/`cwd` substring. |
| `limit` | int, optional | 20 | Max records returned (newest first). |
| `all_turns` | bool, optional | false | `false` = collapse to the **newest record per `session_id`** (one row per session that finished). `true` = every raw turn-end record. |

Rationale for `all_turns`: the hook emits per-turn, so an uncollapsed feed shows the same session 14 times. The director's question is "which sessions finished", so collapse is the default and the raw feed is opt-in.

Response:
```json
{ "completions": [ {session_id, brand, cwd, finished_at} ], "cursor": "<max finished_at seen>", "truncated": <bool> }
```
`cursor` is fed straight back as `since` on the next call — that is the whole "since I last looked" loop.

## 4. Implementation shape (to build only after GO)

- New `bridge/completions.ts`: `readCompletions(opts)` — pure reader, no writes, no deletes.
  - Path: `${process.env.TANDEM_COMPLETIONS_DIR ?? ~/.tandem/completions}/log.jsonl`.
  - **Size/rotation handling:** open + `fstat`, read only the **last 256 KiB** (`TANDEM_COMPLETIONS_TAIL_BYTES`) via a positional read. Discard the first line of that window if the window did not start at byte 0 (partial line). This makes the reader O(window), not O(file), so an unrotated multi-MB log never blows up a tool response or memory.
  - Skip blank/malformed lines silently; skip objects missing `finished_at`.
  - `since` filter uses string `>` (safe: fixed-width ISO `Z`). Second-granularity ties are handled by `>` + newest-first ordering, so a record sharing the cursor's exact second is not re-emitted; accepted trade-off (worst case: one same-second sibling missed — noted, not fixed, since the hook writes at most one record per turn per session).
  - `truncated: true` when the tail window was clipped **or** `limit` cut the result, so the caller knows more exists.
  - Missing file / empty dir → `{completions: [], cursor: null}`, never an error.
- `bridge/router.ts`: add `GET /completions` before the `/sessions` branch; parse `since|session|limit|all_turns` from `req.query`; `audit({route:'GET /completions', ...})` to match existing handlers.
- `src/mcp-server.ts`: register `completions` → `call("GET", "/completions", {}, q({since, session, limit, all_turns}).slice(1))`. Update the header comment "6 tools" → "7 tools" in `src/mcp-server.ts` and `src/http-mcp.ts`.
- Tests in `test/`: fixture log with malformed line + partial-tail case + collapse-vs-raw + cursor round-trip.

**Rotation follow-up (out of scope for this change, flagged):** the hook appends forever with no rotation. At the current ~150 B/record and ~30 records/day, the log reaches ~1.6 MB/year — harmless for a tail reader, so no rotation is required to ship this. If wanted later, rotate hook-side (`log.jsonl` → `log.1.jsonl` at 5 MB); the reader's tail window must then be taught to fall back to the rotated file, or it will simply return fewer records for a large `since` gap.

## 5. Constraint compliance
- No rebuild, no restart, no tmux command was run during this spec phase.
- All inspection was read-only (`ls`, `cat`, `grep`, read-only python parse of the log).
- Build + test happens only on explicit go-ahead; the bridge restart is the director's call.
