/**
 * U-R1A-37: the Codex transcript reader (bridge/transcripts/readers/codex.ts).
 *
 * Ported from Synergy test/codex-history.test.ts (4b3f46f25d34):
 *  - "parses a rollout into a codex SessionInfo with cwd + last message": rewritten. readMessages on
 *    the same fixture gives the id, the cwd and every real message; the last is the reply.
 *  - "falls back to an index-only entry (cwd unknown, title from session_index)": retired. Index-only
 *    rows belong to a history listing, and core has none.
 *  - "every entry is engine:codex, live:false, lastMessage <= 200 chars": retired. Listing row shape.
 *  - "returns [] for a missing codex dir (never throws)": rewritten. locate on a missing root gives
 *    undefined and never throws.
 *  - "detectEngine maps the codex command" and "detectEngineLive tags a codex command": retired. Core
 *    has no engines.ts; the engine comes from the session.
 *  - "listSessions engine:codex filter": retired. Core has no history listing.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const reader = await import("../../bridge/transcripts/readers/codex.ts");

const FIXTURE = fileURLToPath(new URL("../fixtures/codex/", import.meta.url));
const ROLLOUT = join(FIXTURE, "sessions/2026/03/20/rollout-2026-03-20T11-39-29-019d0c8b-9bd8-78e3-a070-60e8d761b632.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);

const ROOT = mkdtempSync(join(tmpdir(), "r1a37-codex-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const meta = (cwd: string, id: string) =>
  JSON.stringify({ timestamp: "2026-11-10T00:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-11-10T00:00:00.000Z", cwd } });

describe("codex reader: readMessages", () => {
  it("names its agent", () => {
    expect(reader.agent).toBe("codex");
  });

  it("reads the fixture rollout: id, cwd, the real messages, no preamble", async () => {
    const out = await reader.readMessages(ROLLOUT);
    expect(out.id).toBe("019d0c8b-9bd8-78e3-a070-60e8d761b632");
    expect(out.cwd).toBe("/Users/fixture/Desktop/sample-project");
    expect(out.messages).toEqual([
      { role: "user", text: "Make the orbs glow brighter and pulse" },
      { role: "assistant", text: "Done — increased glow radius and added a pulse animation in orb-system.ts" },
    ]);
    expect(out.messages.at(-1)?.text).toBe("Done — increased glow radius and added a pulse animation in orb-system.ts");
    for (const m of out.messages) expect(m.text).not.toMatch(/^<(environment_context|permissions)/);
  });

  it("a missing file gives no messages and never throws", async () => {
    const out = await reader.readMessages(join(ROOT, "missing.jsonl"));
    expect(out.messages).toEqual([]);
  });
});

describe("codex reader: locate", () => {
  it("finds the fixture rollout by its session_meta cwd, never session_index.jsonl", async () => {
    expect(await reader.locate(FIXTURE, "/Users/fixture/Desktop/sample-project", 0, new Set())).toBe(ROLLOUT);
  });

  it("on a temp tree finds the rollout by cwd and time; a wrong cwd or a missing root gives undefined", async () => {
    const work = join(ROOT, "work");
    mkdirSync(work);
    const real = realpathSync(work);
    const day = join(ROOT, "sessions", "2026", "11", "10");
    mkdirSync(day, { recursive: true });
    const old = join(day, "rollout-2026-11-10T00-00-00-00000000-0000-0000-0000-000000000001.jsonl");
    const other = join(day, "rollout-2026-11-10T00-00-01-00000000-0000-0000-0000-000000000002.jsonl");
    const mine = join(day, "rollout-2026-11-10T00-00-02-00000000-0000-0000-0000-000000000003.jsonl");
    const notRollout = join(day, "history-00000000-0000-0000-0000-000000000004.jsonl");
    writeFileSync(old, meta(real, "00000000-0000-0000-0000-000000000001") + "\n");
    await sleep(40);
    writeFileSync(other, meta(join(ROOT, "elsewhere"), "00000000-0000-0000-0000-000000000002") + "\n");
    writeFileSync(notRollout, meta(real, "00000000-0000-0000-0000-000000000004") + "\n");
    // codex writes the real cwd; the session may have been given a symlinked spelling of it.
    writeFileSync(mine, meta(real, "00000000-0000-0000-0000-000000000003") + "\n" + "x".repeat(200_000) + "\n");
    const since = created(statSync(other)) + 2000;
    expect(created(statSync(old))).toBeLessThan(since - 2000);

    const sessions = join(ROOT, "sessions");
    expect(await reader.locate(sessions, work, since, new Set())).toBe(mine);
    expect(await reader.locate(sessions, real, since, new Set())).toBe(mine);
    expect(await reader.locate(sessions, work, since, new Set([mine]))).toBeUndefined();
    expect(await reader.locate(sessions, join(ROOT, "wrong"), since, new Set())).toBeUndefined();
    expect(await reader.locate(join(ROOT, "missing"), work, 0, new Set())).toBeUndefined();
  });
});
