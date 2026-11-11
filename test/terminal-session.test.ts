import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  TerminalSession,
  tmux as runTmux,
  tmuxSocketPath,
  type TmuxExec,
  canAdoptTerminalSession,
  describeReadiness,
  describeMarkerlessReadiness,
  readSessionProvenance,
  stepStability,
  requiredStablePolls,
  INITIAL_STABILITY_STATE,
  type StabilityState,
} from "../bridge/terminal-session.ts";
import { CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR, SHELL_DESCRIPTOR, type EngineDescriptor } from "../bridge/drivable.ts";
import { startRelay, info as relayInfo } from "../bridge/relay.ts";

// Runs before the imports above are evaluated: the bridge modules read HOME and
// TANDEM_WAIT_MS at load. A temp HOME keeps transcripts, relay and event logs
// out of the real ~/.tandem; no push or webhook may fire from a test.
const testEnv = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-home-"));
  process.env.HOME = home;
  process.env.TANDEM_WAIT_MS = "8000";
  delete process.env.TANDEM_NTFY_TOPIC;
  delete process.env.TANDEM_DONE_WEBHOOK;
  if (os.homedir() !== home) throw new Error("HOME override did not take; refusing to touch the real ~/.tandem");
  // U-R1A-19: TMUX unset, a private default socket folder and a private TANDEM_HOME (so Tandem's
  // own socket is <it>/tmux/tandem), both set before the bridge modules load.
  delete process.env.TMUX;
  const tmuxTmp = fs.mkdtempSync(path.join(os.tmpdir(), "r1a19-"));
  const tandemHome = fs.mkdtempSync(path.join(os.tmpdir(), "r1a19-"));
  const work = path.join(tmuxTmp, "work");
  fs.mkdirSync(work);
  process.env.TMUX_TMPDIR = tmuxTmp;
  process.env.TANDEM_HOME = tandemHome;
  process.env.CCM_CWD_ALLOWLIST = work;
  return { home, tmuxTmp, tandemHome, work };
});
afterAll(() => rmSync(testEnv.home, { recursive: true, force: true }));

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TerminalSession provenance and spawn guards", () => {
  function dirs(): { allowed: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), "tandem-adopt-"));
    tempRoots.push(root);
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    return { allowed, outside };
  }

  it("accepts adoption only when engine, owner, and real cwd all match", () => {
    const { allowed } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "codex", owner: "owner-a" },
        "codex",
        "owner-a",
        allowed,
        [allowed],
      ),
    ).toBe(true);
  });

  it("refuses an engine-tag mismatch", () => {
    const { allowed } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "claude", owner: "owner-a" },
        "codex",
        "owner-a",
        allowed,
        [allowed],
      ),
    ).toBe(false);
  });

  it("refuses a missing or mismatched owner", () => {
    const { allowed } = dirs();
    expect(canAdoptTerminalSession({ engine: "codex", owner: "" }, "codex", "owner-a", allowed, [allowed])).toBe(false);
    expect(canAdoptTerminalSession({ engine: "codex", owner: "owner-b" }, "codex", "owner-a", allowed, [allowed])).toBe(false);
  });

  it("refuses a matching session whose real cwd is outside the allowlist", () => {
    const { allowed, outside } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "codex", owner: "owner-a" },
        "codex",
        "owner-a",
        outside,
        [allowed],
      ),
    ).toBe(false);
  });

  it("TerminalSession.spawn itself rejects Claude-only options before cwd or tmux access", async () => {
    const base = {
      name: "no-live-spawn",
      cwd: "/path-that-must-not-be-read",
      allowlist: [] as string[],
      descriptor: CODEX_DESCRIPTOR,
    };
    await expect(TerminalSession.spawn({ ...base, model: "opus" })).rejects.toThrow(/Claude-only/);
    await expect(TerminalSession.spawn({ ...base, effort: "high" })).rejects.toThrow(/Claude-only/);
    await expect(TerminalSession.spawn({ ...base, allowBypass: false })).rejects.toThrow(/Claude-only/);
  });
});

// describeReadiness turns the #1 silent boot failure ("no banner / commands don't
// go through") into an actionable message. It is pure (load/cpu injected), so we
// exercise every branch without spawning a real TUI.
describe("describeReadiness", () => {
  it("returns null when the prompt is present (session is ready)", () => {
    expect(describeReadiness("some output\n❯ ", 1.0, 8, "worker")).toBeNull();
    // ready even under high load — the prompt is what matters
    expect(describeReadiness("❯", 99.0, 8, "worker")).toBeNull();
  });

  it("flags a CPU-starved blank pane under high load with the load + remedy", () => {
    const msg = describeReadiness("", 97.0, 8, "p1exec");
    expect(msg).not.toBeNull();
    expect(msg).toContain('session "p1exec"');
    expect(msg).toContain("blank");
    expect(msg).toContain("overloaded");
    expect(msg).toContain("97.0");
    expect(msg).toContain("8 CPUs");
  });

  it("distinguishes blank vs. partial render in the message", () => {
    expect(describeReadiness("", 1.0, 8, "w")).toContain("blank");
    expect(describeReadiness("Welcome\nhalf a screen", 1.0, 8, "w")).toContain(
      "prompt never appeared",
    );
  });

  it("when load is normal, advises a terminal attach to kick the TUI (with the right target)", () => {
    const msg = describeReadiness("", 1.0, 8, "myname");
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("overloaded");
    expect(msg).toContain(`tmux -S ${shq(tmuxSocketPath())} attach -t '=ccm-myname'`);
  });

  it("treats load just above 1.5x CPUs as overloaded, and at/below as not", () => {
    // 8 CPUs -> threshold 12.0
    expect(describeReadiness("", 12.1, 8, "x")).toContain("overloaded");
    expect(describeReadiness("", 12.0, 8, "x")).not.toContain("overloaded");
  });

  it("does not divide-by-zero / mislabel when cpuCount is unknown (0)", () => {
    const msg = describeReadiness("", 50.0, 0, "x");
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("overloaded");
  });
});

// requiredStablePolls: converts a descriptor's minStableMs policy into an
// observation count. The first observation is at t=0, so N time intervals
// require N+1 observations.
describe("requiredStablePolls", () => {
  it("includes the t=0 observation so elapsed stability never undershoots the policy", () => {
    expect(requiredStablePolls(CLAUDE_DESCRIPTOR, 750)).toBe(4); // 3 intervals = 2250ms
    expect(requiredStablePolls(CODEX_DESCRIPTOR, 750)).toBe(Math.ceil(5000 / 750) + 1); // 8
    expect(requiredStablePolls(SHELL_DESCRIPTOR, 750)).toBe(Math.ceil(1500 / 750) + 1); // 3
  });
  it("uses one observation for a zero-duration policy and two for any positive duration", () => {
    expect(requiredStablePolls({ id: "shell", minStableMs: 0 }, 750)).toBe(1);
    expect(requiredStablePolls({ id: "shell", minStableMs: 1 }, 750)).toBe(2);
  });
});

// stepStability is the pure state machine markerless (codex/shell) AND
// marker-based (claude) completion detection share. Binding — Phase 2
// correction B: "changing output is working, a short quiet pause is not
// enough for Codex, and sufficiently stable output can finish" — exercised
// here with captured/synthetic pane sequences, no live process required.
describe("stepStability — markerless (codex): stability-only, conservative window", () => {
  const required = requiredStablePolls(CODEX_DESCRIPTOR, 750); // 8 observations span 5.25s >= 5s floor

  it("changing output on every poll is always 'working', never idle", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    for (let i = 0; i < required + 3; i++) {
      const step = stepStability(`frame ${i}`, state, CODEX_DESCRIPTOR, required);
      expect(step.working).toBe(false); // codex has no marker; "working" is always false
      expect(step.idle).toBe(false); // but stablePolls resets each time output changes
      state = step.state;
    }
  });

  it("a short quiet pause (fewer polls than the 5s floor) is NOT enough to report done", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "final output";
    for (let i = 0; i < required - 1; i++) {
      const step = stepStability(pane, state, CODEX_DESCRIPTOR, required);
      expect(step.idle).toBe(false);
      state = step.state;
    }
  });

  it("sufficiently stable output (>= the 5s floor of consecutive polls) reports done", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "final output";
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability(pane, state, CODEX_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });

  it("output changing right before the stability window elapses resets the count", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    for (let i = 0; i < required - 1; i++) {
      state = stepStability("same pane", state, CODEX_DESCRIPTOR, required).state;
    }
    // One more poll, but the pane just changed — resets to stablePolls=1, not idle.
    const changed = stepStability("different pane now", state, CODEX_DESCRIPTOR, required);
    expect(changed.idle).toBe(false);
    expect(changed.state.stablePolls).toBe(1);
  });
});

