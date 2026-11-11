import { describe, it, expect } from "vitest";
import {
  parseEngineId,
  buildEnabledEngines,
  resolveEngine,
  capabilityReport,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
  KNOWN_ENGINE_IDS,
} from "../bridge/engine-registry.ts";

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

  it("throws EngineUnavailableError when enabled but the executable is missing (injected detector)", async () => {
    await expect(
      resolveEngine("codex", {
        enabledEngines: new Set(["claude", "codex"]),
        detectExecutable: async () => false,
      }),
    ).rejects.toThrow(EngineUnavailableError);
  });

  it("succeeds when enabled and the executable is present (injected detector)", async () => {
    const resolution = await resolveEngine("codex", {
      enabledEngines: new Set(["claude", "codex"]),
      detectExecutable: async () => true,
    });
    expect(resolution.id).toBe("codex");
    expect(resolution.descriptor?.id).toBe("codex");
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
  it("reports every known engine with enabled/available flags", async () => {
    const report = await capabilityReport({
      enabledEngines: new Set(["claude", "codex"]),
      detectExecutable: async (bin) => bin === "codex",
    });
    const byEngine = Object.fromEntries(report.map((r) => [r.engine, r]));
    expect(byEngine.claude).toEqual({ engine: "claude", enabled: true, available: true });
    expect(byEngine.codex).toEqual({ engine: "codex", enabled: true, available: true });
    expect(byEngine.shell).toEqual({ engine: "shell", enabled: false, available: false });
    expect(byEngine.hermes).toEqual({ engine: "hermes", enabled: false, available: false });
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
