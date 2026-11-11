import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RE2JS } from "re2js";
import { loadHarnesses, type Harness } from "../bridge/harness-registry.ts";
import { createStateReader, readScreen } from "../bridge/harness-detect.ts";

const SCREENS = fileURLToPath(new URL("./fixtures/screens/", import.meta.url));
const owner = mkdtempSync(join(tmpdir(), "harness-detect-"));
afterAll(() => rmSync(owner, { recursive: true, force: true }));

const loaded = loadHarnesses({ installDir: join(SCREENS, "harnesses"), ownerDir: owner });
const FILE = /^([a-z0-9]+)-(working|idle|waiting_for_approval|unknown)-([a-z0-9]+)\.txt$/;
const fixtures = readdirSync(SCREENS).filter((f) => f.endsWith(".txt")).sort();

type States = NonNullable<Harness["states"]>;
const states = (s: Partial<States>): Pick<Harness, "states"> => ({
  states: { debounce_ms: 1500, precedence: ["waiting_for_approval", "working", "idle"], ...s },
});

describe("rule files and screen fixtures", () => {
  it("every rule file loads with no errors", () => {
    expect(loaded.errors).toEqual([]);
    expect([...loaded.harnesses.keys()].sort()).toEqual(["claude", "codex", "gemini", "grok", "opencode", "shell"]);
    expect(loaded.harnesses.get("shell")?.states).toBeUndefined();
  });

  it("each agent brings 1 to 3 ccmanager samples per state, and the folder holds nothing else", () => {
    const n = (agent: string, state: string) => fixtures.filter((f) => new RegExp(`^${agent}-${state}-\\d+\\.txt$`).test(f)).length;
    for (const agent of ["claude", "codex", "gemini", "opencode", "grok"]) {
      for (const state of ["working", "waiting_for_approval"]) {
        expect(n(agent, state), `${agent} ${state}`).toBeGreaterThanOrEqual(1);
        expect(n(agent, state), `${agent} ${state}`).toBeLessThanOrEqual(3);
      }
      // idle is a positive match of the agent's prompt; a ccmanager idle sample with no prompt on it reads unknown.
      expect(n(agent, "idle"), `${agent} idle`).toBeLessThanOrEqual(3);
      const idleFixtures = fixtures.filter((f) => f.startsWith(`${agent}-idle-`)).length;
      const hasIdleRule = (loaded.harnesses.get(agent)?.states?.idle ?? []).length > 0;
      expect(idleFixtures > 0, `${agent}: an idle rule needs an idle fixture, and an idle fixture needs a rule`).toBe(hasIdleRule);
    }
    expect(fixtures).toContain("claude-working-real.txt");
    expect(fixtures).toContain("claude-idle-real.txt");
    expect(fixtures).toContain("shell-unknown-1.txt");
    for (const f of fixtures) expect(f).toMatch(FILE);
  });

  // Real dialogs captured from the installed CLIs, plus screens no agent shows when ready for input.
  const unrecognised: Record<string, string> = {
    "an empty screen": "",
    "blank lines": "\n  \n\t\n",
    "plain output": "Normal output\nSome message\nReady",
    "a menu": "Select a theme\n❯ 1. Dark\n  2. Light\n↑↓ to move · enter to select",
    "a shell prompt": "user@host:~/w$ ",
    "the codex update menu": readFileSync(join(SCREENS, "codex-unknown-update.txt"), "utf8"),
    "the gemini sign-in dialog": readFileSync(join(SCREENS, "gemini-unknown-auth.txt"), "utf8"),
    "the grok sign-in screen": readFileSync(join(SCREENS, "grok-unknown-signin.txt"), "utf8"),
  };
  it.each(Object.keys(unrecognised))("%s reads unknown for every agent, never idle", (label) => {
    for (const [name, h] of loaded.harnesses) expect(readScreen(h, unrecognised[label]!), name).toBe("unknown");
  });

  it.each(fixtures)("%s reads as the state in its name", (f) => {
    const [, agent, state] = FILE.exec(f)!;
    const h = loaded.harnesses.get(agent!);
    expect(h, `rule file for ${agent}`).toBeDefined();
    expect(readScreen(h!, readFileSync(join(SCREENS, f), "utf8"))).toBe(state);
  });
});

