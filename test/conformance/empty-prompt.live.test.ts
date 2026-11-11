/**
 * U-R1A-18D-1 live: the real, signed-in Claude Code and Codex CLI, each from its built-in harness
 * file through HarnessSession, on mini. At the empty prompt an agent's text is admitted; once a
 * person's unsent text sits in the prompt row, it is held (`prompt not empty`). Opt-in with
 * TANDEM_LIVE=1; skipped in the full suite.
 *
 * Run (real HOME, only so the signed-in agents work; a private tmux socket):
 *   mkdir /tmp/r1a18d1-live && env -u TMUX TMUX_TMPDIR=/tmp/r1a18d1-live TANDEM_HOME=/tmp/r1a18d1-live/tandem \
 *     TANDEM_LIVE=1 npx vitest run test/conformance/empty-prompt.live.test.ts --reporter=verbose
 *   then: find /tmp/r1a18d1-live -type s -exec tmux -S {} kill-server \; ; rm -rf /tmp/r1a18d1-live
 *
 * Drives HarnessSession directly, never route(): the owner id is injected and the transcript
 * folder is fixed under a temporary HOME while the bridge modules load. No sign-in, no bypass, no
 * account or settings change, no turn: the text is typed with send-keys -l on Tandem's private
 * socket and never submitted (no Enter). Only states and verdicts are printed, never a screen; when
 * the empty prompt is held, only its one prompt row (the agent's own placeholder) is printed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LIVE = process.env.TANDEM_LIVE === "1";
// Under TMUX_TMPDIR (the run folder), so the run cleanup removes it too.
const BOX = LIVE ? mkdtempSync(join(process.env.TMUX_TMPDIR!, "box-")) : "";
const WORK = LIVE ? join(BOX, "work") : "";
const TYPED = "delete the old bra";
/** A sign-in or login screen instead of the prompt (checked only on a screen that is not idle). */
const SIGNED_OUT = /sign in with|select login method|please log ?in|not logged in/i;

// The bridge modules read HOME (transcripts) when they load.
const REAL_HOME = homedir();
let mods: {
  loadHarnesses: typeof import("../../bridge/harness-registry.ts").loadHarnesses;
  HarnessSession: typeof import("../../bridge/engines/harness-engine.ts").HarnessSession;
  TerminalSession: typeof import("../../bridge/terminal-session.ts").TerminalSession;
  admitInput: typeof import("../../bridge/input-gate.ts").admitInput;
};
if (LIVE) {
  mkdirSync(WORK);
  process.env.HOME = join(BOX, "home");
  try {
    const [registry, engine, terminal, gate] = await Promise.all([
      import("../../bridge/harness-registry.ts"),
      import("../../bridge/engines/harness-engine.ts"),
      import("../../bridge/terminal-session.ts"),
      import("../../bridge/input-gate.ts"),
    ]);
    mods = { loadHarnesses: registry.loadHarnesses, HarnessSession: engine.HarnessSession, TerminalSession: terminal.TerminalSession, admitInput: gate.admitInput };
  } finally {
    process.env.HOME = REAL_HOME;
  }
  // The child claude must not join the Claude Code session that runs this test.
  for (const k of Object.keys(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") delete process.env[k];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sock = () => join(process.env.TANDEM_HOME!, "tmux", "tandem");
const tmuxHas = (name: string) => {
  try {
    execFileSync("tmux", ["-S", sock(), "has-session", "-t", `=ccm-${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!LIVE)("empty prompt live: agent text only at an empty prompt (U-R1A-18D-1)", () => {
  const sessions: { close(): Promise<void>; isAlive(): Promise<boolean> }[] = [];

  beforeAll(() => {
    // Never the default tmux server, where real agents run.
    if (!process.env.TMUX_TMPDIR || process.env.TMUX || !process.env.TANDEM_HOME) throw new Error("live run needs TMUX_TMPDIR and TANDEM_HOME set and TMUX unset");
  });

  afterAll(async () => {
    for (const s of sessions) if (await s.isAlive().catch(() => false)) await s.close().catch(() => {});
    rmSync(BOX, { recursive: true, force: true });
  });

  it.each([["claude", "❯"], ["codex", "›"]])("%s: the empty prompt admits agent text; unsent typed text holds it", async (agent, glyph) => {
    const name = `r1a18d-live-${agent}-${randomBytes(3).toString("hex")}`;
    const harness = mods.loadHarnesses().harnesses.get(agent)!;
    expect(harness?.source).toBe("builtin");
    const session = await mods.HarnessSession.spawn(
      harness,
      // allowBypass is Claude-only (codex refuses the option at all), as in claude.live and codex.live.
      { name, cwd: WORK, allowlist: [realpathSync(WORK)], ...(agent === "claude" ? { allowBypass: false } : {}), dialogAnswers: "safe" },
      async (o) => mods.TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1a18d-live-owner" }),
    );
    sessions.push(session);

    // Until idle (120 s); a sign-in screen fails at once (no screen text printed).
    const deadline = Date.now() + 120_000;
    let seen = await session.inputState();
    while (seen.state !== "idle") {
      if (SIGNED_OUT.test(seen.screen)) throw new Error(`NEEDS MAX: ${agent} not signed in on mini`);
      if (Date.now() > deadline) throw new Error(`${name}: never read idle in 120 s; last ${seen.state}`);
      await sleep(500);
      seen = await session.inputState();
    }
    console.log(`r1a18d live ${agent}: start state ${seen.state}`);

    // A screen still changing right after start is held by the settle
    // rule (state idle, no reason): ask again, up to 8 times. `prompt not empty` is never retried.
    let empty = await mods.admitInput(session, "agent", "type");
    console.log(`r1a18d live ${agent}: empty prompt -> ${JSON.stringify(empty)}`);
    for (let i = 0; i < 8 && empty.verdict === "held" && empty.state === "idle" && empty.reason === undefined; i++) {
      empty = await mods.admitInput(session, "agent", "type");
      console.log(`r1a18d live ${agent}: empty prompt, again -> ${JSON.stringify(empty)}`);
    }
    if (empty.verdict !== "enter") {
      // Only the one prompt row (the agent's own placeholder; nothing has been typed yet).
      const row = (await session.inputState()).screen.split("\n").find((l) => l.startsWith(glyph));
      console.log(`r1a18d live ${agent}: prompt row ${JSON.stringify(row ?? "(none)")}`);
    }
    expect(empty).toStrictEqual({ verdict: "enter", state: "idle" });

    // A person's unsent text: typed literally on Tandem's private socket, never Enter.
    execFileSync("tmux", ["-S", sock(), "send-keys", "-t", `=ccm-${name}:`, "-l", TYPED], { stdio: "ignore" });
    await sleep(1500);
    const typed = await mods.admitInput(session, "agent", "type");
    console.log(`r1a18d live ${agent}: typed prompt -> ${JSON.stringify(typed)}`);
    expect(typed.verdict).toBe("held");
    if (typed.state !== "idle" || typed.reason !== "prompt not empty") console.log(`r1a18d live ${agent}: FINDING held with state ${typed.state}, reason ${typed.reason}`);
    // Never submitted: the text still sits in the prompt.
    expect((await session.inputState()).screen.includes(TYPED)).toBe(true);

    await session.close();
    expect(tmuxHas(name)).toBe(false);
  }, 240_000);
});
