/**
 * U-R1A-13: scripts/lint-agents.sh finds an agent name in code outside harness files and their
 * adapters (A), an agent named as the default in the docs or tool text (B), and an agent on by
 * default in .env.example (C). Each case lints a fresh copy of the tree in a /tmp/r1a13- folder.
 */
import { describe, it, expect, afterAll } from "vitest";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "lint-agents.sh");
const BOX = mkdtempSync("/tmp/r1a13-lint-");
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

const BOX16 = mkdtempSync("/tmp/r1a16-lint-");
afterAll(() => rmSync(BOX16, { recursive: true, force: true }));

let n = 0;
/** A copy of the linted parts of the tree. */
function copy(box = BOX): string {
  const dir = join(box, `copy-${n++}`);
  for (const p of ["harnesses", "bridge", "src", "hub/src", "README.md", "SETUP.md", ".env.example"]) {
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  }
  return dir;
}

function lint(dir: string): { rc: number | null; lines: string[] } {
  const r = spawnSync("sh", [SCRIPT, dir], { encoding: "utf8" });
  return { rc: r.status, lines: `${r.stdout}${r.stderr}`.trim().split("\n") };
}

describe("lint-agents.sh", () => {
  it("the tree passes", () => {
    const r = lint(copy());
    expect(r.lines.at(-1)).toBe("lint-agents: PASS");
    expect(r.rc).toBe(0);
  });

  it("an agent name as a quoted string in bridge/ code fails A naming the file and line", () => {
    const dir = copy();
    writeFileSync(join(dir, "bridge", "x.ts"), "export {}\nconst x = 'codex'\n");
    const r = lint(dir);
    expect(r.lines).toContain("A bridge/x.ts:2");
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });

  it("the same line in bridge/transcripts/readers/ passes", () => {
    const dir = copy();
    mkdirSync(join(dir, "bridge", "transcripts", "readers"), { recursive: true });
    writeFileSync(join(dir, "bridge", "transcripts", "readers", "x.ts"), "export {}\nconst x = 'codex'\n");
    const r = lint(dir);
    expect(r.lines.at(-1)).toBe("lint-agents: PASS");
    expect(r.rc).toBe(0);
  });

  it("a comment line naming 'claude' passes, and so does 'pipeline'", () => {
    const dir = copy();
    writeFileSync(
      join(dir, "bridge", "y.ts"),
      "// runs 'claude'\n/* or \"codex\" */\n * `grok`\nconst y = 'pipeline'\nconst z = 'claude-x'\n",
    );
    const r = lint(dir);
    expect(r.lines.at(-1)).toBe("lint-agents: PASS");
    expect(r.rc).toBe(0);
  });

  it("`Default to grok.` in README.md fails B", () => {
    const dir = copy();
    const lines = readFileSync(join(dir, "README.md"), "utf8").split("\n").length;
    appendFileSync(join(dir, "README.md"), "Default to grok.\n");
    const r = lint(dir);
    expect(r.lines).toContain(`B README.md:${lines}`);
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });

  it("TANDEM_ENABLED_ENGINES=claude in .env.example fails C", () => {
    const dir = copy();
    const file = join(dir, ".env.example");
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^TANDEM_ENABLED_ENGINES=$/m);
    writeFileSync(file, text.replace(/^TANDEM_ENABLED_ENGINES=$/m, "TANDEM_ENABLED_ENGINES=claude"));
    const r = lint(dir);
    expect(r.lines.some((l) => /^C \.env\.example:\d+$/.test(l))).toBe(true);
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });

  it("a missing ROOT or harnesses/ is an ERROR with rc 2", () => {
    expect(lint(join(BOX, "nowhere"))).toMatchObject({ rc: 2 });
    const dir = copy();
    rmSync(join(dir, "harnesses"), { recursive: true });
    const r = lint(dir);
    expect(r.rc).toBe(2);
    expect(r.lines.at(-1)).toMatch(/^lint-agents: ERROR /);
  });
});

