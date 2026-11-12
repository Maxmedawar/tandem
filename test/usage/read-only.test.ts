/**
 * U-R1A-51 (A11.2): usage is read only. In account folders seeded with `.credentials.json` and
 * `auth.json`, neither is opened by the collector, the statusLine command or ccusage, and no call
 * leaves the computer. The helper is the REAL pinned ccusage binary
 * (`sh packaging/helpers/ccusage/fetch.sh`, digest-checked); on Linux the same cases also run under
 * `strace -e trace=file,network` (evidence/TANDEM-U-R1A-51.txt, LINUX RUN).
 *
 * Before any import: TZ=UTC, TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a51- folder,
 * every agent folder variable and every proxy variable unset. The login files are written once and
 * never read back by the test (removed only with rmSync). No agent program starts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "OPENCODE_DATA_DIR", "ANTIGRAVITY_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
process.env.TZ = "UTC";
const BOX = mkdtempSync(join(tmpdir(), "r1a51-"));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.HOME = join(BOX, "home");
mkdirSync(process.env.HOME);
for (const v of [...VARS, ...PROXIES, "NO_PROXY", "no_proxy"]) delete process.env[v];

const cc = await import("../../bridge/usage/ccusage.ts");
const { collectUsage } = await import("../../bridge/usage/collector.ts");
const { usageSource } = await import("../../bridge/usage/claude.ts");
const { loadHarnesses } = await import("../../bridge/harness-registry.ts");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILTIN = join(ROOT, "harnesses");
const BIN = join(BOX, "ccusage");
const DROP_SCRIPT = join(ROOT, "bridge", "usage", "statusline-drop.ts");
const MARKER = "R1A51-LOGIN-MARKER";
const LOGIN = /\/(\.credentials\.json|auth\.json)$/;
const H = () => [...loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.values()];

afterAll(() => {
  const sock = join(BOX, `tmux-${process.getuid!()}`, "default");
  if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  rmSync(BOX, { recursive: true, force: true });
});

beforeAll(() => {
  const r = spawnSync("sh", [join(ROOT, "packaging", "helpers", "ccusage", "fetch.sh"), BIN], { cwd: ROOT, timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
  expect(r.stderr.toString(), "fetch.sh failed").toBe("");
  expect(r.status).toBe(0);
  expect(fs.statSync(BIN).mode & 0o111).not.toBe(0);
}, 660_000);

/** Before the real binary runs: HOME and TANDEM_HOME are inside this test's folder, else throw. */
function guardHome(): void {
  for (const v of ["HOME", "TANDEM_HOME"]) if (!process.env[v]?.startsWith(BOX + "/")) throw new Error(`${v} is outside the test folder; the real helper does not run`);
}

/** One usage line per agent, from that ccusage adapter's own tests (V4). */
const CLAUDE_LINE = `{"timestamp":"2026-01-02T10:00:00.000Z","sessionId":"session-a","requestId":"req-a","message":{"id":"msg-a","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":1}}}`;
const CODEX_LINES = [
  `{ "timestamp": "2026-01-02T00:00:00.000Z", "type" : "turn_context", "payload": { "model": "gpt-5" } }`,
  `{ "timestamp": "2026-01-02T00:00:01.000Z", "type" : "event_msg", "payload": { "type" : "token_count", "info": { "total_token_usage": { "input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 50, "total_tokens": 150 }, "model": "gpt-5" } } }`,
  `{ "timestamp": "2026-01-02T00:00:02.000Z", "type" : "event_msg", "payload": { "type":"token_count", "info": { "total_token_usage": { "input_tokens": 200, "cached_input_tokens": 20, "output_tokens": 75, "total_tokens": 275 }, "model": "gpt-5" } } }`,
].join("\n");

