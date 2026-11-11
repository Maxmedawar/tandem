/**
 * U-R1A-15: Antigravity (program `agy`) runs from its built-in harness file
 * (harnesses/antigravity.toml) through the one harness engine, with no code change. The gemini
 * cases of Synergy test/grok-gemini.test.ts, ported as Antigravity (agy succeeds Gemini CLI); its
 * grok and hermes cases are not ported. The `agy` on PATH here is always a fake script; one case
 * runs it in tmux, never the real agy.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a15-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents run.
 * Its afterAll kills that server through its own -S socket, then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../../bridge/harness-registry.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";

const TMUX_BOX = mkdtempSync("/tmp/r1a15-");
process.env.TMUX_TMPDIR = TMUX_BOX;
delete process.env.TMUX;
const SOCK = join(TMUX_BOX, `tmux-${process.getuid!()}`, "default");
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a15 cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync("/tmp/r1a15-");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync("/tmp/r1a15-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

// Read when the bridge modules load (transcripts, harness files).
process.env.TANDEM_HOME = join(tmp, "tandem");

const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { readScreen } = await import("../../bridge/harness-detect.ts");
const { HarnessSession, harnessDescriptor } = await import("../../bridge/engines/harness-engine.ts");
const { EngineDisabledError, EngineUnavailableError, UnknownEngineError, loadedHarnesses, resetHarnessCache, resolveEngine } =
  await import("../../bridge/engine-registry.ts");
const { spawnArgv, TerminalSession } = await import("../../bridge/terminal-session.ts");
const { routeForTest } = await import("../../bridge/router.ts");

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const SCREENS = fileURLToPath(new URL("../fixtures/screens/", import.meta.url));
/** Real agy screens kept by the live recorder (U-R1A-15L), named `<state>[-<word>]-real.txt`. */
const AGY_REAL = fileURLToPath(new URL("../fixtures/agy-screens/", import.meta.url));
const AGY_REAL_FILES = readdirSync(AGY_REAL).filter((f) => /-real\.txt$/.test(f));
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `agy`: it prints `Antigravity (fake)`; each line it
 * reads shows `Working (esc to cancel)` for about 1 s, then redraws that line (carriage return,
 * erase line) as `Done. <line>` and a newline. It has no prompt, as no agy prompt has been seen.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_AGY = join(BIN, "agy");
writeFileSync(
  FAKE_AGY,
  "#!/bin/sh\nprintf 'Antigravity (fake)\\n'\nwhile IFS= read -r line; do\n  printf 'Working (esc to cancel)'\n  sleep 1\n  printf '\\r\\033[KDone. %s\\n' \"$line\"\ndone\n",
  { mode: 0o755 },
);

/** Screens built from agy's own text (read from the binary, never run). */
const AGY_SCREENS: [string, string][] = [
  ["agy approval", "Do you want to proceed?\n> Yes, accept this change\n  No, reject this change"],
  ["agy trust", "Do you trust the contents of this project?\n> Yes\n  No"],
  ["agy sign-in", "Select login method:\n> Other sign-in options\n (esc to cancel)"],
];

/** The built-in antigravity file as the loader reads it (no owner files, the fake agy on PATH). */
function builtinAgy(): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
  expect(errors).toEqual([]);
  const h = harnesses.get("antigravity");
  expect(h).toBeDefined();
  return h!;
}

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1a15-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1a15-fake'",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => ({ report: `report: ${text}`, cursor: 1, status: "quiet" as const }),
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

