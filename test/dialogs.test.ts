/**
 * U-R1A-18B: warmup answers an agent's first-run dialog (folder trust, update notice, bypass
 * accept) only from its harness file's `[[dialogs]]` rows, only when the spawn's `dialogAnswers`
 * allows that kind, and only after the screen shows that exact dialog with the answer selected.
 * Anything else fails the start with a `needs owner` error and types nothing.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a18b-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents
 * run. Cleanup is `tmux -S <that folder>/tmux-<uid>/default kill-server` after `test -S`.
 * HOME and TANDEM_HOME are folders in it too, so the audit lines and transcripts land there.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-dialog.mjs", import.meta.url));
const SCREENS = fileURLToPath(new URL("./fixtures/screens/", import.meta.url));
const DIALOGS = fileURLToPath(new URL("./fixtures/dialogs/", import.meta.url));
const BOX = mkdtempSync("/tmp/r1a18b-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, `tmux-${process.getuid!()}`, "default");
const HOME = join(BOX, "home");
const WORK = join(BOX, "work");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");
const FIXED = join(BOX, "screens");
const LOGS = join(BOX, "logs");
for (const d of [HOME, WORK, FIXED, LOGS]) mkdirSync(d);
mkdirSync(OWNER, { recursive: true });
chmodSync(OWNER, 0o700);
process.env.HOME = HOME;
process.env.TANDEM_HOME = TANDEM_HOME;
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_ENABLED_ENGINES = "r1a18b-rtrust,r1a18b-rbypass,r1a18b-radopt";
process.env.PATH = `/usr/bin:/bin:${process.env.PATH ?? ""}`;

/** The screens fake-dialog.mjs draws ("@ " lines are its options; "#again" redraws after a choice). */
const screen = (file: string, text: string) => {
  const path = join(FIXED, file);
  writeFileSync(path, text);
  return path;
};
const TRUST = screen("trust.txt", " Do you trust this folder?\n\n@ No, exit\n@ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n");
const TRUST_AGAIN = screen("trust-again.txt", "#again\n Do you trust this folder?\n\n@ No, exit\n@ Yes, I trust this folder\n");
const BYPASS = screen("bypass.txt", " WARNING: running in Bypass Permissions mode\n\n@ No, exit\n@ Yes, I accept\n");
const SIGNIN = screen("signin.txt", " Do you trust this folder? Sign in to continue.\n\n@ No, exit\n@ Yes, I trust this folder\n");
const KEYED = screen("keyed.txt", " Do you trust the contents of this directory?\n\n@ Yes, proceed            y\n@ No, quit                n\n");

const RULES_TOML = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`;
const TRUST_ROW = { name: "folder-trust", kind: "trust", match: ["(?i)trust this folder"], answer: "Yes, I trust this folder", highlight: "❯" };
const BYPASS_ROW = { name: "bypass-accept", kind: "bypass", match: ["(?i)bypass permissions mode"], answer: "Yes, I accept", highlight: "❯" };
const KEY_ROW = { name: "folder-trust", kind: "trust", match: ["Do you trust the contents of this directory\\?"], answer: "Yes, proceed", key: "y" };
const rowToml = (r: Record<string, unknown>) =>
  "[[dialogs]]\n" +
  Object.entries(r)
    .map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.map((x) => `'${x}'`).join(", ")}]` : `'${v}'`}`)
    .join("\n") +
  "\n";
const ownerFile = (name: string, args: string[], rows: Record<string, unknown>[]) =>
  writeFileSync(
    join(OWNER, `${name}.toml`),
    `name = "${name}"\nprogram = "${FAKE}"\nargs = [${args.map((a) => `"${a}"`).join(", ")}]\nhas_prompts = true\n${RULES_TOML}${rows.map(rowToml).join("")}`,
    { mode: 0o600 },
  );
const logOf = (name: string) => join(LOGS, `${name}.log`);
ownerFile("r1a18b-rtrust", [TRUST, "0", logOf("rtrust")], [TRUST_ROW]);
ownerFile("r1a18b-rbypass", [BYPASS, "0", logOf("rbypass")], [BYPASS_ROW]);
ownerFile("r1a18b-radopt", [TRUST, "0", logOf("radopt")], [TRUST_ROW]);
// The audit table's files (review-fix U-R1A-18B-R1): a bypass dialog for a permission_skip folder, a
// trust dialog for a folder the limits file does not list, and a made-up `claude` first on PATH
// (the relay's two sessions run the built-in claude file) whose trust dialog also asks for a sign-in.
ownerFile("r1a18b-rskip", [BYPASS, "0", logOf("rskip")], [BYPASS_ROW]);
ownerFile("r1a18b-rdeny", [TRUST, "1", logOf("rdeny")], [TRUST_ROW]);
const BIN = join(BOX, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "claude"), `#!/bin/sh\nexec "${FAKE}" "${SIGNIN}" 1 "${logOf("claude")}"\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.TANDEM_ENABLED_ENGINES += ",r1a18b-rskip,r1a18b-rdeny,claude";

