/**
 * U-R1A-18: the input gate (bridge/input-gate.ts) in route(). Who is typing decides when typed
 * input (send text, interrupt keys) may enter a session: the owner at any time except while the
 * session waits for approval; an agent only at a settled idle prompt, else its text is held.
 * Nothing in a request body changes who is typing.
 *
 * tmux runs only on a private socket: before any tmux call TMUX_TMPDIR is a new /tmp/r1a18-
 * folder and TMUX is unset, so nothing here reaches the default server where the live agents
 * run. Cleanup is `tmux -S <that folder>/tmux-<uid>/default kill-server` after `test -S`.
 * HOME and TANDEM_HOME are folders in it too, so the audit lines land there.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessTerminal } from "../bridge/engines/harness-engine.ts";
import type { CcmHttpRequestFrame } from "../hub/src/protocol.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-cli.sh", import.meta.url));
const SCREENS = fileURLToPath(new URL("./fixtures/screens/", import.meta.url));
const BUILTIN = fileURLToPath(new URL("../harnesses/", import.meta.url));
const BOX = mkdtempSync("/tmp/r1a18-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, `tmux-${process.getuid!()}`, "default");
const HOME = join(BOX, "home");
const WORK = join(BOX, "work");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");
mkdirSync(HOME);
mkdirSync(WORK);
mkdirSync(OWNER, { recursive: true });
chmodSync(OWNER, 0o700);
// Read when the router is imported or the harness files first load.
process.env.HOME = HOME;
process.env.TANDEM_HOME = TANDEM_HOME;
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_WAIT_MS = "8000";
process.env.TANDEM_ENABLED_ENGINES = "r1a18-rules,r1a18-plain,shell";
process.env.PATH = `/usr/bin:/bin:${process.env.PATH ?? ""}`;

/** fake-cli.sh's screens (as in test/engines/harness-engine.test.ts): its prompt, its slow turn, its approval question. */
const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`;
writeFileSync(join(OWNER, "r1a18-rules.toml"), `name = "r1a18-rules"\nprogram = "${FAKE}"\nhas_prompts = true\n${RULES}`, { mode: 0o600 });
writeFileSync(join(OWNER, "r1a18-plain.toml"), `name = "r1a18-plain"\nprogram = "${FAKE}"\nhas_prompts = false\n`, { mode: 0o600 });

// Red first: before bridge/input-gate.ts exists each case fails on its own instead of the file failing to load.
const gate: Partial<typeof import("../bridge/input-gate.ts")> = await import("../bridge/input-gate.ts").catch(() => ({}));
const { route } = await import("../bridge/router.ts");
const { handleHubRequest } = await import("../bridge/hub-rpc.ts");
const { HarnessSession } = await import("../bridge/engines/harness-engine.ts");
const { loadHarnesses } = await import("../bridge/harness-registry.ts");
const { readScreen } = await import("../bridge/harness-detect.ts");
const { loadedHarnesses, resetHarnessCache } = await import("../bridge/engine-registry.ts");
const { applyLimits } = await import("../bridge/limits.ts");
const { agentEntry, writeLimits } = await import("./fixtures/limits.ts");
const { CCM_FRAME_TYPES } = await import("../hub/src/protocol.ts");
const { registerLive, unregisterLive } = await import("../bridge/sessions.ts");
const { executeLocalOp } = await import("../bridge/fleet-op-table.ts");
const { buildMcpServer } = await import("../src/mcp-server.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const WAITING = "waiting_for_approval: the session waits for a person to approve or deny; nothing was typed";
const AGENT_INTERRUPT = "input gate: an agent may not interrupt a session";

type From = "owner" | "agent";
type Action = "type" | "interrupt";
type State = "idle" | "working" | "unknown" | "waiting_for_approval";
const STATES: State[] = ["idle", "working", "unknown", "waiting_for_approval"];
/** Plan section 3, written out: owner enters unless the session waits; agent text only at idle; an agent never interrupts. */
const TABLE: Record<From, Record<Action, Record<State, string>>> = {
  owner: {
    type: { idle: "enter", working: "enter", unknown: "enter", waiting_for_approval: "refused" },
    interrupt: { idle: "enter", working: "enter", unknown: "enter", waiting_for_approval: "refused" },
  },
  agent: {
    type: { idle: "enter", working: "held", unknown: "held", waiting_for_approval: "held" },
    interrupt: { idle: "refused", working: "refused", unknown: "refused", waiting_for_approval: "refused" },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pane = (name: string) => tmux("capture-pane", "-p", "-t", `=ccm-${name}:`);
const tmuxHas = (name: string) => {
  try {
    tmux("has-session", "-t", `=ccm-${name}`);
    return true;
  } catch {
    return false;
  }
};
const transcript = (name: string) => {
  const file = join(TANDEM_HOME, "transcripts", `${name}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
