import http from "node:http";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAllowlist } from "../bridge/router.ts";
import type { FleetRuntime } from "../bridge/fleet-runtime.ts";
import type { LocalFabricHost } from "../bridge/fabric/local-fabric-host.ts";
import type { FabricForward } from "../bridge/hub-rpc.ts";
import { buildMcpServer } from "./mcp-server.ts";
import { ICON_MIME, ICON_PNG } from "./icon.ts";
import type { OAuthConfig } from "./auth-config.ts";
import { OAuthStateStore } from "./oauth-state.ts";
import { TandemOAuthProvider } from "./oauth-provider.ts";

const OAUTH_BODY_LIMIT = 16 * 1024;
const MCP_BODY_LIMIT = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface PublicOAuthServerOptions {
  host: string;
  port: number;
  config: OAuthConfig;
  fleet?: FleetRuntime;
  /** The process's fabric store (src/server.ts opens it), or its hub forwarder; with either the fabric tools are listed. */
  fabric?: LocalFabricHost | FabricForward;
  state?: OAuthStateStore;
}

export interface PublicOAuthServerHandle {
  readonly port: number;
  readonly state: OAuthStateStore;
  close(): Promise<void>;
}

export function assertPublicHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("public MCP listener must bind to an exact loopback host");
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("public MCP port must be an integer from 0 to 65535");
  }
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()");
  next();
}

function isOAuthPath(pathname: string): boolean {
  return pathname === "/authorize" || pathname === "/authorize/decision" || pathname === "/token" ||
    pathname === "/register" || pathname === "/revoke" || pathname.startsWith("/.well-known/oauth-");
}

function noStoreOAuth(req: Request, res: Response, next: NextFunction): void {
  if (isOAuthPath(req.path)) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  next();
}

function enforceBodyPolicy(limit: number, expected: "json" | "form") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const encoding = req.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      res.status(415).json({ error: "unsupported_content_encoding" });
      return;
    }
    const rawLength = req.get("content-length");
    if (rawLength) {
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length) || length < 0) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      if (length > limit) {
        res.setHeader("Connection", "close");
        res.status(413).json({ error: "request_too_large" });
        return;
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const contentType = req.get("content-type")?.toLowerCase() ?? "";
      const valid = expected === "json"
        ? contentType.startsWith("application/json")
        : contentType.startsWith("application/x-www-form-urlencoded");
      if (!valid) {
        res.status(415).json({ error: "unsupported_media_type" });
        return;
      }
    }
    next();
  };
}

const parserErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!error) {
    next();
    return;
  }
  const status = (error as { status?: number }).status === 413 ? 413 : 400;
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: status === 413 ? "request_too_large" : "invalid_request" });
};

function globalRateLimit(windowMs: number, max: number) {
  return {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "tandem-owner",
    message: { error: "rate_limit_exceeded" },
  };
}