type World = { home: string; th: string; accounts: { name: string; agent: string }[] };
/** A config folder per agent, each with `.credentials.json` and `auth.json` (0600 marker files, or FIFOs). */
function seed(root: string, fifo: boolean): World {
  const home = join(root, "home");
  const th = join(root, "tandem");
  mkdirSync(home, { recursive: true });
  mkdirSync(th, { mode: 0o700 });
  chmodSync(th, 0o700);
  const folder = (p: string) => {
    mkdirSync(p, { recursive: true });
    for (const n of [".credentials.json", "auth.json"]) {
      if (fifo) expect(spawnSync("mkfifo", ["-m", "600", join(p, n)]).status).toBe(0);
      else writeFileSync(join(p, n), MARKER, { mode: 0o600 });
    }
    return p;
  };
  const claudeB = join(root, "ro-claude-b");
  const codexB = join(root, "ro-codex-b");
  const agB = join(root, "ro-antigravity");
  for (const c of [join(home, ".claude"), claudeB]) {
    folder(c);
    mkdirSync(join(c, "projects", "project-a"), { recursive: true });
    writeFileSync(join(c, "projects", "project-a", "session-a.jsonl"), CLAUDE_LINE + "\n");
  }
  for (const c of [join(home, ".codex"), codexB]) {
    folder(c);
    mkdirSync(join(c, "sessions", "2026", "01", "02"), { recursive: true });
    writeFileSync(join(c, "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-session.jsonl"), CODEX_LINES + "\n");
  }
  folder(join(home, ".grok"));
  folder(join(home, ".local", "share", "opencode"));
  folder(agB);
  writeFileSync(join(th, "usage.toml"), [["claude-b", "claude", claudeB], ["codex-b", "codex", codexB], ["antigravity-b", "antigravity", agB]]
    .map(([n, a, f]) => `[[accounts]]\nname = "${n}"\nagent = "${a}"\nfolder = ${JSON.stringify(f)}\n`).join(""), { mode: 0o600 });
  return {
    home, th,
    accounts: [
      { name: "claude", agent: "claude" }, { name: "claude-b", agent: "claude" }, { name: "codex", agent: "codex" }, { name: "codex-b", agent: "codex" },
      { name: "grok", agent: "grok" }, { name: "opencode", agent: "opencode" }, { name: "antigravity-b", agent: "antigravity" },
    ],
  };
}
const use = (w: World) => { process.env.HOME = w.home; process.env.TANDEM_HOME = w.th; };
const PLAIN = seed(join(BOX, "plain"), false);
const FIFOS = seed(join(BOX, "fifo"), true);

/** Every account's token row holds numbers (claude and codex above zero) and no reason. */
function expectAllRead(w: World, now: number): void {
  const rows = cc.readTokens(now) as any[];
  expect(rows.map((r) => `${r.agent}/${r.account}`).sort()).toEqual(w.accounts.map((a) => `${a.agent}/${a.name}`).sort());
  for (const r of rows) {
    expect(r.tokens_note, `${r.agent}/${r.account}`).toBeNull();
    expect(r.tokens, `${r.agent}/${r.account}`).not.toBeNull();
    if (r.agent === "claude" || r.agent === "codex") expect(r.tokens.total, `${r.agent}/${r.account}`).toBeGreaterThan(0);
  }
}

