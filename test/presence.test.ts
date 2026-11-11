/**
 * U-R1A-29: who is up on this computer (bridge/presence.ts) and the tool who_is_up on the local
 * MCP server. Each row is a session Tandem runs here with its agent, folder, state and the age of
 * that reading; it reads screens, types nothing, and no screen text leaves it.
 *
 * Every folder this file makes is a mkdtemp folder named /tmp/r1a29-, removed in afterAll. tmux
 * runs only on a private socket: before any tmux call TMUX_TMPDIR is that folder and TMUX is
 * unset, so nothing here reaches the default server. Cleanup is `tmux -S <sock> kill-server`
 * after `test -S`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL("..", import.meta.url));
const FAKE = fileURLToPath(new URL("fixtures/fake-cli.sh", import.meta.url));
const BOXES: string[] = [];
const removeBoxes = () => { for (const box of BOXES.splice(0)) rmSync(box, { recursive: true, force: true }); };
/** A step before afterAll is registered: if it fails (a missing module, a bad write) the folders
 *  made so far are removed and the error is rethrown, since a file that fails to load runs no hook. */
async function guarded<T>(step: () => T | Promise<T>): Promise<T> {
  try { return await step(); } catch (error) { removeBoxes(); throw error; }
}
const box = () => { const dir = mkdtempSync("/tmp/r1a29-"); BOXES.push(dir); return dir; };
const BOX = box();
const STDIO_BOX = await guarded(box);
const SOCK = join(BOX, "tandem", "tmux", "tandem"); // U-R1A-19: Tandem's own socket under TANDEM_HOME
const WORK = join(BOX, "work");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");

