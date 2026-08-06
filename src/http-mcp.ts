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
 * OAUTH STUB: claude.ai's connector flow requires OAuth dynamic client
 * registration even for token-authed servers, so we speak just enough OAuth
 * (RFC 8414/9728 metadata, /register, /authorize, /token) to hand back the one
 * static TANDEM_TOKEN as the bearer token. Same security bar as everything
 * else: an authorization code is only issued to a request that already proves
 * knowledge of the token (path prefix, ?token=, or the RFC 8707 `resource`
 * parameter carrying the token-in-path connector URL). Strangers who find the
 * tunnel URL cannot complete the flow.
 *
 * The tool surface (7 tools) is defined once in ./mcp-server.ts and shared with
 * the local stdio transport (src/stdio-server.ts).
 */
import crypto from "node:crypto";
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

function extractTokens(req: http.IncomingMessage, url: URL): string[] {
  const out: string[] = [];
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    out.push(auth.slice(7).trim());
  }
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) out.push(fromQuery);
  const m = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (m && m[2]) out.push(m[1]);
  return out;
}

function segMatchesToken(seg: string, token: string): boolean {
  try {
    return tokenMatches(decodeURIComponent(seg), token);
  } catch {
    return false;
  }
}

function pathHasToken(pathname: string, token: string): boolean {
  return pathname.split("/").some((seg) => seg.length > 0 && segMatchesToken(seg, token));
}

/**
 * Public base URL as the client sees it. cloudflared forwards the original
 * Host and sets x-forwarded-proto; direct localhost hits fall back to http.
 */
