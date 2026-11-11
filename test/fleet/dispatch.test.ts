import { afterEach, describe, expect, it } from "vitest";

// bridge/router.ts's audit() writes to the real ~/.tandem/bridge.log — stub it
// out exactly like test/router-engines.test.ts, so local-path dispatch tests
// never touch real home state.
import { vi } from "vitest";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const {
  dispatchListDevices,
  dispatchListSessions,
  dispatchOpenSession,
  dispatchSessionOp,
  resolveExistingTarget,
  resolveOpenDevice,
  DeviceAmbiguousError,
  DeviceNotFoundError,
} = await import("../../bridge/fleet-dispatch.ts");
const { createFleetRegistry } = await import("../../bridge/fleet-registry.ts");
const { createFleetScheduler } = await import("../../bridge/fleet-scheduler.ts");
const { createFleetRuntime } = await import("../../bridge/fleet-runtime.ts");
const { registerLive, unregisterLive } = await import("../../bridge/sessions.ts");
const { routeForTest } = await import("../../bridge/router.ts");
type DrivableSession = import("../../bridge/drivable.ts").DrivableSession;
type FleetRuntime = import("../../bridge/fleet-runtime.ts").FleetRuntime;
type FleetBroker = import("../../bridge/fleet-broker.ts").FleetBroker;
type FleetSocket = import("../../bridge/fleet-registry.ts").FleetSocket;

/** The hub with claude enabled: no agent is on by default, so these routing cases enable it. */
const LOCAL_CLAUDE = { id: "local", name: "local", online: true, engines: ["claude"] };

function fakeSocket(): FleetSocket {
  return { send: () => {}, close: () => {}, bufferedAmount: 0 };
}

function fakeSession(id: string): DrivableSession {
  return {
    id,
    engine: "claude",
    cwd: "/tmp/fake",
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: "done", report: "ok", cursor: 1 }),
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
}

/** A scripted broker double — no real socket, canned per-call responses. */
function scriptedBroker(handler: (deviceId: string, op: string, payload: unknown) => Promise<{ status: number; body: unknown }>): FleetBroker {
  return {
    sendRequest: (deviceId: string, op: string, payload: unknown) =>
      handler(deviceId, op, payload),
    handleResponse: () => {},
    rejectAll: () => {},
    rejectEverything: () => {},
    inFlightCount: () => 0,
  } as unknown as FleetBroker;
}

const opened: string[] = [];
afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
});

describe("resolveExistingTarget (binding — correction 2)", () => {
  it("a bare name with no device is always local", () => {
    expect(resolveExistingTarget("plain", undefined)).toEqual({ localName: "plain" });
  });

  it("a bare name with device='local' is local", () => {
    expect(resolveExistingTarget("plain", "local")).toEqual({ localName: "plain" });
  });

  it("an explicit device with a bare name routes to that device", () => {
    expect(resolveExistingTarget("plain", "device-a")).toEqual({ deviceId: "device-a", localName: "plain" });
  });

  it("a composite name implies its device", () => {
    expect(resolveExistingTarget("device-a:plain", undefined)).toEqual({ deviceId: "device-a", localName: "plain" });
  });

  it("agreeing explicit device + composite name is fine", () => {
    expect(resolveExistingTarget("device-a:plain", "device-a")).toEqual({ deviceId: "device-a", localName: "plain" });
  });

  it("conflicting explicit device vs composite-implied device throws", () => {
    expect(() => resolveExistingTarget("device-a:plain", "device-b")).toThrow();
  });
});

