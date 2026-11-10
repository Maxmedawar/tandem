import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthStateError, OAuthStateStore } from "./oauth-state.ts";

const MAX_REDIRECTS = 5;
const MAX_PENDING = 128;
const PENDING_TTL_MS = 5 * 60_000;
const MAX_PASSWORD_FAILURES = 5;
const CSRF_COOKIE = "__Host-tandem_csrf";
const PKCE_S256 = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_ALLOWED_REDIRECT_ORIGINS = "https://claude.ai,https://claude.com";

interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: ["mcp"];
  codeChallenge: string;
  oauthState?: string;
  csrf: string;
  expiresAt: number;
  failures: number;
}

export interface DecisionInput {
  pending: unknown;
  csrf: unknown;
  password: unknown;
  action: unknown;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanExpiredPending(pending: Map<string, PendingAuthorization>, now: number): void {
  for (const [id, record] of pending) {
    if (record.expiresAt <= now) pending.delete(id);
  }
}

// Exact https origins a redirect may use. TANDEM_ALLOWED_REDIRECT_ORIGINS
// (comma-separated) replaces the default when set. Entries that do not parse
// or are not https grant nothing.
function allowedRedirectOrigins(): Set<string> {
  const raw = process.env.TANDEM_ALLOWED_REDIRECT_ORIGINS ?? DEFAULT_ALLOWED_REDIRECT_ORIGINS;
  const origins = new Set<string>();
  for (const entry of raw.split(",")) {
    try {
      const url = new URL(entry.trim());
      if (url.protocol === "https:") origins.add(url.origin);
    } catch {
      // ignored
    }
  }
  return origins;
}

function isLoopbackRedirect(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
}

// The one redirect gate: called at registration, authorize and the decision.
// A redirect passes only on an allowlisted https origin or a loopback host.
function isPermittedRedirect(raw: string): boolean {
  if (raw.length < 1 || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (isLoopbackRedirect(url)) return true;
  return url.protocol === "https:" && allowedRedirectOrigins().has(url.origin);
}

function exactSet(values: string[] | undefined, expected: string[]): boolean {
  if (values === undefined) return true;
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

function validateClientRegistration(
  client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
): void {
  if (client.token_endpoint_auth_method !== "none") {
    throw new InvalidClientMetadataError("only public OAuth clients are supported");
  }
  if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length < 1 || client.redirect_uris.length > MAX_REDIRECTS) {
    throw new InvalidClientMetadataError("redirect_uris must contain one to five entries");
  }
  if (new Set(client.redirect_uris).size !== client.redirect_uris.length || !client.redirect_uris.every(isPermittedRedirect)) {
    throw new InvalidClientMetadataError("redirect_uris contains an unsafe or duplicate URI");
  }
  if (!exactSet(client.grant_types, ["authorization_code", "refresh_token"])) {
    throw new InvalidClientMetadataError("grant_types must be authorization_code and refresh_token");
  }
  if (!exactSet(client.response_types, ["code"])) {
    throw new InvalidClientMetadataError("response_types must contain only code");
  }
  if (client.scope !== undefined && client.scope !== "mcp") {
    throw new InvalidClientMetadataError("scope must be mcp");
  }
  if (client.client_name !== undefined && (client.client_name.length < 1 || client.client_name.length > 80 || /[\u0000-\u001f\u007f]/.test(client.client_name))) {
    throw new InvalidClientMetadataError("client_name is invalid");
  }
  if (
    client.client_uri || client.logo_uri || client.contacts?.length || client.tos_uri || client.policy_uri ||
    client.jwks_uri || client.jwks || client.software_statement
  ) {
    throw new InvalidClientMetadataError("unsupported client metadata");
  }
}

class TandemClientsStore implements OAuthRegisteredClientsStore {
  private readonly state: OAuthStateStore;
  private readonly random: (bytes: number) => Buffer;

  constructor(state: OAuthStateStore, random: (bytes: number) => Buffer) {
    this.state = state;
    this.random = random;
  }

  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (clientId.length < 1 || clientId.length > 256) return Promise.resolve(undefined);
    return this.state.getClient(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    validateClientRegistration(client);
    const clientId = this.random(32).toString("base64url");
    try {
      return await this.state.registerClient({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: [...client.redirect_uris],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "MCP connector",
        scope: "mcp",
      });
    } catch (error) {
      if (error instanceof OAuthStateError && error.kind === "capacity") {
        throw new InvalidClientMetadataError("client registration capacity reached");
      }
      throw error;
    }
  }
}

export interface TandemOAuthProviderOptions {
  state: OAuthStateStore;
  publicUrl: URL;
  canonicalOrigin: string;
  now?: () => number;
  random?: (bytes: number) => Buffer;
}

export class TandemOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;
  private readonly state: OAuthStateStore;
  private readonly publicUrl: string;
  private readonly canonicalOrigin: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(options: TandemOAuthProviderOptions) {
    this.state = options.state;
    this.publicUrl = options.publicUrl.href;
    this.canonicalOrigin = options.canonicalOrigin;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.clientsStore = new TandemClientsStore(options.state, this.random);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri) || !isPermittedRedirect(params.redirectUri)) {
      directOAuthError(res, 400, "invalid_request");
      return;
    }
    const scopes = normalizeScopes(params.scopes);
    if (!scopes || !params.resource || params.resource.href !== this.publicUrl || !PKCE_S256.test(params.codeChallenge)) {
      directOAuthError(res, 400, !scopes ? "invalid_scope" : "invalid_request");
      return;
    }
    if (params.state !== undefined && params.state.length > 1024) {
      directOAuthError(res, 400, "invalid_request");
      return;
    }

