/**
 * U-R1A-11 live conformance: the real, signed-in Claude Code runs from its built-in harness file
 * (harnesses/claude.toml) through HarnessSession, on mini. Opt-in with TANDEM_LIVE=1; skipped in
 * the full suite.
 *
 * Run (real HOME, only so the signed-in `claude` works; a private tmux socket):
 *   T=$(mktemp -d /tmp/r1a11.XXXXXX); env -u TMUX TMUX_TMPDIR="$T" TANDEM_HOME="$T/tandem" TANDEM_LIVE=1 \
 *     npx vitest run test/conformance/claude.live.test.ts --reporter=verbose
 *   then: test -S "$T/tandem/tmux/tandem" && tmux -S "$T/tandem/tmux/tandem" kill-server (Tandem's own socket, U-R1A-19)
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load (Claude's own trust entry and history under ~/.claude are expected). No
 * sign-in, no bypass, no account or settings change, never `claude -p`. Only Tandem's warmup
 * answers Claude's trust prompt for the new folder.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";

const LIVE = process.env.TANDEM_LIVE === "1";
const BOX = LIVE ? mkdtempSync("/tmp/r1a11-live-") : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a11-live-${randomBytes(3).toString("hex")}`;

// The bridge modules read HOME (transcripts) and TANDEM_WAIT_MS once, when they load. A 1 ms send
// cap hands control back right after Enter, so the reads below see the turn from its start.
const REAL_HOME = homedir();
let mods: {
  loadHarnesses: typeof import("../../bridge/harness-registry.ts").loadHarnesses;
  HarnessSession: typeof import("../../bridge/engines/harness-engine.ts").HarnessSession;
  TerminalSession: typeof import("../../bridge/terminal-session.ts").TerminalSession;
};
if (LIVE) {
  mkdirSync(WORK);
  process.env.TANDEM_WAIT_MS = "1";
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
  // The child claude must not join the Claude Code session that runs this test.
  for (const k of Object.keys(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") delete process.env[k];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) =>
  s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>");

describe.skipIf(!LIVE)("claude live: the built-in harness file through HarnessSession (U-R1A-11)", () => {
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a11 live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  /** Reads until agentState is `state` (or the time is up); returns the text read on the way. */
  async function readUntil(state: string, ms: number, cursor: number): Promise<{ text: string; cursor: number; agentState?: string }> {
    const deadline = Date.now() + ms;
    let text = "";
    let last: { agentState?: string } = {};
    while (Date.now() < deadline) {
      const page = await session.read({ cursor });
      text += page.text;
      cursor = page.cursor;
      last = page;
      if (page.agentState === state) return { text, cursor, agentState: page.agentState };
      await sleep(250);
    }
    throw new Error(`${NAME}: agentState never became ${state} in ${ms} ms; last ${last.agentState}`);
  }

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
  });

  afterAll(async () => {
    if (session && (await session.isAlive())) await session.close();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in claude file spawns and reaches its prompt (ready)", () =>
    step(async () => {
      const claude = mods.loadHarnesses().harnesses.get("claude");
      expect(claude?.source).toBe("builtin");
      session = await mods.HarnessSession.spawn(
        claude!,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)], allowBypass: false, dialogAnswers: "safe" },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a11-live-owner" })),
      );
      expect(session.engine).toBe("claude");
      expect(session.readinessWarning).toBeUndefined();
      expect(session.ready).toBe(true);
    }), 60_000);

  it("send: an exact-reply prompt, read until idle with the token in the text", () =>
    step(async () => {
      const token = `TANDEM-OK-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
      const sent = await session.send(`Reply with exactly ${token} and nothing else.`);
      const page = await readUntil("idle", 120_000, sent.cursor);
      expect(sent.report + page.text).toContain(token);
      // The reply itself, not only the echoed prompt.
      const lines: string[] = (await terminal.screen()).split("\n");
      expect(lines.some((l) => l.includes(token) && !l.includes("Reply with"))).toBe(true);
    }), 150_000);

  // Claude 2.1.321 shows its spinner (a working rule) while it thinks, but no marker at all while it
  // streams text, so the task asks it to think first and the read starts right after Enter.
  it("interrupt: a long counting task reads working, then idle within 30 s of interrupt()", () =>
    step(async () => {
      const sent = await session.send("Think it over first, then count from 1 to 3000, one number per line, with no other text.");
      const working = await readUntil("working", 60_000, sent.cursor);
      await session.interrupt();
      await readUntil("idle", 30_000, working.cursor);
      // Stopped, not finished (Claude removes a turn interrupted before any output).
      expect(await terminal.screen()).not.toMatch(/^\s*3000\s*$/m);
    }), 120_000);

  it("close: the session ends", () =>
    step(async () => {
      await session.close();
      expect(await session.isAlive()).toBe(false);
    }), 30_000);
});