describe("(51) usage is read only: no login file is opened, no call leaves the computer", () => {
  it("(51) r1 the collector, usageSource, a real ccusage pass and the statusLine command open no .credentials.json or auth.json", async () => {
    use(PLAIN);
    const now = Date.now();
    const drops = join(PLAIN.th, "usage", "claude");
    mkdirSync(drops, { recursive: true, mode: 0o700 });
    chmodSync(join(PLAIN.th, "usage"), 0o700);
    chmodSync(drops, 0o700);
    writeFileSync(join(drops, "claude.json"), JSON.stringify({ at: now, rate_limits: { five_hour: { used_percentage: 3, resets_at: Math.floor(now / 1000) + 600 } } }), { mode: 0o600 });
    const opened: string[] = [];
    const rec = (p: unknown) => opened.push(typeof p === "string" ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : `fd:${String(p)}`);
    const spies = [
      ...(["openSync", "open", "readFileSync", "readFile", "createReadStream"] as const).map((n) => {
        const real = (fs as any)[n];
        return vi.spyOn(fs as any, n).mockImplementation(((p: unknown, ...rest: unknown[]) => { rec(p); return real(p, ...rest); }) as any);
      }),
      ...(["open", "readFile"] as const).map((n) => {
        const real = (fs.promises as any)[n];
        return vi.spyOn(fs.promises as any, n).mockImplementation(((p: unknown, ...rest: unknown[]) => { rec(p); return real(p, ...rest); }) as any);
      }),
    ];
    syncBuiltinESMExports();
    const hs = H();
    try {
      collectUsage(now, hs);
      usageSource(hs.find((h) => h.name === "claude")!);
      guardHome();
      await cc.collectTokens(now, { bin: BIN, harnesses: hs });
    } finally {
      for (const s of spies) s.mockRestore();
      syncBuiltinESMExports();
    }
    expect(opened).toContain(join(drops, "claude.json"));
    expect(opened.filter((p) => LOGIN.test(p))).toEqual([]);
    expectAllRead(PLAIN, now);

    // The statusLine command, as Claude runs it, in its own process under the same spy.
    const spyLog = join(BOX, "child-spy.log");
    const spyMod = join(BOX, "spy.mjs");
    writeFileSync(spyMod, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const append = fs.appendFileSync
let busy = false
const rec = (p) => { if (busy) return; busy = true; try { append(${JSON.stringify(spyLog)}, (typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : 'fd:' + String(p)) + '\\n') } finally { busy = false } }
for (const n of ['openSync', 'open', 'readFileSync', 'readFile', 'createReadStream']) { const real = fs[n]; fs[n] = function (p, ...rest) { rec(p); return real.call(this, p, ...rest) } }
for (const n of ['open', 'readFile']) { const real = fs.promises[n]; fs.promises[n] = function (p, ...rest) { rec(p); return real.call(this, p, ...rest) } }
syncBuiltinESMExports()
`);
    writeFileSync(spyLog, "");
    const input = JSON.stringify({ session_id: "s", rate_limits: { five_hour: { used_percentage: 7, resets_at: Math.floor(now / 1000) + 900 } } });
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--import", spyMod, DROP_SCRIPT, "claude", drops], { input, timeout: 30_000, env: process.env });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(drops, "claude.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(7);
    const childOpened = readFileSync(spyLog, "utf8").split("\n").filter(Boolean);
    expect(childOpened.length).toBeGreaterThan(0);
    expect(childOpened.filter((p) => LOGIN.test(p))).toEqual([]);
  }, 120_000);

  it("(51) r2 FIFO tripwire: login files that block whoever opens them; the real ccusage pass finishes with no `timed out` row", async () => {
    use(FIFOS);
    for (const p of [join(FIFOS.home, ".claude", ".credentials.json"), join(FIFOS.home, ".codex", "auth.json")]) expect(fs.lstatSync(p).isFIFO()).toBe(true);
    const now = Date.now();
    guardHome();
    await cc.collectTokens(now, { bin: BIN, timeoutMs: 20_000, harnesses: H() });
    const rows = cc.readTokens(now) as any[];
    expect(rows.filter((r) => r.tokens_note === "tokens: not available (timed out)")).toEqual([]);
    expectAllRead(FIFOS, now);
  }, 200_000);

  it("(51) r3 no call leaves the computer: a logging proxy in all six proxy variables counts zero requests from a full pass", async () => {
    use(PLAIN);
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => { seen.push(`request ${req.method} ${req.url}`); res.writeHead(502, { connection: "close" }); res.end(); });
    proxy.on("connect", (req, sock) => { seen.push(`connect ${req.url}`); sock.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"); });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as { port: number }).port;
    try {
      // Canary: the proxy counts a CONNECT.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "canary.invalid:443" });
        req.on("connect", (res, sock) => { sock.destroy(); resolve(res.statusCode); });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(502);
      expect(seen).toEqual(["connect canary.invalid:443"]);
      seen.length = 0;
      // The helper gets nothing of the bridge's environment but an allow-list, so the proxy is handed to it by the test option.
      const now = Date.now() + 1000;
      guardHome();
      await cc.collectTokens(now, { bin: BIN, harnesses: H(), extraEnv: Object.fromEntries(PROXIES.map((v) => [v, `http://127.0.0.1:${port}`])) });
      expectAllRead(PLAIN, now);
      expect(seen).toEqual([]);
    } finally {
      await new Promise((r) => proxy.close(r));
    }
  }, 120_000);
});
