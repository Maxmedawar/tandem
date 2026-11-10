import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-tree.sh", import.meta.url));
const REAL_ICONS = join(homedir(), "design-assets/icons/uxercon-free/SVG");

// Made-up private words. Line numbers in the list: word #3 and word #4.
const WORD_A = "zorblaxium";
const WORD_B = "quindlefrop";
const WORDS = [WORD_A, WORD_B];
// Made-up icon path data (40+ characters, starts with M).
const ICON_D = "M3.5 7.25L9.125 13.5L14.75 7.25M3.5 16.75H14.75V18.5Z";
// Seeded secret built at run time so no literal one sits in this file.
const sample = ["gh", "p_", "q8Zk3Lm2Np7Rs4Tv6", "Wx9Yb1Cd5Fg0Hj8Kp3M"].join("");

const temps: string[] = [];
let fixtures = "";
let wordsFile = "";
let iconsDir = "";

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function git(cwd: string, args: string[], who = { name: "Test", email: "test@example.com" }) {
  const r = spawnSync(
    "git",
    ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

type Commit = { files?: Record<string, string>; remove?: string[]; message?: string; who?: { name: string; email: string } };

function repo(commits: Commit[]): string {
  const dir = tmp("check-tree-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  for (const c of commits) {
    for (const [p, body] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    for (const p of c.remove ?? []) git(dir, ["rm", "-q", p]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", c.message ?? "update"], c.who);
  }
  return dir;
}

function run(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync("sh", [SCRIPT, ...args], { cwd, encoding: "utf8", env });
  const lines = `${r.stdout}${r.stderr}`.split("\n").filter((l) => l !== "");
  // The report goes into a public pack: no line may ever carry a list word.
  for (const l of lines) for (const w of WORDS) expect(l.toLowerCase()).not.toContain(w);
  return { status: r.status, lines, last: lines.at(-1) ?? "" };
}

function check(cwd: string, extra: string[] = []) {
  return run(cwd, ["--words", wordsFile, "--icons", iconsDir, ...extra]);
}

const clean = { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" };

beforeAll(() => {
  fixtures = tmp("check-tree-fixtures-");
  wordsFile = join(fixtures, "words.txt");
  writeFileSync(wordsFile, `# made-up test words\n\n${WORD_A}\n${WORD_B}\n`);
  iconsDir = join(fixtures, "icons");
  mkdirSync(join(iconsDir, "Line"), { recursive: true });
  writeFileSync(
    join(iconsDir, "Line", "made-up.svg"),
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="${ICON_D}" stroke="black" stroke-width="2"/>\n</svg>\n`,
  );
});

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("scripts/check-tree.sh", { timeout: 60_000 }, () => {
  it("passes a clean repo", () => {
    const r = check(repo([{ files: clean }]));
    expect(r.status).toBe(0);
    expect(r.last).toBe("check-tree: PASS");
  });

  it("fails on a secret in a file at HEAD", () => {
    const r = check(repo([{ files: { ...clean, "config.txt": `value = "${sample}"\n` } }]));
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith("SECRET config.txt "))).toBe(true);
    expect(r.lines.join("\n")).not.toContain(sample);
    expect(r.last).toMatch(/^check-tree: FAIL \(\d+ findings\)$/);
  });

  it("fails on a secret only in an earlier commit of the range", () => {
    const dir = repo([{ files: { ...clean, "old.txt": `value = "${sample}"\n` } }, { remove: ["old.txt"] }]);
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => /^SECRET [0-9a-f]{7} /.test(l))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("SECRET old.txt"))).toBe(false);
  });

  it("fails on a secret in a commit message", () => {
    const r = check(repo([{ files: clean, message: `add config ${sample}` }]));
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => /^COMMIT [0-9a-f]{7} message .*secret/.test(l))).toBe(true);
    expect(r.lines.join("\n")).not.toContain(sample);
  });

  it("fails on a private word in file content", () => {
    const r = check(repo([{ files: { ...clean, "notes.md": `talk to ${WORD_A.toUpperCase()} later\n` } }]));
    expect(r.status).toBe(1);
    expect(r.lines).toContain("WORD notes.md word #3");
  });

  it("fails on a private word in a file path, printed as a blob sha", () => {
    const dir = repo([{ files: { ...clean, [`docs/${WORD_B}-plan.md`]: "plain\n" } }]);
    const r = check(dir);
    expect(r.status).toBe(1);
    const blob = git(dir, ["ls-tree", "HEAD", "--", `docs/${WORD_B}-plan.md`]).split(/\s+/)[2].slice(0, 7);
    expect(r.lines).toContain(`WORD blob:${blob} word #4 in path`);
  });

  it("fails on a private word in a commit message", () => {
    const r = check(repo([{ files: clean, message: `sync with ${WORD_B}` }]));
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => /^COMMIT [0-9a-f]{7} message has word #4$/.test(l))).toBe(true);
  });

  it.each([
    ["author name", { name: `Pat ${WORD_A}`, email: "pat@example.com" }],
    ["author email", { name: "Pat", email: `pat@${WORD_B}.example` }],
  ])("fails on a private word in the %s", (_label, who) => {
    const r = check(repo([{ files: clean, who }]));
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => /^COMMIT [0-9a-f]{7} author has word #[34]$/.test(l))).toBe(true);
  });

  it.each(["private/notes.txt", "ee/feature.ts", ".env", "app/.env.local", ".dev.vars", "certs/server.pem", "keys/id.p12", "id.key", "design/home.fig", "assets/UxerCon/arrow.txt"])(
    "fails on the forbidden path %s",
    (p) => {
      const r = check(repo([{ files: { ...clean, [p]: "x\n" } }]));
      expect(r.status).toBe(1);
      expect(r.lines).toContain(`PATH ${p} forbidden path`);
    },
  );

  it("allows .env.example", () => {
    const r = check(repo([{ files: { ...clean, ".env.example": "PORT=3000\n" } }]));
    expect(r.status).toBe(0);
    expect(r.last).toBe("check-tree: PASS");
  });

  it("fails on library icon path data inside a renamed .svg with stroke changed", () => {
    const svg = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${ICON_D}" stroke="currentColor"/></svg>\n`;
    const r = check(repo([{ files: { ...clean, "public/icons/down.svg": svg } }]));
    expect(r.status).toBe(1);
    expect(r.lines).toContain("ICON public/icons/down.svg library icon path data");
  });

  it("fails on library icon path data inside a string in a .tsx file", () => {
    const tsx = `export const Down = () => (\n  <svg viewBox="0 0 24 24"><path d='${ICON_D}' stroke="currentColor" /></svg>\n);\n`;
    const r = check(repo([{ files: { ...clean, "src/Down.tsx": tsx } }]));
    expect(r.status).toBe(1);
    expect(r.lines).toContain("ICON src/Down.tsx library icon path data");
  });

  it("exits 2 when the word list is missing", () => {
    const r = run(repo([{ files: clean }]), ["--words", join(fixtures, "absent.txt"), "--icons", iconsDir]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("exits 2 when the icon folder is missing", () => {
    const r = run(repo([{ files: clean }]), ["--words", wordsFile, "--icons", join(fixtures, "absent-icons")]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("exits 2 when gitleaks is missing", () => {
    const r = run(repo([{ files: clean }]), ["--words", wordsFile, "--icons", iconsDir], { ...process.env, PATH: "/usr/bin:/bin" });
    expect(r.status).toBe(2);
    expect(r.last).toMatch(/^check-tree: ERROR .*gitleaks/);
  });

  it("exits 2 outside a git repo", () => {
    const r = check(tmp("check-tree-norepo-"));
    expect(r.status).toBe(2);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("exits 2 on a range git cannot read", () => {
    const r = check(repo([{ files: clean }]), ["--range", "no-such-rev..HEAD"]);
    expect(r.status).toBe(2);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("never prints a private word, whatever holds it", () => {
    const dir = repo([
      {
        files: { ...clean, [`${WORD_A}/x.md`]: `${WORD_B}\n`, [`private/${WORD_B}.svg`]: `<path d="${ICON_D}"/>\n` },
        message: `${WORD_A} and ${WORD_B}`,
        who: { name: WORD_B, email: `${WORD_A}@example.com` },
      },
    ]);
    const r = check(dir); // run() asserts no line holds a word
    expect(r.status).toBe(1);
    expect(r.lines.filter((l) => l.includes("blob:")).length).toBeGreaterThanOrEqual(3);
  });

  // Audit R1: ways to hide content from the checks.
  it("ignores inline gitleaks:allow comments", () => {
    const r = check(repo([{ files: { ...clean, "config.txt": `value = "${sample}" # gitleaks:allow\n` } }]));
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith("SECRET config.txt "))).toBe(true);
  });

  it("ignores a committed .gitleaksignore", () => {
    const dir = repo([{ files: { ...clean, "config.txt": `value = "${sample}"\n` } }]);
    const c = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, ".gitleaksignore"), `config.txt:github-pat:1\n${c}:config.txt:github-pat:1\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "ignore"]);
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith("SECRET config.txt "))).toBe(true);
    expect(r.lines).toContain(`SECRET ${c.slice(0, 7)} github-pat in config.txt line 1`);
  });

  it("scans a HEAD file that .gitattributes export-ignore hides from git archive", () => {
    const dir = repo([{ files: { ...clean, "config.txt": `value = "${sample}"\n` } }, { files: { ".gitattributes": "config.txt export-ignore\n" } }]);
    const r = check(dir, ["--range", "HEAD~1..HEAD"]);
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith("SECRET config.txt "))).toBe(true);
  });

  it("scans a secret under node_modules/ and inside a zip", () => {
    const side = tmp("check-tree-zip-");
    writeFileSync(join(side, "inner.txt"), `value = "${sample}"\n`);
    const dir = repo([{ files: { ...clean, "node_modules/x/index.js": `const v = "${sample}";\n` } }]);
    expect(spawnSync("zip", ["-q", "-j", join(dir, "bundle.zip"), join(side, "inner.txt")]).status).toBe(0);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add"]);
    const r = check(dir, ["--range", "HEAD"]);
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith("SECRET node_modules/x/index.js "))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("SECRET bundle.zip"))).toBe(true);
  });

  it("checks a symlink as its target text and never follows it", () => {
    const outside = join(tmp("check-tree-outside-"), "x.txt");
    writeFileSync(outside, `value = "${sample}"\n`);
    const dir = repo([{ files: clean }]);
    symlinkSync(outside, join(dir, "out"));
    symlinkSync(`../${WORD_A}/notes.md`, join(dir, "link"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "links"]);
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.lines.slice(0, -1)).toEqual(["WORD link word #3"]);
  });

  it("trims blanks around a word in the list", () => {
    const padded = join(tmp("check-tree-words-"), "padded.txt");
    writeFileSync(padded, `# padded\n  ${WORD_A}  \n`);
    const r = run(repo([{ files: { ...clean, "notes.md": `${WORD_A}.\n` } }]), ["--words", padded, "--icons", iconsDir]);
    expect(r.status).toBe(1);
    expect(r.lines).toContain("WORD notes.md word #2");
  });

  it("exits 2 when a PATH matches nothing at HEAD", () => {
    const r = check(repo([{ files: clean }]), ["src", "no-such-dir"]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("exits 2 when the word list holds no words", () => {
    const empty = join(tmp("check-tree-words-"), "empty.txt");
    writeFileSync(empty, "# only comments\n\n   \n");
    const r = run(repo([{ files: clean }]), ["--words", empty, "--icons", iconsDir]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it("exits 2 when the icon folder holds no path data", () => {
    const r = run(repo([{ files: clean }]), ["--words", wordsFile, "--icons", tmp("check-tree-icons-")]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toMatch(/^check-tree: ERROR /);
  });

  it.each([
    ["a leading and trailing blank", ` ${ICON_D} `],
    ["doubled spaces", ICON_D.replaceAll(" ", "  ")],
    ["commas", ICON_D.replaceAll(" ", ",")],
    ["tabs", ICON_D.replaceAll(" ", "\t")],
    ["line breaks", ICON_D.replaceAll("L", "\nL")],
  ])("fails on library icon path data reformatted with %s", (_label, d) => {
    const r = check(repo([{ files: { ...clean, "public/x.svg": `<svg><path\n  fill="none"\n  d="${d}"/></svg>\n` } }]));
    expect(r.status).toBe(1);
    expect(r.lines).toContain("ICON public/x.svg library icon path data");
  });

  it.each([
    ["marked binary in .gitattributes", { ".gitattributes": "*.svg binary\n", "x.svg": `<path d="${ICON_D}"/>\n` }, "x.svg"],
    ["in a file with a NUL byte", { "x.svg": `<path d="${ICON_D}"/>\n\0` }, "x.svg"],
    ["in a template literal", { "src/I.tsx": `export const I = () => <path d={\`${ICON_D}\`} />;\n` }, "src/I.tsx"],
    ["in an escaped JSON string", { "icons.json": `{"down": "<path d=\\"${ICON_D}\\"/>"}\n` }, "icons.json"],
  ])("fails on library icon path data %s", (_label, files, p) => {
    const r = check(repo([{ files: { ...clean, ...files } }]));
    expect(r.status).toBe(1);
    expect(r.lines).toContain(`ICON ${p} library icon path data`);
  });

  it.skipIf(!existsSync(REAL_ICONS))("fails on a real library SVG, renamed and committed", () => {
    const pick = (d: string): string => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          const f = pick(p);
          if (f) return f;
        } else if (e.name.endsWith(".svg") && /\sd="[^"]{40,}"/.test(readFileSync(p, "utf8"))) return p;
      }
      return "";
    };
    const dir = repo([{ files: clean }]);
    mkdirSync(join(dir, "assets"));
    const src = pick(REAL_ICONS);
    copyFileSync(src, join(dir, "assets", "glyph.svg"));
    // Reformatted copy: every blank becomes a line break plus indent, stroke recoloured.
    const reformatted = readFileSync(src, "utf8").replace(/stroke="[^"]*"/g, 'stroke="currentColor"').replaceAll(" ", "\n  ");
    writeFileSync(join(dir, "assets", "glyph-2.svg"), reformatted);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add glyph"]);
    const r = run(dir, ["--words", wordsFile]);
    expect(r.status).toBe(1);
    expect(r.lines).toContain("ICON assets/glyph.svg library icon path data");
    expect(r.lines).toContain("ICON assets/glyph-2.svg library icon path data");
  });
});
