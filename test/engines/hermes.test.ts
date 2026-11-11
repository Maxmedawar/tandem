import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { routeForTest } from "../../bridge/router.ts";
import {
  HermesSession,
  canonicalizeHermesBaseUrl,
  validateHermesAgentId,
  buildHermesWritableAgents,
  loadHermesConfig,
  type HermesConfig,
} from "../../bridge/engines/hermes.ts";

/**
 * Hermes adapter tests (binding — Phase 2 correction D): every test uses an
 * INJECTED fetch implementation and an INJECTED password reader. No real
 * network call, no real Hermes service, no real password file, ever touched
 * by this suite.
 *
 * These exercise the PROVEN Hermes WebUI wire contract: cookie-session login
 * (POST /api/auth/login), a chat turn started via POST /api/chat/start after
 * reading the pre-send message-count cursor from GET /api/session, and
 * GET /api/session?session_id=...&messages=1 for reads/isAlive/isWorking.
 */

const TEST_PASSWORD = "correct horse battery staple";

function makeConfig(overrides: Partial<HermesConfig> = {}): HermesConfig {
  return {
    baseUrl: "http://127.0.0.1:9999",
    writableAgents: new Set(["agent-a"]),
    requestTimeoutMs: 200,
    maxResponseBytes: 4096,
    passwordPath: "/tmp/does-not-matter",
    liveDisabled: false,
    ...overrides,
  };
}

