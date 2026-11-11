/**
 * U-R1B-CURSOR: Cursor's terminal agent (Cursor CLI) runs from its built-in harness file
 * (harnesses/cursor-agent.toml) through the one harness engine, with no code change. The
 * `cursor-agent` on PATH here is always a fake script; one case runs it in tmux, never the real
 * Cursor CLI.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bcur- folder and TMUX is unset, so nothing here reaches the default
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

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bcur-"));
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
  console.log(`r1bcur cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bcur-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bcur-")));
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
const CUR_SCREENS = join(FIXTURES, "cursor-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_SRC = join(CUR_SCREENS, "idle-src.txt");
const IDLE_FOLLOWUP_SRC = join(CUR_SCREENS, "idle-followup-src.txt");
const WORKING_SRC = join(CUR_SCREENS, "working-src.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `cursor-agent`: it prints idle-src; each line it reads
 * clears the screen and shows working-src for about 1 s, then clears again and prints
 * `reply: <line>` and idle-followup-src.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_CURSOR = join(BIN, "cursor-agent");
writeFileSync(
  FAKE_CURSOR,
  `#!/bin/sh\ncat '${IDLE_SRC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_SRC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_FOLLOWUP_SRC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in cursor-agent file as the loader reads it (no owner files, the fake on PATH). */
function builtinCursor(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("cursor-agent");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bcur-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bcur-fake'",
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

describe("cursor-agent: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinCursor();
    expect(h).toMatchObject({
      name: "cursor-agent",
      program: "cursor-agent",
      source: "builtin",
      file: join(BUILTIN, "cursor-agent.toml"),
      kind: "agent",
      programPath: FAKE_CURSOR,
      has_prompts: true,
      resume: ["--resume", "{id}"],
      history: "~/.cursor/chats",
      delivery: "notice",
    });
    expect(h.args).toEqual([]);
    expect(h.fork).toEqual([]);
    expect(h.skip_prompts_args).toEqual(["--force"]);
    expect(h.account_env).toBeUndefined();
    expect(h.keys).toEqual({ interrupt: ["C-c"], approve: "y", deny: "n" });
    expect(h.states?.waiting_for_approval).toEqual(["Run (?:outside sandbox )?\\(once\\)", "\\(esc or n(?: or p)?\\)", "Keep \\(n\\)"]);
    expect(h.states?.working).toEqual(["(?i)ctrl\\+c to stop"]);
    expect(h.states?.idle).toEqual(["→ (?:Plan, search, build anything|Add a follow-up)"]);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a cursor-agent that is a symlink to an executable named cursor-agent is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const real = join(pkg, "cursor-agent");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(real, join(bin, "cursor-agent"));
    const h = builtinCursor(bin);
    expect(h.programPath).toBe(join(bin, "cursor-agent"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-src.txt", "idle"],
    ["idle-followup-src.txt", "idle"],
    ["working-src.txt", "working"],
    ["waiting_for_approval-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinCursor(), screen(join(CUR_SCREENS, file)))).toBe(state);
  });

  it.each(["unknown-trust-src.txt", "unknown-login-src.txt"])("%s is neither idle nor working nor waiting_for_approval", (file) => {
    expect(["idle", "working", "waiting_for_approval"]).not.toContain(readScreen(builtinCursor(), screen(join(CUR_SCREENS, file))));
  });

  it("idle-src with its placeholder replaced by `→ hello` is not idle", () => {
    const text = screen(IDLE_SRC);
    expect(text).toContain("→ Plan, search, build anything");
    expect(readScreen(builtinCursor(), text.replace("→ Plan, search, build anything", "→ hello"))).not.toBe("idle");
  });

  // Audit: the layout Cursor 2026.11.11-043ef28 draws (1734.index.js), not the box of the -src
  // fixtures: the prompt bar has a one-column margin and a one-column padding before `→ `, half-block
  // rows above and below, and a footer whose model and context figure vary; approval rows start with
  // the `→ ` marker; Write and Delete approvals have no `Skip (esc or n)` row.
  const BAR = (c: string) => ` ${c.repeat(118)}`;
  const PAD = (s: string) => s.padEnd(118);
  it.each([
    ["first turn, padded, footer with no figure", "idle", [BAR("▄"), PAD("  → Plan, search, build anything"), BAR("▀"), "  Auto"]],
    ["follow-up, padded, footer with a long model and a figure", "idle", [BAR("▄"), PAD("  → Add a follow-up"), BAR("▀"), "  claude-4.5-sonnet-thinking-extended-context · 37.2%"]],
    ["follow-up with the /plan hint", "idle", [BAR("▄"), PAD("  → Add a follow-up — /plan to review and build"), BAR("▀")]],
    ["running turn, padded", "working", [BAR("▄"), `  → Add a follow-up${" ".repeat(80)}ctrl+c to stop `, BAR("▀")]],
    ["typed but not sent", "unknown", [BAR("▄"), PAD("  → hello"), BAR("▀")]],
    ["shell approval", "waiting_for_approval", [" Run this command?", " $ npm test", " → Run (once) (y)", "   Add Shell(npm) to allowlist? (tab)", "   Skip & tell the agent what to do instead (esc or n)"]],
    ["write approval", "waiting_for_approval", [" Write to this file?", " in /tmp/work/a.txt", " → Proceed (y)", "   Reject & propose changes (esc or n or p)", "   Add Write(a.txt) to allowlist? (tab)"]],
    ["delete approval", "waiting_for_approval", [" Delete this file?", " → Delete (y)", "   Keep (n)"]],
  ])("real layout: %s reads %s", (_label, state, lines) => {
    expect(readScreen(builtinCursor(), ["", ...(lines as string[]), ""].join("\n"))).toBe(state);
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinCursor();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("cursor-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it.each(["dialogs", "agy-screens", "pi-screens", "gemini-screens"])("never idle: every file in test/fixtures/%s", (folder) => {
    const h = builtinCursor();
    const files = readdirSync(join(FIXTURES, folder));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, screen(join(FIXTURES, folder, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner cursor-agent.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "cursor-agent.toml"), 'name = "cursor-agent"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "cursor-agent.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("cursor-agent")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("cursor-agent");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "cursor-agent.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a cursor-agent on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("cursor-agent")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "cursor-agent");
    resetHarnessCache();
    const r = await resolveEngine("cursor-agent");
    expect(r.id).toBe("cursor-agent");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "cursor-agent.toml"));
    expect(r.harness?.programPath).toBe(FAKE_CURSOR);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("cursor-agent")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("cursor-agent")).rejects.toThrow(/"cursor-agent"/);
  });

  it("GET /sessions?engine=cursor-agent is 200 and every row is engine cursor-agent", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=cursor-agent");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "cursor-agent")).toBe(true);
  });
});

describe("cursor-agent: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinCursor(), { name: "r1bcur-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("cursor-agent");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath>, also with TANDEM_ALLOW_BYPASS=1; --force with skipPrompts", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CURSOR]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CURSOR]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_CURSOR, "--force"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinCursor(), { name: "r1bcur-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one C-c (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinCursor(), fake);
    expect(session.engine).toBe("cursor-agent");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["C-c"]] }]);
  });
});

describe("cursor-agent: a fake cursor-agent in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bcur-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bcur-cursor-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinCursor(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bcur-owner" }),
    );
    try {
      expect(session.engine).toBe("cursor-agent");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bcur-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bcur-ok");

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