/** "Not typed": the token is in neither the pane nor the session's transcript. */
const notTyped = (name: string, token: string) => {
  expect(pane(name)).not.toContain(token);
  expect(transcript(name)).not.toContain(token);
};
let seq = 0;
const tok = () => `r1a18tok${++seq}x${Math.random().toString(36).slice(2, 7)}`;

const auditLog = join(HOME, ".tandem", "bridge.log");
const auditLines = (): Record<string, unknown>[] =>
  existsSync(auditLog) ? readFileSync(auditLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** Runs one router call and returns its answer with the audit lines it wrote. */
async function audited<T>(call: () => Promise<T>): Promise<{ answer: T; lines: Record<string, unknown>[] }> {
  const before = auditLines().length;
  const answer = await call();
  return { answer, lines: auditLines().slice(before) };
}

/** A route() request; `from` is set on the request object, the one place the gate reads it. */
const rq = (method: string, path: string, body: Record<string, unknown> = {}, from?: From) =>
  route({ method, path, query: new URLSearchParams(), body, ...(from ? { from } : {}) });
const sendAs = (name: string, text: string, from?: From, extra: Record<string, unknown> = {}) =>
  rq("POST", `/sessions/${name}/send`, { text, ...extra }, from);
const interruptAs = (name: string, from?: From, body: Record<string, unknown> = {}) =>
  rq("POST", `/sessions/${name}/interrupt`, body, from);

async function pollUntil(name: string, state: State, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last: any;
  while (Date.now() < deadline) {
    last = (await rq("GET", `/sessions/${name}/read`)).body;
    if (last?.agentState === state) return last;
    await sleep(250);
  }
  throw new Error(`${name}: agentState never became ${state}; last ${JSON.stringify(last)}`);
}

/** A terminal that only shows screens; anything that would type into it throws. */
function screenOnly(next: () => string): HarnessTerminal {
  const typed = (): never => {
    throw new Error("the input gate typed into the session");
  };
  return {
    name: "r1a18-stub",
    cwd: WORK,
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: typed,
    readSince: typed,
    applyControls: typed,
    interrupt: typed,
    close: async () => {},
    screen: async () => next(),
  };
}

beforeAll(() => {
  resetHarnessCache();
  const loaded = loadedHarnesses();
  const agents = Object.fromEntries(["r1a18-rules", "r1a18-plain", "shell"].map((n) => [n, agentEntry(loaded.get(n)!)]));
  writeLimits(TANDEM_HOME, { folders: [WORK], shell: true, agents });
  applyLimits();
});

afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a18 cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

describe("(a) decideInput: every from x action x state row", () => {
  const rows = (["owner", "agent"] as From[]).flatMap((from) =>
    (["type", "interrupt"] as Action[]).flatMap((action) => STATES.map((state) => [from, action, state, TABLE[from][action][state]] as const)),
  );
  it("covers 16 rows", () => expect(rows).toHaveLength(16));
  it.each(rows)("decideInput(%s, %s, %s) is %s", (from, action, state, verdict) => {
    expect(gate.decideInput!(from, action, state)).toBe(verdict);
  });
});

describe("(b) admitInput on the built-in rule files over fixture screens (nothing runs)", () => {
  const { harnesses } = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") });
  const DEBOUNCE: Record<string, number> = { claude: 2250, codex: 5000 };
  const ROWS: [string, string, State][] = [
    ["claude", "claude-idle-real", "idle"],
    ["claude", "claude-working-real", "working"],
    ["claude", "claude-waiting_for_approval-1", "waiting_for_approval"],
    ["claude", "claude-unknown-1", "unknown"],
    ["codex", "codex-idle-real", "idle"],
    ["codex", "codex-working-1", "working"],
    ["codex", "codex-waiting_for_approval-1", "waiting_for_approval"],
    ["codex", "codex-unknown-update", "unknown"],
  ];
  it.each(ROWS)("%s file over %s reads %s; owner and agent, type and interrupt, as the table", async (agent, fixture, state) => {
    const harness = harnesses.get(agent)!;
    const screen = readFileSync(join(SCREENS, `${fixture}.txt`), "utf8");
    expect(readScreen(harness, screen)).toBe(state);
    const session = new HarnessSession(harness, screenOnly(() => screen));
    expect(await session.inputState()).toEqual({ state, screen, debounceMs: DEBOUNCE[agent] });
    for (const from of ["owner", "agent"] as From[]) {
      for (const action of ["type", "interrupt"] as Action[]) {
        const started = Date.now();
        expect(await gate.admitInput!(session, from, action), `${from} ${action}`).toEqual({ verdict: TABLE[from][action][state], state });
        const took = Date.now() - started;
        // Only an agent's text at an idle screen waits, and for the file's whole debounce.
        if (from === "agent" && action === "type" && state === "idle") expect(took).toBeGreaterThanOrEqual(DEBOUNCE[agent]);
        else expect(took).toBeLessThan(240); // under one 250 ms re-read: decided on the first read
      }
    }
  }, 20_000);

  it("an agent's idle screen that changes on every read never settles: held after debounce_ms + 1000 ms", async () => {
    const rules = loadedHarnesses().get("r1a18-rules")!;
    let n = 0;
    const session = new HarnessSession(rules, screenOnly(() => `out ${++n}\nfake>`));
    const started = Date.now();
    expect(await gate.admitInput!(session, "agent", "type")).toEqual({ verdict: "held", state: "idle" });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1300);
    expect(took).toBeLessThan(2500);
  }, 10_000);

  it("an agent's idle read followed by a busy one is held; trailing whitespace is not a change", async () => {
    const rules = loadedHarnesses().get("r1a18-rules")!;
    const busy = ["fake>", "fake> slow\nfake is thinking"];
    expect(await gate.admitInput!(new HarnessSession(rules, screenOnly(() => busy.shift() ?? "fake is thinking")), "agent", "type")).toEqual({
      verdict: "held",
      state: "working",
    });
    let n = 0;
    const padded = new HarnessSession(rules, screenOnly(() => `reply: x${" ".repeat(n % 3)}\nfake>${"\n".repeat(++n % 2)}`));
    expect(await gate.admitInput!(padded, "agent", "type")).toEqual({ verdict: "enter", state: "idle" });
  }, 10_000);

  it("a session without inputState reads unknown: the owner enters, an agent is held", async () => {
    const plain = {} as object;
    expect(await gate.admitInput!(plain, "owner", "type")).toEqual({ verdict: "enter", state: "unknown" });
    expect(await gate.admitInput!(plain, "agent", "type")).toEqual({ verdict: "held", state: "unknown" });
    expect(await gate.admitInput!(plain, "agent", "interrupt")).toEqual({ verdict: "refused", state: "unknown" });
  });
});