async function fakePasswordReader(): Promise<string> {
  return TEST_PASSWORD;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function loginResponse(cookie = "sid=abc123; Path=/; HttpOnly; SameSite=Lax"): Response {
  return jsonResponse(200, { ok: true }, { "set-cookie": cookie });
}

function sessionResponse(
  messages: Array<{ role: string; content: string }>,
  activeStreamId?: string,
): Response {
  const session: Record<string, unknown> = { messages };
  if (activeStreamId !== undefined) session.active_stream_id = activeStreamId;
  return jsonResponse(200, { session });
}

/** Routes requests by "METHOD pathname" to a handler; throws on anything
 *  unexpected so a wrong-URL/wrong-method bug fails loudly. Also records
 *  every (url, init) pair seen so tests can assert on headers/bodies/counts. */
function makeRouter(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("canonicalizeHermesBaseUrl — loopback-only, no credentials/query/fragment", () => {
  it("accepts 127.0.0.1, localhost, *.localhost, and IPv6 loopback", () => {
    expect(canonicalizeHermesBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(canonicalizeHermesBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(canonicalizeHermesBaseUrl("http://foo.localhost:8080")).toBe("http://foo.localhost:8080");
    expect(canonicalizeHermesBaseUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
  });

  it("strips a trailing slash from the path", () => {
    expect(canonicalizeHermesBaseUrl("http://127.0.0.1:8080/hermes/")).toBe("http://127.0.0.1:8080/hermes");
  });

  it("rejects a non-loopback host", () => {
    expect(() => canonicalizeHermesBaseUrl("http://example.com")).toThrow(/loopback/);
  });

  it("rejects a hostname-suffix trick (contains but does not end with .localhost)", () => {
    expect(() => canonicalizeHermesBaseUrl("http://notlocalhost.example")).toThrow(/loopback/);
    expect(() => canonicalizeHermesBaseUrl("http://evillocalhost")).toThrow(/loopback/);
  });

  it("rejects credentials, query, and fragment", () => {
    expect(() => canonicalizeHermesBaseUrl("http://user:pass@127.0.0.1")).toThrow(/credentials/);
    expect(() => canonicalizeHermesBaseUrl("http://127.0.0.1/?x=1")).toThrow(/query/);
    expect(() => canonicalizeHermesBaseUrl("http://127.0.0.1/#frag")).toThrow(/fragment/);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => canonicalizeHermesBaseUrl("ftp://127.0.0.1")).toThrow(/http/);
  });

  it("rejects an unparseable URL", () => {
    expect(() => canonicalizeHermesBaseUrl("not a url")).toThrow(/invalid Hermes base URL/);
  });

  it("never echoes a secret-bearing raw URL in validation errors", () => {
    const raw = "ftp://user:VERY-SECRET@example.com/private";
    try {
      canonicalizeHermesBaseUrl(raw);
      throw new Error("expected URL validation to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("http");
      expect(message).not.toContain("VERY-SECRET");
      expect(message).not.toContain("example.com");
    }
  });
});

describe("validateHermesAgentId", () => {
  it("accepts a bounded alphanumeric/./_/- id", () => {
    expect(validateHermesAgentId("agent-a.1_2")).toBe("agent-a.1_2");
  });
  it("rejects an empty id", () => {
    expect(() => validateHermesAgentId("")).toThrow();
  });
  it("rejects disallowed characters", () => {
    expect(() => validateHermesAgentId("agent/../etc")).toThrow();
    expect(() => validateHermesAgentId("agent a")).toThrow();
  });
  it("rejects an id over 128 chars", () => {
    expect(() => validateHermesAgentId("a".repeat(129))).toThrow();
  });
});

describe("buildHermesWritableAgents — fails closed", () => {
  it("unset/blank yields an empty set (no agent is drivable)", () => {
    expect(buildHermesWritableAgents(undefined).size).toBe(0);
    expect(buildHermesWritableAgents("   ").size).toBe(0);
  });
  it("parses comma-separated, colon-separated, and mixed allowlists", () => {
    const s = buildHermesWritableAgents("agent-a,agent-b:agent-c");
    expect([...s].sort()).toEqual(["agent-a", "agent-b", "agent-c"]);
  });
});

describe("loadHermesConfig", () => {
  it("returns undefined when TANDEM_HERMES_BASE_URL is unset", () => {
    expect(loadHermesConfig({})).toBeUndefined();
  });

  it("loads a valid config with defaults, including the default password path", () => {
    const cfg = loadHermesConfig({ TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999" });
    expect(cfg?.baseUrl).toBe("http://127.0.0.1:9999");
    expect(cfg?.writableAgents.size).toBe(0);
    expect(cfg?.requestTimeoutMs).toBe(15_000);
    expect(cfg?.maxResponseBytes).toBe(256 * 1024);
    expect(cfg?.passwordPath).toBe(join(homedir(), ".hermes", "hermes-webui-password.txt"));
    expect(cfg?.liveDisabled).toBe(false);
  });

  it("honors overrides for agents/timeout/cap/password path", () => {
    const cfg = loadHermesConfig({
      TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999",
      TANDEM_HERMES_WRITABLE_AGENTS: "agent-a",
      TANDEM_HERMES_TIMEOUT_MS: "5000",
      TANDEM_HERMES_MAX_RESPONSE_BYTES: "1000",
      TANDEM_HERMES_PASSWORD_PATH: "/custom/password.txt",
    });
    expect(cfg?.writableAgents.has("agent-a")).toBe(true);
    expect(cfg?.requestTimeoutMs).toBe(5000);
    expect(cfg?.maxResponseBytes).toBe(1000);
    expect(cfg?.passwordPath).toBe("/custom/password.txt");
  });

  it("parses TANDEM_HERMES_DISABLE_LIVE case-insensitively for 1/true/yes/on", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "ON"]) {
      const cfg = loadHermesConfig({ TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999", TANDEM_HERMES_DISABLE_LIVE: v });
      expect(cfg?.liveDisabled, `value "${v}"`).toBe(true);
    }
  });

  it("treats unset/other values as NOT disabled", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", "banana"]) {
      const cfg = loadHermesConfig({ TANDEM_HERMES_BASE_URL: "http://127.0.0.1:9999", TANDEM_HERMES_DISABLE_LIVE: v });
      expect(cfg?.liveDisabled, `value "${v}"`).toBe(false);
    }
  });
});

describe("HermesSession.attach — allowlist enforced in the adapter itself", () => {
  it("throws for an agent id not on the allowlist", () => {
    expect(() => HermesSession.attach({ agentId: "not-allowed", config: makeConfig() })).toThrow(/allowlist/);
  });
  it("throws for a malformed agent id before any allowlist check", () => {
    expect(() => HermesSession.attach({ agentId: "bad id!", config: makeConfig() })).toThrow();
  });
  it("succeeds for an allowlisted agent id", () => {
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig() });
    expect(session.id).toBe("agent-a");
    expect(session.engine).toBe("hermes");
    expect(session.cwd).toBe("");
  });
});

describe("HermesSession — login and cookie handling", () => {
  it("logs in with POST /api/auth/login {password} before the first request, never sending Origin/Referer", async () => {
    let loginBody: unknown;
    let loginHeaders: Record<string, string> | undefined;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": (init) => {
        loginBody = JSON.parse(String(init?.body));
        loginHeaders = init?.headers as Record<string, string>;
        return loginResponse();
      },
      "GET /api/session": () => sessionResponse([]),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await session.read();
    expect(loginBody).toEqual({ password: TEST_PASSWORD });
    const keys = Object.keys(loginHeaders ?? {}).map((k) => k.toLowerCase());
    expect(keys).not.toContain("origin");
    expect(keys).not.toContain("referer");
  });

  it("passes config.passwordPath to the injected password reader", async () => {
    let seenPath = "";
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([]),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ passwordPath: "/a/specific/path.txt" }),
      fetchImpl,
      passwordReader: async (p) => {
        seenPath = p;
        return TEST_PASSWORD;
      },
    });
    await session.read();
    expect(seenPath).toBe("/a/specific/path.txt");
  });

  it("captures only the first name=value pair of Set-Cookie, discarding attributes", async () => {
    let seenCookie: string | undefined;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse("sid=abc123; Path=/; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT"),
      "GET /api/session": (init) => {
        seenCookie = (init?.headers as Record<string, string>)?.cookie;
        return sessionResponse([]);
      },
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await session.read();
    expect(seenCookie).toBe("sid=abc123");
  });

  it("caches the cookie: only one login across two operations", async () => {
    let loginCalls = 0;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => {
        loginCalls++;
        return loginResponse();
      },
      "GET /api/session": () => sessionResponse([]),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await session.read();
    await session.isAlive();
    expect(loginCalls).toBe(1);
  });

  it("retries exactly once after a 401: clears the cookie, re-authenticates, retries the same request", async () => {
    let loginCalls = 0;
    let sessionCalls = 0;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => {
        loginCalls++;
        return loginResponse(`sid=cookie-${loginCalls}`);
      },
      "GET /api/session": (init) => {
        sessionCalls++;
        const cookie = (init?.headers as Record<string, string>)?.cookie;
        if (cookie === "sid=cookie-1") return textResponse(401, "unauthorized");
        return sessionResponse([{ role: "user", content: "hi" }]);
      },
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const result = await session.read();
    expect(loginCalls).toBe(2);
    expect(sessionCalls).toBe(2);
    expect(result.text).toBe("[user] hi");
  });

  it("throws if the retried request still 401s, without leaking the password/cookie in the error", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse("sid=always-401"),
      "GET /api/session": () => textResponse(401, "unauthorized"),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.read()).rejects.toThrow(/status 401/);
    try {
      await session.read();
      expect.fail("expected read() to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain(TEST_PASSWORD);
      expect(msg).not.toContain("always-401");
    }
  });

  it("throws when the login response has no Set-Cookie, without leaking the password", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => jsonResponse(200, { ok: true }),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    try {
      await session.read();
      expect.fail("expected read() to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/session cookie/);
      expect(msg).not.toContain(TEST_PASSWORD);
    }
  });

  it("throws on a non-2xx login status, without leaking the password", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => textResponse(403, "forbidden"),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    try {
      await session.read();
      expect.fail("expected read() to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/status 403/);
      expect(msg).not.toContain(TEST_PASSWORD);
    }
  });
});

