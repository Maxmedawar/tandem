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

// Audit (U-R1B-ANCHOR-2): screens built from each program's own UI code (read as text, never run;
// none is a capture). A real working or approval screen must keep its state: read as idle with
// an empty prompt, an agent's text would be typed into a busy agent or an open decision.
describe("(live) real layouts of pi, cursor-agent, copilot, cline and droid keep their state", () => {
  const R = "─".repeat(100);
  // pi 0.79.7: chat, queued messages, loader (a blank row, ` ⠋ Working...`), widgets above the
  // editor (a blank row, then up to 10 lines and a truncation line per widget), editor, footer.
  const piFoot = ["~/work (main)", "↑4.7k ↓44 R3.8k $0.009 (sub) 1.7%/272k (auto)"];
  const pi = (between: string[], editor: string[] = [""]) => [" I will look at the module now.", "", "", " ⠋ Working...", ...between, R, ...editor, R, ...piFoot];
  const widget = (n: number) => ["", ...Array.from({ length: n }, (_, i) => ` widget line ${i + 1}`)];
  // cline 3.0.74: the input bar (a rule, the `❯` row, a rule) stays under the transcript while a
  // turn runs; a queued-messages box sits above it; a reply or reasoning line may start with `❯`.
  const bar = (text = "Ask anything...") => ["─".repeat(80), `❯ ${text}`, "─".repeat(80), " ███░░░░ (1,024) $0.01   ○ Plan ● Act (Tab)"];
  const queued = (row: string, hint: string) => ["╭" + "─".repeat(78) + "╮", "│ Queued messages:".padEnd(79) + "│", `│ ${row}`.padEnd(79) + "│", `│ ${hint}`.padEnd(79) + "│", "╰" + "─".repeat(78) + "╯"];
  // cursor-agent 2026.11.11: an open decision (a rule, the preview, the title, option rows that
  // each end with a key hint, the selected one after `→ `) hides the prompt bar and its footer.
  // The bar has half-block edge rows only in a listed terminal with a UTF-8 locale; elsewhere
  // (tmux, Apple Terminal) it is the `→` row between blank rows.
  const decision = (preview: string[], title: string, options: string[], under: string[] = []) => ["  Done: the change is in place.", "", " " + "─".repeat(78), ...preview.map((l) => "  " + l), "", "  " + title, ...options.map((o) => "   " + o), "", ...under];
  const shell = ["  Run (once) (y)", "  Add Shell(npm) to allowlist? (tab)", "  Run Everything (shift+tab)", "  Skip & tell the agent what to do instead (esc or n)"];
  const pick = (options: string[], at: number) => options.map((o, i) => (i === at ? "→ " + o.slice(2) : o));
  const write = ["  Proceed (y)", "  Reject & propose changes (esc or n or p)", "  Add Write(src/a.ts) to allowlist? (tab)", "  Run Everything (shift+tab)"];
  const plainBar = (inner: string) => ["  Done: the change is in place.", "", "", "  " + inner, "", "   Composer 2 · 12%", "   ~/work · main"];
  const blockBar = (inner: string) => ["  Done: the change is in place.", "", " " + "▄".repeat(78), "  " + inner, " " + "▀".repeat(78), "   Composer 2 · 12%", "   ~/work · main"];
  // copilot 1.0.109: a permission, path, URL, extension or plan dialog is drawn instead of the
  // composer, its status row and its hint row; a status line or a notice may follow it.
  const box = (rows: string[]) => ["╭" + "─".repeat(70) + "╮", ...rows.map((r) => "│ " + r.padEnd(69) + "│"), "╰" + "─".repeat(70) + "╯"];
  const rail = (text: string) => [" ~/work [⎇ main]" + " ".repeat(30) + "claude-sonnet-4.5", "╻" + "▄".repeat(70), "┃ ❯ " + text, "╹" + "▀".repeat(70)];
  // droid 1.8.0: while a turn runs the input box shows its steer hint.
  const droidBox = ["╭" + "─".repeat(70) + "╮", "│ > Enter to steer · Ctrl+Enter to queue".padEnd(71) + "│", "╰" + "─".repeat(70) + "╯", "Auto (Off)  claude-sonnet-4-6" + " ".repeat(30) + "? for help"];

  const LIVE: [string, string, string[], StateName][] = [
    ["pi", "the loader, a blank row, the editor", pi([""]), "working"],
    ["pi", "a 3-line widget above the editor", pi(widget(3)), "working"],
    ["pi", "a 4-line widget above the editor", pi(widget(4)), "working"],
    ["pi", "a full widget (10 lines and its truncation line)", pi(widget(11)), "working"],
    ["pi", "typed steering text and a full widget", pi(widget(11), ["also fix the", "other test"]), "working"],
    ["cline", "a streamed reply with a line that starts with ❯", [" ❯ hello", "", " ⠹ Run this:", "   ❯ npm test", "   then check the log", "", ...bar()], "working"],
    ["cline", "streamed reasoning with a line that starts with ❯", [" ❯ hello", "", " ⠹ Thinking...", "   ❯ maybe run the tests first", "", ...bar()], "working"],
    ["cline", "a selected row in the queued-messages box", [" ❯ hello", "", " ⠹ Here is the plan", "", ...queued(" ❯ also fix lint", "↑/↓ navigate, Enter steer, Tab edit, Esc cancels turn"), ...bar()], "working"],
    ["cline", "a steering row in the queued-messages box, text typed in the bar", [" ❯ hello", "", " * Here is the plan", "", ...queued(" ⠹ also fix lint", "Enter with empty input to steer first · ↑ select or edit"), ...bar("and the docs")], "working"],
    ["cline", "a steering message in the transcript, the thinking line under it", [" ❯ hello", "", " * Here is the plan", "", " ❯ also fix lint", "", " ⠙ Thinking... (esc to cancel)", "", ...bar()], "working"],
    ["cursor-agent", "a command decision, the first row selected", decision(["$  npm test in ~/work"], "Run this command?", pick(shell, 0)), "waiting_for_approval"],
    ["cursor-agent", "a command decision, the allowlist row selected, lines under it", decision(["$  npm test in ~/work"], "Run this command?", pick(shell, 1), [" ".repeat(50) + "Goal active (12s)", " ".repeat(40) + "ctrl+r to review changed files", "", "  2 background jobs"]), "waiting_for_approval"],
    ["cursor-agent", "a command decision, the last row selected", decision(["$  npm test in ~/work"], "Run this command?", pick(shell, 3)), "waiting_for_approval"],
    ["cursor-agent", "two decisions, the pager footer", decision(["Approval 1 of 2", "", "$  npm test in ~/work"], "Run this command?", pick(shell, 2), ["  ←/→ to switch approval", ""]), "waiting_for_approval"],
    ["cursor-agent", "a write decision, the first row selected", decision(["src/a.ts +1 -1", "─".repeat(60), "  1 - old", "  1 + new"], "Write to this file?", pick(write, 0)), "waiting_for_approval"],
    ["cursor-agent", "a write decision, the allowlist row selected", decision(["src/a.ts +1 -1"], "Write to this file?", pick(write, 2)), "waiting_for_approval"],
    ["cursor-agent", "a write decision, the last row selected", decision(["src/a.ts +1 -1"], "Write to this file?", pick(write, 3)), "waiting_for_approval"],
    ["cursor-agent", "a delete decision, Keep selected", decision(["Delete file: src/a.ts"], "Delete this file?", pick(["  Delete (y)", "  Keep (n)"], 1)), "waiting_for_approval"],
    ["cursor-agent", "a tool decision, the propose row selected", decision(["server: tool"], "Run this MCP tool?", pick(["  Run (once) (y)", "  Allowlist MCP Tool (tab)", "  Reject & propose changes (p)", "  Skip (esc or n)"], 2)), "waiting_for_approval"],
    ["cursor-agent", "a running turn, the bar with no edge rows", plainBar("→ Add a follow-up" + " ".repeat(40) + "ctrl+c to stop"), "working"],
    ["cursor-agent", "a running turn, the bar with half-block edge rows", blockBar("→ Add a follow-up" + " ".repeat(40) + "ctrl+c to stop"), "working"],
    ["copilot", "a command dialog, a status line and a notice under it", ["● Running the tests now.", "", "Permission request (2 remaining)", "", ...box(["Run shell command", "", "$ npm test", "", "Do you want to run this command?", "", "❯ 1. Yes", "  2. Yes, and approve `npm test` for the rest of the running session", "  3. No, and tell Copilot what to do differently (Esc to stop)"]), " main ✓", " Update available"], "waiting_for_approval"],
    ["copilot", "an assisted dialog", ["● Running the tests now.", "", ...box(["Run shell command", "$ npm test", "What would you like to do?", "❯ 1. Yes", "  2. No (Esc)", "", "↑↓ navigate · enter select · ctrl+e explain"])], "waiting_for_approval"],
    ["copilot", "an extension dialog", ["● Loading.", "", ...box(['Extension "foo" wants elevated permissions', "It can observe tool calls.", "❯ 1. Yes", "  2. No (Esc)"]), " main ✓"], "waiting_for_approval"],
    ["copilot", "a plan dialog, a status line under it", ["● Planned.", "", "Plan Ready for Review", "", "  1. Accept plan and continue in Interactive execution mode", "  2. Accept plan and continue in Autopilot execution mode", "❯ 3. Suggest changes", "", " main ✓"], "waiting_for_approval"],
    ["copilot", "a running turn: the status row, the composer, the busy row under it", ["● Done.", "", ...rail(""), " ◐ Thinking  esc interrupt"], "working"],
    ["copilot", "a running turn with typed text and a status line", ["● Done.", "", ...rail("also do x"), " ◉ Executing  ctrl+c clear input · ctrl+q enqueue", " main ✓"], "working"],
    ["droid", "a running turn: the status line, the steer-hint box, the footer", ["⛬ ok", "", "⠋ Thinking... (Press ESC to stop)", "", ...droidBox], "working"],
    ["droid", "a running turn with a banner box under the footer", ["⠋ Executing... (Press ESC to stop)", " ☐ a todo", "", ...droidBox, "╭" + "─".repeat(40) + "╮", "│ Update available v1.9.0".padEnd(41) + "│", "╰" + "─".repeat(40) + "╯"], "working"],
  ];
  it.each(LIVE)("%s: %s", (name, _label, lines, want) => {
    const h = harnesses.get(name)!;
    const state = readScreen(h, lines.join("\n"));
    expect(state).toBe(want);
    expect(decideInput("agent", "type", state)).toBe("held");
    expect(decideInput("owner", "type", state)).toBe(want === "waiting_for_approval" ? "refused" : "enter");
  });

  // The other direction, on the real prompt layouts no fixture holds: a quoted approval or busy
  // line above the real prompt reads as that prompt alone does.
  const cursorApproval = linesOf(read("cursor-screens/waiting_for_approval-src.txt"));
  const cursorWorking = linesOf(read("cursor-screens/working-src.txt"));
  const QUOTED: [string, string, string[], string[]][] = [
    ["cursor-agent", "an approval above the empty bar with no edge rows", cursorApproval, plainBar("→ Add a follow-up")],
    ["cursor-agent", "an approval above typed text in the bar with no edge rows", cursorApproval, plainBar("→ " + T)],
    ["cursor-agent", "an approval above the empty bar with half-block edge rows", cursorApproval, blockBar("→ Add a follow-up")],
    ["cursor-agent", "a decision as drawn above the empty bar with no edge rows", decision(["$  npm test in ~/work"], "Run this command?", pick(shell, 0)), plainBar("→ Add a follow-up")],
    ["cursor-agent", "a write decision as drawn above typed text in the bar with no edge rows", decision(["src/a.ts +1 -1"], "Write to this file?", pick(write, 2)), plainBar("→ " + T)],
    ["cursor-agent", "a busy bar above the empty bar with no edge rows", cursorWorking, plainBar("→ Add a follow-up")],
    ["pi", "a busy screen with its editor above the idle editor", pi(widget(11)), linesOf(read("pi-screens/idle-doc.txt"))],
    ["cline", "a busy screen with its bar above the idle bar", [" ⠹ Run this:", "   ❯ npm test", "", ...bar()], [" * Done.", "", ...bar()]],
    ["cline", "a busy screen with its bar above typed text in the bar", [" ⠹ Run this:", "   ❯ npm test", "", ...bar()], [" * Done.", "", ...bar(T)]],
  ];
  it.each(QUOTED)("%s: quoted %s", (name, _label, block, bottom) => {
    const h = harnesses.get(name)!;
    const want = readScreen(h, bottom.join("\n"));
    expect(want).not.toBe("waiting_for_approval");
    expect(want).not.toBe("working");
    for (const b of [block, block.map((l) => "  " + l)]) {
      const q = [...b, "  That is the screen I saw.", "", ...bottom].join("\n");
      expect(readScreen(h, q)).toBe(want);
      if (want === "idle") expect(isPromptEmpty(h, q)).toBe(isPromptEmpty(h, bottom.join("\n")));
    }
  });
});