function publicBase(req: http.IncomingMessage): string {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost");
  const proto = String(
    req.headers["x-forwarded-proto"] ??
      (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"),
  );
  return `${proto}://${host}`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenResponse(token: string): Record<string, unknown> {
  return {
    access_token: token,
    token_type: "Bearer",
    // The token is static; a long lifetime plus a refresh_token (which is the
    // same secret, so presenting it proves possession) keeps clients happy.
    expires_in: 60 * 60 * 24 * 365,
    refresh_token: token,
    scope: "mcp",
  };
}

interface PendingCode {
  expires: number;
  challenge?: string;
  method: string;
}

export async function startServer(opts: ServerOpts): Promise<void> {
  // One-time OAuth authorization codes, only ever minted by the token-gated
  // /authorize handler. In-memory is fine: codes live 10 minutes and a restart
  // just means the client redoes the (automatic) flow.
  const pendingCodes = new Map<string, PendingCode>();

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

    const base = publicBase(req);

    // OAuth metadata discovery (RFC 8414 authorization-server metadata and
    // RFC 9728 protected-resource metadata, including their path-inserted
    // forms like /.well-known/oauth-protected-resource/<token>/mcp). When the
    // discovery path itself embeds the token — the normal case for a
    // /<token>/mcp connector URL — we advertise token-prefixed endpoints so
    // the rest of the flow keeps carrying it. Metadata reveals nothing
    // sensitive on its own (bare-form endpoints still demand the token).
    if (url.pathname.startsWith("/.well-known/")) {
      const asMatch = url.pathname.match(
        /^\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(\/.*)?$/,
      );
      const prMatch = url.pathname.match(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/);
      if (!asMatch && !prMatch) {
        json(res, 404, { error: "not found" });
        return;
      }
      const suffix = (asMatch ? asMatch[1] : prMatch?.[1]) ?? "";
      const issuer = pathHasToken(suffix, opts.token) ? `${base}/${opts.token}` : base;
      if (asMatch) {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
        });
      } else {
        json(res, 200, {
          resource: suffix ? `${base}${suffix}` : `${base}/mcp`,
          authorization_servers: [issuer],
          bearer_methods_supported: ["header"],
          scopes_supported: ["mcp"],
        });
      }
      return;
    }

    // OAuth endpoints, reachable bare (/authorize) or token-prefixed
    // (/<token>/authorize). `viaPathToken` doubles as proof of possession.
    const seg = url.pathname.match(/^\/([^/]+)(\/.+)$/);
    const viaPathToken = seg !== null && segMatchesToken(seg[1], opts.token);
    const route = viaPathToken && seg ? seg[2] : url.pathname;

    // Dynamic client registration. Unauthenticated by design (claude.ai
    // registers before it has any credential); the response contains no
    // secrets — every client gets a throwaway id and must still pass the
    // token-gated /authorize to obtain anything usable.
    if (route === "/register" && req.method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      json(res, 201, {
        client_id: crypto.randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: typeof body?.client_name === "string" ? body.client_name : "mcp-client",
        redirect_uris: Array.isArray(body?.redirect_uris) ? body.redirect_uris : [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      return;
    }

    // Authorization endpoint: no login UI — but a code is issued ONLY when the
    // request already proves knowledge of TANDEM_TOKEN (path prefix, ?token=,
    // or the RFC 8707 `resource` param carrying the /<token>/mcp connector
    // URL). Anyone else gets 401, exactly like the rest of the server.
    if (route === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      let resourceHasToken = false;
      try {
        resourceHasToken = pathHasToken(new URL(q.get("resource") ?? "").pathname, opts.token);
      } catch {
        // no/invalid resource param — other proofs may still apply
      }
      const presented = q.get("token");
      const authed =
        viaPathToken || (presented !== null && tokenMatches(presented, opts.token)) || resourceHasToken;
      if (!authed) {
        json(res, 401, { error: "unauthorized: missing or invalid token" });
        return;
      }
      let target: URL;
      try {
        target = new URL(q.get("redirect_uri") ?? "");
      } catch {
        json(res, 400, { error: "invalid_request", error_description: "missing or invalid redirect_uri" });
        return;
      }
      const isLocalhost = target.hostname === "localhost" || target.hostname === "127.0.0.1";
      if (target.protocol !== "https:" && !(target.protocol === "http:" && isLocalhost)) {
        json(res, 400, {
          error: "invalid_request",
          error_description: "redirect_uri must be https (or http on localhost)",
        });
        return;
      }
      if ((q.get("response_type") ?? "code") !== "code") {
        target.searchParams.set("error", "unsupported_response_type");
        const state = q.get("state");
        if (state !== null) target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      const code = crypto.randomBytes(32).toString("base64url");
      pendingCodes.set(code, {
        expires: Date.now() + 10 * 60_000,
        challenge: q.get("code_challenge") ?? undefined,
        method: q.get("code_challenge_method") ?? "S256",
      });
      target.searchParams.set("code", code);
      const state = q.get("state");
      if (state !== null) target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    // Token endpoint. Possession of a valid one-time code (issued only by the
    // token-gated /authorize above) or of the token itself (refresh grant) is
    // the credential here.
    if (route === "/token" && req.method === "POST") {
      const form = await readForm(req);
      const now = Date.now();
      for (const [c, v] of pendingCodes) if (v.expires < now) pendingCodes.delete(c);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const pending = pendingCodes.get(form.get("code") ?? "");
        if (!pending) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        pendingCodes.delete(form.get("code") ?? "");
        if (pending.challenge) {
          const verifier = form.get("code_verifier") ?? "";
          const derived =
            pending.method === "plain"
              ? verifier
              : crypto.createHash("sha256").update(verifier).digest("base64url");
          if (!tokenMatches(derived, pending.challenge)) {
            json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
            return;
          }
        }
        json(res, 200, tokenResponse(opts.token));
        return;
      }
      if (grant === "refresh_token") {
        if (!tokenMatches(form.get("refresh_token") ?? "", opts.token)) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        json(res, 200, tokenResponse(opts.token));
        return;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (!extractTokens(req, url).some((t) => tokenMatches(t, opts.token))) {
      res.writeHead(401, {
        "content-type": "application/json",
        // Points OAuth-capable clients (claude.ai connectors) at discovery.
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${
          url.pathname === "/" ? "" : url.pathname
        }"`,
      });
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

/** Read a /token request body: form-urlencoded per spec, JSON tolerated. */
async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
  if (String(req.headers["content-type"] ?? "").includes("application/json")) {
    const params = new URLSearchParams();
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof v === "string") params.set(k, v);
      }
    } catch {
      // fall through with whatever parsed
    }
    return params;
  }
  return new URLSearchParams(raw);
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
