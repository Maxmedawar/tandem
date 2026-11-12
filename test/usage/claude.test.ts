/**
 * U-R1A-49: Claude Code accounts report their limits. Every Tandem Claude session gets, in its
 * per-session settings file (U-R1A-25), a statusLine command (bridge/usage/statusline-drop.ts)
 * that writes only `rate_limits` and the time to `<TANDEM_HOME>/usage/<agent>/<account>.json`,
 * then runs the account's own statusLine command with the same input. The collector reads the drop
 * files into state.db; a reading over 30 minutes old is stale, a window past its reset reads unknown.
 *
 * One table of rows over every surface of the invariant (evidence/TANDEM-U-R1A-49-INVARIANT.md).
 * Before any import: TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a49- folder. Each
 * account folder holds a `.credentials.json` at mode 0000. statusLine commands run as Claude runs
 * them: the command string through `/bin/sh -c`, the input bytes on stdin. No agent program starts.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOX = mkdtempSync(join(tmpdir(), "r1a49-"));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
const TH = join(BOX, "tandem");
process.env.TANDEM_HOME = TH;
const HOME = join(BOX, "home");
mkdirSync(HOME);
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
const WORK = join(BOX, "work");
const BIN = join(BOX, "bin");
const OWNER = join(BOX, "owner");
for (const d of [WORK, BIN, OWNER]) mkdirSync(d);
chmodSync(OWNER, 0o700);

const ACCT_A = join(BOX, "acct-a");
const ACCT_B = join(BOX, "acct-b");
const ACCT_C = join(BOX, "acct-c");
const LOOP = join(BOX, "acct-loop");
const DEFAULT = join(HOME, ".claude");
const OWN_A = `printf 'OWN-A %s' "$(wc -c | tr -d ' ')"`;
const account = (dir: string, settings?: unknown) => {
  mkdirSync(dir);
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(dir, ".credentials.json"), "{}");
  chmodSync(join(dir, ".credentials.json"), 0o000);
};
account(ACCT_A, { theme: "dark", statusLine: { type: "command", command: OWN_A, padding: 2 } });
account(ACCT_B, { theme: "dark" });
account(ACCT_C);
account(LOOP, { statusLine: { type: "command", command: "node --experimental-strip-types /x/bridge/usage/statusline-drop.ts work /x/usage/claude" } });
account(DEFAULT);

const dh = await import("../../bridge/delivery-hooks.ts");
const { HarnessSession } = await import("../../bridge/engines/harness-engine.ts");
const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { collectUsage, startUsageCollector } = await import("../../bridge/usage/collector.ts");
const { readUsage } = await import("../../bridge/usage/store.ts");
const { accountOf } = await import("../../bridge/usage/claude.ts");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterAll(() => {
  for (const sock of [join(BOX, `tmux-${process.getuid!()}`, "default"), join(TH, "tmux", "tandem")]) {
    if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  }
  rmSync(BOX, { recursive: true, force: true });
});

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const DROP_SCRIPT = fileURLToPath(new URL("../../bridge/usage/statusline-drop.ts", import.meta.url));
const DELIVERY = join(TH, "delivery");
const DROPS = join(TH, "usage", "claude");
const mode = (p: string) => statSync(p).mode & 0o777;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claude = () => loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.get("claude")!;

/** The fixture without `_source`, every string and empty array filled with a sentinel naming its path. */
const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/usage/claude/statusline-input.json", import.meta.url), "utf8"));
delete FIXTURE._source;
const SENTINELS: string[] = [];
function fill(v: any, at: string): any {
  if (typeof v === "string") { SENTINELS.push(`S3NT-${at}`); return `S3NT-${at}`; }
  if (Array.isArray(v)) { if (v.length === 0) { SENTINELS.push(`S3NT-${at}`); return [`S3NT-${at}`]; } return v.map((x, i) => fill(x, `${at}.${i}`)); }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, `${at}.${k}`)]));
  return v;
}
const INPUT = fill(FIXTURE, "in");
const INPUT_TEXT = JSON.stringify(INPUT);
const withLimits = (rate_limits: unknown) => JSON.stringify({ ...INPUT, rate_limits });
const nowS = () => Math.floor(Date.now() / 1000);

