/**
 * U-R1A-53: `tandem status --json` (bridge/status.ts) gains `accounts`, the account list of one
 * read of the usage report (bridge/usage/report.ts, U-R1A-52), never refreshed; the text form
 * prints one line per account with its shares, reset times and age, stale marked, an unknown share
 * never shown as 0. A report that cannot be read gives `accounts: null` and one stderr line.
 *
 * Before any import: TZ=UTC, TMUX unset, TMUX_TMPDIR, TANDEM_HOME and HOME in a new r1a53- folder,
 * every agent folder variable and proxy variable unset, TANDEM_HUB_LINK_ID=alpha (this computer).
 * The clock is fake (T, year 2033) wherever a case can pass one; every statusDocument call passes a
 * probe, so no control socket is dialled. Only this file writes the store.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "OPENCODE_DATA_DIR", "ANTIGRAVITY_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
process.env.TZ = "UTC";
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "r1a53-")));
if (!relative(realpathSync(userInfo().homedir), BOX).startsWith("..")) throw new Error("r1a53: temp folder is under the real home");
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.HOME = join(BOX, "home");
mkdirSync(process.env.HOME, { mode: 0o700 });
for (const v of [...VARS, ...PROXIES, "TANDEM_HUB_LINK_URL", "TANDEM_HUB_LINK_TOKEN", "TANDEM_CALLER_TOKEN"]) delete process.env[v];
process.env.TANDEM_HUB_LINK_ID = "alpha";

const status = await import("../../bridge/status.ts");
const { createUsageReport } = await import("../../bridge/usage/report.ts");
const { recordReadings, recordTokens, readUsage, tokenRows } = await import("../../bridge/usage/store.ts");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const T = 2_000_000_000_000;
const now = () => T;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const probe = async () => ({ runtime: "not_running" as const });
const ACCOUNT_KEYS = ["agent", "account", "computer", "at", "ageMs", "stale", "five_hour", "seven_day", "plan", "room", "tokens", "cost_usd", "tokens_at", "tokens_age_ms", "tokens_computers", "tokens_note", "limit_note"];
const PAIRS = ["claude/max", "claude/work", "codex/main", "grok/grok"];
const pairs = (accounts: Json[]) => accounts.map((a) => `${a.agent}/${a.account}`);

/** The four accounts of SEED, times relative to `t`, into the current TANDEM_HOME. */
function seed(t: number) {
  recordReadings([
    { agent: "claude", account: "max", atMs: t - 120_000, five: { used: 42, resetsMs: t + 2 * HOUR + 5 * MIN }, seven: { used: 17, resetsMs: t + 4 * DAY + HOUR } },
    { agent: "claude", account: "work", atMs: t - 60_000, five: { used: 90, resetsMs: t - 600_000 }, seven: { used: 55, resetsMs: t + 3 * DAY + HOUR } },
    { agent: "codex", account: "main", atMs: t - 45 * MIN, five: { used: 80, resetsMs: t + 90 * MIN }, seven: { used: 30, resetsMs: t + 6 * DAY + HOUR }, plan: "pro" },
  ], t);
  recordTokens([{ agent: "grok", account: "grok", today: { tokens: 1200, cost: 0.5 }, total: { tokens: 50000, cost: 12 } }], t);
}
seed(T);

afterAll(() => {
  spawnSync("find", [BOX, "-type", "s", "-exec", "tmux", "-S", "{}", "kill-server", ";"]);
  rmSync(BOX, { recursive: true, force: true });
});

