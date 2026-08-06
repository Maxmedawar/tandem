import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The reader resolves its dir from env at CALL time, so each test can point
 * TANDEM_COMPLETIONS_DIR at a scratch dir. Nothing here touches the real
 * ~/.tandem/completions log.
 */
const { readCompletions } = await import("../bridge/completions.ts");

let dir: string;
const savedDir = process.env.TANDEM_COMPLETIONS_DIR;
const savedTail = process.env.TANDEM_COMPLETIONS_TAIL_BYTES;

/** Same shape the Stop hook writes. */
const rec = (session_id: string, finished_at: string, brand = "dev", cwd = "/Users/x/dev") =>
  JSON.stringify({ session_id, brand, cwd, finished_at });

function writeLog(lines: string[]): void {
  writeFileSync(join(dir, "log.jsonl"), lines.length ? lines.join("\n") + "\n" : "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tandem-completions-"));
  process.env.TANDEM_COMPLETIONS_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.TANDEM_COMPLETIONS_DIR;
  else process.env.TANDEM_COMPLETIONS_DIR = savedDir;
  if (savedTail === undefined) delete process.env.TANDEM_COMPLETIONS_TAIL_BYTES;
  else process.env.TANDEM_COMPLETIONS_TAIL_BYTES = savedTail;
});

describe("readCompletions — dedupe (the hook fires per TURN, not per session)", () => {
  it("collapses to the newest record per session_id by default", () => {
    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("A", "2026-07-26T11:00:00Z"),
      rec("B", "2026-07-26T10:30:00Z"),
      rec("A", "2026-07-26T12:00:00Z"),
      rec("B", "2026-07-26T12:30:00Z"),
    ]);
    const { completions } = readCompletions();
    expect(completions.map((c) => c.session_id)).toEqual(["B", "A"]);
    expect(completions.find((c) => c.session_id === "A")!.finished_at).toBe("2026-07-26T12:00:00Z");
    expect(completions).toHaveLength(2); // 5 turn records -> 2 sessions
  });

  it("returns every raw turn record when allTurns is set", () => {
    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("A", "2026-07-26T11:00:00Z"),
      rec("B", "2026-07-26T10:30:00Z"),
    ]);
    expect(readCompletions({ allTurns: true }).completions).toHaveLength(3);
  });

  it("mirrors the real log's ratio: many turns collapse to distinct sessions", () => {
    const lines: string[] = [];
    for (let s = 0; s < 10; s++) {
      for (let t = 0; t < 5; t++) {
        lines.push(rec(`s${s}`, `2026-07-26T${String(10 + t).padStart(2, "0")}:0${s}:00Z`));
      }
    }
    writeLog(lines);
    expect(readCompletions({ allTurns: true, limit: 500 }).completions).toHaveLength(50);
    expect(readCompletions({ limit: 500 }).completions).toHaveLength(10);
  });
});

describe("readCompletions — output shape and ordering", () => {
  it("always carries session_id AND cwd so results tie back to list_sessions", () => {
    writeLog([rec("A", "2026-07-26T10:00:00Z", "slack-bot", "/Users/x/dev/slack-bot")]);
    expect(readCompletions().completions[0]).toEqual({
      session_id: "A",
      brand: "slack-bot",
      cwd: "/Users/x/dev/slack-bot",
      finished_at: "2026-07-26T10:00:00Z",
    });
  });

  it("orders reverse-chronologically", () => {
    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("B", "2026-07-26T12:00:00Z"),
      rec("C", "2026-07-26T11:00:00Z"),
    ]);
    expect(readCompletions().completions.map((c) => c.session_id)).toEqual(["B", "C", "A"]);
  });

  it("defaults to 20 records and flags truncation", () => {
    writeLog(
      Array.from({ length: 30 }, (_, i) => rec(`s${i}`, `2026-07-26T${String(i % 24).padStart(2, "0")}:00:00Z`)),
    );
    const res = readCompletions();
    expect(res.completions).toHaveLength(20);
    expect(res.truncated).toBe(true);
  });

  it("honours an explicit limit and clamps it to a sane range", () => {
    writeLog(Array.from({ length: 5 }, (_, i) => rec(`s${i}`, `2026-07-26T1${i}:00:00Z`)));
    expect(readCompletions({ limit: 2 }).completions).toHaveLength(2);
    expect(readCompletions({ limit: 0 }).completions).toHaveLength(1); // clamped to >= 1
    expect(readCompletions({ limit: 99999 }).completions).toHaveLength(5); // clamped to <= 500
  });
});

