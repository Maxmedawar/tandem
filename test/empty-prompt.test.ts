/**
 * U-R1A-18D-1: an agent's text enters a session only at an EMPTY prompt (bridge/input-gate.ts).
 * The harness file's `states.empty_prompt` patterns say when the input row holds nothing or only
 * the agent's own placeholder; a file without them gets the code rule (the last line is a bare
 * prompt). An idle screen whose prompt holds a person's unsent text is held: `prompt not empty`.
 *
 * No tmux session is started here: sessions are HarnessSessions over a terminal that only shows
 * screens (anything that would type into it throws). HOME, TANDEM_HOME and TMUX_TMPDIR are one
 * new temporary folder, removed after the file.
 */
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessTerminal } from "../bridge/engines/harness-engine.ts";

delete process.env.TMUX;
const BOX = mkdtempSync(join(tmpdir(), "r1a18d-"));
process.env.TMUX_TMPDIR = BOX;
process.env.TANDEM_HOME = join(BOX, "tandem");
process.env.HOME = join(BOX, "home");
mkdirSync(join(BOX, "home"));
const WORK = join(BOX, "work");
mkdirSync(WORK);
const OWNER = join(BOX, "owner");
mkdirSync(OWNER, { mode: 0o700 });
chmodSync(OWNER, 0o700);
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SCREENS = join(FIXTURES, "screens");
const BUILTIN = fileURLToPath(new URL("../harnesses/", import.meta.url));
const FAKE = join(FIXTURES, "fake-cli.sh");

// Red first: each row fails on its own before the code exists, instead of the file failing to load.
const detect: Partial<typeof import("../bridge/harness-detect.ts")> = await import("../bridge/harness-detect.ts").catch(() => ({}));
const gate: Partial<typeof import("../bridge/input-gate.ts")> = await import("../bridge/input-gate.ts").catch(() => ({}));
const { HarnessSession } = await import("../bridge/engines/harness-engine.ts");
const { loadHarnesses } = await import("../bridge/harness-registry.ts");

const { harnesses: builtins, errors: builtinErrors } = loadHarnesses({ installDir: BUILTIN, ownerDir: join(BOX, "no-owner") });
const claude = builtins.get("claude")!;
const codex = builtins.get("codex")!;
const shell = builtins.get("shell")!;

// Owner files for (o) and (p): one 0700 folder, each file 0600.
const head = (name: string) => `name = "${name}"\nprogram = "${FAKE}"\nhas_prompts = true\n[states]\nidle = ['^fake>']\n`;
const ownerFiles: Record<string, string> = {
  "r1a18d-loose": `${head("r1a18d-loose")}debounce_ms = 0\n`,
  "r1a18d-p-ok": `${head("r1a18d-p-ok")}empty_prompt = ['^fake>\\z']\n`,
  "r1a18d-p-bad": `${head("r1a18d-p-bad")}empty_prompt = ['(unclosed']\n`,
  "r1a18d-p-zero": `${head("r1a18d-p-zero")}empty_prompt = []\n`,
  "r1a18d-p-nine": `${head("r1a18d-p-nine")}empty_prompt = [${Array(9).fill("'x'").join(", ")}]\n`,
  "r1a18d-p-type": `${head("r1a18d-p-type")}empty_prompt = 'x'\n`,
  "r1a18d-p-typo": `${head("r1a18d-p-typo")}empty_promt = ['x']\n`,
  "r1a18d-p-none": head("r1a18d-p-none"),
};
for (const [name, text] of Object.entries(ownerFiles)) writeFileSync(join(OWNER, `${name}.toml`), text, { mode: 0o600 });
const owned = loadHarnesses({ installDir: join(BOX, "no-builtin"), ownerDir: OWNER });

const N = " ";
const read = (p: string) => readFileSync(p, "utf8");
const CL = read(join(SCREENS, "claude-idle-real.txt"));
const CL3 = read(join(SCREENS, "claude-idle-3.txt"));
const CX = read(join(SCREENS, "codex-idle-real.txt"));

/** CL with its one `❯` line replaced by `row`, and `after` inserted right after the next border line. */
function clRow(row: string, after?: string): string {
  const lines = CL.split("\n");
  const at = lines.findIndex((l) => l.startsWith("❯"));
  lines[at] = row;
  if (after !== undefined) {
    const border = lines.findIndex((l, i) => i > at && l.startsWith("─".repeat(20)));
    lines.splice(border + 1, 0, after);
  }
  return lines.join("\n");
}
/** CX with its `› ` line replaced by `row`, and `between` inserted right after it. */
function cxRow(row: string, between?: string): string {
  const lines = CX.split("\n");
  const at = lines.findIndex((l) => l.startsWith("› "));
  lines.splice(at, 1, ...(between === undefined ? [row] : [row, between]));
  return lines.join("\n");
}

