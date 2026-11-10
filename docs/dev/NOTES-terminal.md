# NOTES — Claude Code TUI idle detection (empirically probed)

Probed against a REAL `claude` TUI running inside tmux on Max's Mac on 2026-05-29.
Procedure: `tmux new-session -d -s ccm-probe -x 200 -y 50 claude`, then
`tmux capture-pane -p -t ccm-probe`, send prompts injection-safe, observe the
exact strings that mean "working" vs "idle". Probe session was killed + its
transcript removed afterward.

Observed env: Claude Code v2.1.157, Opus 4.8 (1M context), Claude Max plan.

## The reliable working marker

While a turn is RUNNING, the bottom status footer contains the literal string:

    esc to interrupt

Example running footer:

    ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt        3 MCP servers need auth · /mcp

When the turn COMPLETES, that segment is replaced and the footer returns to e.g.:

    ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents            ● high · /effort

=> `WORKING_MARKER = "esc to interrupt"`. Idle requires this string ABSENT.

There is also an animated spinner line above the input box while working, e.g.:

    ✶ Infusing…        (glyph cycles; verb cycles: "Infusing…", "Cogitating…", …)

and on completion a one-line summary like:

    ✻ Cogitated for 1s

The spinner glyph/verb is NOT stable enough to key on (it animates and the verb
varies). The footer `esc to interrupt` string is the dependable signal.

## Why a single glance is not enough (the two-condition rule)

Immediately after pressing Enter there is a brief (<1s) window where the prompt
has been submitted but the spinner / `esc to interrupt` footer has NOT rendered
yet — the footer still reads `auto mode on (shift+tab to cycle)`. A naive
"working marker absent => idle" check fires falsely in that window.

Therefore idle is detected as BOTH:

  1. `esc to interrupt` ABSENT in `tmux capture-pane -p`, AND
  2. the trimmed capture-pane content is byte-identical across
     `IDLE_STABLE_POLLS` (=3) consecutive `POLL_MS` (=750ms) polls.

send() also sleeps one POLL_MS after submitting before it starts judging idle,
so the spinner has a chance to appear first.

## Idle (ready) pane shape

    ────────────────────────────────────────────────────────────  (top border)
    ❯                                                               (input box)
    ────────────────────────────────────────────────────────────  (bottom border)
      ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents   ● high · /effort

The `❯ ` prompt box is present when the session is ready for input.

## Multi-line input — literal `\n` is a SOFT newline, NOT a submit (re-probed 2026-05-29)

Procedure: spawn `ccm-probe`, inject a 2-line body, observe the input box BEFORE
pressing Enter, then press Enter and observe the turn.

Injecting a 2-line body — both as a single literal blob
`tmux send-keys -l -- $'LINE_ONE\nLINE_TWO'` AND as line-by-line segments with a
dedicated literal-newline keystroke between them
(`send-keys -l -- 'LINE_ONE'`, `send-keys -l -- $'\n'`, `send-keys -l -- 'LINE_TWO'`)
— produces the SAME result: both lines sit in the input box as one multi-line
prompt:

    ❯ LINE_ONE
      LINE_TWO

NO premature submit fires on the embedded `\n` (the first line does NOT start a
turn on its own). A single subsequent `send-keys Enter` then submits the WHOLE
two-line body as exactly ONE turn (one `esc to interrupt` working footer, one
spinner). So on Claude Code v2.1.157 a literal `\n` inside the input box is a soft
newline.

DECISION: `TerminalSession.injectMultiline()` splits on `\n` and types each line
as its own literal `-l --` argv, inserting line breaks via a DEDICATED
`send-keys -l -- $'\n'` keystroke between lines (never relying on a single blob
whose `\n` could be reinterpreted on a different terminal/version), and presses
`Enter` exactly ONCE afterward. This guarantees: one multi-line message => one
prompt => one submit => one turn — which is what the relay seed, the wrapped
worker report, and operator injections all require. The injection stays
injection-safe (each line + the newline are discrete `-l --` argv elements; the
user's text is never interpolated into a shell string nor interpretable as tmux
key names).

## First-run trust-folder prompt (spawn warmup)

On the FIRST `claude` launch in a directory that hasn't been trusted, the TUI
shows a blocking prompt BEFORE the input box appears:

    Do you trust the files in this folder?
     ❯ 1. Yes, I trust this folder
       2. No, exit
     Enter to confirm · Esc to cancel