describe("(c) through route() on the private socket", () => {
  const ENGINE = "r1a18-rules";

  it("rules agent: idle, slow and ask rows by who is typing; a body key changes nothing; the person answers", async () => {
    const name = "r1a18-rules";
    const open = await rq("POST", "/sessions/open", { engine: ENGINE, name, cwd: WORK });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ name, engine: ENGINE, ready: true });
    await pollUntil(name, "idle");

    // At idle: owner and agent text enter, and each reply shows.
    const t1 = tok();
    const owner1 = await audited(() => sendAs(name, t1, "owner"));
    expect(owner1.answer.status).toBe(200);
    expect(owner1.answer.body).toMatchObject({ status: "done", engine: ENGINE, report: expect.stringContaining(`reply: ${t1}`) });
    // An entered send writes its one send line (a completion event may add its own line).
    expect(owner1.lines.filter((l) => l.route === "POST /sessions/:name/send")).toEqual([
      expect.objectContaining({ name, from: "owner", state: "idle", textBytes: t1.length }),
    ]);
    const t2 = tok();
    const agent1 = await audited(() => sendAs(name, t2, "agent"));
    expect(agent1.answer.status).toBe(200);
    expect(agent1.answer.body).toMatchObject({ status: "done", report: expect.stringContaining(`reply: ${t2}`) });
    expect(agent1.lines.filter((l) => l.route === "POST /sessions/:name/send")).toEqual([
      expect.objectContaining({ name, from: "agent", state: "idle", textBytes: t2.length }),
    ]);

    // During slow: agent text is held, owner text enters and its reply shows after the slow turn's.
    const slow = await sendAs(name, "slow", "owner");
    expect((slow.body as { status: string }).status).toBe("running");
    const t3 = tok();
    const held = await audited(() => sendAs(name, t3, "agent"));
    expect(held.answer).toEqual({ status: 200, body: { status: "held", name, engine: ENGINE, state: "working", attachHint: expect.any(String) } });
    expect(held.lines).toEqual([expect.objectContaining({ from: "agent", state: "working", held: true, textBytes: t3.length })]);
    expect(held.lines[0]).not.toHaveProperty("text");
    const t4 = tok();
    expect((await sendAs(name, t4, "owner")).status).toBe(200);
    await pollUntil(name, "idle");
    const afterSlow = pane(name);
    expect(afterSlow.indexOf(`reply: ${t4}`)).toBeGreaterThan(afterSlow.indexOf("reply: slow done"));
    expect(afterSlow.indexOf("reply: slow done")).toBeGreaterThan(-1);
    notTyped(name, t3);

    // During ask: nothing typed by anyone through the router; the pane still ends (y/n).
    const ask = await sendAs(name, "ask", "owner");
    expect((ask.body as { status: string }).status).toBe("running");
    expect(await pollUntil(name, "waiting_for_approval")).toMatchObject({ idle: false });
    const refusedWaiting = { status: 409, body: { error: WAITING, state: "waiting_for_approval" } };
    const t5 = tok();
    const ownerSend = await audited(() => sendAs(name, t5, "owner"));
    expect(ownerSend.answer).toEqual(refusedWaiting);
    expect(ownerSend.lines).toEqual([
      expect.objectContaining({ route: "POST /sessions/:name/send", name, from: "owner", state: "waiting_for_approval", denied: "input-gate", textBytes: t5.length }),
    ]);
    const ownerInterrupt = await audited(() => interruptAs(name, "owner"));
    expect(ownerInterrupt.answer).toEqual(refusedWaiting);
    expect(ownerInterrupt.lines).toEqual([
      expect.objectContaining({ route: "POST /sessions/:name/interrupt", name, from: "owner", state: "waiting_for_approval", denied: "input-gate" }),
    ]);
    const t6 = tok();
    const heldWaiting = { status: 200, body: { status: "held", name, engine: ENGINE, state: "waiting_for_approval", attachHint: expect.any(String) } };
    const agentSend = await audited(() => sendAs(name, t6, "agent"));
    expect(agentSend.answer).toEqual(heldWaiting);
    expect(agentSend.lines).toEqual([expect.objectContaining({ from: "agent", state: "waiting_for_approval", held: true })]);
    const agentInterrupt = await audited(() => interruptAs(name, "agent"));
    expect(agentInterrupt.answer).toEqual({ status: 403, body: { error: AGENT_INTERRUPT, state: "waiting_for_approval" } });
    expect(agentInterrupt.lines).toEqual([
      expect.objectContaining({ route: "POST /sessions/:name/interrupt", from: "agent", state: "waiting_for_approval", denied: "input-gate" }),
    ]);
    // A per-send model/effort is checked before the gate (400 here: this agent takes neither).
    const t7 = tok();
    expect(await sendAs(name, t7, "owner", { model: "opus" })).toMatchObject({ status: 400 });
    // An agent's request claiming the owner in its body is still the agent's.
    const t8 = tok();
    expect(await sendAs(name, t8, "agent", { from: "owner" })).toEqual(heldWaiting);

    // No body key changes who is speaking: each key (as req.body.x, req.body?.x, req.body['x'] or
    // destructured, it would be the same key) gives the answer the request gets without it.
    const sent: string[] = [t5, t6, t7, t8];
    for (const from of ["agent", undefined] as (From | undefined)[]) {
      const tBase = tok();
      sent.push(tBase);
      const baseSend = await sendAs(name, tBase, from);
      const baseInterrupt = await interruptAs(name, from);
      expect(baseSend).toEqual(from ? heldWaiting : refusedWaiting);
      expect(baseInterrupt).toEqual(from ? { status: 403, body: { error: AGENT_INTERRUPT, state: "waiting_for_approval" } } : refusedWaiting);
      for (const key of ["from", "as", "caller", "agent"]) {
        for (const value of ["owner", "agent", true]) {
          const t = tok();
          sent.push(t);
          expect(await sendAs(name, t, from, { [key]: value }), `send from=${from} body.${key}=${value}`).toEqual(baseSend);
          expect(await interruptAs(name, from, { [key]: value }), `interrupt from=${from} body.${key}=${value}`).toEqual(baseInterrupt);
        }
      }
      const tAll = tok();
      sent.push(tAll);
      expect(await sendAs(name, tAll, from, { from: "owner", as: "owner", caller: "owner", agent: false })).toEqual(baseSend);
    }
    for (const t of sent) notTyped(name, t);
    expect(pane(name).trimEnd().endsWith("(y/n)")).toBe(true);
    // Read still works while the session waits.
    const read = await rq("GET", `/sessions/${name}/read`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ live: true, agentState: "waiting_for_approval" });

    // The person answers in tmux.
    tmux("send-keys", "-t", `=ccm-${name}:`, "n", "Enter");
    await pollUntil(name, "idle");
    expect(pane(name)).toContain("reply: answered n");
    expect(await rq("POST", `/sessions/${name}/close`)).toEqual({ status: 200, body: { ok: true, name, engine: ENGINE } });
  }, 120_000);

  it.each([
    ["r1a18-plain", "r1a18-plain", (t: string) => t, (t: string) => `reply: ${t}`],
    ["shell", "r1a18-shell", (t: string) => `echo ${t}`, (t: string) => t],
  ])("%s at its prompt (no idle rule): owner text enters, a request without from enters as the owner, agent text is held", async (engine, name, typed, shown) => {
    const open = await rq("POST", "/sessions/open", { engine, name, cwd: WORK });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ name, engine, ready: true });
    const ta = tok();
    expect(await sendAs(name, typed(ta), "agent")).toEqual({ status: 200, body: { status: "held", name, engine, state: "unknown", attachHint: expect.any(String) } });
    notTyped(name, ta);
    for (const from of ["owner", undefined] as (From | undefined)[]) {
      const t = tok();
      const sent = await sendAs(name, typed(t), from);
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ status: "quiet", engine });
      expect((sent.body as { report: string }).report).toContain(shown(t));
    }
    notTyped(name, ta);
    expect(await rq("POST", `/sessions/${name}/close`)).toEqual({ status: 200, body: { ok: true, name, engine } });
    expect(tmuxHas(name)).toBe(false);
  }, 60_000);

  it("(d) a second ask: a hub frame's send is 409 and types nothing; close answers 200 and the tmux session is gone", async () => {
    const name = "r1a18-ask2";
    expect((await rq("POST", "/sessions/open", { engine: ENGINE, name, cwd: WORK })).status).toBe(200);
    await pollUntil(name, "idle");
    expect(((await sendAs(name, "ask", "owner")).body as { status: string }).status).toBe("running");
    await pollUntil(name, "waiting_for_approval");
    for (const extra of [{}, { from: "agent" }]) {
      const t = tok();
      const frame: CcmHttpRequestFrame = {
        type: CCM_FRAME_TYPES.httpRequest,
        request_id: `r1a18-${t}`,
        method: "POST",
        path: `/sessions/${name}/send`,
        headers: {},
        body_base64: Buffer.from(JSON.stringify({ text: t, ...extra }), "utf8").toString("base64"),
      };
      const response = await handleHubRequest(frame);
      expect(response.status_code).toBe(409);
      expect(JSON.parse(Buffer.from(response.body_base64 ?? "", "base64").toString("utf8"))).toEqual({ error: WAITING, state: "waiting_for_approval" });
      notTyped(name, t);
    }
    expect(pane(name).trimEnd().endsWith("(y/n)")).toBe(true);
    expect(await rq("POST", `/sessions/${name}/close`)).toEqual({ status: 200, body: { ok: true, name, engine: ENGINE } });
    expect(tmuxHas(name)).toBe(false);
  }, 60_000);
});

