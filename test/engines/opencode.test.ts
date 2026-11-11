/**
 * U-R1B-08: OpenCode runs from its built-in harness file (harnesses/opencode.toml) through the one
 * harness engine, with no code change. The `opencode` on PATH here is always a fake script; one
 * case runs it in tmux, never the real opencode.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1b08-
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

const TMUX_BOX = mkdtempSync("/tmp/r1b08-");
process.env.TMUX_TMPDIR = TMUX_BOX;
delete process.env.TMUX;
// U-R1A-19: Tandem's own socket under TANDEM_HOME (set below to join(tmp, "tandem")), read at cleanup.
const SOCK = () => join(tmp, "tandem", "tmux", "tandem");
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK()],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1b08 cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync("/tmp/r1b08-");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync("/tmp/r1b08-"));
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
const SCREENS = fileURLToPath(new URL("../fixtures/screens/", import.meta.url));
const IDLE_REAL = join(SCREENS, "opencode-idle-real.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `opencode`: it prints the real 2.2.7 idle screen; each
 * line it reads clears the screen and shows `Working…  esc interrupt` for about 1 s, then clears
 * again and prints `reply: <line>` and the idle screen.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_OPENCODE = join(BIN, "opencode");
writeFileSync(
  FAKE_OPENCODE,
  `#!/bin/sh\ncat '${IDLE_REAL}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  printf 'Working\\342\\200\\246  esc interrupt\\n'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_REAL}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in opencode file as the loader reads it (no owner files, the fake opencode on PATH). */
function builtinOpencode(): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
  expect(errors).toEqual([]);
  const h = harnesses.get("opencode");
  expect(h).toBeDefined();
  return h!;
}

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1b08-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1b08-fake'",
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

describe("opencode: the built-in harness file", () => {
  it("loads with no error, kind agent; its states equal the fixture file's", () => {
    const h = builtinOpencode();
    expect(h).toMatchObject({
      name: "opencode",
      program: "opencode",
      args: ["--standalone"],
      source: "builtin",
      file: join(BUILTIN, "opencode.toml"),
      kind: "agent",
      programPath: FAKE_OPENCODE,
      has_prompts: true,
      skip_prompts_args: ["--auto"],
      resume: ["--session", "{id}"],
      fork: [],
      keys: { interrupt: ["Escape"] },
      delivery: "notice",
    });
    expect(h.args).toEqual(["--standalone"]);
    expect(h.keys).toEqual({ interrupt: ["Escape"] });
    expect(h.account_env).toBeUndefined();
    expect(h.history).toBeUndefined();
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    const fixture = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: NO_OWNER }).harnesses.get("opencode")!;
    expect(fixture).toBeDefined();
    expect(h.states).toEqual(fixture.states);
  });

  it.each([
    ["opencode-idle-real.txt", "idle"],
    ["opencode-working-1.txt", "working"],
    ["opencode-working-2.txt", "working"],
    ["opencode-working-3.txt", "working"],
    ["opencode-waiting_for_approval-1.txt", "waiting_for_approval"],
    ["opencode-waiting_for_approval-2.txt", "waiting_for_approval"],
    ["opencode-waiting_for_approval-3.txt", "waiting_for_approval"],
    ["opencode-unknown-1.txt", "unknown"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinOpencode(), readFileSync(join(SCREENS, file), "utf8"))).toBe(state);
  });

  it("never idle: every approval and unknown screen in the fixtures folder", () => {
    const h = builtinOpencode();
    const files = readdirSync(SCREENS).filter((f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(26);
    const idle = files.filter((f) => readScreen(h, readFileSync(join(SCREENS, f), "utf8")) === "idle");
    expect(idle).toEqual([]);
  });

  it("never idle: every other agent's idle screen in the fixtures folder", () => {
    const h = builtinOpencode();
    const files = readdirSync(SCREENS).filter((f) => /-idle-[^/]*\.txt$/.test(f) && !f.startsWith("opencode-"));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, readFileSync(join(SCREENS, f), "utf8")) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner opencode.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "opencode.toml"), 'name = "opencode"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "opencode.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("opencode")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("opencode");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "opencode.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with an opencode on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("opencode")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "opencode");
    resetHarnessCache();
    const r = await resolveEngine("opencode");
    expect(r.id).toBe("opencode");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "opencode.toml"));
    expect(r.harness?.programPath).toBe(FAKE_OPENCODE);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("opencode")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("opencode")).rejects.toThrow(/"opencode"/);
  });

  it("an open with engine bogus is 400 unknown engine", async () => {
    const res = await routeForTest("POST", "/sessions/open", { name: `r1b08-bogus-${Date.now()}`, engine: "bogus" });
    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error)).toMatch(/unknown engine/);
  });

  it("GET /sessions?engine=opencode is 200 and every row is engine opencode", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=opencode");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "opencode")).toBe(true);
  });
});

describe("opencode: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions>): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinOpencode(), { name: "r1b08-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("opencode");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is /usr/bin/env -- <programPath> --standalone (no --auto), also with TANDEM_ALLOW_BYPASS=1", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_OPENCODE, "--standalone"]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_OPENCODE, "--standalone"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinOpencode(), { name: "r1b08-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands Escape only (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinOpencode(), fake);
    expect(session.engine).toBe("opencode");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("opencode: a fake opencode in tmux on a private socket", () => {
  it("spawns ready; a send of r1b08-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1b08-oc-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinOpencode(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1b08-owner" }),
    );
    try {
      expect(session.engine).toBe("opencode");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1b08-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1b08-ok");

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
