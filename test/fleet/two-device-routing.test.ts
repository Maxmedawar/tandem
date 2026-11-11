/**
 * Proves the spec's Phase 3 acceptance target: "the hub can list and route to
 * at least two simultaneously connected devices" with "exact routing across
 * two simulated devices" — driven over REAL loopback WebSocket connections
 * against the real private fleet listener (loopback ephemeral WebSocket
 * integration tests are allowed — binding — Phase 3 correction 14).
 *
 * Each "device" here is a raw `ws` client that answers every request frame
 * with a canned, device-identifiable response — this isolates HUB-SIDE
 * routing correctness (does the right request reach the right device, and
 * does the right reply come back correctly rewritten) from a single device's
 * OWN local execution correctness, which is already covered independently by
 * test/fleet/device-router.test.ts and test/fleet/device-client.test.ts. Two
 * real device processes cannot share one bridge/router.ts module singleton
 * within a single test process, so this is the correct place to draw that line.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createFleetRuntime } from "../../bridge/fleet-runtime.ts";
import { startPrivateFleetServer, type PrivateServerHandle } from "../../bridge/fleet-private-server.ts";
import { encodeRegisterFrame, encodeResponseFrame, generateNonce, parseFrame } from "../../bridge/fleet-protocol.ts";
import { dispatchListDevices, dispatchOpenSession, dispatchSessionOp, dispatchListSessions } from "../../bridge/fleet-dispatch.ts";

const FLEET_TOKEN = "two-device-test-fleet-token-0123456789";

let handle: PrivateServerHandle | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await handle?.close();
  handle = undefined;
});

function waitFor(ws: WebSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => ws.once(event, resolve));
}

/** Connects a raw synthetic "device" that answers every request with a
 *  canned body identifying itself, tagged by the incoming op/sessionId. */
async function connectSyntheticDevice(port: number, deviceId: string, name: string, engines: string[]): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
  sockets.push(ws);
  await waitFor(ws, "open");
  ws.send(encodeRegisterFrame(deviceId, name, engines as never, generateNonce()));
  await new Promise((resolve) => ws.once("message", resolve)); // register_ack

  ws.on("message", (data) => {
    const frame = parseFrame(data as Buffer);
    if (frame.type !== "request") return;
    const payload = frame.payload as { name?: string; sessionId?: string };
    const body =
      frame.op === "open_session"
        ? { name: payload.name ?? "auto", engine: "claude", cwd: "/synthetic", from: deviceId }
        : frame.op === "list_sessions"
          ? { sessions: [{ id: "existing-session", engine: "claude" }] }
          : { name: payload.sessionId, engine: "claude", from: deviceId, op: frame.op };
    ws.send(encodeResponseFrame(frame.id, true, 200, body));
  });

  return ws;
}

describe("two-device routing (spec: exact routing across two simulated devices)", () => {
  it("list_devices reflects both devices with the exact public shape", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    await connectSyntheticDevice(handle.port, "device-alpha", "alpha-studio", ["claude"]);
    await connectSyntheticDevice(handle.port, "device-beta", "beta-laptop", ["claude", "codex"]);

    const result = dispatchListDevices(runtime);
    expect(result.status).toBe(200);
    const devices = (result.body as { devices: unknown[] }).devices;
    expect(devices).toEqual(
      expect.arrayContaining([
        { id: "local", name: "local", online: true, engines: [] }, // no agent is on by default
        { id: "device-alpha", name: "alpha-studio", online: true, engines: ["claude"] },
        { id: "device-beta", name: "beta-laptop", online: true, engines: ["claude", "codex"] },
      ]),
    );
    expect(devices).toHaveLength(3);
  });

  it("open_session with an explicit device routes to EXACTLY that device, never the other", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    await connectSyntheticDevice(handle.port, "device-alpha", "alpha-studio", ["claude"]);
    await connectSyntheticDevice(handle.port, "device-beta", "beta-laptop", ["claude"]);

    const resultAlpha = await dispatchOpenSession(runtime, { name: "task-1", engine: "claude", device: "device-alpha" });
    expect(resultAlpha.body).toMatchObject({ name: "device-alpha:task-1", device: "device-alpha", from: "device-alpha" });

    const resultBeta = await dispatchOpenSession(runtime, { name: "task-1", engine: "claude", device: "device-beta" });
    expect(resultBeta.body).toMatchObject({ name: "device-beta:task-1", device: "device-beta", from: "device-beta" });
  });

  it("send/read/interrupt/close on a composite name route to the device it names, not the other", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    await connectSyntheticDevice(handle.port, "device-alpha", "alpha-studio", ["claude"]);
    await connectSyntheticDevice(handle.port, "device-beta", "beta-laptop", ["claude"]);

    const send = await dispatchSessionOp(runtime, "send", "device-beta:some-session", undefined, { text: "hi" });
    expect(send.body).toMatchObject({ name: "device-beta:some-session", from: "device-beta", op: "send" });

    const read = await dispatchSessionOp(runtime, "read", "device-alpha:some-session", undefined, {});
    expect(read.body).toMatchObject({ name: "device-alpha:some-session", from: "device-alpha", op: "read" });
  });

  it("list_sessions targeting one device rewrites only that device's session ids", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    await connectSyntheticDevice(handle.port, "device-alpha", "alpha-studio", ["claude"]);
    await connectSyntheticDevice(handle.port, "device-beta", "beta-laptop", ["claude"]);

    const result = await dispatchListSessions(runtime, "device-beta", {});
    expect(result.body).toEqual({
      sessions: [{ id: "device-beta:existing-session", engine: "claude", device: "device-beta", localName: "existing-session" }],
    });
  });

  it("routing never drifts when a THIRD device joins mid-session — the already-open composite name still routes to its original device", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    await connectSyntheticDevice(handle.port, "device-alpha", "alpha-studio", ["claude"]);

    const opened = await dispatchOpenSession(runtime, { name: "durable", engine: "claude", device: "device-alpha" });
    expect(opened.body).toMatchObject({ name: "device-alpha:durable" });

    // A third device joins the fleet after the session was opened.
    await connectSyntheticDevice(handle.port, "device-gamma", "gamma-desktop", ["claude"]);

    const followUp = await dispatchSessionOp(runtime, "send", "device-alpha:durable", undefined, { text: "still here?" });
    expect(followUp.body).toMatchObject({ from: "device-alpha" });
  });
});
