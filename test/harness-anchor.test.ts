/**
 * U-R1B-ANCHOR: a state rule (`working`, `waiting_for_approval`, `idle`) is tied to the end of the
 * screen or to its menu context, so an agent reply that QUOTES a rule's own marker above a real
 * prompt does not change the state. A quoted approval would make the input gate refuse the owner;
 * a quoted working marker would hold agents and keep a send from ending.
 *
 * The table: for every built-in agent in COVERED, each real or sample screen of a state (the
 * source) gives a block of its last lines that alone reads that state; the block, quoted verbatim
 * or indented as a reply shows it, then one reply line and a blank line, then the agent's own
 * prompt (empty, or holding typed text) must read exactly as that prompt alone does.
 *
 * Stated limit: a quoted working marker that is the reply's LAST line directly above the prompt
 * frame, with nothing between, cannot be told from the real working screen by text alone (both
 * show the marker, then the frame); the table puts one reply line and one blank line between. An
 * approval quote is always told apart (the real menu replaces the frame).
 *
 * Pure: no session, no tmux, no network. Built-ins only; the owner folder is a missing folder.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses, type Harness, type StateName } from "../bridge/harness-registry.ts";
import { isPromptEmpty, readScreen } from "../bridge/harness-detect.ts";
import { decideInput } from "../bridge/input-gate.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const BUILTIN = join(REPO, "harnesses");
const F = join(REPO, "test", "fixtures");
const BOX = mkdtempSync(join(tmpdir(), "r1banc-"));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));
const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") });

const NAMES = readdirSync(BUILTIN).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort();
const COVERED = ["claude", "codex", "grok", "antigravity", "opencode", "gemini", "goose", "hermes", "shell", "pi", "cursor-agent", "copilot", "cline", "droid"];
const PENDING: string[] = [];

const STATES: StateName[] = ["working", "waiting_for_approval", "idle"];
const T = "delete the old bra";
const read = (p: string) => readFileSync(join(F, p), "utf8");
/** Screen lines as readScreen sees them: `\r` removed, trailing blank lines dropped. */
function linesOf(s: string): string[] {
  const lines = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1]!.trimEnd() === "") lines.pop();
  return lines;
}

/** Files in a fixture folder named `<state>-*.txt` (state not `unknown`), with that state. */
function stateFiles(dir: string, except: string[] = []): [string, StateName][] {
  const out: [string, StateName][] = [];
  for (const f of readdirSync(join(F, dir)).sort()) {
    const m = /^(working|waiting_for_approval|idle)-.*\.txt$/.exec(f);
    if (m && !except.includes(f)) out.push([`${dir}/${f}`, m[1] as StateName]);
  }
  return out;
}
/** `screens/<name>-<state>-<id>.txt`. */
function screenFiles(name: string): [string, StateName][] {
  const re = new RegExp(`^${name}-(working|waiting_for_approval|idle)-([a-z0-9]+)\\.txt$`);
  const out: [string, StateName][] = [];
  for (const f of readdirSync(join(F, "screens")).sort()) {
    const m = re.exec(f);
    if (m) out.push([`screens/${f}`, m[1] as StateName]);
  }
  return out;
}

const SOURCES: Record<string, () => [string, StateName][]> = {
  claude: () => screenFiles("claude"),
  codex: () => screenFiles("codex"),
  grok: () => screenFiles("grok"),
  opencode: () => screenFiles("opencode"),
  gemini: () => [...stateFiles("gemini-screens"), ...screenFiles("gemini")],
  antigravity: () => stateFiles("agy-screens"),
  goose: () => stateFiles("goose-screens"),
  pi: () => stateFiles("pi-screens"),
  "cursor-agent": () => stateFiles("cursor-screens"),
  copilot: () => stateFiles("copilot-screens", ["idle-typed-src.txt"]),
  cline: () => stateFiles("cline-screens"),
  droid: () => stateFiles("droid-screens"),
};

