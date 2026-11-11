/**
 * U-R1A-11: Claude Code runs from its built-in harness file (harnesses/claude.toml) through the
 * one harness engine. Injected fakes only: no tmux, no real `claude` process.
 *
 * Parity with Synergy's test/engines.test.ts (Claude's engine-table cases) and
 * test/interrupt-keys.test.ts (Escape, then C-c) lands here as harness file cases.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses, type Harness } from "../../bridge/harness-registry.ts";
import { HarnessSession, harnessDescriptor, type HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import {
  EngineDisabledError,
  EngineUnavailableError,
  loadedHarnesses,
  resetHarnessCache,
  resolveEngine,
} from "../../bridge/engine-registry.ts";
import { dialogKey, spawnArgv, type SpawnOptions } from "../../bridge/terminal-session.ts";

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const SCREENS = fileURLToPath(new URL("../fixtures/screens/", import.meta.url));
const screen = (f: string) => readFileSync(join(SCREENS, f), "utf8");

const tmp = mkdtempSync(join(tmpdir(), "r1a11-claude-"));
const NO_OWNER = join(tmp, "no-owner");
/** A PATH folder holding an executable fake `claude` (never run), never the real one. */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

/** The built-in claude file as the loader reads it (no owner files, the fake claude on PATH). */
function builtinClaude(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  return harnesses.get("claude")!;
}

/** An owner folder (mode 0700) holding one claude.toml (mode 0600). */
function ownerWithClaude(): string {
  const home = mkdtempSync(join(tmp, "home-"));
  const dir = join(home, "harnesses");
  mkdirSync(dir);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "claude.toml"), 'name = "claude"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
  return home;
}

interface Call {
  method: string;
  args: unknown[];
}

function fakeTerminal(screenText = "") {
  const calls: Call[] = [];
  const fake: HarnessTerminal = {
    name: "r1a11-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1a11-fake'",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => {
      calls.push({ method: "send", args: [text] });
      return { report: `report: ${text}`, cursor: 1, status: "done" as const };
    },
    readSince: async (cursor: number) => ({ text: "", cursor, idle: true }),
    applyControls: async (controls: { model?: string; effort?: string }) => {
      calls.push({ method: "applyControls", args: [controls] });
      return [];
    },
    interrupt: async (...args: unknown[]) => {
      calls.push({ method: "interrupt", args });
    },
    close: async () => {},
    screen: async () => screenText,
  };
  return { fake, calls };
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarnessCache();
});

describe("claude: the built-in harness file", () => {
  it("loads with no error, kind agent, and its state patterns and precedence equal the fixture file's", () => {
    const h = builtinClaude();
    expect(h).toMatchObject({
      name: "claude",
      program: "claude",
      source: "builtin",
      file: join(BUILTIN, "claude.toml"),
      kind: "agent",
      has_prompts: true,
      skip_prompts_args: ["--dangerously-skip-permissions"],
      resume: ["--resume", "{id}"],
      fork: ["--resume", "{id}", "--fork-session"],
      account_env: "CLAUDE_CONFIG_DIR",
      history: "~/.claude/projects",
      keys: { interrupt: ["Escape", "C-c"], approve: "Enter", deny: "Escape" },
      delivery: "hook",
      hook: "--settings",
    });
    expect(h.logo).toBeUndefined();
    const fixture = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: NO_OWNER }).harnesses.get("claude")!;
    const { debounce_ms, ...patterns } = h.states!;
    const { debounce_ms: _fixtureDebounce, ...fixturePatterns } = fixture.states!;
    expect(patterns).toEqual(fixturePatterns);
    expect(debounce_ms).toBe(2250);
  });

  it("an owner claude.toml is refused and the built-in stays", () => {
    const home = ownerWithClaude();
    const owner = join(home, "harnesses");
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner });
    expect(res.errors).toContainEqual({ file: join(owner, "claude.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("claude")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("claude");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "claude.toml"));
    const lines = stderr.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes(join(owner, "claude.toml")))).toEqual([
      `[bridge] harness file refused: ${join(owner, "claude.toml")}: built-in name: an owner file cannot replace a built-in\n`,
    ]);
  });

  it("is off by default and never the engine of an open with none; enabled with a claude on PATH it resolves to the claude harness, with none it is unavailable", async () => {
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine(undefined)).rejects.toThrow("engine is required. Enabled: none");
    await expect(resolveEngine("claude")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "claude");
    const r = await resolveEngine("claude");
    expect(r.id).toBe("claude");
    expect(r.harness?.file).toBe(join(BUILTIN, "claude.toml"));
    expect(r).not.toHaveProperty("descriptor");
    expect(harnessDescriptor(r.harness!).argv).toEqual(["/usr/bin/env", "--", join(BIN, "claude")]);

    vi.stubEnv("PATH", join(tmp, "no-such-bin"));
    resetHarnessCache();
    await expect(resolveEngine("claude")).rejects.toThrow(EngineUnavailableError);
    expect(() => harnessDescriptor(builtinClaude(join(tmp, "no-such-bin")))).toThrow(/program "claude" was not found/);
  });
});