    const now = this.now();
    cleanExpiredPending(this.pending, now);
    if (this.pending.size >= MAX_PENDING) {
      directOAuthError(res, 503, "temporarily_unavailable");
      return;
    }
    const id = this.random(32).toString("base64url");
    const csrf = this.random(32).toString("base64url");
    this.pending.set(id, {
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      resource: this.publicUrl,
      scopes,
      codeChallenge: params.codeChallenge,
      oauthState: params.state,
      csrf,
      expiresAt: now + PENDING_TTL_MS,
      failures: 0,
    });
    setCsrfCookie(res, csrf);
    res.status(200).type("html").send(consentPage({ pending: id, csrf, redirectUri: params.redirectUri }));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    try {
      return await this.state.challengeForCode(authorizationCode, client.client_id);
    } catch {
      throw new InvalidGrantError("invalid authorization code");
    }
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!resource || resource.href !== this.publicUrl || redirectUri === undefined) {
      throw new InvalidGrantError("invalid authorization grant");
    }
    try {
      return await this.state.exchangeCode(authorizationCode, {
        clientId: client.client_id,
        redirectUri,
        resource: resource.href,
      });
    } catch (error) {
      throw translateGrantError(error);
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!resource || resource.href !== this.publicUrl || !normalizeRefreshScopes(scopes)) {
      throw new InvalidGrantError("invalid refresh grant");
    }
    try {
      return await this.state.exchangeRefresh(refreshToken, {
        clientId: client.client_id,
        resource: resource.href,
        scopes,
      });
    } catch (error) {
      throw translateGrantError(error);
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      return await this.state.verifyAccess(token, this.publicUrl);
    } catch {
      throw new InvalidTokenError("invalid access token");
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.state.revoke(request.token, client.client_id);
  }

  async handleDecision(req: Request, res: Response, input: DecisionInput): Promise<void> {
    const id = typeof input.pending === "string" ? input.pending : "";
    const csrf = typeof input.csrf === "string" ? input.csrf : "";
    const password = typeof input.password === "string" ? input.password : "";
    const action = typeof input.action === "string" ? input.action : "";
    const cookieCsrf = parseCookie(req.headers.cookie ?? "", CSRF_COOKIE);
    const now = this.now();
    cleanExpiredPending(this.pending, now);
    const record = this.pending.get(id);

    if (!record || !isPermittedRedirect(record.redirectUri) || !validRequestOrigin(req, this.canonicalOrigin) || !cookieCsrf ||
      !safeEqual(record.csrf, csrf) || !safeEqual(record.csrf, cookieCsrf) ||
      (action !== "approve" && action !== "deny")) {
      if (record) this.pending.delete(id);
      clearCsrfCookie(res);
      directOAuthError(res, 400, "invalid_request");
      return;
    }

    if (action === "deny") {
      this.pending.delete(id);
      clearCsrfCookie(res);
      res.redirect(302, authorizationRedirect(record, { error: "access_denied" }));
      return;
    }

    // Claim the pending request before the first await. A second concurrent
    // decision now observes it as consumed and cannot mint another code. A
    // failed password attempt is reinserted below only while attempts remain.
    this.pending.delete(id);
    if (password.length > 1024 || !(await this.state.verifyPassword(password))) {
      record.failures += 1;
      if (record.failures >= MAX_PASSWORD_FAILURES) {
        clearCsrfCookie(res);
        directOAuthError(res, 429, "access_denied");
        return;
      }
      this.pending.set(id, record);
      setCsrfCookie(res, record.csrf);
      res.status(401).type("html").send(consentPage({ pending: record.id, csrf: record.csrf, redirectUri: record.redirectUri, passwordError: true }));
      return;
    }

    clearCsrfCookie(res);
    try {
      const code = await this.state.issueAuthorizationCode({
        clientId: record.clientId,
        redirectUri: record.redirectUri,
        resource: record.resource,
        codeChallenge: record.codeChallenge,
      });
      res.redirect(302, authorizationRedirect(record, { code }));
    } catch (error) {
      if (error instanceof OAuthStateError && error.kind === "capacity") {
        directOAuthError(res, 503, "temporarily_unavailable");
        return;
      }
      throw error;
    }
  }
}

