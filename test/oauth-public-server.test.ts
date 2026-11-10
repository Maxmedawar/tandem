import { createHash } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOAuthConfig, loadOAuthConfigFromEnv } from "../src/auth-config.ts";
import { startOAuthServer, type PublicOAuthServerHandle } from "../src/public-server.ts";

const OWNER_PASSWORD = "owner password 0123456789";
const PUBLIC_ORIGIN = "http://127.0.0.1:45678";
const PUBLIC_URL = `${PUBLIC_ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:32123/oauth/callback";
const VERIFIER = "verifier-012345678901234567890123456789012345678901234567890123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const roots: string[] = [];
let handle: PublicOAuthServerHandle | undefined;

async function start(): Promise<{ base: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "tandem-oauth-http-"));
  roots.push(root);
  const stateDir = join(root, "oauth");
  const config = loadOAuthConfig({
    publicUrl: PUBLIC_URL,
    allowLoopbackHttp: true,
    ownerPassword: OWNER_PASSWORD,
    stateDir,
  });
  handle = await startOAuthServer({ host: "127.0.0.1", port: 0, config });
  return { base: `http://127.0.0.1:${handle.port}`, stateDir };
}

async function register(base: string, redirect = REDIRECT): Promise<string> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
      client_name: "Test connector",
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { client_id: string; client_secret?: string; client_name: string };
  expect(body.client_secret).toBeUndefined();
  expect(body.client_name).toBe("MCP connector");
  return body.client_id;
}

function authorizeUrl(base: string, clientId: string, redirect = REDIRECT): string {
  const url = new URL("/authorize", base);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "mcp");
  url.searchParams.set("resource", PUBLIC_URL);
  url.searchParams.set("state", "opaque-client-state");
  return url.href;
}

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1];
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[a-f0-9]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

