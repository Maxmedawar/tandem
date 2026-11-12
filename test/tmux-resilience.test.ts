/**
 * U-R1A-19B: tmux resilience ported from Synergy's R0 bridge (m-step1-synergy bridge/tmux.ts,
 * test/tmux-resilience.test.ts, test/tmux-retry.test.ts, test/terminal-session.test.ts,
 * test/security-fixes.test.ts). Every tmux failure is told apart once, in the one runner: no
 * server, no session, a call that failed while the server is up, a timeout. A passing failure
 * (call failed or timeout) answers 503 `{"error":"tmux_busy"}` and types nothing; a gone session
 * keeps today's answer and types nothing.
 *
 * Real tmux on Tandem's own socket under a temp TANDEM_HOME. A pass-through mock of
 * node:child_process records every tmux call (argv and options) and, when `h.fail(argv)` returns a
 * fault, answers with it instead of running tmux; `h.after(argv, rc)` runs right after a real call.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
// ---- SETUP START (BASE names only: copied to the (1b) base file) ----
import { TerminalSession, tmuxSocketPath } from "../bridge/terminal-session.ts";
import { SHELL_DESCRIPTOR } from "../bridge/drivable.ts";
import { TerminalAdapterSession } from "../bridge/engines/terminal-adapter.ts";
import { route, routeForTest } from "../bridge/router.ts";
import { getLive, registerLive, unregisterLive } from "../bridge/sessions.ts";

// Runs before the imports above are evaluated: the bridge modules read HOME, TANDEM_HOME and
// TANDEM_WAIT_MS at load. Temp folders keep every file and the tmux socket out of the real ~/.tandem.
const testEnv = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "r1a19b-"));
  process.env.HOME = home;
  process.env.TANDEM_WAIT_MS = "8000";
  delete process.env.TANDEM_NTFY_TOPIC;
  delete process.env.TANDEM_DONE_WEBHOOK;
  if (os.homedir() !== home) throw new Error("HOME override did not take; refusing to touch the real ~/.tandem");
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const tandemHome = fs.mkdtempSync(path.join(os.tmpdir(), "r1a19b-"));
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "r1a19b-"));
  const work = path.join(box, "work");
  fs.mkdirSync(work);
  process.env.TANDEM_HOME = tandemHome;
  process.env.TANDEM_ENABLED_ENGINES = "shell";
  return { home, tandemHome, box, work };
});

type Fault = { code: number | string | null; stderr: string; killed?: boolean; signal?: string | null; deliver?: boolean } | { stdout: string };
type Call = { argv: string[]; opts: Record<string, unknown>; rc?: unknown };
const h = vi.hoisted(() => ({
  log: [] as { argv: string[]; opts: Record<string, unknown>; rc?: unknown }[],
  fail: undefined as undefined | ((argv: string[]) => unknown),
  after: undefined as undefined | ((argv: string[], rc: unknown) => void),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (file !== "tmux") return (real.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    const [args, opts, cb] = rest as [string[], Record<string, unknown>, (e: unknown, so: string, se: string) => void];
    const entry: Call = { argv: [...args], opts };
    h.log.push(entry);
    const fault = h.fail?.(entry.argv) as Fault | undefined;
    if (fault) {
      entry.rc = "fault";
      const answer = () => {
        if ("stdout" in fault) return cb(null, fault.stdout, "");
        const e = Object.assign(new Error(`Command failed: tmux ${args.join(" ")}`), {
          code: fault.code,
          killed: fault.killed ?? false,
          signal: fault.signal ?? null,
        });
        cb(e, "", fault.stderr);
      };
      // `deliver`: the real tmux runs first (its keys reach the pane), then the call is reported as failed.
      if ("deliver" in fault && fault.deliver) return real.execFile("tmux", args, opts as Parameters<typeof real.execFile>[2], answer);
      process.nextTick(answer);
      return {};
    }
    return real.execFile("tmux", args, opts as Parameters<typeof real.execFile>[2], (e, so, se) => {
      entry.rc = e ? ((e as { code?: unknown }).code ?? "error") : 0;
      h.after?.(entry.argv, entry.rc);
      cb(e, String(so), String(se));
    });
  }) as unknown as typeof real.execFile;
  return { ...real, execFile, default: { ...real, execFile } };
});

const WORK = testEnv.work;
const sock = (): string => tmuxSocketPath();
/** Out-of-band tmux on Tandem's socket (not through the bridge, not recorded). */
const tx = (...args: string[]) => {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return spawnSync("tmux", ["-S", sock(), ...args], { encoding: "utf8", env });
};
const alive = (name: string): boolean => tx("has-session", "-t", `=ccm-${name}`).status === 0;
const paneOf = (name: string): string => tx("capture-pane", "-p", "-t", `=ccm-${name}:`).stdout ?? "";
/** The tmux command of a recorded argv: after `-S <socket>` and a `-N`. */
const cmdOf = (argv: string[]): string => {
  const rest = argv[0] === "-S" ? argv.slice(2) : argv;
  return rest[0] === "-N" ? rest[1]! : rest[0]!;
};
const sendKeysSince = (mark: number): Call[] => h.log.slice(mark).filter((c) => cmdOf(c.argv) === "send-keys");
const spawned: TerminalSession[] = [];
const spawnShell = async (name: string): Promise<TerminalSession> => {
  const s = await TerminalSession.spawn({
    name,
    cwd: WORK,
    allowlist: [WORK],
    descriptor: SHELL_DESCRIPTOR,
    ownerIdProvider: async () => "r1a19b-owner",
  });
  spawned.push(s);
  return s;
};
const ownerReq = (method: string, path: string, body: Record<string, unknown> = {}, q = "") => routeForTest(method, path, body, q);
const agentReq = (method: string, path: string, body: Record<string, unknown> = {}) =>
  route({ method, path, query: new URLSearchParams(), body, from: "agent" });
