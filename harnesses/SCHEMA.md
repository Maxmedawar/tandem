# Harness files

A harness file describes one CLI agent to Tandem: which program to start, how to resume it,
how to read its screen and which keys answer it. Adding an agent means adding one file
(and, later, a logo). The loader is `bridge/harness-registry.ts`.

A harness file names a program, so Tandem treats it like a program:

- It loads only from two folders. Nothing else is searched.
- It cannot replace a built-in file.
- Key fields hold named keys only, never free text.
- A shell or interpreter is marked `kind = shell`, whatever the file calls itself.
- Loading reads files only. It never starts a process.

## Where files live

| Folder | Who writes it | Rules |
|---|---|---|
| `harnesses/` in the Tandem install | ships with Tandem (built-in) | may use `adapter` |
| `$TANDEM_HOME/harnesses`, else `~/.tandem/harnesses` | you (owner files) | folder must be mode 0700 and owned by you, or no owner file loads (one error); each file must be owned by you and not writable by group or others |

Only `*.toml` files directly inside each folder are read. Subfolders and other files are ignored.
A missing owner folder just means no owner files.

The built-in files are `claude.toml` (Claude Code), `codex.toml` (Codex CLI), `grok.toml`
(Grok CLI), `antigravity.toml` (Antigravity CLI, program `agy`), `opencode.toml` (OpenCode), `pi.toml` (Pi), `gemini.toml` (Gemini CLI), `cursor-agent.toml` (Cursor CLI), `copilot.toml` (GitHub Copilot CLI), `cline.toml` (Cline CLI), `droid.toml` (Factory Droid), `goose.toml` (Goose), `hermes.toml` (Hermes WebUI
agent, attached through its adapter, no program) and `shell.toml` (plain `sh -l`). No agent is
on by default: each one, built-in or owner, runs only when `TANDEM_ENABLED_ENGINES` names it and
its program is found (an adapter agent: its adapter's own checks).

Each file is named `<name>.toml`, where `<name>` is the harness name.

## Format

TOML. Every field not listed here is refused, at the top level and inside `states`, `keys` and
`dialogs`.

| Field | Type | Default | Rule |
|---|---|---|---|
| `name` | string | required | `^[a-z0-9][a-z0-9-]{0,31}$`, equal to the file name without `.toml` |
| `program` | string | required; refused in a file with `adapter` | a bare name (`^[A-Za-z0-9._+][A-Za-z0-9._+-]*$`, so never starting `-`) found on `PATH`, or an absolute path with no `..` whose parts use only those characters (no space, quote, glob or backslash) |
| `args` | array of strings | `[]` | arguments for every start |
| `skip_prompts_args` | array of strings | `[]` | added when the agent should not ask before acting |
| `resume` | array of strings | `[]` | arguments to resume a session; `{id}` is the session id |
| `fork` | array of strings | `[]` | arguments to fork a session; `{id}` is the session id |
| `has_prompts` | boolean | required | whether the agent asks for approval; taken as written, also for a shell |
| `account_env` | string | unset | environment variable that picks the account, `^[A-Z][A-Z0-9_]{0,63}$` |
| `history` | string | unset | history file path, starting `/` or `~/` |
| `states` | table | unset | see below |
| `keys` | table | unset | see below |
| `dialogs` | array of tables (`[[dialogs]]`) | none | see below |
| `delivery` | `"hook"` or `"notice"` | `"notice"` | `"hook"` needs `hook` |
| `hook` | string | unset | the option that loads a per-session settings file Tandem writes, `^--[a-z][a-z0-9-]{0,31}$` |
| `hook_format` | `"settings-file"` or `"config-overrides"` | `"settings-file"` | needs `hook`; how `hook` carries Tandem's hooks (see below) |
| `mcp_env` | `"inherit"`, `"config-overrides"` or `"unknown"` | unset (unknown) | how the agent hands environment to a stdio MCP server it starts: `inherit` (its whole environment; verified for that agent and cited in its file), `config-overrides` (it filters the environment; Tandem registers its own server for the session through `hook`, which needs `hook_format = "config-overrides"`), `unknown` (not verified); see "How an agent's caller token reaches Tandem's MCP server" |
| `usage` | `"statusline"` or `"rollout"` | unset | how Tandem reads the agent's account limits: `statusline` = its per-session settings file takes a `statusLine` command that receives its rate limits on stdin (bridge/usage/statusline-drop.ts; docs/USAGE.md); needs `delivery = "hook"` with the settings-file format, else `usage "statusline" needs a settings-file hook`; `rollout` = every 60 s the bridge reads the last `rate_limits` line in the last 256 KiB of the newest `sessions/**/rollout-*.jsonl` of each account folder (Codex; bridge/usage/codex.ts; docs/USAGE.md); needs `account_dir`, else `usage "rollout" needs account_dir`; any other value: `bad usage: "statusline"` |
| `account_dir` | string | unset | the agent's default account folder when its `account_env` variable is unset, starting `/` or `~/` (else `bad account_dir: must start with / or ~/`) |
| `permission_hook` | boolean | `false` | |
| `reports_context` | boolean | `false` | |
| `adapter` | string | unset | a built-in adapter's name (`hermes`), built-in files only; such an agent has no program and the terminal fields go unused |
| `logo` | string | unset | `^[a-z0-9-]+\.(svg\|png)$` |

With `delivery = "hook"`, mail reaches the agent through hooks, never as keystrokes: at each start
Tandem writes one settings file for that session under `<TANDEM_HOME>/delivery/` (folder 0700, file
0600) and adds `hook` and that file's path to the agent's arguments. The hook command is always
Tandem's own (bridge/delivery-hooks.ts); no harness file names a hook program, and the agent's own
settings are never read or written. Its hooks hand over due mail at a tool call or turn end, labelled
as untrusted data with its sender, and tell Tandem when a turn starts and ends.

With `hook_format = "config-overrides"` (codex.toml) Tandem writes no file: it adds `hook` once before
each of five values, the agent's UserPromptSubmit, PostToolUse, Stop and Interrupt hooks and the trust
record for exactly those four, as Codex reads `--config key=value`. The commands are the same Tandem
commands, an Interrupt also ends the turn, and the agent's own config folder is never read or written.

### `states`

| Field | Type | Default | Rule |
|---|---|---|---|
| `working`, `idle`, `waiting_for_approval` | arrays of patterns | unset | each pattern must compile as an RE2 regular expression (no backreferences) |
| `debounce_ms` | integer | `1500` | 0 to 10000 |
| `precedence` | array | `["waiting_for_approval", "working", "idle"]` | all three state names, each once |
| `empty_prompt` | array of patterns | unset | 1 to 8 patterns, each RE2 like the state patterns; screen text |

The defaults apply only when a `states` table is present.

An agent's text (a send from an agent, Tandem's mail notice) is typed only into an empty prompt. With `empty_prompt`, the prompt is empty when one of its patterns matches the same last 40 lines the state patterns read: write them to match the input row holding nothing or only the agent's own placeholder. Tie each pattern to the prompt in use (the built-in files end theirs at `\z`): an older prompt still on the screen, or a text line under the row, must not match. Without it, the prompt is empty only when the last line is a bare prompt: optional spaces, at most 32 characters that are not whitespace and not `❯`, `›` or `>`, then one of `❯`, `›`, `>`, and nothing after it. Any other idle screen holds the text (`prompt not empty`). The owner's own text is never checked.