`TerminalSession.warmup()` detects this (substring "trust this folder", case-
insensitive) and presses Enter to accept the highlighted default ("Yes, I trust
this folder"), then continues waiting for the input box. Without this, the very
first send() into a fresh cwd would be swallowed by the trust dialog.

## Timing constants (terminal-session.ts)

| constant              | value   | meaning                                            |
|-----------------------|---------|----------------------------------------------------|
| POLL_MS               | 750ms   | capture-pane poll cadence                          |
| IDLE_STABLE_POLLS     | 3       | consecutive stable+not-working polls => idle       |
| SEND_SOFT_CAP_MS      | 25_000  | below the 30s tunnel cap => return status:'running'|
| SEND_HARD_CAP_MS      | 180_000 | absolute ceiling so send() can never hang forever  |
| SPAWN_WARMUP_MS       | 20_000  | max wait for the TUI to become ready on spawn      |

## Transcript + cursor

`tmux pipe-pane -o -t <tgt> 'cat >> <transcriptsDir>/<name>.log'` appends the
raw pane byte stream (full ANSI, with frequent full-screen redraws). The log's
byte length IS the cursor. `readSince(offset)` reads bytes from `offset` to EOF,
decodes UTF-8 (so box-drawing/status glyphs survive — DO NOT decode latin1), and
strips ANSI. Because the TUI repaints the whole screen each frame, the raw delta
is very repetitive; the harvested report collapses runs of identical lines.

## Codex idle marker (Phase 2): NOT PROBED (stability-only)

`engines.ts` leaves the `codex` engine's `isWorking`/`isReady` markers `undefined`
on purpose — codex is driven by the universal stability-only idle rule (identical
to the `shell` engine), which already drives it correctly (just coarser idle).

Reason the throwaway-probe (spec §6.3 / B3) was SKIPPED — deliberately, not
overlooked: launching `codex` is DESTRUCTIVE to Max's real state. `codex` is a
`#!/usr/bin/env node` CLI at `~/.local/bin/codex` whose `~/.codex` is a large live
store (session_index.jsonl, history.jsonl, logs_2.sqlite ~14MB, goals_1.sqlite,
memories, auth.json). Spawning even a throwaway codex would write session/history/
log state (and may need auth/network), so there is no non-destructive way to
observe its working-vs-idle footer here. Per the safety gate, markers stay
`undefined`. Re-probe only in a sandboxed/throwaway `$CODEX_HOME` if ever needed.

Detection note: because `codex` runs as `node`, a LIVE codex pane's
`pane_current_command` is typically `node`, so command-based detection tags it
`shell` unless the foreground process title is literally `codex`. This is cosmetic
only — `codex` and `shell` engines share undefined markers, so the DRIVE behavior
(stability-only idle) is identical either way. No speculative content signature was
added (it could false-positive and mislabel real shells as codex).

## Grok / Gemini idle markers: NOT PROBED (stability-only)

`engines.ts` leaves the `grok` and `gemini` engines' `isWorking`/`isReady` markers
`undefined` on purpose — both are driven by the universal stability-only idle rule
(identical to `codex`/`shell`), which drives them correctly (just coarser idle).

Reason the throwaway-probe was SKIPPED — deliberately, not overlooked: launching
either CLI is DESTRUCTIVE to the user's real state.
- `grok` = a native arm64 binary at `~/.grok/bin/grok`; `~/.grok` is a live store
  (auth.json, active_sessions.json, sessions/, agent_id). Spawning even a throwaway
  grok would write session/auth state.
- `gemini` = a `#!/usr/bin/env node` CLI at `/opt/homebrew/bin/gemini`; `~/.gemini`
  holds oauth_creds.json + history/ + tmp/, and a first run needs OAuth/network.
Per the safety gate, markers stay `undefined`. Re-probe only in a sandboxed/throwaway
HOME if ever needed.

Detection: `grok` is a NATIVE binary, so a live grok pane's `pane_current_command`
is literally `grok` → command-basename detection tags it `grok` directly. `gemini`
runs as `node`, so (like codex) a live gemini pane usually surfaces as `shell` —
cosmetic only (grok/gemini/codex/shell all share undefined markers → identical
stability-only drive behavior). No speculative content signature was added (it could
false-positive and mislabel real shells/node panes).