describe("stepStability — markerless (shell): shorter conservative window", () => {
  it("3 stable observations spanning the 1.5s floor reports done", () => {
    const required = requiredStablePolls(SHELL_DESCRIPTOR, 750);
    let state: StabilityState = INITIAL_STABILITY_STATE;
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability("$ ", state, SHELL_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });
});

describe("stepStability — marker-based (claude): the working marker overrides stability", () => {
  it("the presence of the working marker is always 'working', regardless of pane stability", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "thinking... (esc to interrupt)";
    for (let i = 0; i < 5; i++) {
      const step = stepStability(pane, state, CLAUDE_DESCRIPTOR, requiredStablePolls(CLAUDE_DESCRIPTOR, 750));
      expect(step.working).toBe(true);
      expect(step.idle).toBe(false);
      state = step.state;
    }
  });

  it("once the marker clears, idle requires the same stability window as any other descriptor", () => {
    const required = requiredStablePolls(CLAUDE_DESCRIPTOR, 750);
    let state = stepStability("thinking... (esc to interrupt)", INITIAL_STABILITY_STATE, CLAUDE_DESCRIPTOR, required).state;
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability("❯ ", state, CLAUDE_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });
});

// ---- TANDEM-B-SESSION: exact targeting, cursor safety, quiet vs done ---------
// Real tmux runs on a PRIVATE socket only. Live agents run on the default
// server, so nothing here may reach it: every bridge `tmux` call goes through a
// PATH shim pinned to the private socket, and cleanup kills only that server.

const REAL_TMUX = (() => {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The private constructor, for driving one session without spawning an engine. */
const Ctor = TerminalSession as unknown as new (
  name: string,
  cwd: string,
  logPath: string,
  descriptor: EngineDescriptor,
) => TerminalSession;
type Internals = { capture(): Promise<string>; injectMultiline(text: string): Promise<void> };

/** A markerless descriptor that is ready as soon as `cat` echoes its warmup line. */
const CAT_DESCRIPTOR: EngineDescriptor = { id: "shell", executable: "cat", warmupPrompt: "ready", minStableMs: 0 };

const HINT_SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"];

/** Ends the server on `sock` and waits until the socket answers "no server": kill-server returns
 *  before the server stops listening, and a client in that window (the next test's first tmux
 *  call) gets "server exited unexpectedly" (seen on Linux, tmux 3.4). */
async function endServer(sock: string): Promise<void> {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (!existsSync(sock)) return;
  spawnSync(REAL_TMUX, ["-S", sock, "kill-server"], { env });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = spawnSync(REAL_TMUX, ["-S", sock, "list-sessions"], { encoding: "utf8", env });
    if (r.status !== 0 && /no server running|error connecting/.test(r.stderr)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const onPath = (program: string): boolean => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
/** Pastes an attachHint() command into `shell` with a stand-in for `tmux` first: it checks the
 *  argv is `-S <socket> attach -t <target>`, resolves the target as a session on that socket and
 *  prints its name. */
function pasteHint(shell: string, hint: string, dir: string): string {
  const shim = join(dir, "attach-shim");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      '[ "$1" = -S ] && [ "$3" = attach ] && [ "$4" = -t ] && [ $# -eq 5 ] || { echo "unexpected argv: $*" >&2; exit 2; }',
      "unset TMUX TMUX_PANE",
      `exec ${shq(REAL_TMUX)} -S "$2" list-windows -t "$5" -F '#{session_name}'`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  expect(hint.startsWith("tmux ")).toBe(true);
  return execFileSync(shell, ["-c", shq(shim) + hint.slice("tmux".length)], { encoding: "utf8" }).trim();
}

describe.skipIf(!REAL_TMUX)("TANDEM-B-SESSION (real tmux on a private socket)", () => {
  let box = "";
  let sock = "";
  let callLog = "";
  let savedPath: string | undefined;

  function tx(...args: string[]): string {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    return execFileSync(REAL_TMUX, ["-S", sock, ...args], { encoding: "utf8", env }).trim();
  }
  const sink = (name: string, cmd: string[] = ["cat"], cwd = box): void => {
    tx("new-session", "-d", "-s", `ccm-${name}`, "-x", "200", "-y", "50", "-c", cwd, ...cmd);
  };
  const tag = (name: string, engine: string, owner: string): void => {
    tx("set-option", "-t", `=ccm-${name}:`, "@tandem_engine", engine);
    tx("set-option", "-t", `=ccm-${name}:`, "@tandem_owner", owner);
  };
  const fmt = (name: string, format: string): string => tx("display-message", "-p", "-t", `=ccm-${name}:`, format);
  const pane = (name: string): string => tx("capture-pane", "-p", "-t", `=ccm-${name}:`);
  const alive = (name: string): boolean => {
    try {
      tx("has-session", "-t", `=ccm-${name}`);
      return true;
    } catch {
      return false;
    }
  };
  /** Bridge tmux calls since the last reset, as logged by the shim. */
  const calls = (): { rc: number; argv: string }[] =>
    readFileSync(callLog, "utf8")
      .split("\n")
      .map((line) => /^(\d+)\t(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ rc: Number(m[1]), argv: m[2] }));
  /** After the next bridge tmux call whose argv contains `after`, run `cmds` once. */
  function hookAfter(after: string, cmds: string[][]): void {
    const hook = join(box, "hook.sh");
    const lines = cmds.map((c) => ['"$REAL" -S "$SOCK"', ...c.map(shq)].join(" "));
    writeFileSync(hook, [...lines, 'rm -f "$0"', ""].join("\n"));
    process.env.TB_AFTER = after;
    process.env.TB_HOOK = hook;
  }
  /** A session on the private socket whose pane and input are stubbed. */
  function session(name: string, descriptor: EngineDescriptor, logPath = join(box, `${name}.log`)): TerminalSession {
    if (!existsSync(logPath)) writeFileSync(logPath, "");
    return new Ctor(name, box, logPath, descriptor);
  }
  function stub(s: TerminalSession, paneText: () => string, onInject: (text: string) => void = () => {}): void {
    const inner = s as unknown as Internals;
    inner.capture = async () => paneText();
    inner.injectMultiline = async (text: string) => onInject(text);
  }

  beforeAll(() => {
    savedPath = process.env.PATH;
    box = mkdtempSync(join(tmpdir(), "tandem-tmux-"));
    // U-R1A-19: the bridge runs every tmux call on Tandem's own socket; the shim pins the same one.
    sock = tmuxSocketPath();
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
    callLog = join(box, "calls.log");
    const bin = join(box, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tmux"),
      [
        "#!/bin/sh",
        "unset TMUX TMUX_PANE",
        'if [ "$1" = -S ]; then shift 2; fi',
        `REAL=${shq(REAL_TMUX)}; SOCK=${shq(sock)}; export REAL SOCK`,
        '"$REAL" -S "$SOCK" "$@"',
        "rc=$?",
        `printf '%s\\t%s\\n' "$rc" "$*" >> ${shq(callLog)}`,
        'if [ -n "$TB_AFTER" ] && [ -f "$TB_HOOK" ]; then case "$*" in *"$TB_AFTER"*) sh "$TB_HOOK" ;; esac; fi',
        "exit $rc",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${savedPath}`;
  });
  beforeEach(() => {
    writeFileSync(callLog, "");
    tx("new-session", "-d", "-s", "keeper", "sleep", "600");
  });
  afterEach(async () => {
    delete process.env.TB_AFTER;
    delete process.env.TB_HOOK;
    await endServer(sock);
  });
  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(box, { recursive: true, force: true });
  });

  it("a) only ccm-review-target-long exists with matching tags: review-target is not adopted, not found, untagged", async () => {
    sink("review-target-long");
    tag("review-target-long", "claude", "synthetic-owner");
    const adopted = await TerminalSession.attachExisting("review-target", [box], CLAUDE_DESCRIPTOR, async () => "synthetic-owner");
    expect(adopted).toBeUndefined();
    expect(await TerminalSession.exists("review-target")).toBe(false);
    expect(await TerminalSession.engineTagOf("review-target")).toBeUndefined();
  });

  it("b) has-session (exists, isAlive, spawn and adoption guards) cannot resolve to a longer name", async () => {
    sink("b-has-long");
    expect(await TerminalSession.exists("b-has")).toBe(false);
    expect(await session("b-has", CLAUDE_DESCRIPTOR).isAlive()).toBe(false);
    const has = calls().filter((c) => c.argv.startsWith("has-session"));
    expect(has.length).toBeGreaterThan(0);
    expect(has.every((c) => c.rc !== 0)).toBe(true);
  });

  it("b) display-message provenance tags (readSessionProvenance, attachExisting, engineTagOf) cannot resolve to a longer name", async () => {
    sink("b-prov-long");
    tag("b-prov-long", "claude", "synthetic-owner");
    expect(await readSessionProvenance("b-prov")).toEqual({ engine: "", owner: "" });
  });

  it("b) set-option @tandem_engine in spawn cannot tag a longer name when the new session is gone", async () => {
    hookAfter("new-session", [
      ["kill-session", "-t", "=ccm-b-eng"],
      ["new-session", "-d", "-s", "ccm-b-eng-long", "-c", box, "cat"],
      ["set-option", "-t", "=ccm-b-eng-long:", "@tandem_engine", "claude"],
    ]);
    await TerminalSession.spawn({ name: "b-eng", cwd: box, allowlist: [box], descriptor: CAT_DESCRIPTOR, ownerIdProvider: async () => "spawn-owner" }).catch(() => undefined);
    expect(fmt("b-eng-long", "#{@tandem_engine}")).toBe("claude");
  }, 30_000);

  it("b) set-option @tandem_owner in spawn cannot tag a longer name when the new session is gone", async () => {
    hookAfter("@tandem_engine", [
      ["kill-session", "-t", "=ccm-b-own"],
      ["new-session", "-d", "-s", "ccm-b-own-long", "-c", box, "cat"],
      ["set-option", "-t", "=ccm-b-own-long:", "@tandem_owner", "long-owner"],
    ]);
    await TerminalSession.spawn({ name: "b-own", cwd: box, allowlist: [box], descriptor: CAT_DESCRIPTOR, ownerIdProvider: async () => "spawn-owner" }).catch(() => undefined);
    expect(fmt("b-own-long", "#{@tandem_owner}")).toBe("long-owner");
  }, 30_000);

  it("b) pipe-pane in spawn cannot attach the transcript to a longer name when the new session is gone", async () => {
    hookAfter("@tandem_owner", [
      ["kill-session", "-t", "=ccm-b-pipe"],
      ["new-session", "-d", "-s", "ccm-b-pipe-long", "-c", box, "cat"],
    ]);
    await TerminalSession.spawn({ name: "b-pipe", cwd: box, allowlist: [box], descriptor: CAT_DESCRIPTOR, ownerIdProvider: async () => "spawn-owner" }).catch(() => undefined);
    expect(fmt("b-pipe-long", "#{pane_pipe}")).toBe("0");
  }, 30_000);

  it("b) display-message pane_current_path in attachExisting cannot read a longer name's cwd", async () => {
    const exactDir = join(box, "exact-dir");
    const longerDir = join(box, "longer-dir");
    mkdirSync(exactDir);
    mkdirSync(longerDir);
    sink("b-cwd", ["cat"], exactDir);
    tag("b-cwd", "claude", "owner-x");
    hookAfter("#{@tandem_engine}", [
      ["kill-session", "-t", "=ccm-b-cwd"],
      ["new-session", "-d", "-s", "ccm-b-cwd-long", "-c", longerDir, "cat"],
      ["set-option", "-t", "=ccm-b-cwd-long:", "@tandem_engine", "claude"],
      ["set-option", "-t", "=ccm-b-cwd-long:", "@tandem_owner", "owner-x"],
    ]);
    const adopted = await TerminalSession.attachExisting("b-cwd", [box], CLAUDE_DESCRIPTOR, async () => "owner-x");
    expect(adopted?.cwd ?? "").not.toMatch(/longer-dir$/);
  });

  it("b) send-keys through tmuxTarget (send, warmup, controls, interrupt) cannot type into a longer name", async () => {
    sink("b-keys-long");
    const s = session("b-keys", CLAUDE_DESCRIPTOR);
    await s.send("PROBE-KEYS").catch(() => undefined);
    expect(pane("b-keys-long")).not.toContain("PROBE-KEYS");
    await s.interrupt();
    expect(alive("b-keys-long")).toBe(true);
    const keys = calls().filter((c) => c.argv.startsWith("send-keys"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((c) => c.rc !== 0)).toBe(true);
  }, 30_000);

  it("b) capture-pane through tmuxTarget (send and read idle checks) cannot read a longer name", async () => {
    sink("b-cap-long", ["sh", "-c", "echo esc to interrupt; exec cat"]);
    await session("b-cap", CLAUDE_DESCRIPTOR).readSince(0);
    const caps = calls().filter((c) => c.argv.startsWith("capture-pane"));
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => c.rc !== 0)).toBe(true);
  });

  it("b) kill-session in close() cannot kill a longer name", async () => {
    sink("b-kill-long");
    await session("b-kill", CLAUDE_DESCRIPTOR).close();
    expect(alive("b-kill-long")).toBe(true);
  });

  it("c) send() at the soft cap after 19 bytes: running, empty report, pre-send cursor, and readSince returns the 19 bytes", async () => {
    sink("c-cap");
    const log = join(box, "c.log");
    writeFileSync(log, "before\n");
    const s = session("c-cap", CLAUDE_DESCRIPTOR, log);
    stub(s, () => "esc to interrupt", () => appendFileSync(log, "intermediate output"));
    const r = await s.send("synthetic input");
    expect(r).toEqual({ status: "running", report: "", cursor: 7 });
    const read = await s.readSince(r.cursor);
    expect(read.text).toBe("intermediate output");
    expect(read.state).toBe("working");
  }, 30_000);

  it("d) bytes written after the report is read but before the cursor is computed are not skipped by the next read", async () => {
    sink("d-late");
    const log = join(box, "d.log");
    writeFileSync(log, "before\n");
    const s = session("d-late", { ...CLAUDE_DESCRIPTOR, minStableMs: 0 }, log);
    let captures = 0;
    stub(
      s,
      () => {
        captures += 1;
        if (captures === 2) appendFileSync(log, "LATE BYTES"); // lands while the report is read
        return "result line";
      },
      () => appendFileSync(log, "turn bytes\n"),
    );
    const r = await s.send("go");
    expect(r.status).toBe("done");
    const next = await s.readSince(r.cursor);
    expect(next.text).toContain("LATE BYTES");
    expect(next.state).toBe("done");
    expect(r.report).toContain("result line");
    // The report is the settled screen, so it says what it cut and where to read it.
    expect(r.report).toContain("11 transcript bytes");
    expect(r.report).toContain("cursor 7");
  }, 30_000);

  it("e) Codex, eight unchanged panes 'Waiting for network tool; still running': send() returns quiet, never done", async () => {
    sink("e-codex");
    const s = session("e-codex", CODEX_DESCRIPTOR);
    let captures = 0;
    stub(s, () => {
      captures += 1;
      return "Waiting for network tool; still running";
    });
    expect(requiredStablePolls(CODEX_DESCRIPTOR)).toBe(8);
    const r = await s.send("check the network");
    expect(captures).toBeGreaterThanOrEqual(8);
    expect(r.status).toBe("quiet");
  }, 30_000);

  it("f) shell, stable pane: send() returns quiet and a read says quiet", async () => {
    sink("f-shell");
    const s = session("f-shell", SHELL_DESCRIPTOR);
    stub(s, () => "$ ");
    const r = await s.send("ls");
    expect(r.status).toBe("quiet");
    const read = await s.readSince(r.cursor);
    expect(read.idle).toBe(true);
    expect(read.state).toBe("quiet");
  }, 30_000);

  it("g) Claude, marker absent and pane stable: send() returns done", async () => {
    sink("g-claude");
    const s = session("g-claude", CLAUDE_DESCRIPTOR);
    stub(s, () => "all finished\n❯ ");
    const r = await s.send("finish");
    expect(r.status).toBe("done");
  }, 30_000);

  // The relay reads the built-in claude harness file, which needs a `claude` program on PATH.
  it.skipIf(!onPath("claude"))("h) a relay turn ending in 'quiet' advances to the next turn and passes on its report (needs claude on PATH)", async () => {
    const quietEngine: EngineDescriptor = { id: "codex", executable: "codex", minStableMs: 0 };
    sink("h-lead");
    sink("h-worker");
    const lead = session("h-lead", quietEngine);
    const worker = session("h-worker", quietEngine);
    const leadSaw: string[] = [];
    const workerSaw: string[] = [];
    const statuses: string[] = [];
    const leadReplies = ["Run step one", "DONE"];
    stub(lead, () => leadReplies[leadSaw.length - 1] ?? "DONE", (t) => leadSaw.push(t));
    stub(worker, () => "step one finished", (t) => workerSaw.push(t));
    for (const s of [lead, worker]) {
      const send = s.send.bind(s);
      s.send = async (text: string) => {
        const r = await send(text);
        statuses.push(r.status);
        return r;
      };
    }
    vi.spyOn(TerminalSession, "spawn").mockResolvedValueOnce(lead).mockResolvedValueOnce(worker);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    try {
      const { loopId } = await startRelay({ goal: "finish step one", cwd: box, allowlist: [box], idleTimeoutMs: 1 });
      const deadline = Date.now() + 20_000;
      while (relayInfo(loopId)?.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(relayInfo(loopId)?.running ?? false).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
    expect(statuses).toEqual(["quiet", "quiet", "quiet"]);
    expect(workerSaw).toEqual(["Run step one"]);
    expect(leadSaw).toHaveLength(2);
    expect(leadSaw[1]).toContain("step one finished");
  }, 30_000);

  for (const shell of HINT_SHELLS) {
    it.skipIf(!existsSync(shell))(`i) the attach command printed by attachHint() reaches that exact session when pasted into ${shell}`, () => {
      sink("i-hint");
      sink("i-hint-long");
      const hint = session("i-hint", CLAUDE_DESCRIPTOR).attachHint();
      expect(hint).toBe(`tmux -S ${shq(sock)} attach -t '=ccm-i-hint'`);
      expect(pasteHint(shell, hint, box), `${shell}: ${hint}`).toBe("ccm-i-hint");
    });
  }

  it("j) the bridge's secret settings reach neither the tmux server nor a session's environment; process.env keeps them", async () => {
    // The keeper started this socket's server with the test's own environment: start clean.
    await endServer(sock);
    const secrets: Record<string, string> = {
      TANDEM_OWNER_PASSWORD: "r1a12-owner-password-value",
      TANDEM_HUB_LINK_TOKEN: "r1a12-hub-link-token-value",
      TANDEM_FLEET_TOKEN: "r1a12-fleet-token-value",
    };
    const saved = Object.fromEntries(Object.keys(secrets).map((k) => [k, process.env[k]]));
    Object.assign(process.env, secrets);
    try {
      await TerminalSession.spawn({ name: "r1a12-env", cwd: box, allowlist: [box], descriptor: CAT_DESCRIPTOR, ownerIdProvider: async () => "spawn-owner" });
      // Compared as names only: a failure must never print the environment (it holds real tokens).
      const names = (env: string) => env.split("\n").map((line) => line.replace(/^-/, "").split("=")[0]);
      const globalNames = names(tx("show-environment", "-g"));
      const sessionNames = names(tx("show-environment", "-t", "=ccm-r1a12-env"));
      expect(globalNames.includes("PATH")).toBe(true);
      expect(Object.keys(secrets).filter((k) => globalNames.includes(k))).toEqual([]);
      expect(Object.keys(secrets).filter((k) => sessionNames.includes(k))).toEqual([]);
      expect(Object.keys(secrets).filter((k) => process.env[k] !== secrets[k])).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);

  // U-R1A-12-R1 review-fix: codex 0.167.1 takes an Enter that lands right after the typed text as a
  // newline (its paste detection), so the prompt was never submitted live. Every type-then-Enter path pauses.
  describe("k) Enter reaches tmux only after a pause behind the typed text", () => {
    /** Runs `act`, which calls `typed()` right after the text is typed. Returns whether a tmux call
     *  sending Enter had started 100 ms later (`early`) and whether one came at all (`after`). A
     *  first PATH shim marks the start of that call, before it reaches the socket shim. */
    async function enterAfterTyping(act: (typed: () => void) => Promise<unknown>): Promise<{ early: boolean; after: boolean }> {
      const marker = join(box, "enter-started");
      const first = join(box, "first-bin");
      rmSync(marker, { force: true });
      mkdirSync(first, { recursive: true });
      writeFileSync(join(first, "tmux"), `#!/bin/sh\ncase "$*" in *Enter*) : > ${shq(marker)} ;; esac\nexec ${shq(join(box, "bin", "tmux"))} "$@"\n`, { mode: 0o700 });
      execFileSync(join(first, "tmux"), ["-V"]); // the first run of a new script is slow on macOS
      const path = process.env.PATH;
      process.env.PATH = `${first}:${path}`;
      try {
        let check: Promise<boolean> | undefined;
        await act(() => {
          check ??= new Promise((resolve) => setTimeout(() => resolve(existsSync(marker)), 100));
        });
        expect(check).toBeDefined();
        return { early: await check!, after: existsSync(marker) };
      } finally {
        process.env.PATH = path;
      }
    }

    it.each<[string, (typed: () => void) => Promise<unknown>]>([
      ["send()", async (typed) => {
        sink("k-send");
        const s = session("k-send", CAT_DESCRIPTOR);
        stub(s, () => "$ ", typed);
        return s.send("probe");
      }],
      ["applyControls() (a slash control)", async (typed) => {
        sink("k-ctl");
        const s = session("k-ctl", CLAUDE_DESCRIPTOR);
        stub(s, () => "❯ ", typed);
        return s.applyControls({ effort: "high" });
      }],
      ["spawn's warmup prompt", async (typed) => {
        const proto = TerminalSession.prototype as unknown as Internals;
        const inject = proto.injectMultiline;
        const spy = vi.spyOn(proto, "injectMultiline").mockImplementation(async function (this: unknown, text: string) {
          await inject.call(this, text);
          typed();
        });
        try {
          return await TerminalSession.spawn({ name: "k-warm", cwd: box, allowlist: [box], descriptor: CAT_DESCRIPTOR, ownerIdProvider: async () => "spawn-owner" });
        } finally {
          spy.mockRestore();
        }
      }],
    ])("%s", async (_label, act) => {
      expect(await enterAfterTyping(act)).toEqual({ early: false, after: true });
    }, 30_000);
  });
});

// ---- TANDEM-B-SESSION-R1 review-fix: a quiet turn's event must say quiet -----
describe("quiet completion events (TANDEM-B-SESSION-R1 review-fix)", () => {
  it("quiet) a quiet turn's event says quiet in its status, notification title and handoff, on send and on poll", async () => {
    const { routeForTest } = await import("../bridge/router.ts");
    const { registerLive, unregisterLive } = await import("../bridge/sessions.ts");
    const name = "quiet-event";
    registerLive({
      id: name,
      engine: "codex",
      cwd: testEnv.home,
      isAlive: async () => true,
      isWorking: async () => false,
      send: async () => ({ status: "quiet", report: "still waiting on the network", cursor: 5 }),
      read: async () => ({ text: "more output", cursor: 9, idle: true, state: "quiet" }),
      interrupt: async () => {},
      close: async () => {},
      attachHint: () => "hint",
    });
    vi.stubEnv("TANDEM_NTFY_TOPIC", "quiet-topic");
    vi.stubEnv("TANDEM_DONE_WEBHOOK", "http://127.0.0.1:9/hook");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      const sent = await routeForTest("POST", `/sessions/${name}/send`, { text: "go" });
      const polled = await routeForTest("POST", `/sessions/${name}/send`, { cursor: 5 });
      expect((sent.body as { status: string }).status).toBe("quiet");
      expect((polled.body as { state: string }).state).toBe("quiet");
      const posts = fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
      const hooks = posts.filter((p) => p.url.endsWith("/hook")).map((p) => JSON.parse(String(p.init.body)));
      const pushes = posts.filter((p) => p.url.includes("quiet-topic"));
      expect(hooks).toHaveLength(2);
      expect(pushes).toHaveLength(2);
      for (const ev of hooks) {
        expect(ev.status).toBe("quiet");
        expect(ev.handoff).toContain("quiet");
        expect(ev.handoff).not.toMatch(/\b(done|finished)\b/i);
      }
      for (const p of pushes) {
        const headers = p.init.headers as Record<string, string>;
        expect(headers.Title).toBe(`tandem: ${name} quiet`);
        expect(String(p.init.body)).not.toMatch(/\b(done|finished)\b/i);
      }
      const logged = readFileSync(join(testEnv.home, ".tandem", "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(logged.filter((e) => e.id === name).map((e) => e.status)).toEqual(["quiet", "quiet"]);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
      unregisterLive(name);
    }
  });
});

// ---- U-R1A-19: Tandem's own tmux socket ----------------------------------------
// Every bridge tmux call runs on `<TANDEM_HOME, else ~/.tandem>/tmux/tandem` in an owner-only
// folder, never on the user's default socket (gate A2.8). TMUX is unset and TMUX_TMPDIR and
// TANDEM_HOME are private r1a19- folders (set in the hoisted block above, before any import), so the
// "default socket" here is this run's own. afterAll ends every server this describe could start,
// each through its own -S socket after `test -S`, then removes the folders.
describe.skipIf(!REAL_TMUX)("U-R1A-19: Tandem's own tmux socket", () => {
  const WORK = testEnv.work;
  const OWNER = "r1a19-owner";
  const owner = async () => OWNER;
  const uid = process.getuid!();
  const defaultSock = join(testEnv.tmuxTmp, `tmux-${uid}`, "default");
  const tandemSock = join(testEnv.tandemHome, "tmux", "tandem");
  const homeSock = join(testEnv.home, ".tandem", "tmux", "tandem");
  const quoteHome = join(testEnv.tmuxTmp, "it's here");
  const quoteSock = join(quoteHome, "tmux", "tandem");
  const extraDirs: string[] = [];
  let savedShell: string | undefined;

  const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
  };
  /** Raw tmux on an explicit socket (or this run's default socket when `sock` is ""). */
  const raw = (sock: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync(REAL_TMUX, sock ? ["-S", sock, ...args] : args, { encoding: "utf8", env: cleanEnv(extra) });
  const killServer = (sock: string) => endServer(sock);
  const shellSpawn = (name: string, cwd = WORK) =>
    TerminalSession.spawn({ name, cwd, allowlist: [WORK], descriptor: SHELL_DESCRIPTOR, ownerIdProvider: owner });
  async function withTandemHome<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.TANDEM_HOME;
    if (value === undefined) delete process.env.TANDEM_HOME;
    else process.env.TANDEM_HOME = value;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.TANDEM_HOME;
      else process.env.TANDEM_HOME = saved;
    }
  }
  /** Types `echo "<mark>=[$(printenv NAME)]"` into a shell pane and returns what it printed between the brackets. */
  async function paneValue(sock: string, name: string, varName: string): Promise<string> {
    const mark = `r1a19v${Math.random().toString(36).slice(2, 8)}`;
    raw(sock, ["send-keys", "-t", `=ccm-${name}:`, "-l", "--", `echo "${mark}=[$(printenv ${varName})]"`]);
    raw(sock, ["send-keys", "-t", `=ccm-${name}:`, "Enter"]);
    const re = new RegExp(`^${mark}=\\[(.*)\\]$`, "m");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const m = re.exec(raw(sock, ["capture-pane", "-p", "-t", `=ccm-${name}:`]).stdout);
      if (m) return m[1];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no ${mark} line in ccm-${name}`);
  }
  const globalNames = (sock: string): string[] =>
    raw(sock, ["show-environment", "-g"]).stdout.split("\n").map((l) => l.replace(/^-/, "").split("=")[0]);
  /** Every entry under `dir` with its type and mode, to prove nothing was created or repaired. */
  const snapshot = (dir: string): string[] =>
    readdirSync(dir, { recursive: true }).map(String).sort().map((rel) => {
      const st = lstatSync(join(dir, rel));
      return `${rel} ${st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isSocket() ? "s" : "f"} ${(st.mode & 0o7777).toString(8)}`;
    });

  beforeAll(() => {
    savedShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
  });
  afterAll(async () => {
    process.env.SHELL = savedShell;
    for (const sock of [defaultSock, tandemSock, homeSock, quoteSock]) await killServer(sock);
    for (const dir of [testEnv.tmuxTmp, testEnv.tandemHome, ...extraDirs]) rmSync(dir, { recursive: true, force: true });
  });

  it("a) A2.8: a spawned session lives on Tandem's socket, the default socket lists no ccm- session, tmux/ is 0700, the socket has no group/world bit", async () => {
    await shellSpawn("r1a19-a");
    expect(tmuxSocketPath()).toBe(tandemSock);
    expect(raw(tandemSock, ["has-session", "-t", "=ccm-r1a19-a"]).status).toBe(0);
    const ls = raw("", ["ls"]);
    expect(ls.stdout.split("\n").filter((l) => l.startsWith("ccm-"))).toEqual([]);
    expect(statSync(dirname(tandemSock)).mode & 0o777).toBe(0o700);
    expect(statSync(tandemSock).isSocket()).toBe(true);
    expect(statSync(tandemSock).mode & 0o077).toBe(0);
  }, 30_000);

  it("a) with TANDEM_HOME unset the socket is under the test's temp HOME", async () => {
    await withTandemHome(undefined, async () => {
      expect(homedir()).toBe(testEnv.home);
      expect(tmuxSocketPath()).toBe(join(resolve(testEnv.home), ".tandem", "tmux", "tandem"));
      await shellSpawn("r1a19-ahome");
    });
    expect(raw(homeSock, ["has-session", "-t", "=ccm-r1a19-ahome"]).status).toBe(0);
    expect(statSync(dirname(homeSock)).mode & 0o777).toBe(0o700);
    expect(statSync(homeSock).mode & 0o077).toBe(0);
    await killServer(homeSock);
  }, 30_000);

  const refusals: [string, (th: string) => void][] = [
    ["tmux/ 0755", (th) => { mkdirSync(join(th, "tmux")); chmodSync(join(th, "tmux"), 0o755); }],
    ["tmux/ a symlink to a 0700 folder", (th) => { mkdirSync(join(th, "real"), { mode: 0o700 }); symlinkSync(join(th, "real"), join(th, "tmux")); }],
    ["tmux/ a regular file", (th) => writeFileSync(join(th, "tmux"), "")],
  ];
  it.each(refusals)("b) %s: refused, no server started, nothing made or repaired", async (_label, setup) => {
    const th = mkdtempSync(join(testEnv.tmuxTmp, "b-"));
    setup(th);
    const before = snapshot(th);
    await withTandemHome(th, async () => {
      await expect(shellSpawn("r1a19-b")).rejects.toThrow(join(th, "tmux"));
      const { listLiveTmuxSessions } = await import("../bridge/sessions.ts");
      expect(await listLiveTmuxSessions({ ownerIdProvider: owner })).toEqual([]);
      expect(await TerminalSession.attachExisting("r1a19-b", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
    });
    expect(snapshot(th)).toEqual(before);
  }, 30_000);

  it("b) a TANDEM_HOME making the socket path over 100 bytes: refused by name, nothing made", async () => {
    const th = join(testEnv.tmuxTmp, "x".repeat(110));
    const sock = join(th, "tmux", "tandem");
    expect(() => tmuxSocketPath(th)).toThrow(`tmux socket path too long: ${sock}`);
    await withTandemHome(th, async () => {
      await expect(shellSpawn("r1a19-long")).rejects.toThrow(`tmux socket path too long: ${sock}`);
      const { listLiveTmuxSessions } = await import("../bridge/sessions.ts");
      expect(await listLiveTmuxSessions({ ownerIdProvider: owner })).toEqual([]);
      expect(await TerminalSession.attachExisting("r1a19-long", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
    });
    expect(existsSync(th)).toBe(false);
  });

  it("c) clean env: a stale default server's environment and the bridge's secrets reach no Tandem pane or server", async () => {
    // A server on this run's DEFAULT socket that carries R1A19_STALE.
    expect(raw("", ["new-session", "-d", "-s", "r1a19-stale", "sleep", "600"], { R1A19_STALE: "1" }).status).toBe(0);
    expect(globalNames("").includes("R1A19_STALE")).toBe(true);
    await killServer(tandemSock);
    const saved = process.env.TANDEM_OWNER_PASSWORD;
    process.env.TANDEM_OWNER_PASSWORD = "r1a19-secret";
    try {
      await shellSpawn("r1a19-c1");
      expect(await paneValue(tandemSock, "r1a19-c1", "R1A19_STALE")).toBe("");
      expect(globalNames(tandemSock).includes("TANDEM_OWNER_PASSWORD")).toBe(false);
      expect(process.env.TANDEM_OWNER_PASSWORD).toBe("r1a19-secret");
    } finally {
      if (saved === undefined) delete process.env.TANDEM_OWNER_PASSWORD;
      else process.env.TANDEM_OWNER_PASSWORD = saved;
    }
    // A Tandem-socket server already running with an old secret in its global environment.
    await killServer(tandemSock);
    expect(raw(tandemSock, ["new-session", "-d", "-s", "r1a19-pre", "sleep", "600"], { TANDEM_OWNER_PASSWORD: "r1a19-old" }).status).toBe(0);
    expect(raw(tandemSock, ["show-environment", "-g"]).stdout.includes("=r1a19-old")).toBe(true);
    await shellSpawn("r1a19-c3");
    expect(await paneValue(tandemSock, "r1a19-c3", "TANDEM_OWNER_PASSWORD")).toBe("");
    expect(raw(tandemSock, ["show-environment", "-g"]).stdout.includes("=r1a19-old")).toBe(false);
    await killServer(defaultSock);
  }, 60_000);

  it("d) separator: with tmux printing tabs as `_` provenance, adoption and listing still work; a `|:|` cwd lists right; a `shell|:|x` tag is refused", async () => {
    const { listLiveTmuxSessions } = await import("../bridge/sessions.ts");
    const pipeDir = join(WORK, "a|:|b");
    mkdirSync(pipeDir, { recursive: true });
    await shellSpawn("r1a19-d");
    await shellSpawn("r1a19-dpipe", pipeDir);
    await shellSpawn("r1a19-dx");
    raw(tandemSock, ["set-option", "-t", "=ccm-r1a19-dx:", "@tandem_engine", "shell|:|x"]);
    const shimDir = mkdtempSync(join(tmpdir(), "r1a19-shim-"));
    extraDirs.push(shimDir);
    writeFileSync(
      join(shimDir, "tmux"),
      [
        "#!/bin/sh",
        `out=$(${shq(REAL_TMUX)} "$@")`,
        "rc=$?",
        `[ -n "$out" ] && printf '%s\\n' "$out" | tr '\\t' '_'`,
        "exit $rc",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    try {
      expect(await readSessionProvenance("r1a19-d")).toEqual({ engine: "shell", owner: OWNER });
      const adopted = await TerminalSession.attachExisting("r1a19-d", [WORK], SHELL_DESCRIPTOR, owner);
      expect(adopted?.name).toBe("r1a19-d");
      const listed = await listLiveTmuxSessions({ ownerIdProvider: owner });
      const byName = Object.fromEntries(listed.map((s) => [s.name, s]));
      expect(byName["r1a19-d"]).toMatchObject({ engine: "shell", cwd: realpathSync(WORK) });
      expect(byName["r1a19-dpipe"]).toMatchObject({ engine: "shell", cwd: realpathSync(pipeDir) });
      expect(await readSessionProvenance("r1a19-dx")).toEqual({ engine: "", owner: "" });
      expect(await TerminalSession.attachExisting("r1a19-dx", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
      expect(byName["r1a19-dx"]).toBeUndefined();
    } finally {
      process.env.PATH = savedPath;
    }
  }, 60_000);

  it("e) real adoption through route(): open, drop from the registry, GET /sessions lists it, open again reuses it", async () => {
    const { routeForTest } = await import("../bridge/router.ts");
    const { unregisterLive } = await import("../bridge/sessions.ts");
    const { applyLimits } = await import("../bridge/limits.ts");
    const { agentEntry, writeLimits } = await import("./fixtures/limits.ts");
    const { loadedHarnesses, resetHarnessCache } = await import("../bridge/engine-registry.ts");
    vi.stubEnv("TANDEM_ENABLED_ENGINES", "shell");
    vi.stubEnv("PATH", `/usr/bin:/bin:${process.env.PATH ?? ""}`);
    resetHarnessCache();
    writeLimits(testEnv.tandemHome, { folders: [WORK], shell: true, agents: { shell: agentEntry(loadedHarnesses().get("shell")!) } });
    applyLimits();
    const name = "r1a19-e";
    try {
      const opened = await routeForTest("POST", "/sessions/open", { name, engine: "shell", cwd: WORK });
      expect(opened.status).toBe(200);
      expect(raw(tandemSock, ["has-session", "-t", `=ccm-${name}`]).status).toBe(0);
      unregisterLive(name);
      const listed = await routeForTest("GET", "/sessions");
      expect(listed.status).toBe(200);
      const rows = (listed.body as { sessions: { id: string; engine: string; attachHint: string }[] }).sessions;
      expect(rows.find((s) => s.id === name)).toMatchObject({ engine: "shell", attachHint: `tmux -S ${shq(tandemSock)} attach -t '=ccm-${name}'` });
      const again = await routeForTest("POST", "/sessions/open", { name, engine: "shell", cwd: WORK });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ name, engine: "shell", reused: true });
      const after = await routeForTest("GET", "/sessions");
      expect((after.body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toContain(name);
      expect((await routeForTest("POST", `/sessions/${name}/close`)).status).toBe(200);
    } finally {
      unregisterLive(name);
      vi.unstubAllEnvs();
      resetHarnessCache();
    }
  }, 60_000);

  it("f) a correctly tagged ccm-r1a19-x on the DEFAULT socket is never listed or adopted", async () => {
    const { listLiveTmuxSessions } = await import("../bridge/sessions.ts");
    expect(raw("", ["new-session", "-d", "-s", "ccm-r1a19-x", "-c", WORK, "sleep", "600"]).status).toBe(0);
    raw("", ["set-option", "-t", "=ccm-r1a19-x:", "@tandem_engine", "shell"]);
    raw("", ["set-option", "-t", "=ccm-r1a19-x:", "@tandem_owner", OWNER]);
    try {
      expect((await listLiveTmuxSessions({ ownerIdProvider: owner })).map((s) => s.name)).not.toContain("r1a19-x");
      expect(await TerminalSession.exists("r1a19-x")).toBe(false);
      expect(await TerminalSession.attachExisting("r1a19-x", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
    } finally {
      await killServer(defaultSock);
    }
  }, 30_000);

  describe("g) retry", () => {
    const spawnError = (code: string) => Object.assign(new Error(`spawn tmux ${code}`), { code });
    it("EAGAIN twice then success: one result after 3 calls, each with -S <socket> first and no bridge secret", async () => {
      const seen: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [];
      vi.stubEnv("TANDEM_OWNER_PASSWORD", "r1a19-secret");
      try {
        const exec: TmuxExec = (argv, opts, cb) => {
          seen.push({ argv, env: opts.env });
          if (seen.length <= 2) cb(spawnError("EAGAIN"), "", "");
          else cb(null, "ok\n", "");
        };
        expect(await runTmux(["list-sessions"], exec)).toBe("ok\n");
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toHaveLength(3);
      for (const call of seen) {
        expect(call.argv).toEqual(["-S", tandemSock, "list-sessions"]);
        expect(call.env?.TANDEM_OWNER_PASSWORD).toBeUndefined();
      }
    });
    it("EAGAIN four times: throws after 4 calls", async () => {
      let n = 0;
      const exec: TmuxExec = (_argv, _opts, cb) => { n++; cb(spawnError("EAGAIN"), "", ""); };
      await expect(runTmux(["list-sessions"], exec)).rejects.toThrow(/EAGAIN/);
      expect(n).toBe(4);
    });
    it("a tmux that ran and exited non-zero: 1 call", async () => {
      let n = 0;
      const exec: TmuxExec = (_argv, _opts, cb) => { n++; cb(Object.assign(new Error("Command failed"), { code: 1 }), "", "no server running"); };
      await expect(runTmux(["list-sessions"], exec)).rejects.toThrow(/no server running/);
      expect(n).toBe(1);
    });
  });

  for (const shell of HINT_SHELLS) {
    it.skipIf(!existsSync(shell))(`h) attachHint() with a socket path holding ' reaches that exact session when pasted into ${shell}`, async () => {
      mkdirSync(join(quoteHome, "tmux"), { recursive: true, mode: 0o700 });
      if (raw(quoteSock, ["has-session", "-t", "=ccm-r1a19-q"]).status !== 0) {
        expect(raw(quoteSock, ["new-session", "-d", "-s", "ccm-r1a19-q", "-c", WORK, "sleep", "600"]).status).toBe(0);
      }
      const hint = await withTandemHome(quoteHome, async () => new Ctor("r1a19-q", WORK, join(testEnv.tmuxTmp, "q.log"), SHELL_DESCRIPTOR).attachHint());
      expect(hint).toBe(`tmux -S ${shq(quoteSock)} attach -t '=ccm-r1a19-q'`);
      expect(pasteHint(shell, hint, testEnv.tmuxTmp)).toBe("ccm-r1a19-q");
    });
  }

  // ---- U-R1A-19-R1 audit (independent auditor): one table per attack --------------------------
  describe("U-R1A-19-R1 audit", () => {
    const newHome = (label = "r-") => mkdtempSync(join(testEnv.tmuxTmp, label));
    /** A stand-in exec that records argv and succeeds: proves whether the runner reached tmux at all. */
    const recorder = (calls: string[][]): TmuxExec => (argv, _opts, cb) => { calls.push(argv); cb(null, "", ""); };
    /** The real tmux through the runner's seam, counting calls. */
    const counting = (count: { n: number }): TmuxExec => (argv, opts, cb) => {
      count.n++;
      execFile(REAL_TMUX, argv, opts, (e, so, se) => cb(e as (Error & { code?: unknown }) | null, String(so), String(se)));
    };
    const listed = async () => (await import("../bridge/sessions.ts")).listLiveTmuxSessions({ ownerIdProvider: owner });
    const tagged = (name: string, cwd: string, engine: string, ownerTag: string) => {
      expect(raw(tandemSock, ["new-session", "-d", "-s", `ccm-${name}`, "-c", cwd, "sleep", "600"]).status).toBe(0);
      expect(raw(tandemSock, ["set-option", "-t", `=ccm-${name}:`, "@tandem_engine", engine]).status).toBe(0);
      expect(raw(tandemSock, ["set-option", "-t", `=ccm-${name}:`, "@tandem_owner", ownerTag]).status).toBe(0);
    };

    const mode = (m: number) => (th: string) => { mkdirSync(join(th, "tmux")); chmodSync(join(th, "tmux"), m); };
    const folderRows: [string, (th: string) => void, RegExp | null][] = [
      ["tmux/ 0770", mode(0o770), /group\/world/],
      ["tmux/ 0750", mode(0o750), /group\/world/],
      ["tmux/ 0701", mode(0o701), /group\/world/],
      ["tmux/ 0777", mode(0o777), /group\/world/],
      ["tmux/ 0755", mode(0o755), /group\/world/],
      ["tmux/ a symlink to a 0700 folder", (th) => { mkdirSync(join(th, "real"), { mode: 0o700 }); symlinkSync(join(th, "real"), join(th, "tmux")); }, /a symlink/],
      ["tmux/ a dangling symlink", (th) => symlinkSync(join(th, "gone"), join(th, "tmux")), /a symlink/],
      ["tmux/ a regular file", (th) => writeFileSync(join(th, "tmux"), ""), /not a folder/],
      ["tmux/ already 0700", mode(0o700), null],
      ["tmux/ missing", () => {}, null],
    ];
    it.each(folderRows)("1) socket folder, %s", async (_label, setup, refused) => {
      const th = newHome();
      setup(th);
      const before = snapshot(th);
      const calls: string[][] = [];
      await withTandemHome(th, async () => {
        if (refused) {
          const err = await runTmux(["list-sessions"], recorder(calls)).catch((e) => e as Error);
          expect(String(err)).toMatch(refused);
          expect(String(err)).toContain(join(th, "tmux"));
          expect(calls).toEqual([]);
          expect(snapshot(th)).toEqual(before);
        } else {
          await runTmux(["list-sessions"], recorder(calls));
          expect(calls).toEqual([["-S", join(th, "tmux", "tandem"), "list-sessions"]]);
          expect(snapshot(th)).toEqual(["tmux d 700"]);
        }
      });
    });

    it("1) socket folder: a missing TANDEM_HOME is made 0700 with tmux/ 0700; a folder of another user is refused", async () => {
      const th = join(newHome(), "new home");
      const calls: string[][] = [];
      await withTandemHome(th, () => runTmux(["list-sessions"], recorder(calls)));
      expect(lstatSync(th).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(th, "tmux")).mode & 0o777).toBe(0o700);
      expect(calls).toHaveLength(1);
      const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        await withTandemHome(th, async () => {
          await expect(runTmux(["list-sessions"], recorder(calls))).rejects.toThrow(/not owned by this user/);
        });
      } finally {
        spy.mockRestore();
      }
      expect(calls).toHaveLength(1);
    });

    it("1) socket folder: behind a symlinked TANDEM_HOME the real tmux/ is still checked", async () => {
      const real = newHome();
      const link = `${real}-link`;
      symlinkSync(real, link);
      const calls: string[][] = [];
      await withTandemHome(link, async () => {
        await runTmux(["list-sessions"], recorder(calls));
        expect(calls).toEqual([["-S", join(link, "tmux", "tandem"), "list-sessions"]]);
        expect(lstatSync(join(real, "tmux")).mode & 0o777).toBe(0o700);
        chmodSync(join(real, "tmux"), 0o755);
        await expect(runTmux(["list-sessions"], recorder(calls))).rejects.toThrow(/group\/world/);
        expect(lstatSync(join(real, "tmux")).mode & 0o777).toBe(0o755);
      });
      expect(calls).toHaveLength(1);
    });

    it("1) socket path: `..`, a space and unicode resolve and work with real tmux; exactly 100 bytes works, 101 is refused", async () => {
      const base = newHome();
      const odd = join(base, "sp ace-ü");
      expect(tmuxSocketPath(join(base, "a", "..", "sp ace-ü"))).toBe(join(odd, "tmux", "tandem"));
      const fixed = Buffer.byteLength(join(base, "x", "tmux", "tandem")) - 1;
      expect(fixed).toBeLessThan(100);
      const at100 = join(base, "p".repeat(100 - fixed));
      expect(Buffer.byteLength(tmuxSocketPath(at100))).toBe(100);
      expect(() => tmuxSocketPath(`${at100}p`)).toThrow(/tmux socket path too long/);
      // Bytes, not characters: the same count of 2-byte letters is over.
      expect(() => tmuxSocketPath(join(base, "ü".repeat(100 - fixed)))).toThrow(/tmux socket path too long/);
      for (const [th, name] of [[join(base, "a", "..", "sp ace-ü"), "r1a19-odd"], [at100, "r1a19-len"]] as const) {
        const sock = tmuxSocketPath(th);
        try {
          await withTandemHome(th, () => shellSpawn(name));
          expect(raw(sock, ["has-session", "-t", `=ccm-${name}`]).status).toBe(0);
          expect(statSync(sock).mode & 0o077).toBe(0);
        } finally {
          await killServer(sock);
        }
      }
    }, 60_000);

    it("1) socket file: a stale socket (its server killed) lists nothing and a spawn starts a working server on it", async () => {
      const th = newHome();
      const sock = join(th, "tmux", "tandem");
      mkdirSync(join(th, "tmux"), { mode: 0o700 });
      expect(raw(sock, ["new-session", "-d", "-s", "r1a19-old", "sleep", "600"]).status).toBe(0);
      // This test's own server, the one it started on its own socket one line up.
      process.kill(Number(raw(sock, ["display-message", "-p", "#{pid}"]).stdout.trim()), "SIGKILL");
      const deadline = Date.now() + 5_000;
      while (raw(sock, ["list-sessions"]).status === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(sock)).toBe(true);
      try {
        await withTandemHome(th, async () => {
          expect(await listed()).toEqual([]);
          await shellSpawn("r1a19-stale");
        });
        expect(raw(sock, ["has-session", "-t", "=ccm-r1a19-stale"]).status).toBe(0);
      } finally {
        await killServer(sock);
      }
    }, 30_000);

    it("1) socket folder: eight bridges starting at once end with one 0700 folder and no refusal", async () => {
      const th = join(newHome(), "fresh");
      const url = new URL("../bridge/terminal-session.ts", import.meta.url).href;
      const script = `import(${JSON.stringify(url)}).then((m) => m.tmux(["list-sessions"])).then(() => console.log("ran"), (e) => console.log(/refused|EEXIST|ENOENT: /.test(String(e)) ? String(e) : "ran"))`;
      const kids = await Promise.all(
        Array.from({ length: 8 }, () => new Promise<string>((done) => {
          execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: cleanEnv({ TANDEM_HOME: th }) }, (_e, out, err) => done(String(out).trim() || String(err)));
        })),
      );
      expect(kids).toEqual(Array(8).fill("ran"));
      expect(snapshot(th).filter((l) => !l.endsWith(" s 600") && !l.startsWith("tmux/tandem "))).toEqual(["tmux d 700"]);
    }, 60_000);

    it("2) isolation: with TMUX naming the default server, a tagged same-name session there is never listed, adopted, typed into or closed", async () => {
      expect(raw("", ["new-session", "-d", "-s", "ccm-r1a19-iso", "-c", WORK, "cat"]).status).toBe(0);
      raw("", ["set-option", "-t", "=ccm-r1a19-iso:", "@tandem_engine", "shell"]);
      raw("", ["set-option", "-t", "=ccm-r1a19-iso:", "@tandem_owner", OWNER]);
      const state = () => raw("", ["display-message", "-p", "-t", "=ccm-r1a19-iso:", "#{session_name} #{@tandem_engine} #{@tandem_owner} #{session_activity} #{history_size}"]).stdout +
        raw("", ["capture-pane", "-p", "-t", "=ccm-r1a19-iso:"]).stdout;
      const before = state();
      expect(before).toContain(`ccm-r1a19-iso shell ${OWNER}`);
      const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
      process.env.TMUX = `${defaultSock},${process.pid},0`;
      process.env.TMUX_PANE = "%0";
      try {
        expect((await listed()).map((s) => s.name)).not.toContain("r1a19-iso");
        expect(await TerminalSession.exists("r1a19-iso")).toBe(false);
        expect(await TerminalSession.attachExisting("r1a19-iso", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
        const mine = await shellSpawn("r1a19-iso");
        expect(raw(tandemSock, ["has-session", "-t", "=ccm-r1a19-iso"]).status).toBe(0);
        await mine.send("echo r1a19-typed");
        await mine.interrupt();
        await mine.close();
        expect(raw(tandemSock, ["has-session", "-t", "=ccm-r1a19-iso"]).status).not.toBe(0);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      expect(raw("", ["has-session", "-t", "=ccm-r1a19-iso"]).status).toBe(0);
      expect(state()).toBe(before);
      await killServer(defaultSock);
    }, 60_000);

    it("3) secrets: all three leave a running Tandem server before a new session and reach no pane, argv, error or attach hint", async () => {
      const th = newHome();
      const sock = join(th, "tmux", "tandem");
      mkdirSync(join(th, "tmux"), { mode: 0o700 });
      // Invented values, built here so no literal in this file looks like a real one.
      const secrets: Record<string, string> = Object.fromEntries(
        ["TANDEM_OWNER_PASSWORD", "TANDEM_HUB_LINK_TOKEN", "TANDEM_FLEET_TOKEN"].map((k) => [k, `r1a19-${k.toLowerCase()}-value`]),
      );
      expect(raw(sock, ["new-session", "-d", "-s", "r1a19-pre3", "sleep", "600"], secrets).status).toBe(0);
      for (const v of Object.values(secrets)) expect(raw(sock, ["show-environment", "-g"]).stdout).toContain(`=${v}`);
      for (const [k, v] of Object.entries(secrets)) vi.stubEnv(k, v);
      const seen: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
      const spy: TmuxExec = (argv, opts, cb) => {
        seen.push({ argv, env: opts.env });
        execFile(REAL_TMUX, argv, opts, (e, so, se) => cb(e as (Error & { code?: unknown }) | null, String(so), String(se)));
      };
      try {
        await withTandemHome(th, async () => {
          await shellSpawn("r1a19-sec");
          const err = (await runTmux(["no-such-command-r1a19"], spy).catch((e) => e)) as Error;
          expect(err).toBeInstanceOf(Error);
          const dup = (await runTmux(["new-session", "-d", "-s", "ccm-r1a19-sec"], spy).catch((e) => e)) as Error;
          expect(String(dup)).toMatch(/duplicate session/);
          const hint = new Ctor("r1a19-sec", WORK, join(th, "s.log"), SHELL_DESCRIPTOR).attachHint();
          const text = [String(err), err.stack, JSON.stringify(err), String(dup), dup.stack, hint, JSON.stringify(seen.map((s) => s.argv))].join("\n");
          for (const v of Object.values(secrets)) expect(text).not.toContain(v);
          for (const call of seen) for (const k of Object.keys(secrets)) expect(call.env[k]).toBeUndefined();
        });
        const globals = raw(sock, ["show-environment", "-g"]).stdout;
        for (const [k, v] of Object.entries(secrets)) {
          expect(globals).not.toContain(v);
          expect(globalNames(sock)).not.toContain(k);
          expect(await paneValue(sock, "r1a19-sec", k)).toBe("");
          expect(process.env[k]).toBe(v);
        }
      } finally {
        vi.unstubAllEnvs();
        await killServer(sock);
      }
    }, 60_000);

    const spawnError = (code: string) => Object.assign(new Error(`spawn tmux ${code}`), { code });
    it.each(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"])("4) runner: %s is retried 3 times, waiting 50, 100 then 150 ms", async (code) => {
      let n = 0;
      const exec: TmuxExec = (_argv, _opts, cb) => { n++; cb(spawnError(code), "", ""); };
      const timers = vi.spyOn(globalThis, "setTimeout");
      let waits: unknown[];
      try {
        await expect(runTmux(["new-session", "-d", "-s", "ccm-r1a19-never"], exec)).rejects.toThrow(code);
      } finally {
        waits = timers.mock.calls.map((c) => c[1]);
        timers.mockRestore();
      }
      expect(n).toBe(4);
      expect(waits).toEqual([50, 100, 150]);
    });
    it.each(["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])("4) runner: %s is not retried", async (code) => {
      let n = 0;
      const exec: TmuxExec = (_argv, _opts, cb) => { n++; cb(spawnError(code), "", ""); };
      await expect(runTmux(["new-session", "-d", "-s", "ccm-r1a19-never"], exec)).rejects.toThrow(code);
      expect(n).toBe(1);
    });
    it("4) runner: a real new-session that exits non-zero runs once; shell text in argv reaches tmux as text", async () => {
      const th = newHome();
      const sock = join(th, "tmux", "tandem");
      const count = { n: 0 };
      const marker = join(th, "pwned");
      try {
        await withTandemHome(th, async () => {
          await runTmux(["new-session", "-d", "-s", "ccm-r1a19-dup", "sleep", "600"], counting(count));
          count.n = 0;
          await expect(runTmux(["new-session", "-d", "-s", "ccm-r1a19-dup", "sleep", "600"], counting(count))).rejects.toThrow(/duplicate session/);
          expect(count.n).toBe(1);
          const text = `$(touch ${marker}); \`touch ${marker}\` | touch ${marker} > ${marker}`;
          expect(await runTmux(["display-message", "-p", "-t", "=ccm-r1a19-dup:", text])).toBe(`${text}\n`);
        });
        expect(existsSync(marker)).toBe(false);
        expect(raw(sock, ["list-sessions", "-F", "#{session_name}"]).stdout).toBe("ccm-r1a19-dup\n");
      } finally {
        await killServer(sock);
      }
    }, 30_000);

    it("5) separator: a tag holding a tab, newline, `_`, unicode or the separator is never adopted or listed; a name cannot stand in for a tag", async () => {
      const rows: [string, string, string][] = [
        ["t0", "shell\tx", OWNER],
        ["t1", "shell\nx", OWNER],
        ["t2", "shell\n", OWNER],
        ["t3", "shell_", OWNER],
        ["t4", "shéll", OWNER],
        ["t5", `shell|:|${OWNER}`, ""],
        ["t6", "", `shell|:|${OWNER}`],
        ["t7", "shell|:", `|${OWNER}`],
        ["t8", "shell", `${OWNER}\n`],
        ["t9", "shell", `${OWNER}\t`],
        ["t10", "shell", `${OWNER}|:|`],
        ["t11", "shell", `x\n${OWNER}`],
      ];
      for (const [n, engine, ownerTag] of rows) tagged(`r1a19-${n}`, WORK, engine, ownerTag);
      tagged("r1a19-good", WORK, "shell", OWNER);
      // Names that mimic tags: the separator cannot survive in a name, and a name is never a tag.
      raw(tandemSock, ["new-session", "-d", "-s", `ccm-shell|:|${OWNER}`, "-c", WORK, "sleep", "600"]);
      raw(tandemSock, ["new-session", "-d", "-s", "ccm-shell", "-c", WORK, "sleep", "600"]);
      const names = (await listed()).map((s) => s.name);
      expect(names).toContain("r1a19-good");
      for (const [n] of rows) {
        expect(names, n).not.toContain(`r1a19-${n}`);
        expect(await TerminalSession.attachExisting(`r1a19-${n}`, [WORK], SHELL_DESCRIPTOR, owner), n).toBeUndefined();
      }
      expect(names.filter((n) => n.startsWith("shell"))).toEqual([]);
      expect(await TerminalSession.attachExisting("shell", [WORK], SHELL_DESCRIPTOR, owner)).toBeUndefined();
      // A real shell session is not adopted as another engine.
      expect(await TerminalSession.attachExisting("r1a19-good", [WORK], CODEX_DESCRIPTOR, owner)).toBeUndefined();
      expect(await TerminalSession.attachExisting("r1a19-good", [WORK], CLAUDE_DESCRIPTOR, owner)).toBeUndefined();
      expect((await TerminalSession.attachExisting("r1a19-good", [WORK], SHELL_DESCRIPTOR, owner))?.name).toBe("r1a19-good");
    }, 60_000);

    it("5) separator: a folder name holding a newline cannot forge a row for another session", async () => {
      const outside = join(testEnv.tmuxTmp, "outside");
      mkdirSync(outside);
      tagged("r1a19-vic", outside, "shell", OWNER);
      const forged = join(WORK, `x\nccm-r1a19-vic|:|123|:|${realpathSync(WORK)}`);
      mkdirSync(forged, { recursive: true });
      tagged("r1a19-evil", forged, "shell", OWNER);
      const rows = await listed();
      expect(rows.filter((s) => s.name === "r1a19-vic").map((s) => s.cwd)).toEqual([realpathSync(outside)]);
      expect(rows.filter((s) => s.name === "r1a19-evil")).toHaveLength(1);
    }, 30_000);

    const hostile = ["sp ace", "it's", "$(touch PWNED)", "`touch PWNED`", "$HOME", "a;touch PWNED;b", "nl\nx", 'dq"x', "back\\slash", "*", "~", "a&b|c>PWNED", "-o x"];
    for (const shell of HINT_SHELLS) {
      it.skipIf(!existsSync(shell))(`6) attach hint: hostile socket paths reach tmux as one exact argument when pasted into ${shell}`, () => {
        const dir = newHome("h-");
        const shim = join(dir, "shim");
        writeFileSync(shim, "#!/bin/sh\nprintf '%s\\037' \"$@\"\n", { mode: 0o700 });
        const saved = process.env.TANDEM_HOME;
        try {
          for (const h of hostile) {
            const th = join(testEnv.tmuxTmp, h);
            process.env.TANDEM_HOME = th;
            const hint = new Ctor("r1a19-h", WORK, join(dir, "h.log"), SHELL_DESCRIPTOR).attachHint();
            const out = execFileSync(shell, ["-c", shq(shim) + hint.slice("tmux".length)], { cwd: dir, encoding: "utf8" });
            expect(out.split("\x1f").slice(0, -1), `${shell}: ${hint}`).toEqual(["-S", join(th, "tmux", "tandem"), "attach", "-t", "=ccm-r1a19-h"]);
          }
        } finally {
          process.env.TANDEM_HOME = saved;
        }
        expect(readdirSync(dir)).toEqual(["shim"]);
      });
    }
  });
});
