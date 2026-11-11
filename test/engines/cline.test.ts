/**
 * U-R1B-CLINE: Cline CLI (Cline 3.x, interactive terminal UI) runs from its built-in harness file
 * (harnesses/cline.toml) through the one harness engine, with no code change. The `cline` on PATH
 * here is always a fake script; one case runs it in tmux, never the real Cline CLI.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bcln- folder and TMUX is unset, so nothing here reaches the default
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

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bcln-"));
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
  console.log(`r1bcln cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bcln-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bcln-")));
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
const CLN_SCREENS = join(FIXTURES, "cline-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_CHAT_SRC = join(CLN_SCREENS, "idle-chat-src.txt");
const WORKING_STREAM_SRC = join(CLN_SCREENS, "working-stream-src.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `cline`: it prints idle-chat-src; each line it reads
 * clears the screen and shows working-stream-src for about 1 s, then clears again and prints
 * `reply: <line>` and idle-chat-src.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_CLINE = join(BIN, "cline");
writeFileSync(
  FAKE_CLINE,
  `#!/bin/sh\ncat '${IDLE_CHAT_SRC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_STREAM_SRC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_CHAT_SRC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in cline file as the loader reads it (no owner files, the fake on PATH). */
function builtinCline(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("cline");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bcln-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bcln-fake'",
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

describe("cline: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinCline();
    expect(h).toMatchObject({
      name: "cline",
      program: "cline",
      source: "builtin",
      file: join(BUILTIN, "cline.toml"),
      kind: "agent",
      programPath: FAKE_CLINE,
      has_prompts: true,
      resume: ["--id", "{id}"],
      account_env: "CLINE_DIR",
      history: "~/.cline/data/sessions",
      delivery: "notice",
    });
    expect(h.args).toEqual(["--auto-approve", "false"]);
    expect(h.fork).toEqual([]);
    expect(h.skip_prompts_args).toEqual(["--auto-approve", "true"]);
    expect(h.keys).toEqual({ interrupt: ["Escape"], approve: "y", deny: "n" });
    expect(h.states?.waiting_for_approval).toEqual(["Cline needs permission", "\\[y\\] [Aa]pprove", "Approve tool call\\?"]);
    expect(h.states?.working).toEqual(["Thinking\\.\\.\\. \\(esc to cancel\\)", "(?m)^[ │]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] "]);
    expect(h.states?.idle).toEqual(["❯ +(?:What can I do for you\\?|Ask anything\\.\\.\\.|Plan something\\.\\.\\.)"]);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a cline that is a symlink to an executable named cline is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const real = join(pkg, "cline");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(real, join(bin, "cline"));
    const h = builtinCline(bin);
    expect(h.programPath).toBe(join(bin, "cline"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-home-src.txt", "idle"],
    ["idle-chat-src.txt", "idle"],
    ["idle-plan-src.txt", "idle"],
    ["working-thinking-src.txt", "working"],
    // D5: the thinking line is gone once content streams, and the placeholder still shows.
    ["working-stream-src.txt", "working"],
    ["working-tool-src.txt", "working"],
    ["waiting_for_approval-shell-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-write-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-mode-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinCline(), screen(join(CLN_SCREENS, file)))).toBe(state);
  });

  it("working-stream-src shows the input placeholder too (D5)", () => {
    expect(screen(WORKING_STREAM_SRC)).toContain("❯ Ask anything...");
    expect(screen(WORKING_STREAM_SRC)).not.toContain("Thinking...");
  });

  it.each(["unknown-onboarding-src.txt", "unknown-question-src.txt", "unknown-hubupdate-src.txt"])(
    "%s is neither idle nor working nor waiting_for_approval",
    (file) => {
      expect(["idle", "working", "waiting_for_approval"]).not.toContain(readScreen(builtinCline(), screen(join(CLN_SCREENS, file))));
    },
  );

  // D1: the idle rule is unanchored and never reads the status bar.
  const BAR = "❯ Ask anything...";
  it.each([
    ["no leading space before ❯", BAR],
    ["1 leading space before ❯", ` ${BAR}`],
    ["3 leading spaces before ❯", `   ${BAR}`],
    ["`│ ` before ❯", `│ ${BAR}`],
  ])("idle-chat-src with %s reads idle", (_label, line) => {
    const text = screen(IDLE_CHAT_SRC);
    expect(text).toContain(`\n${BAR}\n`);
    expect(readScreen(builtinCline(), text.replace(`\n${BAR}\n`, `\n${line}\n`))).toBe("idle");
  });

  it("idle-chat-src with its status line removed or replaced reads idle", () => {
    const text = screen(IDLE_CHAT_SRC);
    const status = text.trimEnd().split("\n").pop()!;
    expect(status).toContain("Act (Tab)");
    expect(readScreen(builtinCline(), text.replace(status, ""))).toBe("idle");
    expect(readScreen(builtinCline(), text.replace(status, " █████████ (180,224) $4.87   ● Plan ○ Act (Tab)  ~/work main +3 -1"))).toBe("idle");
  });

  it("`❯ hello` alone is not idle, nor the input bar with typed text", () => {
    expect(readScreen(builtinCline(), "❯ hello\n")).not.toBe("idle");
    expect(readScreen(builtinCline(), screen(IDLE_CHAT_SRC).replace(BAR, "❯ hello"))).not.toBe("idle");
  });

  it("idle-chat-src plus a settled reply line `* done` is still idle (a `*` gutter is not a spinner)", () => {
    const text = screen(IDLE_CHAT_SRC).replace("* Hello! How can I help?", "* Hello! How can I help?\n\n* done");
    expect(text).toContain("* done");
    expect(readScreen(builtinCline(), text)).toBe("idle");
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinCline();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("cline-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("never idle: every file in test/fixtures/dialogs and in each other *-screens folder (listed at run time)", () => {
    const h = builtinCline();
    const folders = ["dialogs", ...readdirSync(FIXTURES).filter((f) => f.endsWith("-screens") && f !== "cline-screens")];
    expect(folders.length).toBeGreaterThanOrEqual(5);
    const idle: string[] = [];
    for (const folder of folders) {
      const files = readdirSync(join(FIXTURES, folder));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) if (readScreen(h, screen(join(FIXTURES, folder, f))) === "idle") idle.push(`${folder}/${f}`);
    }
    expect(idle).toEqual([]);
  });

  it("an owner cline.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "cline.toml"), 'name = "cline"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "cline.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("cline")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("cline");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "cline.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a cline on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("cline")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "cline");
    resetHarnessCache();
    const r = await resolveEngine("cline");
    expect(r.id).toBe("cline");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "cline.toml"));
    expect(r.harness?.programPath).toBe(FAKE_CLINE);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("cline")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("cline")).rejects.toThrow(/"cline"/);
  });

  it("GET /sessions?engine=cline is 200 and every row is engine cline", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=cline");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "cline")).toBe(true);
  });
});

describe("cline: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinCline(), { name: "r1bcln-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("cline");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath> --auto-approve false, also with TANDEM_ALLOW_BYPASS=1; --auto-approve true appended with skipPrompts", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CLINE, "--auto-approve", "false"]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CLINE, "--auto-approve", "false"]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_CLINE, "--auto-approve", "false", "--auto-approve", "true"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinCline(), { name: "r1bcln-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one Escape (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinCline(), fake);
    expect(session.engine).toBe("cline");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("cline: a fake cline in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bcln-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bcln-cline-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinCline(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bcln-owner" }),
    );
    try {
      expect(session.engine).toBe("cline");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bcln-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bcln-ok");

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