A file with no `idle` pattern is markerless: a turn ends `quiet` once the screen holds still for
`debounce_ms` (5000 ms when the file has no `states` table). With an `idle` pattern, the
patterns say when the agent is ready and working.

### `keys`

`approve`, `deny`, `interrupt`: each one named key, or an array of 1 to 4 named keys.

Named keys: `Enter Escape Tab BTab Space BSpace Up Down Left Right Home End PageUp PageDown`,
`C-a` to `C-z`, `F1` to `F12`, or one character `a`-`z` or `0`-`9`. Anything else (a word, text
with a newline) is refused.

### `dialogs`

Each `[[dialogs]]` table describes one first-run dialog the agent may show (folder trust, an
update notice, a bypass-permissions accept) and the one answer Tandem may give at start. 0 to 8
tables.

| Field | Type | Rule |
|---|---|---|
| `name` | string | required; `^[a-z0-9][a-z0-9-]{0,31}$`, unique in the file |
| `kind` | string | required; `trust`, `update` or `bypass` |
| `match` | array of patterns | required; 1 to 4 RE2 patterns, ALL must match the screen; screen text, not command text |
| `answer` | string | required; 1 to 80 characters, command text |
| `highlight` | string | one of `❯` `›` `>` `●` `▶`: select mode; screen text, not command text |
| `key` | string | one character `a`-`z` or `0`-`9`: key mode; shown at the end of the answer line or at its start as `[k] ` |

