<p align="center">
  <img src="assets/tandem-logo.png" alt="Tandem" width="440">
</p>

<h2 align="center">Control every coding agent, on every computer, from one conversation.</h2>

<p align="center">
  <a href="https://github.com/Maxmedawar/tandem/actions/workflows/ci.yml"><img src="https://github.com/Maxmedawar/tandem/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Maxmedawar/tandem/releases"><img src="https://img.shields.io/github/v/release/Maxmedawar/tandem?color=E8643C" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-E8643C.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.6-339933" alt="Node >=22.6">
  <a href="https://github.com/Maxmedawar/tandem/stargazers"><img src="https://img.shields.io/github/stars/Maxmedawar/tandem?color=E8643C" alt="Stars"></a>
  <img src="https://img.shields.io/badge/PRs-welcome-E8643C.svg" alt="PRs welcome">
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Tandem controlling a coding session from a browser chat" width="820">
</p>

Tandem turns an MCP-capable AI chat into a control desk for all of your coding agents.

Open your browser, desktop AI client, or another MCP agent and ask it to start Claude on your laptop, check Codex on your workstation, continue a task on your server, or stop a runaway terminal command. Your agents stay on the computers where their projects and tools already live. Tandem gives you one secure connection for reaching all of them.

```text
your browser chat / AI client / MCP agent
                       |
                    Tandem
              _________|_________
             |         |         |
          laptop   workstation  server
          Claude      Codex      Hermes
```

## What you can do

- See which computers are online and which agents they can run.
- See every live Tandem session across those computers.
- Start Claude Code, Codex, Hermes, or a terminal shell on the computer that has the project.
- Send more work to a running agent without restarting it.
- Read new output, interrupt a stuck turn, or close a finished session.
- Move between your browser, desktop client, and other MCP-capable agents without losing the sessions running on your machines.
- Add multiple computers. Enrolled devices stay connected and reconnect automatically.

For example, from a browser client that supports remote MCP connectors:

> Show me every agent currently running.

> Start Codex on `studio` and have it review the authentication changes.

> Send the failing test output to Claude on `laptop` and ask it to fix the regression.

> Stop the shell command running on `server` but leave the session open.

Tandem is the bridge behind that conversation. It does not replace Claude, Codex, Hermes, or your preferred AI interface.

## Why use Tandem

Without Tandem, each agent is trapped inside the terminal and computer where it started. You switch machines, open SSH sessions, search for the right terminal, and repeat context by hand.

With Tandem, one agent can coordinate the others. You can begin work from a browser, let agents run on the machines that have the right repositories and tools, and come back later from a different client to inspect or steer them.

## Set up (R1a)

R1a has one hub of your own, a Cloudflare Worker, and the Tandem runtime on each computer, which links out to that hub. Try it first on one computer: the hub then runs locally and needs no account.

### Try it on one computer

You need Node.js 22, tmux and network access for npm. You do not need a Cloudflare account or any agent sign-in: the one session is a plain shell. Run this from the top of your clone:

<!-- r1a-first-commands -->
```sh
mkdir -p "$HOME/tandem-try/work" "$HOME/tandem-try/home"
npm ci --no-audit --no-fund
(cd hub && npm ci --no-audit --no-fund)
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$HOME/tandem-try/link-token"
node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$HOME/tandem-try/hub-password"
node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$HOME/tandem-try/owner-password"
chmod 700 "$HOME/tandem-try" "$HOME/tandem-try/home"
cd hub
WRANGLER_SEND_METRICS=false nohup node_modules/.bin/wrangler dev --local --port 8799 --ip 127.0.0.1 --var "TANDEM_HUB_LINK_TOKEN:$(cat "$HOME/tandem-try/link-token")" --var "TANDEM_HUB_PASSWORD:$(cat "$HOME/tandem-try/hub-password")" --persist-to "$HOME/tandem-try/hub-data" > "$HOME/tandem-try/hub.log" 2>&1 &
echo "$!" > "$HOME/tandem-try/hub.pid"
cd ..
i=0; until node -e 'fetch("http://127.0.0.1:8799/").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; do i=$((i + 1)); if [ "$i" -gt 180 ]; then cat "$HOME/tandem-try/hub.log"; exit 1; fi; sleep 1; done
cat > "$HOME/tandem-try/home/limits.toml" <<LIMITS
folders = ["$HOME/tandem-try/work"]
shell = true
[agents.shell]
program = "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$(command -v sh)")"
LIMITS
TANDEM_HOME="$HOME/tandem-try/home" TANDEM_PORT=0 TANDEM_PUBLIC_URL=https://localhost/mcp TANDEM_OWNER_PASSWORD_FILE="$HOME/tandem-try/owner-password" TANDEM_ENABLED_ENGINES=shell TANDEM_CWD_ALLOWLIST="$HOME/tandem-try/work" TANDEM_HUB_LINK_URL=ws://127.0.0.1:8799 TANDEM_HUB_LINK_TOKEN="$(cat "$HOME/tandem-try/link-token")" TANDEM_HUB_LINK_ID=first-computer nohup node --experimental-strip-types src/server.ts > "$HOME/tandem-try/runtime.log" 2>&1 &
echo "$!" > "$HOME/tandem-try/runtime.pid"
i=0; until grep -q 'hub link: connected' "$HOME/tandem-try/runtime.log"; do i=$((i + 1)); if [ "$i" -gt 60 ]; then cat "$HOME/tandem-try/runtime.log"; exit 1; fi; sleep 1; done
TANDEM_HOME="$HOME/tandem-try/home" TANDEM_ENABLED_ENGINES=shell TANDEM_CWD_ALLOWLIST="$HOME/tandem-try/work" node --input-type=module -e 'import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"; const c = new Client({ name: "first-commands", version: "1" }); await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--experimental-strip-types", "src/stdio-server.ts"], env: process.env })); const r = await c.callTool({ name: "open_session", arguments: { name: "first", engine: "shell", cwd: process.env.TANDEM_CWD_ALLOWLIST } }); console.log(r.content[0].text); await c.close(); process.exit(r.isError ? 1 : 0)'
node -e 'fetch("http://127.0.0.1:8799/").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' && TANDEM_HOME="$HOME/tandem-try/home" node --experimental-strip-types bridge/status.ts --json | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); const n = d.computers.filter((c) => c.self).flatMap((c) => c.sessions).filter((s) => s.name === "first").length; console.log(n === 1 ? "tandem: the hub answers and status lists 1 session" : "tandem: the session is not listed"); process.exit(n === 1 ? 0 : 1)'
```
<!-- /r1a-first-commands -->

What it does, in order: installs the dependencies; makes a link token, a hub password and an owner password, each in a private file under `~/tandem-try`; starts a local hub on `http://127.0.0.1:8799` in the background (log `~/tandem-try/hub.log`); writes a limits file that allows the folder `~/tandem-try/work` and the shell; starts the runtime linked to that hub (log `~/tandem-try/runtime.log`); opens one shell session named `first` in that folder; and checks that the hub answers and that status lists that one session. The last line prints `tandem: the hub answers and status lists 1 session` and exits 0 when everything works.

See the status again at any time, from the top of the clone (this is what `tandem status --json` prints once Tandem is installed):

```sh
TANDEM_HOME="$HOME/tandem-try/home" node --experimental-strip-types bridge/status.ts --json
```

Look at the session with `tmux -S "$HOME/tandem-try/home/tmux/tandem" attach -t =ccm-first` (detach with Ctrl-b d). Stop everything with `kill "$(cat "$HOME/tandem-try/runtime.pid")" "$(cat "$HOME/tandem-try/hub.pid")"` and `tmux -S "$HOME/tandem-try/home/tmux/tandem" kill-server`, then remove `~/tandem-try`.

### Deploy your own hub

You need a Cloudflare account, with `wrangler login` done once on this computer (`hub/node_modules/.bin/wrangler login`). Pick a new Worker name that starts with `tandem-` and run, from the top of the clone:

```sh
npm ci && (cd hub && npm ci)
./setup.sh r1a --name tandem-<something>
```

It checks that wrangler is logged in, refuses a name that already has a Worker, creates the hub's OAuth KV namespace, puts the hub password and link token as Worker secrets, and deploys (the Durable Object setup is applied on that first deploy). It prints:

- `hub-deploy: deployed tandem-<something>` and the Worker's URL;
- `hub-deploy: connector URL <Worker URL>/mcp`: add this URL as a connector in your AI client, and sign in with the text of the password file;
- `hub-deploy: owner password file ~/.tandem-next/hub-deploy/tandem-<something>/hub-password`;
- `hub-deploy: link token file ~/.tandem-next/hub-deploy/tandem-<something>/link-token`: each computer needs it to link to the hub.