describe("HermesSession — TANDEM_HERMES_DISABLE_LIVE", () => {
  it("blocks before any password read or network contact when no fetch was injected", async () => {
    let passwordReaderCalled = false;
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ liveDisabled: true }),
      passwordReader: async () => {
        passwordReaderCalled = true;
        return TEST_PASSWORD;
      },
    });
    await expect(session.read()).rejects.toThrow(/DISABLE_LIVE/);
    expect(passwordReaderCalled).toBe(false);
  });

  it("never blocks an injected test fetch, even when the flag is set", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([]),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ liveDisabled: true }),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const result = await session.read();
    expect(result.text).toBe("");
  });
});

describe("HermesSession.send — reads pre-send cursor, POSTs /api/chat/start", () => {
  it("returns status:running with the pre-send message count as cursor on a successful start", async () => {
    let startBody: unknown;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]),
      "POST /api/chat/start": (init) => {
        startBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { status: "ok" });
      },
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const result = await session.send("hi");
    expect(startBody).toEqual({ session_id: "agent-a", message: "hi" });
    expect(result).toEqual({ status: "running", report: "", cursor: 2 });
  });

  it("REJECTS model/effort before any network call (binding correction C)", async () => {
    const { fetchImpl, calls } = makeRouter({});
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.send("hi", { model: "opus" })).rejects.toThrow(/Claude-only/);
    await expect(session.send("hi", { effort: "high" })).rejects.toThrow(/Claude-only/);
    expect(calls.length).toBe(0);
  });

  it("REJECTS an over-length prompt before any network call, never truncating", async () => {
    const { fetchImpl, calls } = makeRouter({});
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.send("y".repeat(8001))).rejects.toThrow(/8,?000/);
    expect(calls.length).toBe(0);
  });

  it("accepts a prompt at exactly the 8000-char bound", async () => {
    let startBody: unknown;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([]),
      "POST /api/chat/start": (init) => {
        startBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {});
      },
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const prompt = "y".repeat(8000);
    await session.send(prompt);
    expect((startBody as { message: string }).message).toBe(prompt);
  });

  it("fails clearly when the pre-send read times out and never claims the prompt started", async () => {
    const neverResolves = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ requestTimeoutMs: 20 }),
      fetchImpl: neverResolves,
      passwordReader: fakePasswordReader,
    });
    await expect(session.send("hi")).rejects.toThrow(/prompt was not sent/);
  });

  it("returns status:running with the pre-send cursor when the chat/start call itself times out", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([{ role: "user", content: "a" }]),
      "POST /api/chat/start": (init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ requestTimeoutMs: 20 }),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const result = await session.send("hi");
    expect(result).toEqual({ status: "running", report: "", cursor: 1 });
  });

  it("throws on a non-2xx status from chat/start", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([]),
      "POST /api/chat/start": () => textResponse(500, "boom"),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.send("hi")).rejects.toThrow(/status 500/);
  });
});

