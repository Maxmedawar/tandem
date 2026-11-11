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
