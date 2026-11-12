# Account usage (Claude Code)

Tandem shows how much of each Claude Code account's 5-hour and 7-day limit is used and when each
window resets. It only reads what Claude Code already hands its status line. It never signs in or
out and never opens, copies or moves a login file.

## What is read, and what never is

- Read: each account folder's `settings.json` (only its `statusLine` entry, once when a session
  starts), Tandem's own drop files, and `~/.tandem/usage.toml`.
- Never read: login files of any kind (for Claude Code, `.credentials.json` and the keychain),
  transcripts, prompts or anything else in an account folder.
- Kept: numbers and times only. No session id, path, model name, prompt or transcript text is
  written or stored.

## How it works

Every Claude session Tandem starts gets a `statusLine` command in its per-session settings file
(`~/.tandem/delivery/<session>.settings.json`). Claude Code runs it at each status update with the
session's status on stdin. The command keeps only `rate_limits.five_hour` and
`rate_limits.seven_day` (used share 0-100 and reset time) and the time, and writes them to the drop
file `~/.tandem/usage/claude/<account>.json` (folder 0700, file 0600, written through a rename):

```json
{ "at": 1794400000000, "rate_limits": { "five_hour": { "used_percentage": 37.5, "resets_at": 1794410000 }, "seven_day": { "used_percentage": 12, "resets_at": 1794900000 } } }
```

An update without limits (Claude Code reports them only to subscribers, after the first answer of
a session) leaves the earlier drop file as it was.

Your own status line keeps working. If the account folder's `settings.json` has a `statusLine`
command, Tandem saves it at session start to `~/.tandem/delivery/<session>.statusline`. The drop
command then runs it with the same input and prints exactly what it prints. Your `padding` is kept.
With no `statusLine` of your own, the command only writes the drop file and prints nothing.

The bridge reads the drop files every 60 seconds into `~/.tandem/state.db`, one row per account.

## Stale and unknown

- A reading older than 30 minutes is stale: the bridge prints one line,
  `usage: claude account <account> has not reported for <m> min`, and again only after the account
  was fresh in between.
- Once a window's reset time has passed, its share reads unknown, never the old number.

## Accounts and their names

An account is one config folder: the folder `CLAUDE_CONFIG_DIR` names, else `~/.claude`. Name your
accounts in `~/.tandem/usage.toml` (mode 0600; Tandem never writes it):

```toml
[[accounts]]
name = "work"            # lowercase letters, digits and -, up to 64, each name once
agent = "claude"         # the harness name
folder = "~/.claude-work" # starts with / or ~/
```

Each `[[accounts]]` table holds exactly these three keys; anything else, or a file open to group
or world, refuses the whole file (one line on the bridge's stderr) and every account is named
after its folder.

A folder not listed is named after its base name: leading dots removed, lowercased, every other
character `-` (`~/.claude` is `claude`, `~/.claude-b` is `claude-b`). Limit: two unlisted folders
with the same base name (say `/a/.claude` and `/b/.claude`) share one name and their readings mix.
List them in `usage.toml` with different names to tell them apart.

## Sessions started outside Tandem

Tandem never edits an account's own `settings.json`. To have sessions you start yourself report
too, add the drop command to that account's `settings.json` by hand:

1. Save your current status line command, if you have one, to a file of its own. Keep it out of
   `~/.tandem/delivery/`: Tandem writes and deletes `<session>.statusline` files there, so a session
   of the same name would take yours with it.

   ```sh
   mkdir -p ~/.tandem/usage && chmod 700 ~/.tandem ~/.tandem/usage
   printf '%s' '<your current statusLine command>' > ~/.tandem/usage/own-claude.statusline
   chmod 600 ~/.tandem/usage/own-claude.statusline
   ```

2. Set the account's `statusLine` to the drop command (absolute paths, single quotes; the last
   argument only when you saved a command in step 1):

   ```json
   "statusLine": {
     "type": "command",
     "command": "'/path/to/node' --experimental-strip-types '/path/to/tandem/bridge/usage/statusline-drop.ts' 'claude' '/Users/you/.tandem/usage/claude' '/Users/you/.tandem/usage/own-claude.statusline'"
   }
   ```

   Use the account's name (as above) as the third word. Tandem's own sessions see the drop command
   in that `settings.json` and do not chain it again, so they report but do not show your saved
   line; a session you start yourself shows it.

To undo, put your old command back as the `statusLine` command and delete the saved file.
