/**
 * U-R1B-GEMINI live conformance: the real, signed-in Gemini CLI runs from its built-in harness
 * file (harnesses/gemini.toml) through HarnessSession, on mini. Opt-in with TANDEM_LIVE=1; skipped
 * in the full suite.
 *
 * Run (real HOME, only so a signed-in `gemini` works; Tandem's own tmux socket under TANDEM_HOME):
 *   T=$(mktemp -d /tmp/r1bgem-live.XXXXXX); env -u TMUX TMUX_TMPDIR="$T" TANDEM_HOME="$T/tandem" \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/gemini.live.test.ts --reporter=verbose
 *   then: test -S "$T/tandem/tmux/tandem" && tmux -S "$T/tandem/tmux/tandem" kill-server; rm -rf "$T"
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load. Gemini writes its own session file under ~/.gemini/tmp during a signed-in
 * run (gemini's data; Tandem never edits it). No sign-in, no account or settings change; nothing
 * here answers a gemini prompt: every send waits for an idle screen (a sign-in, trust, model or
 * update menu never reads idle), so a menu fails the step instead of taking the typed text and
 * Enter. The work folder is a fresh temporary folder with no project files.
 *
 * Sign-in check: gemini's own first screen, read before anything is typed. Signed out it shows
 * `How would you like to authenticate` (and `Failed to sign in` when Google refuses the client);
 * the start step then closes the session, sends no key (Enter there would start a Google sign-in)
 * and throws NEEDS MAX; the other steps fail fast with the same message. Nothing under ~/.gemini is
 * read by this file.
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
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "r1bgem-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1bgem-live-${randomBytes(3).toString("hex")}`;
const SIGNED_OUT = /How would you like to authenticate|Failed to sign in/;
const NOT_SIGNED_IN = "gemini is not signed in on this computer: NEEDS MAX";

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

describe.skipIf(!LIVE)("gemini live: the built-in harness file through HarnessSession (U-R1B-GEMINI)", () => {
  let gemini: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;
  let signedOut = false;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    if (signedOut) throw new Error(NOT_SIGNED_IN);
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen().catch(() => "(session closed)") : "(no session)";
      console.log(`r1bgem live: last screen of ${NAME}:\n${redact(shown)}`);
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
    if (readScreen(gemini, await terminal.screen()) !== "idle") throw new Error(`${NAME}: screen left idle; not typing`);
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

  it("start: the built-in gemini file spawns, signed in, and reaches its prompt (ready)", () =>
    step(async () => {
      gemini = mods.loadHarnesses().harnesses.get("gemini")!;
      expect(gemini?.source).toBe("builtin");
      expect(gemini?.programPath).toBeDefined();
      session = await mods.HarnessSession.spawn(
        gemini,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)] },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bgem-live-owner" })),
      );
      // The first screen, before anything is typed.
      const first = await terminal.screen();
      if (SIGNED_OUT.test(first)) {
        signedOut = true;
        await session.close();
        throw new Error(NOT_SIGNED_IN);
      }
      expect(session.engine).toBe("gemini");
      expect(session.readinessWarning).toBeUndefined();
      expect(session.ready).toBe(true);
    }), 90_000);

  it("exact reply: a token prompt with no command, read until idle with the token in the text", () =>
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
