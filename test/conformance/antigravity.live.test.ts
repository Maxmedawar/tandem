/**
 * U-R1A-15 live conformance: the real Antigravity CLI (program `agy`) runs from its built-in
 * harness file (harnesses/antigravity.toml) through HarnessSession, on mini. Opt-in with
 * TANDEM_LIVE=1; skipped in the full suite.
 *
 * Run (real HOME, only so a signed-in `agy` works; a private tmux socket):
 *   mkdir /tmp/r1a15-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a15-live TANDEM_HOME=/tmp/r1a15-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/antigravity.live.test.ts --reporter=verbose
 *   then: test -d /tmp/r1a15-live/tmux-$(id -u) && tmux -S /tmp/r1a15-live/tmux-$(id -u)/default kill-server
 *
 * Scope here is start and capture only: start spawns agy, shows its first screens never read idle
 * (printed redacted, never saved), and close ends it. send and interrupt are todo for U-R1A-15L,
 * which calibrates the ready screen once agy is signed in: the file has no idle rule yet, so a send
 * that waits for a debounced idle read (re-checked right before typing) cannot pass.
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load (agy's own files under ~/.gemini are expected). No sign-in, no bypass, no
 * account or settings change; nothing here types a key into agy. Before anything spawns it looks
 * up the one login item by name (`security find-generic-password -s jetski-standalone-oauth-token`,
 * output discarded, under a 20 s alarm); only the count reaches the test, and 0 throws NEEDS MAX.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
// Under TMUX_TMPDIR (the run folder), so the run cleanup removes it too.
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "r1a15-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a15-live-${randomBytes(3).toString("hex")}`;

/** 1 when the login keychain holds agy's one sign-in item, else 0. The item is never printed. */
const SIGNED_IN =
  "if perl -e 'alarm 20; exec @ARGV' /usr/bin/security find-generic-password -s jetski-standalone-oauth-token >/dev/null 2>&1; then echo 1; else echo 0; fi";

// The bridge modules read HOME (transcripts) once, when they load.
const REAL_HOME = homedir();
let mods: {
  loadHarnesses: typeof import("../../bridge/harness-registry.ts").loadHarnesses;
  HarnessSession: typeof import("../../bridge/engines/harness-engine.ts").HarnessSession;
  TerminalSession: typeof import("../../bridge/terminal-session.ts").TerminalSession;
};
if (LIVE) {
  mkdirSync(WORK);
  process.env.HOME = join(BOX, "home");
  try {
    const [registry, engine, terminal] = await Promise.all([
      import("../../bridge/harness-registry.ts"),
      import("../../bridge/engines/harness-engine.ts"),
      import("../../bridge/terminal-session.ts"),
    ]);
    mods = { loadHarnesses: registry.loadHarnesses, HarnessSession: engine.HarnessSession, TerminalSession: terminal.TerminalSession };
  } finally {
    process.env.HOME = REAL_HOME;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) =>
  s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>");

describe.skipIf(!LIVE)("antigravity live: the built-in harness file through HarnessSession (U-R1A-15)", () => {
  let agy: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a15 live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
  });

  afterAll(async () => {
    if (session && (await session.isAlive())) await session.close();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in antigravity file spawns ready and its first screens never read idle", () =>
    step(async () => {
      const count = Number(spawnSync("/bin/sh", ["-c", SIGNED_IN], { encoding: "utf8", env: { ...process.env, HOME: REAL_HOME } }).stdout.trim());
      if (!(count > 0)) throw new Error("antigravity is not signed in on this computer: NEEDS MAX");
      agy = mods.loadHarnesses().harnesses.get("antigravity")!;
      expect(agy?.source).toBe("builtin");
      expect(agy?.programPath).toBeDefined();
      session = await mods.HarnessSession.spawn(
        agy,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)] },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a15-live-owner" })),
      );
      expect(session.engine).toBe("antigravity");
      expect(session.readinessWarning).toBeUndefined();
      expect(session.ready).toBe(true);
      for (let i = 1; i <= 3; i++) {
        const screen = await terminal.screen();
        console.log(`r1a15 live: first screen ${i} of ${NAME}:\n${redact(screen)}`);
        expect(readScreen(agy, screen)).not.toBe("idle");
        expect((await session.read({ cursor: 0 })).agentState).not.toBe("idle");
        await sleep(1000);
      }
    }), 90_000);

  it.todo("U-R1A-15L: send: an exact-reply prompt, read until idle with the token in the text");

  it.todo("U-R1A-15L: interrupt: a long counting task reads working, then idle within 30 s of interrupt(); the session stays alive");

  it("close: the session ends", () =>
    step(async () => {
      await session.close();
      expect(await session.isAlive()).toBe(false);
    }), 30_000);
});
