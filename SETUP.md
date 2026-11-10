# Set up Tandem

The normal installation has one Tailscale hub and zero or more outbound device bridges. Public MCP and private device traffic are separate services.

## Requirements

- Node.js 22.6 or newer
- tmux
- the standalone Tailscale app or CLI
- `tailscale up` completed on each machine
- Claude Code, or an explicitly enabled supported engine

Claude is the only default engine. Codex, shell, and Hermes require `TANDEM_ENABLED_ENGINES`.

## 1. Configure the hub

Choose exact project roots. Setup refuses an empty allowlist, a relative directory, a missing directory, or a filesystem root.

```bash
TANDEM_CWD_ALLOWLIST=/absolute/project:/absolute/second-project ./setup.sh hub
```

The script:

1. validates local prerequisites and configuration;
2. writes owner-only state under `~/.tandem`;
3. creates a connector consent password and a separate fleet credential;
4. starts OAuth/MCP on `127.0.0.1:8787`;
5. starts the fleet service on `127.0.0.1:8788`;
6. publishes only port 8787 with public Tailscale Funnel;
7. publishes only port 8788 through tailnet-only Tailscale Serve on HTTPS 8443;
8. verifies public health, OAuth metadata, unauthenticated private WebSocket rejection, and the hub's local device state;
9. writes a stable connector and an expiring one-time device invitation.

Generated state:

| Path | Purpose |
|---|---|
| `~/.tandem/hub/connector.json` | Stable remote MCP connector. No token in its URL. |
| `~/.tandem/hub/owner-password` | Local password for the OAuth consent page. |
| `~/.tandem/hub/device-enrollment.json` | Starter invitation for the first device, valid for 15 minutes. |
| `~/.tandem/hub/invitations/*.json` | Independent invitations created for additional devices. |
| `~/.tandem/hub/config.json` | Protected hub configuration. |
| `~/.tandem/oauth/` | Protected OAuth state. |
| `~/.tandem/fleet/` | Protected fleet enrollment state. |

Files are mode 0600 and state directories are mode 0700. No runtime secret is written into the repository.

## 2. Connect an MCP client

Add the printed `https://.../mcp` URL to a compatible remote Streamable HTTP MCP client. The client dynamically registers and opens the Tandem approval page. Read `~/.tandem/hub/owner-password` locally and enter it on that page.

Tandem requires authorization code flow with PKCE S256. Access tokens are audience-bound and short-lived. Refresh tokens rotate, and replay revokes the token family.

## 3. Enroll a device

Hub setup creates a starter invitation for the first device. Create an independent invitation for each additional device without restarting the hub:

```bash
./setup.sh invite
```

Multiple invitations can remain valid concurrently. Each invitation is protected, enrolls one device, and expires after 15 minutes if unused. Securely copy one invitation to its intended machine in the same permitted tailnet. Before the invitation expires:

```bash
TANDEM_CWD_ALLOWLIST=/absolute/project \
TANDEM_DEVICE_ID=studio \
TANDEM_DEVICE_NAME=studio \
TANDEM_ENABLED_ENGINES=codex \
./setup.sh device /secure/path/device-enrollment.json
```

The private invitation is exchanged once through Tailscale Serve. The hub returns the fleet credential only after consuming that invitation. Device setup then:

- writes an owner-only device configuration;
- removes the local invitation;
- starts the outbound-only bridge;
- waits for an authenticated registration acknowledgment;
- confirms the device's enabled capabilities were accepted.

The device opens no listening socket. Replaying or reusing the invitation fails. The enrolled device itself has no 15-minute limit: it retains the protected fleet credential and reconnects automatically. Repeat `./setup.sh invite` whenever another device needs to join.

Never use Funnel for port 8788 or the Serve HTTPS port. Funnel is public.

## Local stdio

For a same-machine MCP client:

```bash
TANDEM_CWD_ALLOWLIST=/absolute/project ./setup.sh desktop
```

This writes `~/.tandem/desktop/connector.json` and starts nothing. The MCP client launches Tandem over stdio.

## Long-running processes

Setup starts the hub or device and records its PID under `~/.tandem`. Tailscale `--bg` routes persist independently. For a durable server, run the corresponding Node command with its generated `TANDEM_CONFIG_FILE` under launchd, systemd, or your usual service manager.

Do not copy secrets into a service command line. Put only the protected configuration path in the service environment.

## Verify from MCP

1. Call `list_devices`.
2. Confirm only neutral ids, names, online states, and engine ids appear.
3. Open a small read-only task with an explicit device and engine.
4. Keep the returned global session name.
5. Poll without a new `text` value if the turn remains active.
6. Close the session.

## Troubleshooting

| Symptom | Check |
|---|---|
| Tailscale missing or logged out | Install the standalone client, run `tailscale up`, and retry. |
| Funnel setup fails | Check Funnel availability for this node locally with the Tailscale CLI, enable HTTPS/Funnel if required, and rerun setup. Tandem does not retain raw Tailscale output because it can contain private network identity. |
| Serve setup fails | Confirm the chosen private HTTPS port is allowed and differs from 443. |
| Public verification fails | Wait for Tailscale HTTPS certificate issuance, then rerun setup. |
| Invitation rejected | It expired, was revoked, or was already used. Rerun hub setup for a fresh file. |
| Device registration fails | Confirm both machines share the permitted tailnet and the device can reach the private Serve port. |
| Engine absent | Install its executable and explicitly enable it where required. |
| Session route ambiguous | Supply `device`, or configure `TANDEM_DEFAULT_DEVICE`. |
| Turn remains active | Poll without resending the assignment. |

## Migration from older Tandem setup

Cloudflare quick tunnels and token-bearing connector URLs are no longer supported by setup. Run `./setup.sh hub` to create the OAuth connector and protected state.