// U-R1A-16: an agent name may stand in quotes only in the adapter file a built-in harness file
// names (rule A's exemption), an adapter file must exist (rule D), and no U-R1A-16 ALLOW row is left.
describe("lint-agents.sh adapters (U-R1A-16)", () => {
  const lineCount = (file: string) => readFileSync(file, "utf8").split("\n").length;

  it("the tree passes and the script holds no U-R1A-16 row", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toContain("U-R1A-16");
    const r = lint(copy(BOX16));
    expect(r.lines.at(-1)).toBe("lint-agents: PASS");
    expect(r.rc).toBe(0);
  });

  it("'hermes' on a code line of bridge/router.ts fails A there", () => {
    const dir = copy(BOX16);
    const file = join(dir, "bridge", "router.ts");
    appendFileSync(file, "const r1a16 = 'hermes'\n");
    const r = lint(dir);
    expect(r.lines).toContain(`A bridge/router.ts:${lineCount(file) - 1}`);
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });

  it("'claude' on a code line of the hermes adapter fails A there", () => {
    const dir = copy(BOX16);
    const file = join(dir, "bridge", "engines", "hermes.ts");
    appendFileSync(file, "export const r1a16 = 'claude'\n");
    const r = lint(dir);
    expect(r.lines).toContain(`A bridge/engines/hermes.ts:${lineCount(file) - 1}`);
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });

  it("without harnesses/hermes.toml every quoted-hermes code line of the adapter fails A", () => {
    const dir = copy(BOX16);
    rmSync(join(dir, "harnesses", "hermes.toml"));
    const quoted = readFileSync(join(dir, "bridge", "engines", "hermes.ts"), "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !/^[ \t]*(\/\/|\*|\/\*)/.test(line) && /'hermes'|"hermes"|`hermes`/.test(line))
      .map(({ n }) => `A bridge/engines/hermes.ts:${n}`);
    expect(quoted.length).toBeGreaterThan(0);
    const r = lint(dir);
    expect(r.lines.filter((l) => /^A /.test(l))).toEqual(quoted);
    expect(r.lines.at(-1)).toBe(`lint-agents: FAIL (${quoted.length})`);
    expect(r.rc).toBe(1);
  });

  it("an adapter whose bridge/engines/<x>.ts is missing fails D at the adapter line", () => {
    const dir = copy(BOX16);
    writeFileSync(join(dir, "harnesses", "zz.toml"), 'name = "zz"\nhas_prompts = true\nadapter = "nosuch"\n');
    const r = lint(dir);
    expect(r.lines).toContain("D harnesses/zz.toml:3");
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  });
});

// U-R1B-LINT-EMPTY: every agent harness file (not shell.toml, not an `adapter` file) defines
// `empty_prompt` in its [states] table (rule E), and every pattern of it ends with `\z` (rule F).
const BOX17 = mkdtempSync("/tmp/r1blint-");
afterAll(() => rmSync(BOX17, { recursive: true, force: true }));