describe("resolveOpenDevice (binding — correction 2)", () => {
  it("resolves to local when no fleet device is online (backward compatible)", () => {
    const registry = createFleetRegistry();
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler(), localDevice: LOCAL_CLAUDE };
    expect(resolveOpenDevice(runtime, undefined, "claude")).toBeUndefined();
  });

  it("device='local' always resolves to local even with other devices online", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler(), localDevice: LOCAL_CLAUDE };
    expect(resolveOpenDevice(runtime, "local", "claude")).toBeUndefined();
  });

  it("an explicit unknown device throws DeviceNotFoundError", () => {
    const registry = createFleetRegistry();
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    expect(() => resolveOpenDevice(runtime, "ghost", "claude")).toThrow(DeviceNotFoundError);
  });

  it("an explicit device incapable of the engine throws DeviceNotFoundError", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["codex"], fakeSocket());
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    expect(() => resolveOpenDevice(runtime, "device-a", "claude")).toThrow(DeviceNotFoundError);
  });

  it("local is a candidate too: with one remote device also capable, ambiguity fails deterministically listing both", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler(), localDevice: LOCAL_CLAUDE };
    try {
      resolveOpenDevice(runtime, undefined, "claude");
      throw new Error("expected DeviceAmbiguousError");
    } catch (e) {
      expect(e).toBeInstanceOf(DeviceAmbiguousError);
      expect((e as InstanceType<typeof DeviceAmbiguousError>).candidates.sort()).toEqual(["device-a", "local"]);
    }
  });

  it("a configured default device wins over ambiguity", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime = {
      registry,
      broker: scriptedBroker(async () => ({ status: 200, body: {} })),
      scheduler: createFleetScheduler(),
      defaultDeviceId: "device-a",
    };
    expect(resolveOpenDevice(runtime, undefined, "claude")).toBe("device-a");
  });

  it("only a remote device (not local) is capable ⇒ uniquely selected without a default", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["codex"], fakeSocket());
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    expect(resolveOpenDevice(runtime, undefined, "codex")).toBe("device-a");
  });

  it("nothing capable (local included) throws DeviceNotFoundError", () => {
    const registry = createFleetRegistry();
    const runtime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    expect(() => resolveOpenDevice(runtime, undefined, "hermes")).toThrow(DeviceNotFoundError);
  });
});

describe("dispatchOpenSession: remote responses never return a bare name (binding — correction 2)", () => {
  it("accepts a composite name on open and pins the request to that device", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["codex"], fakeSocket());
    const runtime: FleetRuntime = {
      registry,
      broker: scriptedBroker(async (deviceId, op, payload) => {
        expect(deviceId).toBe("device-a");
        expect(op).toBe("open_session");
        expect(payload).toMatchObject({ name: "review", engine: "codex" });
        return { status: 200, body: { name: "review", engine: "codex", cwd: "/x" } };
      }),
      scheduler: createFleetScheduler(),
      localDevice: { id: "local", name: "local", online: true, engines: ["claude"] },
    };
    const result = await dispatchOpenSession(runtime, { name: "device-a:review", engine: "codex" });
    expect(result).toEqual({
      status: 200,
      body: { name: "device-a:review", engine: "codex", cwd: "/x", device: "device-a", localName: "review" },
    });
  });

  it("rewrites a remote open_session's name into <deviceId>:<localName> with additive device/localName", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime: FleetRuntime = {
      registry,
      broker: scriptedBroker(async () => ({ status: 200, body: { name: "sess-1", engine: "claude", cwd: "/x" } })),
      scheduler: createFleetScheduler(),
    };
    const result = await dispatchOpenSession(runtime, { name: "sess-1", engine: "claude", device: "device-a" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ name: "device-a:sess-1", engine: "claude", cwd: "/x", device: "device-a", localName: "sess-1" });
  });

  it("a purely local open (no fleet devices online) behaves EXACTLY like calling the router directly — never gains device/localName", async () => {
    // Whatever the real router does with this name (likely a fail-closed 403
    // from an empty test-env cwd allowlist — this suite never spawns a real
    // tmux/engine process), dispatch must not alter it in any way when the
    // call resolves to local.
    const registry = createFleetRegistry();
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler(), localDevice: LOCAL_CLAUDE };
    const direct = await routeForTest("POST", "/sessions/open", { name: "local-sess-direct", engine: "claude" });
    const result = await dispatchOpenSession(runtime, { name: "local-sess-dispatch", engine: "claude" });
    expect(result.status).toBe(direct.status);
    const body = result.body as Record<string, unknown>;
    expect(body.device).toBeUndefined();
    expect(body.localName).toBeUndefined();
  });

  it("an ambiguous open returns 409 with candidates, never silently picking one", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler(), localDevice: LOCAL_CLAUDE };
    const result = await dispatchOpenSession(runtime, { engine: "claude" });
    expect(result.status).toBe(409);
  });
});