async function authorize(base: string, clientId: string): Promise<{ code: string; cookie: string }> {
  const page = await fetch(authorizeUrl(base, clientId), { redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  const pending = hidden(html, "pending");
  const csrf = hidden(html, "csrf");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
  const decision = await fetch(`${base}/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: PUBLIC_ORIGIN,
    },
    body: new URLSearchParams({ pending, csrf, password: OWNER_PASSWORD, action: "approve" }),
  });
  expect(decision.status).toBe(302);
  const location = new URL(decision.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("opaque-client-state");
  return { code: location.searchParams.get("code")!, cookie };
}

async function exchange(base: string, clientId: string, code: string) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      resource: PUBLIC_URL,
    }),
  });
  return { response, body: await response.json() as { access_token?: string; refresh_token?: string; error?: string } };
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OAuth canonical configuration", () => {
  it("requires an explicit exact HTTPS /mcp URL and same-origin issuer", () => {
    expect(() => loadOAuthConfig({ publicUrl: "https://example.test/" })).toThrow(/\/mcp/);
    expect(() => loadOAuthConfig({ publicUrl: "http://example.test/mcp" })).toThrow(/HTTPS/);
    expect(() => loadOAuthConfig({ publicUrl: "https://u:p@example.test/mcp" })).toThrow(/credentials/);
    expect(() => loadOAuthConfig({ publicUrl: "https://example.test/mcp?q=1" })).toThrow(/query/);
    expect(() => loadOAuthConfig({ publicUrl: "https://example.test/mcp", issuerUrl: "https://other.test" })).toThrow(/same origin/);
    expect(() => loadOAuthConfig({ publicUrl: PUBLIC_URL, allowLoopbackHttp: true })).not.toThrow();
    expect(() => loadOAuthConfigFromEnv({ TANDEM_PUBLIC_URL: " https://example.test/mcp" })).toThrow(/whitespace/);
  });
});

describe("OAuth public boundary", () => {
  it("publishes no-store standards metadata for public PKCE clients only", async () => {
    const { base } = await start();
    const auth = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(auth.status).toBe(200);
    expect(auth.headers.get("cache-control")).toBe("no-store");
    expect(auth.headers.get("strict-transport-security")).toContain("max-age=");
    expect(await auth.json()).toMatchObject({
      issuer: `${PUBLIC_ORIGIN}/`,
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      code_challenge_methods_supported: ["S256"],
    });
    const resource = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(await resource.json()).toMatchObject({ resource: PUBLIC_URL, scopes_supported: ["mcp"] });
  });

  it("rejects confidential and unsafe dynamic registrations", async () => {
    const { base } = await start();
    const confidential = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }),
    });
    expect(confidential.status).toBe(400);
    const unsafe = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://remote.example.test/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(unsafe.status).toBe(400);
  });

  it("defeats the SDK loopback-port redirect relaxation with an exact direct error", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const relaxedButWrong = REDIRECT.replace("32123", "32124");
    const response = await fetch(authorizeUrl(base, clientId, relaxedButWrong), { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("keeps OAuth details out of the consent page and completes a single-use PKCE flow", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const page = await fetch(authorizeUrl(base, clientId), { redirect: "manual" });
    const html = await page.text();
    expect(html).toContain("MCP connector");
    expect(html).toContain("Allow connection?");
    expect(html).toContain("Allow access");
    expect(html).toContain("Deny access");
    expect(html).toContain('label for="owner-password"');
    expect(html).toContain('aria-describedby="permission-copy password-help"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/opacity\s*:\s*0/);
    expect(html).not.toMatch(/(?:linear|radial)-gradient/);
    expect(html).not.toMatch(/translate[XY]?\s*\(/);
    for (const [foreground, background] of [
      ["#f1f0e8", "#11120f"],
      ["#f1f0e8", "#1b1c18"],
      ["#b8b7ac", "#1b1c18"],
      ["#e7aaa2", "#1b1c18"],
      ["#171813", "#d7d2bd"],
      ["#f1f0e8", "#292a25"],
    ]) expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain("name=\"action\" value=\"approve\"");
    expect(html).toContain("name=\"action\" value=\"deny\"");
    expect(html).not.toContain(REDIRECT);
    expect(html).not.toContain(PUBLIC_URL);
    expect(html).not.toContain(CHALLENGE);
    expect(html).not.toContain("opaque-client-state");

    const pending = hidden(html, "pending");
    const csrf = hidden(html, "csrf");
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const decision = await fetch(`${base}/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: PUBLIC_ORIGIN },
      body: new URLSearchParams({ pending, csrf, password: OWNER_PASSWORD, action: "approve" }),
    });
    const code = new URL(decision.headers.get("location")!).searchParams.get("code")!;
    const first = await exchange(base, clientId, code);
    expect(first.response.status).toBe(200);
    expect(first.body.access_token).toBeTruthy();
    expect(first.body.refresh_token).toBeTruthy();
    const replay = await exchange(base, clientId, code);
    expect(replay.response.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("requires exact origin, cookie, CSRF, and owner password for approval", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const page = await fetch(authorizeUrl(base, clientId));
    const html = await page.text();
    const response = await fetch(`${base}/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.invalid" },
      body: new URLSearchParams({
        pending: hidden(html, "pending"),
        csrf: hidden(html, "csrf"),
        password: OWNER_PASSWORD,
        action: "approve",
      }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("consumes a pending approval before concurrent decisions can mint two codes", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const page = await fetch(authorizeUrl(base, clientId));
    const html = await page.text();
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const form = new URLSearchParams({
      pending: hidden(html, "pending"),
      csrf: hidden(html, "csrf"),
      password: OWNER_PASSWORD,
      action: "approve",
    });
    const send = () => fetch(`${base}/authorize/decision`, {
      method: "POST",
      redirect: "manual" as const,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: PUBLIC_ORIGIN },
      body: form.toString(),
    });
    const decisions = await Promise.all([send(), send()]);
    expect(decisions.map((response) => response.status).sort()).toEqual([302, 400]);
    const allowed = decisions.find((response) => response.status === 302);
    if (!allowed) throw new Error("missing approved response");
    const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
    expect((await exchange(base, clientId, code)).response.status).toBe(200);
  });

  it("rejects declared and chunked oversized bodies before SDK handlers", async () => {
    const { base } = await start();
    const target = new URL("/register", base);
    const declaredStatus = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999999" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    expect(declaredStatus).toBe(413);

    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.write(`{"padding":"${"x".repeat(20_000)}`);
      request.end('"}');
    });
    expect(chunkedStatus).toBe(413);
  });

  it("revokes issued access and never accepts a missing bearer token", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const { code } = await authorize(base, clientId);
    const issued = await exchange(base, clientId, code);
    const accessToken = issued.body.access_token!;
    const noBearer = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(noBearer.status).toBe(401);
    expect(noBearer.headers.get("www-authenticate")).toContain("resource_metadata");

    const revoke = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: accessToken }),
    });
    expect(revoke.status).toBe(200);
    const after = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(after.status).toBe(401);
  });
});

