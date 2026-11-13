/**
 * U-R1A-52: the `usage` tool (bridge/usage/report.ts): per account the 5-hour and 7-day shares,
 * reset times, tokens and cost, each reading's age and the computer it came from; readings of other
 * computers ride inside the signed presence body (bridge/hub-presence.ts); the freshest share
 * reading wins, tokens are summed; most_room names per agent the account with the most room.
 *
 * Before any import: TZ=UTC, TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a52- folder,
 * every agent folder variable and proxy variable unset, TANDEM_HUB_LINK_ID=alpha (this computer).
 * The clock is fake (T, year 2033) wherever a case can pass one; the ccusage helper is a fake `sh`
 * script. No agent program starts and no real agent folder is opened.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "OPENCODE_DATA_DIR", "ANTIGRAVITY_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
process.env.TZ = "UTC";
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "r1a52-")));
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith("..")) throw new Error("r1a52: temp folder is under the real home");
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.HOME = join(BOX, "home");
mkdirSync(process.env.HOME, { mode: 0o700 });
for (const v of [...VARS, ...PROXIES, "TANDEM_HUB_LINK_URL", "TANDEM_HUB_LINK_TOKEN", "TANDEM_CALLER_TOKEN"]) delete process.env[v];
process.env.TANDEM_HUB_LINK_ID = "alpha";

const report = await import("../../bridge/usage/report.ts");
const { buildReport, createUsageReport } = report;
const hp = await import("../../bridge/hub-presence.ts");
const { hubPresence, readRemotePresence, readRemoteUsage } = hp;
const { recordReadings, recordTokens } = await import("../../bridge/usage/store.ts");
const { stopTokens } = await import("../../bridge/usage/ccusage.ts");
const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { openDeviceKey } = await import("../../bridge/device-keys.ts");
const { signEnvelope, openEnvelope } = await import("../../bridge/envelope.ts");
const { initRoster, makeOffer, receiveOffer, trustOffer } = await import("../../bridge/roster.ts");
const { createPresence } = await import("../../bridge/presence.ts");
const { buildMcpServer } = await import("../../src/mcp-server.ts");
const { handleHubRequest } = await import("../../bridge/hub-rpc.ts");
const { CCM_FRAME_TYPES } = await import("../../hub/src/protocol.ts");
const { setProcessCaller } = await import("../../bridge/caller-tokens.ts");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILTIN = join(ROOT, "harnesses");
const H = () => [...loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.values()];

/** The fake clock: year 2033, far from the real one, so a read of the system clock shows as a wrong age. */
const T = 2_000_000_000_000;
let clock = T;
const now = () => clock;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ME = "alpha";

/* ---- the wire and answer rules, written out here (not imported) ---- */
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLAN_RE = /^[a-z0-9_-]{1,32}$/;
const REASON_RE = /^(helper missing|timed out|exit -?[0-9]{1,5}|signal [A-Z0-9]{1,20}|output not readable|folder name has a comma|folder missing|spawn [A-Z_0-9]{1,40}|spawn error)$/;
const COMPUTER_RE = /^[a-z0-9._-]{1,64}$/;
const REASON_SRC = REASON_RE.source.slice(1, -1);
const TEMPLATES = [
  /^stale: [a-z0-9-]+ account [a-z0-9-]+ \(read on [a-z0-9._-]+\) has not reported for \d+ min; its shares may be out of date$/,
  /^stale: [a-z0-9-]+ account [a-z0-9-]+ tokens were last read \d+ min ago$/,
  /^unknown: [a-z0-9-]+ account [a-z0-9-]+ (five_hour|seven_day) passed its reset; its share is unknown until the next reading$/,
  /^room: no [a-z0-9-]+ account has a fresh share$/,
  /^refresh: tokens are still being read; each token reading shows its age$/,
  /^refresh: limits could not be re-read \(([A-Z_0-9]{1,40}|error)\)$/,
  new RegExp(`^tokens: not available on [a-z0-9._-]+: ${REASON_SRC}(, [a-z0-9._-]+: ${REASON_SRC})*$`),
  /^limit: not available$/,
];
const WIRE_KEYS = ["agent", "account", "at", "five_used", "five_resets", "seven_used", "seven_resets", "plan", "tokens_at", "tokens_today", "tokens_total", "cost_today", "cost_total", "reason"];
const ANSWER_KEYS = ["computer", "at", "accounts", "most_room", "notices"];
const ACCOUNT_KEYS = ["agent", "account", "computer", "at", "ageMs", "stale", "five_hour", "seven_day", "plan", "room", "tokens", "cost_usd", "tokens_at", "tokens_age_ms", "tokens_computers", "tokens_note", "limit_note"];

/** Every string value in `v` (deep). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}
const allowedString = (s: string) =>
  AGENT_RE.test(s) || ACCOUNT_RE.test(s) || COMPUTER_RE.test(s) || PLAN_RE.test(s) || REASON_RE.test(s) || TEMPLATES.some((t) => t.test(s));
/** Answers collected by (b), (d) and (h) for (i). */
const collected: Json[] = [];

