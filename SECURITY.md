# Security policy

## Trust model

Tandem drives real agent and terminal processes as its OS user. Treat it like remote terminal authority. It is designed for one operator across owner-controlled devices, not for untrusted tenants.

### Public MCP and OAuth

- The public listener binds only to loopback.
- Tailscale Funnel may publish only this listener.
- The canonical resource is one exact HTTPS `/mcp` URL.
- OAuth authorization code flow requires PKCE S256, exact registered redirects, exact resource binding, and the `mcp` scope.
- Owner approval requires a protected password plus a one-time CSRF record and SameSite Strict cookie.
- Authorization codes are short-lived and single use.
- Access tokens are short-lived and audience-bound.
- Refresh tokens rotate. Replay revokes the refresh family and its access tokens.
- Public clients use dynamic registration without client secrets. Redirect URI classes are narrowly validated.
- OAuth bodies, MCP bodies, registration counts, approval attempts, and rates are bounded.
- OAuth state persists only the owner password verifier plus code, access-token, and refresh-token digests. Setup keeps the readable owner password separately in an owner-only file so the operator can complete consent locally.
- OAuth state is written atomically outside the repository with owner-only permissions.

The connector URL is not a credential. Knowing the Funnel hostname does not authorize a client.


### Private fleet and enrollment

- The fleet listener is a separate loopback-only server.
- Tailscale Serve publishes it on a distinct tailnet-only HTTPS port.
- Never publish the fleet or enrollment service with Funnel or a public proxy.
- Device WebSockets require the permanent fleet credential in an Authorization header.
- The credential never appears in a WebSocket URL.
- Each new device uses its own random invitation, which expires after 15 minutes if unused. Multiple invitations and enrolled devices are supported.
- The hub's server-side enrollment store keeps only an invitation digest. The owner-only transfer bundle carries the raw invitation long enough to move it to the new device. Atomic claim gives concurrent replays exactly one winner.
- A consumed, expired, revoked, malformed, or unknown invitation cannot be reused.
- The permanent credential is returned only by the private enrollment exchange.
- The 15-minute lifetime applies only to the invitation. An enrolled device retains its protected fleet credential and reconnects until that credential is rotated or removed.
- Device clients connect outbound and open no listener.
- Protocol frames use strict schemas, a 1 MiB maximum, bounded timeouts, bounded backpressure, and at most 32 in-flight requests per device.
- Duplicate device replacement is generation-safe and rejects the older connection's pending requests.

Every fleet machine must be controlled by the same operator and permitted by the tailnet policy. A successfully enrolled device receives the shared fleet credential. Rotate it if a device is lost or compromised.

### Execution authority

- `TANDEM_CWD_ALLOWLIST` is canonicalized and boundary checked before each tmux-backed spawn or owned-session reattachment.
- An empty allowlist denies session creation.
- Setup additionally refuses relative paths, missing directories, and filesystem roots.
- The allowlist is a starting-directory admission gate, not an OS sandbox.
- Only sessions with Tandem's exact engine and installation ownership tags may be driven after restart.
- Arbitrary tmux panes are never adopted.
- Claude permission bypass is off. Only exact `TANDEM_ALLOW_BYPASS=1` enables it.
- The unattended relay requires that explicit bypass and remains Claude-only.
- Codex, shell, and Hermes are disabled unless explicitly enabled.
- Shell is arbitrary command execution as the OS user.
- Hermes accepts only an exact loopback gateway and explicitly allowlisted writable agent ids. Messaging channels and history discovery are absent.
- Disabled, unknown, and unavailable engines fail before process spawn or gateway contact.

### Privacy

- `list_devices` returns exactly `id`, `name`, `online`, and `engines`.
- Device identity uses configured neutral labels, never hostnames or usernames.
- Default logs exclude prompts, terminal bodies, OAuth artifacts, bearer tokens, nonces, cwd paths, hostnames, usernames, IP addresses, tailnet identity, and histories.
- Audit records retain bounded action metadata and byte counts.
- Startup logs report only safe listener state and the number of configured cwd roots.
- Setup-generated runtime state lives below `~/.tandem` by default, outside the repository, with directories at mode 0700 and files at mode 0600.
- Completion events may contain private summaries by design. Webhook and ntfy delivery are explicit opt-ins.

## Operator checklist

1. Use narrow project allowlists on every machine.
2. Enable only required engines.
3. Keep permission bypass off unless the unattended Claude relay is required.
4. Keep the private fleet port on Tailscale Serve only.
5. Protect the Tailscale account and tailnet policy with strong authentication.
6. Use a dedicated least-privilege OS account where practical.
7. Move long-running processes under a service manager without putting secrets in command arguments.
8. Rotate the fleet credential and OAuth owner password after a suspected compromise.
9. Patch Tandem, Node.js, Tailscale, tmux, and engine CLIs regularly.
10. Redact private paths, URLs, identities, prompts, and credentials from reports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use the repository's private GitHub Security Advisory flow or the maintainer contact in the project metadata. Include reproduction steps and the affected revision, but redact credentials, device identity, private URLs, paths, prompts, and personal data.
