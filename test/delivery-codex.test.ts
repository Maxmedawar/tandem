/**
 * U-R1A-26: Codex gets its mail the way Claude does since U-R1A-25, through Tandem's own hook
 * command, never as keystrokes. Codex takes no settings file: installHook returns the hooks and
 * Codex's trust record for them as per-session `--config` overrides (harness field
 * `hook_format = "config-overrides"`), so no Codex config folder is read or written.
 *
 * tmux runs only on a private socket: before any import TMUX is unset and TMUX_TMPDIR is a new
 * r1a26- folder; TANDEM_HOME, an empty CLAUDE_CONFIG_DIR and an empty CODEX_HOME live in it too.
 * afterAll kills that folder's tmux servers (after `test -S`) and removes it. The probe row runs
 * `codex app-server` (own process group, a new empty CODEX_HOME) and asks `hooks/list` only: no
 * sign-in, no model call.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const BOX = mkdtempSync(join(tmpdir(), "r1a26-"));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
const TH = join(BOX, "tandem");
process.env.TANDEM_HOME = TH;
const CLAUDE_CONFIG = join(BOX, "claude-config");
const CODEX_CONFIG = join(BOX, "codex-home");
mkdirSync(CLAUDE_CONFIG);
mkdirSync(CODEX_CONFIG);
process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG;
process.env.CODEX_HOME = CODEX_CONFIG;
const WORK = join(BOX, "work");
const BIN = join(BOX, "bin");
const OWNER = join(BOX, "owner");
for (const d of [WORK, BIN, OWNER]) mkdirSync(d);
chmodSync(OWNER, 0o700);

const dh = await import("../bridge/delivery-hooks.ts");
const { HarnessSession } = await import("../bridge/engines/harness-engine.ts");
const { loadHarnesses } = await import("../bridge/harness-registry.ts");
const { openMailbox } = await import("../bridge/mailbox.ts");
const { applyLimits } = await import("../bridge/limits.ts");
const { writeLimits } = await import("./fixtures/limits.ts");

writeLimits(TH, { interrupt_from: ["owner"] });
applyLimits();

afterAll(() => {
  for (const sock of [join(BOX, `tmux-${process.getuid!()}`, "default"), join(TH, "tmux", "tandem")]) {
    if (spawnSync("test", ["-S", sock]).status === 0) spawnSync("tmux", ["-S", sock, "kill-server"]);
  }
  rmSync(BOX, { recursive: true, force: true });
});

const BUILTIN = fileURLToPath(new URL("../harnesses/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../bridge/delivery-hooks.ts", import.meta.url));
const DELIVERY = join(TH, "delivery");
const mode = (p: string) => statSync(p).mode & 0o777;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An owner-style harness with Codex's hook form; `program` defaults to /usr/bin/true (never run unless spawned). */
function harness(name: string, delivery: "hook" | "notice", extra: Record<string, unknown> = {}): any {
  return {
    name, program: "/usr/bin/true", programPath: "/usr/bin/true", args: [], skip_prompts_args: [], resume: [], fork: [],
    has_prompts: false, delivery, ...(delivery === "hook" ? { hook: "--config", hook_format: "config-overrides" } : {}),
    permission_hook: false, reports_context: false, source: "owner", file: join(OWNER, `${name}.toml`), kind: "agent", ...extra,
  };
}

type Event = "UserPromptSubmit" | "PostToolUse" | "Stop" | "Interrupt";
const EVENTS: Event[] = ["UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"];
const LABEL: Record<Event, string> = { UserPromptSubmit: "user_prompt_submit", PostToolUse: "post_tool_use", Stop: "stop", Interrupt: "interrupt" };
const TIMEOUT: Record<Event, number> = { UserPromptSubmit: 10, PostToolUse: 10, Stop: 10, Interrupt: 3 };

/** U-R1A-25's command string for one event, under TANDEM_HOME `home`. */
const q = (s: string) => `'${s}'`;
const cmdOf = (e: string, name: string, home = TH) =>
  `${q(process.execPath)} --experimental-strip-types ${q(SCRIPT)} ${q(e)} ${q(name)} ${q(join(home, "state.db"))} ${q(join(home, "delivery"))}`;
