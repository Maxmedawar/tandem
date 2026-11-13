import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateModel,
  validateEffort,
  bypassPermissionsEnabled,
  warnLegacySkipPermissionsIfSet,
  spawnArgv,
  EFFORT_LEVELS,
  MODEL_ALIASES,
} from "../bridge/terminal-session.ts";
import { CLAUDE_DESCRIPTOR } from "../bridge/drivable.ts";
import { loadHarnesses } from "../bridge/harness-registry.ts";
import { HarnessSession, harnessDescriptor } from "../bridge/engines/harness-engine.ts";

// vi.spyOn(process.stderr, "write") does not reliably intercept writes made
// from an imported module in this vitest pool config, so capture manually.
function captureStderr(run: () => void): string[] {
  const orig = process.stderr.write.bind(process.stderr);
  const calls: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    calls.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = orig;
  }
  return calls;
}

describe("validateModel", () => {
  it("accepts every documented alias (case-insensitive, normalized)", () => {
    for (const a of MODEL_ALIASES) expect(validateModel(a.toUpperCase())).toBe(a);
  });
  it("accepts a full claude-* id including the [1m] variant", () => {
    expect(validateModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(validateModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
  });
  it("rejects unsupported values with a clear error (never silent)", () => {
    expect(() => validateModel("gpt-4")).toThrow(/unsupported model/);
    expect(() => validateModel("")).toThrow();
  });
});

describe("validateEffort", () => {
  it("accepts every documented level", () => {
    for (const e of EFFORT_LEVELS) expect(validateEffort(e)).toBe(e);
  });
  it("rejects unsupported values with a clear error", () => {
    expect(() => validateEffort("turbo")).toThrow(/unsupported effort/);
  });
});

describe("bypassPermissionsEnabled (default OFF, opt-in only)", () => {
  const prevAllow = process.env.TANDEM_ALLOW_BYPASS;
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.TANDEM_ALLOW_BYPASS;
    else process.env.TANDEM_ALLOW_BYPASS = prevAllow;
  });
  it("defaults to false when unset", () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    expect(bypassPermissionsEnabled()).toBe(false);
  });
  it("is enabled ONLY by exactly '1'", () => {
    process.env.TANDEM_ALLOW_BYPASS = "1";
    expect(bypassPermissionsEnabled()).toBe(true);
    for (const v of ["true", "yes", "on", "TRUE", "0", "2", " 1 ", ""]) {
      process.env.TANDEM_ALLOW_BYPASS = v;
      // " 1 " is trimmed then compared, so it DOES enable — assert precisely.
      expect(bypassPermissionsEnabled()).toBe(v.trim() === "1");
    }
  });
});

describe("warnLegacySkipPermissionsIfSet (TANDEM_SKIP_PERMISSIONS is ignored)", () => {
  const prevSkip = process.env.TANDEM_SKIP_PERMISSIONS;
  afterEach(() => {
    if (prevSkip === undefined) delete process.env.TANDEM_SKIP_PERMISSIONS;
    else process.env.TANDEM_SKIP_PERMISSIONS = prevSkip;
  });
  it("warns to stderr when the legacy variable is set, regardless of value", () => {
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    const calls = captureStderr(() => warnLegacySkipPermissionsIfSet());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("TANDEM_SKIP_PERMISSIONS is ignored");
    expect(calls[0]).toContain("TANDEM_ALLOW_BYPASS=1");
  });
  it("does not warn, and does not enable bypass, when unset", () => {
    delete process.env.TANDEM_SKIP_PERMISSIONS;
    const calls = captureStderr(() => warnLegacySkipPermissionsIfSet());
    expect(calls).toHaveLength(0);
  });
  it("setting the legacy variable alone does NOT enable bypass", () => {
    const prevAllow = process.env.TANDEM_ALLOW_BYPASS;
    delete process.env.TANDEM_ALLOW_BYPASS;
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    expect(bypassPermissionsEnabled()).toBe(false);
    if (prevAllow === undefined) delete process.env.TANDEM_ALLOW_BYPASS;
    else process.env.TANDEM_ALLOW_BYPASS = prevAllow;
  });
});

describe("the legacy TANDEM_SKIP_PERMISSIONS warning prints once per spawn (U-R1A-12)", () => {
  const BUILTIN = fileURLToPath(new URL("../harnesses/", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "r1a12-controls-"));
  // A stub `claude` in this test's own folder: the cases need the built-in file's descriptor,
  // never the real program (a machine without claude, e.g. the Linux image, runs them too).
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const claude = () => loadHarnesses({ installDir: BUILTIN, ownerDir: join(tmp, "no-owner"), path: bin }).harnesses.get("claude")!;
  const prevSkip = process.env.TANDEM_SKIP_PERMISSIONS;
  afterEach(() => {
    if (prevSkip === undefined) delete process.env.TANDEM_SKIP_PERMISSIONS;
    else process.env.TANDEM_SKIP_PERMISSIONS = prevSkip;
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function captureStderrAsync(run: () => Promise<void>): Promise<string[]> {
    const orig = process.stderr.write.bind(process.stderr);
    const calls: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      calls.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stderr.write = orig;
    }
    return calls;
  }
  const warnings = (calls: string[]) => calls.filter((c) => c.includes("TANDEM_SKIP_PERMISSIONS is ignored"));

  it("spawnArgv for claude writes nothing", () => {
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    expect(captureStderr(() => void spawnArgv(harnessDescriptor(claude()), {}))).toEqual([]);
    expect(captureStderr(() => void spawnArgv(CLAUDE_DESCRIPTOR, {}))).toEqual([]);
  });

  it("HarnessSession.spawn(<built-in claude>) with the default spawn function and a cwd outside its allowlist rejects on the cwd and warns exactly once", async () => {
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    const allowed = join(tmp, "allowed");
    const outside = join(tmp, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const calls = await captureStderrAsync(async () => {
      await expect(
        HarnessSession.spawn(claude(), { name: "r1a12-warn", cwd: outside, allowlist: [allowed] }),
      ).rejects.toThrow(/cwd not allowed/);
    });
    expect(warnings(calls)).toHaveLength(1);
  });
});