function authorizationMetadata(config: OAuthConfig): Record<string, unknown> {
  const base = config.issuerUrl;
  return {
    issuer: base.href,
    authorization_endpoint: new URL("/authorize", base).href,
    token_endpoint: new URL("/token", base).href,
    registration_endpoint: new URL("/register", base).href,
    revocation_endpoint: new URL("/revoke", base).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

export async function createOAuthApp(options: PublicOAuthServerOptions): Promise<{
  app: express.Express;
  state: OAuthStateStore;
}> {
  assertPublicHost(options.host);
  validatePort(options.port);
  const state = options.state ?? await OAuthStateStore.open({
    directory: options.config.stateDir,
    bootstrapPassword: options.config.ownerPassword,
    accessTtlSeconds: options.config.accessTtlSeconds,
    refreshTtlSeconds: options.config.refreshTtlSeconds,
  });
  const provider = new TandemOAuthProvider({
    state,
    publicUrl: options.config.publicUrl,
    canonicalOrigin: options.config.publicUrl.origin,
  });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(securityHeaders);
  app.use(noStoreOAuth);

  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, name: "tandem" });
  });
  app.get(["/favicon.ico", "/icon.png"], (_req, res) => {
    res.setHeader("Content-Type", ICON_MIME);
    res.setHeader("Content-Length", String(ICON_PNG.length));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(ICON_PNG);
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authorizationMetadata(options.config)));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json({
    resource: options.config.publicUrl.href,
    authorization_servers: [options.config.issuerUrl.href],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "Tandem",
  }));

  app.use("/register", enforceBodyPolicy(OAUTH_BODY_LIMIT, "json"), express.json({ limit: OAUTH_BODY_LIMIT, strict: true }));
  app.use(["/token", "/revoke", "/authorize/decision"], enforceBodyPolicy(OAUTH_BODY_LIMIT, "form"), express.urlencoded({ limit: OAUTH_BODY_LIMIT, extended: false, parameterLimit: 24 }));
  app.post("/authorize", enforceBodyPolicy(OAUTH_BODY_LIMIT, "form"), express.urlencoded({ limit: OAUTH_BODY_LIMIT, extended: false, parameterLimit: 24 }));
  app.use(parserErrorHandler);

  // The SDK intentionally relaxes only loopback redirect ports for native
  // clients. Tandem's smaller trust model requires exact registered equality.
  // Preflight phase-one authorization inputs with a uniform direct error so an
  // invalid client id and an invalid redirect are not distinguishable here.
  app.all("/authorize", async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") {
      next();
      return;
    }
    const source = req.method === "POST" ? req.body as Record<string, unknown> : req.query;
    const clientId = typeof source.client_id === "string" ? source.client_id : "";
    const requestedRedirect = typeof source.redirect_uri === "string" ? source.redirect_uri : undefined;
    const client = await provider.clientsStore.getClient(clientId);
    const resolvedRedirect = requestedRedirect ?? (client?.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!client || !resolvedRedirect || !client.redirect_uris.includes(resolvedRedirect)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    next();
  });

  app.post(
    "/authorize/decision",
    rateLimit(globalRateLimit(15 * 60_000, 30)),
    async (req, res, next) => {
      try {
        const body = req.body as Record<string, unknown>;
        await provider.handleDecision(req, res, {
          pending: body.pending,
          csrf: body.csrf,
          password: body.password,
          action: body.action,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: options.config.issuerUrl,
    baseUrl: options.config.issuerUrl,
    resourceServerUrl: options.config.publicUrl,
    resourceName: "Tandem",
    scopesSupported: ["mcp"],
    authorizationOptions: { rateLimit: globalRateLimit(15 * 60_000, 100) },
    clientRegistrationOptions: {
      clientIdGeneration: false,
      clientSecretExpirySeconds: 0,
      rateLimit: globalRateLimit(60 * 60_000, 20),
    },
    tokenOptions: { rateLimit: globalRateLimit(15 * 60_000, 50) },
    revocationOptions: { rateLimit: globalRateLimit(15 * 60_000, 50) },
  }));

  app.use(
    "/mcp",
    enforceBodyPolicy(MCP_BODY_LIMIT, "json"),
    express.json({ limit: MCP_BODY_LIMIT, strict: true }),
    parserErrorHandler,
    requireBearerAuth({
      verifier: provider,
      requiredScopes: ["mcp"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.config.publicUrl),
    }),
    async (req: Request, res: Response) => {
      const server = await buildMcpServer(options.fleet, options.fabric);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void transport.close();
        void server.close();
      };
      res.once("close", cleanup);
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed" });
        else res.destroy();
      }
    },
  );

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("tandem public request failed");
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    else res.destroy();
  }) as ErrorRequestHandler);

  return { app, state };
}

export async function startOAuthServer(options: PublicOAuthServerOptions): Promise<PublicOAuthServerHandle> {
  const { app, state } = await createOAuthApp(options);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  console.error(`tandem OAuth MCP bridge listening on loopback port ${port}`);
  console.error(`cwd allowlist roots: ${getAllowlist().length}`);
  return {
    port,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