const ts: Record<string, any> = await import("../bridge/terminal-session.ts");
const registry: Record<string, any> = await import("../bridge/harness-registry.ts");
const { loadHarnesses } = registry;
const { HarnessSession } = await import("../bridge/engines/harness-engine.ts");
const { route } = await import("../bridge/router.ts");
const { loadedHarnesses, resetHarnessCache } = await import("../bridge/engine-registry.ts");
const { applyLimits } = await import("../bridge/limits.ts");
const { agentEntry, writeLimits } = await import("./fixtures/limits.ts");
const { makeOwnerIdProvider } = await import("../bridge/ownership.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tmuxHas = (name: string) => {
  try {
    tmux("has-session", "-t", `=ccm-${name}`);
    return true;
  } catch {
    return false;
  }
};
const keys = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const auditLog = join(HOME, ".tandem", "bridge.log");
const auditLines = (): Record<string, unknown>[] =>
  existsSync(auditLog) ? readFileSync(auditLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const rq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body });

const STATES = { working: ["^fake is thinking\\z"], idle: ["^fake>\\z"], waiting_for_approval: ["\\(y/n\\)\\z"], debounce_ms: 300, precedence: ["waiting_for_approval", "working", "idle"] };
/** An owner-style harness running fake-dialog.mjs by absolute path. */
function harness(name: string, screenFile: string, start: number, rows: Record<string, unknown>[], states: Record<string, unknown> | undefined = STATES) {
  return {
    name, program: FAKE, programPath: FAKE, args: [screenFile, String(start), logOf(name)],
    skip_prompts_args: [], resume: [], fork: [], has_prompts: true, states, dialogs: rows,
    delivery: "notice", permission_hook: false, reports_context: false, source: "owner", file: join(OWNER, `${name}.toml`), kind: "agent",
  } as any;
}
const spawn = (h: any, dialogAnswers?: string) =>
  HarnessSession.spawn(h, { name: h.name, cwd: WORK, allowlist: [WORK], ...(dialogAnswers ? { dialogAnswers } : {}) } as any);

/** The spawn fails with NeedsOwnerError and leaves no ccm-<name> session. */
async function needsOwner(h: any, dialogAnswers?: string): Promise<Error> {
  let caught: unknown;
  try {
    const s = await spawn(h, dialogAnswers);
    await s.close();
  } catch (e) {
    caught = e;
  }
  expect(ts.NeedsOwnerError).toBeTypeOf("function");
  expect(caught).toBeInstanceOf(ts.NeedsOwnerError);
  expect((caught as Error).message).toMatch(new RegExp(`^needs owner: ${h.name} shows its first-run \\w+ dialog "[a-z-]+" in .+; Tandem typed no answer\\. Open it there yourself once, then open the session again\\.$`));
  expect(tmuxHas(h.name)).toBe(false);
  return caught as Error;
}

afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a18b cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

