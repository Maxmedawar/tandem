import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEngineId,
  buildEnabledEngines,
  enabledEngineIds,
  resolveEngine,
  capabilityReport,
  loadedHarnesses,
  resetHarnessCache,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
  KNOWN_ENGINE_IDS,
} from "../bridge/engine-registry.ts";

// U-R1A-13: no agent is on by default; claude, codex and shell run from their built-in harness
// files and need their program on PATH. The fakes below are never run.
const BUILTIN = fileURLToPath(new URL("../harnesses/", import.meta.url));
const tmp = mkdtempSync("/tmp/r1a13-registry-");
const BIN = join(tmp, "bin");
const EMPTY_BIN = join(tmp, "empty-bin");
mkdirSync(BIN);
mkdirSync(EMPTY_BIN);
for (const p of ["claude", "codex", "sh"]) writeFileSync(join(BIN, p), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

/** PATH starts with the fake programs or with an empty folder; no owner harness files. */
function programsOnPath(present: boolean, tandemHome = join(tmp, "empty-home")): void {
  vi.stubEnv("TANDEM_HOME", tandemHome);
  vi.stubEnv("PATH", `${present ? BIN : EMPTY_BIN}:/usr/bin:/bin`);
  resetHarnessCache();
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHarnessCache();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// U-R1A-16 cases: temp folders under /tmp/r1a16-, owner files in $TANDEM_HOME/harnesses (0700, files 0600).
const BOX16 = mkdtempSync("/tmp/r1a16-registry-");
afterAll(() => rmSync(BOX16, { recursive: true, force: true }));
function ownerHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(BOX16, "home-"));
  const owner = join(home, "harnesses");
  mkdirSync(owner);
  chmodSync(owner, 0o700);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(owner, name), text, { mode: 0o600 });
  return home;
}

describe("parseEngineId — strict known-id parsing", () => {
  it("accepts every known id, case-insensitively", () => {
    for (const id of KNOWN_ENGINE_IDS) {
      expect(parseEngineId(id.toUpperCase())).toBe(id);
    }
  });
  it("rejects an unknown id with UnknownEngineError", () => {
    expect(() => parseEngineId("grok")).toThrow(UnknownEngineError);
  });
});

describe("buildEnabledEngines — no agent on by default, explicit opt-in only", () => {
  it("unset and blank enable nothing", () => {
    programsOnPath(true);
    expect([...buildEnabledEngines(undefined)]).toEqual([]);
    expect([...buildEnabledEngines("   ")]).toEqual([]);
    expect([...enabledEngineIds(undefined)]).toEqual([]);
    expect([...enabledEngineIds("")]).toEqual([]);
  });
  it("adds only the listed engines, any delimiter", () => {
    expect([...buildEnabledEngines("codex:shell")].sort()).toEqual(["codex", "shell"]);
    expect([...buildEnabledEngines("claude, shell:hermes")].sort()).toEqual(["claude", "hermes", "shell"]);
  });
  it("throws UnknownEngineError for a garbage entry", () => {
    expect(() => buildEnabledEngines("codex:not-a-real-engine")).toThrow(UnknownEngineError);
  });
});

