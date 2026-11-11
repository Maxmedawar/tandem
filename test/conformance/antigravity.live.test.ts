/**
 * U-R1A-15 / U-R1A-15L live conformance: the real Antigravity CLI (program `agy`) runs from its
 * built-in harness file (harnesses/antigravity.toml) through HarnessSession, on mini. Opt-in with
 * TANDEM_LIVE=1; skipped in the full suite.
 *
 * Run (real HOME, only so a signed-in `agy` works; a private tmux socket):
 *   mkdir /tmp/r1a15l-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a15l-live TANDEM_HOME=/tmp/r1a15l-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/antigravity.live.test.ts --reporter=verbose
 *   then: test -d /tmp/r1a15l-live/tmux-$(id -u) && tmux -S /tmp/r1a15l-live/tmux-$(id -u)/default kill-server
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load (agy's own files under ~/.gemini are expected). No sign-in, no bypass, no
 * account or settings change; nothing here answers an agy menu: every send waits for an idle
 * screen (a sign-in, trust or update menu never reads idle), so a menu fails the step instead of
 * taking the typed text and Enter.
 *
 * Sign-in check: agy's own first screen. Signed out, agy shows `Select login method:` and waits,
 * and logs `You are not logged into Antigravity.`; when any recorded screen holds either text the
 * start step closes the session, sends no key, and throws NEEDS MAX. Nothing secret is read.
 *
 * Screen recorder: from just before the spawn until close, every 500 ms it captures the pane on the
 * private socket and keeps each distinct screen (trailing whitespace trimmed, home path, email and
 * the account's name redacted) as `<TMUX_TMPDIR>/screens/<nn>-<state the file reads>.txt`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
// agy's changelog: hides the email and plan tier from its header. Set before the first tmux call,
// so the private tmux server (and agy under it) starts with it.
if (LIVE) process.env.AGY_CLI_HIDE_ACCOUNT_INFO = "1";
// Under TMUX_TMPDIR (the run folder), so the run cleanup removes it too.
const RUN = process.env.TMUX_TMPDIR || tmpdir();
const BOX = LIVE ? mkdtempSync(join(RUN, "r1a15-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const SCREENS = join(RUN, "screens");
const SOCK = join(RUN, `tmux-${process.getuid!()}`, "default");
const NAME = `r1a15-live-${randomBytes(3).toString("hex")}`;
const SIGNED_OUT = /Select login method|not logged into Antigravity/;

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
/** The account's display name parts (macOS full name) and login name, never printed. */
const NAMES: string[] = LIVE
  ? [
      ...execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim().split(/\s+/).filter((w) => w.length >= 2),
      userInfo().username,
    ]
  : [];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const redact = (s: string) =>
  NAMES.reduce(
    (out, n) => out.replace(new RegExp(`\\b${escapeRe(n)}\\b`, "gi"), "<USER>"),
    s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>"),
  );

describe.skipIf(!LIVE)("antigravity live: the built-in harness file through HarnessSession (U-R1A-15L)", () => {
  let agy: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();
  /** Raw (unredacted) distinct screens, only for the sign-in check; never written. */
  const raw: string[] = [];

  function record(): void {
    let screen: string;
    try {
      screen = execFileSync("tmux", ["-S", SOCK, "capture-pane", "-p", "-t", `=ccm-${NAME}:`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // before the session exists, or after it ends
    }
    screen = screen
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .trimEnd();
    if (seen.has(screen)) return;
    seen.add(screen);
    raw.push(screen);
    const nn = String(seen.size).padStart(2, "0");
    writeFileSync(join(SCREENS, `${nn}-${readScreen(agy, screen)}.txt`), redact(screen) + "\n");
  }

  function stopRecorder(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  /** On a failed step, the last screen (home path, account email and name redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a15 live: last screen of ${NAME}:\n${redact(shown)}`);
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
    if (readScreen(agy, await terminal.screen()) !== "idle") throw new Error(`${NAME}: screen left idle; not typing`);
    return session.send(text);
  }

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
  });

  afterAll(async () => {
    stopRecorder();
    if (session && (await session.isAlive())) await session.close();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in antigravity file spawns, signed in, and reaches its prompt (ready)", () =>
    step(async () => {
      agy = mods.loadHarnesses().harnesses.get("antigravity")!;
      expect(agy?.source).toBe("builtin");
      expect(agy?.programPath).toBeDefined();
      mkdirSync(SCREENS, { recursive: true });
      timer = setInterval(record, 500);
      session = await mods.HarnessSession.spawn(
        agy,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)] },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a15-live-owner" })),
      );
      record();
      if (raw.some((s) => SIGNED_OUT.test(s))) {
        stopRecorder();
        await session.close();
        throw new Error("antigravity is not signed in on this computer: NEEDS MAX");
      }
      expect(session.engine).toBe("antigravity");
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
      record();
      stopRecorder();
      await session.close();
      expect(await session.isAlive()).toBe(false);
    }), 30_000);
});