const handlerOf = (e: Event, name: string, home = TH) =>
  ({ command: cmdOf(e, name, home), timeout: TIMEOUT[e], ...(e === "PostToolUse" ? { additionalContextLimit: 0 } : {}) });

/** The 10 argv elements the brief names, built here from its text. */
function expected(name: string, home = TH): string[] {
  const C = (e: Event) => JSON.stringify(cmdOf(e, name, home));
  const K = (e: Event) => JSON.stringify(`/<session-flags>/config.toml:${LABEL[e]}:0:0`);
  const H = (e: Event) => JSON.stringify(dh.codexHookHash(LABEL[e], handlerOf(e, name, home), e === "PostToolUse" ? "*" : undefined));
  return [
    "--config", `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${C("UserPromptSubmit")},timeout=10}]}]`,
    "--config", `hooks.PostToolUse=[{matcher="*",hooks=[{type="command",command=${C("PostToolUse")},timeout=10,additionalContextLimit=0}]}]`,
    "--config", `hooks.Stop=[{hooks=[{type="command",command=${C("Stop")},timeout=10}]}]`,
    "--config", `hooks.Interrupt=[{hooks=[{type="command",command=${C("Interrupt")},timeout=3}]}]`,
    "--config", `hooks.state={${EVENTS.map((e) => `${K(e)}={trusted_hash=${H(e)}}`).join(",")}}`,
  ];
}

/** installHook for `name`; the four hook commands read back from the override values. */
function install(name: string): { argv: string[]; cmds: Record<Event, string> } {
  const argv = dh.installHook(harness(name, "hook"), name);
  const cmds = {} as Record<Event, string>;
  for (const [i, e] of EVENTS.entries()) {
    const doc = parse(argv[2 * i + 1]!) as any;
    cmds[e] = doc.hooks[e][0].hooks[0].command;
  }
  return { argv, cmds };
}