Nothing secret is printed. A second run with the same name reuses the same password and token files. `./setup.sh r1a --name tandem-<something> --dry-run` only builds the hub and creates nothing.

### Add a computer

On each computer, from the top of a clone with `npm ci` done, install Tandem without starting it:

```sh
sh packaging/build-release.sh "$HOME/tandem-release"
TANDEM_ARCHIVE="$(ls "$HOME"/tandem-release/*.tar.gz)" TANDEM_NO_START=1 TANDEM_NO_LIMITS=1 sh packaging/install.sh
```

Copy the link token file to the computer (mode 0600), then link it to your hub and start it. `<Worker host>` is the host of the Worker URL, `<computer>` a short name for this computer, and `<password file>` a 0600 file holding at least 16 characters, the owner password for this computer's own sign-in page:

```sh
printf "TANDEM_HUB_LINK_URL='wss://%s'\nTANDEM_HUB_LINK_ID='%s'\nTANDEM_HUB_LINK_TOKEN='%s'\nTANDEM_PUBLIC_URL='https://localhost/mcp'\nTANDEM_OWNER_PASSWORD_FILE='%s'\n" '<Worker host>' '<computer>' "$(cat <link token file>)" '<password file>' >> ~/.tandem/tandem.env
~/.tandem/current/bin/tandem limits init --folder <folder> --agent <agent>
~/.tandem/current/bin/tandem start
~/.tandem/current/bin/tandem status
```

The computer then appears on your hub under its name. Repeat for each computer.

## Supported agents

| Engine | What Tandem controls | Default |
|---|---|---:|
| Claude Code | A real interactive Claude Code session | Off until enabled |
| Codex | A real interactive Codex session | Off until enabled |
| Hermes | An explicitly approved Hermes agent | Off until enabled |
| Shell | A terminal running as your OS user | Off until enabled |

No engine is on by default. Each computer's limits file names the folders and agents it allows.

Shell access is powerful. It gives an approved caller command execution as the Tandem OS user and is not a sandbox.

## Connect a local desktop client

If the AI client runs on the same computer and you do not want any network listener:

```bash
TANDEM_CWD_ALLOWLIST=/absolute/path/to/project ./setup.sh desktop
```

This writes a local MCP connector under `~/.tandem/desktop/connector.json`. The client starts Tandem directly over stdio.

## What your connected AI can call

| Tool | What it lets the AI do |
|---|---|
| `list_devices` | See your connected computers and their available engines. |
| `list_sessions` | See live Tandem sessions on a computer. |
| `open_session` | Start or reattach to an agent session. |
| `send_to_session` | Give the agent more work or read its latest output. |
| `interrupt_session` | Stop the current turn while keeping the session alive. |
| `close_session` | End a Tandem-owned session. |
| `relay` | Run Tandem's optional persistent Claude lead-and-worker loop. |

Tandem routes remote sessions using stable names such as `studio:review`, so later requests return to the same agent on the same computer.

## Security in plain language

Tandem controls real coding agents and terminals, so treat access to it like remote terminal access.

- You choose the folders where Tandem may start sessions. An empty list denies all new sessions.
- Tandem only reconnects to sessions it created and owns.
- Claude permission bypass is off unless you explicitly enable it.
- Codex, Hermes, and shell are off unless you explicitly enable them.
- Public MCP access requires OAuth approval.
- Each computer reaches your hub through an outbound connection that needs the hub's link token and that computer's own key.
- A device invitation works once and expires if unused. The enrolled device itself does not expire.
- Default logs exclude prompts, terminal output, project paths, credentials, hostnames, usernames, IP addresses, and network identity.

The folder allowlist controls where a session starts. It is not an operating-system sandbox. Every agent still has the permissions of the OS account running Tandem.

Read [SETUP.md](SETUP.md) for operations and troubleshooting. Read [SECURITY.md](SECURITY.md) before exposing a hub.

## Browser and client compatibility

Tandem works with clients that support remote MCP servers and OAuth. When that capability is available in a browser-based AI product, you can control Tandem directly from that browser conversation. Tandem also works with local MCP clients over stdio.

Tandem provides the agent-control backend. It cannot add MCP support to a third-party interface that does not offer it, and it cannot force a third-party chat to resume on its own.

## Old setup (Tailscale)

These sections are kept for installs that already use the Tailscale hub; new setups use the R1a path above.

