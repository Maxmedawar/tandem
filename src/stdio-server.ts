/**
 * tandem — local stdio entrypoint (desktop, no tunnel).
 *
 * Runs the SAME MCP server as the HTTP transport (src/mcp-server.ts → the same
 * router and the same tools) over stdio, for MCP desktop apps and local agents
 * that spawn the bridge as a child process. Nothing
 * listens on the network and no tunnel is involved.
 *
 * TRUST MODEL (why there is NO token here): a stdio server can only be driven
 * by whoever spawned it — a local app running as the same user, i.e. the same
 * trust as the user's own terminal. OAuth protects the public network path,
 * while stdio deliberately needs no network credential. The cwd allowlist is
 * still enforced before every spawn, exactly as on the HTTP path.
 *
 * PROTOCOL HYGIENE: stdout is the JSON-RPC wire. Every diagnostic in this
 * process goes to stderr (the router/engine already follow this rule).
 *
 * CALLER (bridge/caller-tokens.ts): an agent inside a Tandem session starts this server as its
 * child with its session's TANDEM_CALLER_TOKEN in the environment, so this process serves that one
 * agent for its whole life. The variable is read and deleted at once (sessions this process opens
 * get their own). A token that names a session makes every call here that agent's
 * (`session:<name>`); one that names nothing, or a session that is no longer there, refuses to
 * start, never the owner. No variable: the
 * owner's own client.
 */

// Desktop apps spawn this process from an arbitrary cwd, so locate .env next to
// package.json via the script's own path — never via process.cwd(). A missing
// .env is fine, but an explicit allowlist is still required before sessions open.
import { fileURLToPath } from "node:url";
import { loadProtectedRuntimeConfigFromEnv } from "./runtime-config.ts";
import type { FabricForward } from "../bridge/hub-rpc.ts";
// Read once and out of the environment at once (never printed).
const callerToken = process.env.TANDEM_CALLER_TOKEN;
delete process.env.TANDEM_CALLER_TOKEN;
try {
  const loadedProtectedConfig = await loadProtectedRuntimeConfigFromEnv();
  if (!loadedProtectedConfig) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  if (process.env.TANDEM_CONFIG_FILE) {
    console.error("tandem stdio will not start: protected runtime configuration is unavailable or unsafe");
    process.exit(1);
  }
  /* no development .env; explicit environment remains supported */
}

// Bridge the user-facing TANDEM_* config to the engine's CCM_* names. This MUST
// happen before importing the server module, which loads the router (and its
// cwd allowlist) at module load.
if (process.env.TANDEM_CWD_ALLOWLIST) process.env.CCM_CWD_ALLOWLIST = process.env.TANDEM_CWD_ALLOWLIST;
if (process.env.TANDEM_DEFAULT_CWD) process.env.CCM_DEFAULT_CWD = process.env.TANDEM_DEFAULT_CWD;

// The caller, before the server module reads it. Fail closed: an unresolved value is never the owner.
if (callerToken !== undefined) {
  const { resolveCallerToken, setProcessCaller } = await import("../bridge/caller-tokens.ts");
  let callerName: string | undefined;
  try {
    callerName = resolveCallerToken(callerToken);
  } catch {
    callerName = undefined;
  }
  // A token outlives a session that ended without close() (the kill switch's --close, a crash, a
  // plain kill-session): it names an agent only while its session is there on Tandem's socket.
  if (callerName !== undefined) {
    const { TerminalSession } = await import("../bridge/terminal-session.ts");
    if (!(await TerminalSession.exists(callerName).catch(() => false))) callerName = undefined;
  }
  if (callerName === undefined) {
    const refusal = "tandem stdio: caller token unknown; refusing to start\n";
    await new Promise((done) => process.stderr.write(refusal, done));
    process.exit(1);
  }
  setProcessCaller(callerName);
  process.stderr.write(`tandem stdio: caller session:${callerName}\n`);
}

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { buildMcpServer } = await import("./mcp-server.ts");
const { getAllowlist } = await import("../bridge/router.ts");
const { createFleetRuntime, buildDefaultDeviceIdFromEnv } = await import("../bridge/fleet-runtime.ts");
const { capabilityReport } = await import("../bridge/engine-registry.ts");
const { startFabric } = await import("../bridge/fabric/local-fabric-host.ts");