type Derive = ((s: string) => string) | string;
/** EMPTY bottom file, and how its TYPED bottom is made (a derivation, or a real file). */
const BOTTOMS: Record<string, [string, Derive]> = {
  claude: ["screens/claude-idle-real.txt", (s) => s.replace(/^❯[^\n]*$/m, "❯ " + T)],
  codex: ["screens/codex-idle-real.txt", (s) => s.replace(/^› [^\n]*$/m, "› " + T)],
  grok: ["screens/grok-idle-real.txt", (s) => s.replace(/❯ {20}/, "❯ " + T + " ")],
  antigravity: ["agy-screens/idle-real.txt", (s) => s.replace(/^>[ \t]*$/m, "> " + T)],
  opencode: ["screens/opencode-idle-real.txt", (s) => s.replace('Ask anything… "Fix broken tests"', T)],
  gemini: ["gemini-screens/idle-src.txt", (s) => s.replace("Type your message or @path/to/file", T)],
  goose: ["goose-screens/idle-src.txt", (s) => s.replace("> Enter to send · Ctrl+J newline", "> " + T)],
  pi: ["pi-screens/idle-doc.txt", (s) => s.replace(/(─{20,}\n)[ \t]*\n(─{20,})/, "$1" + T + "\n$2")],
  "cursor-agent": ["cursor-screens/idle-src.txt", (s) => s.replace("→ Plan, search, build anything", "→ " + T.padEnd(28))],
  copilot: ["copilot-screens/idle-src.txt", "copilot-screens/idle-typed-src.txt"],
  cline: ["cline-screens/idle-home-src.txt", (s) => s.replace("❯ What can I do for you?", "❯ " + T)],
  droid: ["droid-screens/idle-src.txt", (s) => s.replace('Try "Write unit tests for this file"', T + " ".repeat(17))],
};

/** The bottom screen: EMPTY is the file; TYPED is derived (and must differ) or a real file. */
function bottomOf(name: string, which: "EMPTY" | "TYPED"): string {
  const [file, derive] = BOTTOMS[name]!;
  const s = read(file);
  if (which === "EMPTY") return s;
  if (typeof derive === "string") return read(derive);
  const typed = derive(s);
  expect(typed, `${name} TYPED derivation changes the screen`).not.toBe(s);
  return typed;
}

/** BLOCK: the source's last k lines, k = min(12, lines), else the smallest k in 13..30 that reads the state. */
function blockOf(h: Harness, src: string, state: StateName): string[] {
  const lines = linesOf(src);
  const first = Math.min(12, lines.length);
  if (readScreen(h, lines.slice(-first).join("\n")) === state) return lines.slice(-first);
  for (let k = 13; k <= Math.min(30, lines.length); k++) {
    if (readScreen(h, lines.slice(-k).join("\n")) === state) return lines.slice(-k);
  }
  throw new Error("no quotable block");
}

/** Q: the block (verbatim or indented two spaces), one reply line, a blank line, then the bottom's last 38 - k lines. */
function quoted(block: string[], variant: "verbatim" | "indented", trimmed: string[]): string {
  const b = variant === "indented" ? block.map((l) => "  " + l) : block;
  return b.join("\n") + "\n  That is the screen I saw.\n\n" + trimmed.join("\n");
}

const agentsWithRules = COVERED.filter((n) => {
  const s = harnesses.get(n)?.states;
  return s !== undefined && STATES.some((st) => (s[st] ?? []).length > 0);
});

interface Row { name: string; file: string; state: StateName; bottom: "EMPTY" | "TYPED"; variant: "verbatim" | "indented"; want: string }
const ROWS: Row[] = [];
for (const name of agentsWithRules) {
  const h = harnesses.get(name)!;
  for (const [file, state] of SOURCES[name]!()) {
    for (const bottom of ["EMPTY", "TYPED"] as const) {
      let want: string;
      try { want = readScreen(h, bottomOf(name, bottom)); } catch { want = "?"; }
      for (const variant of ["verbatim", "indented"] as const) ROWS.push({ name, file, state, bottom, variant, want });
    }
  }
}

/** Builds Q for one row (asserting the block and the trimmed bottom keep their meaning). */
function build(r: Row): { h: Harness; q: string; trimmed: string } {
  const h = harnesses.get(r.name)!;
  const block = blockOf(h, read(r.file), r.state);
  expect(readScreen(h, block.join("\n")), "BLOCK alone reads the source state").toBe(r.state);
  const bottom = bottomOf(r.name, r.bottom);
  const trimmed = linesOf(bottom).slice(-(38 - block.length)).join("\n");
  expect(readScreen(h, trimmed), "the trimmed bottom reads as the bottom").toBe(readScreen(h, bottom));
  expect(isPromptEmpty(h, trimmed), "the trimmed bottom's prompt is as empty as the bottom's").toBe(isPromptEmpty(h, bottom));
  return { h, q: quoted(block, r.variant, linesOf(trimmed)), trimmed };
}