/** Runs `run` with stdout and stderr captured; returns what each received (as test/status-cli.test.ts). */
async function captured<R>(run: () => Promise<R>): Promise<{ value: R; out: string; err: string }> {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk: Json) => { out += String(chunk); return true; });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk: Json) => { err += String(chunk); return true; });
  try {
    return { value: await run(), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const doc = (over: Json = {}) => status.statusDocument({ now, probe, ...over }) as Promise<Json>;
const acct = (d: Json, pair: string) => d.accounts.find((a: Json) => `${a.agent}/${a.account}` === pair);

describe("(53) accounts in the status document", () => {
  it("(53) a1 shape: the key list ends with accounts, statusVersion 2, the report's accounts unchanged, 17 keys each, this computer alpha", async () => {
    const d = await doc();
    expect(Object.keys(d)).toEqual(["statusVersion", "version", "at", "runtime", "killSwitch", "computers", "accounts"]);
    expect(d.statusVersion).toBe(2);
    expect(status.STATUS_VERSION).toBe(2);
    // G7: presence's computer under TANDEM_HUB_LINK_ID=alpha.
    expect(d.computers[0]).toMatchObject({ computer: "alpha", self: true });
    expect(d.accounts).toEqual((await createUsageReport({ now, computer: "alpha" }).read()).accounts);
    for (const a of d.accounts) expect(Object.keys(a)).toEqual(ACCOUNT_KEYS);
    expect(pairs(d.accounts)).toEqual(PAIRS);
  });

  it("(53) a2 A11.5 readings: fresh, stale, unknown never 0, limit not available", async () => {
    const d = await doc();
    const max = acct(d, "claude/max");
    expect(max.five_hour).toEqual({ used: 42, resets_at: T + 2 * HOUR + 5 * MIN });
    expect(max).toMatchObject({ ageMs: 120000, stale: false, computer: "alpha" });
    expect(acct(d, "codex/main")).toMatchObject({ stale: true, ageMs: 2_700_000 });
    const work = acct(d, "claude/work");
    expect(work.five_hour.used).toBeNull();
    expect(work.seven_day.used).toBe(55);
    const grok = acct(d, "grok/grok");
    expect(grok.limit_note).toBe("limit: not available");
    expect([grok.five_hour.used, grok.seven_day.used, grok.ageMs]).toEqual([null, null, null]);
  });

  it("(53) a3 text form: the account lines in order after the computer lines; the first line unchanged", async () => {
    const d = await doc();
    const lines = status.renderStatus(d).split("\n");
    expect(lines[0]).toBe(`Tandem ${d.version} · runtime not running · kill switch off`);
    const want = [
      "accounts:",
      "  claude/max  5 h 42% resets in 2 h  7 d 17% resets in 4 d  · read 2 min ago on alpha",
      "  claude/work  5 h unknown  7 d 55% resets in 3 d  · read 1 min ago on alpha",
      "  codex/main  5 h 80% resets in 1 h  7 d 30% resets in 6 d  · stale · read 45 min ago on alpha",
      "  grok/grok  limit not available  · no share reading",
    ];
    const i = lines.indexOf("accounts:");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i, i + want.length)).toEqual(want);
    expect(lines.slice(i + want.length)).toEqual([""]);
    const lastComputer = Math.max(...lines.map((l: string, k: number) => (/ · \d+ sessions?: /.test(l) ? k : -1)));
    expect(lastComputer).toBeLessThan(i);
  });

  it("(53) a4 another computer's reading carries its computer", async () => {
    const spare = {
      agent: "codex", account: "spare", at: T - 5000, five_used: 10, five_resets: T + 2 * HOUR, seven_used: 5, seven_resets: T + 5 * DAY,
      plan: null, tokens_at: null, tokens_today: null, tokens_total: null, cost_today: null, cost_total: null, reason: null,
    };
    const usage = createUsageReport({ now, computer: "alpha", remote: () => [{ computer: "beta", receivedMs: T, rows: [spare] }] });
    const d = await doc({ usage });
    expect(acct(d, "codex/spare").computer).toBe("beta");
    const line = status.renderStatus(d).split("\n").find((l: string) => l.startsWith("  codex/spare  "));
    expect(line).toMatch(/· read 5 s ago on beta$/);
  });

  it("(53) a5 no state.db: accounts [] and `accounts: none reporting`", async () => {
    const fresh = join(BOX, "fresh");
    const was = process.env.TANDEM_HOME;
    process.env.TANDEM_HOME = fresh;
    try {
      const d = await doc();
      expect(d.accounts).toEqual([]);
      expect(status.renderStatus(d).split("\n")).toContain("accounts: none reporting");
    } finally {
      process.env.TANDEM_HOME = was;
    }
  });

  it("(53) a6 a report that throws: accounts null, exit 0, one stderr line with the code only", async () => {
    for (const [code, shown] of [["EACCES", "EACCES"], ["not a code", "error"]]) {
      const usage = { read: async () => { throw Object.assign(new Error("/r1a53-secret/path"), { code }); } };
      const r = await captured(() => status.main(["--json"], { now, probe, usage } as Json));
      expect(r.value).toBe(0);
      const d = JSON.parse(r.out);
      expect(d.accounts).toBeNull();
      expect(d.computers[0]).toMatchObject({ computer: "alpha", self: true });
      expect(r.err).toBe(`tandem status: account usage could not be read (${shown})\n`);
      for (const s of [r.out, r.err]) expect(s.includes("r1a53-secret")).toBe(false);
      expect(status.renderStatus(d).split("\n")).toContain("accounts: could not be read");
    }
  });

  it("(53) a7 a row with a name that fails NAME is dropped; the text form holds no control or format character", async () => {
    const good = {
      agent: "claude", account: "ok", computer: "alpha", at: T - 1000, ageMs: 1000, stale: false,
      five_hour: { used: 1, resets_at: T + HOUR }, seven_day: { used: 2, resets_at: T + DAY }, plan: null, room: 98,
      tokens: null, cost_usd: null, tokens_at: null, tokens_age_ms: null, tokens_computers: [], tokens_note: null, limit_note: null,
    };
    const bad = [
      { ...good, agent: "evil\u001b[2J" },
      { ...good, account: "x\nfake" },
      { ...good, computer: "b‮eta" },
      { ...good, tokens_computers: ["ok", "bad\u0007"] },
    ];
    const usage = { read: async () => ({ computer: "alpha", at: T, accounts: [good, ...bad], most_room: [], notices: [] }) };
    const d = await doc({ usage });
    expect(d.accounts).toEqual([good]);
    const text = status.renderStatus(d);
    expect(/[\p{Cc}\p{Cf}]/u.test(text.replace(/\n/g, "")), JSON.stringify(text)).toBe(false);
  });

  it("(53) a8 a pre-53 document (no accounts key) prints no accounts line", () => {
    const c = { computer: "gamma", self: false, at: 1, ageMs: 5000, stale: false, more: 0, counts: { working: 0, idle: 0, waiting_for_approval: 0, unknown: 0 }, sessions: [] };
    const lines = status.renderStatus({ statusVersion: 2, version: "9.9.9", at: 1, runtime: "running", killSwitch: "on", computers: [c] } as Json).split("\n");
    expect(lines.some((l: string) => l.startsWith("accounts"))).toBe(false);
  });

  it("(53) a9 the command in its own process: exit 0, JSON with the four accounts, no ExperimentalWarning", () => {
    const home9 = join(BOX, "home9");
    const th9 = join(BOX, "tandem9");
    mkdirSync(home9, { mode: 0o700 });
    const was = process.env.TANDEM_HOME;
    process.env.TANDEM_HOME = th9;
    try {
      seed(Date.now());
    } finally {
      process.env.TANDEM_HOME = was;
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "bridge", "status.ts"), "--json"], {
      encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: home9, TANDEM_HOME: th9, TANDEM_HUB_LINK_ID: "alpha" },
    });
    expect(r.status, r.stderr).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(pairs(d.accounts)).toEqual(PAIRS);
    expect(r.stderr).not.toContain("ExperimentalWarning");
  });

  it("(53) a10 read only: no helper ran and no drop was re-read", async () => {
    const tokensBefore = tokenRows();
    const usageBefore = readUsage(T);
    await doc();
    expect(tokenRows()).toEqual(tokensBefore);
    expect(readUsage(T)).toEqual(usageBefore);
  });
});
