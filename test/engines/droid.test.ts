/**
 * U-R1B-DROID: Factory's Droid CLI runs from its built-in harness file (harnesses/droid.toml)
 * through the one harness engine, with no code change. The `droid` on PATH here is always a fake
 * script; one case runs it in tmux, never the real Droid CLI.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bdrd- folder and TMUX is unset, so nothing here reaches the default
 * server where the live agents run. Its afterAll kills that server through its own -S socket,
 * then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../../bridge/harness-registry.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bdrd-"));
process.env.TMUX_TMPDIR = TMUX_BOX;
delete process.env.TMUX;
// Tandem's own socket under TANDEM_HOME (set below to join(tmp, "tandem")), read at cleanup.
const SOCK = () => join(tmp, "tandem", "tmux", "tandem");
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK()],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1bdrd cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bdrd-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bdrd-")));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

// Read when the bridge modules load (transcripts, harness files).
process.env.TANDEM_HOME = join(tmp, "tandem");

const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { readScreen } = await import("../../bridge/harness-detect.ts");
const { HarnessSession } = await import("../../bridge/engines/harness-engine.ts");
const { EngineDisabledError, EngineUnavailableError, loadedHarnesses, resetHarnessCache, resolveEngine } = await import(
  "../../bridge/engine-registry.ts"
);
const { spawnArgv, TerminalSession } = await import("../../bridge/terminal-session.ts");
const { routeForTest } = await import("../../bridge/router.ts");

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const DRD_SCREENS = join(FIXTURES, "droid-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_SRC = join(DRD_SCREENS, "idle-src.txt");
const WORKING_SRC = join(DRD_SCREENS, "working-src.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `droid`: it prints idle-src; each line it reads clears
 * the screen and shows working-src for about 1 s, then clears again and prints `reply: <line>`
 * and idle-src.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_DROID = join(BIN, "droid");
writeFileSync(
  FAKE_DROID,
  `#!/bin/sh\ncat '${IDLE_SRC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_SRC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_SRC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in droid file as the loader reads it (no owner files, the fake on PATH). */
function builtinDroid(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("droid");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");
const state = (text: string) => readScreen(builtinDroid(), text);

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bdrd-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bdrd-fake'",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => ({ report: `report: ${text}`, cursor: 1, status: "done" as const }),
    readSince: async (cursor: number) => ({ text: "", cursor, idle: true }),
    applyControls: async () => [],
    interrupt: async (...args: unknown[]) => {
      calls.push({ method: "interrupt", args });
    },
    close: async () => {},
    screen: async () => "",
  };
  return { fake, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHarnessCache();
});

const PLACEHOLDERS = [
  'Try "How do I handle errors in async functions?"',
  'Try "Write unit tests for this file"',
  'Try "Search the documentation for this library"',
  'Try "Optimize the performance of this component"',
  `Try "Debug why users can't login"`,
  'Try "Implement a REST endpoint for user data"',
  'Try "Add proper error handling to API calls"',
  'Try "Set up GitHub Actions for CI/CD"',
  'Try "Fix all lint warnings"',
  'Try "Create a PR with these changes"',
  'Try "Review the changes in my current branch"',
  'Try "Explain how the codebase is organized"',
  'Type "Review this code for security issues"',
];

