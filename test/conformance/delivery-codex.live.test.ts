/**
 * U-R1A-26 live: the real, signed-in Codex CLI, started from its built-in harness file through
 * HarnessSession, gets its mail through Tandem's hooks passed as per-session `--config` values
 * (bridge/delivery-hooks.ts), never as keystrokes, and its hooks end each turn idle. These rows
 * settle Codex's delivery class (harnesses/codex.toml). Opt-in with TANDEM_LIVE=1; skipped otherwise.
 *
 * Run (real HOME and the default Codex sign-in, only so the signed-in `codex` works; a private
 * tmux socket; TANDEM_HOME and TMPDIR in the same folder):
 *   mkdir /tmp/r1a26-live && env -u TMUX -u CODEX_HOME TMUX_TMPDIR=/tmp/r1a26-live TMPDIR=/tmp/r1a26-live \
 *     TANDEM_HOME=/tmp/r1a26-live/tandem TANDEM_LIVE=1 npx vitest run test/conformance/delivery-codex.live.test.ts --reporter=verbose
 *   then kill the tmux servers of /tmp/r1a26-live/tmux-$(id -u)/default and /tmp/r1a26-live/tandem/tmux/tandem
 *   (after `test -S`) and remove /tmp/r1a26-live.
 *
 * Tandem writes only under TANDEM_HOME and a temporary HOME while the bridge modules load; Codex's
 * own folder-trust entry for the new folder is expected. Never answers an approval menu (one fails
 * the row), never `codex exec`. Reports, never asserts, what Codex replied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readScreen } from "../../bridge/harness-detect.ts";
import type { Harness } from "../../bridge/harness-registry.ts";

const LIVE = process.env.TANDEM_LIVE === "1";
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR || "/nonexistent", "r1a26-live-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const NAME = `r1a26-live-${randomBytes(3).toString("hex")}`;

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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) =>
  s.split(REAL_HOME).join("<redacted>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>");

describe.skipIf(!LIVE)("codex live: mail by hook through --config values (U-R1A-26)", () => {
  let codex: Harness;
  let session: InstanceType<typeof mods.HarnessSession>;
  let terminal: Awaited<ReturnType<typeof mods.TerminalSession.spawn>>;
  let box: ReturnType<typeof mods.openMailbox>;

  async function step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const shown = terminal ? await terminal.screen() : "(no session)";
      console.log(`r1a26 live: last screen of ${NAME}:\n${redact(shown)}`);
      throw e;
    }
  }

  const sent = (id: string) => box.sent("owner", 50).find((m) => m.id === id);

  /** Fails at once on an approval menu (never answered). */
  async function noApproval(): Promise<void> {
    if (readScreen(codex, await terminal.screen()) === "waiting_for_approval") throw new Error(`${NAME}: KNOWN LIMIT: approval menu`);
  }

  /** Types only once the screen reads idle and the hooks do not say working. */
  async function sendWhenIdle(text: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await noApproval();
      if ((await session.inputState()).state === "idle") return session.send(text);
      await sleep(500);
    }
    throw new Error(`${NAME}: never idle before typing`);
  }

  /** Waits until every id is delivered and the hooks say the turn ended idle. */
  async function untilDeliveredAndIdle(ids: string[], ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await noApproval();
      if (ids.every((id) => sent(id)?.state === "delivered") && mods.turnState(NAME) === "idle") return;
      await sleep(500);
    }
    throw new Error(`${NAME}: mail ${ids.map((id) => sent(id)?.state).join(",")}, turn ${mods.turnState(NAME)} after ${ms} ms`);
  }

  async function report(label: string): Promise<void> {
    const lines = (await terminal.screen()).split("\n").filter((l) => l.trim() !== "");
    console.log(`r1a26 live: ${label}, last lines of the screen:\n${redact(lines.slice(-14).join("\n"))}`);
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

  it("start: the built-in codex file spawns with its hook values and reaches its prompt", () =>
    step(async () => {
      codex = mods.loadHarnesses().harnesses.get("codex")!;
      expect(codex).toMatchObject({ source: "builtin", delivery: "hook", hook: "--config", hook_format: "config-overrides" });
      session = await mods.HarnessSession.spawn(
        codex,
        { name: NAME, cwd: WORK, allowlist: [realpathSync(WORK)], dialogAnswers: "safe" },
        async (o) => (terminal = await mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a26-live-owner" })),
      );
      expect(session.engine).toBe("codex");
      expect(session.ready).toBe(true);
    }), 90_000);

  it("L0: before the first prompt, no hook review or trust menu for hooks", () =>
    step(async () => {
      await report("L0 before the first prompt");
      const screen = await terminal.screen();
      expect(/hook/i.test(screen) && /trust|review|approve|allow/i.test(screen), "a hook menu is on the screen").toBe(false);
      expect(readScreen(codex, screen)).toBe("idle");
    }), 30_000);

  // A Stop run claims every due message at once, so an fyi acked before the ask came from a tool call (PostToolUse).
  it("L1: fyi delivered at the tool call of a turn (PostToolUse); the hooks then end the turn idle", () =>
    step(async () => {
      const fyi = box.send({ from: "owner", to: NAME, level: "fyi", text: `r1a26 fyi ${randomBytes(4).toString("hex")}` }).id;
      const ask = box.send({ from: "owner", to: NAME, level: "ask", text: `r1a26 ask-l1 ${randomBytes(4).toString("hex")}` }).id;
      await sendWhenIdle("Run the shell command: echo r1a26-ok. Then reply with one word.");
      await untilDeliveredAndIdle([fyi, ask], 180_000);
      console.log(`r1a26 live: L1 fyi acked ${sent(fyi)!.deliveredAt}, ask acked ${sent(ask)!.deliveredAt}`);
      expect(sent(fyi)!.deliveredAt!).toBeLessThan(sent(ask)!.deliveredAt!);
      await report("after the L1 turn");
    }), 200_000);

  it("L2: ask delivered at the turn end (Stop), then idle", () =>
    step(async () => {
      const text = `r1a26 ask ${randomBytes(4).toString("hex")}`;
      const id = box.send({ from: "owner", to: NAME, level: "ask", text }).id;
      await sendWhenIdle("Reply with one word.");
      await untilDeliveredAndIdle([id], 180_000);
      console.log(`r1a26 live: L2 ask of ${Buffer.byteLength(text)} bytes delivered`);
      await report("after the L2 turn");
    }), 200_000);

  it("L3 (reported only): a counting turn, interrupt() after 3 s, the turn state within 10 s", () =>
    step(async () => {
      await sendWhenIdle("Count from 1 to 300, one number per line.");
      await sleep(3_000);
      await session.interrupt();
      let state = mods.turnState(NAME);
      for (let i = 0; i < 20 && state !== "idle"; i++) {
        await sleep(500);
        state = mods.turnState(NAME);
      }
      console.log(`r1a26 live: L3 turnState after interrupt(): ${state}`);
      await report("after the L3 interrupt");
    }), 60_000);

  it("close: the session ends and its turn file goes", () =>
    step(async () => {
      await session.close();
      expect(await session.isAlive()).toBe(false);
      expect(mods.turnState(NAME)).toBeUndefined();
    }), 30_000);
});