describe("resolveEngine — order: engine given -> known -> enabled -> program found", () => {
  it("no engine (undefined or blank) throws `engine is required` naming the enabled agents", async () => {
    programsOnPath(true);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    for (const raw of [undefined, "", "  "]) {
      await expect(resolveEngine(raw)).rejects.toThrow(UnknownEngineError);
      await expect(resolveEngine(raw)).rejects.toThrow("engine is required. Enabled: none");
    }
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "shell,codex");
    await expect(resolveEngine(undefined)).rejects.toThrow("engine is required. Enabled: codex, shell");
    await expect(resolveEngine("", { enabledEngines: new Set(["shell", "claude"]) })).rejects.toThrow(
      "engine is required. Enabled: claude, shell",
    );
  });

  it("throws UnknownEngineError for a garbage id", async () => {
    await expect(resolveEngine("not-a-real-engine")).rejects.toThrow(UnknownEngineError);
  });

  it("throws EngineDisabledError for a known id not enabled, before the program check", async () => {
    programsOnPath(false);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    for (const id of KNOWN_ENGINE_IDS) {
      await expect(resolveEngine(id)).rejects.toThrow(EngineDisabledError);
    }
    await expect(resolveEngine("codex", { enabledEngines: new Set(["claude"]) })).rejects.toThrow(EngineDisabledError);
  });

  it("claude enabled with no claude on PATH is EngineUnavailableError naming the program", async () => {
    programsOnPath(false);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "claude");
    await expect(resolveEngine("claude")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("claude")).rejects.toThrow(/program "claude" was not found/);
  });

  it("claude, codex and shell each resolve to their built-in file with a fake program first on PATH", async () => {
    programsOnPath(true);
    const program: Record<string, string> = { claude: "claude", codex: "codex", shell: "sh" };
    for (const id of ["claude", "codex", "shell"]) {
      const r = await resolveEngine(id, { enabledEngines: new Set([id]) });
      expect(r.id).toBe(id);
      expect(r.harness?.source).toBe("builtin");
      expect(r.harness?.file).toBe(join(BUILTIN, `${id}.toml`));
      expect(r.harness?.programPath).toBe(join(BIN, program[id]!));
      expect(r).not.toHaveProperty("descriptor");
    }
  });

  // U-R1A-16: hermes runs from its built-in adapter file: no program, no PATH lookup.
  it("hermes resolves to its built-in adapter file with PATH an empty folder", async () => {
    programsOnPath(false);
    vi.stubEnv("PATH", EMPTY_BIN);
    resetHarnessCache();
    const r = await resolveEngine("hermes", { enabledEngines: new Set(["hermes"]) });
    expect(r.id).toBe("hermes");
    expect(r.harness).toMatchObject({ name: "hermes", source: "builtin", file: join(BUILTIN, "hermes.toml"), adapter: "hermes", kind: "agent" });
    expect(r.harness).not.toHaveProperty("programPath");
  });

  it("an owner hermes.toml is refused at load with its stderr line, and the built-in stays", async () => {
    const home = ownerHome({ "hermes.toml": 'name = "hermes"\nprogram = "/bin/sh"\nhas_prompts = false\n' });
    programsOnPath(true, home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    expect(loadedHarnesses().get("hermes")).toMatchObject({ source: "builtin", file: join(BUILTIN, "hermes.toml") });
    expect(stderr.mock.calls.map((c) => String(c[0]))).toContainEqual(
      `[bridge] harness file refused: ${join(home, "harnesses", "hermes.toml")}: built-in name: an owner file cannot replace a built-in\n`,
    );
    expect((await resolveEngine("hermes", { enabledEngines: new Set(["hermes"]) })).harness?.source).toBe("builtin");
  });

  it("an unknown name in TANDEM_ENABLED_ENGINES fails closed, naming every built-in and loaded name once", async () => {
    const home = ownerHome({ "r1a16-owner.toml": 'name = "r1a16-owner"\nprogram = "r1a16-owner"\nhas_prompts = false\n' });
    programsOnPath(true, home);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "claude,nosuch");
    const names = [...new Set([...KNOWN_ENGINE_IDS, ...loadedHarnesses().keys()])].sort();
    expect(names).toContain("r1a16-owner");
    const e = await resolveEngine("claude").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnknownEngineError);
    expect((e as Error).message).toBe(`unknown engine: "nosuch". Supported engines: ${names.join(", ")}.`);
  });
});

// U-R1A-16: a built-in id whose built-in file is not loaded is unavailable (503), for an open and
// for a relay start alike. The registry and the router are imported again over a loader that
// drops claude's file.
describe("a built-in id with no harness file loaded", () => {
  afterEach(() => {
    vi.doUnmock("../bridge/harness-registry.ts");
    vi.resetModules();
  });

  it("resolveEngine throws EngineUnavailableError; open and relay start answer 503", async () => {
    const work = mkdtempSync(join(BOX16, "work-"));
    programsOnPath(true);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "claude");
    vi.stubEnv("CCM_CWD_ALLOWLIST", work);
    vi.resetModules();
    vi.doMock("../bridge/harness-registry.ts", async (importOriginal) => {
      const real = await importOriginal<typeof import("../bridge/harness-registry.ts")>();
      return {
        ...real,
        loadHarnesses: (opts?: Parameters<typeof real.loadHarnesses>[0]) => {
          const res = real.loadHarnesses(opts);
          res.harnesses.delete("claude");
          return res;
        },
      };
    });
    const registry = await import("../bridge/engine-registry.ts");
    const e = await registry.resolveEngine("claude").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(registry.EngineUnavailableError);
    expect((e as Error).message).toContain("has no harness file loaded");
    const { routeForTest } = await import("../bridge/router.ts");
    const open = await routeForTest("POST", "/sessions/open", { engine: "claude" });
    expect(open.status).toBe(503);
    const relay = await routeForTest("POST", "/relay/start", { goal: "x", cwd: work });
    expect(relay.status).toBe(503);
  });
});

describe("capabilityReport", () => {
  it("available = the built-in file's programPath is set; hermes true; disabled false", async () => {
    programsOnPath(true);
    const all = new Set(["claude", "codex", "shell", "hermes"]);
    expect(await capabilityReport({ enabledEngines: all })).toEqual([
      { engine: "claude", enabled: true, available: true },
      { engine: "codex", enabled: true, available: true },
      { engine: "shell", enabled: true, available: true },
      { engine: "hermes", enabled: true, available: true },
    ]);
    programsOnPath(false);
    // /usr/bin or /bin may still hold a sh; claude and codex are never there.
    const missing = Object.fromEntries((await capabilityReport({ enabledEngines: all })).map((r) => [r.engine, r.available]));
    expect(missing.claude).toBe(false);
    expect(missing.codex).toBe(false);
    expect(missing.hermes).toBe(true);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    expect(await capabilityReport()).toEqual(KNOWN_ENGINE_IDS.map((engine) => ({ engine, enabled: false, available: false })));
  });
});
