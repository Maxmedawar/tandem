/**
 * U-R1A-50: Codex accounts report their limits. Every 60 seconds the bridge reads, from the last
 * 256 KiB of the newest (by modification time) `sessions/**\/rollout-*.jsonl` under each Codex
 * account folder, the last `rate_limits` entry: used share, window length and reset time of each
 * window, and the plan type. It never opens `auth.json`. A reading over 30 minutes old is stale, a
 * window past its reset reads unknown (bridge/usage/store.ts, as for Claude).
 *
 * Before any import: TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a50- folder, CODEX_HOME
 * unset. Each account folder holds an `auth.json` with a marker (mode 0000). No agent program starts.
 * The fixture is the newest rollout file's last `rate_limits` line and the line before it (mini,
 * codex-cli 0.167.1), every string value blanked except timestamp, type, payload.type, plan_type.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const BOX = mkdtempSync(join(tmpdir(), "r1a50-"));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
const TH = join(BOX, "tandem");
mkdirSync(TH, { mode: 0o700 });
chmodSync(TH, 0o700);
process.env.TANDEM_HOME = TH;
const HOME = join(BOX, "home");
mkdirSync(HOME);
process.env.HOME = HOME;
delete process.env.CODEX_HOME;

const { readCodexFolder, codexReadings } = await import("../../bridge/usage/codex.ts");
const { collectUsage } = await import("../../bridge/usage/collector.ts");
const { readUsage, recordReadings } = await import("../../bridge/usage/store.ts");
const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterAll(() => {
  const sock = join(BOX, `tmux-${process.getuid!()}`, "default");
  if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  rmSync(BOX, { recursive: true, force: true });
});

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/usage/codex/rollout-tail.jsonl", import.meta.url));
const codex = () => loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.get("codex")!;
const NOW = Date.now();
const S = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();
const MARKER = "R1A50-AUTH-MARKER";

type Win = { used_percent: number; window_minutes: number; resets_at: number } | null;
const win = (used: number, minutes: number, resetsMs = NOW + 3_600_000): Win => ({ used_percent: used, window_minutes: minutes, resets_at: S(resetsMs) });
/** A rate_limits object in codex-cli 0.167.1's shape. */
const limits = (primary: Win, secondary: Win, plan: unknown = "pro") => ({
  limit_id: "", limit_name: null, primary, secondary, credits: { has_credits: false, unlimited: false, balance: "" },
  individual_limit: null, spend_control_reached: null, plan_type: plan, rate_limit_reached_type: null,
});
/** One token_count line holding `rl`; `ts` null = no timestamp key. */
const rlLine = (rl: unknown, ts: string | null = iso(NOW - 60_000)) =>
  JSON.stringify({ ...(ts === null ? {} : { timestamp: ts }), ordinal: 1, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rl } });
const plainLine = (ts = iso(NOW - 120_000), text = "SESSION-TEXT") =>
  JSON.stringify({ timestamp: ts, ordinal: 0, type: "response_item", payload: { type: "message", content: [{ type: "output_text", text }] } });

/** An account folder with `auth.json` (marker, 0000). */
function folder(name: string, at = BOX): string {
  const f = join(at, name);
  mkdirSync(join(f, "sessions"), { recursive: true });
  writeFileSync(join(f, "auth.json"), JSON.stringify({ token: MARKER }));
  chmodSync(join(f, "auth.json"), 0o000);
  return f;
}
/** Writes `<f>/sessions/<rel>` with `lines`, mtime `mtimeS` (seconds). */
function rollout(f: string, rel: string, lines: string[], mtimeS = S(NOW - 30_000)): string {
  const p = join(f, "sessions", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
  utimesSync(p, mtimeS, mtimeS);
  return p;
}
function stderrOf<T>(fn: () => T): { out: T; lines: string[] } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => { lines.push(String(s)); return true; }) as any);
  try { return { out: fn(), lines: lines.join("").split("\n").filter(Boolean) }; } finally { spy.mockRestore(); }
}
/** readCodexFolder leaves `agent` empty; codexReadings sets the harness name. */
const asCodex = (r: any) => ({ ...r, agent: "codex" });
const row = (agent: string, acct: string, now = NOW) => readUsage(now).find((r: any) => r.account === acct && r.agent === agent);
const usageToml = (rows: { name: string; folder: string }[]) =>
  writeFileSync(join(TH, "usage.toml"), rows.map((r) => `[[accounts]]\nname = "${r.name}"\nagent = "codex"\nfolder = ${JSON.stringify(r.folder)}\n`).join(""), { mode: 0o600 });

