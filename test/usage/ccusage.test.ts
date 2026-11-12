/**
 * U-R1A-51: tokens and cost per account, from the pinned ccusage helper (packaging/helpers/ccusage),
 * run once per account folder with only that agent's folder variable, offline, every 10 minutes and
 * on demand at most once a minute, killed (by its process group) after 60 seconds. Grok, Antigravity
 * and OpenCode have no limit source: "limit: not available" (H23).
 *
 * Before any import: TZ=UTC, TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a51- folder,
 * every agent folder variable and every proxy variable unset. The helper here is a fake (`sh`
 * script) that logs its argv, cwd and folder variables, then prints a recorded ccusage output
 * (test/fixtures/usage/ccusage, captured from ccusage 20.0.49 on each adapter's own test inputs,
 * every string blanked but the dates). No agent program starts.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "OPENCODE_DATA_DIR", "ANTIGRAVITY_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
process.env.TZ = "UTC";
const BOX = mkdtempSync(join(tmpdir(), "r1a51-"));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.HOME = join(BOX, "home");
mkdirSync(process.env.HOME);
for (const v of [...VARS, ...PROXIES]) delete process.env[v];

const cc = await import("../../bridge/usage/ccusage.ts");
const { startUsageCollector, collectUsage } = await import("../../bridge/usage/collector.ts");
const { readUsage, recordReadings } = await import("../../bridge/usage/store.ts");
const { codexReadings } = await import("../../bridge/usage/codex.ts");
const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterAll(() => {
  const sock = join(BOX, `tmux-${process.getuid!()}`, "default");
  if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  rmSync(BOX, { recursive: true, force: true });
});

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILTIN = join(ROOT, "harnesses");
const FIXDIR = join(ROOT, "test", "fixtures", "usage", "ccusage");
const AGENTS = ["claude", "codex", "grok", "opencode", "antigravity"] as const;
type Agent = (typeof AGENTS)[number];
const VAR: Record<Agent, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grok: "GROK_HOME", opencode: "OPENCODE_DATA_DIR", antigravity: "ANTIGRAVITY_DATA_DIR" };
const fixture = (a: Agent) => readFileSync(join(FIXDIR, `${a}.json`), "utf8");
/** V4's recorded numbers (ccusage 20.0.49, TZ=UTC): the one daily row's date, and totals. */
const RECORDED: Record<Agent, { date: string; tokens: number; cost: number }> = {
  claude: { date: "2026-01-02", tokens: 101, cost: 0.000315 },
  codex: { date: "2026-01-02", tokens: 275, cost: 0.0009775 },
  grok: { date: "2025-06-15", tokens: 120, cost: 0.000252 },
  opencode: { date: "2026-01-02", tokens: 180, cost: 0.02 },
  antigravity: { date: "2026-05-05", tokens: 1530, cost: 0.005175 },
};
/** V4's empty-folder outputs, verbatim (claude exits 1 on an empty folder: no JSON). */
const EMPTY = {
  codex: `{"daily":[],"totals":{"cacheCreationTokens":0,"cacheReadTokens":0,"costUSD":0,"inputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0}}`,
  grok: `{"daily":[],"totals":{"cacheCreationTokens":0,"cacheReadTokens":0,"inputTokens":0,"outputTokens":0,"totalCost":-0.0,"totalTokens":0}}`,
};
const T0 = Date.parse("2026-01-02T12:00:00Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = () => [...loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.values()];
const harness = (n: string) => H().find((h) => h.name === n)!;

// The fake helper: one log line per run (argv, cwd, each folder variable that is set), then the
// output chosen by `mode.<folder base>` / `mode` and `out.<agent>.<folder base>.json` / the fixture.
const FAKE_DIR = join(BOX, "fake");
mkdirSync(FAKE_DIR);
const FAKE = join(FAKE_DIR, "fake-ccusage.sh");
const LOG = join(FAKE_DIR, "log");
writeFileSync(FAKE, `#!/bin/sh
D='${FAKE_DIR}'
line="$*"
folder=none
for v in CLAUDE_CONFIG_DIR CODEX_HOME GROK_HOME OPENCODE_DATA_DIR ANTIGRAVITY_DATA_DIR; do
  if eval "[ -n \\"\\\${$v+x}\\" ]"; then eval "val=\\$$v"; line="$line $v=$val"; folder=$val; fi
done
echo "$line cwd=$(pwd)" >> "$D/log"
base=$(basename "$folder")
mode=$(cat "$D/mode.$base" 2>/dev/null || cat "$D/mode" 2>/dev/null || true)
case "$mode" in
  exit\\ *) exit \${mode#exit } ;;
  hang) sleep 600 & echo $! > "$D/pids"; echo $$ >> "$D/pids"; exec sleep 600 ;;
  slow) sleep 1 ;;
  text) echo 'not json'; exit 0 ;;
  big) head -c 9437184 /dev/zero | tr '\\0' x; exit 0 ;;
  stderr) echo 'R1A51-STDERR-MARKER' >&2 ;;
  env) env > "$D/env.$1.$base" ;;
esac
out="$D/out.$1.$base.json"; [ -f "$out" ] || out='${FIXDIR}'/"$1.json"
cat "$out"
`);
chmodSync(FAKE, 0o755);
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : []);
/** Every log, mode, pids and output file of the fake goes; the script stays. */
const clearFake = () => { for (const f of readdirSync(FAKE_DIR)) if (f !== "fake-ccusage.sh") rmSync(join(FAKE_DIR, f), { force: true }); };
const setMode = (mode: string, base?: string) => writeFileSync(join(FAKE_DIR, base === undefined ? "mode" : `mode.${base}`), mode);
/** The fixture with every number of its rows and totals times `k`, as the fake's output for `agent` and folder base `base`. */
function scaledOut(agent: Agent, base: string, k: number): { tokens: number; cost: number } {
  const v = JSON.parse(fixture(agent));
  const costKey = agent === "codex" ? "costUSD" : "totalCost";
  for (const r of [...v.daily, v.totals]) { r.totalTokens *= k; r[costKey] *= k; }
  writeFileSync(join(FAKE_DIR, `out.${agent}.${base}.json`), JSON.stringify(v));
  return { tokens: v.totals.totalTokens, cost: v.totals[costKey] };
}