describe("(a) the loader: [[dialogs]]", () => {
  const dir = join(BOX, "loader");
  mkdirSync(dir);
  const base = (name: string) => `name = "${name}"\nprogram = "/bin/echo"\nhas_prompts = true\n`;
  const ok = { name: "'t'", kind: "'trust'", match: "['(?i)trust']", answer: "'Yes'", highlight: "'❯'" };
  const table = (o: Record<string, string>) => "[[dialogs]]\n" + Object.entries(o).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n";
  const without = (k: string) => Object.fromEntries(Object.entries(ok).filter(([x]) => x !== k));
  const refused: [string, string][] = [
    ["an unknown key in a dialog", table({ ...ok, extra: "'x'" })],
    ["dialogs not an array of tables", `dialogs = "x"\n`],
    ["more than 8 dialogs", Array.from({ length: 9 }, (_, i) => table({ ...ok, name: `'t${i}'` })).join("")],
    ["a bad name", table({ ...ok, name: "'Bad_Name'" })],
    ["a missing name", table(without("name"))],
    ["two dialogs with one name", table(ok) + table(ok)],
    ["a bad kind", table({ ...ok, kind: "'login'" })],
    ["no match", table({ ...ok, match: "[]" })],
    ["5 match patterns", table({ ...ok, match: "['a', 'b', 'c', 'd', 'e']" })],
    ["a match that is not RE2", table({ ...ok, match: "['(a)\\1']" })],
    ["match not an array", table({ ...ok, match: "'trust'" })],
    ["an empty answer", table({ ...ok, answer: "''" })],
    ["an 81-character answer", table({ ...ok, answer: `'${"a".repeat(81)}'` })],
    ["an answer with a shell character", table({ ...ok, answer: "'Yes; rm'" })],
    ["an answer with a control character", table({ ...ok, answer: '"Yes\\u0007"' })],
    ["an answer matching NEVER (sign in)", table({ ...ok, answer: "'Sign in'" })],
    ["an answer matching NEVER (purchase)", table({ ...ok, answer: "'Purchase credits'" })],
    ["an answer matching NEVER (log in)", table({ ...ok, answer: "'Log in with a browser'" })],
    ["an update answer with update", table({ ...ok, kind: "'update'", answer: "'Update now'" })],
    ["an update answer with install", table({ ...ok, kind: "'update'", answer: "'Install'" })],
    ["an update answer with upgrade", table({ ...ok, kind: "'update'", answer: "'UPGRADE'" })],
    ["both highlight and key", table({ ...ok, key: "'y'" })],
    ["neither highlight nor key", table(without("highlight"))],
    ["a bad highlight", table({ ...ok, highlight: "'*'" })],
    ["a bad key (upper case)", table({ ...without("highlight"), key: "'Y'" })],
    ["a bad key (two characters)", table({ ...without("highlight"), key: "'yy'" })],
  ];
  it.each(refused)("refuses %s", (label, rows) => {
    const name = `d${refused.findIndex(([l]) => l === label)}`;
    const own = join(dir, name);
    mkdirSync(own);
    writeFileSync(join(own, `${name}.toml`), base(name) + rows);
    const { harnesses, errors } = loadHarnesses({ installDir: own, ownerDir: "/nonexistent-r1a18b", path: "/usr/bin" });
    expect(harnesses.has(name)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/dialogs/);
    expect(errors[0].reason).not.toBe("unknown field dialogs");
  });

  it("loads a good row (highlight mode and key mode), and an update row that skips", () => {
    const own = join(dir, "good");
    mkdirSync(own);
    const rows = table(ok) + table({ ...without("highlight"), name: "'k'", key: "'y'" }) + table({ ...ok, name: "'u'", kind: "'update'", answer: "'Skip'", highlight: "'>'" });
    writeFileSync(join(own, "good.toml"), base("good") + rows);
    const { harnesses, errors } = loadHarnesses({ installDir: own, ownerDir: "/nonexistent-r1a18b", path: "/usr/bin" });
    expect(errors).toEqual([]);
    expect(harnesses.get("good")?.dialogs).toEqual([
      { name: "t", kind: "trust", match: ["(?i)trust"], answer: "Yes", highlight: "❯" },
      { name: "k", kind: "trust", match: ["(?i)trust"], answer: "Yes", key: "y" },
      { name: "u", kind: "update", match: ["(?i)trust"], answer: "Skip", highlight: ">" },
    ]);
  });

  it("NEVER is the one exported regex of the brief", () => {
    expect(registry.NEVER).toBeInstanceOf(RegExp);
    expect(String(registry.NEVER)).toBe(String(/sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|login|purchase|buy|subscri|payment|billing|credit card/i));
  });

  it("the 4 built-in files load with their rows", () => {
    const { harnesses, errors } = loadHarnesses({ ownerDir: "/nonexistent-r1a18b" });
    for (const n of ["claude", "codex", "grok", "antigravity"]) expect(errors.filter((e: any) => e.file.endsWith(`/${n}.toml`))).toEqual([]);
    expect(harnesses.get("claude")?.dialogs).toEqual([
      { name: "folder-trust", kind: "trust", match: ["(?i)trust this folder"], answer: "Yes, I trust this folder", highlight: "❯" },
      { name: "bypass-accept", kind: "bypass", match: ["(?i)bypass permissions mode"], answer: "Yes, I accept", highlight: "❯" },
    ]);
    expect(harnesses.get("codex")?.dialogs).toEqual([
      { name: "folder-trust", kind: "trust", match: ["(?i)trust this folder\\?"], answer: "Trust and continue", highlight: "›" },
      { name: "folder-trust-old", kind: "trust", match: ["(?i)do you trust the contents of this directory"], answer: "Yes, continue", highlight: "›" },
      { name: "update", kind: "update", match: ["(?i)update available"], answer: "Skip", highlight: "›" },
    ]);
    expect(harnesses.get("antigravity")?.dialogs).toEqual([
      { name: "folder-trust", kind: "trust", match: ["(?i)do you trust the contents of this project\\?"], answer: "Yes, I trust this folder", highlight: ">" },
    ]);
    expect(harnesses.get("grok")?.dialogs).toEqual([
      { name: "folder-trust", kind: "trust", match: ["Do you trust the contents of this directory\\?"], answer: "Yes, proceed", key: "y" },
    ]);
  });
});