/** One hook run as Codex runs it: `sh -c <command>`, one JSON object on stdin. */
function run(cmd: string, stdin: unknown): { status: number | null; stdout: string; stderr: string } {
  const input = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const r = spawnSync("sh", ["-c", cmd], { input, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Codex-shaped stdin (codex-rs/hooks/src/schema.rs). */
const base = (name: string) => ({ session_id: "r1a26-sid", turn_id: "r1a26-turn", transcript_path: null, cwd: WORK, hook_event_name: name, model: "gpt-r1a26", permission_mode: "default" });
const postToolUse = () => ({ ...base("PostToolUse"), tool_name: "shell", tool_input: { command: ["echo", "r1a26"] }, tool_response: "r1a26", tool_use_id: "r1a26-call" });
const stop = (active: boolean) => ({ ...base("Stop"), stop_hook_active: active, last_assistant_message: "done" });
const interrupt = () => base("Interrupt");

const box = openMailbox();
afterAll(() => box.close());
const send = (to: string, level: "fyi" | "ask" | "interrupt", text: string) => box.send({ from: "owner", to, level, text }).id;
const stateOf = (id: string) => box.sent("owner", 500).find((m) => m.id === id)?.state;

describe("(a) the harness files: codex.toml delivers by hook through --config overrides; hook_format is checked", () => {
  const NO_OWNER = join(BOX, "no-owner");
  it("codex.toml: hook --config, hook_format config-overrides; claude.toml: hook, no hook_format; every other built-in file stays notice", () => {
    const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path: BIN });
    expect(errors).toEqual([]);
    expect(harnesses.get("codex")).toMatchObject({ delivery: "hook", hook: "--config", hook_format: "config-overrides" });
    expect(harnesses.get("claude")).toMatchObject({ delivery: "hook", hook: "--settings" });
    expect(harnesses.get("claude")).not.toHaveProperty("hook_format");
    const others = readdirSync(BUILTIN).filter((f) => f.endsWith(".toml") && f !== "claude.toml" && f !== "codex.toml");
    expect(others.length).toBeGreaterThan(0);
    for (const f of others) {
      const h = harnesses.get(f.slice(0, -5))!;
      expect(h.delivery, f).toBe("notice");
      expect(h.hook, f).toBeUndefined();
      expect(h, f).not.toHaveProperty("hook_format");
    }
  });

  it("refused: hook_format with no hook; hook_format \"x\" and \"Settings-File\"", () => {
    const dir = join(BOX, "a-owner", "harnesses");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const file = (name: string, body: string) =>
      writeFileSync(join(dir, `${name}.toml`), `name = "${name}"\nprogram = "/usr/bin/true"\nhas_prompts = false\n${body}`, { mode: 0o600 });
    file("r1a26-nohook", 'hook_format = "config-overrides"\n');
    file("r1a26-x", 'delivery = "hook"\nhook = "--config"\nhook_format = "x"\n');
    file("r1a26-case", 'delivery = "hook"\nhook = "--config"\nhook_format = "Settings-File"\n');
    const { harnesses, errors } = loadHarnesses({ installDir: join(BOX, "no-builtin"), ownerDir: dir, path: BIN });
    const reason = (n: string) => errors.find((e) => e.file.endsWith(`${n}.toml`))?.reason;
    for (const n of ["r1a26-nohook", "r1a26-x", "r1a26-case"]) expect(harnesses.has(n), n).toBe(false);
    expect(reason("r1a26-nohook")).toMatch(/hook_format needs hook/);
    expect(reason("r1a26-x")).toMatch(/bad hook_format/);
    expect(reason("r1a26-case")).toMatch(/bad hook_format/);
  });
});

describe("(b) installHook config-overrides: 10 argv elements, no file", () => {
  it("returns [--config, U, --config, P, --config, S, --config, I, --config, T]; each value parses as TOML to the named tables", () => {
    mkdirSync(DELIVERY, { recursive: true, mode: 0o700 });
    writeFileSync(join(DELIVERY, "r1a26-inst.turn"), JSON.stringify({ state: "working", at: new Date().toISOString() }), { mode: 0o600 });
    const argv = dh.installHook(harness("r1a26-inst", "hook"), "r1a26-inst");
    expect(argv).toEqual(expected("r1a26-inst"));
    expect(argv.filter((_, i) => i % 2 === 0)).toEqual(Array(5).fill("--config"));
    // smol-toml makes null-prototype tables: toEqual compares the same keys and values.
    const doc = (i: number) => parse(argv[i]!) as any;
    const cmd = (e: Event) => cmdOf(e, "r1a26-inst");
    expect(doc(1)).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("UserPromptSubmit"), timeout: 10 }] }] } });
    expect(doc(3)).toEqual({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd("PostToolUse"), timeout: 10, additionalContextLimit: 0 }] }] } });
    expect(doc(5)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: cmd("Stop"), timeout: 10 }] }] } });
    expect(doc(7)).toEqual({ hooks: { Interrupt: [{ hooks: [{ type: "command", command: cmd("Interrupt"), timeout: 3 }] }] } });
    const state = Object.fromEntries(EVENTS.map((e) => [
      `/<session-flags>/config.toml:${LABEL[e]}:0:0`,
      { trusted_hash: dh.codexHookHash(LABEL[e], handlerOf(e, "r1a26-inst"), e === "PostToolUse" ? "*" : undefined) },
    ]));
    expect(doc(9)).toEqual({ hooks: { state } });
    expect(mode(DELIVERY)).toBe(0o700);
    expect(readdirSync(DELIVERY)).toEqual([]);
    for (const e of EVENTS) expect(spawnSync("sh", ["-n", "-c", cmd(e)]).status, e).toBe(0);
  });

  it("a TANDEM_HOME holding ' or a newline throws and writes nothing", () => {
    for (const bad of [join(BOX, "it's"), join(BOX, "two\nlines")]) {
      process.env.TANDEM_HOME = bad;
      try {
        expect(() => dh.installHook(harness("r1a26-q", "hook"), "r1a26-q")).toThrow();
        expect(existsSync(bad)).toBe(false);
      } finally {
        process.env.TANDEM_HOME = TH;
      }
    }
  });

  it("a TANDEM_HOME holding \", \\, a space, $ and é works; each value still parses back to the exact command", () => {
    const odd = join(BOX, 'odd "q" \\b $x é');
    process.env.TANDEM_HOME = odd;
    try {
      const argv = dh.installHook(harness("r1a26-odd", "hook"), "r1a26-odd");
      expect(argv).toEqual(expected("r1a26-odd", odd));
      for (const [i, e] of EVENTS.entries()) {
        expect((parse(argv[2 * i + 1]!) as any).hooks[e][0].hooks[0].command, e).toBe(cmdOf(e, "r1a26-odd", odd));
      }
      expect(readdirSync(join(odd, "delivery"))).toEqual([]);
    } finally {
      process.env.TANDEM_HOME = TH;
    }
  });

  it("the settings-file form is unchanged: no Interrupt hook, the file holds the three events", () => {
    const argv = dh.installHook(harness("r1a26-sf", "hook", { hook: "--settings", hook_format: undefined }), "r1a26-sf");
    expect(argv).toEqual(["--settings", join(DELIVERY, "r1a26-sf.settings.json")]);
    expect(Object.keys(JSON.parse(readFileSync(argv[1]!, "utf8")).hooks)).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
    dh.removeHook("r1a26-sf");
  });
});

