import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerLive, unregisterLive, getLive } from "../bridge/sessions.ts";
import { resetHarnessCache } from "../bridge/engine-registry.ts";
import type { DrivableSession, EngineId } from "../bridge/drivable.ts";
import { TerminalSession } from "../bridge/terminal-session.ts";

/**
 * Router engine-awareness tests (binding — Phase 2 correction E). These NEVER
 * touch a real tmux process, engine executable, or network: engine
 * unknown/disabled/hermes-validation paths all return before any side effect,
 * and same/mismatched-engine name-reuse is exercised by seeding a FAKE
 * DrivableSession straight into the shared registry via registerLive() — the
 * exact same registry open_session/send/read/interrupt/close all read from.
 *
 * router.ts's audit() writes to the REAL ~/.tandem/bridge.log as a Phase 1
 * side effect independent of engine selection. Stub the three `node:fs`
 * calls it uses so this file never touches real home state (binding — Phase 2
 * correction G), while every other `node:fs` export (existsSync, statSync,
 * realpathSync, ...) stays real — nothing else in this suite depends on them,
 * but nothing else needs to be faked either.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { routeForTest } = await import("../bridge/router.ts");

/** A PATH folder holding an executable fake `claude` (never run), so claude resolves without the real one. */
const FAKE_BIN = mkdtempSync("/tmp/r1a13-fakebin-");
writeFileSync(join(FAKE_BIN, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
afterAll(() => rmSync(FAKE_BIN, { recursive: true, force: true }));

function fakeSession(engine: EngineId, id: string): DrivableSession {
  return {
    id,
    engine,
    cwd: "/tmp/fake",
    ...{ skipTag: "0" },
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: "done", report: "ok", cursor: 1 }),
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
}

// MUST `await run()` (not `return run()`) — handleOpen's engine resolution is
// itself async and typically suspends past at least one microtask (e.g.
// resolveEngine's success path, or handleOpenHermes's config lookup running
// only after that await resumes). A non-awaited return would let this
// function's `finally` restore the env vars WHILE the routed call is still
// in flight, so code deeper in the chain would read the ORIGINAL env instead
// of the value this helper is meant to inject.
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const opened: string[] = [];
afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
});

describe("POST /sessions/open — engine resolution happens before any side effect", () => {
  it("400s on an unknown engine id", async () => {
    const res = await routeForTest("POST", "/sessions/open", { name: "x1", engine: "not-a-real-engine" });
    expect(res.status).toBe(400);
  });

  it("403s on a known but disabled engine (codex, unset TANDEM_ENABLED_ENGINES)", async () => {
    await withEnv({ TANDEM_ENABLED_ENGINES: undefined }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name: "x2", engine: "codex" });
      expect(res.status).toBe(403);
    });
  });
});

describe("POST /sessions/open — hermes: rejects cwd/model/effort, requires config + allowlist", () => {
  it("400s when cwd is supplied for engine=hermes", async () => {
    await withEnv({ TANDEM_ENABLED_ENGINES: "hermes" }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name: "agent-x", engine: "hermes", cwd: "/tmp" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/cwd/);
    });
  });

  it("400s when model is supplied for engine=hermes", async () => {
    await withEnv({ TANDEM_ENABLED_ENGINES: "hermes" }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name: "agent-x", engine: "hermes", model: "opus" });
      expect(res.status).toBe(400);
    });
  });

  it("400s when effort is supplied for engine=hermes", async () => {
    await withEnv({ TANDEM_ENABLED_ENGINES: "hermes" }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name: "agent-x", engine: "hermes", effort: "high" });
      expect(res.status).toBe(400);
    });
  });

  it("503s when hermes is enabled but TANDEM_HERMES_BASE_URL is unset", async () => {
    await withEnv({ TANDEM_ENABLED_ENGINES: "hermes", TANDEM_HERMES_BASE_URL: undefined }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name: "agent-x", engine: "hermes" });
      expect(res.status).toBe(503);
    });
  });

  it("403s when hermes is configured but the agent id is not on the writable allowlist", async () => {
    await withEnv(
      {
        TANDEM_ENABLED_ENGINES: "hermes",
        TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999",
        TANDEM_HERMES_WRITABLE_AGENTS: "some-other-agent",
      },
      async () => {
        const res = await routeForTest("POST", "/sessions/open", { name: "agent-x", engine: "hermes" });
        expect(res.status).toBe(403);
      },
    );
  });
});