/**
 * U-R1A-18-R1 (audit). Sessions here are HarnessSessions over a terminal that only records what
 * would be typed, registered live so every caller's path (route, hub frame, fleet op, MCP tool)
 * reaches them; nothing runs and no tmux call is made.
 */
describe("(e) U-R1A-18-R1 audit: identity, fresh reads, controls, malformed bodies, timing", () => {
  const registered: string[] = [];
  afterAll(() => registered.forEach((n) => unregisterLive(n)));
  const rules = () => loadedHarnesses().get("r1a18-rules")!;
  const builtin = (agent: string) => loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") }).harnesses.get(agent)!;
  const fixture = (n: string) => readFileSync(join(SCREENS, `${n}.txt`), "utf8");

  function recording(name: string, next: () => string | Promise<string>, harness = rules()) {
    const calls: string[] = [];
    const terminal: HarnessTerminal = {
      name,
      cwd: WORK,
      ready: true,
      readinessWarning: undefined,
      attachHint: () => "",
      isAlive: async () => true,
      isCurrentlyWorking: async () => false,
      send: async (text: string) => {
        calls.push(`send:${text}`);
        return { status: "done", report: "", cursor: 0 };
      },
      readSince: async () => ({ text: "", cursor: 0, idle: true }) as never,
      applyControls: async (controls) => {
        calls.push(`controls:${JSON.stringify(controls)}`);
        return [];
      },
      interrupt: async () => {
        calls.push("interrupt");
      },
      close: async () => {},
      screen: async () => next(),
    };
    const session = new HarnessSession(harness, terminal);
    registerLive(session);
    registered.push(name);
    return { session, calls };
  }
  type Answer = { status?: number; body: unknown };
  const hubCall = async (path: string, body: unknown, extra: Record<string, unknown> = {}): Promise<Answer> => {
    const frame = {
      type: CCM_FRAME_TYPES.httpRequest,
      request_id: `r1a18-${tok()}`,
      method: "POST",
      path,
      headers: {},
      body_base64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
      ...extra,
    } as CcmHttpRequestFrame;
    const response = await handleHubRequest(frame);
    return { status: response.status_code, body: JSON.parse(Buffer.from(response.body_base64 ?? "", "base64").toString("utf8")) };
  };

  it("identity: nothing a caller can send makes an agent the owner or the owner an agent, on every path into send and interrupt", async () => {
    const name = "r1a18-fake-wait";
    const { calls } = recording(name, () => "run it? (y/n)");
    const path = (action: string) => `/sessions/${name}/${action}`;
    const state = "waiting_for_approval";
    const SEES: Record<From, Record<"send" | "interrupt", Answer>> = {
      owner: { send: { status: 409, body: { error: WAITING, state } }, interrupt: { status: 409, body: { error: WAITING, state } } },
      agent: {
        send: { status: 200, body: { status: "held", name, engine: "r1a18-rules", state, attachHint: "" } },
        interrupt: { status: 403, body: { error: AGENT_INTERRUPT, state } },
      },
    };
    const claim = (who: From) => ({ from: who, as: who, caller: who, agent: who === "agent", role: who, sender: who, identity: who, rpcFrom: who });
    const viaRoute = (from: unknown, body: Record<string, unknown>, query = "") => (action: "send" | "interrupt") =>
      route({ method: "POST", path: path(action), query: new URLSearchParams(query), body: { ...(action === "send" ? { text: tok() } : {}), ...body }, ...(from === undefined ? {} : { from: from as From }) });
    const q = (who: From) => new URLSearchParams(Object.entries(claim(who)).map(([k, v]) => [k, String(v)])).toString();
    const mcp = async (action: "send" | "interrupt"): Promise<Answer> => {
      const server = await buildMcpServer();
      const client = new Client({ name: "r1a18", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        const args = { name, ...(action === "send" ? { text: tok() } : {}), ...claim("agent") };
        const result = (await client.callTool({ name: action === "send" ? "send_to_session" : "interrupt_session", arguments: args })) as { content: { text: string }[] };
        return { body: JSON.parse(result.content[0].text) };
      } finally {
        await client.close();
        await server.close();
      }
    };
    const ROWS: [string, From, (action: "send" | "interrupt") => Promise<Answer>][] = [
      ["route, no from", "owner", viaRoute(undefined, {})],
      ["route, no from, body claims agent", "owner", viaRoute(undefined, claim("agent"))],
      ["route, no from, query claims agent", "owner", viaRoute(undefined, {}, q("agent"))],
      ["route, from owner, body and query claim agent", "owner", viaRoute("owner", claim("agent"), q("agent"))],
      ["routeForTest seam, body claims agent", "owner", async (action) => (await import("../bridge/router.ts")).routeForTest("POST", path(action), { ...(action === "send" ? { text: tok() } : {}), ...claim("agent") }, q("agent"))],
      [
        "hub frame: headers, frame fields and body claim agent",
        "owner",
        (action) =>
          hubCall(path(action), { ...(action === "send" ? { text: tok() } : {}), ...claim("agent") }, {
            headers: { from: ["agent"], "x-tandem-from": ["agent"], "x-from": ["agent"] },
            raw_query: q("agent"),
            from: "agent",
            trusted_surface: true,
          }),
      ],
      ["fleet op, payload claims agent", "owner", (action) => executeLocalOp(action, { sessionId: name, ...(action === "send" ? { text: tok() } : {}), ...claim("agent") } as never)],
      ["MCP tool, arguments claim agent", "owner", mcp],
      ["route, from agent", "agent", viaRoute("agent", {})],
      ["route, from agent, body claims owner", "agent", viaRoute("agent", claim("owner"))],
      ["route, from agent, query claims owner", "agent", viaRoute("agent", {}, q("owner"))],
      ...[["Owner"], ["OWNER"], ["owner "], [" owner"], [""], [0], [false], [true], [["owner"]], [{ owner: true }]].map(
        ([value]) => [`route, from ${JSON.stringify(value)} (not the owner's exact value) with a body claiming owner`, "agent", viaRoute(value, claim("owner"))] as [string, From, (action: "send" | "interrupt") => Promise<Answer>],
      ),
    ];
    for (const [label, who, call] of ROWS) {
      for (const action of ["send", "interrupt"] as const) {
        const answer = await call(action);
        expect(answer.body, `${label}: ${action} body`).toEqual(SEES[who][action].body);
        if (answer.status !== undefined) expect(answer.status, `${label}: ${action} status`).toBe(SEES[who][action].status);
      }
    }
    expect(calls).toEqual([]);
  }, 30_000);

  it("fresh reads: the session's own cached idle admits nobody; one changed idle screen restarts the wait", async () => {
    let screen = "fake>";
    const cached = recording("r1a18-fake-fresh", () => screen);
    await cached.session.read();
    await sleep(400);
    expect((await cached.session.read()).agentState).toBe("idle");
    screen = "run it? (y/n)";
    expect(await gate.admitInput!(cached.session, "owner", "type")).toEqual({ verdict: "refused", state: "waiting_for_approval" });
    expect(await gate.admitInput!(cached.session, "owner", "interrupt")).toEqual({ verdict: "refused", state: "waiting_for_approval" });
    expect(await gate.admitInput!(cached.session, "agent", "type")).toEqual({ verdict: "held", state: "waiting_for_approval" });

    let reads = 0;
    const changing = recording("r1a18-fake-change", () => (++reads <= 2 ? "a\nfake>" : "b\nfake>"));
    const started = Date.now();
    expect(await gate.admitInput!(changing.session, "agent", "type")).toEqual({ verdict: "enter", state: "idle" });
    // Without the restart it would enter on read 3 (500 ms); with it, 300 ms after the change at least.
    expect(Date.now() - started).toBeGreaterThanOrEqual(790);
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(cached.calls.concat(changing.calls)).toEqual([]);
  }, 10_000);

  it("controls: a per-send model/effort reaches the session only after admission, then before its text", async () => {
    let screen = fixture("claude-waiting_for_approval-1");
    const name = "r1a18-fake-controls";
    const { calls } = recording(name, () => screen, builtin("claude"));
    const send = (from: From) => sendAs(name, "hello", from, { model: "opus", effort: "high" });
    expect(await send("owner")).toEqual({ status: 409, body: { error: WAITING, state: "waiting_for_approval" } });
    expect(await send("agent")).toMatchObject({ status: 200, body: { status: "held", state: "waiting_for_approval" } });
    screen = fixture("claude-working-real");
    expect(await send("agent")).toMatchObject({ status: 200, body: { status: "held", state: "working" } });
    screen = fixture("claude-unknown-1");
    expect(await send("agent")).toMatchObject({ status: 200, body: { status: "held", state: "unknown" } });
    expect(calls).toEqual([]);
    const entered = ['controls:{"model":"opus","effort":"high"}', "send:hello"];
    screen = fixture("claude-working-real");
    expect(await send("owner")).toMatchObject({ status: 200, body: { status: "done" } });
    expect(calls.splice(0)).toEqual(entered);
    screen = fixture("claude-idle-real");
    expect(await send("agent")).toMatchObject({ status: 200, body: { status: "done" } });
    expect(calls).toEqual(entered);
  }, 20_000);

  it.each([[null], [[]], ["text"], [7], [true]])("malformed body %j on send and interrupt answers 400, never 500, and types nothing", async (body) => {
    const live = `r1a18-fake-body-${seq++}`;
    const { calls } = recording(live, () => "fake>");
    for (const name of [live, "r1a18-not-live"]) {
      for (const action of ["send", "interrupt"]) {
        const path = `/sessions/${name}/${action}`;
        for (const from of [undefined, "agent"] as (From | undefined)[]) {
          const answer = await route({ method: "POST", path, query: new URLSearchParams(), body: body as never, ...(from ? { from } : {}) }).catch((e) => ({ status: 500, body: String(e) }));
          expect(answer, `route ${action} ${name} from=${from}`).toEqual({ status: 400, body: { error: "body must be a JSON object" } });
        }
        expect(await hubCall(path, body), `hub ${action} ${name}`).toEqual({ status: 400, body: { error: "body must be a JSON object" } });
      }
    }
    expect(calls).toEqual([]);
  });

  it("timing: a screen read that never answers, or answers slowly, cannot hang the gate or route()", async () => {
    const timed = async <T>(run: () => Promise<T>) => {
      const started = Date.now();
      const answer = await run();
      return { answer, took: Date.now() - started };
    };
    const never = recording("r1a18-fake-hang", () => new Promise<string>(() => {}));
    // A read with no answer in 2000 ms is a screen the session cannot show: unknown.
    const owner = await timed(() => gate.admitInput!(never.session, "owner", "type"));
    expect(owner.answer).toEqual({ verdict: "enter", state: "unknown" });
    expect(owner.took).toBeLessThan(3000);
    const agent = await timed(() => gate.admitInput!(never.session, "agent", "type"));
    expect(agent.answer).toEqual({ verdict: "held", state: "unknown" });
    expect(agent.took).toBeLessThan(3000);
    const routed = await timed(() => sendAs("r1a18-fake-hang", tok(), "agent"));
    expect(routed.answer).toMatchObject({ status: 200, body: { status: "held", state: "unknown" } });
    expect(routed.took).toBeLessThan(3000);
    const refused = await timed(() => interruptAs("r1a18-fake-hang", "agent"));
    expect(refused.answer.status).toBe(403);
    expect(refused.took).toBeLessThan(3000);
    expect(never.calls).toEqual([]);

    // Idle on the first read, then no answer: held, within one read's limit of the first poll.
    let k = 0;
    const stalls = recording("r1a18-fake-stall", () => (++k === 1 ? "fake>" : new Promise<string>(() => {})));
    const stalled = await timed(() => gate.admitInput!(stalls.session, "agent", "type"));
    expect(stalled.answer).toEqual({ verdict: "held", state: "unknown" });
    expect(stalled.took).toBeLessThan(3200);

    // Slow reads of an idle screen that keeps changing: held by debounce_ms + 1000 ms plus one poll and one read.
    let n = 0;
    const slow = recording("r1a18-fake-slow", async () => {
      await sleep(700);
      return `out ${++n}\nfake>`;
    });
    const slowed = await timed(() => gate.admitInput!(slow.session, "agent", "type"));
    expect(slowed.answer).toEqual({ verdict: "held", state: "idle" });
    expect(slowed.took).toBeLessThan(300 + 1000 + 250 + 700 + 400);
    expect(stalls.calls.concat(slow.calls)).toEqual([]);
  }, 30_000);
});