let worldN = 0;
/** A fresh HOME and TANDEM_HOME (0700) under BOX, set in process.env. */
function world(): { home: string; th: string } {
  const w = join(BOX, `w${++worldN}`);
  const home = join(w, "home");
  const th = join(w, "tandem");
  mkdirSync(home, { recursive: true });
  mkdirSync(th, { mode: 0o700 });
  chmodSync(th, 0o700);
  process.env.HOME = home;
  process.env.TANDEM_HOME = th;
  clearFake();
  return { home, th };
}
const dir = (p: string) => { mkdirSync(p, { recursive: true }); return p; };
/** A Claude account folder that has usage: it holds `projects/` (without it the helper is not run, case p). */
const claudeDir = (p: string) => { dir(join(p, "projects")); return p; };
const usageToml = (th: string, rows: { name: string; agent: string; folder: string }[]) =>
  writeFileSync(join(th, "usage.toml"), rows.map((r) => `[[accounts]]\nname = "${r.name}"\nagent = "${r.agent}"\nfolder = ${JSON.stringify(r.folder)}\n`).join(""), { mode: 0o600 });
const tok = (now: number) => cc.readTokens(now) as any[];
const tokRow = (agent: string, account: string, now = T0) => tok(now).find((r) => r.agent === agent && r.account === account);
/** A pid is gone: kill(pid, 0) throws ESRCH, or (linux only) it is a zombie (the container's PID 1 does not reap). */
function gone(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[0] === "Z"; } catch { return true; }
  }
  return false;
}
async function waitGone(pids: number[], ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pids.every(gone)) return true; await sleep(25); }
  return pids.every(gone);
}
const pidsOf = () => readFileSync(join(FAKE_DIR, "pids"), "utf8").trim().split("\n").map(Number);
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
}

/** Seven accounts: two Claude, two Codex, one each of Grok, OpenCode, Antigravity (default roots). */
function sevenAccounts(): { home: string; th: string; folders: Record<string, { agent: Agent; folder: string | undefined }> } {
  const { home, th } = world();
  const claudeB = claudeDir(join(home, "..", "claude-b-folder"));
  const codexB = dir(join(home, "..", "codex-b-folder"));
  claudeDir(join(home, ".claude"));
  dir(join(home, ".codex"));
  dir(join(home, ".grok"));
  dir(join(home, ".local", "share", "opencode"));
  dir(join(home, ".gemini", "antigravity"));
  usageToml(th, [{ name: "claude-b", agent: "claude", folder: claudeB }, { name: "codex-b", agent: "codex", folder: codexB }]);
  return {
    home, th, folders: {
      claude: { agent: "claude", folder: join(home, ".claude") },
      "claude-b": { agent: "claude", folder: claudeB },
      codex: { agent: "codex", folder: join(home, ".codex") },
      "codex-b": { agent: "codex", folder: codexB },
      grok: { agent: "grok", folder: join(home, ".grok") },
      opencode: { agent: "opencode", folder: join(home, ".local", "share", "opencode") },
      antigravity: { agent: "antigravity", folder: undefined },
    },
  };
}