describe("(c) the trust hash", () => {
  it("the two test vectors", () => {
    expect(dh.codexHookHash("stop", { command: "/bin/echo stop", timeout: 10 }))
      .toBe("sha256:b5692673ad654992be1324ef3743787e9fada201fa8c8c05847988d53892e8a5");
    expect(dh.codexHookHash("post_tool_use", { command: "/bin/echo hi", timeout: 10 }, "*"))
      .toBe("sha256:8a03912ae6876cf2cef837bc22f06482165faefdb5d97c3c49f2714a99c2c312");
  });
});

const HAS_CODEX = spawnSync("sh", ["-c", "command -v codex"]).status === 0;
if (!HAS_CODEX) console.log("r1a26: probe row skipped: codex is not on PATH");

describe.skipIf(!HAS_CODEX)("(d) PROBE: codex app-server hooks/list sees Tandem's 4 hooks trusted", () => {
  const PROBE = join(BOX, "probe");
  mkdirSync(PROBE);

  /** `codex app-server` + `argv` in its own process group; the hooks/list answer for a new empty cwd. */
  async function hooksList(argv: string[], codexHome: string): Promise<any> {
    const cwd = mkdtempSync(join(PROBE, "cwd-"));
    const child = spawnChild("codex", ["app-server", ...argv], {
      cwd, detached: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: codexHome },
    });
    try {
      return await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error("r1a26: codex app-server gave no hooks/list answer in 20 s")), 20_000);
        let buf = "";
        child.stdout!.on("data", (b) => {
          buf += b;
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const l of lines) {
            if (!l.includes('"id":2')) continue;
            clearTimeout(timer);
            const msg = JSON.parse(l);
            if (msg.error) fail(new Error(`r1a26: hooks/list error ${JSON.stringify(msg.error)}`));
            else done(msg.result.data[0]);
          }
        });
        child.on("error", fail);
        for (const m of [
          { id: 1, method: "initialize", params: { clientInfo: { name: "r1a26", version: "0" } } },
          { method: "initialized" },
          { id: 2, method: "hooks/list", params: { cwds: [cwd] } },
        ]) child.stdin!.write(`${JSON.stringify(m)}\n`);
      });
    } finally {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  const EVENT_NAME: Record<Event, string> = { UserPromptSubmit: "userPromptSubmit", PostToolUse: "postToolUse", Stop: "stop", Interrupt: "interrupt" };
  function checkTandem(data: any, name: string, home: string): void {
    expect(data.warnings).toEqual([]);
    expect(data.errors).toEqual([]);
    const ours = data.hooks.filter((h: any) => h.source === "sessionFlags");
    expect(ours).toHaveLength(4);
    for (const e of EVENTS) {
      const h = ours.find((x: any) => x.eventName === EVENT_NAME[e]);
      expect(h, e).toMatchObject({ source: "sessionFlags", trustStatus: "trusted", enabled: true, timeoutSec: TIMEOUT[e], command: cmdOf(e, name, home) });
      expect(h.additionalContextLimit, e).toBe(e === "PostToolUse" ? 0 : null);
    }
  }

  it("Tandem's 4 hooks: sessionFlags, trusted, enabled, timeouts 10/10/10/3, limit 0 on postToolUse only", async () => {
    const data = await hooksList(dh.installHook(harness("r1a26-probe", "hook"), "r1a26-probe"), mkdtempSync(join(PROBE, "ch-")));
    console.log(`r1a26: probe hooks ${JSON.stringify(data.hooks.map((h: any) => [h.eventName, h.source, h.trustStatus, h.timeoutSec]))}`);
    expect(data.hooks).toHaveLength(4);
    checkTandem(data, "r1a26-probe", TH);
  }, 30_000);

  it("the same with a TANDEM_HOME holding \", \\, a space, $ and é", async () => {
    const odd = join(BOX, 'probe "q" \\b $x é');
    process.env.TANDEM_HOME = odd;
    try {
      const data = await hooksList(dh.installHook(harness("r1a26-podd", "hook"), "r1a26-podd"), mkdtempSync(join(PROBE, "ch-")));
      expect(data.hooks).toHaveLength(4);
      checkTandem(data, "r1a26-podd", odd);
    } finally {
      process.env.TANDEM_HOME = TH;
    }
  }, 30_000);

  it("a user config.toml with its own trusted Stop hook: that hook stays trusted, and Tandem's 4 too", async () => {
    const ch = realpathSync(mkdtempSync(join(PROBE, "ch-")));
    const config = join(ch, "config.toml");
    const hash = dh.codexHookHash("stop", { command: "/bin/echo user", timeout: 10 });
    writeFileSync(config, [
      "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', 'command = "/bin/echo user"', "timeout = 10",
      `[hooks.state.${JSON.stringify(`${config}:stop:0:0`)}]`, `trusted_hash = ${JSON.stringify(hash)}`, "",
    ].join("\n"), { mode: 0o600 });
    const data = await hooksList(dh.installHook(harness("r1a26-puser", "hook"), "r1a26-puser"), ch);
    expect(data.hooks).toHaveLength(5);
    const user = data.hooks.find((h: any) => h.source === "user");
    expect(user).toMatchObject({ command: "/bin/echo user", trustStatus: "trusted", eventName: "stop" });
    checkTandem(data, "r1a26-puser", TH);
  }, 30_000);
});