Exactly one of `highlight` and `key`. Refused: an `answer` that matches NEVER
(`bridge/harness-registry.ts`: sign-in, log-in, purchase, buy, subscription, payment, billing,
credit card text), any `answer` containing `updat`, `install` or `upgrad` (any case), and an
`update` answer that does not start with `Skip`, `Not now`, `Later`, `No`, `Dismiss` or `Remind`:
an update dialog may only be skipped, and a `trust` answer matching `parent`, `all` (a whole word),
`always` or `every` (any case): a trust answer trusts this folder only.

How Tandem uses them (`bridge/terminal-session.ts`):

- **Shown.** A dialog is on screen when all its `match` patterns match and an answer line is
  present: a line whose text, trimmed, after an optional `highlight` marker and an optional `N. `
  (in key mode also without a trailing whitespace and the key), equals `answer` or starts with
  `answer` and ` (`. In key mode a line is also an answer line in the start form: the trimmed
  line, after one optional marker from `❯` `›` `>` `●` `▶` and its following spaces, starts with
  `[<key>]` and one or more spaces, and the rest equals `answer` or starts with `answer` and ` (`;
  a row whose bracket holds another key is not an answer line. Two dialogs shown at once are not
  answered.
- **The key** (`dialogKey(pane, dialog)`). A block is the run of non-blank lines, not starting
  `─`, around the answer line. Select mode: Enter only when the `highlight` marker is on the
  answer line, else one Down or Up toward it. Key mode: a line shows the key when it ends with
  whitespace and the key, or starts with `[<key>]` in the start form; `key` only when the answer
  line shows it and no other line of its block shows it.
- **When.** Only during start (warmup), before the ready check, so a dialog wins over any state
  (`waiting_for_approval` included): one key per screen poll, no next key until the screen
  changed, at most 8 arrows and one Enter or key per dialog per start. Only when the start allows
  that kind (`dialogAnswers`): an opened session in a limits-file folder allows `trust` and
  `update`, and `bypass` too in a `permission_skip` folder; the relay (`permission_skip` checked)
  allows all three. A reused or adopted session never runs warmup, so nothing is answered. Outside
  warmup no dialog is ever answered.
- **needs owner.** A shown dialog the start does not allow, a shown dialog while NEVER matches the
  screen, a shown dialog while the screen holds update text (`updat`, `install`, `upgrad`) unless it
  is an `update` dialog that skips, a dialog still shown after its Enter or key, or a dialog still
  shown when warmup ends (two dialogs shown at once end this way, with no key):
  the start kills its own tmux session and fails (`NeedsOwnerError`; an open answers 409
  `needs owner: <harness> shows its first-run <kind> dialog "<name>" in <cwd> (<reason>); Tandem
  typed no answer. Open it there yourself once, then open the session again.`; a relay start
  answers 409 the same way). The first four send no key at all.

Never answer a dialog through an agent's own flag, config or trust file, or its environment.

### Command text