describe("(b) the fixtures: which file shows which dialog, and its key", () => {
  const builtins = () => {
    const { harnesses } = loadHarnesses({ ownerDir: "/nonexistent-r1a18b" });
    return Object.fromEntries(["claude", "codex", "grok", "antigravity"].map((n) => [n, harnesses.get(n)!])) as Record<string, any>;
  };
  const shown = (pane: string, h: any) => (typeof ts.shownDialogs === "function" ? ts.shownDialogs(pane, h.dialogs ?? []) : undefined);
  const owned: [string, string, string, string, string][] = [
    ["antigravity-trust-real.txt", DIALOGS, "antigravity", "folder-trust", "Enter"],
    ["grok-trust-real.txt", DIALOGS, "grok", "folder-trust", "y"],
    ["codex-trust-strings.txt", DIALOGS, "codex", "folder-trust", "Enter"],
    ["codex-trustold-strings.txt", DIALOGS, "codex", "folder-trust-old", "Enter"],
    ["codex-unknown-update.txt", SCREENS, "codex", "update", "Down"],
  ];
  it("every file in test/fixtures/dialogs is in this table", () => {
    expect(readdirSync(DIALOGS).sort()).toEqual(owned.filter(([, d]) => d === DIALOGS).map(([f]) => f).sort());
  });
  it.each(owned)("%s: %s's file shows exactly one dialog (%s), key %s; the other files show none", (file, dir, owner, dialog, key) => {
    const pane = readFileSync(join(dir, file), "utf8");
    const files = builtins();
    const seen = shown(pane, files[owner]);
    expect(seen?.map((d: any) => d.name)).toEqual([dialog]);
    expect(ts.dialogKey(pane, seen[0])).toBe(key);
    for (const other of Object.keys(files).filter((n) => n !== owner)) expect(shown(pane, files[other])).toEqual([]);
  });
  const others = readdirSync(SCREENS).filter((f) => f.endsWith(".txt") && f !== "codex-unknown-update.txt");
  it.each(others)("%s: no built-in file shows a dialog", (file) => {
    const pane = readFileSync(join(SCREENS, file), "utf8");
    for (const h of Object.values(builtins())) expect(shown(pane, h)).toEqual([]);
  });
});

