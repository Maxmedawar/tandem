import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.ts";
import { resetHarnessCache } from "../bridge/engine-registry.ts";

// The session listing is stubbed (as in test/router-filter-audit.test.ts): claude, shell and
// codex rows, sliced to the limit like the real one; no tmux.
const ROWS = vi.hoisted(() => [
  { id: "c1", engine: "claude" },
  { id: "s1", engine: "shell" },
  { id: "x1", engine: "codex" },
  { id: "s2", engine: "shell" },
]);
vi.mock("../bridge/sessions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/sessions.ts")>()),
  listSessions: async (opts: { limit?: number } = {}) => ({ sessions: ROWS.slice(0, opts.limit ?? 20) }),
}));

// Owner harness files load from $TANDEM_HOME/harnesses: an empty home here, so only the
// harness test below adds an engine name.
const TANDEM_HOME = mkdtempSync(join(tmpdir(), "r1a10-mcp-"));
process.env.TANDEM_HOME = TANDEM_HOME;
beforeEach(() => resetHarnessCache());
afterAll(() => {
  resetHarnessCache();
  rmSync(TANDEM_HOME, { recursive: true, force: true });
});

async function engineEnum(): Promise<string[] | undefined> {
  const server = await buildMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const open = tools.find((t) => t.name === "open_session");
  return ((open?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.["engine"])?.enum;
}

// The ONE tool surface shared by both transports (HTTP and stdio). If either
// transport's view of the tools drifts, this locks it down.
const EXPECTED_TOOLS = [
  "open_session",
  "list_sessions",
  "send_to_session",
  "interrupt_session",
  "close_session",
  "relay",
  // Phase 3: list_devices is always registered (returns an empty device list
  // when no fleet runtime is supplied — see test/fleet/mcp-schema.test.ts).
  "list_devices",
];

describe("buildMcpServer (shared tool surface)", () => {
  it("registers exactly the 7 tools (6 consolidated + Phase 3 list_devices)", async () => {
    const server = await buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    await client.close();
    await server.close();
  });

  // Phase 2: open_session gained an optional `engine` field without changing
  // the tool count/names above (binding — Phase 2 outline: "do not change the
  // number or names of MCP tools").
  it("open_session exposes an optional engine enum: claude|codex|shell|hermes", async () => {
    const server = await buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const openSession = tools.find((t) => t.name === "open_session");
    expect(openSession).toBeDefined();
    const props = (openSession!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const engineProp = props["engine"] as { enum?: string[] } | undefined;
    expect(engineProp?.enum?.slice().sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "shell"]);

    // engine must not be required (defaults to claude).
    const required = (openSession!.inputSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain("engine");

    await client.close();
    await server.close();
  });

  it("open_session's engine enum adds the name of each loaded harness file", async () => {
    const owner = join(TANDEM_HOME, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "r1a10-agent.toml"), 'name = "r1a10-agent"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    try {
      resetHarnessCache();
      expect((await engineEnum())?.slice().sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "r1a10-agent", "shell"]);
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
    resetHarnessCache();
    expect((await engineEnum())?.slice().sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "shell"]);
  });

  it("local list_sessions takes engine: 'shell' and returns only shell rows", async () => {
    const server = await buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "list_sessions", arguments: { engine: "shell" } });
      const text = (result.content as { type: string; text: string }[])[0].text;
      const rows = (JSON.parse(text) as { sessions: { id: string; engine: string }[] }).sessions;
      expect(rows.map((row) => row.id)).toEqual(["s1", "s2"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