describe("HermesSession.read — GET /api/session?session_id=...&messages=1, shape-validated", () => {
  it("renders only messages newer than the supplied cursor and returns the new count", async () => {
    const { fetchImpl, calls } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () =>
        sessionResponse([
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ]),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const full = await session.read();
    expect(full.text).toBe("[user] one\n[assistant] two\n[user] three");
    expect(full.cursor).toBe(3);
    expect(full.idle).toBe(true);

    const partial = await session.read({ cursor: 2 });
    expect(partial.text).toBe("[user] three");
    expect(partial.cursor).toBe(3);

    const sessionCall = calls.find((c) => c.url.includes("/api/session"));
    expect(sessionCall?.url).toBe("http://127.0.0.1:9999/api/session?session_id=agent-a&messages=1");
    expect(sessionCall?.init?.method).toBe("GET");
  });

  it("idle is false while active_stream_id is present", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([{ role: "assistant", content: "..." }], "stream-123"),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    const result = await session.read();
    expect(result.idle).toBe(false);
  });

  it("accepts a null active_stream_id as idle", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => jsonResponse(200, { session: { messages: [], active_stream_id: null } }),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    expect((await session.read()).idle).toBe(true);
  });

  it("renders the reference content-block array form", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () =>
        jsonResponse(200, {
          session: {
            messages: [{ role: "assistant", content: [{ text: "hello" }, { text: "world" }] }],
          },
        }),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    expect((await session.read()).text).toBe("[assistant] hello world");
  });

  it("rejects a non-integer, negative, or over-limit cursor without making a network call", async () => {
    const { fetchImpl, calls } = makeRouter({});
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig(),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.read({ cursor: 1.5 })).rejects.toThrow(/invalid Hermes read cursor/);
    await expect(session.read({ cursor: -1 })).rejects.toThrow(/invalid Hermes read cursor/);
    await expect(session.read({ cursor: 1_000_001 })).rejects.toThrow(/invalid Hermes read cursor/);
    expect(calls.length).toBe(0);
  });

  it("throws when the session envelope is missing", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => jsonResponse(200, { notSession: true }),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await expect(session.read()).rejects.toThrow(/expected shape/);
  });

  it("throws when messages is not an array", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => jsonResponse(200, { session: { messages: "nope" } }),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await expect(session.read()).rejects.toThrow(/expected shape/);
  });

  it("throws when a message is missing role/content", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => jsonResponse(200, { session: { messages: [{ role: "user" }] } }),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await expect(session.read()).rejects.toThrow(/expected shape/);
  });

  it("throws when active_stream_id is present but not a string", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => jsonResponse(200, { session: { messages: [], active_stream_id: 42 } }),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await expect(session.read()).rejects.toThrow(/expected shape/);
  });

  it("throws on a non-JSON response", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => textResponse(200, "not json"),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await expect(session.read()).rejects.toThrow(/non-JSON/);
  });

  it("enforces the response size cap WHILE STREAMING a real Response body, never unbounded .text() first", async () => {
    const big = "x".repeat(5000);
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => new Response(big, { status: 200 }),
    });
    const session = HermesSession.attach({
      agentId: "agent-a",
      config: makeConfig({ maxResponseBytes: 100 }),
      fetchImpl,
      passwordReader: fakePasswordReader,
    });
    await expect(session.read()).rejects.toThrow(/exceeded/);
  });
});