describe("claude: spawn flags (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions>): Promise<string[]> {
    const h = builtinClaude();
    const seen: SpawnOptions[] = [];
    const { fake } = fakeTerminal();
    await HarnessSession.spawn(h, { name: "r1a11-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fake;
    });
    expect(seen).toHaveLength(1);
    // Warmup trust and bypass dialog keys stay Claude-only: the descriptor keeps the id.
    expect(seen[0]!.descriptor?.id).toBe("claude");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  // U-R1A-25: the session's own delivery settings file follows the program.
  const HOOK = ["--settings", expect.stringMatching(/\/delivery\/r1a11-spawn\.settings\.json$/)];

  it("plain: /usr/bin/env -- <programPath> and nothing else", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    const program = builtinClaude().programPath ?? "claude";
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", program, ...HOOK]);
  });

  it("with bypass: --dangerously-skip-permissions from allowBypass: true only; TANDEM_ALLOW_BYPASS=1 alone adds nothing (U-R1A-17)", async () => {
    const program = builtinClaude().programPath ?? "claude";
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({ allowBypass: true })).toEqual(["/usr/bin/env", "--", program, ...HOOK, "--dangerously-skip-permissions"]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", program, ...HOOK]);
    expect(await spawned({ allowBypass: false })).toEqual(["/usr/bin/env", "--", program, ...HOOK]);
  });

  it('with model "opus", effort "high": --model opus --effort high', async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    const program = builtinClaude().programPath ?? "claude";
    expect(await spawned({ model: "opus", effort: "high" })).toEqual(["/usr/bin/env", "--", program, ...HOOK, "--model", "opus", "--effort", "high"]);
  });

  describe("warmup's trust answer (claude.toml's folder-trust row): one key per screen poll, Enter only on a highlighted 'Yes, I trust this folder'", () => {
    // U-R1A-18B: the blind Claude-only trust keys became the dialog row; same screens in, same keys out.
    const row = (name: string) => builtinClaude().dialogs?.find((d) => d.name === name);
    const trustAnswerKey = (pane: string) => dialogKey(pane, row("folder-trust")!);
    // The real trust dialog of claude 2.1.321 (private tmux socket, new folder), with the options swapped in.
    const dialog = (...options: string[]) =>
      [
        "",
        "─".repeat(120),
        " Accessing workspace:",
        "",
        " /private/tmp/w",
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
        " folder first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        ...options,
        "",
        " Enter to confirm · Esc to cancel",
        "",
        "",
      ].join("\n");

    it.each([
      ["claude 2.1.321: 'No, exit' highlighted first", [" ❯ No, exit", "   Yes, I trust this folder"], "Down"],
      ["claude 2.1.321 after one Down: Yes highlighted", ["   No, exit", " ❯ Yes, I trust this folder"], "Enter"],
      ["older numbered layout: Yes highlighted first", [" ❯ 1. Yes, I trust this folder", "   2. No, exit"], "Enter"],
      ["older numbered layout: No highlighted, Yes above", ["   1. Yes, I trust this folder", " ❯ 2. No, exit"], "Up"],
      ["Yes two options below the highlight: one Down this poll", [" ❯ No, exit", "   Not now", "   Yes, I trust this folder"], "Down"],
      ["the highlighted Yes says 'no' in its own text", [" ❯ Yes, I trust this folder (no MCP servers)", "   No, exit"], "Enter"],
    ])("%s", (_label, options, key) => {
      expect(trustAnswerKey(dialog(...options))).toBe(key);
    });

    // A wrapping list (claude 2.1.321: a second Down returns to "No, exit"), one poll per key.
    it.each([
      ["claude 2.1.321", ["No, exit", "Yes, I trust this folder"], 0, ["Down", "Enter"]],
      ["older numbered", ["1. Yes, I trust this folder", "2. No, exit"], 0, ["Enter"]],
      ["older numbered, No highlighted", ["1. Yes, I trust this folder", "2. No, exit"], 1, ["Up", "Enter"]],
      ["three options", ["No, exit", "Not now", "Yes, I trust this folder"], 0, ["Down", "Down", "Enter"]],
    ])("%s: options %j, one key per poll, Enter only on Yes", (_label, options, start, want) => {
      let at = start as number;
      const sent: string[] = [];
      for (let poll = 0; poll < 6 && sent.at(-1) !== "Enter"; poll++) {
        const key = trustAnswerKey(dialog(...options.map((o, i) => (i === at ? ` ❯ ${o}` : `   ${o}`))));
        expect(key).toBeDefined();
        sent.push(key!);
        if (key === "Enter") expect(options[at]).toMatch(/Yes, I trust this folder/);
        if (key === "Down") at = (at + 1) % options.length;
        if (key === "Up") at = (at - 1 + options.length) % options.length;
      }
      expect(sent).toEqual(want);
    });

    it.each([
      [
        "the bypass-permissions warning, even with 'trust this folder' on screen",
        " WARNING: Claude Code running in Bypass Permissions mode\n\n Only use it in a folder you trust this folder to be safe.\n\n ❯ 1. No, exit\n   2. Yes, I accept\n\n Enter to confirm · Esc to cancel",
      ],
      ["an update prompt", " A new version of Claude Code is available. Do you trust this folder's updater?\n\n ❯ 1. Update now\n   2. Not now\n"],
      ["an older dialog with no 'Yes, I trust this folder' option", dialog(" ❯ 1. Yes, proceed", "   2. No, exit")],
      [
        "the prompt box under transcript text that quotes the option",
        "  Yes, I trust this folder\n\n" + "─".repeat(80) + "\n❯ \n" + "─".repeat(80) + "\n  ⏵⏵ auto mode on (shift+tab to cycle)",
      ],
      ["the option with no highlight in its block", dialog("   No, exit", "   Yes, I trust this folder")],
    ])("no key for %s", (_label, pane) => {
      expect(trustAnswerKey(pane)).toBeUndefined();
    });

    // The blind bypass Down+Enter became the bypass-accept row: Down toward "Yes, I accept", then Enter on it.
    it.each([
      ["'No, exit' highlighted", " ❯ 1. No, exit\n   2. Yes, I accept", "Down"],
      ["'Yes, I accept' highlighted", "   1. No, exit\n ❯ 2. Yes, I accept", "Enter"],
    ])("bypass-accept row: %s gives %s", (_label, options, key) => {
      const pane = ` WARNING: Claude Code running in Bypass Permissions mode\n\n${options}\n\n Enter to confirm · Esc to cancel`;
      expect(dialogKey(pane, row("bypass-accept")!)).toBe(key);
    });
  });

  it("a bad model or effort throws before the spawn function is called", async () => {
    const h = builtinClaude();
    for (const bad of [{ model: "gpt-5" }, { effort: "extreme" }]) {
      let called = 0;
      await expect(
        HarnessSession.spawn(h, { name: "r1a11-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/unsupported (model|effort)/);
      expect(called).toBe(0);
    }
  });
});

describe("claude: a harness session over an injected terminal", () => {
  it("per-turn model/effort call applyControls, then send", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinClaude(), fake);
    expect(session.engine).toBe("claude");
    const result = await session.send("go", { model: "opus", effort: "high" });
    expect(calls).toEqual([
      { method: "applyControls", args: [{ model: "opus", effort: "high" }] },
      { method: "send", args: ["go"] },
    ]);
    expect(result).toEqual({ report: "report: go", cursor: 1, status: "done" });
  });

  it("interrupt hands Escape, C-c in order (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    await new HarnessSession(builtinClaude(), fake).interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape", "C-c"]] }]);
  });

  it.each([
    ["claude-idle-real.txt", "idle"],
    ["claude-idle-stale.txt", "idle"],
    ["claude-working-real.txt", "working"],
  ])("read on %s gives %s", async (file, state) => {
    vi.useFakeTimers();
    const { fake } = fakeTerminal(screen(file));
    const session = new HarnessSession(builtinClaude(), fake);
    await session.read();
    vi.advanceTimersByTime(2250);
    expect((await session.read()).agentState).toBe(state);
    const d = harnessDescriptor(builtinClaude());
    expect(d.isReady!(screen(file))).toBe(state === "idle");
    expect(d.isWorking!(screen(file))).toBe(state !== "idle");
  });
});
