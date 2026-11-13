/**
 * U-R1B-GEMINI: Gemini CLI runs from its built-in harness file (harnesses/gemini.toml) through the
 * one harness engine, with no code change. The `gemini` on PATH here is always a fake script; one
 * case runs it in tmux, never the real gemini.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bgem- folder and TMUX is unset, so nothing here reaches the default
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

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bgem-"));
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
  console.log(`r1bgem cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bgem-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bgem-")));
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
const GEM_SCREENS = join(FIXTURES, "gemini-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_SRC = join(GEM_SCREENS, "idle-src.txt");
const WORKING_SRC = join(GEM_SCREENS, "working-src.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `gemini`: it prints idle-src; each line it reads clears
 * the screen and shows working-src for about 1 s, then clears again and prints `reply: <line>`
 * and idle-src.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_GEMINI = join(BIN, "gemini");
writeFileSync(
  FAKE_GEMINI,
  `#!/bin/sh\ncat '${IDLE_SRC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_SRC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_SRC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in gemini file as the loader reads it (no owner files, the fake gemini on PATH). */
function builtinGemini(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("gemini");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bgem-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bgem-fake'",
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

describe("gemini: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinGemini();
    expect(h).toMatchObject({
      name: "gemini",
      program: "gemini",
      source: "builtin",
      file: join(BUILTIN, "gemini.toml"),
      kind: "agent",
      programPath: FAKE_GEMINI,
      has_prompts: true,
      resume: ["--resume", "{id}"],
      account_env: "GEMINI_CLI_HOME",
      history: "~/.gemini/tmp",
      delivery: "notice",
    });
    expect(h.args).toEqual([]);
    expect(h.fork).toEqual([]);
    expect(h.skip_prompts_args).toEqual(["--yolo"]);
    expect(h.keys).toEqual({ interrupt: ["Escape"], approve: "Enter", deny: "Escape" });
    expect(h.states?.waiting_for_approval).toEqual([
      "(?i)waiting for user confirmation[^\\n]*(?:(?:\\n[ \\t]*)*\\n[ \\t]*(?:[^ \\t│>*\\n][^\\n]*|│[ \\t]*(?:[^ \\t>*\\n][^\\n]*)?|(?:│[ \\t]*)?[>*][ \\t]*)){0,2}(?:\\n[ \\t]*)*\\z",
      "│ (?:Apply this change|Allow execution|Do you want to proceed)[^\\n]*(?:\\n[ \\t]*(?:│[ \\t]*(?:[^ \\t>*\\n][^\\n]*|[>*][ \\t]*)?)?)*(?:\\n[ \\t]*╰[^\\n]*)?(?:(?:\\n[ \\t]*)*\\n[ \\t]*[^ \\t│>*\\n][^\\n]*)?(?:\\n[ \\t]*)*\\z",
      "(?i)(?:allow execution|do you want to|apply this change)[^\\n]*(?:\\n[ \\t]*(?:[^ \\t│>*\\n][^\\n]*|│[ \\t]*(?:[^ \\t>*\\n][^\\n]*)?|(?:│[ \\t]*)?[>*][ \\t]*)?)*?\\n[ \\t]*(?:│[ \\t]*)?(?:[^ \\t│>*\\n][^\\n]*)?\\byes\\b[^\\n]*(?:\\n[ \\t]*(?:│[ \\t]*(?:[^ \\t>*\\n][^\\n]*|[>*][ \\t]*)?)?)*(?:\\n[ \\t]*╰[^\\n]*)?(?:(?:\\n[ \\t]*)*\\n[ \\t]*[^ \\t│>*\\n][^\\n]*)?(?:\\n[ \\t]*)*\\z",
      "No, suggest changes \\(esc\\)[^\\n]*(?:\\n[ \\t]*(?:│[ \\t]*(?:[^ \\t>*\\n][^\\n]*|[>*][ \\t]*)?)?)*(?:\\n[ \\t]*╰[^\\n]*)?(?:(?:\\n[ \\t]*)*\\n[ \\t]*[^ \\t│>*\\n][^\\n]*)?(?:\\n[ \\t]*)*\\z",
    ]);
    expect(h.states?.working).toEqual(["(?i)esc to cancel[^\\n]*(?:\\n[ \\t]*(?:[^ \\t│>*\\n][^\\n]*|│[ \\t]*(?:[^ \\t>*\\n][^\\n]*)?|(?:│[ \\t]*)?[>*][ \\t]*)?){0,3}(?:\\n ?(?:│ )?[>*] [^\\n]*)?(?:\\n[ \\t]*(?:[^ \\t│>*\\n][^\\n]*|│[ \\t]*(?:[^ \\t>*\\n][^\\n]*)?|(?:│[ \\t]*)?[>*][ \\t]*)?)*\\z"]);
    expect(h.states?.idle).toEqual(["(?m)^ ?(?:│ )?[>*] +Type your message or @path/to/file[^\\n]*(?:\\n[ \\t]*[▄▀─][^\\n]*)?(?:(?:\\n[ \\t]*)*\\n[ \\t]*[^ \\t│>*\\n][^\\n]*){0,3}(?:\\n[ \\t]*)*\\z"]);
    expect(h.states?.debounce_ms).toBe(1500);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toEqual([{ name: "folder-trust", kind: "trust", match: ["(?i)do you trust the files in this folder\\?"], answer: "Trust folder", highlight: "●" }]);
  });

  it("a gemini that is a symlink to an executable named gemini.js is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const js = join(pkg, "gemini.js");
    writeFileSync(js, "#!/usr/bin/env node\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(js, join(bin, "gemini"));
    const h = builtinGemini(bin);
    expect(h.programPath).toBe(join(bin, "gemini"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-src.txt", "idle"],
    ["working-src.txt", "working"],
    ["waiting_for_approval-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinGemini(), screen(join(GEM_SCREENS, file)))).toBe(state);
  });

  it("every gemini-waiting_for_approval and gemini-working screen in the screens folder reads its state", () => {
    const h = builtinGemini();
    const approval = readdirSync(SCREENS).filter((f) => /^gemini-waiting_for_approval-[^/]*\.txt$/.test(f));
    const working = readdirSync(SCREENS).filter((f) => /^gemini-working-[^/]*\.txt$/.test(f));
    expect(approval.length).toBeGreaterThan(0);
    expect(working.length).toBeGreaterThan(0);
    expect(approval.filter((f) => readScreen(h, screen(join(SCREENS, f))) !== "waiting_for_approval")).toEqual([]);
    expect(working.filter((f) => readScreen(h, screen(join(SCREENS, f))) !== "working")).toEqual([]);
  });

  it("every gemini-unknown screen (the real auth capture included) and unknown-trust-src read neither idle nor working", () => {
    const h = builtinGemini();
    const files = readdirSync(SCREENS)
      .filter((f) => /^gemini-unknown-[^/]*\.txt$/.test(f))
      .map((f) => join(SCREENS, f));
    expect(files).toContain(join(SCREENS, "gemini-unknown-auth.txt"));
    files.push(join(GEM_SCREENS, "unknown-trust-src.txt"));
    const read = files.map((f) => readScreen(h, screen(f)));
    expect(read.filter((s) => s === "idle" || s === "working")).toEqual([]);
  });

  it("idle-src with its prompt line replaced by `│ > hello` is not idle", () => {
    const text = screen(IDLE_SRC);
    const prompt = "│ >   Type your message or @path/to/file";
    expect(text).toContain(prompt);
    expect(readScreen(builtinGemini(), text.replace(prompt, "│ > hello"))).not.toBe("idle");
  });

  // 0.38.2 InputPrompt: a Box with paddingX 1 and borderLeft only when ui.useBackgroundColor is
  // false (its default is true), so the default prompt line starts with a space, not `│`.
  it.each([" >   ", " *   ", "│ *   "])("the prompt line %j then the placeholder reads idle (default ui.useBackgroundColor, yolo)", (prefix) => {
    const text = screen(IDLE_SRC);
    const prompt = "│ >   Type your message or @path/to/file";
    expect(text).toContain(prompt);
    expect(readScreen(builtinGemini(), text.replace(prompt, `${prefix}Type your message or @path/to/file`))).toBe("idle");
    expect(readScreen(builtinGemini(), text.replace(prompt, `${prefix.trimEnd()} hello`))).not.toBe("idle");
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinGemini();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("gemini-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it.each(["dialogs", "agy-screens", "pi-screens"])("never idle: every file in test/fixtures/%s", (folder) => {
    const h = builtinGemini();
    const files = readdirSync(join(FIXTURES, folder));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, screen(join(FIXTURES, folder, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner gemini.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "gemini.toml"), 'name = "gemini"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "gemini.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("gemini")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("gemini");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "gemini.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a gemini on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("gemini")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "gemini");
    resetHarnessCache();
    const r = await resolveEngine("gemini");
    expect(r.id).toBe("gemini");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "gemini.toml"));
    expect(r.harness?.programPath).toBe(FAKE_GEMINI);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("gemini")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("gemini")).rejects.toThrow(/"gemini"/);
  });

  it("GET /sessions?engine=gemini is 200 and every row is engine gemini", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=gemini");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "gemini")).toBe(true);
  });
});

describe("gemini: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinGemini(), { name: "r1bgem-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("gemini");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath>, also with TANDEM_ALLOW_BYPASS=1; skipPrompts adds --yolo", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GEMINI]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GEMINI]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_GEMINI, "--yolo"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinGemini(), { name: "r1bgem-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one Escape (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinGemini(), fake);
    expect(session.engine).toBe("gemini");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("gemini: a fake gemini in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bgem-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bgem-gemini-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinGemini(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bgem-owner" }),
    );
    try {
      expect(session.engine).toBe("gemini");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bgem-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bgem-ok");

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