describe("HermesSession.isAlive / isWorking — always query live state", () => {
  it("isAlive is true on a healthy session read, false on failure", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([]),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    expect(await session.isAlive()).toBe(true);

    const { fetchImpl: failingFetch } = makeRouter({
      "POST /api/auth/login": () => textResponse(500, "down"),
    });
    const dead = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl: failingFetch, passwordReader: fakePasswordReader });
    expect(await dead.isAlive()).toBe(false);
  });

  it("isWorking reflects the CURRENT active_stream_id on every call, not a stale flag from a prior send/read", async () => {
    let busy = true;
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => loginResponse(),
      "GET /api/session": () => sessionResponse([], busy ? "stream-1" : undefined),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    expect(await session.isWorking()).toBe(true);
    busy = false;
    expect(await session.isWorking()).toBe(false);
  });

  it("isWorking is false when the underlying query fails", async () => {
    const { fetchImpl } = makeRouter({
      "POST /api/auth/login": () => textResponse(500, "down"),
    });
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    expect(await session.isWorking()).toBe(false);
  });
});

describe("HermesSession — interrupt/close are safe no-ops (no tmux pane, no owned agent to destroy)", () => {
  it("interrupt() resolves without a network call", async () => {
    const { fetchImpl, calls } = makeRouter({});
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await session.interrupt();
    expect(calls.length).toBe(0);
  });

  it("close() resolves without a network call (Tandem never destroys an agent it didn't create)", async () => {
    const { fetchImpl, calls } = makeRouter({});
    const session = HermesSession.attach({ agentId: "agent-a", config: makeConfig(), fetchImpl, passwordReader: fakePasswordReader });
    await session.close();
    expect(calls.length).toBe(0);
  });
});

// ---- U-R1A-16: A1.1's Hermes steps through the router, against a test-only Hermes server ----
//
// The server below is the only Hermes these cases reach: node:http on 127.0.0.1, port 0, closed in
// afterAll. It serves the three WebUI routes the adapter uses and counts requests per path.

type Msg = { role: string; content: string };