Every string outside `states` and `dialogs` is command text, and so is a dialog's `answer`. It may not hold a newline, NUL or any other
control character, a format character (bidi or zero-width), a line or paragraph
separator, nor `` ` ``, `$`, `;`, `|`, `&`, `<`, `>`, nor a `{` or `}` other than in
the exact text `{id}`.

## How an agent's caller token reaches Tandem's MCP server

Each session's agent gets its own caller token in its environment (`TANDEM_CALLER_TOKEN`, see
bridge/caller-tokens.ts). Tandem's stdio MCP server (`tandem stdio`) started by that agent reads
it and serves that agent, never the owner. Whether the variable reaches the server depends on how
the agent starts its MCP servers, which `mcp_env` records:

- `inherit`: the agent passes its whole environment; nothing more is needed.
- `config-overrides`: the agent filters the environment. At each start Tandem adds, after the hook
  values, its own stdio server `tandem` for that one session as three `hook` values:
  `mcp_servers.tandem.command` (this Node), `mcp_servers.tandem.args` (`--experimental-strip-types`
  and Tandem's `src/stdio-server.ts`) and `mcp_servers.tandem.env_vars` (the names of the variables
  to pass, TANDEM_CALLER_TOKEN among them). Names only: no value of any variable is ever on a
  command line. An owner entry named `tandem` in the agent's own config has its command, args and
  env_vars replaced for that session by Tandem's (the same program); its other keys stay (an `env`
  table there still sets what it names, and an entry of `url` type under that name stops the agent
  from starting: seen with codex-cli 0.167.1, `url is not supported for stdio`). An owner entry
  under another name still starts without a token and is refused (below).
- `unknown`: not verified.

A stdio server with no token refuses to start when its process or one of its parents is the pane
process of a session on Tandem's socket, and when it cannot tell (a parent id it cannot read, more
than 64 parents, or no tmux program on its PATH while one of its parents is a tmux server); the
owner's own clients run outside Tandem sessions and stay the owner. There is no override variable. A server serving an
agent checks at every tool call that its token still names that agent and its session is still
there; when not, that call gets a JSON-RPC error and the server stops.

Built-in files:

- `antigravity.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `claude.toml`: `inherit`: U-R1A-36C V4: under an empty CLAUDE_CONFIG_DIR and HOME, `claude mcp list` started a probe stdio server that saw TANDEM_CALLER_TOKEN
- `cline.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `codex.toml`: `config-overrides`: U-R1A-36C V2/V3: codex-cli 0.167.1 starts a stdio server with a short default environment plus its `env_vars`; `codex mcp get tandem --json` under an empty CODEX_HOME listed Tandem's command, args and env_vars
- `copilot.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `cursor-agent.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `droid.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `gemini.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `goose.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `grok.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `hermes.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `opencode.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `pi.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner
- `shell.toml`: `unknown`: unverified: inherited environment if the agent passes it; else its stdio server refuses to start, never the owner

Limits: the same OS user can still (1) start a stdio server detached from the session (setsid, a
double fork, nohup to parent pid 1, launchd or systemd-run, `at`, another tmux server) and be the
owner; (2) read the token from the pane process's environment (`ps eww`, /proc) or write a hash
row into state.db; (3) win the race between the parent-id reads and the start; (4) start a
stdio server with another `TANDEM_HOME` (or, when the session's own home is not the default one,
with the variable dropped): it looks at that other home's socket, finds no session of its own
there and is the owner of that other home, never of the one its session lives in. The ancestry rule
and the per-call recheck stop an honest, confused or prompt-injected agent; isolation from a
hostile process of the same user needs separate OS users. Codex's own shell tool drops variables
whose names hold TOKEN by default, so a stdio server a Codex agent starts from its shell has no
token and is refused.

## Shell or agent

Each loaded harness gets `kind` = `shell` or `agent`, and `programPath` when the program is
found: the program itself when it is an absolute path to an existing file, else the first match
on `PATH` (found by reading folders, never by running a lookup command).

`kind = shell` when the base name of `program`, or the base name of the real path of
`programPath`, lowercased with `.exe` and a trailing run of digits, dots and dashes removed
(`python3.12` becomes `python`), is one of:

```
sh bash zsh dash ksh mksh yash csh tcsh fish nu xonsh elvish pwsh powershell cmd busybox
env sudo doas su nohup nice timeout xargs script expect python pypy perl ruby php node
nodejs bun deno lua luajit tclsh wish osascript awk gawk mawk
```

Everything else is `agent`. A script's `#!` line is never read.

## Refused files

A refused file never stops the others. It is reported with a reason and skipped:

- a TOML syntax error, a wrong type, an unknown field, a missing required field, or a value
  that breaks a rule above;
- a file over 64 KiB, a symlink, or anything that is not a regular file;
- an owner file not owned by you, or writable by group or others;
- a file name that is not `<valid name>.toml`;
- a file named `all.toml` or `terminal.toml`, built-in or owner (reserved name: the session list
  filter uses `all` and `terminal`);
- an owner file that uses a built-in name (the built-in stays);
- two owner files that claim one name (both are refused).

## Example

```toml
name = "opencode"
program = "opencode"
has_prompts = true
skip_prompts_args = ["--auto"]
resume = ["--session", "{id}"]
```