function translateGrantError(error: unknown): InvalidGrantError | InvalidScopeError | ServerError {
  if (error instanceof OAuthStateError) {
    if (error.kind === "invalid_grant") return new InvalidGrantError("invalid grant");
    if (error.kind === "capacity") return new ServerError("token capacity reached");
  }
  return new ServerError("token operation failed");
}

function normalizeScopes(scopes: string[] | undefined): ["mcp"] | undefined {
  if (scopes === undefined || scopes.length === 0) return ["mcp"];
  return scopes.length === 1 && scopes[0] === "mcp" ? ["mcp"] : undefined;
}

function normalizeRefreshScopes(scopes: string[] | undefined): boolean {
  return scopes === undefined || (scopes.length === 1 && scopes[0] === "mcp");
}

function validRequestOrigin(req: Request, canonicalOrigin: string): boolean {
  const origin = req.get("origin");
  if (origin !== undefined) return origin === canonicalOrigin;
  const referer = req.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === canonicalOrigin;
  } catch {
    return false;
  }
}

function parseCookie(header: string, name: string): string | undefined {
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function setCsrfCookie(res: Response, value: string): void {
  res.cookie(CSRF_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: PENDING_TTL_MS,
  });
}

function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
}

function directOAuthError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function authorizationRedirect(
  record: PendingAuthorization,
  result: { code: string } | { error: string },
): string {
  const target = new URL(record.redirectUri);
  if ("code" in result) target.searchParams.set("code", result.code);
  else target.searchParams.set("error", result.error);
  if (record.oauthState !== undefined) target.searchParams.set("state", record.oauthState);
  return target.href;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function consentPage(input: { pending: string; csrf: string; redirectUri: string; passwordError?: boolean }): string {
  const redirect = new URL(input.redirectUri);
  const host = escapeHtml(redirect.host);
  const where = isLoopbackRedirect(redirect) ? `on this computer (${host})` : `at ${host}`;
  const error = input.passwordError
    ? '<p id="password-error" class="error" role="alert">Password not accepted. Check it and try again.</p>'
    : "";
  const describedBy = input.passwordError ? "permission-copy password-error password-help" : "permission-copy password-help";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Allow Tandem access</title>
  <style>
    :root{color-scheme:dark;--ground:#11120f;--surface:#1b1c18;--ink:#f1f0e8;--quiet:#b8b7ac;--edge:#34352e;--focus:#ddd6b8;--danger:#e7aaa2}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--ground);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px 20px}
    main{width:min(100%,460px);background:var(--surface);padding:40px;border-radius:18px 18px 18px 5px;box-shadow:0 3px 8px rgba(0,0,0,.2)}
    h1{font-size:clamp(1.8rem,8vw,2.55rem);line-height:1.08;letter-spacing:-.02em;margin:0 0 22px;max-width:14ch}
    p{color:var(--quiet);line-height:1.55;margin:0 0 24px}
    strong{color:var(--ink);font-weight:650}
    label{display:block;font-weight:650;margin:0 0 9px}
    input{width:100%;min-height:50px;border:2px solid var(--edge);border-radius:8px;background:var(--ground);color:var(--ink);font:inherit;padding:12px 14px}
    input:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
    .error{color:var(--danger);font-weight:620;margin:0 0 18px}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:24px}
    button{min-height:50px;border:0;border-radius:8px;font:inherit;font-weight:720;cursor:pointer;background:#d7d2bd;color:#171813;padding:11px 16px}
    button[name=action][value=deny]{background:#292a25;color:var(--ink)}
    button:hover{background:#ebe6d2}
    button[name=action][value=deny]:hover{background:#363730}
    small{display:block;color:var(--quiet);line-height:1.45;margin-top:22px}
    @media(max-width:430px){main{padding:30px 24px}.actions{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <h1>Allow connection?</h1>
    <p id="permission-copy"><strong>MCP connector</strong> ${where} is requesting every enabled Tandem tool. Approval can start and control agent or terminal sessions with your OS account's authority.</p>
    ${error}
    <form method="post" action="/authorize/decision">
      <input type="hidden" name="pending" value="${escapeHtml(input.pending)}">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
      <label for="owner-password">Tandem owner password</label>
      <input id="owner-password" name="password" type="password" autocomplete="current-password" required maxlength="1024" aria-describedby="${describedBy}">
      <div class="actions">
        <button type="submit" name="action" value="approve">Allow access</button>
        <button type="submit" name="action" value="deny" formnovalidate>Deny access</button>
      </div>
      <small id="password-help">Access continues through rotating tokens until the client or its token is revoked.</small>
    </form>
    <small>Continue only if you started this connection.</small>
  </main>
</body>
</html>`;
}