describe("antigravity: the built-in harness file", () => {
  it("loads with no error, kind agent; its states equal the gemini fixture file's; markerless at 1500 ms", () => {
    const h = builtinAgy();
    expect(h).toMatchObject({
      name: "antigravity",
      program: "agy",
      args: [],
      source: "builtin",
      file: join(BUILTIN, "antigravity.toml"),
      kind: "agent",
      programPath: FAKE_AGY,
      has_prompts: true,
      skip_prompts_args: ["--dangerously-skip-permissions"],
      resume: ["--conversation", "{id}"],
      fork: [],
      history: "~/.gemini/antigravity-cli/conversations",
      keys: { interrupt: ["Escape"] },
      delivery: "notice",
    });
    expect(h.keys).toEqual({ interrupt: ["Escape"] });
    expect(h.account_env).toBeUndefined();
    expect(h.hook).toBeUndefined();
    expect(h.logo).toBeUndefined();
    const fixture = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: NO_OWNER }).harnesses.get("gemini")!;
    expect(h.states).toEqual(fixture.states);
    expect(h.states?.debounce_ms).toBe(1500);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.states?.idle).toBeUndefined();

    const d = harnessDescriptor(h);
    expect(d.minStableMs).toBe(1500);
    expect(d.isReady).toBeUndefined();
    expect(d.isWorking).toBeUndefined();
  });

  it.each([
    ["gemini-working-1.txt", "working"],
    ["gemini-working-2.txt", "working"],
    ["gemini-waiting_for_approval-1.txt", "waiting_for_approval"],
    ["gemini-waiting_for_approval-2.txt", "waiting_for_approval"],
    ["gemini-waiting_for_approval-3.txt", "waiting_for_approval"],
    ["gemini-unknown-1.txt", "unknown"],
    ["gemini-unknown-2.txt", "unknown"],
    ["gemini-unknown-auth.txt", "unknown"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinAgy(), readFileSync(join(SCREENS, file), "utf8"))).toBe(state);
  });

  it("never idle: every approval, sign-in, update and trust screen in the fixtures folder", () => {
    const h = builtinAgy();
    const files = readdirSync(SCREENS).filter((f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(26);
    const idle = files.filter((f) => readScreen(h, readFileSync(join(SCREENS, f), "utf8")) === "idle");
    expect(idle).toEqual([]);
  });

  it("never idle: every non-idle real agy screen", () => {
    const h = builtinAgy();
    const files = AGY_REAL_FILES.filter((f) => !f.startsWith("idle-"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const idle = files.filter((f) => readScreen(h, readFileSync(join(AGY_REAL, f), "utf8")) === "idle");
    expect(idle).toEqual([]);
  });

  it.each(AGY_REAL_FILES.map((f) => [f, f.split("-")[0]!]))(
    "real agy screen %s reads %s through the built-in file",
    (file, state) => {
      expect(readScreen(builtinAgy(), readFileSync(join(AGY_REAL, file), "utf8"))).toBe(state);
    },
  );

  it.each(AGY_SCREENS)("never idle: the %s screen", (_label, screen) => {
    expect(readScreen(builtinAgy(), screen)).not.toBe("idle");
  });

  it("the agy approval screen reads waiting_for_approval", () => {
    expect(readScreen(builtinAgy(), AGY_SCREENS[0]![1])).toBe("waiting_for_approval");
  });

  it("an owner antigravity.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "antigravity.toml"), 'name = "antigravity"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', {
      mode: 0o600,
    });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "antigravity.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("antigravity")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("antigravity");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "antigravity.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with an agy on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("antigravity")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "antigravity");
    resetHarnessCache();
    const r = await resolveEngine("antigravity");
    expect(r.id).toBe("antigravity");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "antigravity.toml"));
    expect(r.harness?.programPath).toBe(FAKE_AGY);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("antigravity")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("antigravity")).rejects.toThrow(/"agy"/);
  });

  it("agy is only the program: resolveEngine('agy') is UnknownEngineError, also with TANDEM_ENABLED_ENGINES=agy", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("agy")).rejects.toThrow(UnknownEngineError);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "agy");
    resetHarnessCache();
    await expect(resolveEngine("agy")).rejects.toThrow(UnknownEngineError);
  });

  it("an open with engine bogus is 400 unknown engine", async () => {
    const res = await routeForTest("POST", "/sessions/open", { name: `r1a15-bogus-${Date.now()}`, engine: "bogus" });
    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error)).toMatch(/unknown engine/);
  });

  it("GET /sessions?engine=antigravity is 200 and every row is engine antigravity", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=antigravity");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "antigravity")).toBe(true);
  });
});

describe("antigravity: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions>): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinAgy(), { name: "r1a15-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("antigravity");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is /usr/bin/env -- <programPath> alone (no --dangerously-skip-permissions), also with TANDEM_ALLOW_BYPASS=1", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_AGY]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_AGY]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinAgy(), { name: "r1a15-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands Escape only (the file's keys.interrupt; a second Ctrl+C exits agy)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinAgy(), fake);
    expect(session.engine).toBe("antigravity");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("antigravity: a fake agy in tmux on a private socket", () => {
  it("spawns ready; a send of r1a15-ok ends quiet (markerless) with it in the report; a read gives unknown; close", async () => {
    const name = `r1a15-agy-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinAgy(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a15-owner" }),
    );
    try {
      expect(session.engine).toBe("antigravity");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1a15-ok");
      expect(sent.status).toBe("quiet");
      expect(sent.report).toContain("r1a15-ok");

      expect((await session.read({ cursor: sent.cursor })).agentState).toBe("unknown");
    } finally {
      await session.close();
    }
    expect(await session.isAlive()).toBe(false);
  }, 60_000);
});