/** The single-quoted words of a statusLine command: [node, script, account, drop dir, chain file?]. */
const words = (cmd: string) => [...cmd.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
/** installHook for `name` with CLAUDE_CONFIG_DIR = `dir` (unset when undefined); the settings JSON. */
function install(name: string, dir: string | undefined, h: any = claude()): { argv: string[]; settings: any; cmd: string } {
  if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const argv = dh.installHook(h, name);
    const settings = JSON.parse(readFileSync(argv[1]!, "utf8"));
    return { argv, settings, cmd: settings.statusLine?.command };
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}
/** One statusLine run as Claude runs it. */
function run(cmd: string, input: string | Buffer) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { input, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}
/** process.stderr lines written while `fn` runs. */
function stderrOf(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => { lines.push(String(s)); return true; }) as any);
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join("").split("\n").filter(Boolean);
}
const usageRow = (acct: string, now = Date.now()) => readUsage(now).find((r: any) => r.account === acct && r.agent === "claude");

describe("(49) usage: Claude Code accounts report their limits", () => {
  let A: ReturnType<typeof install>;
  let B: ReturnType<typeof install>;

  it("(49) u1 two config folders give two accounts: two statusLine commands, two drop files, two rows", () => {
    A = install("r1a49-u1a", ACCT_A);
    B = install("r1a49-u1b", ACCT_B);
    expect(A.argv).toEqual(["--settings", join(DELIVERY, "r1a49-u1a.settings.json")]);
    expect(words(A.cmd).slice(0, 4)).toEqual([process.execPath, DROP_SCRIPT, "acct-a", DROPS]);
    expect(words(B.cmd)).toEqual([process.execPath, DROP_SCRIPT, "acct-b", DROPS]);
    expect(A.cmd.split(" ")[1]).toBe("--experimental-strip-types");
    expect(run(A.cmd, INPUT_TEXT).status).toBe(0);
    expect(run(B.cmd, INPUT_TEXT).status).toBe(0);
    expect(readdirSync(DROPS).sort()).toEqual(["acct-a.json", "acct-b.json"]);
    collectUsage(Date.now(), [claude()]);
    const rows = readUsage().filter((r: any) => r.agent === "claude");
    expect(rows.map((r: any) => r.account).sort()).toEqual(["acct-a", "acct-b"]);
    expect(usageRow("acct-a")).toMatchObject({ stale: false, five_hour: { used: 37.5, resetsAt: 4102444800_000 }, seven_day: { used: 12, resetsAt: 4102963200_000 } });
  });

  it("(49) u2 the drop file holds nothing but rate_limits (5 h, 7 d) and the time; 0600 in a 0700 folder; state.db holds no session text", () => {
    const before = Date.now();
    expect(run(A.cmd, INPUT_TEXT).status).toBe(0);
    const file = join(DROPS, "acct-a.json");
    const bytes = readFileSync(file, "utf8");
    const json = JSON.parse(bytes);
    expect(Object.keys(json)).toEqual(["at", "rate_limits"]);
    expect(json.at).toBeGreaterThanOrEqual(before);
    expect(json.at).toBeLessThanOrEqual(Date.now());
    expect(json.rate_limits).toStrictEqual({
      five_hour: { used_percentage: 37.5, resets_at: 4102444800 },
      seven_day: { used_percentage: 12, resets_at: 4102963200 },
    });
    expect(bytes).not.toContain("spend_limit");
    for (const s of SENTINELS) expect(bytes).not.toContain(s);
    for (const k of ["session_id", "transcript_path", "cwd", "model", "workspace", "cost", "context_window", "prompt_cache"]) expect(bytes).not.toContain(k);
    expect(mode(file)).toBe(0o600);
    expect(mode(DROPS)).toBe(0o700);
    collectUsage(Date.now(), [claude()]);
    const db = new DatabaseSync(join(TH, "state.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM usage_readings").all() as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual(["account", "agent", "at_ms", "five_resets_ms", "five_used", "read_ms", "seven_resets_ms", "seven_used"]);
        for (const [k, v] of Object.entries(r)) if (k !== "account" && k !== "agent") expect(v === null || typeof v === "number").toBe(true);
        expect(r.account).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      }
    } finally { db.close(); }
    for (const f of readdirSync(TH).filter((f) => f.startsWith("state.db"))) {
      const raw = readFileSync(join(TH, f), "latin1");
      for (const s of SENTINELS) expect(raw).not.toContain(s);
    }
  });

  it("(49) u3 the owner's own statusLine output still prints, byte for byte, with his padding", () => {
    const r = run(A.cmd, INPUT_TEXT);
    expect(r.stdout).toBe(`OWN-A ${Buffer.byteLength(INPUT_TEXT)}`);
    expect(r.stderr).toBe("");
    expect(A.settings.statusLine).toMatchObject({ type: "command", padding: 2 });
    expect(Object.keys(A.settings)).toEqual(["hooks", "statusLine"]);
    const chain = join(DELIVERY, "r1a49-u1a.statusline");
    expect(words(A.cmd)[4]).toBe(chain);
    expect(readFileSync(chain, "utf8")).toBe(OWN_A);
    expect(mode(chain)).toBe(0o600);
  });

  it("(49) u4 a folder with no statusLine of its own gets only the drop file", () => {
    const r = run(B.cmd, INPUT_TEXT);
    expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(existsSync(join(DELIVERY, "r1a49-u1b.statusline"))).toBe(false);
    expect(words(B.cmd)).toHaveLength(4);
    expect(B.settings.statusLine).toStrictEqual({ type: "command", command: B.cmd });
    expect(existsSync(join(DROPS, "acct-b.json"))).toBe(true);
  });

  it("(49) u5 a 31-minute-old reading is stale with one notice; 29 minutes is fresh; no second notice while still stale", () => {
    const C = install("r1a49-u5", ACCT_C);
    expect(run(C.cmd, INPUT_TEXT).status).toBe(0);
    const at = JSON.parse(readFileSync(join(DROPS, "acct-c.json"), "utf8")).at as number;
    const mine = (lines: string[]) => lines.filter((l) => l.includes("account acct-c "));
    expect(mine(stderrOf(() => collectUsage(at + 29 * 60_000, [claude()])))).toEqual([]);
    expect(usageRow("acct-c", at + 29 * 60_000)).toMatchObject({ stale: false, ageMs: 29 * 60_000 });
    expect(mine(stderrOf(() => collectUsage(at + 31 * 60_000, [claude()])))).toEqual(["usage: claude account acct-c has not reported for 31 min"]);
    expect(usageRow("acct-c", at + 31 * 60_000)).toMatchObject({ stale: true, ageMs: 31 * 60_000, at });
    expect(mine(stderrOf(() => collectUsage(at + 32 * 60_000, [claude()])))).toEqual([]);
    // Fresh again, then stale again: one more notice.
    expect(run(C.cmd, INPUT_TEXT).status).toBe(0);
    const at2 = JSON.parse(readFileSync(join(DROPS, "acct-c.json"), "utf8")).at as number;
    expect(mine(stderrOf(() => collectUsage(at2 + 60_000, [claude()])))).toEqual([]);
    expect(mine(stderrOf(() => collectUsage(at2 + 40 * 60_000, [claude()])))).toEqual(["usage: claude account acct-c has not reported for 40 min"]);
  });

  it("(49) u6 a window past its reset reads unknown (null), never the old number; the other window keeps its number", () => {
    const C = install("r1a49-u6", ACCT_C);
    const past = nowS() - 60;
    const future = nowS() + 3600;
    expect(run(C.cmd, withLimits({ five_hour: { used_percentage: 88, resets_at: past }, seven_day: { used_percentage: 41, resets_at: future } })).status).toBe(0);
    const now = Date.now();
    collectUsage(now, [claude()]);
    const row = usageRow("acct-c", now)!;
    expect(row.five_hour).toEqual({ used: null, resetsAt: past * 1000 });
    expect(row.seven_day).toEqual({ used: 41, resetsAt: future * 1000 });
    // A fresh reading turns unknown once its reset passes.
    expect(usageRow("acct-c", future * 1000)!.seven_day).toEqual({ used: null, resetsAt: future * 1000 });
    expect(usageRow("acct-c", future * 1000 - 1)!.seven_day.used).toBe(41);
  });

  it("(49) u7 no rate_limits, or only spend_limit: the earlier drop file stays as it was and the reading keeps its age", () => {
    const file = join(DROPS, "acct-a.json");
    const before = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    const { rate_limits: _, ...noLimits } = INPUT;
    for (const input of [JSON.stringify(noLimits), withLimits({ spend_limit: INPUT.rate_limits.spend_limit }), withLimits({})]) {
      const r = run(A.cmd, input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`OWN-A ${Buffer.byteLength(input)}`);
      expect(readFileSync(file)).toEqual(before);
      expect(statSync(file).mtimeMs).toBe(mtime);
    }
    const at = JSON.parse(before.toString("utf8")).at as number;
    collectUsage(at + 5 * 60_000, [claude()]);
    expect(usageRow("acct-a", at + 5 * 60_000)).toMatchObject({ at, ageMs: 5 * 60_000 });
  });

  it("(49) u8 hostile input: no drop write for a bad window, exit 0, stdout only the chain's, no stack trace", () => {
    const file = join(DROPS, "acct-a.json");
    const before = readFileSync(file);
    const future = nowS() + 3600;
    const w = (used_percentage: unknown, resets_at: unknown = future) => ({ used_percentage, resets_at });
    const bad: [string, string | Buffer][] = [
      ["not JSON", "{not json S3NT-x"],
      ["2 MiB", Buffer.alloc(2 * 1024 * 1024, 0x20)],
      ["2 MiB of JSON", withLimits({ five_hour: w(10), pad: "x".repeat(2 * 1024 * 1024) })],
      ["used as a string", withLimits({ five_hour: w("50"), seven_day: w("50") })],
      ["used not finite", withLimits({ five_hour: w("__INF__") }).replace('"__INF__"', "1e999")],
      ["used -1", withLimits({ five_hour: w(-1) })],
      ["used 101", withLimits({ five_hour: w(101) })],
      ["resets_at 0", withLimits({ five_hour: w(5, 0) })],
      ["resets_at a string", withLimits({ five_hour: w(5, String(future)) })],
      ["windows not objects", withLimits({ five_hour: "S3NT-w", seven_day: [1, 2] })],
      ["rate_limits a string", withLimits("S3NT-rl")],
      ["top level an array", "[1,2,3]"],
    ];
    for (const [label, input] of bad) {
      const r = run(A.cmd, input);
      expect(r.status, label).toBe(0);
      expect(r.stdout, label).toMatch(/^OWN-A \d+$/);
      expect(r.stderr, label).not.toMatch(/\n\s+at |Error:|S3NT|\/|node:/);
      expect(r.stderr.split("\n").filter(Boolean).length, label).toBeLessThanOrEqual(1);
      expect(readFileSync(file), label).toEqual(before);
    }
    expect(run(A.cmd, "{not json").stdout).toBe("OWN-A 9");
    // One bad window, one good one: only the good one is written.
    const r = run(A.cmd, withLimits({ five_hour: w(101), seven_day: w(20) }));
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).rate_limits).toStrictEqual({ seven_day: { used_percentage: 20, resets_at: future } });
    // A bad account or drop dir argument: nothing written, still the owner's line, exit 0.
    const [node, script, , dir, chain] = words(A.cmd);
    for (const args of [["../x", dir], ["Bad Name", dir], ["acct-z", "relative/dir"]]) {
      const q = (s: string) => `'${s}'`;
      const out = run([q(node!), "--experimental-strip-types", q(script!), q(args[0]!), q(args[1]!), q(chain!)].join(" "), INPUT_TEXT);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe(`OWN-A ${Buffer.byteLength(INPUT_TEXT)}`);
    }
    expect(readdirSync(DROPS).sort()).toEqual(["acct-a.json", "acct-b.json", "acct-c.json"]);
  });

  it("(49) u9 usage.toml names a listed folder; 0644 or an unknown key refuses the file; the default account is ~/.claude named claude", () => {
    const toml = join(TH, "usage.toml");
    const listed = `[[accounts]]\nname = "work"\nagent = "claude"\nfolder = ${JSON.stringify(ACCT_A)}\n`;
    writeFileSync(toml, listed, { mode: 0o600 });
    chmodSync(toml, 0o600);
    let lines = stderrOf(() => { expect(words(install("r1a49-u9", ACCT_A).cmd)[2]).toBe("work"); });
    expect(lines).toEqual([]);
    expect(words(install("r1a49-u9", ACCT_B).cmd)[2]).toBe("acct-b");
    chmodSync(toml, 0o644);
    lines = stderrOf(() => { expect(words(install("r1a49-u9", ACCT_A).cmd)[2]).toBe("acct-a"); });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: .+; accounts are named after their folders$/);
    expect(lines[0]).not.toContain("/");
    writeFileSync(toml, `${listed}color = "red"\n`);
    chmodSync(toml, 0o600);
    lines = stderrOf(() => { expect(words(install("r1a49-u9", ACCT_A).cmd)[2]).toBe("acct-a"); });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: .+; accounts are named after their folders$/);
    for (const text of [`[[accounts]]\nname = "Work"\nagent = "claude"\nfolder = "/x"\n`, `[[accounts]]\nname = "w"\nagent = "claude"\nfolder = "x"\n`,
      `${listed}${listed}`, `other = 1\n`, `[[accounts]]\nname = "w"\nagent = "claude"\n`]) {
      writeFileSync(toml, text);
      lines = stderrOf(() => { expect(words(install("r1a49-u9", ACCT_A).cmd)[2]).toBe("acct-a"); });
      expect(lines).toHaveLength(1);
    }
    rmSync(toml);
    const d = install("r1a49-u9", undefined);
    expect(words(d.cmd)[2]).toBe("claude");
    expect(accountOf(claude())).toEqual({ folder: fs.realpathSync(DEFAULT), name: "claude" });
    expect(accountOf({ ...claude(), account_env: "R1A49_UNSET" })).toEqual({ folder: fs.realpathSync(DEFAULT), name: "claude" });
  });

  it("(49) u10 no loop: an own statusLine that is the drop command gets no chain file, drop only", () => {
    const L = install("r1a49-u10", LOOP);
    expect(words(L.cmd)).toHaveLength(4);
    expect(existsSync(join(DELIVERY, "r1a49-u10.statusline"))).toBe(false);
    expect(run(L.cmd, INPUT_TEXT)).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(existsSync(join(DROPS, "acct-loop.json"))).toBe(true);
  });

  it("(49) u11 the wiring: spawn puts the statusLine in the --settings file it names; no usage = BASE's settings; close removes both files", async () => {
    const AGENT = join(BIN, "r1a49-agent.sh");
    writeFileSync(AGENT, `#!/bin/sh\nout=$1\nshift\n: > "$out.tmp"\nfor a in "$@"; do printf '%s\\n' "$a" >> "$out.tmp"; done\nmv "$out.tmp" "$out"\nprintf 'r1a49>'\nexec sleep 600\n`, { mode: 0o755 });
    const STATES = { idle: ["r1a49>\\z"], debounce_ms: 200, precedence: ["waiting_for_approval", "working", "idle"] };
    const out = join(BOX, "r1a49-spawn.argv");
    const h = {
      name: "r1a49-own", program: AGENT, programPath: AGENT, args: [out], skip_prompts_args: [], resume: [], fork: [], has_prompts: false,
      account_env: "CLAUDE_CONFIG_DIR", delivery: "hook", hook: "--settings", usage: "statusline", permission_hook: false, reports_context: false,
      source: "owner", file: join(OWNER, "r1a49-own.toml"), kind: "agent", states: STATES,
    } as any;
    process.env.CLAUDE_CONFIG_DIR = ACCT_A;
    let s;
    try {
      s = await HarnessSession.spawn(h, { name: "r1a49-spawn", cwd: WORK, allowlist: [WORK] });
    } finally { delete process.env.CLAUDE_CONFIG_DIR; }
    const settings = join(DELIVERY, "r1a49-spawn.settings.json");
    const chain = join(DELIVERY, "r1a49-spawn.statusline");
    try {
      for (let i = 0; i < 100 && !existsSync(out); i++) await sleep(100);
      const argv = readFileSync(out, "utf8").split("\n").slice(0, -1);
      expect(argv.slice(-2)).toEqual(["--settings", settings]);
      const json = JSON.parse(readFileSync(settings, "utf8"));
      expect(words(json.statusLine.command)).toEqual([process.execPath, DROP_SCRIPT, "acct-a", join(TH, "usage", "r1a49-own"), chain]);
      expect(json.statusLine.padding).toBe(2);
      expect(readFileSync(chain, "utf8")).toBe(OWN_A);
    } finally {
      await s.close();
    }
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(chain)).toBe(false);
    const { usage: _, ...plain } = h;
    process.env.CLAUDE_CONFIG_DIR = ACCT_A;
    try {
      const file = dh.installHook(plain, "r1a49-plain")[1]!;
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["hooks"]);
      expect(existsSync(join(DELIVERY, "r1a49-plain.statusline"))).toBe(false);
    } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  }, 30_000);

  it("(49) u12 loader: usage needs a settings-file hook; bad usage and account_dir refuse with the exact texts; built-in claude has both keys", () => {
    const owner = join(BOX, "u12-owner");
    mkdirSync(owner, { mode: 0o700 });
    chmodSync(owner, 0o700);
    const base = (n: string) => `name = "${n}"\nprogram = "/usr/bin/true"\nhas_prompts = false\n`;
    const files: Record<string, string> = {
      "u12-ok": `${base("u12-ok")}delivery = "hook"\nhook = "--settings"\nusage = "statusline"\naccount_env = "R1A49_DIR"\naccount_dir = "~/.u12"\n`,
      "u12-sf": `${base("u12-sf")}delivery = "hook"\nhook = "--settings"\nhook_format = "settings-file"\nusage = "statusline"\naccount_dir = "/abs/u12"\n`,
      "u12-caps": `${base("u12-caps")}delivery = "hook"\nhook = "--settings"\nusage = "Statusline"\n`,
      "u12-int": `${base("u12-int")}delivery = "hook"\nhook = "--settings"\nusage = 1\n`,
      "u12-co": `${base("u12-co")}delivery = "hook"\nhook = "--config"\nhook_format = "config-overrides"\nusage = "statusline"\n`,
      "u12-notice": `${base("u12-notice")}usage = "statusline"\n`,
      "u12-rel": `${base("u12-rel")}account_dir = "rel/dir"\n`,
      "u12-none": `${base("u12-none")}delivery = "hook"\nhook = "--settings"\n`,
    };
    for (const [n, t] of Object.entries(files)) writeFileSync(join(owner, `${n}.toml`), t, { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner });
    const reason = (n: string) => res.errors.find((e: any) => e.file === join(owner, `${n}.toml`))?.reason;
    expect(res.harnesses.get("u12-ok")).toMatchObject({ usage: "statusline", account_dir: "~/.u12" });
    expect(res.harnesses.get("u12-sf")).toMatchObject({ usage: "statusline", account_dir: "/abs/u12" });
    expect(reason("u12-caps")).toBe('bad usage: "statusline"');
    expect(reason("u12-int")).toBe('bad usage: "statusline"');
    expect(reason("u12-co")).toBe('usage "statusline" needs a settings-file hook');
    expect(reason("u12-notice")).toBe('usage "statusline" needs a settings-file hook');
    expect(reason("u12-rel")).toBe("bad account_dir: must start with / or ~/");
    expect(res.harnesses.get("u12-none")).not.toHaveProperty("usage");
    expect(res.harnesses.get("u12-none")).not.toHaveProperty("account_dir");
    expect(res.harnesses.get("claude")).toMatchObject({ usage: "statusline", account_dir: "~/.claude", account_env: "CLAUDE_CONFIG_DIR" });
    expect(res.errors.filter((e: any) => e.file.startsWith(BUILTIN))).toEqual([]);
    for (const n of ["codex", "gemini", "shell"]) expect(res.harnesses.get(n)).not.toHaveProperty("usage");
  });

  it("(49) u13 login files: never opened; the bridge-side calls open only settings.json, usage.toml and paths under TANDEM_HOME", () => {
    for (const d of [ACCT_A, ACCT_B, ACCT_C, LOOP, DEFAULT]) expect(mode(join(d, ".credentials.json"))).toBe(0);
    writeFileSync(join(TH, "usage.toml"), `[[accounts]]\nname = "work"\nagent = "claude"\nfolder = ${JSON.stringify(ACCT_A)}\n`, { mode: 0o600 });
    const h = claude();
    const opened: string[] = [];
    const record = (p: unknown) => { if (typeof p === "string" || p instanceof URL) opened.push(String(p)); };
    const realOpen = fs.openSync;
    const realRead = fs.readFileSync;
    const o = vi.spyOn(fs, "openSync").mockImplementation(((p: any, ...rest: any[]) => { record(p); return (realOpen as any)(p, ...rest); }) as any);
    const r = vi.spyOn(fs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) => { record(p); return (realRead as any)(p, ...rest); }) as any);
    syncBuiltinESMExports();
    let a: string[];
    let b: string[];
    try {
      process.env.CLAUDE_CONFIG_DIR = ACCT_A;
      a = dh.installHook(h, "r1a49-u13a");
      process.env.CLAUDE_CONFIG_DIR = ACCT_B;
      b = dh.installHook(h, "r1a49-u13b");
      delete process.env.CLAUDE_CONFIG_DIR;
      collectUsage(Date.now(), [h]);
      readUsage();
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      o.mockRestore();
      r.mockRestore();
      syncBuiltinESMExports();
      rmSync(join(TH, "usage.toml"));
    }
    expect(opened.length).toBeGreaterThan(0);
    expect(opened).toContain(join(TH, "usage.toml"));
    expect(opened.some((p) => p.endsWith(join("acct-a", "settings.json")))).toBe(true);
    for (const p of opened) {
      const ok = p.endsWith("/settings.json") || p === join(TH, "usage.toml") || p.startsWith(`${TH}/`);
      expect(ok, p).toBe(true);
      expect(p).not.toMatch(/credentials|auth\.json|keychain|oauth/i);
    }
    // The statusLine runs (their own processes) leave the login files untouched too: still 0000, still there.
    expect(run(JSON.parse(readFileSync(a[1]!, "utf8")).statusLine.command, INPUT_TEXT).status).toBe(0);
    expect(run(JSON.parse(readFileSync(b[1]!, "utf8")).statusLine.command, INPUT_TEXT).status).toBe(0);
    for (const d of [ACCT_A, ACCT_B]) expect(mode(join(d, ".credentials.json"))).toBe(0);
  });

  it("(49) u14 an account folder or TANDEM_HOME holding ' : installHook throws and writes nothing", () => {
    const q = join(BOX, "acct'q");
    account(q, { statusLine: { type: "command", command: OWN_A } });
    const before = readdirSync(DELIVERY).sort();
    expect(() => install("r1a49-u14", q)).toThrow();
    expect(readdirSync(DELIVERY).sort()).toEqual(before);
    const qh = join(BOX, "th'q");
    process.env.TANDEM_HOME = qh;
    try {
      expect(() => install("r1a49-u14", ACCT_A)).toThrow();
    } finally { process.env.TANDEM_HOME = TH; }
    expect(existsSync(qh)).toBe(false);
    expect(readdirSync(DELIVERY).sort()).toEqual(before);
  });

  it("(49) u15 the collector skips drop files that break the shape, symlinks and bad names; startUsageCollector runs a pass and stops", () => {
    const now = Date.now();
    const good = { at: now, rate_limits: { five_hour: { used_percentage: 3, resets_at: nowS() + 600 } } };
    const put = (n: string, v: unknown) => { writeFileSync(join(DROPS, n), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 }); chmodSync(join(DROPS, n), 0o600); };
    put("x-text.json", { ...good, model: "S3NT-model" });
    put("x-win.json", { at: now, rate_limits: { five_hour: { used_percentage: 3, resets_at: 9, session_id: "S3NT" } } });
    put("x-bad.json", "{nope");
    put("Bad_Name.json", good);
    put("x-open.json", good);
    chmodSync(join(DROPS, "x-open.json"), 0o644);
    fs.symlinkSync(join(DROPS, "acct-a.json"), join(DROPS, "x-link.json"));
    put("x-ok.json", good);
    const stop = startUsageCollector({ everyMs: 3_600_000, now: () => now });
    stop();
    const names = readUsage(now).map((r: any) => r.account);
    expect(names).toContain("x-ok");
    for (const n of ["x-text", "x-win", "x-bad", "Bad_Name", "x-open", "x-link"]) expect(names).not.toContain(n);
  });

  it("(49) u16 audit: a drop file whose time is ahead of the clock, not a whole number, or whose reset is out of range is skipped; it never pins a row", () => {
    const now = Date.now();
    const win = { five_hour: { used_percentage: 3, resets_at: nowS() + 600 } };
    const put = (n: string, text: string) => { writeFileSync(join(DROPS, n), text, { mode: 0o600 }); chmodSync(join(DROPS, n), 0o600); };
    put("y-ahead.json", JSON.stringify({ at: now + 10 * 60_000, rate_limits: win }));
    put("y-huge.json", `{"at":1e300,"rate_limits":${JSON.stringify(win)}}`);
    put("y-frac.json", JSON.stringify({ at: now - 0.5, rate_limits: win }));
    put("y-reset.json", `{"at":${now},"rate_limits":{"five_hour":{"used_percentage":3,"resets_at":1e300}}}`);
    put("y-ok.json", JSON.stringify({ at: now, rate_limits: win }));
    collectUsage(now, [claude()]);
    const names = readUsage(now).map((r: any) => r.account);
    expect(names).toContain("y-ok");
    for (const n of ["y-ahead", "y-huge", "y-frac", "y-reset"]) expect(names).not.toContain(n);
    for (const r of readUsage(now)) expect(r.ageMs).toBeGreaterThanOrEqual(0);
    // The same account reports honestly later: its row is there and goes stale like any other.
    put("y-ahead.json", JSON.stringify({ at: now + 1000, rate_limits: win }));
    collectUsage(now + 2000, [claude()]);
    expect(usageRow("y-ahead", now + 40 * 60_000)).toMatchObject({ stale: true });
  });
});