// This computer's mailbox (bridge/mailbox.ts), opened below; several processes may open its file at once.
let mail: import("../bridge/mailbox.ts").Mailbox | undefined;
// A room post that names a session leaves it one fyi line in this mailbox (bound late: the box opens
// below). A refused wake drops that one name with one stderr line, never the name or the text.
const onWake = ({ names, room, eventId }: { names: string[]; room: string; eventId: string }) => {
  for (const name of names) {
    try {
      mail?.wake(name, room, eventId);
    } catch (error) {
      const status = (error as { status?: unknown } | undefined)?.status;
      console.error(`room wake: ${typeof status === "number" ? status : "failed"}`);
    }
  }
};
// This process's own fabric store (only with CCM_FABRIC_ENABLED=1). The bridge process may
// open the same SQLite file: SQLite's file locks serialise the writes. Its diagnostics and
// audit lines go to stderr, since stdout is the wire.
const fabric = await startFabric({ stdout: (value) => process.stderr.write(value), onWake });

// No store here and a hub link set: the 11 fabric tools pass each call to the hub, which sends
// it to the memory home. Nothing is stored on this computer. The link config is also kept for an
// agent's signed commands to another computer (bridge/remote-command.ts, U-R1A-36B).
let hubForward: FabricForward | undefined;
let hubLink: import("../bridge/hub-link.ts").HubLinkConfig | undefined;
if (process.env.TANDEM_HUB_LINK_URL) {
  try {
    const { hubLinkConfigFromEnv } = await import("../bridge/hub-link.ts");
    const { fabricForward } = await import("../bridge/hub-rpc.ts");
    hubLink = hubLinkConfigFromEnv(process.env);
    if (hubLink && !fabric) hubForward = fabricForward(hubLink);
  } catch {
    if (!fabric) console.error("tandem stdio: hub link configuration is invalid; memory tools are off");
  }
}
// Out of the environment in every case, so no session this process starts inherits the secret.
delete process.env.TANDEM_HUB_LINK_TOKEN;

const allowlist = getAllowlist();
if (allowlist.length === 0) {
  console.error(
    "⚠  cwd allowlist is empty: open_session/relay will refuse every directory.\n" +
      "   Set TANDEM_CWD_ALLOWLIST to the folders the bridge may work in.",
  );
}

// One long-lived server for the whole process (the SDK's stdio model), unlike
// the HTTP path's per-request instances. Session/relay state lives in the
// engine modules either way.
const localCapabilities = await capabilityReport();
const fleet = createFleetRuntime({
  defaultDeviceId: buildDefaultDeviceIdFromEnv(),
  localEngines: localCapabilities.filter((entry) => entry.enabled && entry.available).map((entry) => entry.engine),
});
try {
  mail = (await import("../bridge/mailbox.ts")).openMailbox();
} catch {
  console.error("mail: store unavailable; mail tools are off");
}
// A message a dead deliverer left delivering (only those over 60 s: a hook run ends in 10 s) shows
// as maybe_delivered; then the notice line for agents with mail (bridge/delivery-notice.ts).
if (mail) {
  try {
    mail.recover(60_000);
  } catch {
    console.error("mail: recover failed at start; a message left delivering stays so until the next start");
  }
  (await import("../bridge/delivery-notice.ts")).startNotices(mail);
}
// Who is up on this computer (bridge/presence.ts): read on a call, never on a timer.
const presence = (await import("../bridge/presence.ts")).createPresence();
// Past sessions' messages, masked and project-scoped (bridge/transcripts/search.ts); its file opens on first use.
let transcripts: import("../bridge/transcripts/search.ts").TranscriptSearch | undefined;
try {
  transcripts = (await import("../bridge/transcripts/search.ts")).openTranscriptSearch();
} catch {
  console.error("transcripts: search unavailable; transcript tools are off");
}
const server = await buildMcpServer(fleet, fabric ?? hubForward, mail, presence, transcripts, hubLink);
await server.connect(new StdioServerTransport());

console.error("tandem MCP bridge ready on stdio (local, no token)");
console.error(`cwd allowlist roots: ${allowlist.length}`);
