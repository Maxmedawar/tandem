/**
 * U-R1B-09: Pi runs from its built-in harness file (harnesses/pi.toml) through the one harness
 * engine, with no code change. The `pi` on PATH here is always a fake script; one case runs it in
 * tmux, never the real pi.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1b09- folder and TMUX is unset, so nothing here reaches the default server
 * where the live agents run. Its afterAll kills that server through its own -S socket, then
 * removes the folder.
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

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1b09-"));
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
  console.log(`r1b09 cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1b09-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1b09-")));
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
const PI_SCREENS = join(FIXTURES, "pi-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_DOC = join(PI_SCREENS, "idle-doc.txt");
const WORKING_DOC = join(PI_SCREENS, "working-doc.txt");
const NO_OWNER = join(tmp, "no-owner");
/**
 * A PATH folder holding an executable fake `pi`: it prints idle-doc; each line it reads clears
 * the screen and shows working-doc for about 1 s, then clears again and prints `reply: <line>`
 * and idle-doc.
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_PI = join(BIN, "pi");
writeFileSync(
  FAKE_PI,
  `#!/bin/sh\ncat '${IDLE_DOC}'\nwhile IFS= read -r line; do\n  printf '\\033[2J\\033[H'\n  cat '${WORKING_DOC}'\n  sleep 1\n  printf '\\033[2J\\033[H'\n  printf 'reply: %s\\n' "$line"\n  cat '${IDLE_DOC}'\ndone\n`,
  { mode: 0o755 },
);

/** The built-in pi file as the loader reads it (no owner files, the fake pi on PATH). */
function builtinPi(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("pi");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1b09-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1b09-fake'",
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

describe("pi: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinPi();
    expect(h).toMatchObject({
      name: "pi",
      program: "pi",
      source: "builtin",
      file: join(BUILTIN, "pi.toml"),
      kind: "agent",
      programPath: FAKE_PI,
      has_prompts: false,
      resume: ["--session", "{id}"],
      fork: ["--fork", "{id}"],
      account_env: "PI_CODING_AGENT_DIR",
      history: "~/.pi/agent/sessions",
      delivery: "notice",
    });
    expect(h.args).toEqual([]);
    expect(h.skip_prompts_args).toEqual([]);
    expect(h.keys).toEqual({ interrupt: ["Escape"] });
    expect(h.states?.working).toEqual(["Working\\.\\.\\."]);
    expect(h.states?.idle).toEqual(["─{20,}\\n[^\\n]*\\n─{20,}\\n[^\\n]*\\n[^\\n]*\\d%/\\d"]);
    expect(h.states?.waiting_for_approval ?? []).toEqual([]);
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a pi that is a symlink to an executable named cli.js is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const cli = join(pkg, "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(cli, join(bin, "pi"));
    const h = builtinPi(bin);
    expect(h.programPath).toBe(join(bin, "pi"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-doc.txt", "idle"],
    ["idle-header-doc.txt", "idle"],
    ["working-doc.txt", "working"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinPi(), screen(join(PI_SCREENS, file)))).toBe(state);
  });

  it("idle-doc with its usage line removed is not idle", () => {
    const lines = screen(IDLE_DOC).trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/1\.7%\/272k/);
    expect(readScreen(builtinPi(), lines.slice(0, -1).join("\n") + "\n")).not.toBe("idle");
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinPi();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("pi-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it.each(["dialogs", "agy-screens"])("never idle: every file in test/fixtures/%s", (folder) => {
    const h = builtinPi();
    const files = readdirSync(join(FIXTURES, folder));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, screen(join(FIXTURES, folder, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner pi.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "pi.toml"), 'name = "pi"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "pi.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("pi")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("pi");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "pi.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a pi on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("pi")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "pi");
    resetHarnessCache();
    const r = await resolveEngine("pi");
    expect(r.id).toBe("pi");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "pi.toml"));
    expect(r.harness?.programPath).toBe(FAKE_PI);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("pi")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("pi")).rejects.toThrow(/"pi"/);
  });

  it("GET /sessions?engine=pi is 200 and every row is engine pi", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=pi");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "pi")).toBe(true);
  });
});

describe("pi: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinPi(), { name: "r1b09-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("pi");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath>, also with TANDEM_ALLOW_BYPASS=1 and with skipPrompts", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_PI]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_PI]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_PI]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinPi(), { name: "r1b09-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one Escape (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinPi(), fake);
    expect(session.engine).toBe("pi");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});

describe("pi: a fake pi in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1b09-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1b09-pi-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinPi(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1b09-owner" }),
    );
    try {
      expect(session.engine).toBe("pi");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1b09-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1b09-ok");

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