### Fastest setup: give this to your agent

Paste this into Claude Code, Codex, or another trusted local coding agent on the computer you want to use as the Tandem hub. It will perform the installation and pause only when it needs you to sign in, approve a Tailscale setting, or choose which folders it may use.

```text
Install Tandem on this computer for me from:
https://github.com/Maxmedawar/tandem

Tandem lets an MCP-capable browser chat or AI client see, start, steer, and stop
my coding agents across all of my enrolled computers.

Do the setup yourself. Keep explanations short. Stop only when you need me to
sign in, approve an account setting, or answer a required question.

Safety rules:
- Read README.md, SETUP.md, SECURITY.md, and .env.example before changing anything.
- Preserve unrelated files and working-tree changes.
- Ask me which exact project folders Tandem may use. Never choose my home folder
  or a filesystem root. Do not continue until I answer.
- Ask which engines I want. No engine is on by default. Enable only the ones I
  name, and never Claude permission bypass unless I explicitly request it.
- Never print or paste a consent password, OAuth token, fleet credential,
  invitation token, private Tailscale address, or tailnet identity. You may report
  only the protected local file paths that setup intentionally prints, without
  reading or copying those files' contents.
- Never put a secret in a URL, command argument, issue, screenshot, or log.
- Use Tailscale Funnel only for the public MCP service. Use the separate,
  tailnet-only Tailscale Serve service for device traffic.
- Stop if a verification fails. Do not report partial setup as success.

Steps:
1. Check for Node.js 22.6+, tmux, Tailscale, and at least one supported coding
   agent. Install missing prerequisites with the normal package manager when safe.
   If an install needs administrator approval, ask me first.
2. Check whether Tailscale is running and connected. If I must sign in or enable
   HTTPS or Funnel in my account, give me short numbered instructions and wait.
3. Clone the repository if it is not already present, then enter the repository.
4. After I provide the allowed project folders and optional engines, run:
   TANDEM_CWD_ALLOWLIST=<exact approved folders> ./setup.sh hub
5. Confirm that setup verified public OAuth, rejected an unauthenticated private
   device connection, and detected the hub as a local device.
6. Confirm protected Tandem state is outside the repository and owner-only.
   Check permissions without displaying any secret contents.
7. Run npm run typecheck, npm test, and npm audit.

When everything passes, tell me only:
- that Tandem is ready;
- the stable MCP URL reported by setup;
- where setup stored the consent password, without reading it;
- where setup stored the first device invitation, without reading it;
- that I can run ./setup.sh invite once for each additional computer;
- that an invitation expires after 15 minutes if unused, but an enrolled device
  stays connected and reconnects automatically.
```

The same installation prompt lives in [SETUP-PROMPT.md](SETUP-PROMPT.md).

### Set up the main computer

You need:

- Node.js 22.6 or newer
- tmux
- Tailscale, connected with `tailscale up`
- at least one supported agent installed

Clone Tandem and tell it which project folders it may use:

```bash
git clone https://github.com/Maxmedawar/tandem.git
cd tandem
TANDEM_CWD_ALLOWLIST=/absolute/path/to/project ./setup.sh hub
```

Setup gives you:

1. One stable MCP URL to add to a compatible browser or desktop AI client.
2. A local owner password used once when approving that connection.
3. A protected invitation file for adding the first remote computer.

The MCP URL contains no secret. Your client opens Tandem's OAuth approval page when it connects.

### Add more computers

Create a separate invitation for each computer you want to add:

```bash
./setup.sh invite
```

Copy the reported invitation file to that computer, clone Tandem there, and run:

```bash
git clone https://github.com/Maxmedawar/tandem.git
cd tandem
TANDEM_CWD_ALLOWLIST=/absolute/path/to/project \
TANDEM_DEVICE_ID=studio \
TANDEM_DEVICE_NAME=studio \
./setup.sh device /secure/path/device-enrollment.json
```

Repeat this for every computer. Multiple invitations may exist at the same time.

The 15-minute limit applies only to an unused invitation file. It does not limit the device. After enrollment, the device stays authorized and reconnects automatically until you rotate its fleet credential or remove its protected configuration.

## Development

```bash
npm install
npm run typecheck
npm test
npm audit
```

The automated setup tests use temporary homes, synthetic network names, loopback listeners, and stub network and Cloudflare commands. They change no real account or network setting.

## License

MIT. See [LICENSE](LICENSE).