describe("POST /sessions/open — engine-mismatch on name reuse is a 409, checked before any spawn", () => {
  it("409s when the same name is already live under a different engine", async () => {
    const name = "dup-engine-name";
    registerLive(fakeSession("claude", name));
    opened.push(name);
    await withEnv({ TANDEM_ENABLED_ENGINES: "shell" }, async () => {
      const res = await routeForTest("POST", "/sessions/open", { name, engine: "shell" });
      expect(res.status).toBe(409);
    });
  });

  it("reuses (200, reused:true) when the same name is requested with the SAME engine", async () => {
    const name = "reuse-me";
    registerLive(fakeSession("claude", name));
    opened.push(name);
    resetHarnessCache();
    const res = await withEnv({ TANDEM_ENABLED_ENGINES: "claude", PATH: `${FAKE_BIN}:/usr/bin:/bin` }, () =>
      routeForTest("POST", "/sessions/open", { name, engine: "claude" }),
    );
    resetHarnessCache();
    expect(res.status).toBe(200);
    expect((res.body as { reused?: boolean }).reused).toBe(true);
    expect((res.body as { engine?: string }).engine).toBe("claude");
  });

  it("409s instead of letting Hermes shadow a live tmux session after restart", async () => {
    const exists = vi.spyOn(TerminalSession, "exists").mockResolvedValue(true);
    const tag = vi.spyOn(TerminalSession, "engineTagOf").mockResolvedValue("claude");
    try {
      await withEnv(
        {
          TANDEM_ENABLED_ENGINES: "hermes",
          TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999",
          TANDEM_HERMES_WRITABLE_AGENTS: "survivor",
        },
        async () => {
          const res = await routeForTest("POST", "/sessions/open", {
            name: "survivor",
            engine: "hermes",
          });
          expect(res.status).toBe(409);
          expect(JSON.stringify(res.body)).toMatch(/claude/);
        },
      );
    } finally {
      exists.mockRestore();
      tag.mockRestore();
    }
  });
});

describe("send/read/interrupt/close — engine-agnostic dispatch, engine surfaced in responses", () => {
  it("send() 400s when model/effort is given for a non-claude live session", async () => {
    const name = "hermes-live";
    registerLive(fakeSession("hermes", name));
    opened.push(name);
    const res = await routeForTest("POST", `/sessions/${name}/send`, { text: "hi", model: "opus" });
    expect(res.status).toBe(400);
  });

  it("send() succeeds and echoes engine for a non-claude live session with no model/effort", async () => {
    const name = "hermes-live-2";
    registerLive(fakeSession("hermes", name));
    opened.push(name);
    const res = await routeForTest("POST", `/sessions/${name}/send`, { text: "hi" });
    expect(res.status).toBe(200);
    expect((res.body as { engine?: string }).engine).toBe("hermes");
  });

  it("read()/interrupt()/close() all surface the session's engine", async () => {
    const name = "codex-live";
    registerLive(fakeSession("codex", name));
    opened.push(name);
    const read = await routeForTest("GET", `/sessions/${name}/read`);
    expect((read.body as { engine?: string }).engine).toBe("codex");
    const interrupt = await routeForTest("POST", `/sessions/${name}/interrupt`);
    expect((interrupt.body as { engine?: string }).engine).toBe("codex");
    const close = await routeForTest("POST", `/sessions/${name}/close`);
    expect((close.body as { engine?: string }).engine).toBe("codex");
    expect(getLive(name)).toBeUndefined();
    opened.pop(); // close() already unregistered it
  });
});
