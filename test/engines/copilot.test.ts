/**
 * U-R1B-COPILOT: GitHub Copilot CLI runs from its built-in harness file (harnesses/copilot.toml)
 * through the one harness engine, with no code change. The `copilot` on PATH here is always a fake
 * script; one case runs it in tmux, never the real Copilot CLI.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bcop- folder and TMUX is unset, so nothing here reaches the default
 * server where the live agents run. Its afterAll kills that server through its own -S socket,
 * then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../../bridge/harness-registry.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bcop-"));
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
  console.log(`r1bcop cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bcop-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bcop-")));
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
const COP_SCREENS = join(FIXTURES, "copilot-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_SRC = join(COP_SCREENS, "idle-src.txt");
const WORKING_SRC = join(COP_SCREENS, "working-src.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `copilot`: it prints idle-src; each line it reads
 * clears the screen and shows working-src for about 1 s, then clears again and prints
 * `reply: <line>` and idle-src.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_COPILOT = join(BIN, "copilot");
writeFileSync(
  FAKE_COPILOT,
  `#!/bin/sh\ncat '${IDLE_SRC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_SRC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_SRC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in copilot file as the loader reads it (no owner files, the fake on PATH). */
function builtinCopilot(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("copilot");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");
const isFile = (file: string) => statSync(file).isFile();

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bcop-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bcop-fake'",
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

describe("copilot: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinCopilot();
    expect(h).toMatchObject({
      name: "copilot",
      program: "copilot",
      source: "builtin",
      file: join(BUILTIN, "copilot.toml"),
      kind: "agent",
      programPath: FAKE_COPILOT,
      has_prompts: true,
      account_env: "COPILOT_HOME",
      history: "~/.copilot/session-state",
      delivery: "notice",
    });
    expect(h.args).toEqual([]);
    expect(h.fork).toEqual([]);
    expect(h.skip_prompts_args).toEqual(["--allow-all"]);
    expect(h.resume).toEqual(["--resume={id}"]);
    expect(h.keys).toEqual({ interrupt: ["C-c"], approve: "Enter", deny: "Escape" });
    expect(h.states?.waiting_for_approval).toEqual([
      ", and tell Copilot (?:what to do differently|why)[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z",
      "Do you want to (?:(?:re-)?run|use|allow|approve|modify|read|list|create|delete|edit|write|update|move|perform|ignore)\\b(?:[^\\n]*\\n){0,20}?[^\\n]*\\(Esc[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z",
      "ctrl\\+e explain[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z",
      'Extension "[^"\\n]*" wants (?:elevated permissions|to read \\d+ sensitive environment variables?)[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z',
      "Accept plan and continue in (?:Autopilot|Interactive) execution mode[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z",
      "Exit to Interactive execution mode without running the plan[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)*\\z",
    ]);
    expect(h.states?.working).toEqual(["ctrl\\+c (?:interrupt|stop agents|clear input|exit shell mode)[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)?(?:\\n[ \\t]*┃[^\\n]*)?(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?){0,10}\\z", "esc (?:interrupt|stop agents|edit prompt)[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)?(?:\\n[ \\t]*┃[^\\n]*)?(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?){0,10}\\z", "esc again to [^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?)?(?:\\n[ \\t]*┃[^\\n]*)?(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?){0,10}\\z"]);
    expect(h.states?.idle).toEqual(["/ commands[^\\n]*(?:\\n[ \\t]*(?:[^ \\t┃╻╹─\\n][^\\n]*)?){0,3}(?:\\n[ \\t]*)*\\z"]);
    expect(h.states?.debounce_ms).toBe(1500);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a copilot that is a symlink to an executable named npm-loader.js is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const real = join(pkg, "npm-loader.js");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(real, join(bin, "copilot"));
    const h = builtinCopilot(bin);
    expect(h.programPath).toBe(join(bin, "copilot"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-src.txt", "idle"],
    ["working-src.txt", "working"],
    ["waiting_for_approval-shell-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-edit-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-url-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-plan-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinCopilot(), screen(join(COP_SCREENS, file)))).toBe(state);
  });

  it.each(["idle-typed-src.txt", "unknown-trust-src.txt", "unknown-login-src.txt", "unknown-exitwarn-src.txt"])(
    "%s is neither idle nor working nor waiting_for_approval",
    (file) => {
      expect(["idle", "working", "waiting_for_approval"]).not.toContain(readScreen(builtinCopilot(), screen(join(COP_SCREENS, file))));
    },
  );

  // D1: idle is the literal hint row, never anchored to a column or tied to the status line.
  const HINT = "/ commands · ? help";
  const STATUS = "~/work  main  claude-sonnet-4.5";
  it.each([
    ["0 leading spaces before the hint row", (t: string) => t],
    ["1 leading space before the hint row", (t: string) => t.replace(HINT, ` ${HINT}`)],
    ["3 leading spaces before the hint row", (t: string) => t.replace(HINT, `   ${HINT}`)],
    ["`│ ` before the hint row", (t: string) => t.replace(HINT, `│ ${HINT}`)],
    ["the status line removed", (t: string) => t.replace(`${STATUS}\n`, "")],
    ["the status line replaced by an update notice", (t: string) => t.replace(STATUS, "↓ Update available: 1.0.110")],
  ])("idle-src with %s reads idle", (_label, edit) => {
    const text = screen(IDLE_SRC);
    expect(text).toContain(HINT);
    expect(text).toContain(STATUS);
    const edited = edit(text);
    expect(readScreen(builtinCopilot(), edited)).toBe("idle");
  });

  // D2: every verb of the question-line rule, with a menu row that Esc takes below it (every
  // Copilot dialog that asks `Do you want to ...` draws one: `(Esc)` or `(Esc to stop)`).
  const VERBS = ["run", "re-run", "use", "allow", "approve", "modify", "read", "list", "create", "delete", "edit", "write", "update", "move", "perform", "ignore"];
  it.each(VERBS)("`Do you want to %s x?` above a menu with an Esc row reads waiting_for_approval", (verb) => {
    expect(readScreen(builtinCopilot(), `\nDo you want to ${verb} x?\n\n❯ 1. Yes\n  2. No (Esc)\n`)).toBe("waiting_for_approval");
  });

  // Audit (U-R1B-COPILOT): a reply that asks `Do you want to ...?` is not a dialog. Read as
  // waiting_for_approval it would refuse the owner's answer (input gate) until it scrolled away.
  it.each(VERBS)("a reply line `● Do you want to %s x?` above an empty prompt reads idle", (verb) => {
    const text = `● Do you want to ${verb} the README too?\n\n` + screen(IDLE_SRC);
    expect(readScreen(builtinCopilot(), text)).toBe("idle");
  });

  it.each([
    "Do you want to remember screen reader mode for future sessions?",
    "Do you want to connect in remote or local mode?",
    "Do you want to continue locally?",
  ])("the line `%s` alone is not waiting_for_approval", (line) => {
    expect(readScreen(builtinCopilot(), `\n${line}\n`)).not.toBe("waiting_for_approval");
  });

  // Audit (U-R1B-COPILOT): dialogs with no `, and tell Copilot` row (cli-main.js 1.0.109).
  const BOX = (rows: string[]) => ["╭" + "─".repeat(58) + "╮", ...rows.map((r) => `│ ${r}`.padEnd(59) + "│"), "╰" + "─".repeat(58) + "╯"].join("\n");
  it.each([
    [
      "an Assisted Permissions dialog (reject row `No (Esc)`, question `What would you like to do?`)",
      BOX(["Read files", "What would you like to do?", "", "❯ 1. Yes", "  2. No (Esc)", "", "↑/↓ navigate · ctrl+e explain · enter select · esc cancel"]),
    ],
    [
      "the extension elevated-permission dialog",
      BOX(['Extension "acme" wants elevated permissions', "This extension wants to: observe permission requests.", "Denying will prevent this extension from loading.", "", "❯ 1. Yes", "  2. No (Esc)"]),
    ],
    [
      "the extension environment-variable dialog",
      BOX(['Extension "acme" wants to read 2 sensitive environment variables', "API_URL", "", "❯ 1. Yes", "  2. No (Esc)"]),
    ],
    [
      "the plan approval offering only exit_only",
      BOX(["Plan Ready for Review", "", "❯ 1. Exit to Interactive execution mode without running the plan", "  2. Suggest changes"]),
    ],
  ])("%s reads waiting_for_approval", (_label, text) => {
    expect(readScreen(builtinCopilot(), text)).toBe("waiting_for_approval");
  });

  // Audit (U-R1B-COPILOT): the busy hint's Escape forms (activity indicator, cli-main.js 1.0.109).
  it.each(["esc interrupt", "esc stop agents", "esc edit prompt", "esc again to edit prompt", "ctrl+c stop agents"])(
    "working-src with the busy hint `%s` reads working",
    (hint) => {
      expect(readScreen(builtinCopilot(), screen(WORKING_SRC).replace("ctrl+c interrupt", hint))).toBe("working");
    },
  );

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinCopilot();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("copilot-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  // The folder list is read at run time, so the screen folders of later agents are swept too.
  const OTHER_FOLDERS = [
    "dialogs",
    ...readdirSync(FIXTURES).filter((f) => f.endsWith("-screens") && f !== "copilot-screens" && statSync(join(FIXTURES, f)).isDirectory()),
  ];
  it("the swept folders include dialogs and every other *-screens folder", () => {
    expect(OTHER_FOLDERS).toContain("dialogs");
    expect(OTHER_FOLDERS).toContain("cursor-screens");
    expect(OTHER_FOLDERS).not.toContain("copilot-screens");
  });
  it.each(OTHER_FOLDERS)("never idle: every file in test/fixtures/%s", (folder) => {
    const h = builtinCopilot();
    const files = readdirSync(join(FIXTURES, folder)).filter((f) => isFile(join(FIXTURES, folder, f)));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, screen(join(FIXTURES, folder, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner copilot.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "copilot.toml"), 'name = "copilot"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "copilot.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("copilot")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("copilot");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "copilot.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a copilot on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("copilot")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "copilot");
    resetHarnessCache();
    const r = await resolveEngine("copilot");
    expect(r.id).toBe("copilot");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "copilot.toml"));
    expect(r.harness?.programPath).toBe(FAKE_COPILOT);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("copilot")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("copilot")).rejects.toThrow(/"copilot"/);
  });

  it("GET /sessions?engine=copilot is 200 and every row is engine copilot", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=copilot");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "copilot")).toBe(true);
  });
});

