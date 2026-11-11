/**
 * U-R1A-12: Codex runs from its built-in harness file (harnesses/codex.toml) through the one
 * harness engine. Injected fakes only: no tmux, no real `codex` process (the `codex` on PATH
 * here is a fake file that is never run).
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses, type Harness } from "../../bridge/harness-registry.ts";
import { HarnessSession, type HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import {
  EngineDisabledError,
  EngineUnavailableError,
  loadedHarnesses,
  resetHarnessCache,
  resolveEngine,
} from "../../bridge/engine-registry.ts";
import { spawnArgv, type SpawnOptions } from "../../bridge/terminal-session.ts";

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const SCREENS = fileURLToPath(new URL("../fixtures/screens/", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "r1a12-codex-"));
const NO_OWNER = join(tmp, "no-owner");
/** A PATH folder holding an executable fake `codex`. */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const FAKE_CODEX = join(BIN, "codex");

/** The built-in codex file as the loader reads it (no owner files, the fake codex on PATH). */
function builtinCodex(): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
  expect(errors).toEqual([]);
  const h = harnesses.get("codex");
  expect(h).toBeDefined();
  return h!;
}

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1a12-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1a12-fake'",
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

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHarnessCache();
});

describe("codex: the built-in harness file", () => {
  it("loads with no error, kind agent; its state patterns and precedence equal the fixture file's, debounce_ms 5000", () => {
    const h = builtinCodex();
    expect(h).toMatchObject({
      name: "codex",
      program: "codex",
      args: [],
      source: "builtin",
      file: join(BUILTIN, "codex.toml"),
      kind: "agent",
      programPath: FAKE_CODEX,
      has_prompts: true,
      skip_prompts_args: ["--dangerously-bypass-approvals-and-sandbox"],
      resume: ["resume", "{id}"],
      fork: ["fork", "{id}"],
      account_env: "CODEX_HOME",
      history: "~/.codex/sessions",
      keys: { interrupt: ["Escape"], approve: "Enter", deny: "Escape" },
      delivery: "notice",
    });
    expect(h.hook).toBeUndefined();
    expect(h.logo).toBeUndefined();
    const fixture = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: NO_OWNER }).harnesses.get("codex")!;
    const { debounce_ms, ...patterns } = h.states!;
    const { debounce_ms: _fixtureDebounce, ...fixturePatterns } = fixture.states!;
    expect(patterns).toEqual(fixturePatterns);
    expect(debounce_ms).toBe(5000);
  });

  it("an owner codex.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "codex.toml"), 'name = "codex"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({ file: join(owner, "codex.toml"), reason: "built-in name: an owner file cannot replace a built-in" });
    expect(res.harnesses.get("codex")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("codex");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "codex.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a codex on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", BIN);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("codex")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "codex");
    const r = await resolveEngine("codex");
    expect(r.id).toBe("codex");
    expect(r.descriptor).toBeUndefined();
    expect(r.harness?.file).toBe(join(BUILTIN, "codex.toml"));
    expect(r.harness?.programPath).toBe(FAKE_CODEX);

    vi.stubEnv("PATH", join(tmp, "no-such-bin"));
    resetHarnessCache();
    await expect(resolveEngine("codex")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("codex")).rejects.toThrow(/"codex"/);
  });
});

describe("codex: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions>): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinCodex(), { name: "r1a12-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("codex");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is /usr/bin/env -- <programPath> alone, also with TANDEM_ALLOW_BYPASS=1", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CODEX]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_CODEX]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinCodex(), { name: "r1a12-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands Escape only (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinCodex(), fake);
    expect(session.engine).toBe("codex");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["Escape"]] }]);
  });
});
