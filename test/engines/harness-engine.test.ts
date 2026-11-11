/**
 * U-R1A-10: one generic engine runs any CLI agent from its harness file. A made-up CLI
 * (test/fixtures/fake-cli.sh), added as one owner harness file, opens, takes input, reports its
 * state and closes through the MCP tools, with no code change (gate A1.6).
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a10-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents
 * run. Cleanup is `tmux -S <that folder>/tmux-<uid>/default kill-server` after `test -S`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-cli.sh", import.meta.url));
const BOX = mkdtempSync("/tmp/r1a10-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, `tmux-${process.getuid!()}`, "default");
const WORK = join(BOX, "work");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");
const SENTINEL = join(BOX, "sentinel");
mkdirSync(WORK);
mkdirSync(OWNER, { recursive: true });
chmodSync(OWNER, 0o700);
// All three are read when the router is imported or the harness files first load.
process.env.TANDEM_HOME = TANDEM_HOME;
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_WAIT_MS = "8000";

/** fake-cli.sh's screens: its prompt, its slow turn, its approval question. Each pattern ends at the end of the screen. */
const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`;
const FILES: Record<string, string> = {
  "fake-rules": `program = "${FAKE}"\nargs = ["two words", "*"]\nhas_prompts = true\n${RULES}`,
  "fake-trust": `program = "${FAKE}"\nargs = ["trust"]\nhas_prompts = true\n${RULES}`,
  "fake-plain": `program = "${FAKE}"\nhas_prompts = false\n`,
  // Prints claude's prompt mark (as its argument) but never its own idle prompt.
  "fake-chevron": `program = "${FAKE}"\nargs = ["\u276F"]\nhas_prompts = true\n[states]\nidle = ['^never idle>\\z']\n`,
  "fake-bash": `program = "bash"\nhas_prompts = false\n`,
  "fake-missing": `program = "${join(BOX, "missing-cli")}"\nhas_prompts = false\n`,
  claude: `program = "${FAKE}"\nhas_prompts = true\n`,
  "bad-key": `program = "${FAKE}"\nhas_prompts = true\n[keys]\napprove = "yes\\n"\n`,
  "bad-args": `program = "${FAKE}"\nargs = ["$(touch ${SENTINEL})"]\nhas_prompts = false\n`,
};
for (const [name, body] of Object.entries(FILES)) {
  writeFileSync(join(OWNER, `${name}.toml`), `name = "${name}"\n${body}`, { mode: 0o600 });
}

const { buildMcpServer } = await import("../../src/mcp-server.ts");
const { dispatchOpenSession } = await import("../../bridge/fleet-dispatch.ts");
const { createFleetRuntime } = await import("../../bridge/fleet-runtime.ts");
const { harnessDescriptor } = await import("../../bridge/engines/harness-engine.ts");
const { loadedHarnesses, resetHarnessCache, resolveEngine } = await import("../../bridge/engine-registry.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pane = (name: string) => tmux("capture-pane", "-p", "-t", `=ccm-${name}:`);
const tmuxHas = (name: string) => {
  try {
    tmux("has-session", "-t", `=ccm-${name}`);
    return true;
  } catch {
    return false;
  }
};

let client: Client;
let server: ReturnType<typeof buildMcpServer>;
let stderrLines: string[] = [];
const runtime = createFleetRuntime({ localEngines: ["claude"] });

beforeAll(async () => {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  resetHarnessCache();
  loadedHarnesses();
  stderrLines = spy.mock.calls.map((c) => String(c[0]));
  spy.mockRestore();
  server = buildMcpServer();
  client = new Client({ name: "r1a10", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
});

afterEach(() => {
  delete process.env.TANDEM_ENABLED_ENGINES;
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a10 cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

/** One MCP tool call: the parsed JSON body, or the error text when the call is refused. */
async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body?: any }> {
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    return r.isError ? { isError: true, text } : { isError: false, text, body: JSON.parse(text) };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e) };
  }
}
const send = (name: string, text = "") => call("send_to_session", { name, text });

/** Polls (empty send) until agentState is `state`; idle is debounced, so it can take a second poll. */
async function pollUntil(name: string, state: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last: any;
  while (Date.now() < deadline) {
    last = (await send(name)).body;
    if (last?.agentState === state) return last;
    await sleep(250);
  }
  throw new Error(`${name}: agentState never became ${state}; last ${JSON.stringify(last)}`);
}

async function engineEnum(): Promise<string[]> {
  const { tools } = await client.listTools();
  const open = tools.find((t) => t.name === "open_session")!;
  return (open.inputSchema.properties?.["engine"] as { enum: string[] }).enum;
}

/** The status from the dispatch the MCP tool runs, and the same error body through the MCP tool. */
async function refused(args: Record<string, unknown>, status: number, message: RegExp) {
  const direct = await dispatchOpenSession(runtime, args as never);
  expect(direct.status).toBe(status);
  expect((direct.body as { error: string }).error).toMatch(message);
  expect((await call("open_session", args)).body).toEqual(direct.body);
}

/** Not in the enum, so the MCP tool refuses it; the dispatch behind it gives 400. */
async function notAnEngine(engine: string) {
  const viaMcp = await call("open_session", { engine, name: "r1a10-none" });
  expect(viaMcp.isError).toBe(true);
  expect(viaMcp.text).toMatch(/engine/);
  const direct = await dispatchOpenSession(runtime, { engine, name: "r1a10-none" });
  expect(direct.status).toBe(400);
  expect((direct.body as { error: string }).error).toMatch(/unknown engine/);
}

describe("harness engine: the descriptor a harness file makes", () => {
  it("argv is /usr/bin/env -- <programPath> then the file's args verbatim, with and without args", () => {
    const h = loadedHarnesses();
    expect(harnessDescriptor(h.get("fake-rules")!).argv).toEqual(["/usr/bin/env", "--", FAKE, "two words", "*"]);
    expect(harnessDescriptor(h.get("fake-plain")!).argv).toEqual(["/usr/bin/env", "--", FAKE]);
  });

  it("idle rules read the screen with debounce_ms; a file without states is markerless at 5000 ms", () => {
    const rules = harnessDescriptor(loadedHarnesses().get("fake-rules")!);
    expect(rules.id).toBe("fake-rules");
    expect(rules.minStableMs).toBe(300);
    expect(rules.isReady!("argc=0\nfake>")).toBe(true);
    expect(rules.isWorking!("argc=0\nfake>")).toBe(false);
    expect(rules.isWorking!("fake> slow\nfake is thinking")).toBe(true);
    const plain = harnessDescriptor(loadedHarnesses().get("fake-plain")!);
    expect(plain.isReady).toBeUndefined();
    expect(plain.isWorking).toBeUndefined();
    expect(plain.minStableMs).toBe(5000);
  });
});

describe("harness engine: refusals", () => {
  it("a loaded harness not named in TANDEM_ENABLED_ENGINES is 403", async () => {
    expect(await engineEnum()).toContain("fake-rules");
    await refused({ engine: "fake-rules", name: "r1a10-off" }, 403, /disabled/);
  });

  it("an unknown engine id is 400", async () => {
    await notAnEngine("r1a10-nope");
  });

  it("an enabled harness whose program is missing is 503", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-missing";
    await refused({ engine: "fake-missing", name: "r1a10-missing" }, 503, /not found/);
  });

  it("a bash program loads as kind shell, stays in the enum, and is 403 without shell enabled", async () => {
    expect(loadedHarnesses().get("fake-bash")?.kind).toBe("shell");
    expect(await engineEnum()).toContain("fake-bash");
    process.env.TANDEM_ENABLED_ENGINES = "fake-bash";
    await refused({ engine: "fake-bash", name: "r1a10-bash" }, 403, /shell/);
  });

  it("model on a harness engine is 400", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-rules";
    await refused({ engine: "fake-rules", name: "r1a10-model", model: "opus" }, 400, /model/);
  });

  it("a harness engine with a non-local device is 400", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-rules";
    await refused({ engine: "fake-rules", name: "r1a10-dev", device: "other" }, 400, /local/);
  });

  it("an owner claude.toml is refused: claude stays on its built-in harness file, once in the enum", async () => {
    expect((await engineEnum()).filter((e) => e === "claude")).toEqual(["claude"]);
    // The tool text names claude once, as a built-in, not again as a loaded harness file.
    const { tools } = await client.listTools();
    const described = (tools.find((t) => t.name === "open_session")!.inputSchema.properties?.["engine"] as { description: string }).description;
    expect(/loaded harness name \(([^)]*)\)/.exec(described)?.[1]?.split(", ")).not.toContain("claude");
    expect(loadedHarnesses().get("claude")?.source).toBe("builtin");
    const resolution = await resolveEngine("claude");
    expect(resolution.harness).toBe(loadedHarnesses().get("claude"));
    expect(resolution.descriptor).toBeUndefined();
    expect(stderrLines.filter((l) => l.includes(join(OWNER, "claude.toml")))).toHaveLength(1);
  });

  it("a text key with a newline and a command in args are refused at load: not in the enum, 400, nothing runs", async () => {
    const engines = await engineEnum();
    for (const bad of ["bad-key", "bad-args"]) {
      expect(engines).not.toContain(bad);
      await notAnEngine(bad);
    }
    expect(stderrLines).toContain(`[bridge] harness file refused: ${join(OWNER, "bad-key.toml")}: bad key in keys.approve\n`);
    expect(stderrLines).toContain(`[bridge] harness file refused: ${join(OWNER, "bad-args.toml")}: forbidden character in args\n`);
    expect(existsSync(SENTINEL)).toBe(false);
  });
});

describe("harness engine: a fake CLI through the MCP tools (private tmux socket)", () => {
  it("rules agent: opens ready with its 2 args, reads idle, working, done, waiting_for_approval, idle, closes", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-rules";
    const name = "r1a10-rules";
    const open = await call("open_session", { engine: "fake-rules", name });
    expect(open.body).toMatchObject({ name, engine: "fake-rules", ready: true });
    expect(pane(name)).toContain("argc=2\narg=[two words]\narg=[*]\n");
    expect(await pollUntil(name, "idle")).toMatchObject({ idle: true, engine: "fake-rules" });

    const hello = await send(name, "hello");
    expect(hello.body).toMatchObject({ status: "done", engine: "fake-rules" });
    expect(hello.body.report).toContain("reply: hello");

    const slow = await send(name, "slow");
    expect(slow.body.status).toBe("running");
    expect((await send(name)).body).toMatchObject({ agentState: "working", idle: false });
    await pollUntil(name, "idle");
    expect(pane(name)).toContain("reply: slow done");

    const ask = await send(name, "ask");
    expect(ask.body.status).toBe("running");
    expect((await send(name)).body).toMatchObject({ agentState: "waiting_for_approval", idle: false });
    const answer = await send(name, "y");
    expect(answer.body.status).toBe("done");
    expect(answer.body.report).toContain("reply: answered y");
    await pollUntil(name, "idle");

    expect((await call("close_session", { name })).body).toMatchObject({ ok: true, engine: "fake-rules" });
    expect(tmuxHas(name)).toBe(false);
  }, 120_000);

  it("plain agent (no states): opens, a send ends quiet, agentState is unknown, closes", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-plain";
    const name = "r1a10-plain";
    expect((await call("open_session", { engine: "fake-plain", name })).body).toMatchObject({ name, engine: "fake-plain", ready: true });
    const hello = await send(name, "hello");
    expect(hello.body.status).toBe("quiet");
    expect(hello.body.report).toContain("reply: hello");
    expect((await send(name)).body).toMatchObject({ agentState: "unknown", engine: "fake-plain" });
    expect((await call("close_session", { name })).body).toMatchObject({ ok: true });
    expect(tmuxHas(name)).toBe(false);
  }, 120_000);

  it("a harness agent showing claude's \u276F but never its own idle rule opens not ready (positive idle only)", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-chevron";
    const name = "r1a10-chevron";
    const open = await call("open_session", { engine: "fake-chevron", name });
    expect(pane(name)).toContain("arg=[\u276F]");
    expect(open.body).toMatchObject({ name, ready: false, warning: expect.stringMatching(/did not reach the prompt/) });
    expect((await call("close_session", { name })).body).toMatchObject({ ok: true });
    expect(tmuxHas(name)).toBe(false);
  }, 60_000);

  it("a harness agent showing 'trust this folder' gets no key at warmup", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-trust";
    const name = "r1a10-trust";
    expect((await call("open_session", { engine: "fake-trust", name })).body).toMatchObject({ name, ready: true });
    await sleep(1500);
    const shown = pane(name);
    expect(shown).toContain("Do you trust this folder?");
    expect(shown).not.toContain("reply:");
    expect(shown.split("\n").filter((l) => l.startsWith("fake>"))).toHaveLength(1);
    expect((await call("close_session", { name })).body).toMatchObject({ ok: true });
    expect(tmuxHas(name)).toBe(false);
  }, 60_000);
});