describe("droid: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinDroid();
    expect(h).toMatchObject({
      name: "droid",
      program: "droid",
      source: "builtin",
      file: join(BUILTIN, "droid.toml"),
      kind: "agent",
      programPath: FAKE_DROID,
      has_prompts: true,
      history: "~/.factory/sessions",
      delivery: "notice",
    });
    expect(h.args).toEqual([]);
    expect(h.skip_prompts_args).toEqual(["--auto", "high"]);
    expect(h.resume).toEqual(["--resume", "{id}"]);
    expect(h.fork).toEqual(["--fork", "{id}"]);
    expect(h.account_env).toBeUndefined();
    expect(h.keys).toEqual({ interrupt: ["Escape"], approve: "Enter", deny: "Escape" });
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.states?.waiting_for_approval?.length).toBeGreaterThan(0);
    expect(h.states?.working).toEqual(["\\((?:Press ESC to stop|Please wait)\\)[^\\n]*(?:\\n[^\\n╭╮╰╯│]*){0,4}\\n[ \\t]*╭[^\\n]*(?:\\n[ \\t]*│[^\\n]*)+\\n[ \\t]*╰[^\\n]*(?:\\n[ \\t]*(?:│[ \\t]*(?:[^ \\t>\\n][^\\n]*)?|[^ \\t│>\\n][^\\n]*)?)*\\z"]);
    expect(h.states?.idle?.length).toBeGreaterThan(0);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a droid that is a symlink to an executable named droid is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const real = join(pkg, "droid");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(real, join(bin, "droid"));
    const h = builtinDroid(bin);
    expect(h.programPath).toBe(join(bin, "droid"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-src.txt", "idle"],
    ["idle-alt-src.txt", "idle"],
    ["working-src.txt", "working"],
    ["working-wait-src.txt", "working"],
    ["waiting_for_approval-exec-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-edit-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-batch-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-spec-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-shield-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, want) => {
    expect(state(screen(join(DRD_SCREENS, file)))).toBe(want);
  });

  it("every waiting_for_approval-*-src.txt fixture is covered above", () => {
    const files = readdirSync(DRD_SCREENS).filter((f) => f.startsWith("waiting_for_approval-"));
    expect(files.sort()).toEqual([
      "waiting_for_approval-batch-src.txt",
      "waiting_for_approval-edit-src.txt",
      "waiting_for_approval-exec-src.txt",
      "waiting_for_approval-shield-src.txt",
      "waiting_for_approval-spec-src.txt",
    ]);
  });

  it.each(["unknown-trust-src.txt", "unknown-login-src.txt", "unknown-ide-src.txt"])(
    "%s is neither idle nor working nor waiting_for_approval",
    (file) => {
      expect(["idle", "working", "waiting_for_approval"]).not.toContain(state(screen(join(DRD_SCREENS, file))));
    },
  );

  // D1: the idle rule is the input box's placeholder, unanchored, never the footer.
  const BOX_LINE = '│ > Try "Write unit tests for this file"';
  it.each([
    ["left border removed", (t: string) => t.replace(BOX_LINE, '> Try "Write unit tests for this file"')],
    ["left border removed, 1 leading space", (t: string) => t.replace(BOX_LINE, ' > Try "Write unit tests for this file"')],
    ["left border removed, 3 leading spaces", (t: string) => t.replace(BOX_LINE, '   > Try "Write unit tests for this file"')],
    ["footer removed", (t: string) => t.replace(/^Auto \(Off\).*$/m, "")],
    ["footer replaced by an update failure", (t: string) => t.replace(/^Auto \(Off\).*$/m, "⚠ Update failed — network")],
    ["footer replaced by a ready update", (t: string) => t.replace(/^Auto \(Off\).*$/m, "✓ v1.9.0 ready (restart to apply)")],
  ])("D1: idle-src with %s reads idle", (_label, edit) => {
    const text = screen(IDLE_SRC);
    expect(text).toContain(BOX_LINE);
    const changed = edit(text);
    expect(changed).not.toBe(text);
    expect(state(changed)).toBe("idle");
  });

  it.each(PLACEHOLDERS)("D1: `> %s` alone reads idle", (p) => {
    expect(state(`> ${p}\n`)).toBe("idle");
  });

  it("D1: `> Try \"something else\"` alone is not idle", () => {
    expect(state('> Try "something else"\n')).not.toBe("idle");
  });

  // D2: every confirmation family needs its cancel row with Droid's key hint under it.
  it("D2: `No, cancellation` alone is not an approval, nor is it with the key hint under it", () => {
    expect(state("No, cancellation\n")).not.toBe("waiting_for_approval");
    expect(state("│  No, cancellation  │\n╰────╯\n  ↑↓ navigate · Enter select · Esc cancel\n")).not.toBe("waiting_for_approval");
  });

  // Reply text that quotes a confirmation's words is not an approval (owner lockout class).
  const IDLE_BOX = ["╭" + "─".repeat(70) + "╮", "│ > " + " ".repeat(67) + "│", "╰" + "─".repeat(70) + "╯", "Auto (Off)  claude-sonnet-4-6"];
  it.each([
    ["a reply line with `No, cancel` in a sentence", ["Pick No, cancel if you do not want the command to run."]],
    ["a reply that lists the rows", ["Droid shows:", "  Yes, allow", "  No, cancel", "  No, cancel all", "  No, keep iterating on spec"]],
    ["a reply that quotes the shield title", ["Droid-Shield approval required means a secret was found.", "  Proceed anyway", "  Cancel"]],
    ["an answered confirmation's rows left above the input", ["  EXECUTE  npm test", "  Yes, allow", "  No, cancel", "", "⛬ Ran npm test: 3 passed"]],
    // Audit (U-R1B-DROID): quoted lists WITH their key hint, the lockout class; an open list
    // replaces the input box, so a hint with the input box under it is reply text.
    ["a fake tool list with its hint in a code block", ["The prompt looks like this:", "```", "╭" + "─".repeat(40) + "╮", "│  Yes, allow" + " ".repeat(28) + "│", "│  No, cancel" + " ".repeat(28) + "│", "╰" + "─".repeat(40) + "╯", "  ↑↓ navigate · Enter select · Esc cancel", "```"]],
    ["a cancel-all row and its hint", ["  No, cancel all", "  ↑↓ navigate · Enter select · Esc cancel · Alt/Option+E to inspect approval details"]],
    ["the shield list with its hint", ["Droid-Shield approval required", "  Proceed anyway", "  Cancel", "  ↑↓ navigate · Enter select · Esc cancel"]],
    ["the spec exit rows with their hint", ["  3. No, keep iterating on spec", "  4. No and explain why", "  ↑↓ navigate · 1-4 select · Enter select · Esc cancel"]],
    ["the autonomy step with its hint", [" 1. Proceed with Manual Approvals", "  ↑↓ navigate · 1-1 select · Enter select · Tab reasoning · Esc back"]],
    ["the sandbox list with its hint", ["   ✕ No, cancel", "     ↑↓ to select, Enter to confirm, Esc to deny"]],
    ["the mission proposal with its hint", ["  No and explain why", "  ↑/↓ Navigate · Enter Select · 1-3 Quick select · ESC Cancel"]],
  ])("reply text: %s, above the empty input box, reads idle", (_label, lines) => {
    expect(state(["", ...lines, "", ...IDLE_BOX, ""].join("\n"))).toBe("idle");
  });

  // The layouts droid 1.8.0 draws, from its UI code (read as text): the tool confirmation is a
  // round box with no padding whose rows are `  <label>` (the selected row is only bold), with the
  // key hint under it; the sandbox list marks its selected row `> ` (`✕ ` on the cancel row) and
  // has its own hint; the spec-mode exit is a numbered list ending `No and explain why`, and its
  // second step a numbered autonomy list. After the first turn the empty input shows no
  // placeholder; while a turn runs the input shows `Enter to steer · Ctrl+Enter to queue`.
  const B = (w = 76) => ["╭" + "─".repeat(w) + "╮", "╰" + "─".repeat(w) + "╯"];
  const R = (s: string, w = 76) => "│" + s.padEnd(w) + "│";
  const [TOP, BOT] = B();
  const HINT = "  ↑↓ navigate · Enter select · Esc cancel · Alt/Option+E to inspect approval details";
  it.each([
    ["exec, one command", "waiting_for_approval", ["  Command to approve · low risk", "  ↳ npm test", TOP, R("  Yes, allow"), R("  Yes, and always allow Low"), R("  No, cancel"), BOT, HINT]],
    ["exec, the cancel row selected", "waiting_for_approval", ["  Command to approve", "  ↳ rm -rf build", TOP, R("  Yes, allow"), R("  No, cancel"), BOT, "  ↑↓ navigate · Enter select · Esc cancel"]],
    ["batch", "waiting_for_approval", ["  Commands (2): medium risk", TOP, R("  Yes, allow all"), R("  No, cancel all"), BOT, HINT]],
    ["mcp tool", "waiting_for_approval", ["  MCP tool to approve · low impact", "  ↳ github___list_issues", TOP, R("  Yes, allow"), R("  Always allow list_issues"), R('  Always allow all "github" tools'), R("  No, cancel"), BOT, HINT]],
    ["edit with a diff hint", "waiting_for_approval", ["  Edit a.ts", "  - x", "  + y", TOP, R("  Yes, allow"), R("  No, cancel"), BOT, "  ↑↓ navigate · Enter select · Esc cancel · Ctrl+O expand diff"]],
    ["droid-shield", "waiting_for_approval", ["Droid-Shield approval required", "↳ git push origin main", "Possible secret in .env", TOP, R("  Proceed anyway"), R("  Proceed & report false positive"), R("  Cancel"), BOT, HINT]],
    ["sandbox list, cancel row selected", "waiting_for_approval", ["   Sandbox Violation: network access blocked", "     example.com", TOP, R("   Yes, allow"), R(" ✕ No, cancel"), BOT, "     ↑↓ to select, Enter to confirm, Esc to deny"]],
    ["spec exit", "waiting_for_approval", ["    Will save to: ~/work/.factory/docs/spec.md", TOP, R(" 1. Proceed with the proposal"), R(" 2. Proceed with comment"), R(" 3. Manually edit spec (vim via $EDITOR)"), R(" 4. No and explain why"), BOT, "  ↑↓ navigate · 1-4 select · Enter select · Esc cancel"]],
    ["spec exit, autonomy step", "waiting_for_approval", [TOP, R(" 1. Proceed with Manual Approvals"), R(" 2. Proceed with Low autonomy"), R(" 3. Proceed with Medium autonomy"), BOT, "  ↑↓ navigate · 1-3 select · Enter select · Tab reasoning · Esc back"]],
    ["mission proposal", "waiting_for_approval", ["  Mission proposal", "  Build a /health route", TOP, R(" Proceed with the proposal"), R(" Proceed with comment"), R(" No and explain why"), BOT, "  ↑/↓ Navigate · Enter Select · 1-3 Quick select · ESC Cancel"]],
    ["deny-listed command", "waiting_for_approval", ["  Command to approve (deny-listed)", "  ↳ rm -rf build", TOP, R(" Droid would like to run a deny-listed command"), R(""), R("  Yes, allow"), R("  No, cancel"), BOT, HINT]],
    ["spec exit with the Ctrl+C warning and the droids hint under it", "waiting_for_approval", [TOP, R(" 1. Proceed with the proposal"), R(" 2. No and explain why"), BOT, "  ↑↓ navigate · 1-2 select · Enter select · Esc cancel", "  Press Ctrl+C again to exit", "", "Ctrl+D for droids"]],
    ["empty input after the first turn", "idle", ["⛬ Done: 3 tests pass.", "", ...IDLE_BOX]],
    ["empty input, padded", "idle", ["   ╭" + "─".repeat(70) + "╮", "   │ >" + " ".repeat(68) + "│", "   ╰" + "─".repeat(70) + "╯"]],
    ["spec mode first turn", "idle", [TOP, R(" > Droid will research and plan before making changes"), BOT]],
    ["running turn, steer hint in the input", "working", ["⠙ Thinking... (Press ESC to stop)", "", TOP, R(" > Enter to steer · Ctrl+Enter to queue"), BOT]],
    ["typed but not sent", "unknown", [TOP, R(" > hello"), BOT]],
    ["a quoted empty prompt with no box under it", "unknown", ["│ >   │"]],
  ])("real layout: %s reads %s", (_label, want, lines) => {
    expect(state(["", ...(lines as string[]), ""].join("\n"))).toBe(want);
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinDroid();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("droid-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("never idle: every file in test/fixtures/dialogs and in every other agent's *-screens folder", () => {
    const h = builtinDroid();
    const folders = ["dialogs", ...readdirSync(FIXTURES).filter((f) => f.endsWith("-screens") && f !== "droid-screens")];
    expect(folders.length).toBeGreaterThanOrEqual(7);
    const idle: string[] = [];
    for (const folder of folders) {
      const files = readdirSync(join(FIXTURES, folder));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) if (readScreen(h, screen(join(FIXTURES, folder, f))) === "idle") idle.push(`${folder}/${f}`);
    }
    expect(idle).toEqual([]);
  });

  it("an owner droid.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "droid.toml"), 'name = "droid"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "droid.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("droid")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("droid");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "droid.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a droid on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("droid")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "droid");
    resetHarnessCache();
    const r = await resolveEngine("droid");
    expect(r.id).toBe("droid");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "droid.toml"));
    expect(r.harness?.programPath).toBe(FAKE_DROID);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("droid")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("droid")).rejects.toThrow(/"droid"/);
  });

  it("GET /sessions?engine=droid is 200 and every row is engine droid", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=droid");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "droid")).toBe(true);
  });
});

describe("droid: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinDroid(), { name: "r1bdrd-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("droid");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath>, also with TANDEM_ALLOW_BYPASS=1; --auto high with skipPrompts", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_DROID]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_DROID]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_DROID, "--auto", "high"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinDroid(), { name: "r1bdrd-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one Escape (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinDroid(), fake);
    expect(session.engine).toBe("droid");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("droid: a fake droid in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bdrd-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bdrd-droid-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinDroid(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bdrd-owner" }),
    );
    try {
      expect(session.engine).toBe("droid");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bdrd-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bdrd-ok");

      // idle is debounced, so it can take a few reads.
      const deadline = Date.now() + 10_000;
      let got: string | undefined;
      while (Date.now() < deadline) {
        got = (await session.read({ cursor: sent.cursor })).agentState;
        if (got === "idle") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(got).toBe("idle");
    } finally {
      await session.close();
    }
    expect(await session.isAlive()).toBe(false);
  }, 60_000);
});