/* ---- worlds: a fresh HOME and TANDEM_HOME under BOX ---- */
let worldN = 0;
function world(): { home: string; th: string } {
  const w = join(BOX, `w${++worldN}`);
  const home = join(w, "home");
  const th = join(w, "tandem");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(th, { mode: 0o700 });
  process.env.HOME = home;
  process.env.TANDEM_HOME = th;
  return { home, th };
}

/** A claude drop file, written as statusline-drop.ts writes it (0600 in a 0700 folder); windows `[used, resetsMs]`. */
function drop(account: string, at: number, five?: [number, number], seven?: [number, number]) {
  const dir = join(process.env.TANDEM_HOME!, "usage", "claude");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(process.env.TANDEM_HOME!, "usage"), 0o700);
  chmodSync(dir, 0o700);
  const win = (w: [number, number]) => ({ used_percentage: w[0], resets_at: w[1] / 1000 });
  const rate_limits = { ...(five ? { five_hour: win(five) } : {}), ...(seven ? { seven_day: win(seven) } : {}) };
  const file = join(dir, `${account}.json`);
  writeFileSync(file, JSON.stringify({ at, rate_limits }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/* ---- the fake ccusage helper: one log line per run; `mode` hang = exec sleep 600 ---- */
const FAKE_DIR = join(BOX, "fake");
mkdirSync(FAKE_DIR);
const FAKE = join(FAKE_DIR, "fake-ccusage.sh");
const LOG = join(FAKE_DIR, "log");
writeFileSync(FAKE, `#!/bin/sh
D='${FAKE_DIR}'
echo "$1" >> "$D/log"
mode=$(cat "$D/mode" 2>/dev/null || true)
if [ "$mode" = hang ]; then exec sleep 600; fi
echo '{"daily":[{"date":"2033-05-18","totalTokens":100,"totalCost":0.5}],"totals":{"totalTokens":100,"totalCost":0.5}}'
`);
chmodSync(FAKE, 0o755);
const runs = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0);
const setMode = (m: string) => writeFileSync(join(FAKE_DIR, "mode"), m);

/** A wire row with every field null but agent, account and `at`; `over` replaces fields. */
const wire = (over: Json = {}): Json => ({
  agent: "claude", account: "claude-a", at: T, five_used: null, five_resets: null, seven_used: null, seven_resets: null, plan: null,
  tokens_at: null, tokens_today: null, tokens_total: null, cost_today: null, cost_total: null, reason: null, ...over,
});
const R5 = T + 2 * HOUR;
const R7 = T + 3 * DAY;
const acct = (a: Json, agent: string, account: string) => a.accounts.find((x: Json) => x.agent === agent && x.account === account);

/* ---- an MCP client on buildMcpServer with only a usage report ---- */
async function usageClient(r: Json) {
  const server = await buildMcpServer(undefined, undefined, undefined, undefined, undefined, undefined, r);
  const client = new Client({ name: "r1a52", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (args: Json = {}) => {
    const res = await client.callTool({ name: "usage", arguments: args });
    return JSON.parse((res.content as { text: string }[])[0].text);
  };
  return { client, server, call, close: async () => { await client.close(); await server.close(); } };
}

/* ---- the fake hub (node:http) and keys, as test/hub-presence.test.ts ---- */
const A = openDeviceKey({ path: join(BOX, "keys", "alpha", "device.key") });
const B = openDeviceKey({ path: join(BOX, "keys", "beta", "device.key") });
const TOKEN = "p".repeat(40);
type Seen = { path: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let onPresence: (body: Json) => { status: number; body: unknown } = () => ({ status: 200, body: { presence: [], connected: [] } });
let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      const a = onPresence(JSON.parse(s.body));
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  stopTokens();
  await new Promise((resolve) => server.close(resolve));
  const sock = join(BOX, `tmux-${process.getuid!()}`, "default");
  if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  rmSync(BOX, { recursive: true, force: true });
});
afterEach(() => {
  stopTokens();
});
const cfg = { get url() { return `ws://127.0.0.1:${port}`; }, token: TOKEN, bridgeId: "alpha" };
let dbs = 0;
const dbPath = () => join(BOX, "db", String(++dbs), "state.db");
/** A world with a roster rooted at alpha, beta trusted. */
function rosterWorld() {
  const w = world();
  initRoster(A, "alpha", clock);
  receiveOffer(JSON.stringify(makeOffer(B, "beta", clock)), clock);
  trustOffer(A, B.fingerprint, clock);
  return w;
}
function fakePresence(names: string[]) {
  return createPresence({
    now,
    computer: "alpha",
    list: async () => names.map((id) => ({ id, engine: "shell", project: "work", cwd: `/tmp/r1a52-x/${id}`, live: true, updatedAt: clock, attachHint: "" }) as Json),
    live: () => undefined,
    remote: { read: () => [] },
  });
}
const pushedBody = (s: Seen) => {
  const items = JSON.parse(s.body).presence as { to: string; envelope: string }[];
  const opened = openEnvelope(items[0].envelope, { sender: { id: "alpha", publicKey: A.publicKey }, self: "beta", seen: { remember: () => true }, now: clock, maxAgeMs: 60_000, kind: "presence" });
  return { body: JSON.parse(opened.body), envelope: items[0].envelope };
};
const AUDIT = () => join(process.env.TANDEM_HOME!, "bridge.log");
const auditLines = (): Json[] => (existsSync(AUDIT()) ? readFileSync(AUDIT(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const reading = (over: Json = {}) => ({
  v: 1, kind: "presence", at: clock,
  sessions: [{ name: "b-one", engine: "shell", project: "work", state: "idle", stateAt: clock }],
  more: 0, ...over,
});
const envelope = (body: Json, ts = clock) => JSON.stringify(signEnvelope(B, { from: "beta", to: "alpha", body: JSON.stringify(body) }, ts, "presence"));
const answerWith = (env: string) => ({ status: 200, body: { presence: [{ from: "beta", envelope: env, at: clock }], connected: ["alpha", "beta"] } });

describe("(52) usage report", { timeout: 30_000 }, () => {
  it("(52) (a) shape: buildReport gives exactly the UsageAnswer and UsageAccount keys in order; accounts sorted by agent, account; most_room one row per agent", () => {
    const a = buildReport({
      now: T,
      computer: ME,
      local: [
        wire({ agent: "codex", account: "codex-b", at: T - 1000, five_used: 10, five_resets: R5, plan: "pro" }),
        wire({ agent: "claude", account: "claude-b", at: T - 1000, five_used: 30, five_resets: R5, tokens_at: T - 2000, tokens_today: 1, tokens_total: 2, cost_today: 0.5, cost_total: 1 }),
      ],
      remote: [{ computer: "beta", receivedMs: T, rows: [wire({ agent: "claude", account: "claude-a", at: T - 5000, seven_used: 20, seven_resets: R7 }), wire({ agent: "grok", account: "grok", at: null, tokens_at: T - 1000, reason: "helper missing" })] }],
    }) as Json;
    expect(Object.keys(a)).toEqual(ANSWER_KEYS);
    expect(a.computer).toBe(ME);
    expect(a.at).toBe(T);
    expect(a.accounts.map((x: Json) => `${x.agent}/${x.account}`)).toEqual(["claude/claude-a", "claude/claude-b", "codex/codex-b", "grok/grok"]);
    for (const x of a.accounts) {
      expect(Object.keys(x)).toEqual(ACCOUNT_KEYS);
      expect(Object.keys(x.five_hour)).toEqual(["used", "resets_at"]);
      expect(Object.keys(x.seven_day)).toEqual(["used", "resets_at"]);
    }
    const b = acct(a, "claude", "claude-b");
    expect(Object.keys(b.tokens)).toEqual(["today", "total"]);
    expect(Object.keys(b.cost_usd)).toEqual(["today", "total"]);
    expect(b).toMatchObject({ computer: ME, at: T - 1000, ageMs: 1000, stale: false, room: 70, tokens: { today: 1, total: 2 }, cost_usd: { today: 0.5, total: 1 }, tokens_at: T - 2000, tokens_age_ms: 2000, tokens_computers: [ME] });
    expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: "beta", at: T - 5000, ageMs: 5000, room: 80, tokens: null, cost_usd: null, tokens_at: null, tokens_age_ms: null, tokens_computers: [] });
    expect(acct(a, "grok", "grok")).toMatchObject({ computer: null, at: null, ageMs: null, room: null, tokens_note: "tokens: not available on beta: helper missing", limit_note: "limit: not available" });
    expect(a.most_room).toEqual([
      { agent: "claude", account: "claude-a", computer: "beta", room: 80 },
      { agent: "codex", account: "codex-b", computer: ME, room: 90 },
      { agent: "grok", account: null, computer: null, room: null },
    ]);
    for (const r of a.most_room) expect(Object.keys(r)).toEqual(["agent", "account", "computer", "room"]);
  });

  it("(52) (b) A11.3 through the MCP tool, fake clock: age, stale after 30 min with its notice, a new drop seen only with refresh, unknown past the reset", async () => {
    world();
    clock = T;
    const r = createUsageReport({ now, harnesses: H(), ccusage: { bin: FAKE } });
    const c = await usageClient(r);
    try {
      drop("claude-a", T, [40, R5], [20, R7]);
      let a = await c.call({ refresh: true });
      collected.push(a);
      expect(a.computer).toBe(ME);
      expect(a.at).toBe(T);
      expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: ME, at: T, ageMs: 0, stale: false, room: 60, five_hour: { used: 40, resets_at: R5 }, seven_day: { used: 20, resets_at: R7 } });
      expect(a.notices).toEqual([]);

      clock = T + 31 * MIN;
      a = await c.call({});
      collected.push(a);
      expect(acct(a, "claude", "claude-a")).toMatchObject({ ageMs: 1_860_000, stale: true, room: null });
      expect(a.notices).toContain(`stale: claude account claude-a (read on ${ME}) has not reported for 31 min; its shares may be out of date`);

      drop("claude-a", T + 31 * MIN, [70, R5], [20, R7]);
      a = await c.call({});
      collected.push(a);
      expect(acct(a, "claude", "claude-a")).toMatchObject({ ageMs: 1_860_000, stale: true, five_hour: { used: 40 } });
      a = await c.call({ refresh: true });
      collected.push(a);
      expect(acct(a, "claude", "claude-a")).toMatchObject({ at: T + 31 * MIN, ageMs: 0, stale: false, five_hour: { used: 70, resets_at: R5 }, room: 30 });
      expect(a.notices).toEqual([]);

      clock = R5 + 1000;
      a = await c.call({});
      collected.push(a);
      const x = acct(a, "claude", "claude-a");
      expect(x.five_hour).toEqual({ used: null, resets_at: R5 });
      expect(x.seven_day).toEqual({ used: 20, resets_at: R7 });
      expect(a.notices).toContain("unknown: claude account claude-a five_hour passed its reset; its share is unknown until the next reading");
      for (const row of a.accounts) expect(typeof row.ageMs === "number" || typeof row.tokens_age_ms === "number").toBe(true);
    } finally {
      await c.close();
    }
  });

  it("(52) (c) freshest wins: the newer share reading and its computer; ties go to this computer, then the lower id; a remote time counts no later than its arrival", () => {
    const f5 = (u: number) => ({ five_used: u, five_resets: R5 });
    let a = buildReport({ now: T, computer: ME, local: [wire({ at: T - 120_000, ...f5(20) })], remote: [{ computer: "beta", receivedMs: T, rows: [wire({ at: T - 60_000, ...f5(50) })] }] }) as Json;
    expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: "beta", at: T - 60_000, ageMs: 60_000, five_hour: { used: 50 } });
    a = buildReport({ now: T, computer: ME, local: [wire({ at: T - 60_000, ...f5(20) })], remote: [{ computer: "beta", receivedMs: T, rows: [wire({ at: T - 60_000, ...f5(50) })] }] }) as Json;
    expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: ME, five_hour: { used: 20 } });
    a = buildReport({ now: T, computer: ME, local: [], remote: [
      { computer: "gamma", receivedMs: T, rows: [wire({ at: T - 60_000, ...f5(70) })] },
      { computer: "beta", receivedMs: T, rows: [wire({ at: T - 60_000, ...f5(50) })] },
    ] }) as Json;
    expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: "beta", five_hour: { used: 50 } });
    a = buildReport({ now: T, computer: ME, local: [], remote: [{ computer: "beta", receivedMs: T - 30_000, rows: [wire({ at: T + 10 * MIN, ...f5(50) })] }] }) as Json;
    expect(acct(a, "claude", "claude-a")).toMatchObject({ computer: "beta", at: T - 30_000, ageMs: 30_000, stale: false });
  });

  it("(52) (d) tokens: summed over computers with numbers; a failed computer named in tokens_note; only failures give null; limit_note for agents with no limit source; a tokens-only account goes stale", () => {
    const nums = (at: number, k: number) => ({ tokens_at: at, tokens_today: 10 * k, tokens_total: 100 * k, cost_today: 0.25 * k, cost_total: 0.5 * k });
    let a = buildReport({ now: T, computer: ME, local: [wire({ at: null, ...nums(T - 60_000, 1) })], remote: [{ computer: "beta", receivedMs: T, rows: [wire({ at: null, ...nums(T - 120_000, 2) })] }] }) as Json;
    collected.push(a);
    expect(acct(a, "claude", "claude-a")).toMatchObject({ tokens: { today: 30, total: 300 }, cost_usd: { today: 0.75, total: 1.5 }, tokens_computers: [ME, "beta"].sort(), tokens_at: T - 120_000, tokens_age_ms: 120_000, tokens_note: null });
    a = buildReport({ now: T, computer: ME, local: [wire({ at: null, ...nums(T - 60_000, 1) })], remote: [{ computer: "beta", receivedMs: T, rows: [wire({ at: null, tokens_at: T - 60_000, reason: "helper missing" })] }] }) as Json;
    collected.push(a);
    expect(acct(a, "claude", "claude-a")).toMatchObject({ tokens: { today: 10, total: 100 }, cost_usd: { today: 0.25, total: 0.5 }, tokens_computers: [ME], tokens_note: "tokens: not available on beta: helper missing" });
    a = buildReport({ now: T, computer: ME, local: [wire({ at: null, tokens_at: T - 1000, reason: "timed out" })], remote: [{ computer: "beta", receivedMs: T, rows: [wire({ at: null, tokens_at: T - 1000, reason: "exit 1" })] }] }) as Json;
    collected.push(a);
    expect(acct(a, "claude", "claude-a")).toMatchObject({ tokens: null, cost_usd: null, tokens_computers: [], tokens_note: `tokens: not available on ${ME}: timed out, beta: exit 1` });
    const agents = ["antigravity", "claude", "codex", "grok", "opencode"];
    a = buildReport({ now: T, computer: ME, local: agents.map((g) => wire({ agent: g, account: g, at: null, ...nums(T - 1000, 1) })), remote: [] }) as Json;
    collected.push(a);
    for (const g of ["grok", "antigravity", "opencode"]) expect(acct(a, g, g).limit_note).toBe("limit: not available");
    for (const g of ["claude", "codex"]) expect(acct(a, g, g).limit_note).toBeNull();
    a = buildReport({ now: T, computer: ME, local: [wire({ account: "claude-t", at: null, ...nums(T - 31 * MIN, 1) })], remote: [] }) as Json;
    collected.push(a);
    expect(acct(a, "claude", "claude-t")).toMatchObject({ computer: null, ageMs: null, stale: true, tokens_age_ms: 31 * MIN, room: null });
    expect(a.notices).toContain("stale: claude account claude-t tokens were last read 31 min ago");
  });

  it("(52) (e) most room: 100 minus the higher share, fresh readings only, a window past its reset ignored; ties to the lower name; an agent with none gets nulls and a notice; grok gets nulls and no notice", () => {
    const row = (account: string, at: number, five?: number | [number, number], seven?: number) => wire({
      account, at,
      ...(five === undefined ? {} : Array.isArray(five) ? { five_used: five[0], five_resets: five[1] } : { five_used: five, five_resets: R5 }),
      ...(seven === undefined ? {} : { seven_used: seven, seven_resets: R7 }),
    });
    let a = buildReport({ now: T, computer: ME, local: [row("a", T, 10, 30), row("b", T, 50), row("c", T - 31 * MIN, 0)], remote: [] }) as Json;
    expect(a.accounts.map((x: Json) => x.room)).toEqual([70, 50, null]);
    expect(a.most_room).toEqual([{ agent: "claude", account: "a", computer: ME, room: 70 }]);
    a = buildReport({ now: T, computer: ME, local: [row("a", T, 10, 30), row("b", T, [50, T], 20)], remote: [] }) as Json;
    expect(acct(a, "claude", "b")).toMatchObject({ room: 80, five_hour: { used: null, resets_at: T } });
    expect(a.most_room[0]).toEqual({ agent: "claude", account: "b", computer: ME, room: 80 });
    a = buildReport({ now: T, computer: ME, local: [wire({ account: "d", at: T, five_used: 10, five_resets: T - 1, seven_used: 5, seven_resets: T })], remote: [] }) as Json;
    expect(acct(a, "claude", "d").room).toBeNull();
    expect(a.notices).toEqual([
      "unknown: claude account d five_hour passed its reset; its share is unknown until the next reading",
      "unknown: claude account d seven_day passed its reset; its share is unknown until the next reading",
      "room: no claude account has a fresh share",
    ]);
    a = buildReport({ now: T, computer: ME, local: [row("y", T, 40), row("x", T, 40)], remote: [] }) as Json;
    expect(a.most_room).toEqual([{ agent: "claude", account: "x", computer: ME, room: 60 }]);
    a = buildReport({
      now: T, computer: ME,
      local: [wire({ agent: "codex", account: "codex-a", at: T - 40 * MIN, five_used: 5, five_resets: R5 }), wire({ agent: "grok", account: "grok", at: null, tokens_at: T, tokens_today: 1, tokens_total: 1, cost_today: 0, cost_total: 0 })],
      remote: [],
    }) as Json;
    expect(a.most_room).toEqual([{ agent: "codex", account: null, computer: null, room: null }, { agent: "grok", account: null, computer: null, room: null }]);
    expect(a.notices).toContain("room: no codex account has a fresh share");
    expect(a.notices.filter((n: string) => n.startsWith("room:"))).toEqual(["room: no codex account has a fresh share"]);
  });

  it("(52) (f) refresh token gate: one pass with no rows, none under a minute (another process too), one at a minute; a hanging helper answers with the notice; collectUsage throwing gives its notice and still answers", async () => {
    const { home } = world();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    rmSync(LOG, { force: true });
    setMode("ok");
    clock = T;
    const r = createUsageReport({ now, harnesses: H(), ccusage: { bin: FAKE } });
    let a: Json = await r.read({ refresh: true });
    expect(runs()).toBe(1);
    expect(acct(a, "claude", "claude")).toMatchObject({ tokens: { today: 100, total: 100 }, tokens_at: T, tokens_age_ms: 0 });

    // Another process (a child node, same TANDEM_HOME, its own report and module state) at T + 30 s: the gate reads the rows.
    const code = `
const { loadHarnesses } = await import(${JSON.stringify(join(ROOT, "bridge", "harness-registry.ts"))});
const { createUsageReport } = await import(${JSON.stringify(join(ROOT, "bridge", "usage", "report.ts"))});
const harnesses = [...loadHarnesses({ installDir: ${JSON.stringify(BUILTIN)}, ownerDir: ${JSON.stringify(join(BOX, "no-owner"))} }).harnesses.values()];
const a = await createUsageReport({ now: () => ${T + 30_000}, harnesses, ccusage: { bin: ${JSON.stringify(FAKE)} } }).read({ refresh: true });
process.stdout.write(JSON.stringify(a));
`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env: process.env, encoding: "utf8", timeout: 60_000 });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).at).toBe(T + 30_000);
    expect(runs()).toBe(1);

    clock = T + 59_999;
    await r.read({ refresh: true });
    expect(runs()).toBe(1);
    clock = T + 60_000;
    a = await r.read({ refresh: true });
    expect(runs()).toBe(2);
    expect(acct(a, "claude", "claude").tokens_at).toBe(T + 60_000);

    // collectUsage throws: a Codex rollout to record while TANDEM_HOME is a file.
    const keep = process.env.TANDEM_HOME;
    const day = join(home, ".codex", "sessions", "2033", "05", "18");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-r1a52.jsonl"), JSON.stringify({ timestamp: new Date(T).toISOString(), payload: { rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: R5 / 1000 } } } }) + "\n");
    const asFile = join(BOX, "tandem-as-file");
    writeFileSync(asFile, "");
    process.env.TANDEM_HOME = asFile;
    try {
      clock = T + 5 * MIN;
      a = await createUsageReport({ now, harnesses: H(), ccusage: { bin: FAKE } }).read({ refresh: true });
      expect(Object.keys(a)).toEqual(ANSWER_KEYS);
      expect(a.notices).toContain("refresh: limits could not be re-read (EEXIST)");
    } finally {
      process.env.TANDEM_HOME = keep;
    }
    rmSync(join(home, ".codex"), { recursive: true, force: true });

    // A helper that hangs: the answer comes after refreshWaitMs with the notice; the pass runs on.
    setMode("hang");
    clock = T + 10 * MIN;
    const started = Date.now();
    a = await createUsageReport({ now, harnesses: H(), ccusage: { bin: FAKE }, refreshWaitMs: 300 }).read({ refresh: true });
    const took = Date.now() - started;
    expect(took).toBeLessThan(3000);
    expect(a.notices).toContain("refresh: tokens are still being read; each token reading shows its age");
    expect(acct(a, "claude", "claude").tokens_at).toBe(T + 60_000);
    expect(report.REFRESH_WAIT_MS).toBe(30_000);
    setMode("ok");
  });
});