describe("readScreen", () => {
  it("no states table gives unknown", () => {
    expect(readScreen({}, "esc to interrupt")).toBe("unknown");
    expect(readScreen(loaded.harnesses.get("shell")!, "user@host:~/w$ ")).toBe("unknown");
  });

  it("nothing matching gives unknown, and a state with no patterns never matches", () => {
    const h = states({ working: ["busy"], waiting_for_approval: [] });
    expect(readScreen(h, "all quiet")).toBe("unknown");
    expect(readScreen(h, "")).toBe("unknown");
    expect(readScreen(h, "busy")).toBe("working");
  });

  it("follows precedence, the default and a custom order", () => {
    const rules = { working: ["run"], idle: ["ready"], waiting_for_approval: ["allow\\?"] };
    const screen = "run\nready\nallow?";
    expect(readScreen(states(rules), screen)).toBe("waiting_for_approval");
    expect(readScreen(states({ ...rules, precedence: ["working", "idle", "waiting_for_approval"] }), screen)).toBe("working");
    expect(readScreen(states({ ...rules, precedence: ["idle", "waiting_for_approval", "working"] }), screen)).toBe("idle");
  });

  it("a match beyond the last 40 lines does not count", () => {
    const h = states({ working: ["MARK"] });
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
    expect(readScreen(h, ["MARK", ...filler(39)].join("\n"))).toBe("working");
    expect(readScreen(h, ["MARK", ...filler(40)].join("\n"))).toBe("unknown");
  });

  it("ignores trailing blank lines", () => {
    const h = states({ working: ["MARK"], idle: ["^last$\\z"] });
    const body = ["MARK", ...Array.from({ length: 38 }, (_, i) => `line ${i}`), "last"];
    expect(readScreen(h, [...body, "", "   ", "\t", "", ""].join("\n"))).toBe("working");
    expect(readScreen(states({ idle: ["^last\\z"] }), "x\nlast\n\n  \n")).toBe("idle");
  });

  it("reads \\r\\n screens", () => {
    const h = states({ idle: ["^ready$"], working: ["^run\\z"] });
    expect(readScreen(h, "x\r\nready\r\ny\r\n")).toBe("idle");
    expect(readScreen(h, "x\r\nrun\r\n\r\n")).toBe("working");
  });

  it("^ and $ match at line ends", () => {
    const h = states({ working: ["^b$"] });
    expect(readScreen(h, "a\nb\nc")).toBe("working");
    expect(readScreen(h, "a\nab\nc")).toBe("unknown");
  });
});

describe("createStateReader debounce", () => {
  const rules = (debounce_ms: number) =>
    states({ debounce_ms, working: ["RUN"], waiting_for_approval: ["ALLOW"], idle: ["READY"] });
  const clock = () => {
    let t = 0;
    return { now: () => t, set: (v: number) => { t = v; } };
  };

  it("working to idle waits debounce_ms", () => {
    const c = clock();
    const r = createStateReader(rules(1500), c.now);
    expect(r.observe("RUN")).toBe("working");
    c.set(100);
    expect(r.observe("READY")).toBe("working");
    c.set(1599);
    expect(r.observe("READY")).toBe("working");
    c.set(1600);
    expect(r.observe("READY")).toBe("idle");
  });

  it("a screen change restarts the wait", () => {
    const c = clock();
    const r = createStateReader(rules(1500), c.now);
    expect(r.observe("RUN")).toBe("working");
    c.set(1000);
    expect(r.observe("READY 1")).toBe("working");
    c.set(2400);
    expect(r.observe("READY 2")).toBe("working");
    c.set(2600); // 1,600 ms after READY 1 appeared, but only 200 ms of READY 2
    expect(r.observe("READY 2")).toBe("working");
    c.set(3899);
    expect(r.observe("READY 2")).toBe("working");
    c.set(3900);
    expect(r.observe("READY 2")).toBe("idle");
  });

  it("working, waiting and unknown are returned at once", () => {
    const c = clock();
    const r = createStateReader(rules(1500), c.now);
    r.observe("READY");
    c.set(2000);
    expect(r.observe("READY")).toBe("idle");
    expect(r.observe("RUN")).toBe("working");
    expect(r.observe("ALLOW")).toBe("waiting_for_approval");
    expect(r.observe("nothing known")).toBe("unknown");
    expect(r.observe("RUN")).toBe("working");
  });

  it("a first idle gives unknown until the screen is stable", () => {
    const c = clock();
    const r = createStateReader(rules(1500), c.now);
    expect(r.observe("READY")).toBe("unknown");
    c.set(1499);
    expect(r.observe("READY")).toBe("unknown");
    c.set(1500);
    expect(r.observe("READY")).toBe("idle");
  });

  it("debounce_ms = 0 returns idle at once", () => {
    const c = clock();
    const r = createStateReader(rules(0), c.now);
    expect(r.observe("READY")).toBe("idle");
    expect(r.observe("RUN")).toBe("working");
    expect(r.observe("READY")).toBe("idle");
  });

  it("uses Date.now by default", () => {
    const r = createStateReader(rules(0));
    expect(r.observe("READY")).toBe("idle");
  });
});

describe("a slow pattern cannot stall", () => {
  const screens = {
    "40 lines of 2,000 a": Array.from({ length: 40 }, () => "a".repeat(2000)).join("\n"),
    "one line of 1,000,000 characters": "a".repeat(1_000_000),
  };
  for (const pattern of ["(a+)+b", "(a|a)*b"]) {
    for (const [label, screen] of Object.entries(screens)) {
      it(`${pattern} over ${label} returns in under 1,000 ms`, () => {
        const h = states({ working: [pattern] });
        const t0 = performance.now();
        expect(readScreen(h, screen)).toBe("unknown");
        expect(performance.now() - t0).toBeLessThan(1000);
      });
    }
  }
});

describe("patterns compile once per harness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("readScreen and createStateReader reuse the compiled set", () => {
    const spy = vi.spyOn(RE2JS, "compile");
    const h = states({ working: ["RUN", "BUSY"], waiting_for_approval: ["ALLOW"], idle: ["READY"] });
    readScreen(h, "READY");
    expect(spy).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 1000; i++) readScreen(h, `READY ${i}`);
    const r = createStateReader(h, () => 0);
    for (let i = 0; i < 1000; i++) r.observe(`RUN ${i}`);
    expect(spy).toHaveBeenCalledTimes(4);
    readScreen(states({ working: ["RUN"] }), "RUN");
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