describe("readCompletions — since cursor", () => {
  it("returns only strictly newer records and round-trips its own cursor", () => {
    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("B", "2026-07-26T11:00:00Z"),
      rec("C", "2026-07-26T12:00:00Z"),
    ]);
    const first = readCompletions();
    expect(first.cursor).toBe("2026-07-26T12:00:00Z");

    // Nothing new since the cursor -> empty, cursor unchanged (no repeats).
    const second = readCompletions({ since: first.cursor! });
    expect(second.completions).toEqual([]);
    expect(second.cursor).toBe(first.cursor);

    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("B", "2026-07-26T11:00:00Z"),
      rec("C", "2026-07-26T12:00:00Z"),
      rec("D", "2026-07-26T13:00:00Z"),
    ]);
    const third = readCompletions({ since: first.cursor! });
    expect(third.completions.map((c) => c.session_id)).toEqual(["D"]);
  });

  it("advances the cursor even when a filter matches nothing", () => {
    writeLog([rec("A", "2026-07-26T10:00:00Z")]);
    const res = readCompletions({ session: "no-such-brand" });
    expect(res.completions).toEqual([]);
    expect(res.cursor).toBe("2026-07-26T10:00:00Z");
  });
});

describe("readCompletions — session filter", () => {
  beforeEach(() => {
    writeLog([
      rec("aaa-111", "2026-07-26T10:00:00Z", "dev", "/Users/x/dev"),
      rec("bbb-222", "2026-07-26T11:00:00Z", "slack-bot", "/Users/x/dev/slack-bot"),
    ]);
  });

  it("matches an exact session_id", () => {
    expect(readCompletions({ session: "aaa-111" }).completions.map((c) => c.session_id)).toEqual(["aaa-111"]);
  });

  it("matches a brand or cwd substring", () => {
    expect(readCompletions({ session: "slack" }).completions.map((c) => c.session_id)).toEqual(["bbb-222"]);
    expect(readCompletions({ session: "/dev/slack-bot" }).completions.map((c) => c.session_id)).toEqual(["bbb-222"]);
  });
});

describe("readCompletions — robustness, size guard, rotation", () => {
  it("returns empty (not an error) when the log is missing or empty", () => {
    expect(readCompletions()).toEqual({ completions: [], cursor: null, truncated: false });
    writeLog([]);
    expect(readCompletions()).toEqual({ completions: [], cursor: null, truncated: false });
  });

  it("skips blank, malformed and incomplete lines", () => {
    writeFileSync(
      join(dir, "log.jsonl"),
      [
        rec("A", "2026-07-26T10:00:00Z"),
        "",
        "{not json at all",
        JSON.stringify({ session_id: "X" }), // no finished_at
        JSON.stringify({ finished_at: "2026-07-26T11:00:00Z" }), // no session_id
        "   ",
        rec("B", "2026-07-26T12:00:00Z"),
      ].join("\n") + "\n",
    );
    expect(readCompletions().completions.map((c) => c.session_id)).toEqual(["B", "A"]);
  });

  it("reads only the tail window and discards the partial first line", () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      rec(`s${String(i).padStart(3, "0")}`, `2026-07-26T10:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    writeFileSync(join(dir, "log.jsonl"), lines.join("\n") + "\n");
    // A window far smaller than the file forces a clip mid-record.
    process.env.TANDEM_COMPLETIONS_TAIL_BYTES = "400";
    const res = readCompletions({ limit: 500 });
    expect(res.truncated).toBe(true); // older records exist above the window
    expect(res.completions.length).toBeGreaterThan(0);
    expect(res.completions.length).toBeLessThan(200); // did NOT read the whole file
    // Every returned record parsed cleanly — no fragment leaked through.
    for (const c of res.completions) {
      expect(c.session_id).toMatch(/^s\d{3}$/);
      expect(c.finished_at).toMatch(/^2026-07-26T10:00:\d{2}Z$/);
    }
  });

  it("survives a log larger than the window without reading it all", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => rec(`s${i}`, "2026-07-26T10:00:00Z"));
    writeFileSync(join(dir, "log.jsonl"), lines.join("\n") + "\n");
    process.env.TANDEM_COMPLETIONS_TAIL_BYTES = String(16 * 1024);
    const res = readCompletions({ allTurns: true, limit: 500 });
    expect(res.truncated).toBe(true);
    expect(res.completions.length).toBeLessThanOrEqual(500);
  });
});

describe("GET /completions route", () => {
  it("is reachable through the router and parses its query params", async () => {
    writeLog([
      rec("A", "2026-07-26T10:00:00Z"),
      rec("A", "2026-07-26T11:00:00Z"),
      rec("B", "2026-07-26T12:00:00Z"),
    ]);
    const { routeForTest } = await import("../bridge/router.ts");

    const collapsed = await routeForTest("GET", "/completions", {}, "");
    expect(collapsed.status).toBe(200);
    expect((collapsed.body as { completions: unknown[] }).completions).toHaveLength(2);

    const raw = await routeForTest("GET", "/completions", {}, "all_turns=true");
    expect((raw.body as { completions: unknown[] }).completions).toHaveLength(3);

    const since = await routeForTest("GET", "/completions", {}, "since=2026-07-26T11:00:00Z");
    expect((since.body as { completions: { session_id: string }[] }).completions.map((c) => c.session_id)).toEqual(["B"]);

    const limited = await routeForTest("GET", "/completions", {}, "limit=1");
    expect((limited.body as { completions: unknown[] }).completions).toHaveLength(1);
  });
});