const DEFAULT = folder(".codex", HOME);
const B = folder("codex-b-folder");

describe("(50) usage: Codex accounts report their limits from the tail of their session logs", () => {
  it("(50) a two folders (default ~/.codex and usage.toml's codex-b) give two accounts with their own numbers", () => {
    rollout(DEFAULT, "2026/11/12/rollout-2026-11-12T00-00-00-a.jsonl", [plainLine(), rlLine(limits(win(31, 10080), null))]);
    rollout(B, "2026/11/12/rollout-2026-11-12T00-00-00-b.jsonl", [plainLine(), rlLine(limits(win(12, 300), win(64, 10080), "plus"))]);
    usageToml([{ name: "codex-b", folder: B }, { name: "codex-b2", folder: B }]);
    const h = codex();
    const got = codexReadings(h, NOW);
    expect(got.map((r: any) => r.account).sort()).toEqual(["codex", "codex-b"]); // B listed twice: read once
    collectUsage(NOW, [h]);
    expect(row("codex", "codex")).toMatchObject({ stale: false, five_hour: { used: null, resetsAt: null }, seven_day: { used: 31 }, plan: "pro" });
    expect(row("codex", "codex-b")).toMatchObject({ stale: false, five_hour: { used: 12 }, seven_day: { used: 64 }, plan: "plus" });
    expect(row("codex", "codex")!.at).toBe(NOW - 60_000);
  });

  it("(50) b of two rollout files the newer mtime wins even when its name sorts first", () => {
    const f = folder("b-folder");
    rollout(f, "2026/11/10/rollout-2026-11-10T00-00-00-a.jsonl", [rlLine(limits(win(70, 10080), null))], S(NOW - 10_000));
    rollout(f, "2026/11/11/rollout-2026-11-11T00-00-00-z.jsonl", [rlLine(limits(win(20, 10080), null))], S(NOW - 900_000));
    expect(readCodexFolder(f, "b", NOW)).toMatchObject({ account: "b", seven: { used: 70 } });
  });

  it("(50) c a newest file with no rate_limits line keeps the earlier stored reading; its age grows and it turns stale", () => {
    const f = folder("c-folder");
    const h = { ...codex(), name: "codex-c", account_dir: f };
    rollout(f, "2026/11/12/rollout-old.jsonl", [rlLine(limits(win(44, 10080, NOW + 86_400_000), null))], S(NOW - 50_000));
    collectUsage(NOW, [h]);
    const first = row("codex-c", "c-folder")!;
    expect(first).toMatchObject({ at: NOW - 60_000, seven_day: { used: 44 } });
    rollout(f, "2026/11/12/rollout-new.jsonl", [plainLine(iso(NOW)), plainLine(iso(NOW))], S(NOW));
    expect(readCodexFolder(f, "c-folder", NOW + 5 * 60_000)).toBeUndefined();
    collectUsage(NOW + 5 * 60_000, [h]);
    const later = row("codex-c", "c-folder", NOW + 5 * 60_000)!;
    expect(later).toMatchObject({ at: NOW - 60_000, stale: false, seven_day: { used: 44 } });
    expect(later.ageMs).toBe(first.ageMs + 5 * 60_000);
    const { lines } = stderrOf(() => collectUsage(NOW + 31 * 60_000, [h]));
    expect(row("codex-c", "c-folder", NOW + 31 * 60_000)).toMatchObject({ stale: true, at: NOW - 60_000 });
    expect(lines.filter((l) => l.startsWith("usage: codex-c "))).toEqual(["usage: codex-c account c-folder has not reported for 32 min"]);
  });

  it("(50) d windows map by length: 7-day primary + null secondary = seven only; 300 + 10080 = both; any other length skipped with one stderr line per account", () => {
    const f1 = folder("d1");
    rollout(f1, "2026/11/12/rollout-d1.jsonl", [rlLine(limits(win(31, 10080), null))]);
    const r1 = readCodexFolder(f1, "d1", NOW)!;
    expect(r1.seven).toEqual({ used: 31, resetsMs: S(NOW + 3_600_000) * 1000 });
    expect(r1).not.toHaveProperty("five");
    const f2 = folder("d2");
    rollout(f2, "2026/11/12/rollout-d2.jsonl", [rlLine(limits(win(5.5, 300, NOW + 600_000), win(40, 10080)))]);
    const r2 = readCodexFolder(f2, "d2", NOW)!;
    expect(r2.five).toEqual({ used: 5.5, resetsMs: S(NOW + 600_000) * 1000 });
    expect(r2.seven).toEqual({ used: 40, resetsMs: S(NOW + 3_600_000) * 1000 });
    const f3 = folder("d3");
    rollout(f3, "2026/11/12/rollout-d3.jsonl", [rlLine(limits(win(9, 60), win(41, 10080)))]);
    const a = stderrOf(() => readCodexFolder(f3, "d3", NOW));
    const b = stderrOf(() => readCodexFolder(f3, "d3", NOW));
    expect(a.out).toMatchObject({ seven: { used: 41 } });
    expect(a.out).not.toHaveProperty("five");
    expect(b.out).toEqual(a.out);
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toMatch(/d3/);
    expect(b.lines).toEqual([]);
    // Only other lengths: no window, so no reading from that line.
    const f4 = folder("d4");
    rollout(f4, "2026/11/12/rollout-d4.jsonl", [rlLine(limits(win(9, 60), null))]);
    expect(stderrOf(() => readCodexFolder(f4, "d4", NOW)).out).toBeUndefined();
  });

  it("(50) e a 50 MB rollout file is read from its tail in under 100 ms", () => {
    const f = folder("e-folder");
    const p = join(f, "sessions", "2026", "11", "12", "rollout-big.jsonl");
    mkdirSync(join(p, ".."), { recursive: true });
    const filler = Buffer.from((plainLine(iso(NOW - 600_000), "x".repeat(900)) + "\n").repeat(1024));
    const fd = openSync(p, "w");
    let size = 0;
    while (size < 50 * 1024 * 1024) size += writeSync(fd, filler);
    size += writeSync(fd, rlLine(limits(win(77, 10080), null)) + "\n");
    closeSync(fd);
    expect(size).toBeGreaterThan(50 * 1024 * 1024);
    readCodexFolder(f, "e", NOW); // warm-up, untimed
    let ms = Infinity;
    let r: any;
    for (let attempt = 0; attempt < 2 && ms >= 100; attempt++) {
      const t0 = performance.now();
      r = readCodexFolder(f, "e", NOW);
      ms = performance.now() - t0;
    }
    expect(r).toMatchObject({ seven: { used: 77 } });
    expect(ms).toBeLessThan(100);
  }, 60_000);

  it("(50) f auth.json (marker, mode 0000) in an account folder is never opened; only rollout files under sessions/ and TANDEM_HOME are", () => {
    for (const d of [DEFAULT, B]) expect(fs.statSync(join(d, "auth.json")).mode & 0o777).toBe(0);
    usageToml([{ name: "codex-b", folder: B }]);
    const h = codex();
    const opened: string[] = [];
    const fds = new Map<number, string>();
    const realOpen = fs.openSync;
    const realReadFile = fs.readFileSync;
    const realRead = fs.readSync;
    const o = vi.spyOn(fs, "openSync").mockImplementation(((p: any, ...rest: any[]) => { const fd = (realOpen as any)(p, ...rest); opened.push(String(p)); fds.set(fd, String(p)); return fd; }) as any);
    const rf = vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => { opened.push(typeof p === "number" ? fds.get(p) ?? `fd:${p}` : String(p)); return (realReadFile as any)(p, ...rest); }) as any);
    const rs = vi.spyOn(fs, "readSync").mockImplementation(((fd: any, ...rest: any[]) => { opened.push(fds.get(fd) ?? `fd:${fd}`); return (realRead as any)(fd, ...rest); }) as any);
    syncBuiltinESMExports();
    try {
      codexReadings(h, NOW);
      collectUsage(NOW, [h]);
      readUsage(NOW);
    } finally {
      o.mockRestore();
      rf.mockRestore();
      rs.mockRestore();
      syncBuiltinESMExports();
    }
    expect(opened.some((p) => p.startsWith(join(DEFAULT, "sessions") + "/"))).toBe(true);
    expect(opened.some((p) => p.startsWith(join(B, "sessions") + "/"))).toBe(true);
    for (const p of opened) {
      const ok = /\/sessions\/.+\/rollout-[^/]*\.jsonl$/.test(p) || p.startsWith(`${TH}/`);
      expect(ok, p).toBe(true);
      expect(p).not.toMatch(/auth\.json|credentials|keychain|oauth/i);
    }
    for (const d of [DEFAULT, B]) expect(fs.statSync(join(d, "auth.json")).mode & 0o777).toBe(0);
    const db = readFileSync(join(TH, "state.db")).toString("latin1") + (fs.existsSync(join(TH, "state.db-wal")) ? readFileSync(join(TH, "state.db-wal")).toString("latin1") : "");
    expect(db).not.toContain(MARKER);
  });

  it("(50) g a symlinked rollout file and a symlinked sessions folder (or day folder) are skipped", () => {
    const elsewhere = folder("g-elsewhere");
    const target = rollout(elsewhere, "2026/11/12/rollout-target.jsonl", [rlLine(limits(win(99, 10080), null))], S(NOW));
    const g1 = folder("g1");
    rollout(g1, "2026/11/11/rollout-real.jsonl", [rlLine(limits(win(11, 10080), null))], S(NOW - 600_000));
    mkdirSync(join(g1, "sessions", "2026", "11", "12"), { recursive: true });
    symlinkSync(target, join(g1, "sessions", "2026", "11", "12", "rollout-link.jsonl"));
    symlinkSync(join(elsewhere, "sessions", "2026", "11", "12"), join(g1, "sessions", "2026", "11", "13"));
    expect(readCodexFolder(g1, "g1", NOW)).toMatchObject({ seven: { used: 11 } });
    const g2 = join(BOX, "g2");
    mkdirSync(g2);
    symlinkSync(join(elsewhere, "sessions"), join(g2, "sessions"));
    expect(readCodexFolder(g2, "g2", NOW)).toBeUndefined();
  });

  it("(50) h plan type kept when it matches ^[a-z0-9_-]{1,32}$, NULL when not; Claude readings keep NULL", () => {
    const plans: [string, unknown, string | null][] = [
      ["h-pro", "pro", "pro"], ["h-team", "team_plus-2", "team_plus-2"], ["h-caps", "Pro", null], ["h-space", "pro plan", null],
      ["h-long", "a".repeat(33), null], ["h-num", 7, null], ["h-null", null, null], ["h-text", "SESSION-TEXT", null],
    ];
    for (const [name, plan, want] of plans) {
      const f = folder(name);
      rollout(f, "2026/11/12/rollout-h.jsonl", [rlLine(limits(win(1, 10080), null, plan))]);
      const r = readCodexFolder(f, name, NOW)!;
      expect(r, name).toBeDefined();
      recordReadings([asCodex(r)], NOW);
      expect(row("codex", name)?.plan, name).toBe(want);
    }
    recordReadings([{ account: "h-claude", agent: "claude", atMs: NOW, seven: { used: 3, resetsMs: NOW + 60_000 } }], NOW);
    expect(row("claude", "h-claude")!.plan).toBeNull();
    // An older table without the column gains it; its rows read NULL.
    const db = new DatabaseSync(join(TH, "state.db"));
    try {
      expect((db.prepare("PRAGMA table_info(usage_readings)").all() as any[]).map((c) => c.name)).toContain("plan");
    } finally { db.close(); }
  });

  it("(50) h2 an existing usage_readings table without plan gains the column; its rows keep NULL", () => {
    const th2 = join(BOX, "tandem-old");
    mkdirSync(th2, { mode: 0o700 });
    const db = new DatabaseSync(join(th2, "state.db"));
    db.exec(`CREATE TABLE usage_readings (account TEXT, agent TEXT, at_ms INTEGER, five_used REAL, five_resets_ms INTEGER,
      seven_used REAL, seven_resets_ms INTEGER, read_ms INTEGER, PRIMARY KEY (account, agent))`);
    db.prepare("INSERT INTO usage_readings VALUES ('old', 'claude', ?, NULL, NULL, 5, ?, ?)").run(NOW, NOW + 60_000, NOW);
    db.close();
    chmodSync(join(th2, "state.db"), 0o600);
    process.env.TANDEM_HOME = th2;
    try {
      recordReadings([{ account: "new", agent: "codex", atMs: NOW, seven: { used: 8, resetsMs: NOW + 60_000 }, plan: "pro" }], NOW);
      const rows = readUsage(NOW);
      expect(rows.find((r: any) => r.account === "old")).toMatchObject({ plan: null, seven_day: { used: 5 } });
      expect(rows.find((r: any) => r.account === "new")).toMatchObject({ plan: "pro", seven_day: { used: 8 } });
    } finally { process.env.TANDEM_HOME = TH; }
  });

  it("(50) i a Codex reading past its reset reads unknown (null), never the old share", () => {
    const f = folder("i-folder");
    rollout(f, "2026/11/12/rollout-i.jsonl", [rlLine(limits(win(10, 300, NOW + 600_000), win(50, 10080, NOW + 7_200_000)))]);
    recordReadings([asCodex(readCodexFolder(f, "i-folder", NOW))], NOW);
    expect(row("codex", "i-folder", NOW)).toMatchObject({ five_hour: { used: 10 }, seven_day: { used: 50 } });
    expect(row("codex", "i-folder", NOW + 3_600_000)).toMatchObject({ five_hour: { used: null, resetsAt: S(NOW + 600_000) * 1000 }, seven_day: { used: 50 } });
    expect(row("codex", "i-folder", NOW + 7_300_000)).toMatchObject({ five_hour: { used: null }, seven_day: { used: null, resetsAt: S(NOW + 7_200_000) * 1000 } });
  });

  it("(50) j the fixture (mini, codex-cli 0.167.1) parses into the expected numbers", () => {
    const lines = readFileSync(FIXTURE, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes('"rate_limits"'))).toHaveLength(1);
    const f = folder("j-folder");
    const p = join(f, "sessions", "2026", "11", "11", "rollout-2026-11-11T18-00-00-fixture.jsonl");
    mkdirSync(join(p, ".."), { recursive: true });
    fs.copyFileSync(FIXTURE, p);
    const at = Date.parse("2026-11-11T18:37:29.719Z");
    expect(readCodexFolder(f, "j", at + 60_000)).toEqual({
      account: "j", agent: "", atMs: at, seven: { used: 31, resetsMs: 1794474921_000 }, plan: "pro",
    });
  });

  it("(50) k the stored row holds numbers, times and the plan only: no other string from the fixture", () => {
    const f = folder("k-folder");
    const p = join(f, "sessions", "2026", "11", "11", "rollout-k.jsonl");
    mkdirSync(join(p, ".."), { recursive: true });
    fs.copyFileSync(FIXTURE, p);
    const at = Date.parse("2026-11-11T18:37:29.719Z");
    recordReadings([asCodex(readCodexFolder(f, "k-folder", at + 60_000))], at + 60_000);
    const db = new DatabaseSync(join(TH, "state.db"));
    let r: Record<string, unknown>;
    try {
      r = db.prepare("SELECT * FROM usage_readings WHERE account = 'k-folder' AND agent = 'codex'").get() as Record<string, unknown>;
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    expect(Object.keys(r).sort()).toEqual(["account", "agent", "at_ms", "five_resets_ms", "five_used", "plan", "read_ms", "seven_resets_ms", "seven_used"]);
    for (const [k, v] of Object.entries(r)) {
      if (k === "account" || k === "agent") continue;
      if (k === "plan") expect(v).toBe("pro");
      else expect(v === null || typeof v === "number", k).toBe(true);
    }
    const bytes = readFileSync(join(TH, "state.db")).toString("latin1");
    for (const s of ["token_count", "event_msg", "item_completed", "2026-11-11T18:37", "SESSION-TEXT", MARKER]) expect(bytes, s).not.toContain(s);
  });

  it("(50) l a harness with usage = \"rollout\" and no account_dir is refused by the loader; built-in codex reads its rollouts", () => {
    const owner = join(BOX, "l-owner");
    mkdirSync(owner, { mode: 0o700 });
    chmodSync(owner, 0o700);
    const base = (n: string) => `name = "${n}"\nprogram = "/usr/bin/true"\nhas_prompts = false\n`;
    writeFileSync(join(owner, "l-none.toml"), `${base("l-none")}usage = "rollout"\n`, { mode: 0o600 });
    writeFileSync(join(owner, "l-ok.toml"), `${base("l-ok")}usage = "rollout"\naccount_dir = "~/.l-ok"\n`, { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner });
    const reason = (n: string) => res.errors.find((e: any) => e.file === join(owner, `${n}.toml`))?.reason;
    expect(reason("l-none")).toBe('usage "rollout" needs account_dir');
    expect(res.harnesses.has("l-none")).toBe(false);
    expect(res.harnesses.get("l-ok")).toMatchObject({ usage: "rollout", account_dir: "~/.l-ok" });
    expect(res.harnesses.get("codex")).toMatchObject({ usage: "rollout", account_dir: "~/.codex", account_env: "CODEX_HOME" });
    expect(res.errors.filter((e: any) => e.file.startsWith(BUILTIN))).toEqual([]);
  });

  it("(50) m a line over 60 s ahead of now is skipped (the earlier line wins); a line with no parseable timestamp takes the file's mtime", () => {
    const f = folder("m-folder");
    rollout(f, "2026/11/12/rollout-m.jsonl", [rlLine(limits(win(21, 10080), null), iso(NOW - 120_000)), rlLine(limits(win(22, 10080), null), iso(NOW + 61_000))]);
    expect(readCodexFolder(f, "m", NOW)).toMatchObject({ atMs: NOW - 120_000, seven: { used: 21 } });
    rollout(f, "2026/11/12/rollout-m.jsonl", [rlLine(limits(win(21, 10080), null), iso(NOW - 120_000)), rlLine(limits(win(23, 10080), null), iso(NOW + 59_000))]);
    expect(readCodexFolder(f, "m", NOW)).toMatchObject({ atMs: NOW + 59_000, seven: { used: 23 } });
    const f2 = folder("m2-folder");
    rollout(f2, "2026/11/12/rollout-m2.jsonl", [rlLine(limits(win(24, 10080), null), null)], S(NOW - 300_000));
    expect(readCodexFolder(f2, "m2", NOW)).toMatchObject({ atMs: S(NOW - 300_000) * 1000, seven: { used: 24 } });
    rollout(f2, "2026/11/12/rollout-m2.jsonl", [rlLine(limits(win(25, 10080), null), "not a date")], S(NOW - 200_000));
    expect(readCodexFolder(f2, "m2", NOW)).toMatchObject({ atMs: S(NOW - 200_000) * 1000, seven: { used: 25 } });
    const f3 = folder("m3-folder");
    rollout(f3, "2026/11/12/rollout-m3.jsonl", [rlLine(limits(win(26, 10080), null), null)], S(NOW + 120_000));
    expect(readCodexFolder(f3, "m3", NOW)).toBeUndefined();
  });
});
