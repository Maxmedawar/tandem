/**
 * U-R1A-37 live: the real, signed-in Claude Code and Codex CLI each run one session from their
 * built-in harness files through HarnessSession, on mini; then the session's own transcript file
 * is found, fingerprinted and read. Opt-in with TANDEM_LIVE=1; skipped in the full suite.
 *
 * Run (real HOME, only so the signed-in CLIs work; a private tmux socket; TANDEM_HOME your own):
 *   mkdir /tmp/r1a37-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a37-live TANDEM_HOME=/tmp/r1a37-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/transcripts/live.test.ts --reporter=verbose
 *   then: test -d /tmp/r1a37-live/tmux-$(id -u) && tmux -S /tmp/r1a37-live/tmux-$(id -u)/default kill-server
 *
 * Drives HarnessSession directly, never route(): the owner id is injected and HOME points at a
 * temporary folder only while the bridge modules load, so Tandem writes only under TANDEM_HOME (the
 * agents' own files under ~/.claude and ~/.codex are expected). No sign-in, no bypass, no account or
 * settings change, never `claude -p` or `codex exec`; nothing here answers a prompt (Claude's trust
 * question for the new folder is answered by Tandem's warmup). Every send waits for an idle screen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
const WORK = LIVE ? mkdtempSync("/tmp/r1a37-") : "";
// Registered before any bridge import, so a failed import still removes the folder.
afterAll(() => {
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});
const REAL_HOME = homedir();
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

let mods: {
  loadHarnesses: typeof import("../../bridge/harness-registry.ts").loadHarnesses;
  HarnessSession: typeof import("../../bridge/engines/harness-engine.ts").HarnessSession;
  TerminalSession: typeof import("../../bridge/terminal-session.ts").TerminalSession;
  transcripts: typeof import("../../bridge/transcripts/index.ts");
};
if (LIVE) {
  // A 1 ms send cap hands control back right after Enter, so the reads see the turn from its start.
  process.env.TANDEM_WAIT_MS = "1";
  process.env.HOME = join(WORK, "home");
  try {
    const [registry, engine, terminal, transcripts] = await Promise.all([
      import("../../bridge/harness-registry.ts"),
      import("../../bridge/engines/harness-engine.ts"),
      import("../../bridge/terminal-session.ts"),
      import("../../bridge/transcripts/index.ts"),
    ]);
    mods = { loadHarnesses: registry.loadHarnesses, HarnessSession: engine.HarnessSession, TerminalSession: terminal.TerminalSession, transcripts };
  } catch (e) {
    // A failed import ends this file before any hook runs, so the folder goes here, then the failure.
    rmSync(WORK, { recursive: true, force: true });
    throw e;
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

/** One agent: start, one exact-reply prompt read until idle, close; then its transcript. */
function liveAgent(agent: "claude" | "codex", historyUnder: (cwd: string) => string) {
  describe.skipIf(!LIVE)(`${agent} live: the session's own transcript (U-R1A-37)`, () => {
    const name = `r1a37-live-${agent}-${randomBytes(3).toString("hex")}`;
    const token = `TANDEM-OK-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
    const prompt = `Reply with exactly ${token} and nothing else. Do not run any command.`;
    let harness: Harness;
    let session: InstanceType<typeof mods.HarnessSession>;
    let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;

    async function step(fn: () => Promise<void>): Promise<void> {
      try {
        await fn();
      } catch (e) {
        const shown = terminal ? await terminal.screen() : "(no session)";
        console.log(`r1a37 live: last screen of ${name}:\n${redact(shown)}`);
        throw e;
      }
    }

    async function readUntil(state: string, ms: number, cursor: number): Promise<{ text: string; cursor: number }> {
      const deadline = Date.now() + ms;
      let text = "";
      let last: { agentState?: string } = {};
      while (Date.now() < deadline) {
        const page = await session.read({ cursor });
        text += page.text;
        cursor = page.cursor;
        last = page;
        if (page.agentState === state && !page.more) return { text, cursor };
        await sleep(250);
      }
      throw new Error(`${name}: agentState never became ${state} in ${ms} ms; last ${last.agentState}`);
    }

    beforeAll(() => {
      if (!process.env.TMUX_TMPDIR || process.env.TMUX) throw new Error("live run needs TMUX_TMPDIR set and TMUX unset");
    });

    afterAll(async () => {
      if (session && (await session.isAlive())) await session.close();
    });

    it("start: the built-in file spawns and reaches its prompt", () =>
      step(async () => {
        harness = mods.loadHarnesses().harnesses.get(agent)!;
        expect(harness?.source).toBe("builtin");
        session = await mods.HarnessSession.spawn(
          harness,
          { name, cwd: WORK, allowlist: [realpathSync(WORK)], ...(agent === "claude" ? { allowBypass: false } : {}) },
          async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a37-live-owner" })),
        );
        expect(session.readinessWarning).toBeUndefined();
        expect(session.ready).toBe(true);
      }), 90_000);

    it("send: the exact-reply prompt, read until idle, then close", () =>
      step(async () => {
        await readUntil("idle", 30_000, 0);
        if (readScreen(harness, await terminal.screen()) !== "idle") throw new Error(`${name}: screen left idle; not typing`);
        const sent = await session.send(prompt);
        const page = await readUntil("idle", 120_000, sent.cursor);
        expect(sent.report + page.text).toContain(token);
        await session.close();
        expect(await session.isAlive()).toBe(false);
      }), 180_000);

    it("transcript: a pointer to the agent's own file with a sha256; the prompt and the reply read back", () =>
      step(async () => {
        const pointer = await mods.transcripts.transcriptFor(name);
        expect(pointer?.agent).toBe(agent);
        expect(pointer?.path?.startsWith(historyUnder(realpathSync(WORK)))).toBe(true);
        expect(pointer?.sha256).toMatch(/^[0-9a-f]{64}$/);
        const read = await mods.transcripts.readTranscript(name);
        const messages = read?.messages ?? [];
        expect(messages.some((m) => m.role === "user" && m.text.includes(prompt))).toBe(true);
        expect(messages.some((m) => m.role === "assistant" && m.text.includes(token))).toBe(true);
        console.log(`r1a37 live: ${agent} pointer ${redact(pointer!.path!)} sha256 ${pointer!.sha256} bytes ${pointer!.bytes}; ${messages.length} messages`);
      }), 30_000);
  });
}

liveAgent("claude", (cwd) => join(REAL_HOME, ".claude", "projects", slug(cwd)) + "/");
liveAgent("codex", () => join(REAL_HOME, ".codex", "sessions") + "/");