describe("(e) the hook with Codex-shaped stdin", () => {
  it("PostToolUse with fyi, ask and interrupt queued: prints fyi and interrupt (delivered), not the ask; Stop then the ask", () => {
    const { cmds } = install("r1a26-e1");
    const fyi = send("r1a26-e1", "fyi", "r1a26 e1 fyi");
    const ask = send("r1a26-e1", "ask", "r1a26 e1 ask");
    const intr = send("r1a26-e1", "interrupt", "r1a26 e1 interrupt");
    const r = run(cmds.PostToolUse, postToolUse());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(out.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain("r1a26 e1 fyi");
    expect(text).toContain("r1a26 e1 interrupt");
    expect(text).not.toContain("r1a26 e1 ask");
    expect([stateOf(fyi), stateOf(intr), stateOf(ask)]).toEqual(["delivered", "delivered", "queued"]);

    const active = run(cmds.Stop, stop(true));
    expect([active.status, active.stdout]).toEqual([0, ""]);
    expect(stateOf(ask)).toBe("queued");
    const s = run(cmds.Stop, stop(false));
    expect(s.status).toBe(0);
    const block = JSON.parse(s.stdout);
    expect(Object.keys(block)).toEqual(["decision", "reason"]);
    expect(block.decision).toBe("block");
    expect(block.reason).toContain("r1a26 e1 ask");
    expect(stateOf(ask)).toBe("delivered");
  });

  it("Interrupt: prints nothing, claims nothing, leaves the turn idle; exit 0", () => {
    const { cmds } = install("r1a26-e2");
    run(cmds.UserPromptSubmit, { ...base("UserPromptSubmit"), prompt: "hi" });
    expect(dh.turnState("r1a26-e2")).toBe("working");
    const fyi = send("r1a26-e2", "fyi", "r1a26 e2 fyi");
    const ask = send("r1a26-e2", "ask", "r1a26 e2 ask");
    const r = run(cmds.Interrupt, interrupt());
    expect([r.status, r.stdout]).toEqual([0, ""]);
    expect([stateOf(fyi), stateOf(ask)]).toEqual(["queued", "queued"]);
    expect(dh.turnState("r1a26-e2")).toBe("idle");
    expect(mode(join(DELIVERY, "r1a26-e2.turn"))).toBe(0o600);
  });
});

describe("(f) HarnessSession.spawn of a config-overrides harness", () => {
  const AGENT = join(BIN, "r1a26-agent.sh");
  writeFileSync(AGENT, `#!/bin/sh\nout=$1\nshift\n: > "$out.tmp"\nfor a in "$@"; do printf '%s\\n' "$a" >> "$out.tmp"; done\nmv "$out.tmp" "$out"\nprintf 'r1a26>'\nexec sleep 600\n`, { mode: 0o755 });
  const STATES = { idle: ["r1a26>\\z"], debounce_ms: 200, precedence: ["waiting_for_approval", "working", "idle"] };

  it("argv ends with the 10 elements; no settings file; config folders stay empty; close removes the turn file", async () => {
    const out = join(BOX, "r1a26-spawn.argv");
    const h = harness("r1a26-spawn", "hook", { program: AGENT, programPath: AGENT, args: [out], states: STATES });
    const s = await HarnessSession.spawn(h, { name: "r1a26-spawn", cwd: WORK, allowlist: [WORK] });
    try {
      for (let i = 0; i < 100 && !existsSync(out); i++) await sleep(100);
      const argv = readFileSync(out, "utf8").split("\n").slice(0, -1);
      expect(argv.slice(-10)).toEqual(expected("r1a26-spawn"));
      expect(readdirSync(CODEX_CONFIG)).toEqual([]);
      expect(readdirSync(CLAUDE_CONFIG)).toEqual([]);
      expect(existsSync(join(homedir(), ".codex"))).toBe(false);
      expect(readdirSync(DELIVERY).filter((f) => f.startsWith("r1a26-spawn"))).toEqual([]);
      const ups = (parse(argv.at(-9)!) as any).hooks.UserPromptSubmit[0].hooks[0].command;
      run(ups, { ...base("UserPromptSubmit"), prompt: "hi" });
      expect(existsSync(join(DELIVERY, "r1a26-spawn.turn"))).toBe(true);
    } finally {
      await s.close();
    }
    expect(existsSync(join(DELIVERY, "r1a26-spawn.turn"))).toBe(false);
  }, 30_000);
});

describe("(g) inputState: the Interrupt hook ends a turn", () => {
  const STATES = { idle: ["r1a26>\\z"], debounce_ms: 0, precedence: ["waiting_for_approval", "working", "idle"] };
  const session = (name: string, delivery: "hook" | "notice") =>
    new HarnessSession(harness(name, delivery, { states: STATES }), {
      name, cwd: WORK, ready: true, readinessWarning: undefined, attachHint: () => "", isAlive: async () => true,
      isCurrentlyWorking: async () => false, send: async () => ({ report: "", cursor: 0, status: "done" as const }),
      readSince: async (cursor: number) => ({ text: "", cursor, idle: true }), applyControls: async () => [],
      interrupt: async () => {}, close: async () => {}, screen: async () => "r1a26>",
    } as any);

  it("idle screen + UserPromptSubmit = working; after Interrupt = idle; a notice session ignores its turn file", async () => {
    const { cmds } = install("r1a26-g1");
    const s = session("r1a26-g1", "hook");
    run(cmds.UserPromptSubmit, { ...base("UserPromptSubmit"), prompt: "hi" });
    expect((await s.inputState()).state).toBe("working");
    run(cmds.Interrupt, interrupt());
    expect((await s.inputState()).state).toBe("idle");
    run(cmds.UserPromptSubmit, { ...base("UserPromptSubmit"), prompt: "again" });
    expect(dh.turnState("r1a26-g1")).toBe("working");
    expect((await session("r1a26-g1", "notice").inputState()).state).toBe("idle");
  });
});
