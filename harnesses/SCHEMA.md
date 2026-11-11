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

Each file is named `<name>.toml`, where `<name>` is the harness name.

## Format

TOML. Every field not listed here is refused, at the top level and inside `states` and `keys`.

| Field | Type | Default | Rule |
|---|---|---|---|
| `name` | string | required | `^[a-z0-9][a-z0-9-]{0,31}$`, equal to the file name without `.toml` |
| `program` | string | required | a bare name (`^[A-Za-z0-9._+][A-Za-z0-9._+-]*$`, so never starting `-`) found on `PATH`, or an absolute path with no `..` whose parts use only those characters (no space, quote, glob or backslash) |
| `args` | array of strings | `[]` | arguments for every start |
| `skip_prompts_args` | array of strings | `[]` | added when the agent should not ask before acting |
| `resume` | array of strings | `[]` | arguments to resume a session; `{id}` is the session id |
| `fork` | array of strings | `[]` | arguments to fork a session; `{id}` is the session id |
| `has_prompts` | boolean | required | whether the agent asks for approval; taken as written, also for a shell |
| `account_env` | string | unset | environment variable that picks the account, `^[A-Z][A-Z0-9_]{0,63}$` |
| `history` | string | unset | history file path, starting `/` or `~/` |
| `states` | table | unset | see below |
| `keys` | table | unset | see below |
| `delivery` | `"hook"` or `"notice"` | `"notice"` | `"hook"` needs `hook` |
| `hook` | string | unset | hook command |
| `permission_hook` | boolean | `false` | |
| `reports_context` | boolean | `false` | |
| `adapter` | `"hermes"` | unset | built-in files only |
| `logo` | string | unset | `^[a-z0-9-]+\.(svg\|png)$` |

### `states`

| Field | Type | Default | Rule |
|---|---|---|---|
| `working`, `idle`, `waiting_for_approval` | arrays of patterns | unset | each pattern must compile as an RE2 regular expression (no backreferences) |
| `debounce_ms` | integer | `1500` | 0 to 10000 |
| `precedence` | array | `["waiting_for_approval", "working", "idle"]` | all three state names, each once |

The defaults apply only when a `states` table is present.

### `keys`

`approve`, `deny`, `interrupt`: each one named key, or an array of 1 to 4 named keys.

Named keys: `Enter Escape Tab BTab Space BSpace Up Down Left Right Home End PageUp PageDown`,
`C-a` to `C-z`, `F1` to `F12`, or one character `a`-`z` or `0`-`9`. Anything else (a word, text
with a newline) is refused.

### Command text

Every string outside `states` is command text. It may not hold a newline, NUL or any other
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