describe("lint-agents.sh empty_prompt (U-R1B-LINT-EMPTY)", () => {
  const AGENTS = ["antigravity", "claude", "cline", "codex", "copilot", "cursor-agent", "droid", "gemini", "goose", "grok", "opencode", "pi"];
  const fileLines = (file: string) => readFileSync(file, "utf8").split("\n");
  const lineOf = (file: string, re: RegExp) => fileLines(file).findIndex((l) => re.test(l)) + 1;
  const edit = (file: string, fn: (ls: string[]) => string[]) => writeFileSync(file, fn(fileLines(file)).join("\n"));
  const toml = (dir: string, name: string) => join(dir, "harnesses", `${name}.toml`);
  const head = (name: string) => `name = "${name}"\nprogram = "${name}"\nhas_prompts = true\n`;
  const zz = (dir: string, tail: string) => {
    writeFileSync(toml(dir, "zzagent"), `${head("zzagent")}[states]\nidle = ['^zz>']\n${tail}`);
    return toml(dir, "zzagent");
  };
  const failed = (r: { rc: number | null; lines: string[] }, n: number) => {
    expect(r.lines.at(-1)).toBe(`lint-agents: FAIL (${n})`);
    expect(r.rc).toBe(1);
  };

  it("(e1) goose without its empty_prompt line fails E at its [states] line", () => {
    const dir = copy(BOX17);
    const g = toml(dir, "goose");
    const states = lineOf(g, /^\[states\]/);
    edit(g, (ls) => ls.filter((l) => !/^empty_prompt/.test(l)));
    const r = lint(dir);
    expect(r.lines).toContain(`E harnesses/goose.toml:${states}`);
    failed(r, 1);
  });

  it("(e2) every agent file without its empty_prompt line fails E, one each, none for hermes or shell", () => {
    const dir = copy(BOX17);
    const want = AGENTS.map((a) => `E harnesses/${a}.toml:${lineOf(toml(dir, a), /^\[states\]/)}`);
    for (const a of AGENTS) edit(toml(dir, a), (ls) => ls.filter((l) => !/^empty_prompt/.test(l)));
    const r = lint(dir);
    expect(r.lines.filter((l) => /^E /.test(l))).toEqual(want);
    expect(r.lines.some((l) => /hermes\.toml|shell\.toml/.test(l))).toBe(false);
    failed(r, 12);
  });

  it("(e3) a new agent file with [states] and no empty_prompt fails E at the [states] line", () => {
    const dir = copy(BOX17);
    zz(dir, "");
    const r = lint(dir);
    expect(r.lines).toContain("E harnesses/zzagent.toml:4");
    failed(r, 1);
  });

  it("(e4) an agent file with no [states] table fails E at line 1", () => {
    const dir = copy(BOX17);
    writeFileSync(toml(dir, "zznostates"), head("zznostates"));
    const r = lint(dir);
    expect(r.lines).toContain("E harnesses/zznostates.toml:1");
    failed(r, 1);
  });

  it("(e5) a commented-out empty_prompt, or one under [keys], does not count", () => {
    const a = copy(BOX17);
    const ga = toml(a, "goose");
    const states = lineOf(ga, /^\[states\]/);
    edit(ga, (ls) => ls.map((l) => (/^empty_prompt/.test(l) ? `# ${l}` : l)));
    const ra = lint(a);
    expect(ra.lines).toContain(`E harnesses/goose.toml:${states}`);
    failed(ra, 1);

    const b = copy(BOX17);
    const gb = toml(b, "goose");
    const moved = fileLines(gb).find((l) => /^empty_prompt/.test(l)) as string;
    edit(gb, (ls) => ls.filter((l) => l !== moved).flatMap((l) => (/^\[keys\]/.test(l) ? [l, moved] : [l])));
    const rb = lint(b);
    expect(rb.lines).toContain(`E harnesses/goose.toml:${states}`);
    failed(rb, 1);
  });

  it("(f1) goose's pattern without its final \\z fails F at the empty_prompt line", () => {
    const dir = copy(BOX17);
    const g = toml(dir, "goose");
    const at = lineOf(g, /^empty_prompt/);
    edit(g, (ls) => ls.map((l) => (/^empty_prompt/.test(l) ? l.replace("\\z']", "']") : l)));
    const r = lint(dir);
    expect(r.lines).toContain(`F harnesses/goose.toml:${at}`);
    failed(r, 1);
  });

  it("(f2) droid's first pattern without its final \\z fails F, its second pattern is fine", () => {
    const dir = copy(BOX17);
    const d = toml(dir, "droid");
    const at = lineOf(d, /^empty_prompt/);
    edit(d, (ls) => ls.map((l) => (/^empty_prompt/.test(l) ? l.replace("\\z', '", "', '") : l)));
    const r = lint(dir);
    expect(r.lines).toContain(`F harnesses/droid.toml:${at}`);
    failed(r, 1);
  });

  it("(f3) a \\z inside the pattern, not at its end, fails F", () => {
    const dir = copy(BOX17);
    zz(dir, "empty_prompt = ['^zz\\z>']\n");
    const r = lint(dir);
    expect(r.lines).toContain("F harnesses/zzagent.toml:6");
    failed(r, 1);
  });

  it("(f4) a three-line array: a bad second pattern fails F at the key line; both good passes", () => {
    const bad = copy(BOX17);
    zz(bad, "empty_prompt = [\n  '^zz[>]\\z',\n  '^yy[>]',\n]\n");
    const r = lint(bad);
    expect(r.lines).toContain("F harnesses/zzagent.toml:6");
    failed(r, 1);

    const good = copy(BOX17);
    zz(good, "empty_prompt = [\n  '^zz[>]\\z',\n  '^yy[>]\\z',\n]\n");
    const p = lint(good);
    expect(p.lines.at(-1)).toBe("lint-agents: PASS");
    expect(p.rc).toBe(0);
  });

  it("(f5) a basic string must end with the TOML escape \\\\z", () => {
    const good = copy(BOX17);
    zz(good, 'empty_prompt = ["^zz>\\\\z"]\n');
    const p = lint(good);
    expect(p.lines.at(-1)).toBe("lint-agents: PASS");
    expect(p.rc).toBe(0);

    const bad = copy(BOX17);
    zz(bad, 'empty_prompt = ["^zz>"]\n');
    const r = lint(bad);
    expect(r.lines).toContain("F harnesses/zzagent.toml:6");
    failed(r, 1);
  });

  it("(g1) one E and one F in one copy count 2", () => {
    const dir = copy(BOX17);
    const g = toml(dir, "goose");
    const states = lineOf(g, /^\[states\]/);
    edit(g, (ls) => ls.filter((l) => !/^empty_prompt/.test(l)));
    const d = toml(dir, "droid");
    const at = lineOf(d, /^empty_prompt/);
    edit(d, (ls) => ls.map((l) => (/^empty_prompt/.test(l) ? l.replace("\\z', '", "', '") : l)));
    const r = lint(dir);
    expect(r.lines).toContain(`E harnesses/goose.toml:${states}`);
    expect(r.lines).toContain(`F harnesses/droid.toml:${at}`);
    failed(r, 2);
  });
});

