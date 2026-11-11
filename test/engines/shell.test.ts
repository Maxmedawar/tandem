/**
 * U-R1A-13: plain shell runs from its built-in harness file (harnesses/shell.toml) through the one
 * harness engine, and is off by default like every other agent. The fake `sh` on PATH below is
 * never run; one case starts a real `sh -l` in tmux.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a13-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents run.
 * afterAll kills that server through its own -S socket, then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";

const BOX = mkdtempSync("/tmp/r1a13-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, "tandem", "tmux", "tandem"); // U-R1A-19: Tandem's own socket under TANDEM_HOME
const WORK = join(BOX, "work");
mkdirSync(WORK);
// Read when the router is imported or the harness files first load.
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_WAIT_MS = "15000";

const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { HarnessSession, harnessDescriptor } = await import("../../bridge/engines/harness-engine.ts");
const { EngineDisabledError, loadedHarnesses, resetHarnessCache, resolveEngine } = await import("../../bridge/engine-registry.ts");
const { spawnArgv } = await import("../../bridge/terminal-session.ts");
const { routeForTest } = await import("../../bridge/router.ts");
const { applyLimits } = await import("../../bridge/limits.ts");
const { agentEntry, writeLimits } = await import("../fixtures/limits.ts");

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const NO_OWNER = join(BOX, "no-owner");
/** A PATH folder holding an executable fake `sh` (never run). */
const BIN = join(BOX, "bin");
mkdirSync(BIN);
const FAKE_SH = join(BIN, "sh");
writeFileSync(FAKE_SH, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

/** The built-in shell file as the loader reads it (no owner files, the fake sh on PATH). */
function builtinShell() {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
  expect(errors).toEqual([]);
  const h = harnesses.get("shell");
  expect(h).toBeDefined();
  return h!;
}

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1a13-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1a13-fake'",
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

afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a13 cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

describe("shell: the built-in harness file", () => {
  it("loads with no error, kind shell, has_prompts false, args [-l], no history", () => {
    const h = builtinShell();
    expect(h).toMatchObject({
      name: "shell",
      program: "sh",
      args: ["-l"],
      source: "builtin",
      file: join(BUILTIN, "shell.toml"),
      kind: "shell",
      programPath: FAKE_SH,
      has_prompts: false,
      skip_prompts_args: [],
      resume: [],
      fork: [],
      keys: { interrupt: "C-c" },
    });
    expect(h.states?.debounce_ms).toBe(1500);
    expect(h.states?.idle).toBeUndefined();
    expect(h.history).toBeUndefined();
    expect(h.account_env).toBeUndefined();
  });

  it("an owner shell.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(BOX, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "shell.toml"), 'name = "shell"\nprogram = "/bin/sh"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "shell.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("shell")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("shell");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "shell.toml"));
  });

  it("is disabled by default; enabled, with a sh on PATH, it resolves to the harness file", async () => {
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("shell")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "shell");
    resetHarnessCache();
    const r = await resolveEngine("shell");
    expect(r.id).toBe("shell");
    expect(r.harness?.file).toBe(join(BUILTIN, "shell.toml"));
    expect(r.harness?.programPath).toBe(FAKE_SH);
  });
});

describe("shell: the harness engine (injected spawn function)", () => {
  it("spawn argv is /usr/bin/env -- <programPath> -l", async () => {
    const h = builtinShell();
    const seen: SpawnOptions[] = [];
    const { fake } = fakeTerminal();
    await HarnessSession.spawn(h, { name: "r1a13-spawn", cwd: "/tmp/work", allowlist: ["/tmp"] }, async (o) => {
      seen.push(o);
      return fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("shell");
    expect(spawnArgv(seen[0]!.descriptor!, seen[0]!)).toEqual(["/usr/bin/env", "--", FAKE_SH, "-l"]);
  });

  it("model, effort or allowBypass throws before the spawn function runs", async () => {
    const h = builtinShell();
    for (const extra of [{ model: "opus" }, { effort: "high" }, { allowBypass: true }]) {
      let ran = false;
      await expect(
        HarnessSession.spawn(h, { name: "r1a13-flags", cwd: "/tmp/work", allowlist: ["/tmp"], ...extra }, async () => {
          ran = true;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/not supported for engine "shell"/);
      expect(ran).toBe(false);
    }
  });

  it("is markerless with minStableMs 1500", () => {
    const d = harnessDescriptor(builtinShell());
    expect(d.isReady).toBeUndefined();
    expect(d.isWorking).toBeUndefined();
    expect(d.minStableMs).toBe(1500);
  });

  it("interrupt hands C-c only", async () => {
    const { fake, calls } = fakeTerminal();
    await new HarnessSession(builtinShell(), fake).interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["C-c"]] }]);
  });
});

describe("shell: a real sh -l in tmux on a private socket", () => {
  it("opens through the router, a send of echo r1a13-ok ends quiet with that text, close", async () => {
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "shell");
    vi.stubEnv("PATH", `/usr/bin:/bin:${process.env.PATH ?? ""}`);
    resetHarnessCache();
    // U-R1A-17: the limits file allows only this: the shell, pinned to the sh found, in WORK.
    writeLimits(process.env.TANDEM_HOME!, { folders: [WORK], shell: true, agents: { shell: agentEntry(loadedHarnesses().get("shell")!) } });
    applyLimits();
    const name = `r1a13-sh-${Math.random().toString(36).slice(2, 8)}`;
    const opened = await routeForTest("POST", "/sessions/open", { name, engine: "shell", cwd: WORK });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ name, engine: "shell", ready: true });
    expect(existsSync(SOCK)).toBe(true);

    const sent = await routeForTest("POST", `/sessions/${name}/send`, { text: "echo r1a13-ok" });
    expect(sent.status).toBe(200);
    const body = sent.body as { status: string; report: string; engine: string };
    expect(body.engine).toBe("shell");
    expect(body.status).toBe("quiet");
    expect(body.report).toMatch(/^r1a13-ok$/m);

    const closed = await routeForTest("POST", `/sessions/${name}/close`);
    expect(closed).toEqual({ status: 200, body: { ok: true, name, engine: "shell" } });
  }, 60_000);
});