describe("OAuth redirect allowlist", () => {
  const ENV = "TANDEM_ALLOWED_REDIRECT_ORIGINS";
  const savedEnv = process.env[ENV];
  const CONSENT_TAIL = "is requesting every enabled Tandem tool.";

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  async function registerStatus(base: string, redirect: string): Promise<{ status: number; clientId?: string }> {
    const response = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    const body = await response.json() as { client_id?: string };
    return { status: response.status, clientId: body.client_id };
  }

  // Seeds a client straight into the state store, bypassing the registration check.
  async function seedClient(redirect: string): Promise<string> {
    const clientId = "seeded-client-0123456789";
    await handle!.state.registerClient({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MCP connector",
      scope: "mcp",
    });
    return clientId;
  }

  async function consentHtml(base: string, redirect: string): Promise<string> {
    const { status, clientId } = await registerStatus(base, redirect);
    expect(status).toBe(201);
    const page = await fetch(authorizeUrl(base, clientId!, redirect), { redirect: "manual" });
    expect(page.status).toBe(200);
    return page.text();
  }

  it("a) refuses to register a redirect outside the allowlist", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect((await registerStatus(base, "https://evil.example/cb")).status).toBe(400);
  });

  it("b) registers the default claude.ai callback", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect((await registerStatus(base, "https://claude.ai/api/mcp/auth_callback")).status).toBe(201);
  });

  it("c) registers a loopback http redirect", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect((await registerStatus(base, "http://127.0.0.1:5000/cb")).status).toBe(201);
  });

  it("d) refuses a lookalike host that only starts with an allowed host", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect((await registerStatus(base, "https://claude.ai.evil.example/cb")).status).toBe(400);
  });

  it("e) refuses plain http on an allowed host", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect((await registerStatus(base, "http://claude.ai/cb")).status).toBe(400);
  });

  it("f) the env variable replaces the default allowlist", async () => {
    process.env[ENV] = "https://client.example";
    const { base } = await start();
    expect((await registerStatus(base, "https://client.example/cb")).status).toBe(201);
    expect((await registerStatus(base, "https://claude.ai/cb")).status).toBe(400);
  });

  it("g) junk and non-https entries in the env variable grant nothing", async () => {
    process.env[ENV] = "not a url, http://plain.example, javascript:alert(1), data:text/html;x, null, ,*";
    const { base } = await start();
    for (const redirect of [
      "http://plain.example/cb",
      "https://plain.example/cb",
      "https://claude.ai/cb",
      "https://evil.example/cb",
    ]) expect((await registerStatus(base, redirect)).status, redirect).toBe(400);
    expect((await registerStatus(base, "http://127.0.0.1:5000/cb")).status).toBe(201);
  });

  it("h) refuses a stored client with a disallowed redirect at authorize", async () => {
    delete process.env[ENV];
    const { base } = await start();
    const redirect = "https://evil.example/cb";
    const clientId = await seedClient(redirect);
    const response = await fetch(authorizeUrl(base, clientId, redirect), { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain("Allow connection?");
    expect(JSON.parse(text)).toEqual({ error: "invalid_request" });
  });

  it("i) refuses the same stored client at the approve decision and issues no code", async () => {
    // The redirect is allowed while the consent page is fetched, then drops off
    // the allowlist before the owner approves.
    process.env[ENV] = "https://evil.example";
    const { base, stateDir } = await start();
    const redirect = "https://evil.example/cb";
    const clientId = await seedClient(redirect);
    const page = await fetch(authorizeUrl(base, clientId, redirect), { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    delete process.env[ENV];
    const decision = await fetch(`${base}/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: PUBLIC_ORIGIN },
      body: new URLSearchParams({
        pending: hidden(html, "pending"),
        csrf: hidden(html, "csrf"),
        password: OWNER_PASSWORD,
        action: "approve",
      }),
    });
    expect(decision.status).toBe(400);
    expect(decision.headers.get("location")).toBeNull();
    const persisted = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8")) as { codes: object };
    expect(Object.keys(persisted.codes)).toHaveLength(0);
  });

  it("j) consent page shows the HTML-escaped redirect host of an allowed client", async () => {
    process.env[ENV] = "https://claude.ai,https://a&b.example";
    const { base } = await start();
    expect(await consentHtml(base, "https://claude.ai/api/mcp/auth_callback"))
      .toContain(`<strong>MCP connector</strong> at claude.ai ${CONSENT_TAIL}`);
    const escaped = await consentHtml(base, "https://a&b.example/cb");
    expect(escaped).toContain(`<strong>MCP connector</strong> at a&amp;b.example ${CONSENT_TAIL}`);
    expect(escaped).not.toContain("a&b.example");
  });

  it("k) loopback consent says this computer and shows host and port", async () => {
    delete process.env[ENV];
    const { base } = await start();
    expect(await consentHtml(base, "http://127.0.0.1:5000/cb"))
      .toContain(`<strong>MCP connector</strong> on this computer (127.0.0.1:5000) ${CONSENT_TAIL}`);
  });
});
