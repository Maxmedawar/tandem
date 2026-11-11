/**
 * U-R1A-12 live conformance: the real, signed-in Codex CLI runs from its built-in harness file
 * (harnesses/codex.toml) through HarnessSession, on mini. Opt-in with TANDEM_LIVE=1; skipped in
 * the full suite.
 *
 * Run (real HOME, only so the signed-in `codex` works; a private tmux socket):
 *   mkdir /tmp/r1a12-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a12-live TANDEM_HOME=/tmp/r1a12-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/codex.live.test.ts --reporter=verbose
 *   then: test -d /tmp/r1a12-live/tmux-$(id -u) && tmux -S /tmp/r1a12-live/tmux-$(id -u)/default kill-server
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load (Codex's own files under ~/.codex are expected). No sign-in, no bypass, no
 * account or settings change, never `codex exec`; nothing here answers a Codex prompt: every send
 * waits for an idle screen (an update, trust or approval menu never reads idle), so a menu fails
 * the step instead of taking the typed text and Enter (a first run typed into the update menu).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
// Under TMUX_TMPDIR (the run folder), so the run cleanup removes it too.
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "r1a12-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a12-live-${randomBytes(3).toString("hex")}`;

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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) =>
  s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>");

describe.skipIf(!LIVE)("codex live: the built-in harness file through HarnessSession (U-R1A-12)", () => {
  let codex: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a12 live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  /** Reads until agentState is `state` (or the time is up); returns the text read on the way. */
  async function readUntil(state: string, ms: number, cursor: number): Promise<{ text: string; cursor: number }> {
    const deadline = Date.now() + ms;
    let text = "";
    let last: { agentState?: string } = {};
    while (Date.now() < deadline) {
      const page = await session.read({ cursor });
      text += page.text;
      cursor = page.cursor;
      last = page;
      if (page.agentState === state) return { text, cursor };
      await sleep(250);
    }
    throw new Error(`${NAME}: agentState never became ${state} in ${ms} ms; last ${last.agentState}`);
  }

  /** Types only once the screen has read idle (debounced) and still reads idle right before typing. */
  async function sendWhenIdle(text: string) {
    await readUntil("idle", 30_000, 0);
    if (readScreen(codex, await terminal.screen()) !== "idle") throw new Error(`${NAME}: screen left idle; not typing`);
    return session.send(text);
  }

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
  });

  afterAll(async () => {
    if (session && (await session.isAlive())) await session.close();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in codex file spawns and reaches its prompt (ready)", () =>
    step(async () => {
      codex = mods.loadHarnesses().harnesses.get("codex")!;
      expect(codex?.source).toBe("builtin");
      expect(codex?.programPath).toBeDefined();
      session = await mods.HarnessSession.spawn(
        codex,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)], dialogAnswers: "safe" },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a12-live-owner" })),
      );
      expect(session.engine).toBe("codex");
      expect(session.readinessWarning).toBeUndefined();
      expect(session.ready).toBe(true);
    }), 90_000);

  it("send: an exact-reply prompt, read until idle with the token in the text", () =>
    step(async () => {
      const token = `TANDEM-OK-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
      const sent = await sendWhenIdle(`Reply with exactly ${token} and nothing else. Do not run any command.`);
      const page = await readUntil("idle", 120_000, sent.cursor);
      expect(sent.report + page.text).toContain(token);
      // The reply itself, not only the echoed prompt.
      const lines: string[] = (await terminal.screen()).split("\n");
      expect(lines.some((l) => l.includes(token) && !l.includes("Reply with"))).toBe(true);
    }), 150_000);

  it("interrupt: a long counting task reads working, then idle within 30 s of interrupt(); the session stays alive", () =>
    step(async () => {
      const sent = await sendWhenIdle("Count from 1 to 400, one number per line, without running any command.");
      const working = await readUntil("working", 60_000, sent.cursor);
      await session.interrupt();
      await readUntil("idle", 30_000, working.cursor);
      expect(await session.isAlive()).toBe(true);
    }), 120_000);

  it("close: the session ends", () =>
    step(async () => {
      await session.close();
      expect(await session.isAlive()).toBe(false);
    }), 30_000);
});
