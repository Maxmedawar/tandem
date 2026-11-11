import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { buildMcpServer } = await import("../../src/mcp-server.ts");
const { createFleetRegistry } = await import("../../bridge/fleet-registry.ts");
const { createFleetBroker } = await import("../../bridge/fleet-broker.ts");
const { createFleetScheduler } = await import("../../bridge/fleet-scheduler.ts");
type FleetRuntime = import("../../bridge/fleet-runtime.ts").FleetRuntime;
type FleetSocket = import("../../bridge/fleet-registry.ts").FleetSocket;

function fakeSocket(): FleetSocket {
  return { send: () => {}, close: () => {}, bufferedAmount: 0 };
}

async function connectedClient(fleet?: FleetRuntime) {
  const server = await buildMcpServer(fleet);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("buildMcpServer: list_devices tool (binding — correction 10)", () => {
  it("is registered even with no remote fleet runtime, and returns the local hub with no agent on by default", async () => {
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    const { server, client } = await connectedClient(undefined);
    vi.unstubAllEnvs();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = await client.callTool({ name: "list_devices", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({ devices: [{ id: "local", name: "local", online: true, engines: [] }] });
  });

  it("returns exactly {id,name,online,engines} per device when a fleet runtime is supplied", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude", "codex"], fakeSocket());
    const fleet: FleetRuntime = { registry, broker: createFleetBroker(registry), scheduler: createFleetScheduler() };
    const { server, client } = await connectedClient(fleet);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = await client.callTool({ name: "list_devices", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices).toEqual([{ id: "device-a", name: "studio", online: true, engines: ["claude", "codex"] }]);
    for (const device of parsed.devices) {
      expect(Object.keys(device).sort()).toEqual(["engines", "id", "name", "online"]);
    }
  });
});

describe("buildMcpServer: device param on session tools", () => {
  it("open_session/send_to_session/interrupt_session/close_session/list_sessions all expose an optional 'device' field", async () => {
    const { server, client } = await connectedClient(undefined);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const { tools } = await client.listTools();
    for (const name of ["open_session", "send_to_session", "interrupt_session", "close_session", "list_sessions"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `expected tool ${name} to exist`).toBeDefined();
      const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props, `expected ${name} to expose a device field`).toHaveProperty("device");
      const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
      expect(required, `${name}'s device field must not be required`).not.toContain("device");
    }
  });

  it("relay tool never gains a device field (binding — correction 1: relay stays local-only)", async () => {
    const { server, client } = await connectedClient(undefined);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const { tools } = await client.listTools();
    const relay = tools.find((t) => t.name === "relay");
    const props = (relay!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).not.toHaveProperty("device");
  });
});
