/**
 * Tandem device entrypoint.
 *
 * Connects OUT to a hub's private fleet WebSocket listener and serves this
 * machine's own local engines through the fleet protocol. This process runs
 * the SAME cwd-allowlisted, engine-gated local router every other Tandem
 * entrypoint uses — the fleet client only ever forwards already-validated
 * fixed operations into it (bridge/fleet-device-router.ts). It never grants
 * any capability the local router itself wouldn't grant to a same-machine
 * caller, and it opens NO listening socket of its own (outbound-only).
 *
 * Required: TANDEM_FLEET_TOKEN, TANDEM_HUB_URL, TANDEM_DEVICE_ID.
 */

import { fileURLToPath } from "node:url";
import { loadProtectedRuntimeConfigFromEnv, writeProtectedFile } from "./runtime-config.ts";
try {
  const loadedProtectedConfig = await loadProtectedRuntimeConfigFromEnv();
  if (!loadedProtectedConfig) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  if (process.env.TANDEM_CONFIG_FILE) {
    console.error("✗ tandem device will not start: protected runtime configuration is unavailable or unsafe");
    process.exit(1);
  }
  /* no development .env; explicit process environment remains supported */
}

function fail(message: string): never {
  console.error(`✗ tandem device will not start: ${message}`);
  process.exit(1);
}

const fleetToken = (process.env.TANDEM_FLEET_TOKEN ?? "").trim();
const hubUrl = (process.env.TANDEM_HUB_URL ?? "").trim();
const deviceId = (process.env.TANDEM_DEVICE_ID ?? "").trim();
const deviceName = (process.env.TANDEM_DEVICE_NAME ?? "").trim() || deviceId;

if (!fleetToken) fail("TANDEM_FLEET_TOKEN is not set.");
if (fleetToken.length < 16) fail("TANDEM_FLEET_TOKEN is too short to be safe (need >= 16 chars).");
if (!hubUrl) fail("TANDEM_HUB_URL is not set (e.g. wss://hub.your-tailnet.ts.net:8443).");
if (!deviceId) fail("TANDEM_DEVICE_ID is not set.");

const { FleetDeviceClient, InvalidHubUrlError } = await import("../bridge/fleet-device-client.ts");
const { capabilityReport } = await import("../bridge/engine-registry.ts");
const { getAllowlist } = await import("../bridge/router.ts");

const allowlist = getAllowlist();
if (allowlist.length === 0) {
  console.error(
    "⚠  cwd allowlist is empty: open_session will refuse every directory.\n" +
      "   Set TANDEM_CWD_ALLOWLIST to the folders this device may work in.",
  );
}

let client: InstanceType<typeof FleetDeviceClient>;
try {
  const capabilities = await capabilityReport();
  const availableEngines = capabilities
    .filter((entry) => entry.enabled && entry.available)
    .map((entry) => entry.engine);
  client = new FleetDeviceClient({
    hubUrl,
    fleetToken,
    deviceId,
    deviceName,
    engines: () => [...availableEngines],
    onRegistered: process.env.TANDEM_DEVICE_READY_FILE
      ? () => void writeProtectedFile(process.env.TANDEM_DEVICE_READY_FILE!, "ready\n")
      : undefined,
  });
} catch (e) {
  if (e instanceof InvalidHubUrlError) fail(e.message);
  throw e;
}

client.start();
console.error(`tandem device "${deviceId}" connecting to the configured private hub`);
console.error(`cwd allowlist roots: ${allowlist.length}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`tandem device: received ${signal}, disconnecting...`);
  await client.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