describe("(c) warmup through HarnessSession.spawn and a real tmux pane", () => {
  it("trust, 'No, exit' highlighted first: Down then Enter, then ready", async () => {
    const h = harness("r1a18b-trust", TRUST, 0, [TRUST_ROW]);
    const s = await spawn(h, "safe");
    try {
      expect(s.ready).toBe(true);
      expect(keys(logOf(h.name))).toEqual(["Down", "Enter"]);
    } finally {
      await s.close();
    }
  }, 40_000);

  it("dialogAnswers absent ('none'): needs owner, no key, no session left", async () => {
    const h = harness("r1a18b-none", TRUST, 1, [TRUST_ROW]);
    expect((await needsOwner(h)).message).toContain('trust dialog "folder-trust"');
    expect(keys(logOf(h.name))).toEqual([]);
  }, 40_000);

  it("a bypass dialog with 'safe': needs owner, no key", async () => {
    const h = harness("r1a18b-bysafe", BYPASS, 0, [BYPASS_ROW]);
    expect((await needsOwner(h, "safe")).message).toContain('bypass dialog "bypass-accept"');
    expect(keys(logOf(h.name))).toEqual([]);
  }, 40_000);

  it("a bypass dialog with 'safe-and-bypass': answered (Down, Enter), ready", async () => {
    const h = harness("r1a18b-byok", BYPASS, 0, [BYPASS_ROW]);
    const s = await spawn(h, "safe-and-bypass");
    try {
      expect(s.ready).toBe(true);
      expect(keys(logOf(h.name))).toEqual(["Down", "Enter"]);
    } finally {
      await s.close();
    }
  }, 40_000);

  it("sign-in text on the dialog's screen: needs owner, no key", async () => {
    const h = harness("r1a18b-never", SIGNIN, 1, [TRUST_ROW]);
    await needsOwner(h, "safe-and-bypass");
    expect(keys(logOf(h.name))).toEqual([]);
  }, 40_000);

  it("key mode: exactly 'y', then ready", async () => {
    const h = harness("r1a18b-key", KEYED, -1, [KEY_ROW]);
    const s = await spawn(h, "safe");
    try {
      expect(s.ready).toBe(true);
      expect(keys(logOf(h.name))).toEqual(["y"]);
    } finally {
      await s.close();
    }
  }, 40_000);

  it("no highlight drawn: needs owner at the warmup deadline, no Enter", async () => {
    const h = harness("r1a18b-nohl", TRUST, -1, [TRUST_ROW]);
    await needsOwner(h, "safe");
    expect(keys(logOf(h.name))).toEqual([]);
  }, 40_000);

  it("a dialog drawn again after its Enter: one Enter only, needs owner", async () => {
    const h = harness("r1a18b-again", TRUST_AGAIN, 1, [TRUST_ROW]);
    await needsOwner(h, "safe");
    expect(keys(logOf(h.name))).toEqual(["Enter"]);
  }, 40_000);

  it("a markerless file (no idle rule): answered, then ready once the screen holds still", async () => {
    const h = harness("r1a18b-quiet", TRUST, 0, [TRUST_ROW], { debounce_ms: 300, precedence: ["waiting_for_approval", "working", "idle"] });
    const s = await spawn(h, "safe");
    try {
      expect(s.ready).toBe(true);
      expect(keys(logOf(h.name))).toEqual(["Down", "Enter"]);
    } finally {
      await s.close();
    }
  }, 40_000);

  it("a dialog that its file's states also read as waiting_for_approval: answered first", async () => {
    const h = harness("r1a18b-wfa", TRUST, 0, [TRUST_ROW], { ...STATES, waiting_for_approval: ["(?i)do you trust this folder\\?"] });
    const { readScreen } = await import("../bridge/harness-detect.ts");
    expect(readScreen(h, " Do you trust this folder?\n\n ❯ No, exit\n   Yes, I trust this folder\n")).toBe("waiting_for_approval");
    const s = await spawn(h, "safe");
    try {
      expect(s.ready).toBe(true);
      expect(keys(logOf(h.name))).toEqual(["Down", "Enter"]);
    } finally {
      await s.close();
    }
  }, 40_000);
});

