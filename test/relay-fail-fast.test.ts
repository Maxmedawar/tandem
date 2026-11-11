import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay, RelayConfigError } from "../bridge/relay.ts";
import { TerminalSession, type SpawnOptions } from "../bridge/terminal-session.ts";
import { loadHarnesses } from "../bridge/harness-registry.ts";

// Runs before the imports above load: the relay folder is under a temporary HOME, never the real one.
const testHome = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const saved = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "r1a12-relay-home-"));
  process.env.HOME = home;
  return { home, saved };
});
afterAll(() => {
  process.env.HOME = testHome.saved;
  rmSync(testHome.home, { recursive: true, force: true });
});

// The relay is NO-HUMAN-IN-THE-LOOP: if Claude ever raises an in-session
// permission prompt, nobody is there to click through it and the loop hangs
// forever. startRelay() must refuse to start — synchronously, before spawning
// any tmux session — unless bypass is explicitly enabled. This is deliberately
// testable WITHOUT tmux/claude: the guard runs before any TerminalSession.spawn.
describe("startRelay — fail-fast bypass guard", () => {
  const prev = process.env.TANDEM_ALLOW_BYPASS;
  afterEach(() => {
    if (prev === undefined) delete process.env.TANDEM_ALLOW_BYPASS;
    else process.env.TANDEM_ALLOW_BYPASS = prev;
  });

  it("rejects with a RelayConfigError when bypass is not enabled (unset)", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
      RelayConfigError,
    );
  });

  it("the error message is a clear, actionable configuration error", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
      /TANDEM_ALLOW_BYPASS=1/,
    );
  });

  it("rejects when the legacy TANDEM_SKIP_PERMISSIONS variable is set instead", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    const prevSkip = process.env.TANDEM_SKIP_PERMISSIONS;
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    try {
      await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
        RelayConfigError,
      );
    } finally {
      if (prevSkip === undefined) delete process.env.TANDEM_SKIP_PERMISSIONS;
      else process.env.TANDEM_SKIP_PERMISSIONS = prevSkip;
    }
  });

  it("rejects with values other than exactly '1'", async () => {
    for (const v of ["true", "yes", "0", ""]) {
      process.env.TANDEM_ALLOW_BYPASS = v;
      await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
        RelayConfigError,
      );
    }
  });

  it("with bypass allowed, the lead spawns from the built-in claude file: descriptor id claude and that file's argv", async () => {
    process.env.TANDEM_ALLOW_BYPASS = "1";
    const seen: SpawnOptions[] = [];
    const spy = vi.spyOn(TerminalSession, "spawn").mockImplementation(async (o: SpawnOptions) => {
      seen.push(o);
      throw new Error("r1a12: no tmux in this test");
    });
    try {
      await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(/no tmux in this test/);
    } finally {
      spy.mockRestore();
    }
    const builtin = fileURLToPath(new URL("../harnesses/", import.meta.url));
    const claude = loadHarnesses({ installDir: builtin, ownerDir: join(testHome.home, "no-owner") }).harnesses.get("claude")!;
    expect(claude.source).toBe("builtin");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toMatch(/^relay-[0-9a-f]{8}-lead$/);
    expect(seen[0]!.allowBypass).toBe(true);
    expect(seen[0]!.descriptor?.id).toBe("claude");
    expect(seen[0]!.descriptor?.argv).toEqual(["/usr/bin/env", "--", claude.programPath ?? "claude"]);
  });
});
