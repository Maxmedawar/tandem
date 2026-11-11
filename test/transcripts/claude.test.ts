/**
 * U-R1A-37: the Claude Code transcript reader (bridge/transcripts/readers/claude.ts).
 *
 * Ported from Synergy test/sessions-claude-history.test.ts (4b3f46f25d34):
 *  - "reads claude history from the injected root instead of the real home directory": rewritten.
 *    `locate` reads only the slug folders of one session's cwd under the root it is given, never
 *    the root itself, another project folder or the real ~/.claude (readdir wrapped the same way).
 *  - "decodes cwd from the directory name relative to the injected root": retired. decodeProjectDir
 *    is not ported: the cwd comes from the session; the slug rule (cwd to folder) is tested instead.
 *  - "never walks claude history for engine:codex" and the grok/gemini/shell/hermes loop: rewritten
 *    in index.test.ts (shell and an agent with no history get no row, so nothing is read).
 *  - "still walks claude history when the filter is absent": retired. Core has no history listing.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ readdirPaths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
      spy.readdirPaths.push(String(path));
      return (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const reader = await import("../../bridge/transcripts/readers/claude.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
const created = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
const REAL_CLAUDE = join(userInfo().homedir, ".claude");

const ROOT = mkdtempSync(join(tmpdir(), "r1a37-claude-"));
const PROJECTS = join(ROOT, "projects");
const WORK = join(ROOT, "work");
mkdirSync(WORK);
const SLUG_DIRS = [...new Set([join(PROJECTS, slug(realpathSync(WORK))), join(PROJECTS, slug(WORK))])];
const OTHER = join(PROJECTS, "-some-other-project");
for (const d of [...SLUG_DIRS, OTHER]) mkdirSync(d, { recursive: true });

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  spy.readdirPaths.length = 0;
});

describe("claude reader: locate", () => {
  it("names its agent", () => {
    expect(reader.agent).toBe("claude");
  });

  it("reads only the slug folders, never the root, another project folder or the real ~/.claude; earliest file at or after the start wins; a taken file is skipped; a start 10 s ahead finds nothing", async () => {
    const dir = SLUG_DIRS[0]!;
    const before = join(dir, "before.jsonl");
    const first = join(dir, "first.jsonl");
    const second = join(SLUG_DIRS[SLUG_DIRS.length - 1]!, "second.jsonl");
    writeFileSync(before, "{}\n");
    await sleep(40);
    writeFileSync(first, "{}\n");
    await sleep(40);
    writeFileSync(second, "{}\n");
    writeFileSync(join(dir, "not-a-transcript.txt"), "{}\n");
    // Another project folder holds a newer file; it must never be read or chosen.
    writeFileSync(join(OTHER, "other.jsonl"), "{}\n");
    // `first` is created exactly 2000 ms before this start (inside the window), `before` earlier.
    const since = created(statSync(first)) + 2000;
    expect(created(statSync(before))).toBeLessThan(since - 2000);

    expect(await reader.locate(PROJECTS, WORK, since, new Set())).toBe(first);
    expect(await reader.locate(PROJECTS, WORK, since, new Set([first]))).toBe(second);
    expect(await reader.locate(PROJECTS, WORK, since, new Set([first, second]))).toBeUndefined();
    expect(await reader.locate(PROJECTS, WORK, Date.now() + 10_000, new Set())).toBeUndefined();

    expect(spy.readdirPaths.length).toBeGreaterThan(0);
    for (const p of spy.readdirPaths) expect(SLUG_DIRS).toContain(p);
    expect(spy.readdirPaths).not.toContain(PROJECTS);
    expect(spy.readdirPaths).not.toContain(OTHER);
    expect(spy.readdirPaths.some((p) => p.startsWith(REAL_CLAUDE))).toBe(false);
  });

  it("uses the cwd alone when its realpath fails (the folder is gone), never throws; the slug replaces every character outside A-Z a-z 0-9", async () => {
    for (const [cwd, folder] of [
      ["/private/tmp/r1a11-live-x/work", "-private-tmp-r1a11-live-x-work"],
      ["/Users/m/.config", "-Users-m--config"],
    ] as const) {
      mkdirSync(join(PROJECTS, folder), { recursive: true });
      const file = join(PROJECTS, folder, "gone.jsonl");
      writeFileSync(file, "{}\n");
      spy.readdirPaths.length = 0;
      expect(await reader.locate(PROJECTS, cwd, 0, new Set())).toBe(file);
      expect(spy.readdirPaths).toEqual([join(PROJECTS, folder)]);
    }
  });

  it("a missing root gives undefined", async () => {
    expect(await reader.locate(join(ROOT, "missing"), WORK, 0, new Set())).toBeUndefined();
  });
});

describe("claude reader: readMessages", () => {
  it("gives the cwd, the id and the user and assistant texts in order, a bad line skipped", async () => {
    const file = join(ROOT, "3f2b-session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "summary", summary: "not a message" }),
        JSON.stringify({ type: "user", cwd: "/work/first", message: { role: "user", content: "hello there" } }),
        "{ this line is not JSON",
        JSON.stringify({
          type: "assistant",
          cwd: "/work/second",
          message: {
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "first reply" },
              { type: "tool_use", id: "t1", name: "Bash", input: {} },
            ],
          },
        }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "tool output" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }, { type: "text", text: "part" }] } }),
        "",
      ].join("\n"),
    );
    expect(await reader.readMessages(file)).toEqual({
      id: "3f2b-session",
      cwd: "/work/first",
      messages: [
        { role: "user", text: "hello there" },
        { role: "assistant", text: "first reply" },
        { role: "assistant", text: "second part" },
      ],
    });
  });

  it("a missing file gives no messages and never throws", async () => {
    const out = await reader.readMessages(join(ROOT, "missing.jsonl"));
    expect(out.messages).toEqual([]);
  });
});
