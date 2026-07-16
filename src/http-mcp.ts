/**
 * HTTP MCP server for tandem.
 *
 * Exposes the bridge as a Streamable-HTTP MCP server on localhost; your own
 * cloudflared quick tunnel publishes it to https://<random>.trycloudflare.com
 * for a chat AI (Claude.ai) to connect to. Each tool calls the local router
 * (../bridge/router.ts) in-process — the same proven handlers the original used,
 * minus the Worker tunnel.
 *
 * AUTH: every request must present TANDEM_TOKEN. Accepted as:
 *   - Authorization: Bearer <token>   (preferred)
 *   - ?token=<token>                  (query string)
 *   - /<token>/mcp                    (path prefix, handy for connector configs)
 * Any request without a matching token gets 401 and never reaches a tool.
 *
 * The tool surface (6 tools) is defined once in ./mcp-server.ts and shared with
 * the local stdio transport (src/stdio-server.ts).
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAllowlist } from "../bridge/router.ts";
import { buildMcpServer } from "./mcp-server.ts";
import { ICON_PNG, ICON_MIME } from "./icon.ts";

export interface ServerOpts {
  token: string;
  port: number;
  host: string;
}

/** Length-independent token compare. */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function extractToken(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const m = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (m && m[2]) return m[1];
  return "";
}

export async function startServer(opts: ServerOpts): Promise<void> {
  const allowlist = getAllowlist();
  if (allowlist.length === 0) {
    console.error(
      "⚠  cwd allowlist is empty — open_session/relay will refuse every directory.\n" +
        "   Set TANDEM_CWD_ALLOWLIST to the folders the bridge may work in.",
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);

    // Health check needs no auth and exposes nothing sensitive.
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "tandem" }));
      return;
    }

    // Icon / favicon: served WITHOUT auth (it's a public, non-sensitive asset)
    // so a connector UI that fetches the origin's favicon — like claude.ai — can
    // show the Claude Code crab next to the tandem connector. Cached for a day.
    if (url.pathname === "/favicon.ico" || url.pathname === "/icon.png") {
      res.writeHead(200, {
        "content-type": ICON_MIME,
        "content-length": String(ICON_PNG.length),
        "cache-control": "public, max-age=86400",
      });
      res.end(ICON_PNG);
      return;
    }

    // tandem authenticates with a static TANDEM_TOKEN and runs no OAuth service.
    // Without this, the token gate below answers discovery probes with 401, which
    // reads to a client as "OAuth exists, keep going" and sends it into dynamic
    // client registration. A flat 404 says there is no OAuth here.
    if (url.pathname.startsWith("/.well-known/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found: tandem uses a static bearer token, not OAuth" }));
      return;
    }

    if (!tokenMatches(extractToken(req, url), opts.token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized: missing or invalid token" }));
      return;
    }

    // claude.ai's add-connector flow validates the endpoint with a bare GET
    // probe (no body, Accept: text/html or */*). The MCP streamable-http transport
    // requires GETs to list text/event-stream in Accept and otherwise rejects them
    // with 406, which stalls connector registration. We answer ONLY that exact
    // probe shape — a GET with no request body whose Accept lacks text/event-stream
    // — with a benign 200. Every POST (real JSON-RPC traffic), every GET carrying a
    // body, and any GET that does accept text/event-stream falls straight through to
    // the transport's normal handling, including an honest 406 on a malformed
    // request. This never intercepts real MCP requests.
    const accept = String(req.headers["accept"] ?? "");
    const hasBody =
      "transfer-encoding" in req.headers ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
    if (req.method === "GET" && !hasBody && !accept.includes("text/event-stream")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          name: "tandem",
          transport: "streamable-http",
          hint: "POST JSON-RPC with Accept: application/json, text/event-stream",
        }),
      );
      return;
    }

    // Authenticated. Handle statelessly; session/relay state lives in the engine
    // modules, so it persists across requests regardless.
    const body = await readBody(req);
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  console.error(`tandem MCP bridge listening on http://${opts.host}:${opts.port}  (token required)`);
  console.error(`cwd allowlist: ${allowlist.join(":") || "(empty — set TANDEM_CWD_ALLOWLIST)"}`);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}
