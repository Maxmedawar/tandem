import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    copyFileSync(pick(REAL_ICONS), join(dir, "assets", "glyph.svg"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add glyph"]);
    const r = run(dir, ["--words", wordsFile]);
    expect(r.status).toBe(1);
    expect(r.lines).toContain("ICON assets/glyph.svg library icon path data");
  });
});