describe("dispatchSessionOp: remote send/read/interrupt/close routing", () => {
  it("routes a composite-named send to its device and rewrites the response name", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime: FleetRuntime = {
      registry,
      broker: scriptedBroker(async (deviceId, op, payload) => {
        expect(deviceId).toBe("device-a");
        expect(op).toBe("send");
        expect(payload).toMatchObject({ sessionId: "sess-1", text: "hi" });
        return { status: 200, body: { name: "sess-1", engine: "claude", report: "ok", cursor: 1 } };
      }),
      scheduler: createFleetScheduler(),
    };
    const result = await dispatchSessionOp(runtime, "send", "device-a:sess-1", undefined, { text: "hi" });
    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).name).toBe("device-a:sess-1");
  });

  it("400s when the explicit device conflicts with the composite name's device", async () => {
    const registry = createFleetRegistry();
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    const result = await dispatchSessionOp(runtime, "send", "device-a:sess-1", "device-b", { text: "hi" });
    expect(result.status).toBe(400);
  });

  it("404s a remote op against a device that is not currently online", async () => {
    const registry = createFleetRegistry();
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    const result = await dispatchSessionOp(runtime, "send", "offline-device:sess-1", undefined, { text: "hi" });
    expect(result.status).toBe(404);
  });

  it("a bare name always routes locally even while remote devices are online", async () => {
    const name = "local-only-sess";
    registerLive(fakeSession(name));
    opened.push(name);
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    let brokerCalled = false;
    const runtime: FleetRuntime = {
      registry,
      broker: scriptedBroker(async () => {
        brokerCalled = true;
        return { status: 200, body: {} };
      }),
      scheduler: createFleetScheduler(),
    };
    const result = await dispatchSessionOp(runtime, "send", name, undefined, { text: "hi" });
    expect(brokerCalled).toBe(false);
    expect(result.status).toBe(200);
  });
});

describe("dispatchListSessions: rewrites remote session ids (binding — correction 2)", () => {
  it("rewrites every id in a remote device's session list", async () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const runtime: FleetRuntime = {
      registry,
      broker: scriptedBroker(async () => ({
        status: 200,
        body: { sessions: [{ id: "sess-1", engine: "claude" }, { id: "sess-2", engine: "codex" }] },
      })),
      scheduler: createFleetScheduler(),
    };
    const result = await dispatchListSessions(runtime, "device-a", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      sessions: [
        { id: "device-a:sess-1", engine: "claude", device: "device-a", localName: "sess-1" },
        { id: "device-a:sess-2", engine: "codex", device: "device-a", localName: "sess-2" },
      ],
    });
  });
});

describe("dispatchListDevices: exact public shape (binding — correction 10)", () => {
  it("includes the safe local hub record when using the production runtime", () => {
    const runtime = createFleetRuntime({ localEngines: ["claude", "codex"] });
    expect(dispatchListDevices(runtime)).toEqual({
      status: 200,
      body: { devices: [{ id: "local", name: "local", online: true, engines: ["claude", "codex"] }] },
    });
  });

  it("returns id/name/online/engines only, straight from the registry, no wire round trip", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude", "codex"], fakeSocket());
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    const result = dispatchListDevices(runtime);
    expect(result).toEqual({ status: 200, body: { devices: [{ id: "device-a", name: "studio", online: true, engines: ["claude", "codex"] }] } });
  });

  it("is empty when no device has registered", () => {
    const registry = createFleetRegistry();
    const runtime: FleetRuntime = { registry, broker: scriptedBroker(async () => ({ status: 200, body: {} })), scheduler: createFleetScheduler() };
    expect(dispatchListDevices(runtime)).toEqual({ status: 200, body: { devices: [] } });
  });
});
