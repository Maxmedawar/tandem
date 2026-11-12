import path from "node:path";
import { tandemHome } from "../bridge/tandem-home.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface OAuthConfigInput {
  publicUrl: string;
  issuerUrl?: string;
  ownerPassword?: string;
  stateDir?: string;
  allowLoopbackHttp?: boolean;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

export interface OAuthConfig {
  publicUrl: URL;
  issuerUrl: URL;
  ownerPassword?: string;
  stateDir: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

function hasCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

function isExactLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function parseAbsoluteUrl(raw: string, label: string): URL {
  if (!raw || raw.trim() !== raw) throw new Error(`${label} must be an absolute URL without surrounding whitespace`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (hasCredentials(parsed)) throw new Error(`${label} must not contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${label} must not contain a query or fragment`);
  return parsed;
}

function parseTtl(value: number | undefined, fallback: number, label: string): number {
  const ttl = value ?? fallback;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) {
    throw new Error(`${label} must be an integer from 60 to 31536000 seconds`);
  }
  return ttl;
}

export function loadOAuthConfig(input: OAuthConfigInput): OAuthConfig {
  const publicUrl = parseAbsoluteUrl(input.publicUrl, "TANDEM_PUBLIC_URL");
  if (publicUrl.pathname !== "/mcp") throw new Error("TANDEM_PUBLIC_URL must use the exact /mcp path");
  if (publicUrl.protocol !== "https:" && !(input.allowLoopbackHttp && isExactLoopbackHttp(publicUrl))) {
    throw new Error("TANDEM_PUBLIC_URL must use HTTPS");
  }

  const issuerUrl = input.issuerUrl
    ? parseAbsoluteUrl(input.issuerUrl, "TANDEM_ISSUER_URL")
    : new URL(publicUrl.origin);
  if (issuerUrl.pathname !== "/") throw new Error("TANDEM_ISSUER_URL must be an origin without a path");
  if (issuerUrl.protocol !== "https:" && !(input.allowLoopbackHttp && isExactLoopbackHttp(issuerUrl))) {
    throw new Error("TANDEM_ISSUER_URL must use HTTPS");
  }
  if (issuerUrl.origin !== publicUrl.origin) {
    throw new Error("TANDEM_ISSUER_URL must use the same origin as TANDEM_PUBLIC_URL");
  }

  const ownerPassword = input.ownerPassword;
  if (ownerPassword !== undefined && (ownerPassword.length < 16 || ownerPassword.length > 1024)) {
    throw new Error("TANDEM_OWNER_PASSWORD must contain 16 to 1024 characters");
  }

  return {
    publicUrl,
    issuerUrl,
    ownerPassword,
    stateDir: path.resolve(input.stateDir ?? path.join(tandemHome(), "oauth")),
    accessTtlSeconds: parseTtl(input.accessTtlSeconds, 600, "access token TTL"),
    refreshTtlSeconds: parseTtl(input.refreshTtlSeconds, 30 * 24 * 60 * 60, "refresh token TTL"),
  };
}

export function loadOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const publicUrl = env.TANDEM_PUBLIC_URL ?? "";
  if (!publicUrl.trim()) throw new Error("TANDEM_PUBLIC_URL is required when OAuth is enabled");
  const issuerUrl = env.TANDEM_ISSUER_URL;
  return loadOAuthConfig({
    publicUrl,
    issuerUrl: issuerUrl && issuerUrl.trim() ? issuerUrl : undefined,
    ownerPassword: env.TANDEM_OWNER_PASSWORD,
    stateDir: env.TANDEM_OAUTH_STATE_DIR?.trim() || undefined,
    accessTtlSeconds: env.TANDEM_ACCESS_TTL_SECONDS ? Number(env.TANDEM_ACCESS_TTL_SECONDS) : undefined,
    refreshTtlSeconds: env.TANDEM_REFRESH_TTL_SECONDS ? Number(env.TANDEM_REFRESH_TTL_SECONDS) : undefined,
  });
}
