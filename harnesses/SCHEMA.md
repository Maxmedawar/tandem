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
(Grok CLI), `antigravity.toml` (Antigravity CLI, program `agy`), `hermes.toml` (Hermes WebUI
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
| `hook` | string | unset | hook command |
| `permission_hook` | boolean | `false` | |
| `reports_context` | boolean | `false` | |
| `adapter` | string | unset | a built-in adapter's name (`hermes`), built-in files only; such an agent has no program and the terminal fields go unused |
| `logo` | string | unset | `^[a-z0-9-]+\.(svg\|png)$` |

### `states`

| Field | Type | Default | Rule |
|---|---|---|---|
| `working`, `idle`, `waiting_for_approval` | arrays of patterns | unset | each pattern must compile as an RE2 regular expression (no backreferences) |
| `debounce_ms` | integer | `1500` | 0 to 10000 |
| `precedence` | array | `["waiting_for_approval", "working", "idle"]` | all three state names, each once |

The defaults apply only when a `states` table is present.

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
| `highlight` | string | one of `❯` `›` `>`: select mode; screen text, not command text |
| `key` | string | one character `a`-`z` or `0`-`9`: key mode |

Exactly one of `highlight` and `key`. Refused: an `answer` that matches NEVER
(`bridge/harness-registry.ts`: sign-in, log-in, purchase, buy, subscription, payment, billing,
credit card text), any `answer` containing `updat`, `install` or `upgrad` (any case), and an
`update` answer that does not start with `Skip`, `Not now`, `Later`, `No`, `Dismiss` or `Remind`:
an update dialog may only be skipped.

How Tandem uses them (`bridge/terminal-session.ts`):

- **Shown.** A dialog is on screen when all its `match` patterns match and an answer line is
  present: a line whose text, trimmed, after an optional `highlight` marker and an optional `N. `
  (in key mode also without a trailing whitespace and the key), equals `answer` or starts with
  `answer` and ` (`. Two dialogs shown at once are not answered.
- **The key** (`dialogKey(pane, dialog)`). A block is the run of non-blank lines, not starting
  `─`, around the answer line. Select mode: Enter only when the `highlight` marker is on the
  answer line, else one Down or Up toward it. Key mode: `key` only when the answer line ends with
  whitespace and the key and no other line of its block ends that way.
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
