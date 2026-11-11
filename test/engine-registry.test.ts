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

  it("hermes resolves with no harness (its code path until U-R1A-16)", async () => {
    programsOnPath(false);
    const r = await resolveEngine("hermes", { enabledEngines: new Set(["hermes"]) });
    expect(r).toEqual({ id: "hermes" });
  });

  it("an owner file named like a built-in id is skipped with its stderr line", async () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "hermes.toml"), 'name = "hermes"\nprogram = "/bin/sh"\nhas_prompts = false\n', { mode: 0o600 });
    programsOnPath(true, home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    expect(loadedHarnesses().has("hermes")).toBe(false);
    expect(stderr.mock.calls.map((c) => String(c[0]))).toContainEqual(
      `[bridge] harness file skipped: ${join(owner, "hermes.toml")}: "hermes" keeps its built-in engine\n`,
    );
    expect(await resolveEngine("hermes", { enabledEngines: new Set(["hermes"]) })).toEqual({ id: "hermes" });
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
