# Cutover: the new build beside the old one

`scripts/cutover.sh` installs the new build beside the runtime a computer already runs, under its
own service (`tandem-next`: launchd label `com.tandem-next.runtime`, systemd unit
`tandem-next.service`), its own home (`~/.tandem-next`) and its own computer name
(`<host>-next`). One command removes it again. Each computer below is done on its own, in this
order; the next one starts only after the checks of the one before pass.

## Before you start

- The old runtime stays as it is the whole time: its service `com.tandem.runtime`, its home
  `~/.tandem`, its `tandem` command, its Worker and fleetbus. The cutover only looks at it
  (`test -e`, `test -L`); it never reads, stops or changes it, and rollback never touches it.
- Run every command from your own terminal, not inside a Tandem or tmux session.
- The checkout is at the merged `int/r1a` sha, with `npm ci` done at its top and in `hub/`, and
  each command runs from the checkout's top folder.
- The new runtime needs its own owner settings before its first start: `TANDEM_PUBLIC_URL` (an
  `https://<host>/mcp` address) and `TANDEM_OWNER_PASSWORD_FILE` (a 0600 file). Without them it
  does not start. The cutover does not write them; the `printf` line in each block below adds
  them to `~/.tandem-next/tandem.env`, which is why every install here is `--no-start`.
- Placeholders: `<NEW HUB URL>` is the new hub (`https://...`); `<TOKEN FILE>` holds its link
  token (mode 0600, 16 to 512 characters); `<FOLDER>` and `<AGENT>` are the folders and agents
  this computer allows (repeat `--folder` and `--agent` as needed); `<PUBLIC URL>` and
  `<PASSWORD FILE>` are the owner settings above.
- Each step can be undone with the commands under "Roll back".

## mini

mini is the memory home, so its store is copied into the new home before the new runtime first
starts. The store path the new runtime uses is `~/.tandem-next/fabric/fabric.sqlite3` (pinned in
`~/.tandem-next/tandem.env` as `CCM_FABRIC_DB_PATH`, so a `CCM_FABRIC_DB_PATH` exported in the
shell can never point it at the old store). `<OLD STORE>` is the old runtime's store file;
`<COPY DIR>` is a new private folder outside `~/.tandem`; `<SUBJECT>` is the old hub user's OAuth
subject.

```sh
sh scripts/cutover.sh install --dry-run --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
sh scripts/cutover.sh install --no-start --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
printf "TANDEM_PUBLIC_URL='%s'\nTANDEM_OWNER_PASSWORD_FILE='%s'\nCCM_FABRIC_ENABLED='1'\n" '<PUBLIC URL>' '<PASSWORD FILE>' >> ~/.tandem-next/tandem.env
mkdir -m 700 <COPY DIR>
sqlite3 <OLD STORE> ".backup <COPY DIR>/old-store.sqlite3"
node --experimental-strip-types scripts/migrate-from-synergy.ts --from <COPY DIR>/old-store.sqlite3 --to ~/.tandem-next/fabric/fabric.sqlite3 --from-subject <SUBJECT>
TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem start
sh scripts/cutover.sh status
```

### Checks

- Both computers are listed on the new hub: the old one under its own name and this one as
  `<host>-next`.
- `TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem status --json` lists this
  computer as `<host>-next`.
- The old runtime's pid is unchanged (`launchctl list | grep -F com.tandem.runtime` before and
  after).
- A5.2, the real-fleet compare: the menu bar list against `tandem status --json` (the new one,
  as above): computers, counts, running and idle match exactly, and the data age is shown.
- A11.5, the screenshot of the open menu: `screencapture -i <file>` (needs Screen Recording for
  the terminal); without it, checked by eye and written in decisions.md.

### Roll back

- `sh scripts/cutover.sh rollback` stops and removes the new service and program; its data stays
  in `~/.tandem-next`.
- `sh scripts/cutover.sh rollback --purge` removes `~/.tandem-next` whole.

## macbook

```sh
sh scripts/cutover.sh install --dry-run --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
sh scripts/cutover.sh install --no-start --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
printf "TANDEM_PUBLIC_URL='%s'\nTANDEM_OWNER_PASSWORD_FILE='%s'\n" '<PUBLIC URL>' '<PASSWORD FILE>' >> ~/.tandem-next/tandem.env
TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem start
sh scripts/cutover.sh status
```

### Checks

- Both computers are listed on the new hub: the old one under its own name and this one as
  `<host>-next`.
- `TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem status --json` lists this
  computer as `<host>-next`.
- The old runtime's pid is unchanged.

### Roll back

- `sh scripts/cutover.sh rollback` (data kept in `~/.tandem-next`).
- `sh scripts/cutover.sh rollback --purge` (removes `~/.tandem-next`).

## mini2

mini2 runs production and goes last, after mini and macbook have passed their checks.

```sh
sh scripts/cutover.sh install --dry-run --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
sh scripts/cutover.sh install --no-start --hub-url <NEW HUB URL> --hub-token-file <TOKEN FILE> --folder <FOLDER> --agent <AGENT>
printf "TANDEM_PUBLIC_URL='%s'\nTANDEM_OWNER_PASSWORD_FILE='%s'\n" '<PUBLIC URL>' '<PASSWORD FILE>' >> ~/.tandem-next/tandem.env
TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem start
sh scripts/cutover.sh status
```

### Checks

- Both computers are listed on the new hub: the old one under its own name and this one as
  `<host>-next`.
- `TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem status --json` lists this
  computer as `<host>-next`.
- The old runtime's pid is unchanged.

### Roll back

- `sh scripts/cutover.sh rollback` (data kept in `~/.tandem-next`).
- `sh scripts/cutover.sh rollback --purge` (removes `~/.tandem-next`).

The windows computer is down and is not in this cutover.

## Known limits

- The new service's plist lives in `~/.tandem-next/agents` (as `packaging/install.sh` does
  today), not in `~/Library/LaunchAgents`, so after a restart of the computer run
  `TANDEM_HOME=~/.tandem-next ~/.tandem-next/current/bin/tandem start` again.
- The old and the new computer both appear on any hub both use.
- Nothing here moves the claude.ai connector or fleetbus.
- The owner settings (`TANDEM_PUBLIC_URL`, `TANDEM_OWNER_PASSWORD_FILE`) are added by hand; the
  cutover writes only the service, computer name, port, store path and hub link.