/** A terminal that only shows screens; anything that would type into it throws. */
function screenOnly(next: () => string | Promise<string>): HarnessTerminal {
  const typed = (): never => {
    throw new Error("the input gate typed into the session");
  };
  return {
    name: "r1a18d-stub",
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
const over = (h: typeof claude, screen: string) => new HarnessSession(h, screenOnly(() => screen));

const HELD_REASON = { verdict: "held", state: "idle", reason: "prompt not empty" };
const ENTER = { verdict: "enter", state: "idle" };

async function timed(session: object, from: "owner" | "agent", action: "type" | "interrupt") {
  const started = Date.now();
  const answer = await gate.admitInput!(session, from, action);
  return { answer, took: Date.now() - started };
}
/** Agent text held with the reason, decided on the first read. */
async function heldNow(session: object) {
  const { answer, took } = await timed(session, "agent", "type");
  expect(answer).toStrictEqual(HELD_REASON);
  expect(took).toBeLessThan(240);
}

const TEMPLATES = (file: string) => [
  "fix lint errors",
  "fix typecheck errors",
  `how does ${file} work?`,
  `refactor ${file}`,
  "how do I log an error?",
  `edit ${file} to...`,
  `write a test for ${file}`,
  "create a util logging.py that...",
];

const TYPED_A: [string, typeof claude, string][] = [
  ["claude, space", claude, clRow("❯ delete the old bra")],
  ["claude, NBSP", claude, clRow(`❯${N}delete the old bra`)],
  ["codex", codex, cxRow("› delete the old bra")],
];

describe("(a) GAP 1 regression: a person's unsent text in an idle prompt", () => {
  it.each(TYPED_A)("%s: reads idle; agent text held (prompt not empty); owner text enters", async (_l, h, screen) => {
    expect(detect.readScreen!(h, screen)).toBe("idle");
    await heldNow(over(h, screen));
    expect(await gate.admitInput!(over(h, screen), "owner", "type")).toStrictEqual(ENTER);
  });
});

describe("(b) empty prompts", () => {
  const claudeEmpty: [string, string][] = [
    ["CL", CL],
    ["claude-idle-3", CL3],
    ["bare ❯", clRow("❯")],
    ["❯ NBSP", clRow(`❯${N}`)],
    ["❯ NBSP spaces", clRow(`❯${N}   `)],
    ...TEMPLATES("README.md").map((t): [string, string] => [`Try "${t}"`, clRow(`❯${N}Try "${t}"`)]),
    ...TEMPLATES("<filepath>").map((t): [string, string] => [`Try "${t}"`, clRow(`❯${N}Try "${t}"`)]),
  ];
  it.each(claudeEmpty)("claude: %s is empty", (_l, screen) => {
    expect(detect.isPromptEmpty!(claude, screen)).toBe(true);
  });
  it.each([
    ["CX", true, CX],
    ["follow-up placeholder", true, cxRow("› Ask a follow-up question")],
    ["bare ›", true, cxRow("›")],
    ["Waiting for startup", false, cxRow("› Waiting for startup")],
  ] as [string, boolean, string][])("codex: %s is empty = %s", (_l, empty, screen) => {
    expect(detect.isPromptEmpty!(codex, screen)).toBe(empty);
  });
  it.each([
    ["claude-idle-real", claude, CL, 2250],
    ["claude-idle-3", claude, CL3, 2250],
    ["codex-idle-real", codex, CX, 5000],
  ] as [string, typeof claude, string, number][])("gate: agent text at %s enters after the debounce", async (_l, h, screen, ms) => {
    const { answer, took } = await timed(over(h, screen), "agent", "type");
    expect(answer).toStrictEqual(ENTER);
    expect(took).toBeGreaterThanOrEqual(ms);
  }, 20_000);
  it("gate: codex Waiting for startup is held (prompt not empty)", async () => {
    await heldNow(over(codex, cxRow("› Waiting for startup")));
  });
});

const TYPED_C: [string, typeof claude, string][] = [
  ["claude, text before the placeholder", claude, clRow(`❯${N}fix it Try "refactor <filepath>"`)],
  ["claude, text after the placeholder", claude, clRow(`❯${N}Try "refactor <filepath>" now`)],
  ["claude, half a placeholder", claude, clRow(`❯${N}Try "refactor`)],
  ["codex, text before the placeholder", codex, cxRow("› fix it Ask Codex to do anything")],
  ["codex, text after the placeholder", codex, cxRow("› Ask Codex to do anything now")],
];
describe("(c) typed text plus placeholder", () => {
  it.each(TYPED_C)("%s: not empty; agent text held", async (_l, h, screen) => {
    expect(detect.isPromptEmpty!(h, screen)).toBe(false);
    await heldNow(over(h, screen));
  });
});

describe("(d) multi-line input", () => {
  it("claude: reads unknown; agent text held (unknown, no reason)", async () => {
    const screen = clRow(`❯${N}first line\n  second line`);
    expect(detect.readScreen!(claude, screen)).toBe("unknown");
    expect(await gate.admitInput!(over(claude, screen), "agent", "type")).toStrictEqual({ verdict: "held", state: "unknown" });
  });
  it("codex: reads idle; agent text held (prompt not empty)", async () => {
    const screen = cxRow("› first line\n  second line");
    expect(detect.readScreen!(codex, screen)).toBe("idle");
    await heldNow(over(codex, screen));
  });
});

const TYPED_E: [string, typeof claude, string][] = [
  ["claude", claude, clRow(`❯${N}/`, "  /help    Show help\n  /review  Review a pull request")],
  ["codex", codex, cxRow("› /", "  /model   choose what model to use\n  /review  review my current changes")],
];
const TYPED_F: [string, typeof claude, string][] = [
  ["claude", claude, clRow(`❯${N}[Pasted text #1 +12 lines]`)],
  ["codex", codex, cxRow("› [Pasted Content 1204 chars]")],
];
const TYPED_H: [string, typeof claude, string][] = [
  ["claude", claude, clRow(`❯${N}deploy the app`, "  search prompts: dep")],
  ["codex", codex, cxRow("› deploy the app")],
];
describe.each([
  ["(e) slash menu open", TYPED_E],
  ["(f) pasted text collapsed", TYPED_F],
  ["(h) selected-history text", TYPED_H],
] as [string, [string, typeof claude, string][]][])("%s", (_d, rows) => {
  it.each(rows)("%s: reads idle; agent text held (prompt not empty)", async (_l, h, screen) => {
    expect(detect.readScreen!(h, screen)).toBe("idle");
    await heldNow(over(h, screen));
  });
});

describe("(g) queued messages", () => {
  it.each([
    ["claude", claude, "Press up to edit queued messages\n" + read(join(SCREENS, "claude-working-real.txt"))],
    ["codex", codex, "↳ run the tests\n" + read(join(SCREENS, "codex-working-1.txt"))],
  ] as [string, typeof claude, string][])("%s: reads working; agent text held (working)", async (_l, h, screen) => {
    expect(detect.readScreen!(h, screen)).toBe("working");
    expect(await gate.admitInput!(over(h, screen), "agent", "type")).toStrictEqual({ verdict: "held", state: "working" });
  });
});

describe("(i) narrow terminal wrapping", () => {
  it("claude: a wrapped placeholder reads unknown; held (unknown)", async () => {
    const screen = clRow(`❯${N}Try "write a test for\nverylongname.ts"`);
    expect(detect.readScreen!(claude, screen)).toBe("unknown");
    expect(await gate.admitInput!(over(claude, screen), "agent", "type")).toStrictEqual({ verdict: "held", state: "unknown" });
  });
  it("codex: a wrapped placeholder reads idle; held (prompt not empty)", async () => {
    const screen = cxRow("› Ask Codex to do\n  anything");
    expect(detect.readScreen!(codex, screen)).toBe("idle");
    await heldNow(over(codex, screen));
  });
});

describe("(j) ANSI-only differences", () => {
  it.each([
    ["claude", claude, clRow(`❯${N}\x1b[2mTry "refactor <filepath>"\x1b[0m`)],
    ["codex", codex, cxRow("› \x1b[2mAsk Codex to do anything\x1b[0m")],
  ] as [string, typeof claude, string][])("%s: a placeholder with attributes is not empty; held", async (_l, h, screen) => {
    expect(detect.isPromptEmpty!(h, screen)).toBe(false);
    await heldNow(over(h, screen));
  });
  it("residual R1: unsent text exactly equal to a placeholder reads empty", () => {
    expect(detect.isPromptEmpty!(claude, clRow(`❯${N}Try "fix lint errors"`))).toBe(true);
  });
});

describe("(k) screen not capturable", () => {
  it("claude file over a terminal whose screen() rejects: held (unknown), no reason", async () => {
    const session = new HarnessSession(claude, screenOnly(() => Promise.reject(new Error("no screen"))));
    expect(await gate.admitInput!(session, "agent", "type")).toStrictEqual({ verdict: "held", state: "unknown" });
  });
});

describe("(l) shell unchanged", () => {
  it("shell over typed text: agent held (unknown); owner enters (unknown)", async () => {
    const screen = "user@host:~/w$ rm -rf half";
    expect(await gate.admitInput!(over(shell, screen), "agent", "type")).toStrictEqual({ verdict: "held", state: "unknown" });
    expect(await gate.admitInput!(over(shell, screen), "owner", "type")).toStrictEqual({ verdict: "enter", state: "unknown" });
  });
});

describe("(m) owner and interrupt unchanged over every typed screen", () => {
  const rows = [...TYPED_A, ...TYPED_C, ...TYPED_E, ...TYPED_F, ...TYPED_H];
  it.each(rows)("%s: owner type and interrupt enter, agent interrupt refused, no reason", async (_l, h, screen) => {
    for (const [from, action, verdict] of [["owner", "type", "enter"], ["owner", "interrupt", "enter"], ["agent", "interrupt", "refused"]] as const) {
      const { answer, took } = await timed(over(h, screen), from, action);
      expect(answer, `${from} ${action}`).toStrictEqual({ verdict, state: "idle" });
      expect(took).toBeLessThan(240);
    }
  });
});

describe("(n) the settle rule unchanged", () => {
  const typed = TYPED_A[0]![2];
  const seq = (list: string[]) => {
    const last = list[list.length - 1]!;
    return new HarnessSession(claude, screenOnly(() => list.shift() ?? last));
  };
  it("[CL, CL, typed, ...]: held (prompt not empty) after the third read", async () => {
    const { answer, took } = await timed(seq([CL, CL, typed, typed]), "agent", "type");
    expect(answer).toStrictEqual(HELD_REASON);
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(2250);
  }, 10_000);
  it("[typed, CL, CL, ...]: held (prompt not empty) on the first read", async () => {
    await heldNow(seq([typed, CL, CL]));
  });
});

describe("(o) the code rule (no empty_prompt)", () => {
  it.each(["fake>", "fake> ", "x\nfake>", "reply: x  \nfake>\n", ">", "❯", "  › "])("%j is empty", (s) => {
    expect(detect.isPromptEmpty!({}, s)).toBe(true);
  });
  it.each(["fake> hello", "fake> a>", "fake>abc>", "? for shortcuts", "", "fake> slow\nfake is thinking"])("%j is not empty", (s) => {
    expect(detect.isPromptEmpty!({}, s)).toBe(false);
  });
  // Every idle fixture of the built-ins with no empty_prompt row yet (18D-2 adds them): held.
  const others = [
    ...readdirSync(SCREENS).filter((f) => /^(?!claude-|codex-)[a-z0-9]+-idle-.*\.txt$/.test(f)).map((f) => join("screens", f)),
    ...readdirSync(FIXTURES)
      .filter((d) => d.endsWith("-screens"))
      .flatMap((d) => readdirSync(join(FIXTURES, d)).filter((f) => f.startsWith("idle")).map((f) => join(d, f))),
  ].sort();
  it("covers the nine named fixtures", () => {
    for (const f of ["screens/grok-idle-real.txt", "screens/opencode-idle-real.txt", "agy-screens/idle-real.txt", "pi-screens/idle-doc.txt", "gemini-screens/idle-src.txt", "cursor-screens/idle-src.txt", "copilot-screens/idle-src.txt", "cline-screens/idle-home-src.txt", "droid-screens/idle-src.txt"]) {
      expect(others).toContain(f);
    }
  });
  it.each(others)("%s is not empty by the code rule", (f) => {
    expect(detect.isPromptEmpty!({}, read(join(FIXTURES, f)))).toBe(false);
  });

  const stub = (screen: string, extra: object = {}) => ({ inputState: async () => ({ state: "idle", screen, debounceMs: 0 }), ...extra });
  it("stubs: fake> enters; fake> hello held; a throwing promptEmpty held; the session's own rule wins", async () => {
    expect(await gate.admitInput!(stub("fake>"), "agent", "type")).toStrictEqual(ENTER);
    await heldNow(stub("fake> hello"));
    await heldNow(stub("fake>", { promptEmpty: () => { throw new Error("x"); } }));
    expect(await gate.admitInput!(stub("fake> hello", { promptEmpty: () => true }), "agent", "type")).toStrictEqual(ENTER);
  });
  it("owner file r1a18d-loose (no empty_prompt): fake> hello reads idle and is held; fake> enters", async () => {
    const loose = owned.harnesses.get("r1a18d-loose")!;
    expect(loose).toBeDefined();
    expect(detect.readScreen!(loose, "fake> hello")).toBe("idle");
    await heldNow(over(loose, "fake> hello"));
    expect(await gate.admitInput!(over(loose, "fake>"), "agent", "type")).toStrictEqual(ENTER);
  });
});

describe("(p) the loader", () => {
  it("empty_prompt loads as written", () => {
    expect(owned.harnesses.get("r1a18d-p-ok")?.states?.empty_prompt).toEqual(["^fake>\\z"]);
  });
  it.each([
    ["r1a18d-p-bad", "bad pattern in states.empty_prompt"],
    ["r1a18d-p-zero", "bad states.empty_prompt: 1 to 8 patterns"],
    ["r1a18d-p-nine", "bad states.empty_prompt: 1 to 8 patterns"],
    ["r1a18d-p-type", "wrong type for states.empty_prompt: expected an array of strings"],
    ["r1a18d-p-typo", "unknown field states.empty_promt"],
  ])("%s is refused: %s", (name, reason) => {
    const file = join(OWNER, `${name}.toml`);
    expect(owned.errors.filter((e) => e.file === file)).toEqual([{ file, reason }]);
    expect(owned.harnesses.has(name)).toBe(false);
  });
  it("a file without the field has no empty_prompt key", () => {
    const states = owned.harnesses.get("r1a18d-p-none")?.states;
    expect(states).toBeDefined();
    expect(Object.hasOwn(states!, "empty_prompt")).toBe(false);
  });
  it("the built-ins load with no error; claude and codex each have one empty_prompt pattern", () => {
    expect(builtinErrors).toEqual([]);
    expect(claude.states?.empty_prompt).toHaveLength(1);
    expect(codex.states?.empty_prompt).toHaveLength(1);
  });
});

// Audit (U-R1A-18D-1): the empty box or composer must be the one in use, not an older one still
// on the screen, and nothing a person typed may sit between it and the footer.
describe("(q) audit: only the prompt in use counts", () => {
  const RULE = CL.split("\n").find((l) => l.startsWith("─".repeat(20)))!;
  const emptyBox = `${RULE}\n❯${N}\n${RULE}`;
  /** CL with an older, empty box left above the box in use, whose row is `row`. */
  const ghost = (row: string) => CL.replace(RULE, `${emptyBox}\n\n${RULE}`).replace(/^❯[^\n]*Try [^\n]*$/m, row);
  /** The composer row, the blank line, the status line and the footer. */
  const cxPane = (row: string) => cxRow(row).trimEnd().split("\n").slice(-4).join("\n");
  const rows: [string, typeof claude, string][] = [
    ["claude: an older empty box above the typed box", claude, ghost(`❯${N}delete the old bra`)],
    ["claude: an older empty box above a box in shell mode", claude, ghost(`!${N}rm -rf half`)],
    ["codex: text after a leading line break", codex, cxRow("› ", "  rm -rf half")],
    ["codex: text after two leading line breaks", codex, cxRow("› ", "\n  rm -rf half")],
    ["codex: a text line under the placeholder", codex, cxRow("› Ask Codex to do anything", "  more")],
    ["codex: an empty row right above the typed composer", codex, cxRow("› ", "› delete the old bra")],
    ["codex: an older empty composer above the typed one", codex, `${CX.trimEnd()}\n${cxPane("› delete the old bra")}`],
  ];
  it.each(rows)("%s: not empty; agent text is never admitted", async (_l, h, screen) => {
    expect(detect.isPromptEmpty!(h, screen)).toBe(false);
    expect((await gate.admitInput!(over(h, screen), "agent", "type")).verdict).toBe("held");
  });
  it("the helper screens hold the typed row", () => {
    expect(cxPane("› delete the old bra").startsWith("› delete the old bra\n")).toBe(true);
    expect(ghost(`❯${N}delete the old bra`).split("\n").filter((l) => l.startsWith("❯"))).toEqual([`❯${N}`, `❯${N}delete the old bra`]);
  });
  it("the older box alone above the empty box in use still reads empty", () => {
    expect(detect.isPromptEmpty!(claude, ghost(`❯${N}`))).toBe(true);
    expect(detect.isPromptEmpty!(codex, `${CX.trimEnd()}\n${cxPane("› ")}`)).toBe(true);
  });
});
