/**
 * Exercises the production wiring pieces src/server.ts assembles (binding —
 * Phase 3 correction 7): a public HTTP MCP server and a private fleet
 * listener started independently, in the same process, sharing one
 * FleetRuntime — never merged into a single router, and the public side
 * keeps working untouched when no fleet token is configured.
 *
 * src/server.ts itself is a top-level-await script (not importable in a
 * test), so this exercises the same building blocks it wires together:
 * bridge/fleet-runtime.ts, bridge/fleet-private-server.ts, and
 * src/public-server.ts's startOAuthServer(). The removal rows at the end run
 * src/server.ts as a child process to prove the legacy static bearer is gone.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { loadOAuthConfig } = await import("../../src/auth-config.ts");
const { assertPublicHost, startOAuthServer } = await import("../../src/public-server.ts");
const { createFleetRuntime, buildDefaultDeviceIdFromEnv } = await import("../../bridge/fleet-runtime.ts");
const { startPrivateFleetServer } = await import("../../bridge/fleet-private-server.ts");

type FleetRuntime = ReturnType<typeof createFleetRuntime>;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FLEET_TOKEN = "production-wiring-test-token-0123456789";
const OWNER_PASSWORD = "owner password 0123456789";
const PUBLIC_URL = "http://127.0.0.1:45678/mcp";

type Closeable = { close(): Promise<void> };
const cleanups: Closeable[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function oauthConfig() {
  const root = await mkdtemp(join(tmpdir(), "tandem-wiring-"));
  roots.push(root);
  return loadOAuthConfig({
    publicUrl: PUBLIC_URL,
    allowLoopbackHttp: true,
    ownerPassword: OWNER_PASSWORD,
    stateDir: join(root, "oauth"),
  });
}

async function startPublic(fleet?: FleetRuntime) {
  return startOAuthServer({ host: "127.0.0.1", port: 0, config: await oauthConfig(), fleet });
}

describe("production wiring: public server with no fleet token", () => {
  it("rejects a non-loopback public bind and an invalid port before listening", async () => {
    expect(() => assertPublicHost("0.0.0.0")).toThrow(/loopback/);
    expect(() => assertPublicHost("127.0.0.1")).not.toThrow();
    const config = await oauthConfig();
    await expect(startOAuthServer({ host: "0.0.0.0", port: 0, config })).rejects.toThrow(/loopback/);
    await expect(startOAuthServer({ host: "127.0.0.1", port: 70_000, config })).rejects.toThrow(/port/);
  });

  it("still listens and serves its health check with no fleet runtime supplied", async () => {
    const publicHandle = await startPublic();
    const res = await fetch(`http://127.0.0.1:${publicHandle.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "tandem" });
    await publicHandle.close();
  });

  it("rejects an unauthenticated MCP request with 401", async () => {
    const publicHandle = await startPublic();
    cleanups.push(publicHandle);
    const unauthorized = await fetch(`http://127.0.0.1:${publicHandle.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
  });
});

describe("production wiring: fleet-enabled hub — same process, separate listeners", () => {
  it("the private fleet listener is a SEPARATE server; a WS upgrade to the PUBLIC port never reaches it", async () => {
    const fleetRuntime = createFleetRuntime({ defaultDeviceId: buildDefaultDeviceIdFromEnv({}) });
    const privateHandle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime: fleetRuntime });
    cleanups.push(privateHandle);

    // The public OAuth server never attaches an 'upgrade' handler, so a
    // WebSocket handshake against it must fail (never silently treated as a
    // fleet registration attempt against the wrong listener) — even when
    // presented with the exact valid fleet token.
    const publicHandle = await startPublic(fleetRuntime);
    cleanups.push(publicHandle);

    const wsAgainstPublic = new WebSocket(`ws://127.0.0.1:${publicHandle.port}`, {
      headers: { authorization: `Bearer ${FLEET_TOKEN}` },
    });
    wsAgainstPublic.on("error", () => {}); // expected — avoid an unhandled-error crash
    let opened = false;
    wsAgainstPublic.once("open", () => { opened = true; });
    await Promise.race([new Promise((r) => wsAgainstPublic.once("error", r)), new Promise((r) => wsAgainstPublic.once("close", r))]);
    expect(opened).toBe(false);

    // Meanwhile the SAME token against the PRIVATE listener succeeds normally.
    const wsAgainstPrivate = new WebSocket(`ws://127.0.0.1:${privateHandle.port}`, {
      headers: { authorization: `Bearer ${FLEET_TOKEN}` },
    });
    await new Promise((resolve) => wsAgainstPrivate.once("open", resolve));
    wsAgainstPrivate.close();
  });

  it("private listener close() rejects all pending broker requests and closes connected sockets (drain on shutdown)", async () => {
    const fleetRuntime = createFleetRuntime();
    const privateHandle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime: fleetRuntime });

    const ws = new WebSocket(`ws://127.0.0.1:${privateHandle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await new Promise((resolve) => ws.once("open", resolve));
    const { encodeRegisterFrame, generateNonce } = await import("../../bridge/fleet-protocol.ts");
    ws.send(encodeRegisterFrame("device-a", "studio", ["claude"], generateNonce()));
    await new Promise((resolve) => ws.once("message", resolve)); // register_ack

    const pending = fleetRuntime.broker.sendRequest("device-a", "read", { sessionId: "x" });
    const pendingAssertion = expect(pending).rejects.toThrow();
    const closed = new Promise((resolve) => ws.once("close", resolve));

    await privateHandle.close();

    await pendingAssertion;
    await closed;
  });
});

describe("buildDefaultDeviceIdFromEnv", () => {
  it("reads TANDEM_DEFAULT_DEVICE, trims it, and treats blank as unset", () => {
    expect(buildDefaultDeviceIdFromEnv({ TANDEM_DEFAULT_DEVICE: "  device-a  " })).toBe("device-a");
    expect(buildDefaultDeviceIdFromEnv({})).toBeUndefined();
    expect(buildDefaultDeviceIdFromEnv({ TANDEM_DEFAULT_DEVICE: "   " })).toBeUndefined();
  });
});

describe("legacy static bearer login is removed", () => {
  it("a) src/server.ts with TANDEM_LEGACY_TOKEN_AUTH=1 and TANDEM_TOKEN still answers 401 to that bearer", async () => {
    const home = await mkdtemp(join(tmpdir(), "tandem-bearer-child-"));
    roots.push(home);
    const legacyToken = "legacy-static-token-0123456789ab";
    const ownerPassword = "child owner password 012";
    expect(legacyToken).toHaveLength(32);
    expect(ownerPassword).toHaveLength(24);
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TANDEM_OAUTH_STATE_DIR: join(home, "oauth"),
        TANDEM_PORT: "0",
        TANDEM_PUBLIC_URL: "https://tandem.example/mcp",
        TANDEM_OWNER_PASSWORD: ownerPassword,
        TANDEM_LEGACY_TOKEN_AUTH: "1",
        TANDEM_TOKEN: legacyToken,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      let stderr = "";
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no listener line within 20s; stderr:\n${stderr}`)), 20_000);
        child.stderr!.on("data", (chunk) => {
          stderr += chunk;
          const match = /MCP bridge listening on loopback port (\d+)/.exec(stderr);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited ${code}; stderr:\n${stderr}`)); });
      });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${legacyToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bearer-removal-test", version: "0" } },
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, "SIGTERM");
      await exited;
    }
  }, 30_000);

  it("b) src/http-mcp.ts and test/legacy-http.test.ts do not exist", () => {
    expect(existsSync(join(REPO_ROOT, "src/http-mcp.ts"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "test/legacy-http.test.ts"))).toBe(false);
  });

  it("c) git grep for legacy bearer mentions outside test/ finds nothing (exit 1)", () => {
    let status = 0;
    let output = "";
    try {
      output = execFileSync("git", ["grep", "-nIiE", "LEGACY_TOKEN_AUTH|TANDEM_TOKEN|http-mcp|static bearer", "--", ".", ":!test/"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? -1;
      output = failure.stdout ?? "";
    }
    expect(output).toBe("");
    expect(status).toBe(1);
  });
});