// Audit of U-R1B-LINT-EMPTY: rule F reads the pattern's decoded text the way RE2 does: `\\z` is
// an escaped backslash and a `z`, not the end; an array with no pattern has none ending at `\z`.
describe("lint-agents.sh empty_prompt audit (U-R1B-LINT-EMPTY)", () => {
  const zz = (tail: string, crlf = false) => {
    const dir = copy(BOX17);
    const text = `name = "zzagent"\nprogram = "zzagent"\nhas_prompts = true\n[states]\nidle = ['^zz>']\n${tail}`;
    writeFileSync(join(dir, "harnesses", "zzagent.toml"), crlf ? text.replace(/\n/g, "\r\n") : text);
    return lint(dir);
  };
  const fails = (r: { rc: number | null; lines: string[] }) => {
    expect(r.lines).toContain("F harnesses/zzagent.toml:6");
    expect(r.lines.at(-1)).toBe("lint-agents: FAIL (1)");
    expect(r.rc).toBe(1);
  };
  const passes = (r: { rc: number | null; lines: string[] }) => {
    expect(r.lines.at(-1)).toBe("lint-agents: PASS");
    expect(r.rc).toBe(0);
  };

  it("(a1) a literal string ending in an escaped backslash and z fails F; an odd run of backslashes passes", () => {
    fails(zz(String.raw`empty_prompt = ['^zz\\z']` + "\n"));
    passes(zz(String.raw`empty_prompt = ['^zz\\\z']` + "\n"));
  });

  it("(a2) a basic string decoding to an escaped backslash and z fails F; one decoding to \\\\\\z passes", () => {
    fails(zz(String.raw`empty_prompt = ["^zz\\\\z"]` + "\n"));
    passes(zz(String.raw`empty_prompt = ["^zz\\\\\\z"]` + "\n"));
  });

  it("(a3) an empty array, a non-array value, or an unclosed array fails F", () => {
    fails(zz("empty_prompt = []\n"));
    fails(zz("empty_prompt = true\n"));
    fails(zz(String.raw`empty_prompt = ['^zz\z',` + "\n"));
  });

  it("(a4) a CRLF file is read like an LF file", () => {
    passes(zz(String.raw`empty_prompt = ['^zz\z']` + "\n", true));
    fails(zz(String.raw`empty_prompt = ['^zz']` + "\n", true));
  });
});