/** fake-cli.sh's screens: its prompt, its slow turn, its approval question. */
const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`;

const [
  { createPresence, HEARTBEAT_MS }, { buildMcpServer }, { loadedHarnesses, resetHarnessCache }, { applyLimits }, { agentEntry, writeLimits }, { routeForTest },
] = await guarded(async () => {
  process.env.TMUX_TMPDIR = BOX;
  delete process.env.TMUX;
  mkdirSync(WORK);
  mkdirSync(OWNER, { recursive: true });
  chmodSync(OWNER, 0o700);
  process.env.TANDEM_HOME = TANDEM_HOME;
  process.env.CCM_CWD_ALLOWLIST = WORK;
  process.env.TANDEM_WAIT_MS = "3000";
  process.env.TANDEM_HUB_LINK_ID = "r1a29-box";
  writeFileSync(join(OWNER, "fake-rules.toml"), `name = "fake-rules"\nprogram = "${FAKE}"\nhas_prompts = true\n${RULES}`, { mode: 0o600 });
  return [
    await import("../bridge/presence.ts"),
    await import("../src/mcp-server.ts"),
    await import("../bridge/engine-registry.ts"),
    await import("../bridge/limits.ts"),
    await import("./fixtures/limits.ts"),
    await import("../bridge/router.ts"),
  ] as const;
});

afterAll(() => {
  try {
    const out = execFileSync(
      "/bin/sh",
      ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`r1a29 cleanup: ${out.trim()}`);
  } finally {
    removeBoxes();
  }
});

const T = 1_800_000_000_000;
const SESSION_TOOLS = ["open_session", "list_sessions", "send_to_session", "interrupt_session", "close_session", "relay", "list_devices"];
const ROW_KEYS = ["name", "engine", "project", "cwd", "state", "stateAt", "ageMs"];

/** A row of listSessions for `name` (the fields presence reads, plus an attach hint it must drop). */
const info = (name: string) => ({
  id: name, engine: "fake-rules", project: "work", cwd: "/tmp/r1a29-x/work", live: true, updatedAt: T, attachHint: `tmux attach -t '=ccm-${name}'`,
}) as Json;
/** A live session whose inputState answers `state` with `screen`. */
const reads = (state: string, screen = "fake>") => ({ inputState: async () => ({ state, screen, debounceMs: 0 }) });

/** A presence on a clock the test moves, counting list and inputState calls. */
function rig(live: Record<string, object | undefined>) {
  const clock = { t: T };
  const counts = { list: 0, input: 0 };
  const counted = Object.fromEntries(Object.entries(live).map(([name, s]) => {
    if (!s || typeof (s as Json).inputState !== "function") return [name, s];
    const inner = (s as Json).inputState;
    return [name, { inputState: () => { counts.input++; return inner(); } }];
  }));
  const presence = createPresence({
    now: () => clock.t,
    list: async () => { counts.list++; return Object.keys(live).map(info); },
    live: (name: string) => counted[name],
    computer: "r1a29-box",
  });
  return { clock, counts, presence };
}

describe("(a) one row per session, with its state", () => {
  it("six sessions in name order: working, idle, waiting_for_approval, unknown, no inputState and a throwing read are unknown", async () => {
    const { presence } = rig({
      "s-f-throws": { inputState: async () => { throw new Error("no screen"); } },
      "s-a-working": reads("working"),
      "s-e-plain": {},
      "s-c-waiting": reads("waiting_for_approval"),
      "s-b-idle": reads("idle"),
      "s-d-unknown": reads("unknown"),
    });
    const answer = await presence.whoIsUp();
    expect(answer).toEqual({ computer: "r1a29-box", at: T, ageMs: 0, sessions: expect.any(Array) });
    expect(answer.sessions.map((r: Json) => [r.name, r.state])).toEqual([
      ["s-a-working", "working"],
      ["s-b-idle", "idle"],
      ["s-c-waiting", "waiting_for_approval"],
      ["s-d-unknown", "unknown"],
      ["s-e-plain", "unknown"],
      ["s-f-throws", "unknown"],
    ]);
    for (const row of answer.sessions) {
      expect(Object.keys(row)).toEqual(ROW_KEYS);
      expect(row).toMatchObject({ engine: "fake-rules", project: "work", cwd: "/tmp/r1a29-x/work", stateAt: T, ageMs: 0 });
    }
  });

  it("a read that never answers is unknown within 2,500 ms; a session not live is unknown without a read", async () => {
    const { presence } = rig({ "s-hang": { inputState: () => new Promise(() => {}) }, "s-gone": undefined, "s-ok": reads("idle") });
    const start = Date.now();
    const answer = await presence.whoIsUp();
    expect(Date.now() - start).toBeLessThan(2500);
    expect(answer.sessions.map((r: Json) => [r.name, r.state])).toEqual([["s-gone", "unknown"], ["s-hang", "unknown"], ["s-ok", "idle"]]);
  });
});

describe("(b) heartbeat", () => {
  it("a reading under HEARTBEAT_MS is answered again; at HEARTBEAT_MS, or with refresh, it reads; calls at once share one reading", async () => {
    expect(HEARTBEAT_MS).toBe(10_000);
    const { clock, counts, presence } = rig({ "s-a": reads("idle"), "s-b": reads("working") });
    const first = await presence.whoIsUp();
    expect(counts).toEqual({ list: 1, input: 2 });

    clock.t = T + 9_999;
    const again = await presence.whoIsUp();
    expect(counts).toEqual({ list: 1, input: 2 });
    expect(again).toEqual({ ...first, ageMs: 9_999, sessions: first.sessions.map((r: Json) => ({ ...r, ageMs: 9_999 })) });

    clock.t = T + 10_000;
    const fresh = await presence.whoIsUp();
    expect(counts).toEqual({ list: 2, input: 4 });
    expect(fresh).toMatchObject({ at: T + 10_000, ageMs: 0 });

    clock.t = T + 10_001;
    expect(await presence.whoIsUp({ refresh: true })).toMatchObject({ at: T + 10_001, ageMs: 0 });
    expect(counts).toEqual({ list: 3, input: 6 });

    const pair = await Promise.all([presence.whoIsUp({ refresh: true }), presence.whoIsUp({ refresh: true })]);
    expect(counts).toEqual({ list: 4, input: 8 });
    expect(pair[0]).toEqual(pair[1]);

    clock.t = T + 30_000;
    await Promise.all([presence.whoIsUp(), presence.whoIsUp()]);
    expect(counts).toEqual({ list: 5, input: 10 });
  });
});

describe("(c) no terminal text", () => {
  it("screens holding a secret and a home path never reach the answer", async () => {
    const home = userInfo().homedir;
    const screen = `SECRET-r1a29\n${home}/project\nfake>`;
    const { presence } = rig({ "s-a": reads("idle", screen), "s-b": reads("working", screen), "s-c": { inputState: async () => { throw new Error(`SECRET-r1a29 ${home}`); } } });
    const text = JSON.stringify(await presence.whoIsUp({ refresh: true }));
    expect(text).not.toContain("SECRET-r1a29");
    expect(text).not.toContain(home);
    expect(text).not.toContain("attach");
  });
});

describe("(d) the MCP tool", () => {
  async function connect(presence?: Json) {
    const server = await buildMcpServer(undefined, undefined, undefined, presence);
    const client = new Client({ name: "r1a29", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();

  it("without a presence the same 7 tools; with one, those plus who_is_up, whose answer has the shape", async () => {
    const plain = await connect();
    expect(await names(plain.client)).toEqual([...SESSION_TOOLS].sort());
    await plain.close();

    const { presence } = rig({ "s-a": reads("idle") });
    const m = await connect(presence);
    expect(await names(m.client)).toEqual([...SESSION_TOOLS, "who_is_up"].sort());
    const tool = (await m.client.listTools()).tools.find((t) => t.name === "who_is_up")!;
    expect(tool.description).toMatch(/read-only/i);
    expect(tool.description).toContain("no terminal text is returned");
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["refresh"]);
    const result = await m.client.callTool({ name: "who_is_up", arguments: { refresh: true } });
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    expect(body).toEqual({
      computer: "r1a29-box", at: T, ageMs: 0,
      sessions: [{ name: "s-a", engine: "fake-rules", project: "work", cwd: "/tmp/r1a29-x/work", state: "idle", stateAt: T, ageMs: 0 }],
    });
    await m.close();
  });
});

describe("(e) a real session on a private tmux socket", () => {
  beforeAll(() => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    loadedHarnesses();
    spy.mockRestore();
    writeLimits(TANDEM_HOME, { folders: [WORK], agents: { "fake-rules": agentEntry(loadedHarnesses().get("fake-rules")!) } });
    applyLimits();
    process.env.TANDEM_ENABLED_ENGINES = "fake-rules";
  });
  afterAll(() => {
    delete process.env.TANDEM_ENABLED_ENGINES;
  });

  it("opens idle, an owner send of ask reads waiting_for_approval on refresh, closed is gone; no screen text in any row", async () => {
    const name = "r1a29-rules";
    const presence = createPresence();
    const seen: string[] = [];
    const row = async () => {
      const answer = await presence.whoIsUp({ refresh: true });
      seen.push(JSON.stringify(answer));
      expect(answer.computer).toBe("r1a29-box");
      return answer.sessions.find((r: Json) => r.name === name);
    };
    const until = async (state: string) => {
      const deadline = Date.now() + 15_000;
      let last: Json;
      while (Date.now() < deadline) {
        last = await row();
        if (last?.state === state) return last;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`${name}: never ${state}; last ${JSON.stringify(last)}`);
    };

    const open = await routeForTest("POST", "/sessions/open", { engine: "fake-rules", name, cwd: WORK });
    expect(open.body).toMatchObject({ name, ready: true });
    expect(await until("idle")).toMatchObject({ name, engine: "fake-rules", state: "idle", ageMs: 0 });

    await routeForTest("POST", `/sessions/${name}/send`, { text: "ask" });
    expect(await until("waiting_for_approval")).toMatchObject({ name, state: "waiting_for_approval" });

    expect((await routeForTest("POST", `/sessions/${name}/close`)).body).toMatchObject({ ok: true });
    expect(await row()).toBeUndefined();
    for (const text of seen) {
      expect(text).not.toContain("fake>");
      expect(text).not.toContain("reply:");
    }
  }, 90_000);
});

describe("(f) src/stdio-server.ts as its own process", () => {
  it("lists who_is_up and answers no sessions for computer r1a29-box", async () => {
    const home = join(STDIO_BOX, "home");
    mkdirSync(home, { recursive: true });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key === "TMUX" || key === "TMUX_PANE" || key.startsWith("TANDEM_") || key.startsWith("CCM_")) continue;
      env[key] = value;
    }
    Object.assign(env, { HOME: home, TMUX_TMPDIR: STDIO_BOX, TANDEM_CWD_ALLOWLIST: STDIO_BOX, TANDEM_HUB_LINK_ID: "r1a29-box" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--experimental-strip-types", "src/stdio-server.ts"], cwd: repo, stderr: "pipe", env,
    });
    const client = new Client({ name: "r1a29-stdio", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("who_is_up");
      const result = await client.callTool({ name: "who_is_up", arguments: {} });
      const body = JSON.parse((result.content as { text: string }[])[0].text);
      expect(body).toEqual({ computer: "r1a29-box", at: expect.any(Number), ageMs: expect.any(Number), sessions: [] });
    } finally {
      await client.close();
    }
  }, 60_000);
});
