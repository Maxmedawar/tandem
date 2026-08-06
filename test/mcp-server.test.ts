import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.ts";

// The ONE tool surface shared by both transports (HTTP and stdio). If either
// transport's view of the tools drifts, this locks it down.
const EXPECTED_TOOLS = [
  "open_session",
  "list_sessions",
  "send_to_session",
  "interrupt_session",
  "close_session",
  "relay",
  "completions",
];

describe("buildMcpServer (shared tool surface)", () => {
  it("registers exactly the 7 consolidated tools", async () => {
    const server = buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    await client.close();
    await server.close();
  });
});