describe("copilot: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinCopilot(), { name: "r1bcop-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("copilot");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath>, also with TANDEM_ALLOW_BYPASS=1; --allow-all with skipPrompts", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_COPILOT]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_COPILOT]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_COPILOT, "--allow-all"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinCopilot(), { name: "r1bcop-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one C-c (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinCopilot(), fake);
    expect(session.engine).toBe("copilot");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["C-c"]] }]);
  });
});

describe("copilot: a fake copilot in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bcop-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bcop-copilot-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinCopilot(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bcop-owner" }),
    );
    try {
      expect(session.engine).toBe("copilot");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bcop-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bcop-ok");

      // idle is debounced, so it can take a few reads.
      const deadline = Date.now() + 10_000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        state = (await session.read({ cursor: sent.cursor })).agentState;
        if (state === "idle") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(state).toBe("idle");
    } finally {
      await session.close();
    }
    expect(await session.isAlive()).toBe(false);
  }, 60_000);
});

// U-R1B-COPILOT-LAYOUT: Copilot 1.0.109 (cli-main.js, read as text, never run) draws its composer in
// one of two forms, with the status row above it and ONE hint row under it: (A) prompt frame on, a
// rail `╻▄…` / `┃ <text>` / `╹▀…` with no `❯` glyph; (B) prompt frame off, a `─` rule / `❯ <text>` /
// a `─` rule. The fixtures are constructed from its strings, not captures. The frame's default could
// not be read from the package, so both forms must read.
const { isPromptEmpty } = await import("../../bridge/harness-detect.ts");
const { decideInput } = await import("../../bridge/input-gate.ts");
describe("copilot: the real composers (U-R1B-COPILOT-LAYOUT)", () => {
  const NEW: [string, string, boolean][] = [
    ["idle-frame-src.txt", "idle", true],
    ["idle-plain-src.txt", "idle", true],
    ["idle-frame-narrow-src.txt", "idle", true],
    ["idle-plain-update-src.txt", "idle", true],
    ["idle-frame-shell-src.txt", "idle", false],
    ["idle-plain-shell-src.txt", "idle", false],
    ["unknown-typed-frame-src.txt", "unknown", false],
    ["unknown-typed-plain-src.txt", "unknown", false],
    ["unknown-multiline-frame-src.txt", "unknown", false],
    ["unknown-multiline-plain-src.txt", "unknown", false],
    ["unknown-exitwarn-frame-src.txt", "unknown", false],
    ["unknown-queue-edit-src.txt", "unknown", false],
    ["working-frame-src.txt", "working", false],
    ["working-plain-typed-src.txt", "working", false],
    ["waiting_for_approval-shell-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-feedback-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-path-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-url-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-extension-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-assisted-box-src.txt", "waiting_for_approval", false],
    ["waiting_for_approval-plan-box-src.txt", "waiting_for_approval", false],
    ["unknown-trust-box-src.txt", "unknown", false],
  ];
  it("(r1) the table names 22 files, each in the folder", () => {
    expect(NEW).toHaveLength(22);
    for (const [file] of NEW) expect(isFile(join(COP_SCREENS, file)), file).toBe(true);
  });
  it.each(NEW)("(r1) %s reads %s; empty prompt %s", (file, state, empty) => {
    const s = screen(join(COP_SCREENS, file));
    const h = builtinCopilot();
    expect(readScreen(h, s)).toBe(state);
    expect(isPromptEmpty(h, s)).toBe(empty);
  });

  const HINT = " / commands · ? help";
  const ST = " ~/work [⎇ main]".padEnd(62) + "claude-sonnet-4.5";
  const RA = (rows: string[], w = 80) => ["╻" + "▄".repeat(w - 1), ...rows.map((t) => (t ? "┃ " + t : "┃" + " ".repeat(w - 1))), "╹" + "▀".repeat(w - 1)];
  const RB = (rows: string[], w = 80) => ["─".repeat(w), "❯ " + rows[0], ...rows.slice(1).map((t) => "  " + t), "─".repeat(w)];
  const A = screen(join(COP_SCREENS, "idle-frame-src.txt"));
  const B = screen(join(COP_SCREENS, "idle-plain-src.txt"));
  /** Each edit must change the screen it is given. */
  const derive = (s: string, edit: (t: string) => string) => {
    const out = edit(s);
    expect(out).not.toBe(s);
    return out;
  };
  type Edit = [string, string, (t: string) => string];
  const both = (label: string, edit: (t: string) => string): Edit[] => [[`A: ${label}`, A, edit], [`B: ${label}`, B, edit]];
  const R2: Edit[] = [
    ...both("the hint row ` / commands` only", (t) => t.replace(HINT, " / commands")),
    ...both("the update notice in front of the hints", (t) => t.replace(HINT, " Update: 1.0.110 · next launch or /restart · / commands · ? help")),
    ...both("a vim-mode label in front of the hints", (t) => t.replace(HINT, " -- INSERT -- · / commands · ? help")),
    ...both("the `plan` mode label in front of the hints", (t) => t.replace(HINT, " plan · / commands · ? help")),
    ...both("2 status rows above the composer", (t) => t.replace(ST, `${ST}\n  +3 -1 · sandbox`)),
    ...both("3 status rows above the composer", (t) => t.replace(ST, ` ~/work\n ⎇ main  +3 -1\n claude-sonnet-4.5 · sandbox`)),
    ...both("the footer line ` main ✓` under the hint row", (t) => t.replace(HINT, `${HINT}\n main ✓`)),
    ["A: the composer at 40 columns", A, (t: string) => t.replace(RA([""]).join("\n"), RA([""], 40).join("\n"))],
    ["A: the composer at 200 columns", A, (t: string) => t.replace(RA([""]).join("\n"), RA([""], 200).join("\n"))],
    ["B: the composer at 40 columns", B, (t: string) => t.replace(RB([""]).join("\n"), RB([""], 40).join("\n"))],
    ["B: the composer at 200 columns", B, (t: string) => t.replace(RB([""]).join("\n"), RB([""], 200).join("\n"))],
    ["A: the `┃` row with its trailing spaces removed", A, (t: string) => t.replace(/^┃ +$/m, "┃")],
    ["B: the `❯` row with its trailing space removed", B, (t: string) => t.replace(/^❯ $/m, "❯")],
  ];
  it.each(R2)("(r2) %s: idle and empty", (_label, s, edit) => {
    const h = builtinCopilot();
    const t = derive(s, edit);
    expect(readScreen(h, t)).toBe("idle");
    expect(isPromptEmpty(h, t)).toBe(true);
  });

  it.each([
    ["A", A, (t: string) => t.replace(/^┃ +$/m, "┃ Refining your prompt…")],
    ["B", B, (t: string) => t.replace(/^❯ $/m, "❯ Refining your prompt…")],
  ])("(r3) %s: the `Refining your prompt…` placeholder is not an empty prompt", (_label, s, edit) => {
    const h = builtinCopilot();
    const t = derive(s, edit);
    expect(readScreen(h, t)).toBe("idle");
    expect(isPromptEmpty(h, t)).toBe(false);
  });

  const WA = screen(join(COP_SCREENS, "working-frame-src.txt"));
  const WB = derive(B, (t) => t.replace(HINT, " ◐ Thinking  ctrl+c interrupt"));
  it.each(
    ["ctrl+c interrupt", "ctrl+c clear input", "ctrl+c stop agents", "ctrl+c exit shell mode", "esc again to edit prompt"].flatMap((hint) => [
      ["A", hint, WA] as const,
      ["B", hint, WB] as const,
    ]),
  )("(r4) %s: the busy row `%s` under the composer reads working", (_form, hint, s) => {
    const h = builtinCopilot();
    const t = hint === "ctrl+c interrupt" ? s : derive(s, (x) => x.replace("ctrl+c interrupt", hint));
    expect(readScreen(h, t)).toBe("working");
    expect(isPromptEmpty(h, t)).toBe(false);
  });

  const shellBox = screen(join(COP_SCREENS, "waiting_for_approval-shell-box-src.txt")).trimEnd().split("\n");
  it.each([
    ["A, a reply asking `Do you want to run`", A, ["● Do you want to run the README too?", ""]],
    ["B, a reply asking `Do you want to run`", B, ["● Do you want to run the README too?", ""]],
    ["A, a reply quoting an approval box (no column-0 row)", A, ["● This is the box I saw:", "", ...shellBox.map((l) => "  " + l), "", "  That is the screen I saw.", ""]],
    ["B, a reply quoting an approval box (no column-0 row)", B, ["● This is the box I saw:", "", ...shellBox.map((l) => "  " + l), "", "  That is the screen I saw.", ""]],
  ])("(r5) %s: reads as the prompt alone (idle and empty)", (_label, s, above) => {
    const h = builtinCopilot();
    const t = [...above, s].join("\n");
    expect(readScreen(h, t)).toBe("idle");
    expect(isPromptEmpty(h, t)).toBe(true);
    expect(decideInput("owner", "type", readScreen(h, t))).toBe("enter");
    expect(decideInput("agent", "type", readScreen(h, t))).toBe("enter");
  });

  // G3: the bottom-area function returns the permission dialog before the queue manager, but the
  // root draws the queue manager's edit composer as a pinned footer UNDER whatever that function
  // returned, so a permission dialog and a pinned queue-edit composer can be on screen together.
  const dialog = shellBox.slice(0, -1);
  it.each([
    ["A", [...dialog, ...RA(["also fix lint"]), "editing queued item — enter save · esc cancel", " main ✓"]],
    ["B", [...dialog, ...RB(["also fix lint"]), "editing queued item — enter save · esc cancel", " main ✓"]],
  ])("(r6) %s: a permission dialog with the pinned queue-edit composer under it is neither idle nor empty", (_form, lines) => {
    const h = builtinCopilot();
    const t = lines.join("\n");
    expect(readScreen(h, t)).not.toBe("idle");
    expect(isPromptEmpty(h, t)).toBe(false);
    expect(decideInput("agent", "type", readScreen(h, t))).toBe("held");
  });
  // Builder addition: an empty composer and its hint row quoted at column 0 in a reply, right above a
  // real dialog that is not an approval (the ask-user `Question` box, the folder-trust box; each a
  // Po box drawn instead of the composer, cli-main.js 1.0.109). Nothing composer-like follows the
  // quote, so only the line count after the hint row tells it from the real prompt: 1.0.109 draws
  // only a status line under the hint row. Read as empty, an agent's text would answer the dialog.
  const ask = ["╭" + "─".repeat(70) + "╮", ...["Question", "─".repeat(68), "Which branch should I use?", "", "❯ 1. main", "  2. dev", "  3. Other (type your answer)", "", "↑/↓ to select · enter to confirm · esc to cancel"].map((r) => "│ " + r.padEnd(68) + " │"), "╰" + "─".repeat(70) + "╯"];
  const trust = screen(join(COP_SCREENS, "unknown-trust-box-src.txt")).trimEnd().split("\n");
  const QUOTES: [string, string[]][] = [
    ["form A", [...RA([""]), HINT]],
    ["form B", [...RB([""]), HINT]],
    ["the old fixture layout", screen(IDLE_SRC).trimEnd().split("\n").slice(-4)],
  ];
  it.each(QUOTES.flatMap(([label, q]) => [[label, "the ask-user box", q, ask] as const, [label, "the folder-trust box", q, trust] as const]))(
    "(r7) an empty composer of %s quoted at column 0 above %s is not an empty prompt",
    (_label, _dialog, q, dialog) => {
      const h = builtinCopilot();
      const t = ["● This is what I saw:", "", ...q, "", ...dialog, " main ✓"].join("\n");
      expect(isPromptEmpty(h, [...q].join("\n"))).toBe(true);
      expect(isPromptEmpty(h, t)).toBe(false);
      expect(readScreen(h, t)).not.toBe("waiting_for_approval");
    },
  );
});
