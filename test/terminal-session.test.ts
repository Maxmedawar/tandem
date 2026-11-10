import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TerminalSession,
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
  return { home };
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
    expect(msg).toContain("tmux attach -t ccm-myname");
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
    box = mkdtempSync(join(tmpdir(), "tandem-tmux-"));
    sock = join(box, "sock");
    callLog = join(box, "calls.log");
    const bin = join(box, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tmux"),
      [
        "#!/bin/sh",
        "unset TMUX TMUX_PANE",
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
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
  });
  beforeEach(() => {
    writeFileSync(callLog, "");
    tx("new-session", "-d", "-s", "keeper", "sleep", "600");
  });
  afterEach(() => {
    delete process.env.TB_AFTER;
    delete process.env.TB_HOOK;
    try {
      tx("kill-server");
    } catch {
      /* already gone */
    }
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

  it("h) a relay turn ending in 'quiet' advances to the next turn and passes on its report", async () => {
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

  it("i) the target printed by attachHint() resolves to that exact session when pasted into sh, bash and zsh", () => {
    sink("i-hint");
    sink("i-hint-long");
    const hint = session("i-hint", CLAUDE_DESCRIPTOR).attachHint();
    expect(hint.startsWith("tmux attach -t ")).toBe(true);
    // Stand-in for `tmux attach`: resolve the pasted target as a session, print its name.
    const shim = join(box, "attach-shim");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        '[ "$1" = attach ] && [ "$2" = -t ] && [ $# -eq 3 ] || { echo "unexpected argv: $*" >&2; exit 2; }',
        "unset TMUX TMUX_PANE",
        `exec ${shq(REAL_TMUX)} -S ${shq(sock)} list-windows -t "$3" -F '#{session_name}'`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const cmd = shq(shim) + hint.slice("tmux".length);
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((p) => existsSync(p))) {
      expect(execFileSync(shell, ["-c", cmd], { encoding: "utf8" }).trim(), `${shell}: ${hint}`).toBe("ccm-i-hint");
    }
  });
});