const BUSY = { code: 1, stderr: "server exited unexpectedly\n" };
const TIMEOUT = { killed: true, signal: "SIGKILL", code: null, stderr: "" };
const isHas = (name: string) => (argv: string[]) => cmdOf(argv) === "has-session" && argv.includes(`=ccm-${name}`);

afterEach(() => {
  h.fail = undefined;
  h.after = undefined;
});
afterAll(async () => {
  h.fail = undefined;
  h.after = undefined;
  for (const s of spawned.splice(0)) await s.close().catch(() => undefined);
  for (const dir of [testEnv.tandemHome, testEnv.box]) {
    const found = spawnSync("find", [dir, "-type", "s"], { encoding: "utf8" }).stdout ?? "";
    for (const s of found.split("\n").filter(Boolean)) spawnSync("tmux", ["-S", s, "kill-server"]);
  }
  for (const dir of [testEnv.home, testEnv.tandemHome, testEnv.box]) rmSync(dir, { recursive: true, force: true });
});
// ---- SETUP END ----

import { probeAlive, readLogPage, stripAnsi, tmux as runTmux, tmuxFailureKind, type TmuxExec } from "../bridge/terminal-session.ts";
import { SendOutcomeUnknownError, SessionGoneError, TmuxBusyError } from "../bridge/drivable.ts";
import { listLiveTmuxSessions, listSessions } from "../bridge/sessions.ts";
import { callerFolder, insideTandemSession } from "../bridge/caller-tokens.ts";
import { engage, release } from "../bridge/kill-switch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A TANDEM_HOME of its own (under the test's box, so afterAll ends any server in it). */
async function withHome<T>(fn: (home: string) => Promise<T>, setup: (home: string) => void = () => {}): Promise<T> {
  const home = mkdtempSync(join(testEnv.box, "h-"));
  setup(home);
  const saved = process.env.TANDEM_HOME;
  process.env.TANDEM_HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.TANDEM_HOME = saved;
  }
}
/** setTimeout delays asked for while `fn` runs. */
async function waitsOf(fn: () => Promise<unknown>): Promise<unknown[]> {
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    await fn().catch(() => undefined);
    return timers.mock.calls.map((c) => c[1]);
  } finally {
    timers.mockRestore();
  }
}
const kindOf = (e: unknown) => (e as { tmuxFailure?: unknown }).tmuxFailure;