describe("harness anchor: the table covers every built-in harness file", () => {
  it("the built-ins load with no error", () => {
    expect(errors).toEqual([]);
    expect([...harnesses.keys()].sort()).toEqual(NAMES);
  });

  it("(cov) COVERED and PENDING do not overlap and together are every harness file", () => {
    expect(COVERED.filter((n) => PENDING.includes(n))).toEqual([]);
    expect([...COVERED, ...PENDING].sort()).toEqual(NAMES);
    expect(NAMES).toHaveLength(14);
  });

  it("every source and bottom file named exists", () => {
    for (const [file, typed] of Object.values(BOTTOMS)) {
      expect(existsSync(join(F, file)), file).toBe(true);
      if (typeof typed === "string") expect(existsSync(join(F, typed)), typed).toBe(true);
    }
    for (const name of agentsWithRules) expect(SOURCES[name]!().length, `${name} sources`).toBeGreaterThan(0);
  });

  it("hermes is an adapter agent with no working, approval or idle pattern", () => {
    const s = harnesses.get("hermes")!.states;
    for (const st of STATES) expect(s?.[st] ?? []).toEqual([]);
    expect(agentsWithRules).not.toContain("hermes");
  });

  it("shell has no state pattern: every quoted screen reads unknown with it", () => {
    const shell = harnesses.get("shell")!;
    expect(agentsWithRules).not.toContain("shell");
    for (const r of ROWS) {
      const h = harnesses.get(r.name)!;
      let block: string[];
      try { block = blockOf(h, read(r.file), r.state); } catch { continue; }
      const bottom = bottomOf(r.name, r.bottom);
      const q = quoted(block, r.variant, linesOf(bottom).slice(-(38 - block.length)));
      expect(readScreen(shell, q), `${r.name} ${r.file}`).toBe("unknown");
    }
  });
});

describe.each(agentsWithRules.flatMap((name) => SOURCES[name]!().map(([file, state]) => [name, file, state] as const)))(
  "(src) %s %s",
  (name, file, state) => {
    it(`reads ${state}`, () => {
      expect(readScreen(harnesses.get(name)!, read(file))).toBe(state);
    });
  },
);

describe("(quoted) a quoted state marker above the real prompt reads as the prompt", () => {
  it.each(ROWS.map((r) => [`${r.name} ${r.file} above ${r.bottom} (${r.variant}): quoted ${r.state}, prompt reads ${r.want}`, r] as const))(
    "%s",
    (_title, r) => {
      const { h, q, trimmed } = build(r);
      expect(q.split("\n").length).toBeLessThanOrEqual(40);
      const want = readScreen(h, trimmed);
      expect(readScreen(h, q)).toBe(want);
      if (want === "idle") expect(isPromptEmpty(h, q)).toBe(isPromptEmpty(h, trimmed));
      expect(decideInput("owner", "type", readScreen(h, q))).toBe("enter");
    },
  );
});

// Audit (U-R1B-ANCHOR-1): grok 1.0.77's real approval screens were never recorded (U-R1A-14L audit,
// Limits). Its program text holds `Waiting on plan approval` and `No plan written: approve or request
// changes` beside the working status texts (the status line sits above the composer box), a `Type
// revision notes...` composer placeholder, and approve / request changes key hints with no
// `N/N:select`. So a rule for a status or option-row marker must not need the composer box to be
// gone: read as idle, an agent's text would be typed into the approval. These screens are built
// from the real composer box, not captured.
describe("(live) grok: an approval marker above the composer box still reads waiting_for_approval", () => {
  const real = linesOf(read("screens/grok-idle-real.txt"));
  const at = real.map((l) => l.includes("╭─")).lastIndexOf(true);
  const box = real.slice(at, at + 3);
  const HINTS = "  a:approve  │  r:request changes  │  c:copy plan  │  p:show plan";
  it.each([
    ["the plan approval status line", ["   ◆ Waiting on plan approval"]],
    ["the no-plan status line", ["   ◆ No plan written: approve or request changes"]],
    ["the reject option row", ["   (●) Yes, approve", "   (○) No, reject (type to add feedback)"]],
  ])("%s, the composer box, a key-hint footer", (_label, marker) => {
    const h = harnesses.get("grok")!;
    expect(box.map((l) => l.trim()[0])).toEqual(["╭", "│", "╰"]);
    for (const screen of [[...real.slice(0, at), ...marker, ...box, HINTS], [...real.slice(0, at), ...marker, "", ...box]]) {
      const state = readScreen(h, screen.join("\n"));
      expect(state).toBe("waiting_for_approval");
      expect(decideInput("owner", "type", state)).toBe("refused");
      expect(decideInput("agent", "type", state)).toBe("held");
    }
  });
});
