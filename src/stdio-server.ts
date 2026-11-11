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
 */

// Desktop apps spawn this process from an arbitrary cwd, so locate .env next to
// package.json via the script's own path — never via process.cwd(). A missing
// .env is fine, but an explicit allowlist is still required before sessions open.
import { fileURLToPath } from "node:url";
import { loadProtectedRuntimeConfigFromEnv } from "./runtime-config.ts";
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

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { buildMcpServer } = await import("./mcp-server.ts");
const { getAllowlist } = await import("../bridge/router.ts");
const { createFleetRuntime, buildDefaultDeviceIdFromEnv } = await import("../bridge/fleet-runtime.ts");
const { capabilityReport } = await import("../bridge/engine-registry.ts");
const { startFabric } = await import("../bridge/fabric/local-fabric-host.ts");

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
// This process's own fabric store (only with CCM_FABRIC_ENABLED=1). The bridge process may
// open the same SQLite file: SQLite's file locks serialise the writes. Its diagnostics and
// audit lines go to stderr, since stdout is the wire.
const fabric = await startFabric({ stdout: (value) => process.stderr.write(value) });
const server = await buildMcpServer(fleet, fabric);
await server.connect(new StdioServerTransport());

console.error("tandem MCP bridge ready on stdio (local, no token)");
console.error(`cwd allowlist roots: ${allowlist.length}`);