describe("(d) through route() with a limits file", () => {
  beforeAll(() => {
    resetHarnessCache();
    const loaded = loadedHarnesses();
    const agents = Object.fromEntries(["r1a18b-rtrust", "r1a18b-rbypass", "r1a18b-radopt"].map((n) => [n, agentEntry(loaded.get(n)!)]));
    writeLimits(TANDEM_HOME, { folders: [WORK], agents });
    applyLimits();
  });

  it("a folder in the limits file's folders: the trust dialog is answered, 200 ready", async () => {
    const name = "r1a18b-rtrust";
    const res = await rq("POST", "/sessions/open", { engine: name, name, cwd: WORK });
    try {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name, ready: true });
      expect(keys(logOf("rtrust"))).toEqual(["Down", "Enter"]);
    } finally {
      await rq("POST", `/sessions/${name}/close`);
    }
  }, 40_000);

  it("a bypass dialog outside permission_skip: 409 needs owner, nothing typed, no session, audit denied 'dialog'", async () => {
    const name = "r1a18b-rbypass";
    const before = auditLines().length;
    const res = await rq("POST", "/sessions/open", { engine: name, name, cwd: WORK });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toMatch(/^needs owner: /);
    expect(keys(logOf("rbypass"))).toEqual([]);
    expect(tmuxHas(name)).toBe(false);
    expect(auditLines().slice(before)).toContainEqual(expect.objectContaining({ route: "POST /sessions/open", name, denied: "dialog" }));
  }, 40_000);

  it("a pre-made tagged session showing a dialog is adopted: reused, no key", async () => {
    const name = "r1a18b-radopt";
    tmux("new-session", "-d", "-s", `ccm-${name}`, "-x", "200", "-y", "50", "-c", WORK, "/usr/bin/env", "--", FAKE, TRUST, "0", logOf("radopt"));
    tmux("set-option", "-t", `=ccm-${name}:`, "@tandem_engine", name);
    tmux("set-option", "-t", `=ccm-${name}:`, "@tandem_owner", await makeOwnerIdProvider()());
    await sleep(1500);
    const res = await rq("POST", "/sessions/open", { engine: name, name, cwd: WORK });
    try {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name, reused: true });
      await sleep(2000);
      expect(keys(logOf("radopt"))).toEqual([]);
    } finally {
      await rq("POST", `/sessions/${name}/close`);
    }
  }, 40_000);
});