describe("(19B) k the runner tells every failure apart (injected TmuxExec, no real tmux)", () => {
  const exited = (stderr: string, message = "Command failed: tmux") =>
    ({ err: Object.assign(new Error(message), { code: 1 }), stderr });
  const spawnErr = (code: string, extra: Record<string, unknown> = {}) =>
    ({ err: Object.assign(new Error(`spawn tmux ${code}`), { code, ...extra }), stderr: "" });
  async function run(f: { err: Error; stderr: string }, args = ["list-sessions"]): Promise<{ e: Error; n: number }> {
    let n = 0;
    const exec: TmuxExec = (_argv, _opts, cb) => {
      n++;
      cb(f.err as Error & { code?: unknown }, "", f.stderr);
    };
    const e = await runTmux(args, exec).then(() => new Error("resolved"), (x: Error) => x);
    return { e, n };
  }

  it("(19B) k1 `no server running on <socket>` is a plain Error, no_server, 1 call", async () => {
    const { e, n } = await run(exited("no server running on /x/tmux/tandem\n"));
    expect(e).not.toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("no_server");
    expect(n).toBe(1);
  });
  it("(19B) k2 `error connecting to <socket> (No such file or directory)` is no_server", async () => {
    const { e } = await run(exited("error connecting to /x/tmux/tandem (No such file or directory)\n"));
    expect(e).not.toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("no_server");
  });
  it("(19B) k3 `error connecting to <socket> (Permission denied)` is TmuxBusyError call_failed", async () => {
    const { e } = await run(exited("error connecting to /x (Permission denied)\n"));
    expect(e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("call_failed");
  });
  it("(19B) k4 `can't find session: <name>` is a plain Error, no_session", async () => {
    const { e } = await run(exited("can't find session: ccm-x\n"));
    expect(e).not.toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("no_session");
  });
  it("(19B) k5 `server exited unexpectedly` is TmuxBusyError call_failed, 1 call", async () => {
    const { e, n } = await run(exited("server exited unexpectedly\n"));
    expect(e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("call_failed");
    expect(n).toBe(1);
  });
  it("(19B) k6 empty stderr: the message names the exit code, never error.message or the argv", async () => {
    const { e } = await run(
      exited("", "Command failed: tmux -S s new-session -e TANDEM_CALLER_TOKEN=R1A19B-SECRET"),
      ["new-session", "-d", "-s", "ccm-r1a19b-k6"],
    );
    expect(e.message).toBe("tmux new-session failed: exited with code 1");
    expect(e.message).not.toContain("R1A19B-SECRET");
    expect(e.message).not.toContain("Command failed");
  });
  it("(19B) k7 a killed call (the timeout) is TmuxBusyError timeout, `timed out after 10000 ms`, 1 call", async () => {
    const { e, n } = await run({ err: Object.assign(new Error("Command failed: tmux"), { killed: true, signal: "SIGKILL", code: null }), stderr: "" });
    expect(e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("timeout");
    expect(e.message.endsWith("timed out after 10000 ms")).toBe(true);
    expect(n).toBe(1);
  });
  it("(19B) k8 spawn EAGAIN four times: TmuxBusyError call_failed after 4 calls, waits 50, 100, 150", async () => {
    let result: { e: Error; n: number } | undefined;
    const waits = await waitsOf(async () => {
      result = await run(spawnErr("EAGAIN"));
    });
    expect(result!.e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(result!.e)).toBe("call_failed");
    expect(result!.n).toBe(4);
    expect(waits).toEqual([50, 100, 150]);
  });
  it("(19B) k9 spawn ENOENT (no tmux program) is a plain Error, no_server, 1 call", async () => {
    const { e, n } = await run(spawnErr("ENOENT"));
    expect(e).not.toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("no_server");
    expect(n).toBe(1);
  });
  it("(19B) k10 spawn EACCES is TmuxBusyError call_failed, 1 call", async () => {
    const { e, n } = await run(spawnErr("EACCES"));
    expect(e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("call_failed");
    expect(n).toBe(1);
  });
  it("(19B) k11 ERR_CHILD_PROCESS_STDIO_MAXBUFFER with killed is call_failed, not timeout", async () => {
    const { e } = await run(spawnErr("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", { killed: true }));
    expect(e).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(e)).toBe("call_failed");
  });
});

describe("(19B) x permission denied is call_failed in all three callers", () => {
  const DENIED = () => ({ code: 1, stderr: `error connecting to ${sock()} (Permission denied)\n` });
  it("(19B) x1 tmuxFailureKind gives call_failed for the text, as stderr and as a message", () => {
    expect(tmuxFailureKind({ stderr: "error connecting to /x (Permission denied)\n" })).toBe("call_failed");
    expect(tmuxFailureKind(new Error("error connecting to /x (Permission denied)"))).toBe("call_failed");
    expect(tmuxFailureKind(new Error("error connecting to /x (No such file or directory)"))).toBe("no_server");
  });
  it("(19B) x2 insideTandemSession fails closed (throws: cannot tell) when list-panes says permission denied", async () => {
    h.fail = (a) => (cmdOf(a) === "list-panes" ? DENIED() : undefined);
    await expect(insideTandemSession(process.pid)).rejects.toThrow(/Permission denied/);
  });
  it("(19B) x3 the kill switch's session list throws on it (never `nothing running`)", async () => {
    h.fail = (a) => (cmdOf(a) === "list-sessions" ? DENIED() : undefined);
    try {
      await expect(engage()).rejects.toThrow(/could not be listed.*Permission denied/);
    } finally {
      h.fail = undefined;
      release();
    }
  });
  it("(19B) x4 the kill switch's session list throws with no tmux program, as before 19B (never `nothing running`)", async () => {
    h.fail = (a) => (cmdOf(a) === "list-sessions" ? ({ code: "ENOENT", stderr: "" } as unknown as Fault) : undefined);
    try {
      await expect(engage()).rejects.toThrow(/could not be listed.*ENOENT/);
    } finally {
      h.fail = undefined;
      release();
    }
  });
});

describe("(19B) p probeAlive: has-session -t =ccm-<name>", () => {
  const P = "r1a19b-p1";
  beforeAll(() => {
    expect(tx("new-session", "-d", "-s", `ccm-${P}`, "sleep", "600").status).toBe(0);
  });
  afterAll(() => {
    tx("kill-session", "-t", `=ccm-${P}`);
  });

  it("(19B) p1 a live session is alive", async () => {
    expect(await probeAlive(P)).toBe("alive");
  });
  it("(19B) p2 server up (another session alive), the name absent: gone", async () => {
    expect(alive(P)).toBe(true);
    expect(await probeAlive("r1a19b-p2")).toBe("gone");
  });
  it("(19B) p3 no server: a socket that never existed, and a server that exited with its last session: gone", async () => {
    expect(await withHome(async () => probeAlive("r1a19b-p3"))).toBe("gone");
    expect(
      await withHome(async () => {
        expect(tx("new-session", "-d", "-s", "ccm-r1a19b-p3", "sleep", "600").status).toBe(0);
        expect(tx("kill-session", "-t", "=ccm-r1a19b-p3").status).toBe(0);
        return probeAlive("r1a19b-p3");
      }, (home) => mkdirSync(join(home, "tmux"), { mode: 0o700 })),
    ).toBe("gone");
  });
  it("(19B) p4 call_failed once, then real: alive after 2 has-session calls, one 40 ms wait", async () => {
    let n = 0;
    h.fail = (a) => (isHas(P)(a) && n++ === 0 ? BUSY : undefined);
    const mark = h.log.length;
    let got: unknown;
    const waits = await waitsOf(async () => {
      got = await probeAlive(P);
    });
    expect(got).toBe("alive");
    expect(h.log.slice(mark).filter((c) => isHas(P)(c.argv))).toHaveLength(2);
    expect(waits).toEqual([40]);
  });
  it("(19B) p5 call_failed twice: TmuxBusyError after 2 calls, one 40 ms wait", async () => {
    h.fail = (a) => (isHas(P)(a) ? BUSY : undefined);
    const mark = h.log.length;
    let err: unknown;
    const waits = await waitsOf(async () => {
      err = await probeAlive(P).catch((e) => e);
    });
    expect(err).toBeInstanceOf(TmuxBusyError);
    expect(h.log.slice(mark).filter((c) => isHas(P)(c.argv))).toHaveLength(2);
    expect(waits).toEqual([40]);
  });
  it("(19B) p6 a timeout: TmuxBusyError timeout after 1 call", async () => {
    h.fail = (a) => (isHas(P)(a) ? TIMEOUT : undefined);
    const mark = h.log.length;
    const err = await probeAlive(P).catch((e) => e);
    expect(err).toBeInstanceOf(TmuxBusyError);
    expect(kindOf(err)).toBe("timeout");
    expect(h.log.slice(mark).filter((c) => isHas(P)(c.argv))).toHaveLength(1);
  });
  it("(19B) p7 the has-session argv is exactly -S <socket> has-session -t =ccm-<name>", async () => {
    const mark = h.log.length;
    await probeAlive(P);
    expect(h.log.slice(mark).map((c) => c.argv)).toEqual([["-S", sock(), "has-session", "-t", `=ccm-${P}`]]);
  });
  it("(19B) p8 has-session alive while list-sessions answers empty: alive (an incomplete list never makes a live session gone)", async () => {
    h.fail = (a) => (cmdOf(a) === "list-sessions" ? { stdout: "" } : undefined);
    expect(await listLiveTmuxSessions({ ownerIdProvider: async () => "r1a19b-owner" })).toEqual([]);
    expect(await probeAlive(P)).toBe("alive");
  });
});

describe("(19B) t typing paths: nothing is typed unless has-session said alive", () => {
  it("(19B) t1 has-session call_failed twice: send rejects TmuxBusyError, no send-keys, the pane never shows T1", async () => {
    const name = "r1a19b-t1";
    const s = await spawnShell(name);
    h.fail = (a) => (isHas(name)(a) ? BUSY : undefined);
    const mark = h.log.length;
    await expect(s.send("T1")).rejects.toBeInstanceOf(TmuxBusyError);
    expect(sendKeysSince(mark)).toEqual([]);
    h.fail = undefined;
    expect(paneOf(name)).not.toContain("T1");
  }, 30_000);
  it("(19B) t2 the same for interrupt(): rejects TmuxBusyError, no send-keys", async () => {
    const name = "r1a19b-t2";
    const s = await spawnShell(name);
    h.fail = (a) => (isHas(name)(a) ? BUSY : undefined);
    const mark = h.log.length;
    await expect(s.interrupt()).rejects.toBeInstanceOf(TmuxBusyError);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) t3 the session killed out of band: send rejects SessionGoneError `tmux session gone: ccm-<name>`, no send-keys", async () => {
    const name = "r1a19b-t3";
    const s = await spawnShell(name);
    expect(tx("kill-session", "-t", `=ccm-${name}`).status).toBe(0);
    const mark = h.log.length;
    const err = await s.send("T3").catch((e) => e);
    expect(err).toBeInstanceOf(SessionGoneError);
    expect((err as Error).message).toBe(`tmux session gone: ccm-${name}`);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) t4 killed: interrupt() resolves, no send-keys", async () => {
    const name = "r1a19b-t4";
    const s = await spawnShell(name);
    expect(tx("kill-session", "-t", `=ccm-${name}`).status).toBe(0);
    const mark = h.log.length;
    await expect(s.interrupt()).resolves.toBeUndefined();
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) t5 prefix sibling: ccm-<x> killed, ccm-<x>-long alive: send rejects SessionGoneError, the sibling gets nothing", async () => {
    const name = "r1a19b-t5";
    const s = await spawnShell(name);
    expect(tx("kill-session", "-t", `=ccm-${name}`).status).toBe(0);
    expect(tx("new-session", "-d", "-s", `ccm-${name}-long`, "cat").status).toBe(0);
    try {
      await expect(s.send("T5_SIBLING_TEXT")).rejects.toBeInstanceOf(SessionGoneError);
      await sleep(300);
      expect(paneOf(`${name}-long`)).not.toContain("T5_SIBLING_TEXT");
    } finally {
      tx("kill-session", "-t", `=ccm-${name}-long`);
    }
  }, 30_000);
  it("(19B) t6 race: ccm-<x> dies right after the probe said alive: the send-keys to =ccm-<x>: fails, the sibling gets nothing", async () => {
    const name = "r1a19b-t6";
    const s = await spawnShell(name);
    expect(tx("new-session", "-d", "-s", `ccm-${name}-long`, "cat").status).toBe(0);
    try {
      let fired = false;
      h.after = (argv, rc) => {
        if (fired || !isHas(name)(argv) || rc !== 0) return;
        fired = true;
        tx("kill-session", "-t", `=ccm-${name}`);
      };
      const mark = h.log.length;
      await expect(s.send("T6_RACE_TEXT")).rejects.toThrow();
      expect(fired).toBe(true);
      const keys = sendKeysSince(mark);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((c) => c.rc !== 0)).toBe(true);
      expect(keys[0]!.argv).toContain(`=ccm-${name}:`);
      await sleep(300);
      expect(paneOf(`${name}-long`)).not.toContain("T6_RACE_TEXT");
    } finally {
      tx("kill-session", "-t", `=ccm-${name}-long`);
    }
  }, 30_000);
});

