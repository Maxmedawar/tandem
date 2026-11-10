/**
 * Tandem network entrypoint.
 *
 * The public MCP listener is OAuth-protected. The private fleet listener is a
 * separate loopback-only WebSocket service with its own bearer credential.
 */
import { fileURLToPath } from "node:url";
import { loadProtectedRuntimeConfigFromEnv, readProtectedSecretFile } from "./runtime-config.ts";

try {
  const loadedProtectedConfig = await loadProtectedRuntimeConfigFromEnv();
  if (!loadedProtectedConfig) {
    try {
      process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!process.env.TANDEM_OWNER_PASSWORD && process.env.TANDEM_OWNER_PASSWORD_FILE) {
    process.env.TANDEM_OWNER_PASSWORD = await readProtectedSecretFile(process.env.TANDEM_OWNER_PASSWORD_FILE);
  }
} catch {
  console.error("tandem will not start: protected runtime configuration is unavailable or unsafe");
  process.exit(1);
}

if (process.env.TANDEM_CWD_ALLOWLIST) process.env.CCM_CWD_ALLOWLIST = process.env.TANDEM_CWD_ALLOWLIST;
if (process.env.TANDEM_DEFAULT_CWD) process.env.CCM_DEFAULT_CWD = process.env.TANDEM_DEFAULT_CWD;

const publicHost = process.env.TANDEM_HOST ?? "127.0.0.1";
const publicPort = Number(process.env.TANDEM_PORT ?? 8787);
const fleetToken = (process.env.TANDEM_FLEET_TOKEN ?? "").trim();
const fleetHost = process.env.TANDEM_FLEET_HOST ?? "127.0.0.1";
const fleetPort = Number(process.env.TANDEM_FLEET_PORT ?? 8788);

if (fleetToken && fleetToken.length < 16) {
  console.error("tandem will not start: TANDEM_FLEET_TOKEN must contain at least 16 characters");
  process.exit(1);
}
if (fleetToken && !new Set(["127.0.0.1", "::1", "localhost"]).has(fleetHost)) {
  console.error("tandem will not start: private fleet listener host must be loopback");
  process.exit(1);
}
if (fleetToken && (!Number.isInteger(fleetPort) || fleetPort < 0 || fleetPort > 65_535)) {
  console.error("tandem will not start: private fleet port is invalid");
  process.exit(1);
}

const { createFleetRuntime, buildDefaultDeviceIdFromEnv } = await import("../bridge/fleet-runtime.ts");
const { capabilityReport } = await import("../bridge/engine-registry.ts");
const localCapabilities = await capabilityReport();
const fleetRuntime = createFleetRuntime({
  defaultDeviceId: buildDefaultDeviceIdFromEnv(),
  localEngines: localCapabilities.filter((entry) => entry.enabled && entry.available).map((entry) => entry.engine),
});

type ClosableHandle = { readonly port: number; close(): Promise<void> };
let publicHandle: ClosableHandle | undefined;
let privateHandle: ClosableHandle | undefined;

try {
  const { loadOAuthConfigFromEnv } = await import("./auth-config.ts");
  const config = loadOAuthConfigFromEnv();
  const { startOAuthServer } = await import("./public-server.ts");
  publicHandle = await startOAuthServer({ host: publicHost, port: publicPort, config, fleet: fleetRuntime });

  if (fleetToken) {
    const { startPrivateFleetServer } = await import("../bridge/fleet-private-server.ts");
    const { FleetEnrollmentStore } = await import("../bridge/fleet-enrollment.ts");
    const { audit } = await import("../bridge/audit.ts");
    const enrollmentStore = await FleetEnrollmentStore.open(
      process.env.TANDEM_ENROLLMENT_STATE_DIR,
    );
    try {
      privateHandle = await startPrivateFleetServer({
        host: fleetHost,
        port: fleetPort,
        fleetToken,
        runtime: fleetRuntime,
        enrollment: { store: enrollmentStore, fleetToken },
        auditEvent: audit,
      });
    } catch (error) {
      await publicHandle.close();
      publicHandle = undefined;
      throw error;
    }
    console.error(`tandem private fleet listener on loopback port ${privateHandle.port}`);
  }
} catch (error) {
  // Do not echo filesystem paths, bind addresses, tailnet names, or secrets
  // from lower-level errors. Detailed errors belong in local debugging, not
  // the default startup surface.
  void error;
  console.error("tandem will not start: configuration, protected state, or listener startup failed");
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`tandem: received ${signal}, shutting down`);
  const results = await Promise.allSettled([
    publicHandle?.close() ?? Promise.resolve(),
    privateHandle?.close() ?? Promise.resolve(),
  ]);
  process.exit(results.some((result) => result.status === "rejected") ? 1 : 0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