describe("review-fix U-R1A-18B-R1: the audit table", () => {
  const YES = { name: "any", kind: "trust", match: [".*"], answer: "Yes", highlight: "❯" };
  const far = Array.from({ length: 12 }, (_, i) => (i === 10 ? "@ Yes, I trust this folder" : `@ Option ${i}`)).join("\n");
  // label, screen, start highlight, rows, dialogAnswers, the keys typed, how the start ends
  const starts: [string, string, number, Record<string, unknown>[], string, string[], "owner" | "ready"][] = [
    ["two dialogs at once: no key, needs owner at the deadline", " Do you trust this folder?\n WARNING: Bypass Permissions mode\n\n@ No, exit\n@ Yes, I trust this folder\n@ Yes, I accept\n", 1, [TRUST_ROW, BYPASS_ROW], "safe-and-bypass", [], "owner"],
    ["NEVER text far from the dialog (a footer)", " Do you trust this folder?\n\n@ No, exit\n@ Yes, I trust this folder\n\n\n\n\n Not signed in · /login\n", 1, [TRUST_ROW], "safe-and-bypass", [], "owner"],
    ["answer 'Yes', match '.*', a sign-in dialog", " Sign in with your account?\n\n@ Yes\n@ No\n", 0, [YES], "safe-and-bypass", [], "owner"],
    ["answer 'Yes', match '.*', a purchase dialog", " Buy 500 more credits?\n\n@ Yes\n@ No\n", 0, [YES], "safe-and-bypass", [], "owner"],
    ["answer 'Yes', match '.*', kind trust, an install dialog", " A new version is ready. Install it now?\n\n@ Yes\n@ No\n", 0, [YES], "safe-and-bypass", [], "owner"],
    ["answer 'Yes', kind update (a row the loader refuses), an update dialog", " Update available\n\n@ Yes\n@ No\n", 0, [{ ...YES, kind: "update" }], "safe-and-bypass", [], "owner"],
    ["answer 'Install update' (a row the loader refuses)", " A new version is ready\n\n@ Install update\n@ Later\n", 0, [{ ...YES, answer: "Install update" }], "safe-and-bypass", [], "owner"],
    ["an update dialog is skipped: Down, Enter", " Update available\n\n@ Update now\n@ Skip\n", 0, [{ ...YES, kind: "update", answer: "Skip" }], "safe", ["Down", "Enter"], "ready"],
    ["the answer 10 options below: 8 arrows, no Enter", ` Do you trust this folder?\n\n${far}\n`, 0, [TRUST_ROW], "safe", Array(8).fill("Down"), "owner"],
    ["a screen that never changes: one arrow, no Enter", " Do you trust this folder?\n\n ❯ No, exit\n   Yes, I trust this folder\n", 0, [TRUST_ROW], "safe", ["Down"], "owner"],
  ];
  it("warmup, every row at once: the keys typed and how the start ends", async () => {
    const got = await Promise.all(
      starts.map(async ([label, text, start, rows, answers], i) => {
        const h = harness(`r1a18b-t${i}`, screen(`t${i}.txt`, text), start, rows);
        let end: string;
        try {
          const s = await spawn(h, answers);
          end = s.ready ? "ready" : "not ready";
          await s.close();
        } catch (e) {
          end = e instanceof ts.NeedsOwnerError ? "owner" : String(e);
        }
        return [label, keys(logOf(h.name)), end, tmuxHas(h.name)];
      }),
    );
    expect(got).toEqual(starts.map(([label, , , , , typed, end]) => [label, typed, end, false]));
  }, 60_000);

  const dir = join(BOX, "loader-audit");
  const row = (o: Record<string, unknown>) => rowToml({ name: "t", kind: "trust", match: [".*"], answer: "Yes", highlight: "❯", ...o });
  const files: [string, string, boolean][] = [
    ["answer 'Yes', match '.*'", row({}), true],
    ["answer 'Sign in'", row({ answer: "Sign in" }), false],
    ["answer 'Buy'", row({ answer: "Buy" }), false],
    ["answer 'Install update', kind trust", row({ answer: "Install update" }), false],
    ["answer 'Upgrade now', kind bypass", row({ kind: "bypass", answer: "Upgrade now" }), false],
    ["answer 'Yes', kind update", row({ kind: "update" }), false],
    ["answer 'Skip until next version', kind update", row({ kind: "update", answer: "Skip until next version" }), true],
    ["answer 'Not now', kind update", row({ kind: "update", answer: "Not now" }), true],
    ["a pattern that backtracks elsewhere", row({ match: ["(a+)+$"] }), true],
    ["9 dialogs", Array.from({ length: 9 }, (_, i) => row({ name: `t${i}` })).join(""), false],
    ["kind 'login'", row({ kind: "login" }), false],
    ["kind 'install'", row({ kind: "install" }), false],
  ];
  it("the loader, every malicious row: loads or is refused", () => {
    const got = files.map(([label, rows], i) => {
      const own = join(dir, `m${i}`);
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, `m${i}.toml`), `name = "m${i}"\nprogram = "/bin/echo"\nhas_prompts = true\n${rows}`);
      return [label, loadHarnesses({ installDir: own, ownerDir: "/nonexistent-r1a18b", path: "/usr/bin" }).harnesses.has(`m${i}`)];
    });
    expect(got).toEqual(files.map(([label, , loads]) => [label, loads]));
  });

  it("a pattern that backtracks in other engines reads a long screen in linear time", () => {
    const d = { name: "t", kind: "trust", match: ["(a+)+$", "(.*)*x\\z"], answer: "Yes", highlight: "❯" };
    const t0 = Date.now();
    expect(ts.shownDialogs(`${"a".repeat(50_000)}!\n ❯ Yes\n`, [d])).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("past warmup, a trust dialog the agent prints itself gets no key", async () => {
    const h = harness("r1a18b-mimic", TRUST, 0, [TRUST_ROW]);
    const later = join(FIXED, "mimic.txt");
    h.args.push(later);
    const s = await spawn(h, "safe-and-bypass");
    try {
      expect(s.ready).toBe(true);
      writeFileSync(later, " Do you trust this folder?\n\n ❯ Yes, I trust this folder\n   No, exit\n");
      await sleep(1500);
      const pane = tmux("capture-pane", "-p", "-t", `=ccm-${h.name}:`);
      expect(ts.shownDialogs(pane, [TRUST_ROW]).map((d: any) => d.name)).toEqual(["folder-trust"]);
      expect(ts.dialogKey(pane, TRUST_ROW)).toBe("Enter");
      await s.read();
      await sleep(2500);
      await s.read();
      expect(keys(logOf(h.name))).toEqual(["Down", "Enter"]);
    } finally {
      await s.close();
    }
  }, 40_000);

  describe("through route()", () => {
    const limits = (fields: Record<string, unknown>) => {
      const loaded = loadedHarnesses();
      const agents = Object.fromEntries(["r1a18b-rskip", "r1a18b-rdeny", "claude"].map((n) => [n, agentEntry(loaded.get(n)!)]));
      writeLimits(TANDEM_HOME, { agents, ...fields });
      applyLimits();
    };
    /** The relay's sessions on the private server (none also when no server is left). */
    const relaySessions = () => {
      try {
        return tmux("list-sessions", "-F", "#{session_name}").split("\n").filter((n) => n.startsWith("ccm-relay-"));
      } catch {
        return [];
      }
    };

    it("a bypass dialog in a permission_skip folder: answered, 200 ready", async () => {
      limits({ folders: [WORK], permission_skip: [WORK] });
      const name = "r1a18b-rskip";
      const res = await rq("POST", "/sessions/open", { engine: name, name, cwd: WORK });
      try {
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name, ready: true });
        expect(keys(logOf("rskip"))).toEqual(["Down", "Enter"]);
      } finally {
        await rq("POST", `/sessions/${name}/close`);
      }
    }, 40_000);

    it("a relay whose agent shows a dialog with sign-in text: 409 needs owner, nothing typed, no session left", async () => {
      limits({ folders: [WORK], permission_skip: [WORK] });
      expect(loadedHarnesses().get("claude")?.programPath).toBe(join(BIN, "claude"));
      process.env.TANDEM_ALLOW_BYPASS = "1";
      const before = auditLines().length;
      try {
        const res = await rq("POST", "/relay/start", { goal: "r1a18b audit", cwd: WORK });
        expect((res.body as any).error).toMatch(/^needs owner: claude shows its first-run trust dialog "folder-trust" /);
        expect(res.status).toBe(409);
        expect(keys(logOf("claude"))).toEqual([]);
        expect(relaySessions()).toEqual([]);
        expect(auditLines().slice(before)).toContainEqual(expect.objectContaining({ route: "POST /relay/start", denied: "dialog" }));
      } finally {
        delete process.env.TANDEM_ALLOW_BYPASS;
      }
    }, 40_000);

    it("a folder the limits file does not list: 403, nothing typed, no session", async () => {
      const other = join(BOX, "other");
      mkdirSync(other);
      limits({ folders: [other] });
      const name = "r1a18b-rdeny";
      const res = await rq("POST", "/sessions/open", { engine: name, name, cwd: WORK });
      expect(res.status).toBe(403);
      expect((res.body as any).error).toMatch(/^limits: /);
      expect(keys(logOf("rdeny"))).toEqual([]);
      expect(tmuxHas(name)).toBe(false);
    }, 40_000);
  });
});