describe("(19B) r routes on a registered session, passing failure: 503 tmux_busy, kept, nothing typed", () => {
  const R = "r1a19b-r";
  let adapter: TerminalAdapterSession;
  const busy = { status: 503, body: { error: "tmux_busy" } };
  const unknown = { status: 500, body: { error: "send_outcome_unknown" } };
  let term: TerminalSession;
  beforeAll(async () => {
    term = await spawnShell(R);
    adapter = new TerminalAdapterSession("shell", term);
    registerLive(adapter);
  }, 30_000);
  afterAll(() => unregisterLive(R));

  it("(19B) r1 owner send, has-session call_failed twice: 503, still registered, no send-keys", async () => {
    h.fail = (a) => (isHas(R)(a) ? BUSY : undefined);
    const mark = h.log.length;
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R1" })).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) r2 agent send: the same 503 (not held by the input gate)", async () => {
    h.fail = (a) => (isHas(R)(a) ? BUSY : undefined);
    const mark = h.log.length;
    expect(await agentReq("POST", `/sessions/${R}/send`, { text: "R2" })).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) r3 GET read: 503, still registered", async () => {
    h.fail = (a) => (isHas(R)(a) ? BUSY : undefined);
    expect(await ownerReq("GET", `/sessions/${R}/read`)).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r4 poll-mode send (empty text): 503", async () => {
    h.fail = (a) => (isHas(R)(a) ? BUSY : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "" })).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r5 owner interrupt: 503, no send-keys", async () => {
    h.fail = (a) => (isHas(R)(a) ? BUSY : undefined);
    const mark = h.log.length;
    expect(await ownerReq("POST", `/sessions/${R}/interrupt`, {})).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) r6 owner send with a timeout on has-session: 503", async () => {
    h.fail = (a) => (isHas(R)(a) ? TIMEOUT : undefined);
    const mark = h.log.length;
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R6" })).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
    expect(sendKeysSince(mark)).toEqual([]);
  }, 30_000);
  it("(19B) r7 the probe passes, the first send-keys runs and gets call_failed: owner send 500 send_outcome_unknown (never 503), still registered", async () => {
    h.fail = (a) => (cmdOf(a) === "send-keys" ? BUSY : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R7" })).toEqual(unknown);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r8 list-sessions answers empty, the session alive: owner send 200 and the pane shows the text", async () => {
    h.fail = (a) => (cmdOf(a) === "list-sessions" ? { stdout: "" } : undefined);
    const res = await ownerReq("POST", `/sessions/${R}/send`, { text: "echo R8_$((4+4))_OK" });
    expect(res.status).toBe(200);
    expect(paneOf(R)).toContain("R8_8_OK");
  }, 30_000);
  it("(19B) r9 a send-keys that delivers, then fails: 500 send_outcome_unknown, the text is in the pane once, nothing is sent again", async () => {
    const mark = h.log.length;
    const auditLines = () => readFileSync(join(testEnv.home, ".tandem", "bridge.log"), "utf8").split("\n").filter((l) => l.includes('"denied":"send-outcome-unknown"')).length;
    const before = auditLines();
    h.fail = (a) => (cmdOf(a) === "send-keys" && a.includes("R9_ONCE") ? { ...BUSY, deliver: true } : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R9_ONCE" })).toEqual(unknown);
    h.fail = undefined;
    expect(auditLines()).toBe(before + 1);
    await sleep(300);
    expect(sendKeysSince(mark).length).toBe(1);
    expect(paneOf(R).match(/R9_ONCE/g)?.length).toBe(1);
    expect(getLive(R)).toBe(adapter);
    tx("send-keys", "-t", `=ccm-${R}:`, "C-u");
  }, 30_000);
  it("(19B) r10 a send-keys killed by the timeout: the same 500, one send-keys", async () => {
    const mark = h.log.length;
    h.fail = (a) => (cmdOf(a) === "send-keys" ? TIMEOUT : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R10" })).toEqual(unknown);
    expect(sendKeysSince(mark).length).toBe(1);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r11 a send-keys whose tmux never started (spawn EACCES): no key reached tmux, 503 tmux_busy", async () => {
    h.fail = (a) => (cmdOf(a) === "send-keys" ? { code: "EACCES", stderr: "" } : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/send`, { text: "R11" })).toEqual(busy);
    expect(await ownerReq("POST", `/sessions/${R}/interrupt`)).toEqual(busy);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r12 owner interrupt, its send-keys run and get call_failed: 500 send_outcome_unknown, every key tried once", async () => {
    const mark = h.log.length;
    h.fail = (a) => (cmdOf(a) === "send-keys" ? BUSY : undefined);
    expect(await ownerReq("POST", `/sessions/${R}/interrupt`)).toEqual(unknown);
    expect(sendKeysSince(mark).length).toBe(2);
    expect(getLive(R)).toBe(adapter);
  }, 30_000);
  it("(19B) r13 TerminalSession.send: a send-keys that ran and failed rejects SendOutcomeUnknownError, a gone session's send-keys error stays plain", async () => {
    h.fail = (a) => (cmdOf(a) === "send-keys" ? BUSY : undefined);
    const e = await term.send("R13").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendOutcomeUnknownError);
    expect((e as SendOutcomeUnknownError).tmuxFailure).toBe("call_failed");
    expect(e).not.toBeInstanceOf(TmuxBusyError);
    h.fail = (a) => (cmdOf(a) === "send-keys" ? { code: 1, stderr: "can't find session: ccm-x\n" } : undefined);
    const g = await term.send("R13").catch((x: unknown) => x);
    expect(g).not.toBeInstanceOf(SendOutcomeUnknownError);
    expect(g).not.toBeInstanceOf(TmuxBusyError);
  }, 30_000);
});

// ---- G START (copied to the (1b) base file) ----
describe("(19B) g a gone session keeps today's answer", () => {
  const G = "r1a19b-g";
  let mark = 0;
  beforeAll(async () => {
    registerLive(new TerminalAdapterSession("shell", await spawnShell(G)));
    expect(tx("kill-session", "-t", `=ccm-${G}`).status).toBe(0);
    mark = h.log.length;
  }, 30_000);
  afterAll(() => unregisterLive(G));
  const line = (n: number, res: { status: number; body: unknown }) =>
    console.log(`G${n} ${res.status} ${JSON.stringify(res.body)} registered=${getLive(G) ? "yes" : "no"}`);
  const keys = (body: unknown) => Object.keys(body as object).sort();

  it("(19B) g1 owner send: 500 `send failed: ...`, still registered", async () => {
    const res = await ownerReq("POST", `/sessions/${G}/send`, { text: "G1" });
    line(1, res);
    expect(res.status).toBe(500);
    expect(keys(res.body)).toEqual(["error"]);
    expect((res.body as { error: string }).error.startsWith("send failed: ")).toBe(true);
    expect(getLive(G)).toBeDefined();
    expect((res.body as { error: string }).error).toBe(`send failed: tmux session gone: ccm-${G}`);
  }, 30_000);
  it("(19B) g2 agent send: 200 held, still registered", async () => {
    const res = await agentReq("POST", `/sessions/${G}/send`, { text: "G2" });
    line(2, res);
    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual(["attachHint", "engine", "name", "state", "status"]);
    expect((res.body as { status: string }).status).toBe("held");
    expect(getLive(G)).toBeDefined();
  }, 30_000);
  it("(19B) g3 GET read: 200 live, still registered", async () => {
    const res = await ownerReq("GET", `/sessions/${G}/read`);
    line(3, res);
    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual(["attachHint", "cursor", "engine", "idle", "live", "more", "state", "text"]);
    expect((res.body as { live: boolean }).live).toBe(true);
    expect(getLive(G)).toBeDefined();
  }, 30_000);
  it("(19B) g4 owner interrupt: 200 ok, still registered", async () => {
    const res = await ownerReq("POST", `/sessions/${G}/interrupt`, {});
    line(4, res);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: G, engine: "shell" });
    expect(getLive(G)).toBeDefined();
  }, 30_000);
  // ---- G BASE END ----
  it("(19B) g5 g1 to g4 together typed nothing (zero send-keys)", () => {
    expect(sendKeysSince(mark)).toEqual([]);
  });
});
// ---- G END ----

describe("(19B) l the listing tells no server apart from a call that failed", () => {
  const L = "r1a19b-l7";
  const ownerId = async () => "r1a19b-owner";
  const listFails = (a: string[]) => (cmdOf(a) === "list-sessions" ? BUSY : undefined);

  it("(19B) l1 list-sessions call_failed: listLiveTmuxSessions rejects TmuxBusyError", async () => {
    h.fail = listFails;
    await expect(listLiveTmuxSessions({ ownerIdProvider: ownerId })).rejects.toBeInstanceOf(TmuxBusyError);
  });
  it("(19B) l2 a socket that never existed: []", async () => {
    expect(await withHome(async () => listLiveTmuxSessions({ ownerIdProvider: ownerId }))).toEqual([]);
  });
  it("(19B) l3 a refused socket folder (tmux/ 0755): [], no tmux call", async () => {
    const mark = h.log.length;
    const got = await withHome(
      async () => listLiveTmuxSessions({ ownerIdProvider: ownerId }),
      (home) => {
        mkdirSync(join(home, "tmux"));
        chmodSync(join(home, "tmux"), 0o755);
      },
    );
    expect(got).toEqual([]);
    expect(h.log.length).toBe(mark);
  });
  it("(19B) l4 GET /sessions with list-sessions call_failed: 503 tmux_busy", async () => {
    h.fail = listFails;
    expect(await ownerReq("GET", "/sessions")).toEqual({ status: 503, body: { error: "tmux_busy" } });
  });
  it("(19B) l5 GET /sessions?engine=shell, the same fault: 503 tmux_busy", async () => {
    h.fail = listFails;
    expect(await ownerReq("GET", "/sessions", {}, "engine=shell")).toEqual({ status: 503, body: { error: "tmux_busy" } });
  });
  it("(19B) l6 GET /sessions, no server and nothing registered: 200 { sessions: [] }", async () => {
    const res = await withHome(async () => ownerReq("GET", "/sessions"));
    expect(res).toEqual({ status: 200, body: { sessions: [] } });
  });
  it("(19B) l7 listSessions(): list-sessions and the registered session's has-session fail: tmuxBusy, the row kept", async () => {
    registerLive(new TerminalAdapterSession("shell", await spawnShell(L)));
    h.fail = (a) => listFails(a) ?? (isHas(L)(a) ? BUSY : undefined);
    const got = await listSessions();
    expect(got.tmuxBusy).toBe(true);
    expect(got.sessions.map((s) => s.id)).toContain(L);
  }, 30_000);
  it("(19B) l8 GET /sessions, one registered live session, no fault: 200, its row, no tmuxBusy key", async () => {
    try {
      const res = await ownerReq("GET", "/sessions");
      expect(res.status).toBe(200);
      expect((res.body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toContain(L);
      expect("tmuxBusy" in (res.body as object)).toBe(false);
    } finally {
      unregisterLive(L);
    }
  }, 30_000);
});

describe("(19B) s spawn ends what it made; the 36F gap", () => {
  it("(19B) s1 the closing exit-empty on gets call_failed: spawn resolves, session alive, token kept, one stderr line", async () => {
    const name = "r1a19b-s1";
    h.fail = (a) => (a.slice(2).join(" ") === "set-option -s exit-empty on" ? BUSY : undefined);
    const writes = vi.spyOn(process.stderr, "write");
    try {
      await spawnShell(name);
      h.fail = undefined;
      const lines = writes.mock.calls.map((c) => String(c[0])).filter((t) => /exit-empty on failed after a new session \(call_failed\)/.test(t));
      expect(lines).toEqual([
        "[bridge] tmux: exit-empty on failed after a new session (call_failed); the tmux server stays up after its last session until the next open\n",
      ]);
    } finally {
      writes.mockRestore();
    }
    expect(alive(name)).toBe(true);
    expect(callerFolder(name)).toBeDefined();
    // The server keeps exit-empty off now: end it so later cases start clean.
    tx("kill-server");
  }, 30_000);
  it("(19B) s2 pipe-pane gets call_failed: spawn rejects TmuxBusyError, the session is ended, the token revoked", async () => {
    const name = "r1a19b-s2";
    h.fail = (a) => (cmdOf(a) === "pipe-pane" ? BUSY : undefined);
    await expect(spawnShell(name)).rejects.toBeInstanceOf(TmuxBusyError);
    expect(alive(name)).toBe(false);
    expect(callerFolder(name)).toBeUndefined();
  }, 30_000);
  it("(19B) s3 the warmup's probe gets call_failed twice: spawn rejects TmuxBusyError, the session is ended, the token revoked", async () => {
    const name = "r1a19b-s3";
    const mark = h.log.length;
    const made = () => h.log.slice(mark).some((c) => cmdOf(c.argv) === "new-session" && c.rc === 0);
    h.fail = (a) => (isHas(name)(a) && made() ? BUSY : undefined);
    await expect(spawnShell(name)).rejects.toBeInstanceOf(TmuxBusyError);
    h.fail = undefined;
    expect(alive(name)).toBe(false);
    expect(callerFolder(name)).toBeUndefined();
  }, 30_000);
  it("(19B) s4 new-session fails `duplicate session`: spawn rejects and never ends the other ccm-<y>", async () => {
    const name = "r1a19b-s4";
    expect(tx("new-session", "-d", "-s", `ccm-${name}`, "sleep", "600").status).toBe(0);
    try {
      h.fail = (a) => (isHas(name)(a) ? { code: 1, stderr: `can't find session: ccm-${name}\n` } : undefined);
      await expect(spawnShell(name)).rejects.toThrow(/duplicate session/);
      h.fail = undefined;
      expect(alive(name)).toBe(true);
    } finally {
      tx("kill-session", "-t", `=ccm-${name}`);
    }
  }, 30_000);
});

describe("(19B) u readLogPage never cuts a UTF-8 character at the end of the file", () => {
  let n = 0;
  const file = (bytes: Buffer): string => {
    const p = join(testEnv.box, `u${n++}.log`);
    writeFileSync(p, bytes);
    return p;
  };
  it("(19B) u1 a character cut at EOF is held back, then read whole once complete", () => {
    for (const ch of ["é", "€", "😀"]) {
      const bytes = Buffer.from(ch);
      for (let k = 1; k < bytes.length; k++) {
        const p = file(Buffer.concat([Buffer.from("ab"), bytes.subarray(0, k)]));
        expect(readLogPage(p, 0), `${ch} ${k}`).toEqual({ text: "ab", next: 2, more: false });
        appendFileSync(p, bytes.subarray(k));
        expect(readLogPage(p, 2), `${ch} ${k}`).toEqual({ text: ch, next: 2 + bytes.length, more: false });
      }
    }
  });
  it("(19B) u2 a complete character at EOF is returned whole", () => {
    expect(readLogPage(file(Buffer.from("ab€")), 0)).toEqual({ text: "ab€", next: 5, more: false });
  });
  it("(19B) u3 bytes that can never complete a character are returned as before", () => {
    expect(readLogPage(file(Buffer.from([0x61, 0x62, 0x80])), 0)).toEqual({ text: "ab�", next: 3, more: false });
    expect(readLogPage(file(Buffer.from([0x61, 0x62, 0xff])), 0)).toEqual({ text: "ab�", next: 3, more: false });
    expect(readLogPage(file(Buffer.from([0x61, 0x62, 0xe2, 0x41])), 0)).toEqual({ text: "ab�A", next: 4, more: false });
  });
  it("(19B) u4 a file holding only a cut character: nothing yet", () => {
    expect(readLogPage(file(Buffer.from([0xe2, 0x82])), 0)).toEqual({ text: "", next: 0, more: false });
  });
});

describe("(19B) y ported Synergy cases through Tandem's API", () => {
  it("(19B) y1 stripAnsi removes CSI colours, keeps text and UTF-8 glyphs", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m \x1b[1;32mworld\x1b[0m ❯ ⏵⏵")).toBe("hello world ❯ ⏵⏵");
  });
  it("(19B) y2 stripAnsi removes an OSC title and carriage returns", () => {
    const out = stripAnsi("\x1b]0;my title\x07line one\rline two\n\x1b[2Jcleared");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("cleared");
    expect(out).not.toContain("my title");
    expect(out).not.toContain("\r");
  });
  it("(19B) y3 stripAnsi removes cursor-position sequences", () => {
    expect(stripAnsi("\x1b[2;5HX\x1b[H\x1b[KY")).toBe("XY");
  });

  describe("on a real shell session", () => {
    const Y = "r1a19b-y";
    let s: TerminalSession;
    beforeAll(async () => {
      s = await spawnShell(Y);
    }, 30_000);

    it("(19B) y4 the transcript holds the shell's own evaluation of literal text", async () => {
      await s.send("echo CCM_$((1+1))_marker");
      expect((await s.readSince(0)).text).toContain("CCM_2_marker");
    }, 30_000);
    it("(19B) y5 screen() shows the output and two screens 800 ms apart are equal", async () => {
      await s.send("echo IDLE_PROBE_OK");
      expect(await s.screen()).toContain("IDLE_PROBE_OK");
      const a = (await s.screen()).trimEnd();
      await sleep(800);
      expect((await s.screen()).trimEnd()).toBe(a);
    }, 30_000);
    it("(19B) y6 C-c interrupts a running command; the next command runs", async () => {
      await s.send("sleep 30");
      await s.interrupt(["C-c"]);
      await s.send("echo AFTER_CC");
      const deadline = Date.now() + 10_000;
      let text = "";
      while (Date.now() < deadline) {
        text = (await s.readSince(0)).text;
        if ((text.match(/AFTER_CC/g) ?? []).length >= 2) break;
        await sleep(250);
      }
      expect((text.match(/AFTER_CC/g) ?? []).length).toBeGreaterThanOrEqual(2);
    }, 40_000);
    it("(19B) y7 a two-line text is one submit: the transcript holds FIRST before SECOND as one block", async () => {
      await s.send("cat <<'EOF'");
      await s.send("MLINE_FIRST_AAA\nMLINE_SECOND_BBB");
      await s.send("EOF");
      expect((await s.readSince(0)).text).toMatch(/MLINE_FIRST_AAA[\s\S]*MLINE_SECOND_BBB/);
    }, 40_000);
  });
});

describe("(19B) k12 every tmux call carries the timeout", () => {
  it("(19B) k12 every real tmux call recorded in this file has timeout 10000 and killSignal SIGKILL", () => {
    expect(h.log.length).toBeGreaterThan(0);
    const wrong = h.log.filter((c) => c.opts?.timeout !== 10_000 || c.opts?.killSignal !== "SIGKILL");
    expect(wrong.map((c) => c.argv.slice(2).join(" "))).toEqual([]);
  });
});