describe("(52) carriage in the signed presence", { timeout: 30_000 }, () => {
  it("(52) (g) sender: usage rows ride as one more body key with exactly 14 keys each; none in the store = the old five keys; 24 worst-case rows fit with sessions dropped; 30 accounts send the first 24; a store that throws sends sessions only", async () => {
    rosterWorld();
    clock = T;
    seen.length = 0;
    onPresence = () => ({ status: 200, body: { presence: [], connected: [] } });
    // None in the store: exactly the 33B-3 body.
    await hubPresence(cfg, { presence: fakePresence(["s-a"]), key: A, now, path: dbPath() }).syncOnce();
    expect(Object.keys(pushedBody(seen[0]).body)).toEqual(["v", "kind", "at", "sessions", "more"]);

    recordReadings([{ account: "claude-a", agent: "claude", atMs: T - 1000, five: { used: 40, resetsMs: R5 }, seven: { used: 20, resetsMs: R7 }, plan: "max" }], T);
    recordTokens([{ account: "claude-a", agent: "claude", today: { tokens: 5, cost: 0.5 }, total: { tokens: 50, cost: 5 } }, { account: "grok", agent: "grok", reason: "helper missing" }], T - 500);
    await hubPresence(cfg, { presence: fakePresence(["s-a"]), key: A, now, path: dbPath() }).syncOnce();
    const { body } = pushedBody(seen[1]);
    expect(Object.keys(body)).toEqual(["v", "kind", "at", "sessions", "more", "usage"]);
    expect(body.sessions.map((s: Json) => s.name)).toEqual(["s-a"]);
    expect(body.usage).toEqual([
      { agent: "claude", account: "claude-a", at: T - 1000, five_used: 40, five_resets: R5, seven_used: 20, seven_resets: R7, plan: "max", tokens_at: T - 500, tokens_today: 5, tokens_total: 50, cost_today: 0.5, cost_total: 5, reason: null },
      { agent: "grok", account: "grok", at: null, five_used: null, five_resets: null, seven_used: null, seven_resets: null, plan: null, tokens_at: T - 500, tokens_today: null, tokens_total: null, cost_today: null, cost_total: null, reason: "helper missing" },
    ]);
    for (const row of body.usage) {
      expect(Object.keys(row)).toEqual(WIRE_KEYS);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === "string") expect([AGENT_RE, ACCOUNT_RE, PLAN_RE, REASON_RE].some((re) => re.test(v)), k).toBe(true);
        else expect(v === null || typeof v === "number", k).toBe(true);
      }
    }

    // 30 accounts in the store: the first 24 by agent, account.
    rosterWorld();
    recordReadings(Array.from({ length: 30 }, (_, i) => ({ account: `acct-${String(29 - i).padStart(2, "0")}`, agent: "claude", atMs: T - 1000, five: { used: 1, resetsMs: R5 } })), T);
    await hubPresence(cfg, { presence: fakePresence([]), key: A, now, path: dbPath() }).syncOnce();
    expect(pushedBody(seen[2]).body.usage.map((r: Json) => r.account)).toEqual(Array.from({ length: 24 }, (_, i) => `acct-${String(i).padStart(2, "0")}`));

    // A store that throws: sessions still go, no usage key.
    await hubPresence(cfg, { presence: fakePresence(["s-b"]), key: A, now, path: dbPath(), usage: () => { throw new Error("R1A52 store down"); } }).syncOnce();
    const thrown = pushedBody(seen[3]).body;
    expect(Object.keys(thrown)).toEqual(["v", "kind", "at", "sessions", "more"]);
    expect(thrown.sessions.map((s: Json) => s.name)).toEqual(["s-b"]);
  });

  it("(52) (g) worst case: 24 rows with every string at its longest and every number 16 digits fit under 16,384 bytes alone (measured) and with 300 long sessions (sessions dropped, counted in more)", async () => {
    rosterWorld();
    // A 16-digit clock for this case, used by the carrier and its signing alike (U2).
    const W = 9_000_000_000_000_000;
    clock = W;
    seen.length = 0;
    const worst = Array.from({ length: hp.MAX_USAGE_ROWS }, (_, i) => wire({
      agent: "a".repeat(32), account: `${String(i).padStart(2, "0")}${"b".repeat(62)}`, at: W, five_used: 99.99999999999999, five_resets: 9_007_199_254_740_991,
      seven_used: 99.99999999999998, seven_resets: 9_007_199_254_740_990, plan: "p".repeat(32), tokens_at: W, tokens_today: 9_007_199_254_740_991,
      tokens_total: 9_007_199_254_740_990, cost_today: 1234567.891234567, cost_total: 7654321.198765432, reason: `spawn ${"E".repeat(40)}`,
    }));
    expect(hp.MAX_USAGE_ROWS).toBe(24);
    await hubPresence(cfg, { presence: fakePresence([]), key: A, now, path: dbPath(), usage: () => worst }).syncOnce();
    const alone = pushedBody(seen[0]);
    const aloneBytes = Buffer.byteLength(alone.envelope, "utf8");
    process.stderr.write(`(52) (g) 24 worst-case usage rows, no sessions: signed envelope ${aloneBytes} bytes (cap 16,384)\n`);
    expect(aloneBytes).toBeLessThan(16_384);
    expect(alone.body.usage).toEqual(worst);

    const names = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, "0")}${"n".repeat(197)}`);
    await hubPresence(cfg, { presence: fakePresence(names), key: A, now, path: dbPath(), usage: () => worst }).syncOnce();
    const full = pushedBody(seen[1]);
    expect(Buffer.byteLength(full.envelope, "utf8")).toBeLessThanOrEqual(16_384);
    expect(full.body.usage).toHaveLength(24);
    expect(full.body.sessions.length).toBeLessThan(300);
    expect(full.body.more).toBe(300 - full.body.sessions.length);
    clock = T;
    // ~290 sign-and-measure rounds: 62 ms on mini, over 5 s in the Linux container under load.
  }, 30_000);

  it("(52) (h) receiver: a roster member's usage rows are kept with their arrival time; an old-shape body gives []; each bad body is refused as shape with one audit line, the kept reading unchanged; who_is_up rows never carry usage", async () => {
    clock = T;
    const good = [wire({ at: T - 1000, five_used: 40, five_resets: R5, tokens_at: T - 2000, tokens_today: 1, tokens_total: 2, cost_today: 0.5, cost_total: 1 })];
    const fresh = async (body: Json) => {
      rosterWorld();
      const path = dbPath();
      const carrier = hubPresence(cfg, { presence: fakePresence([]), key: A, now, path, usage: () => [] });
      onPresence = () => answerWith(envelope(body));
      await carrier.syncOnce();
      return { path, carrier };
    };
    clock = T;
    let { path } = await fresh(reading({ at: T - 500, usage: good }));
    expect(readRemoteUsage({ path, self: "alpha" })).toEqual([{ computer: "beta", receivedMs: T, rows: good }]);
    const others = readRemotePresence({ now, path, self: "alpha" });
    expect(others).toHaveLength(1);
    expect(Object.keys(others[0])).toEqual(["computer", "at", "ageMs", "stale", "sessions", "more"]);
    expect(JSON.stringify(others)).not.toContain("usage");
    collected.push(buildReport({ now: T, computer: ME, local: [], remote: readRemoteUsage({ path, self: "alpha" }) }));

    ({ path } = await fresh(reading({ at: T - 500 })));
    expect(readRemoteUsage({ path, self: "alpha" })).toEqual([{ computer: "beta", receivedMs: T, rows: [] }]);

    const MARK = "R1A52-TEXT-MARKER";
    const bad: [string, (g: Json[]) => unknown][] = [
      ["a marker in agent", (g) => [{ ...g[0], agent: MARK }]],
      ["a spaced marker in account", (g) => [{ ...g[0], account: "r1a52 text marker" }]],
      ["a marker in plan", (g) => [{ ...g[0], plan: MARK }]],
      ["a marker in reason", (g) => [{ ...g[0], reason: MARK }]],
      ["an extra row key", (g) => [{ ...g[0], model: "x" }]],
      ["a missing row key", (g) => [(({ plan: _p, ...rest }) => rest)(g[0])]],
      ["25 rows", (g) => Array.from({ length: 25 }, (_, i) => ({ ...g[0], account: `acct-${i}` }))],
      ["no rows", () => []],
      ["usage not an array", (g) => g[0]],
      ["a duplicate agent and account", (g) => [g[0], { ...g[0] }]],
      ["used 101", (g) => [{ ...g[0], five_used: 101 }]],
      ["tokens -1", (g) => [{ ...g[0], tokens_today: -1 }]],
      ["a cost as a string", (g) => [{ ...g[0], cost_total: "1" }]],
      ["at over 60 s past the envelope time", (g) => [{ ...g[0], at: T + 2000 + 60_001 }]],
      ["tokens_at after the envelope time", (g) => [{ ...g[0], tokens_at: T + 2001 }]],
      ["at and tokens_at both null", (g) => [{ ...g[0], at: null, tokens_at: null }]],
      ["tokens numbers half null", (g) => [{ ...g[0], tokens_total: null, cost_total: null }]],
    ];
    for (const [what, make] of bad) {
      clock = T;
      const w = await fresh(reading({ at: T - 500, usage: good }));
      const kept = readRemoteUsage({ path: w.path, self: "alpha" });
      clock = T + 2000;
      onPresence = () => answerWith(envelope(reading({ at: T + 2000, usage: make(good) })));
      const n = auditLines().length;
      await w.carrier.syncOnce();
      const lines = auditLines().slice(n).filter((l) => l.event === "presence.refused").map(({ ts: _ts, ...rest }) => rest);
      expect(lines, what).toEqual([{ event: "presence.refused", from: "beta", denied: "shape" }]);
      expect(readRemoteUsage({ path: w.path, self: "alpha" }), what).toEqual(kept);
    }
    clock = T;
  });

  it("(52) (i) numbers only: the answers of (b), (d) and (h) hold no marker, no slash, and only names, reasons and notice templates as strings", () => {
    expect(collected.length).toBeGreaterThanOrEqual(8);
    for (const a of collected) {
      const text = JSON.stringify(a);
      expect(text).not.toContain("R1A52-TEXT-MARKER");
      expect(text).not.toContain("/");
      for (const s of strings(a)) expect(allowedString(s), s).toBe(true);
    }
  });
});

describe("(52) the tool and the hub frame", { timeout: 30_000 }, () => {
  it("(52) (k) hub frame /usage: POST with no body or {} answers 200; refresh true re-reads; GET 404; a body other than { refresh: boolean } 400", async () => {
    world();
    const frame = (method: string, raw?: string) => ({
      type: CCM_FRAME_TYPES.httpRequest, request_id: `r1a52-${Math.random()}`, method, path: "/usage", headers: {},
      ...(raw === undefined ? {} : { body_base64: Buffer.from(raw, "utf8").toString("base64") }),
    }) as Json;
    const send = async (method: string, raw?: string) => {
      const f = await handleHubRequest(frame(method, raw));
      return { status: f.status_code, body: JSON.parse(Buffer.from(f.body_base64 ?? "", "base64").toString("utf8")) };
    };
    for (const raw of [undefined, "{}"]) {
      const r = await send("POST", raw);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body)).toEqual(ANSWER_KEYS);
      expect(r.body.computer).toBe(ME);
    }
    const t = Date.now();
    drop("claude-k", t, [33, Math.ceil((t + 2 * HOUR) / 1000) * 1000]);
    expect(acct((await send("POST", "{}")).body, "claude", "claude-k")).toBeUndefined();
    const r = await send("POST", JSON.stringify({ refresh: true }));
    expect(r.status).toBe(200);
    expect(acct(r.body, "claude", "claude-k")).toMatchObject({ computer: ME, at: t, five_hour: { used: 33 } });
    expect((await send("GET")).status).toBe(404);
    expect((await send("GET")).body).toEqual({ error: "not found" });
    for (const raw of [JSON.stringify({ refresh: "yes" }), JSON.stringify({ x: 1 }), "[]", JSON.stringify("s"), "{not json"]) {
      expect(await send("POST", raw), raw).toEqual({ status: 400, body: { error: "body: only refresh (true or false)" } });
    }
  });

  it("(52) (j) tools: no report = the 7 tools; with one, usage takes only refresh; an agent-served process gets the owner's answer", async () => {
    const bare = await buildMcpServer();
    const bc = new Client({ name: "r1a52", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bare.connect(st), bc.connect(ct)]);
    const names = (await bc.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(7);
    expect(names).not.toContain("usage");
    await bc.close();
    await bare.close();

    world();
    clock = T;
    drop("claude-j", T - 1000, [25, R5], [10, R7]);
    const r = createUsageReport({ now, harnesses: H(), ccusage: { bin: FAKE } });
    const owner = await usageClient(r);
    const tool = (await owner.client.listTools()).tools.find((t) => t.name === "usage")!;
    expect(Object.keys((tool.inputSchema as Json).properties)).toEqual(["refresh"]);
    expect(tool.description).toContain("most_room");
    const ownerAnswer = await owner.call({ refresh: true });
    await owner.close();
    // This process now serves an agent (as an agent's own stdio server would after its caller token).
    setProcessCaller("r1a52-agent");
    const agent = await usageClient(r);
    const agentAnswer = await agent.call({ refresh: true });
    await agent.close();
    expect(agentAnswer).toEqual(ownerAnswer);
    expect(acct(agentAnswer, "claude", "claude-j")).toMatchObject({ five_hour: { used: 25 }, room: 75 });
  });
});
