import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEngineId,
  buildEnabledEngines,
  resolveEngine,
  capabilityReport,
  resetHarnessCache,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
  KNOWN_ENGINE_IDS,
} from "../bridge/engine-registry.ts";

// codex runs from its built-in harness file: its presence is the file's programPath, found on PATH.
const tmp = mkdtempSync(join(tmpdir(), "r1a12-registry-"));
const CODEX_BIN = join(tmp, "bin");
mkdirSync(CODEX_BIN);
writeFileSync(join(CODEX_BIN, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
/** PATH holds a fake `codex` (never run) or nothing; no owner harness files. */
function codexOnPath(present: boolean): void {
  vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
  vi.stubEnv("PATH", present ? CODEX_BIN : join(tmp, "no-such-bin"));
  resetHarnessCache();
}
afterEach(() => {
  vi.unstubAllEnvs();
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

describe("buildEnabledEngines — claude-only default, explicit opt-in for others", () => {
  it("unset/blank enables only claude", () => {
    expect([...buildEnabledEngines(undefined)]).toEqual(["claude"]);
    expect([...buildEnabledEngines("   ")]).toEqual(["claude"]);
  });
  it("adds explicitly listed engines", () => {
    const enabled = buildEnabledEngines("codex:shell");
    expect(enabled.has("claude")).toBe(true);
    expect(enabled.has("codex")).toBe(true);
    expect(enabled.has("shell")).toBe(true);
    expect(enabled.has("hermes")).toBe(false);
  });
  it("accepts comma-separated and mixed delimiters", () => {
    expect([...buildEnabledEngines("codex, shell:hermes")].sort()).toEqual([
      "claude",
      "codex",
      "hermes",
      "shell",
    ]);
  });
  it("throws UnknownEngineError for a garbage entry", () => {
    expect(() => buildEnabledEngines("codex:not-a-real-engine")).toThrow(UnknownEngineError);
  });
});

describe("resolveEngine — order: parse -> enabled -> executable-available", () => {
  it("defaults to claude when no id is given", async () => {
    const resolution = await resolveEngine(undefined, { enabledEngines: new Set(["claude"]) });
    expect(resolution.id).toBe("claude");
    expect(resolution.harness?.name).toBe("claude");
  });

  it("claude is EXEMPT from the executable-presence check (no regression from Phase 1, no subprocess on the hot path)", async () => {
    let called = false;
    const resolution = await resolveEngine("claude", {
      enabledEngines: new Set(["claude"]),
      detectExecutable: async () => {
        called = true;
        return false; // even a detector that says "missing" must not block claude
      },
    });
    expect(resolution.id).toBe("claude");
    expect(called).toBe(false);
  });

  it("throws UnknownEngineError for a garbage id", async () => {
    await expect(resolveEngine("not-a-real-engine")).rejects.toThrow(UnknownEngineError);
  });

  it("throws EngineDisabledError for a known id not in the enabled set", async () => {
    await expect(
      resolveEngine("codex", { enabledEngines: new Set(["claude"]) }),
    ).rejects.toThrow(EngineDisabledError);
  });

  it("throws EngineUnavailableError when enabled but no codex is on PATH", async () => {
    codexOnPath(false);
    await expect(
      resolveEngine("codex", {
        enabledEngines: new Set(["claude", "codex"]),
      }),
    ).rejects.toThrow(EngineUnavailableError);
  });

  it("succeeds when enabled and a codex is on PATH: the built-in codex harness file", async () => {
    codexOnPath(true);
    const resolution = await resolveEngine("codex", {
      enabledEngines: new Set(["claude", "codex"]),
    });
    expect(resolution.id).toBe("codex");
    expect(resolution.harness?.name).toBe("codex");
    expect(resolution.harness?.programPath).toBe(join(CODEX_BIN, "codex"));
  });

  it("shell needs no executable check (no fixed binary) even with a detector that always fails", async () => {
    const resolution = await resolveEngine("shell", {
      enabledEngines: new Set(["claude", "shell"]),
      detectExecutable: async () => false,
    });
    expect(resolution.id).toBe("shell");
  });

  it("hermes has no tmux descriptor and needs no executable check", async () => {
    const resolution = await resolveEngine("hermes", {
      enabledEngines: new Set(["claude", "hermes"]),
      detectExecutable: async () => false,
    });
    expect(resolution.id).toBe("hermes");
    expect(resolution.descriptor).toBeUndefined();
  });

  it("never calls the detector for a disabled engine (enablement checked first)", async () => {
    let called = false;
    await expect(
      resolveEngine("codex", {
        enabledEngines: new Set(["claude"]),
        detectExecutable: async () => {
          called = true;
          return true;
        },
      }),
    ).rejects.toThrow(EngineDisabledError);
    expect(called).toBe(false);
  });
});

describe("capabilityReport", () => {
  it("reports every known engine with enabled/available flags (codex: its file's programPath)", async () => {
    codexOnPath(true);
    const report = await capabilityReport({
      enabledEngines: new Set(["claude", "codex"]),
    });
    const byEngine = Object.fromEntries(report.map((r) => [r.engine, r]));
    expect(byEngine.claude).toEqual({ engine: "claude", enabled: true, available: true });
    expect(byEngine.codex).toEqual({ engine: "codex", enabled: true, available: true });
    expect(byEngine.shell).toEqual({ engine: "shell", enabled: false, available: false });
    expect(byEngine.hermes).toEqual({ engine: "hermes", enabled: false, available: false });
    codexOnPath(false);
    const missing = await capabilityReport({ enabledEngines: new Set(["claude", "codex"]) });
    expect(missing.find((r) => r.engine === "codex")).toEqual({ engine: "codex", enabled: true, available: false });
  });

  it("shell is available when enabled regardless of the detector", async () => {
    const report = await capabilityReport({
      enabledEngines: new Set(["claude", "shell"]),
      detectExecutable: async () => false,
    });
    const shell = report.find((r) => r.engine === "shell");
    expect(shell).toEqual({ engine: "shell", enabled: true, available: true });
  });
});
