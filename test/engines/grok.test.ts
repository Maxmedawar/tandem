/**
 * U-R1A-14: Grok runs from its built-in harness file (harnesses/grok.toml) through the one
 * harness engine, with no code change. Grok cases ported from Synergy test/grok-gemini.test.ts
 * (its cwd-gate form is not ported). The `grok` on PATH here is always a fake script; one case
 * runs it in tmux, never the real grok.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a14-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents run.
 * Its afterAll kills that server through its own -S socket, then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../../bridge/harness-registry.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";

const TMUX_BOX = mkdtempSync("/tmp/r1a14-");
process.env.TMUX_TMPDIR = TMUX_BOX;
delete process.env.TMUX;
const SOCK = join(TMUX_BOX, `tmux-${process.getuid!()}`, "default");
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a14 cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync("/tmp/r1a14-");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync("/tmp/r1a14-"));
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
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `grok`: it prints `> `; each line it reads shows a
 * spinner line for about 1 s, then redraws that line (carriage return, erase line) as the reply
 * and a new `> `, as grok's TUI does.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_GROK = join(BIN, "grok");
writeFileSync(
  FAKE_GROK,
  "#!/bin/sh\nprintf '> '\nwhile IFS= read -r line; do\n  printf '\\342\\240\\213 Thinking\\342\\200\\246 0.1s'\n  sleep 1\n  printf '\\r\\033[K\\342\\227\\206 Done. %s\\n> ' \"$line\"\ndone\n",
  { mode: 0o755 },
);

/** The built-in grok file as the loader reads it (no owner files, the fake grok on PATH). */
function builtinGrok(): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
  expect(errors).toEqual([]);
  const h = harnesses.get("grok");
  expect(h).toBeDefined();
  return h!;
}

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1a14-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1a14-fake'",
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

describe("grok: the built-in harness file", () => {
  it("loads with no error, kind agent; its states equal the fixture file's after the loader's defaults", () => {
    const h = builtinGrok();
    expect(h).toMatchObject({
      name: "grok",
      program: "grok",
      args: [],
      source: "builtin",
      file: join(BUILTIN, "grok.toml"),
      kind: "agent",
      programPath: FAKE_GROK,
      has_prompts: true,
      skip_prompts_args: ["--always-approve"],
      resume: ["--resume", "{id}"],
      fork: [],
      account_env: "GROK_HOME",
      history: "~/.grok/sessions",
      keys: { interrupt: ["Escape", "C-c"] },
      delivery: "notice",
    });
    expect(h.keys).toEqual({ interrupt: ["Escape", "C-c"] });
    expect(h.hook).toBeUndefined();
    expect(h.logo).toBeUndefined();
    const fixture = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: NO_OWNER }).harnesses.get("grok")!;
    expect(h.states).toEqual(fixture.states);
    expect(h.states?.debounce_ms).toBe(1500);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
  });

  it.each([
    ["grok-idle-1.txt", "idle"],
    ["grok-idle-2.txt", "idle"],
    ["grok-idle-3.txt", "idle"],
    ["grok-working-1.txt", "working"],
    ["grok-working-2.txt", "working"],
    ["grok-working-3.txt", "working"],
    ["grok-waiting_for_approval-1.txt", "waiting_for_approval"],
    ["grok-waiting_for_approval-2.txt", "waiting_for_approval"],
    ["grok-waiting_for_approval-3.txt", "waiting_for_approval"],
    ["grok-unknown-signin.txt", "unknown"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinGrok(), readFileSync(join(SCREENS, file), "utf8"))).toBe(state);
  });

  it("an owner grok.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "grok.toml"), 'name = "grok"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "grok.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("grok")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("grok");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "grok.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a grok on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("grok")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "grok");
    resetHarnessCache();
    const r = await resolveEngine("grok");
    expect(r.id).toBe("grok");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "grok.toml"));
    expect(r.harness?.programPath).toBe(FAKE_GROK);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("grok")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("grok")).rejects.toThrow(/"grok"/);
  });

  it("an open with engine bogus is 400 unknown engine", async () => {
    const res = await routeForTest("POST", "/sessions/open", { name: `r1a14-bogus-${Date.now()}`, engine: "bogus" });
    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error)).toMatch(/unknown engine/);
  });

  it("GET /sessions?engine=grok is 200 and every row is engine grok", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=grok");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "grok")).toBe(true);
  });
});

describe("grok: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions>): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinGrok(), { name: "r1a14-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("grok");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is /usr/bin/env -- <programPath> alone (no --always-approve), also with TANDEM_ALLOW_BYPASS=1", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GROK]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GROK]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinGrok(), { name: "r1a14-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands Escape then C-c (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinGrok(), fake);
    expect(session.engine).toBe("grok");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape", "C-c"]] }]);
  });
});

describe("grok: a fake grok in tmux on a private socket", () => {
  it("spawns ready; a send of r1a14-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1a14-grok-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinGrok(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a14-owner" }),
    );
    try {
      expect(session.engine).toBe("grok");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1a14-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1a14-ok");

      // idle is debounced (1500 ms), so it can take a few reads.
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
