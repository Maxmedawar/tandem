import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { tandemHome } from "../bridge/tandem-home.ts";
import { join } from "node:path";
import { emitCompletion, emitNeedsInput } from "../bridge/events.ts";

const EVENTS_LOG = join(tandemHome(), "events.log");
function lastLineWithId(id: string): any {
  const lines = readFileSync(EVENTS_LOG, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = JSON.parse(lines[i]);
    if (o.id === id) return o;
  }
  throw new Error(`no events.log line with id ${id}`);
}

// emitCompletion has three sinks: events.log (always), webhook (if set), ntfy
// (if topic set). Phase 6c adds a `silent` flag that suppresses ONLY the ntfy
// phone push — used for routine per-task completions so the phone isn't buzzed
// on every step. We verify the gating by spying on global fetch (the ntfy POST).

describe("emitCompletion silent flag — gates ONLY the ntfy phone push", () => {
  const prevTopic = process.env.TANDEM_NTFY_TOPIC;
  const prevHook = process.env.TANDEM_DONE_WEBHOOK;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    process.env.TANDEM_NTFY_TOPIC = "tandem-unit-test-topic";
    delete process.env.TANDEM_DONE_WEBHOOK; // isolate: only ntfy could fetch
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevTopic === undefined) delete process.env.TANDEM_NTFY_TOPIC;
    else process.env.TANDEM_NTFY_TOPIC = prevTopic;
    if (prevHook === undefined) delete process.env.TANDEM_DONE_WEBHOOK;
    else process.env.TANDEM_DONE_WEBHOOK = prevHook;
  });

  const ev = { type: "relay" as const, id: "loopX", cursor: 1, summary: "task done" };

  it("buzzes (POSTs ntfy) when silent is not set", () => {
    emitCompletion(ev);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("tandem-unit-test-topic");
  });

  it("does NOT buzz when silent:true", () => {
    emitCompletion({ ...ev, silent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("events.log line shape (durable record for every transition)", () => {
  it("a silent completion is still logged, and the silent flag is NOT serialized", () => {
    const id = "silent-shape-" + Math.floor(Math.random() * 1e9);
    emitCompletion({ type: "relay", id, cursor: 3, summary: "routine task done", reason: "task done", silent: true });
    const line = lastLineWithId(id);
    expect(Object.hasOwn(line, "silent")).toBe(false); // flag must not leak into the record
    expect(line.status).toBe("done");
    expect(line.event).toBeUndefined(); // a plain completion, not tagged
  });

  it("a needs-input event is tagged event:'needs_input' and carries the question", () => {
    const id = "needs-shape-" + Math.floor(Math.random() * 1e9);
    emitNeedsInput({ type: "relay", id, cursor: 4, summary: "needs your answer", reason: "which DB?" });
    const line = lastLineWithId(id);
    expect(line.event).toBe("needs_input");
    expect(line.reason).toBe("which DB?");
  });
});