describe("(51) usage: tokens and cost per account from the ccusage helper", () => {
  it("(51) a each of the five recorded outputs parses into its today and total tokens and cost; the empty outputs parse as zeros", () => {
    for (const a of AGENTS) {
      const r = RECORDED[a];
      const on = Date.parse(`${r.date}T08:00:00Z`);
      expect(cc.parseDaily(fixture(a), on), a).toEqual({ today: { tokens: r.tokens, cost: r.cost }, total: { tokens: r.tokens, cost: r.cost } });
      expect(cc.parseDaily(fixture(a), on + 86_400_000), a).toEqual({ today: { tokens: 0, cost: 0 }, total: { tokens: r.tokens, cost: r.cost } });
    }
    for (const [a, text] of Object.entries(EMPTY)) expect(cc.parseDaily(text, T0), a).toEqual({ today: { tokens: 0, cost: 0 }, total: { tokens: 0, cost: 0 } });
    // Rows without totals: total is the sum of the rows.
    expect(cc.parseDaily(JSON.stringify({ daily: [{ date: "2026-01-01", totalTokens: 5, totalCost: 1 }, { date: "2026-01-02", totalTokens: 7, totalCost: 2 }] }), T0))
      .toEqual({ today: { tokens: 7, cost: 2 }, total: { tokens: 12, cost: 3 } });
    for (const bad of ["not json", "[]", "{}", `{"daily":[{"date":"2026-01-02","totalTokens":-1,"totalCost":0}]}`, `{"daily":[{"date":"2026-01-02","totalTokens":1.5,"totalCost":0}]}`,
      `{"daily":[],"totals":{"totalTokens":1,"totalCost":-2}}`, `{"daily":[],"totals":{"totalTokens":1e300,"totalCost":0}}`]) {
      expect(cc.parseDaily(bad, T0), bad).toBeUndefined();
    }
  });

  it("(51) b totals per account: two Claude, two Codex, one Grok, OpenCode, Antigravity; each run holds only its own agent's variable", async () => {
    const { folders } = sevenAccounts();
    const want: Record<string, { tokens: number; cost: number }> = {};
    let k = 1;
    for (const [name, { agent, folder }] of Object.entries(folders)) want[name] = scaledOut(agent, folder ? basename(folder) : "none", k++);
    for (const v of Object.values(VAR)) process.env[v] = join(BOX, "never-this-folder");
    try {
      await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    } finally { for (const v of Object.values(VAR)) delete process.env[v]; }
    for (const [name, { agent }] of Object.entries(folders)) {
      expect(tokRow(agent, name), name).toMatchObject({ tokens: { total: want[name]!.tokens }, cost_usd: { total: want[name]!.cost }, tokens_note: null });
    }
    const lines = logLines();
    expect(lines).toHaveLength(7);
    for (const { agent, folder } of Object.values(folders)) {
      const mine = lines.filter((l) => l.startsWith(`${agent} `) && (folder === undefined || l.includes(`=${folder} `)));
      expect(mine, `${agent} ${folder}`).toHaveLength(1);
      const set = Object.values(VAR).filter((v) => mine[0]!.includes(` ${v}=`));
      expect(set, mine[0]).toEqual(folder === undefined ? [] : [VAR[agent]]);
      expect(mine[0]).not.toContain("never-this-folder");
    }
  });

  it("(51) c argv is exactly `<agent> daily --json --offline` for each of the five, cwd /", async () => {
    sevenAccounts();
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    const lines = logLines();
    for (const a of AGENTS) {
      const mine = lines.filter((l) => l.startsWith(`${a} `));
      expect(mine.length, a).toBeGreaterThan(0);
      for (const l of mine) expect(l.replace(/ [A-Z_]+=\S+/g, "")).toBe(`${a} daily --json --offline cwd=/`);
    }
  });

  it("(51) d a hung run is killed by its process group at the deadline: `tokens: not available (timed out)`", async () => {
    expect(cc.KILL_MS).toBe(60_000);
    const { home } = world();
    claudeDir(join(home, ".claude"));
    setMode("hang");
    const t = Date.now();
    await cc.collectTokens(T0, { bin: FAKE, timeoutMs: 300, harnesses: H() });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(tokRow("claude", "claude")).toMatchObject({ tokens: null, cost_usd: null, tokens_note: "tokens: not available (timed out)" });
    const pids = pidsOf();
    expect(pids).toHaveLength(2);
    expect(await waitGone(pids)).toBe(true);
  });

  it("(51) e reasons: helper missing, exit 3, output not readable (text, 9 MiB), folder name has a comma; a good row turns NULL; stderr is never kept", async () => {
    const { home, th } = world();
    claudeDir(join(home, ".claude"));
    const f = (n: string) => claudeDir(join(home, "..", n));
    usageToml(th, ["e-exit", "e-text", "e-big", "e-err", "a,b"].map((n) => ({ name: n === "a,b" ? "e-comma" : n, agent: "claude", folder: f(n) })));
    await cc.collectTokens(T0, { bin: join(BOX, "no-such-helper"), harnesses: H() });
    expect(logLines()).toEqual([]);
    for (const n of ["claude", "e-exit", "e-text", "e-big", "e-err"]) expect(tokRow("claude", n), n).toMatchObject({ tokens: null, tokens_note: "tokens: not available (helper missing)" });
    expect(tokRow("claude", "e-comma")).toMatchObject({ tokens: null, tokens_note: "tokens: not available (folder name has a comma)" });
    await cc.collectTokens(T0 + 1, { bin: FAKE, harnesses: H() });
    for (const n of ["claude", "e-exit", "e-text", "e-big", "e-err"]) expect(tokRow("claude", n, T0 + 1), n).toMatchObject({ tokens: { total: 101 }, tokens_note: null });
    expect(logLines().some((l) => l.includes("a,b"))).toBe(false);
    setMode("exit 3", "e-exit");
    setMode("text", "e-text");
    setMode("big", "e-big");
    setMode("stderr", "e-err");
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => { err.push(String(s)); return true; }) as any);
    try {
      await cc.collectTokens(T0 + 2, { bin: FAKE, harnesses: H() });
    } finally { spy.mockRestore(); }
    expect(tokRow("claude", "e-exit", T0 + 2)).toMatchObject({ tokens: null, cost_usd: null, tokens_note: "tokens: not available (exit 3)" });
    expect(tokRow("claude", "e-text", T0 + 2)).toMatchObject({ tokens: null, tokens_note: "tokens: not available (output not readable)" });
    expect(tokRow("claude", "e-big", T0 + 2)).toMatchObject({ tokens: null, tokens_note: "tokens: not available (output not readable)" });
    expect(tokRow("claude", "e-err", T0 + 2)).toMatchObject({ tokens: { total: 101 }, tokens_note: null });
    expect(tokRow("claude", "e-comma", T0 + 2)).toMatchObject({ tokens_note: "tokens: not available (folder name has a comma)" });
    expect(err.join("")).not.toContain("R1A51-STDERR-MARKER");
    const db = new DatabaseSync(join(th, "state.db"));
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
    const bytes = readFileSync(join(th, "state.db")).toString("latin1") + (existsSync(join(th, "state.db-wal")) ? readFileSync(join(th, "state.db-wal")).toString("latin1") : "");
    expect(bytes).not.toContain("R1A51-STDERR-MARKER");
  }, 30_000);

  it("(51) f limit notes: grok, antigravity, opencode rows read `limit: not available`; claude and codex rows read null", async () => {
    const { folders } = sevenAccounts();
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    for (const [name, { agent }] of Object.entries(folders)) {
      expect(tokRow(agent, name)?.limit_note, name).toBe(["grok", "antigravity", "opencode"].includes(agent) ? "limit: not available" : null);
    }
  });

  it("(51) g schedule: every 10 min; on demand at most once a minute; a call during a pass joins it", async () => {
    expect(cc.TOKENS_EVERY_MS).toBe(600_000);
    expect(cc.REFRESH_MIN_MS).toBe(60_000);
    const { home } = world();
    claudeDir(join(home, ".claude"));
    const T = T0 + 30 * 86_400_000;
    const o = { bin: FAKE, harnesses: H() };
    expect(await cc.refreshTokens(T, o)).toBe(true);
    expect(logLines()).toHaveLength(1);
    expect(await cc.refreshTokens(T + 59_999, o)).toBe(false);
    expect(logLines()).toHaveLength(1);
    expect(await cc.refreshTokens(T + 60_000, o)).toBe(true);
    expect(logLines()).toHaveLength(2);
    setMode("slow");
    const a = cc.refreshTokens(T + 200_000, o);
    const b = cc.refreshTokens(T + 200_001, o);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(logLines()).toHaveLength(3);
  }, 15_000);

  it("(51) h startUsageCollector runs token passes on its timer; its stop ends the timer and kills an in-flight run", async () => {
    const { home } = world();
    claudeDir(join(home, ".claude"));
    const stop = startUsageCollector({ everyMs: 60_000, tokensEveryMs: 100, ccusage: { bin: FAKE } });
    let stopped = false;
    try {
      await sleep(1000);
      expect(logLines().length).toBeGreaterThanOrEqual(2);
      setMode("hang");
      await waitFor(() => existsSync(join(FAKE_DIR, "pids")) && pidsOf().length === 2);
      const pids = pidsOf();
      expect(pids).toHaveLength(2);
      stop();
      stopped = true;
      const n = logLines().length;
      await sleep(500);
      expect(logLines()).toHaveLength(n);
      expect(await waitGone(pids)).toBe(true);
    } finally { if (!stopped) stop(); }
  }, 15_000);

  it("(51) i numbers only: no string from the helper's output reaches state.db; usage_tokens has the eight columns", async () => {
    const { home, th } = world();
    claudeDir(join(home, ".claude"));
    writeFileSync(join(FAKE_DIR, `out.claude.${basename(join(home, ".claude"))}.json`), fixture("claude").replace(/""/g, '"R1A51-TEXT-MARKER"'));
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    await cc.collectTokens(T0 + 1, { bin: FAKE, harnesses: H() });
    expect(tokRow("claude", "claude", T0 + 1)).toMatchObject({ tokens: { today: 101, total: 101 } });
    const db = new DatabaseSync(join(th, "state.db"));
    let cols: string[];
    try {
      cols = (db.prepare("PRAGMA table_info(usage_tokens)").all() as { name: string }[]).map((c) => c.name);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    expect(cols).toEqual(["account", "agent", "read_ms", "tokens_today", "cost_today", "tokens_total", "cost_total", "reason"]);
    for (const f of ["state.db", "state.db-wal"]) {
      if (existsSync(join(th, f))) expect(readFileSync(join(th, f)).toString("latin1"), f).not.toContain("R1A51-TEXT-MARKER");
    }
  });

  it("(51) j default folders: none under HOME = no run, no row, no state.db; a listed folder that does not exist gets a row with a reason", async () => {
    const { th } = world();
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    expect(logLines()).toEqual([]);
    expect(tok(T0)).toEqual([]);
    expect(existsSync(join(th, "state.db"))).toBe(false);
    usageToml(th, [{ name: "j-missing", agent: "grok", folder: join(BOX, "j-not-there") }]);
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    expect(logLines()).toEqual([]);
    expect(tok(T0)).toEqual([expect.objectContaining({ account: "j-missing", agent: "grok", tokens: null, tokens_note: "tokens: not available (folder missing)", limit_note: "limit: not available" })]);
  });

  it("(51) k A11.1 recorded half: two Claude and two Codex accounts give window shares, reset times, tokens and cost under one name each, each with its age", async () => {
    const { home, th } = world();
    const now = Date.now();
    const claudeB = claudeDir(join(home, "..", "k-claude-b"));
    const codexB = dir(join(home, "..", "k-codex-b"));
    claudeDir(join(home, ".claude"));
    dir(join(home, ".codex"));
    usageToml(th, [{ name: "claude-b", agent: "claude", folder: claudeB }, { name: "codex-b", agent: "codex", folder: codexB }]);
    // Drop files as the statusLine command writes them (test/usage/claude.test.ts).
    const drops = join(th, "usage", "claude");
    mkdirSync(drops, { recursive: true, mode: 0o700 });
    chmodSync(join(th, "usage"), 0o700);
    chmodSync(drops, 0o700);
    const S = (ms: number) => Math.floor(ms / 1000);
    const want: Record<string, { agent: Agent; five: number; seven: number; fiveR: number; sevenR: number; at: number; k: number; folder: string }> = {
      claude: { agent: "claude", five: 11, seven: 21, fiveR: S(now + 3_600_000), sevenR: S(now + 86_400_000), at: now - 120_000, k: 2, folder: join(home, ".claude") },
      "claude-b": { agent: "claude", five: 12, seven: 22, fiveR: S(now + 3_700_000), sevenR: S(now + 86_500_000), at: now - 130_000, k: 3, folder: claudeB },
      codex: { agent: "codex", five: 13, seven: 23, fiveR: S(now + 3_800_000), sevenR: S(now + 86_600_000), at: now - 140_000, k: 4, folder: join(home, ".codex") },
      "codex-b": { agent: "codex", five: 14, seven: 24, fiveR: S(now + 3_900_000), sevenR: S(now + 86_700_000), at: now - 150_000, k: 5, folder: codexB },
    };
    // Rollout lines in the U-R1A-50 fixture's shape (test/fixtures/usage/codex/rollout-tail.jsonl), times and shares set here.
    const tail = readFileSync(join(ROOT, "test", "fixtures", "usage", "codex", "rollout-tail.jsonl"), "utf8").trim().split("\n");
    const rlIdx = tail.findIndex((l) => l.includes('"rate_limits"'));
    const toks: Record<string, { tokens: number; cost: number }> = {};
    for (const [name, w] of Object.entries(want)) {
      if (w.agent === "claude") {
        writeFileSync(join(drops, `${name}.json`), JSON.stringify({ at: w.at, rate_limits: { five_hour: { used_percentage: w.five, resets_at: w.fiveR }, seven_day: { used_percentage: w.seven, resets_at: w.sevenR } } }), { mode: 0o600 });
      } else {
        const v = JSON.parse(tail[rlIdx]!);
        v.timestamp = new Date(w.at).toISOString();
        const rl = v.payload.rate_limits;
        rl.primary = { used_percent: w.five, window_minutes: 300, resets_at: w.fiveR };
        rl.secondary = { used_percent: w.seven, window_minutes: 10080, resets_at: w.sevenR };
        const p = join(w.folder, "sessions", "2026", "11", "12", "rollout-k.jsonl");
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, [...tail.slice(0, rlIdx), JSON.stringify(v)].join("\n") + "\n");
      }
      toks[name] = scaledOut(w.agent, basename(w.folder), w.k);
    }
    const hs = H().filter((h) => h.name === "claude" || h.name === "codex");
    collectUsage(now, hs);
    await cc.collectTokens(now, { bin: FAKE, harnesses: hs });
    const later = now + 5_000;
    for (const [name, w] of Object.entries(want)) {
      const lim = readUsage(later).find((r: any) => r.agent === w.agent && r.account === name);
      expect(lim, name).toMatchObject({ five_hour: { used: w.five, resetsAt: w.fiveR * 1000 }, seven_day: { used: w.seven, resetsAt: w.sevenR * 1000 }, ageMs: later - w.at, stale: false });
      expect(tokRow(w.agent, name, later), name).toMatchObject({ tokens: { total: toks[name]!.tokens }, cost_usd: { total: toks[name]!.cost }, ageMs: 5_000, at: now, tokens_note: null, limit_note: null });
    }
  });

  it("(51) l G1: an ALTER that meets `duplicate column name: plan` (another process added it) is ignored; the reading is stored", async () => {
    const { th } = world();
    const file = join(th, "state.db");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE usage_readings (account TEXT, agent TEXT, at_ms INTEGER, five_used REAL, five_resets_ms INTEGER,
      seven_used REAL, seven_resets_ms INTEGER, read_ms INTEGER, PRIMARY KEY (account, agent))`);
    db.close();
    chmodSync(file, 0o600);
    const ready = join(th, "child-ready");
    const child = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; ALTER TABLE usage_readings ADD COLUMN plan TEXT');
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      db.exec('COMMIT');
      db.close();
    `], { detached: true, stdio: "ignore" });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      await waitFor(() => existsSync(ready), 10_000);
      expect(existsSync(ready)).toBe(true);
      const now = Date.now();
      recordReadings([{ account: "l", agent: "codex", atMs: now, seven: { used: 9, resetsMs: now + 60_000 }, plan: "pro" }], now);
      expect(readUsage(now).find((r: any) => r.account === "l")).toMatchObject({ seven_day: { used: 9 }, plan: "pro" });
      expect(await exited).toBe(0);
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ }
    }
  }, 20_000);

  it("(51) m G2: a symlinked ~/.codex also listed by its real path is one account (the listed name) and one helper run", async () => {
    const { home, th } = world();
    const realCodex = dir(join(home, "..", "real-codex"));
    symlinkSync(realCodex, join(home, ".codex"));
    usageToml(th, [{ name: "codex-a", agent: "codex", folder: realCodex }]);
    const now = Date.now();
    const line = JSON.stringify({ timestamp: new Date(now - 60_000).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 5, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 3600 }, secondary: null } } });
    const p = join(realCodex, "sessions", "2026", "11", "12", "rollout-m.jsonl");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, line + "\n");
    expect(codexReadings(harness("codex"), now).map((r: any) => r.account)).toEqual(["codex-a"]);
    await cc.collectTokens(now, { bin: FAKE, harnesses: [harness("codex")] });
    expect(logLines().filter((l) => l.startsWith("codex "))).toHaveLength(1);
    expect(tok(now).map((r) => `${r.agent}/${r.account}`)).toEqual(["codex/codex-a"]);
  });

  it("(51) n one account's failure spares the others", async () => {
    const { folders } = sevenAccounts();
    setMode("exit 1", "codex-b-folder");
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    for (const [name, { agent }] of Object.entries(folders)) {
      if (name === "codex-b") expect(tokRow(agent, name)).toMatchObject({ tokens: null, tokens_note: "tokens: not available (exit 1)" });
      else expect(tokRow(agent, name), name).toMatchObject({ tokens: { total: RECORDED[agent].tokens }, tokens_note: null });
    }
  });

  it("(51) p a Claude folder with no projects/ yet reads zero tokens and cost and is not run; with projects/ it is run; without the helper it reads helper missing", async () => {
    const { home, th } = world();
    dir(join(home, ".claude"));
    const empty = dir(join(home, "..", "p-empty"));
    const has = claudeDir(join(home, "..", "p-has"));
    const itself = dir(join(home, "..", "p-itself", "projects"));
    dir(join(home, ".codex"));
    usageToml(th, [{ name: "p-empty", agent: "claude", folder: empty }, { name: "p-has", agent: "claude", folder: has }, { name: "p-itself", agent: "claude", folder: itself }]);
    await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    const zero = { tokens: { today: 0, total: 0 }, cost_usd: { today: 0, total: 0 }, tokens_note: null, limit_note: null };
    expect(tokRow("claude", "claude")).toMatchObject(zero);
    expect(tokRow("claude", "p-empty")).toMatchObject(zero);
    expect(tokRow("claude", "p-has")).toMatchObject({ tokens: { total: 101 }, tokens_note: null });
    expect(tokRow("claude", "p-itself")).toMatchObject({ tokens: { total: 101 }, tokens_note: null });
    // Only Claude: a Codex folder with nothing in it is still run (ccusage answers zeros itself).
    expect(logLines().map((l) => l.replace(/ cwd=.*$/, "")).sort()).toEqual([
      `claude daily --json --offline CLAUDE_CONFIG_DIR=${has}`, `claude daily --json --offline CLAUDE_CONFIG_DIR=${itself}`, `codex daily --json --offline CODEX_HOME=${join(home, ".codex")}`,
    ].sort());
    await cc.collectTokens(T0 + 1, { bin: join(BOX, "no-such-helper"), harnesses: H() });
    for (const n of ["claude", "p-empty", "p-has"]) expect(tokRow("claude", n, T0 + 1), n).toMatchObject({ tokens: null, tokens_note: "tokens: not available (helper missing)" });
  });

  it("(51) q the helper is always run by path: a bare name is never looked up on PATH", async () => {
    const { home } = world();
    dir(join(home, ".codex"));
    const here = dir(join(home, "..", "q-here"));
    const onPath = dir(join(home, "..", "q-on-path"));
    const ran = join(home, "..", "q-ran");
    for (const [d, word] of [[here, "here"], [onPath, "path"]] as const) {
      writeFileSync(join(d, "r1a51-q-helper"), `#!/bin/sh\necho ${word} >> '${ran}'\ncat '${join(FIXDIR, "codex.json")}'\n`);
      chmodSync(join(d, "r1a51-q-helper"), 0o755);
    }
    const [path, cwd] = [process.env.PATH, process.cwd()];
    process.env.PATH = `${onPath}:${path}`;
    try {
      // Not in the working folder: helper missing, PATH's is not run.
      await cc.collectTokens(T0, { bin: "r1a51-q-helper", harnesses: H() });
      expect(tokRow("codex", "codex")).toMatchObject({ tokens: null, tokens_note: "tokens: not available (helper missing)" });
      expect(existsSync(ran)).toBe(false);
      // In the working folder: that file runs, PATH's still does not.
      process.chdir(here);
      await cc.collectTokens(T0 + 1, { bin: "r1a51-q-helper", harnesses: H() });
      expect(tokRow("codex", "codex", T0 + 1)).toMatchObject({ tokens: { total: 275 }, tokens_note: null });
      expect(readFileSync(ran, "utf8")).toBe("here\n");
    } finally {
      process.chdir(cwd);
      process.env.PATH = path;
    }
  });

  it("(51) r the helper's environment is the allow-list plus its own folder variable: no secret, proxy, CCM_/TANDEM_ or other variable of the bridge", async () => {
    const { folders } = sevenAccounts();
    setMode("env");
    const SECRET = "R1A51-SECRET-VALUE";
    const planted = ["TANDEM_OWNER_PASSWORD", "TANDEM_HUB_LINK_TOKEN", "TANDEM_FLEET_TOKEN", "TANDEM_CALLER_TOKEN", "CCM_TUNNEL_TOKEN", "CCM_BRIDGE_ID", "TANDEM_CONFIG_FILE",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "XDG_DATA_HOME_R1A51", "R1A51_DECOY", "ANTHROPIC_API_KEY", ...Object.values(VAR)];
    const before = Object.fromEntries(planted.map((v) => [v, process.env[v]]));
    for (const v of planted) process.env[v] = SECRET;
    process.env.LANG = "C";
    try {
      await cc.collectTokens(T0, { bin: FAKE, harnesses: H() });
    } finally {
      for (const v of planted) { if (before[v] === undefined) delete process.env[v]; else process.env[v] = before[v]; }
    }
    expect(cc.HELPER_ENV).toEqual(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"]);
    // What `sh` itself adds to its children.
    const SHELL = ["PWD", "OLDPWD", "SHLVL", "_"];
    expect(process.env.TANDEM_HOME).toBeTruthy();
    for (const [name, { agent, folder }] of Object.entries(folders)) {
      const dump = readFileSync(join(FAKE_DIR, `env.${agent}.${folder ? basename(folder) : "none"}`), "utf8");
      expect(dump, name).not.toContain(SECRET);
      const names = dump.trim().split("\n").map((l) => l.slice(0, l.indexOf("="))).filter((n) => !SHELL.includes(n)).sort();
      const want = [...cc.HELPER_ENV.filter((v: string) => process.env[v] !== undefined), ...(folder === undefined ? [] : [VAR[agent]])].sort();
      expect(names, name).toEqual(want);
      for (const v of ["PATH", "HOME", "TZ", "LANG"]) expect(names, `${name} ${v}`).toContain(v);
      if (folder !== undefined) expect(dump, name).toContain(`${VAR[agent]}=${folder}\n`);
    }
    expect(tokRow("claude", "claude")).toMatchObject({ tokens: { total: 101 }, tokens_note: null });
    // The test-only option (read-only.test.ts r3 hands its logging proxy over with it) does reach the helper; a folder variable in it does not.
    await cc.collectTokens(T0 + 1, { bin: FAKE, harnesses: [harness("codex")], extraEnv: { HTTPS_PROXY: "http://127.0.0.1:9", CODEX_HOME: "/r1a51-not-this", GROK_HOME: "/r1a51-not-this" } });
    const dump = readFileSync(join(FAKE_DIR, "env.codex..codex"), "utf8");
    expect(dump).toContain("HTTPS_PROXY=http://127.0.0.1:9\n");
    expect(dump).toContain(`CODEX_HOME=${folders.codex!.folder}\n`);
    expect(dump).not.toContain("r1a51-not-this");
  });

  it("(51) o PIN.md names the version, commit, command and four integrities; fetch.sh carries each; LICENSE is MIT", () => {
    const pin = readFileSync(join(ROOT, "packaging", "helpers", "ccusage", "PIN.md"), "utf8");
    const fetch = readFileSync(join(ROOT, "packaging", "helpers", "ccusage", "fetch.sh"), "utf8");
    for (const s of ["20.0.49", "37c8acd1a8a1742b0e4e6fa3f658139f6404100e", "ccusage <agent> daily --json --offline"]) expect(pin, s).toContain(s);
    const integrities = [
      "sha512-nEYFIyA1WaAOLPTw5JHFShgQbkDArravcGzEopVz/rIWJuZmfMvE4CCJ111A0thCn72TzJi3/q+ByNOfGGXh/Q==",
      "sha512-OOrqJ7T3Uxee+J8+nyui0SAszxHY93J/T4gU0X8HgrP7qEXw7dioR46XjAyXtoryZMF+t87FbPye/FJ6qdRrWg==",
      "sha512-c1/4mP5kRNnq65HIoG6F5gvzETAYoocVuDO5N6gaP0n4vR5g58iIe2KVkoERemmKsXVWpI0cp6bsLYfTvFFmRQ==",
      "sha512-MITIo4RpJuskZqpk80VrZ8uE6QsN3uJFY3R0NXO2jZOB1qL7MqVkYuGQC0lFqsTp5ux6UC/nOa+ZubaP3ED/nQ==",
    ];
    const inPin = pin.match(/sha512-[A-Za-z0-9+/=]+/g) ?? [];
    expect([...new Set(inPin)].sort()).toEqual([...integrities].sort());
    for (const i of inPin) expect(fetch, i).toContain(i);
    expect(readFileSync(join(ROOT, "packaging", "helpers", "ccusage", "LICENSE"), "utf8").split("\n")[0]).toBe("MIT License");
  });
});
