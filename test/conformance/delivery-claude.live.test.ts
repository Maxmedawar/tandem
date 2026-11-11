/**
 * U-R1A-25 live: the real, signed-in Claude Code, started from its built-in harness file through
 * HarnessSession, gets its mail through the per-session hook file (bridge/delivery-hooks.ts), never
 * as keystrokes, and its hooks end each turn idle. Opt-in with TANDEM_LIVE=1; skipped otherwise.
 *
 * Run (real HOME, only so the signed-in `claude` works; a private tmux socket; TANDEM_HOME and
 * TMPDIR in the same folder):
 *   mkdir /tmp/r1a25-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a25-live TMPDIR=/tmp/r1a25-live \
 *     TANDEM_HOME=/tmp/r1a25-live/tandem TANDEM_LIVE=1 npx vitest run test/conformance/delivery-claude.live.test.ts --reporter=verbose
 *   then kill the tmux servers of /tmp/r1a25-live/tmux-$(id -u)/default and /tmp/r1a25-live/tandem/tmux/tandem
 *   (after `test -S`) and remove /tmp/r1a25-live.
 *
 * Tandem writes only under TANDEM_HOME and a temporary HOME while the bridge modules load; Claude's
 * own trust entry for the new folder is expected. Reports, never asserts, what Claude replied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LIVE = process.env.TANDEM_LIVE === "1";
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || "/nonexistent", "r1a25-live-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a25-live-${randomBytes(3).toString("hex")}`;

const REAL_HOME = homedir();
let mods: {
  loadHarnesses: typeof import("../../bridge/harness-registry.ts").loadHarnesses;
  HarnessSession: typeof import("../../bridge/engines/harness-engine.ts").HarnessSession;
  TerminalSession: typeof import("../../bridge/terminal-session.ts").TerminalSession;
  openMailbox: typeof import("../../bridge/mailbox.ts").openMailbox;
  turnState: typeof import("../../bridge/delivery-hooks.ts").turnState;
};
if (LIVE) {
  mkdirSync(WORK);
  process.env.TANDEM_WAIT_MS = "1";
  process.env.HOME = join(BOX, "home");
  try {
    const [registry, engine, terminal, mailbox, hooks] = await Promise.all([
      import("../../bridge/harness-registry.ts"),
      import("../../bridge/engines/harness-engine.ts"),
      import("../../bridge/terminal-session.ts"),
      import("../../bridge/mailbox.ts"),
      import("../../bridge/delivery-hooks.ts"),
    ]);
    mods = {
      loadHarnesses: registry.loadHarnesses, HarnessSession: engine.HarnessSession, TerminalSession: terminal.TerminalSession,
      openMailbox: mailbox.openMailbox, turnState: hooks.turnState,
    };
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

describe.skipIf(!LIVE)("claude live: mail by hook, turn end by the Stop hook (U-R1A-25)", () => {
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;
  let box: ReturnType<typeof mods.openMailbox>;

  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a25 live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  const stateOf = (id: string) => box.sent("owner", 50).find((m) => m.id === id)?.state;

  /** Waits until the message is delivered and the hooks say the turn ended idle. */
  async function untilDeliveredAndIdle(id: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stateOf(id) === "delivered" && mods.turnState(NAME) === "idle") return;
      await sleep(500);
    }
    throw new Error(`${NAME}: mail ${stateOf(id)}, turn ${mods.turnState(NAME)} after ${ms} ms`);
  }

  async function report(label: string): Promise<void> {
    const lines = (await terminal.screen()).split("\n").filter((l) => l.trim() !== "");
    console.log(`r1a25 live: ${label}, last lines of the screen:\n${redact(lines.slice(-12).join("\n"))}`);
  }

  beforeAll(() => {
    if (!process.env.TMUX_TMPDIR || process.env.TMUX || !process.env.TANDEM_HOME) throw new Error("live run needs TMUX_TMPDIR and TANDEM_HOME set and TMUX unset");
    box = mods.openMailbox();
  });

  afterAll(async () => {
    if (session && (await session.isAlive())) await session.close();
    box?.close();
    rmSync(BOX, { recursive: true, force: true });
  });

  it("start: the built-in claude file spawns with its hook file and reaches its prompt", () =>
    step(async () => {
      const claude = mods.loadHarnesses().harnesses.get("claude");
      expect(claude).toMatchObject({ source: "builtin", delivery: "hook", hook: "--settings" });
      session = await mods.HarnessSession.spawn(
        claude!,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)], allowBypass: false, dialogAnswers: "safe" },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a25-live-owner" })),
      );
      expect(session.ready).toBe(true);
    }), 90_000);

  it("fyi: delivered at the tool call of a turn; the Stop hook then ends the turn idle", () =>
    step(async () => {
      const id = box.send({ from: "owner", to: NAME, level: "fyi", text: `r1a25 fyi ${randomBytes(4).toString("hex")}` }).id;
      await session.send("Run the shell command: echo r1a25. Then reply with one word.");
      await untilDeliveredAndIdle(id, 180_000);
      await report("after the fyi turn");
    }), 200_000);

  it("ask: delivered at the turn end (Stop), one more turn, then idle", () =>
    step(async () => {
      const id = box.send({ from: "owner", to: NAME, level: "ask", text: `r1a25 ask ${randomBytes(4).toString("hex")}` }).id;
      await session.send("Reply with one word.");
      await untilDeliveredAndIdle(id, 180_000);
      await report("after the ask turn");
    }), 200_000);

  it("close: the session ends and its hook file goes", () =>
    step(async () => {
      await session.close();
      expect(await session.isAlive()).toBe(false);
      expect(mods.turnState(NAME)).toBeUndefined();
    }), 30_000);
});