async function startTestHermes(password: string) {
  const cookies = new Set<string>();
  const sessions = new Map<string, { messages: Msg[]; active_stream_id: string | null }>([
    ["r1a16-agent", { messages: [], active_stream_id: null }],
  ]);
  const counts: Record<string, number> = {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let n = 0;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = `${req.method} ${u.pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try {
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = {};
    }
    const reply = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const signedIn = cookies.has(String(req.headers.cookie ?? "").trim());
    if (key === "POST /api/auth/login") {
      if (body.password !== password) return reply(401, { error: "wrong password" });
      const cookie = `r1a16sid=${++n}`;
      cookies.add(cookie);
      return reply(200, { ok: true }, { "set-cookie": `${cookie}; Path=/; HttpOnly` });
    }
    if (key === "GET /api/session") {
      if (!signedIn) return reply(401, { error: "sign in" });
      const s = sessions.get(u.searchParams.get("session_id") ?? "");
      if (!s || u.searchParams.get("messages") !== "1") return reply(404, { error: "no such session" });
      return reply(200, { session: s });
    }
    if (key === "POST /api/chat/start") {
      if (!signedIn) return reply(401, { error: "sign in" });
      const s = sessions.get(String(body.session_id));
      if (!s) return reply(404, { error: "no such session" });
      const text = String(body.message);
      s.messages.push({ role: "user", content: text });
      s.active_stream_id = `r1a16-stream-${++n}`;
      const t = setTimeout(() => {
        timers.delete(t);
        s.messages.push({ role: "assistant", content: `reply: ${text}` });
        s.active_stream_id = null;
      }, 300);
      timers.add(t);
      return reply(200, { stream_id: s.active_stream_id });
    }
    return reply(404, { error: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    count: (key: string) => counts[key] ?? 0,
    total: () => Object.values(counts).reduce((a, b) => a + b, 0),
    messageCount: (id: string) => sessions.get(id)?.messages.length ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Awaited env helper, as in test/router-engines.test.ts: the routed call finishes before the
// variables are put back.
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("Hermes through the router on a test-only server (U-R1A-16, A1.1)", () => {
  const box = mkdtempSync("/tmp/r1a16-hermes-");
  const passwordFile = join(box, "password");
  const wrongPasswordFile = join(box, "wrong-password");
  writeFileSync(passwordFile, "r1a16-password\n", { mode: 0o600 });
  writeFileSync(wrongPasswordFile, "r1a16-not-it\n", { mode: 0o600 });
  let hermes: Awaited<ReturnType<typeof startTestHermes>>;
  beforeAll(async () => {
    hermes = await startTestHermes("r1a16-password");
  });
  afterAll(async () => {
    await hermes.close();
    rmSync(box, { recursive: true, force: true });
  });

  const env = (over: Record<string, string | undefined> = {}) => ({
    TANDEM_ENABLED_ENGINES: "hermes",
    TANDEM_HERMES_BASE_URL: hermes.url,
    TANDEM_HERMES_WRITABLE_AGENTS: "r1a16-agent,r1a16-ghost",
    TANDEM_HERMES_PASSWORD_PATH: passwordFile,
    TANDEM_HERMES_DISABLE_LIVE: "0",
    ...over,
  });
  type Body = Record<string, unknown> & { error?: string; sessions?: { id: string; engine: string; live: boolean }[] };
  const call = async (method: string, path: string, body: Record<string, unknown> = {}, query = "", over = {}) => {
    const res = await withEnv(env(over), () => routeForTest(method, path, body, query));
    return { status: res.status, body: res.body as Body };
  };
  const open = (name: string, extra: Record<string, unknown> = {}, over = {}) =>
    call("POST", "/sessions/open", { name, engine: "hermes", ...extra }, "", over);
  const listed = async () => ((await call("GET", "/sessions", {}, "engine=hermes")).body.sessions ?? []).map((s) => s.id);

  describe("A1.1 steps", () => {
    let cursor = 0;
    let token = "";

    it("start: open attaches and checks the agent answers (one login, one session read)", async () => {
      const logins = hermes.count("POST /api/auth/login");
      const reads = hermes.count("GET /api/session");
      const res = await open("r1a16-agent");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "r1a16-agent", engine: "hermes" });
      expect(res.body).not.toHaveProperty("reused");
      expect(hermes.count("POST /api/auth/login")).toBe(logins + 1);
      expect(hermes.count("GET /api/session")).toBe(reads + 1);
    });

    it("ready: the session lists live under engine=hermes", async () => {
      const res = await call("GET", "/sessions", {}, "engine=hermes");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([expect.objectContaining({ id: "r1a16-agent", engine: "hermes", live: true })]);
    });

    it("send: a unique token starts a turn (status running, cursor = the message count before)", async () => {
      token = `r1a16-token-${process.pid}-${Date.now()}`;
      const before = hermes.messageCount("r1a16-agent");
      const starts = hermes.count("POST /api/chat/start");
      const res = await call("POST", "/sessions/r1a16-agent/send", { text: token });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "running", engine: "hermes", cursor: before });
      expect(hermes.count("POST /api/chat/start")).toBe(starts + 1);
      cursor = res.body.cursor as number;
    });

    it("wait and read: reads from the cursor reach idle within 5 s and hold the reply", async () => {
      const deadline = Date.now() + 5000;
      let page: Body = {};
      for (;;) {
        page = (await call("GET", "/sessions/r1a16-agent/read", {}, `cursor=${cursor}`)).body;
        if (page.idle === true || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(page.idle).toBe(true);
      expect(page.text).toContain(`reply: ${token}`);
    });

    it("interrupt: 200 with no request to Hermes", async () => {
      const before = hermes.total();
      const res = await call("POST", "/sessions/r1a16-agent/interrupt");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, engine: "hermes" });
      expect(hermes.total()).toBe(before);
    });

    it("close: 200, no request to Hermes, and no longer listed", async () => {
      const before = hermes.total();
      const res = await call("POST", "/sessions/r1a16-agent/close");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, engine: "hermes" });
      expect(hermes.total()).toBe(before);
      expect(await listed()).not.toContain("r1a16-agent");
    });
  });

  describe("an agent that does not answer is not opened", () => {
    it("an allowlisted id Hermes does not know: 503 did not answer, not listed, a second open is not reused", async () => {
      for (let i = 0; i < 2; i++) {
        const res = await open("r1a16-ghost");
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/did not answer/);
        expect(res.body).not.toHaveProperty("reused");
      }
      expect(await listed()).not.toContain("r1a16-ghost");
    });

    it("a wrong password: 503", async () => {
      await call("POST", "/sessions/r1a16-agent/close");
      const res = await open("r1a16-agent", {}, { TANDEM_HERMES_PASSWORD_PATH: wrongPasswordFile });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/did not answer/);
      expect(await listed()).not.toContain("r1a16-agent");
    });

    it("TANDEM_HERMES_DISABLE_LIVE=1: 503 with no request", async () => {
      await call("POST", "/sessions/r1a16-agent/close");
      const before = hermes.total();
      const res = await open("r1a16-agent", {}, { TANDEM_HERMES_DISABLE_LIVE: "1" });
      expect(res.status).toBe(503);
      expect(hermes.total()).toBe(before);
    });
  });

  describe("refusals before any request", () => {
    it.each(["cwd", "model", "effort"])("%s given: 400", async (field) => {
      const before = hermes.total();
      const res = await open("r1a16-agent", { [field]: field === "cwd" ? "/tmp" : "high" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${field} is not supported for engine "hermes"`);
      expect(hermes.total()).toBe(before);
    });

    it("hermes not enabled: 403", async () => {
      const before = hermes.total();
      const res = await open("r1a16-agent", {}, { TANDEM_ENABLED_ENGINES: undefined });
      expect(res.status).toBe(403);
      expect(hermes.total()).toBe(before);
    });

    it("an id not on the allowlist: 403", async () => {
      const before = hermes.total();
      const res = await open("r1a16-stranger");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not on the writable-agent allowlist/);
      expect(hermes.total()).toBe(before);
    });

    it("base URL unset: 503", async () => {
      const before = hermes.total();
      const res = await open("r1a16-agent", {}, { TANDEM_HERMES_BASE_URL: undefined });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/);
      expect(hermes.total()).toBe(before);
    });
  });
});
