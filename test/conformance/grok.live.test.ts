/**
 * U-R1A-14 live conformance: the real, signed-in Grok CLI runs from its built-in harness file
 * (harnesses/grok.toml) through HarnessSession, on mini. Opt-in with TANDEM_LIVE=1; skipped in
 * the full suite.
 *
 * Run (real HOME, only so the signed-in `grok` works; a private tmux socket):
 *   mkdir /tmp/r1a14-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a14-live TANDEM_HOME=/tmp/r1a14-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/grok.live.test.ts --reporter=verbose
 *   then: test -d /tmp/r1a14-live/tmux-$(id -u) && tmux -S /tmp/r1a14-live/tmux-$(id -u)/default kill-server
 *
 * Drives HarnessSession directly, never route(), so Tandem writes nothing under the real HOME:
 * the owner id is injected and the transcript folder is fixed under a temporary HOME while the
 * bridge modules load (Grok's own files under ~/.grok are expected). No sign-in, no bypass, no
 * account or settings change; nothing here answers a Grok prompt: every send waits for an idle
 * screen (a sign-in, trust or update menu never reads idle), so a menu fails the step instead of
 * taking the typed text and Enter. With no `<GROK_HOME or ~/.grok>/auth.json` (checked for
 * existence only, never read) it throws before anything spawns.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
// Before the first tmux call: the private tmux server takes this process's environment. With any
// Claude or Cursor hook in the user's files grok asks to trust every new folder; these switch
// those scans off (grok docs 26-config-reference.md, compat.claude.hooks / compat.cursor.hooks).
if (LIVE) {
  process.env.GROK_CLAUDE_HOOKS_ENABLED = "0";
  process.env.GROK_CURSOR_HOOKS_ENABLED = "0";
}
// Under TMUX_TMPDIR (the run folder), so the run cleanup removes it too.
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "r1a14-box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a14-live-${randomBytes(3).toString("hex")}`;

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

/**
 * Screen recorder: from just before the spawn until close, every 500 ms one capture of the pane on
 * the private socket; each distinct screen (trailing whitespace trimmed, redacted) is written to
 * <TMUX_TMPDIR>/screens/<nn>-<state the file reads>.txt. Errors before the session exists are ignored.
 */
const ACCOUNT_NAMES = (() => {
  const names = [userInfo().username];
  try {
    const full = execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
    if (full) names.push(full, ...full.split(/\s+/).filter((w) => w.length >= 4));
  } catch {}
  return names.filter(Boolean).sort((a, b) => b.length - a.length);
})();
const redactScreen = (s: string) =>
  ACCOUNT_NAMES.reduce(
    (t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<USER>"),
    s.split(REAL_HOME).join("<HOME>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<EMAIL>"),
  );
function startRecorder(harness: Harness): () => void {
  const dir = join(process.env.TMUX_TMPDIR!, "screens");
  mkdirSync(dir, { recursive: true });
  const sock = join(process.env.TMUX_TMPDIR!, `tmux-${process.getuid!()}`, "default");
  const seen = new Set<string>();
  const capture = () => {
    let raw: string;
    try {
      raw = execFileSync("tmux", ["-S", sock, "capture-pane", "-p", "-t", `=ccm-${NAME}:`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return;
    }
    const screen = raw.split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
    if (seen.has(screen)) return;
    seen.add(screen);
    const nn = String(seen.size).padStart(2, "0");
    writeFileSync(join(dir, `${nn}-${readScreen(harness, screen)}.txt`), redactScreen(screen) + "\n");
  };
  const timer = setInterval(capture, 500);
  return () => {
    clearInterval(timer);
    capture();
  };
}
let stopRecorder: (() => void) | undefined;
const redact = (s: string) =>
  s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>");

describe.skipIf(!LIVE)("grok live: the built-in harness file through HarnessSession (U-R1A-14)", () => {
  let grok: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;

  /** On a failed step, the last screen (home path and account email redacted). */
  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a14 live: last screen of ${NAME}:\n${redact(shown)}`);
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
    if (readScreen(grok, await terminal.screen()) !== "idle") throw new Error(`${NAME}: screen left idle; not typing`);
    return session.send(text);
  }

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
  });

  afterAll(async () => {
    if (session && (await session.isAlive())) await session.close();
    stopRecorder?.();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in grok file spawns and reaches its prompt (ready)", () =>
    step(async () => {
      // Existence only: the file is never opened.
      if (!existsSync(join(process.env.GROK_HOME || join(REAL_HOME, ".grok"), "auth.json"))) {
        throw new Error("grok is not signed in on this computer: NEEDS MAX");
      }
      grok = mods.loadHarnesses().harnesses.get("grok")!;
      expect(grok?.source).toBe("builtin");
      expect(grok?.programPath).toBeDefined();
      stopRecorder = startRecorder(grok);
      session = await mods.HarnessSession.spawn(
        grok,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)] },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a14-live-owner" })),
      );
      expect(session.engine).toBe("grok");
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
