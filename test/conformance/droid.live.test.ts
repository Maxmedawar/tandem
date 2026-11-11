/**
 * U-R1B-DROID live conformance: the real, signed-in Factory Droid CLI (program `droid`) runs from
 * its built-in harness file (harnesses/droid.toml) through HarnessSession, on mini. Opt-in with
 * TANDEM_LIVE=1; skipped in the full suite.
 *
 * Run (real HOME, only so a signed-in `droid` works; Tandem's own tmux socket under TANDEM_HOME):
 *   T=$(mktemp -d /tmp/r1bdrd-live.XXXXXX); env -u TMUX TMUX_TMPDIR="$T" TANDEM_HOME="$T/tandem" \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/droid.live.test.ts --reporter=verbose
 *   then: test -S "$T/tandem/tmux/tandem" && tmux -S "$T/tandem/tmux/tandem" kill-server; rm -rf "$T"
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load. Droid writes its own session files under ~/.factory/sessions during a
 * signed-in run (Droid's data; Tandem never edits it). No sign-in, no account or settings change;
 * nothing here answers a Droid prompt: every send waits for an idle screen (a sign-in, trust,
 * extension, model or update menu never reads idle), so a menu fails the step instead of taking
 * the typed text and Enter. The work folder is a fresh temporary folder with no project files.
 *
 * Sign-in, trust and first-run menus: Droid's own first screens, read before anything is typed.
 * A folder not yet trusted shows `Trust this folder?`; signed out it shows `Welcome to Factory
 * CLI` with `Login with Factory account` / `Continue with API key`; a first run may offer the
 * VSCode extension. Each way the start step closes the session, sends no key and throws; the
 * other steps fail fast with the same message. Nothing under ~/.factory is read by this file.
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
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "r1bdrd-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1bdrd-live-${randomBytes(3).toString("hex")}`;
const STOPS: [RegExp, string][] = [
  [/Trust this folder\?/, "droid asks to trust the work folder: needs a SCHEMA dialog form for its menu"],
  [/Welcome to Factory CLI|Login with Factory account|Continue with API key/, "droid is not signed in on this computer: NEEDS MAX"],
  [/Would you like to install the Factory VSCode extension\?/, "droid shows a first-run extension menu: NEEDS MAX"],
];
// How long the start step watches the first screens for a sign-in, trust or extension menu.
const FIRST_SCREENS_MS = 5_000;

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

describe.skipIf(!LIVE)("droid live: the built-in harness file through HarnessSession (U-R1B-DROID)", () => {
  let droid: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;
  let stopped: string | undefined;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    if (stopped) throw new Error(stopped);
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen().catch(() => "(session closed)") : "(no session)";
      console.log(`r1bdrd live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  /** Reads until agentState is `state` (or the time is up); returns the text read on the way. */
  async function readUntil(state: string, ms: number, cursorAt: number): Promise<{ text: string; cursor: number }> {
    const deadline = Date.now() + ms;
    let text = "";
    let at = cursorAt;
    let last: { agentState?: string } = {};
    while (Date.now() < deadline) {
      const page = await session.read({ cursor: at });
      text += page.text;
      at = page.cursor;
      last = page;
      if (page.agentState === state) return { text, cursor: at };
      await sleep(250);
    }
    throw new Error(`${NAME}: agentState never became ${state} in ${ms} ms; last ${last.agentState}`);
  }

  /** Types only once the screen has read idle (debounced) and still reads idle right before typing. */
  async function sendWhenIdle(text: string) {
    await readUntil("idle", 30_000, 0);
    if (readScreen(droid, await terminal.screen()) !== "idle") throw new Error(`${NAME}: screen left idle; not typing`);
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

  it("start: the built-in droid file spawns, signed in, and reaches its prompt (ready)", () =>
    step(async () => {
      droid = mods.loadHarnesses().harnesses.get("droid")!;
      expect(droid?.source).toBe("builtin");
      expect(droid?.programPath).toBeDefined();
      session = await mods.HarnessSession.spawn(
        droid,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)] },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bdrd-live-owner" })),
      );
      // The first screens, before anything is typed: a sign-in, trust or extension menu stops the run here.
      const deadline = Date.now() + FIRST_SCREENS_MS;
      do {
        const shown = await terminal.screen();
        const hit = STOPS.find(([re]) => re.test(shown));
        if (hit) {
          console.log(`r1bdrd live: first screen of ${NAME}:\n${redact(shown)}`);
          stopped = hit[1];
          await session.close();
          throw new Error(stopped);
        }
        if (readScreen(droid, shown) === "idle") break;
        await sleep(250);
      } while (Date.now() < deadline);
      expect(session.engine).toBe("droid");
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
