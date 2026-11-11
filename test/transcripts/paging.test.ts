/**
 * U-R1A-37: session and relay reads come in pages that always fit through the hub (the U-R1A-07
 * audit owner: a read over ~190 KiB used to answer 413 payload_too_large instead of paging).
 *
 * The live case opens a made-up CLI (test/fixtures/fake-cli.sh) as an owner harness, enabled and
 * allowlisted as test/engines/harness-engine.test.ts does, on a private tmux socket: TMUX_TMPDIR is
 * a new /tmp/r1a37- folder and TMUX is unset before any tmux call; afterAll kills that socket's
 * server and removes the folder.
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("../fixtures/fake-cli.sh", import.meta.url));
const BOX = mkdtempSync("/tmp/r1a37-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, "tandem", "tmux", "tandem"); // U-R1A-19: Tandem's own socket under TANDEM_HOME
// Registered before any bridge import, so a failed import still removes the folder.
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a37 paging cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});
const WORK = join(BOX, "work");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");
mkdirSync(WORK);
mkdirSync(OWNER, { recursive: true });
chmodSync(OWNER, 0o700);
// Read when the router is imported or the harness files first load.
process.env.TANDEM_HOME = TANDEM_HOME;
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_WAIT_MS = "8000";
writeFileSync(
  join(OWNER, "fake-pg.toml"),
  `name = "fake-pg"\nprogram = "${FAKE}"\nhas_prompts = true\n[states]\nworking = ['^fake is thinking\\z']\nidle = ['^fake>\\z']\ndebounce_ms = 300\n`,
  { mode: 0o600 },
);

// A failed import ends this file before any hook runs, so the folder goes here, then the failure.
const [{ readLogPage }, { routeForTest }, { handleHubRequest }, { CCM_FRAME_TYPES }, { applyLimits }, { loadedHarnesses }, { agentEntry, writeLimits }] = await Promise.all([
  import("../../bridge/terminal-session.ts"),
  import("../../bridge/router.ts"),
  import("../../bridge/hub-rpc.ts"),
  import("../../hub/src/protocol.ts"),
  import("../../bridge/limits.ts"),
  import("../../bridge/engine-registry.ts"),
  import("../fixtures/limits.ts"),
]).catch((e: unknown) => {
  rmSync(BOX, { recursive: true, force: true });
  throw e;
});

const PAGE = 65_536;
const JSON_CAP = 98_304;

/** Every page of `file` from offset 0, checking that `next` always grows. */
function pages(file: string): { text: string; next: number; more: boolean }[] {
  const out: { text: string; next: number; more: boolean }[] = [];
  let from = 0;
  for (;;) {
    const page = readLogPage(file, from);
    out.push(page);
    if (!page.more) return out;
    expect(page.next).toBeGreaterThan(from);
    from = page.next;
  }
}

describe("readLogPage", () => {
  it("300 KiB of text lines: pages of at most 65,536 bytes, each ending at a line end, that join back to the file; the last has more false", () => {
    const file = join(BOX, "lines.log");
    let body = "";
    for (let i = 0; Buffer.byteLength(body) < 300 * 1024; i++) body += `line ${String(i).padStart(6, "0")} ${"x".repeat(i % 97)}\n`;
    writeFileSync(file, body);
    const all = pages(file);
    expect(all.length).toBeGreaterThan(4);
    for (const p of all) expect(Buffer.byteLength(p.text)).toBeLessThanOrEqual(PAGE);
    for (const p of all.slice(0, -1)) {
      expect(p.more).toBe(true);
      expect(p.text.endsWith("\n")).toBe(true);
    }
    expect(all.at(-1)!.more).toBe(false);
    expect(all.at(-1)!.next).toBe(statSync(file).size);
    expect(all.map((p) => p.text).join("")).toBe(body);
  });

  it("300 KiB of \\x01 bytes: every page's JSON is at most 98,304 bytes and next always grows (raw 0x80 bytes too)", () => {
    const file = join(BOX, "ctrl.log");
    writeFileSync(file, Buffer.alloc(300 * 1024, 1));
    const all = pages(file);
    for (const p of all) expect(Buffer.byteLength(JSON.stringify(p.text))).toBeLessThanOrEqual(JSON_CAP);
    expect(all.map((p) => p.text).join("")).toBe("\x01".repeat(300 * 1024));
    // Not UTF-8 at all (binary pane output): still pages that fit, and the reads end.
    writeFileSync(file, Buffer.alloc(300 * 1024, 0x80));
    const raw = pages(file);
    for (const p of raw) expect(Buffer.byteLength(JSON.stringify(p.text))).toBeLessThanOrEqual(JSON_CAP);
    expect(raw.at(-1)!.next).toBe(300 * 1024);
  });

  it("no newline: a page ends at a UTF-8 boundary", () => {
    const file = join(BOX, "utf8.log");
    const body = "€".repeat(100_000);
    writeFileSync(file, body);
    const all = pages(file);
    for (const p of all) expect(p.text).not.toContain("�");
    expect(all.map((p) => p.text).join("")).toBe(body);
  });

  it("from at or past the end, or a missing file", () => {
    const file = join(BOX, "short.log");
    writeFileSync(file, "abc\n");
    expect(readLogPage(file, 4)).toEqual({ text: "", next: 4, more: false });
    expect(readLogPage(file, 99)).toEqual({ text: "", next: 4, more: false });
    expect(readLogPage(join(BOX, "missing.log"), 0)).toEqual({ text: "", next: 0, more: false });
  });
});

describe("a session read through the hub", () => {
  it("a 300 KiB pane log read through handleHubRequest answers 200 within the frame cap with more: true and idle: false", async () => {
    process.env.TANDEM_ENABLED_ENGINES = "fake-pg";
    // U-R1A-17: the limits file allows only fake-pg in WORK.
    writeLimits(TANDEM_HOME, { folders: [WORK], agents: { "fake-pg": agentEntry(loadedHarnesses().get("fake-pg")!) } });
    applyLimits();
    const name = `r1a37-pg-${randomBytes(3).toString("hex")}`;
    try {
      const open = await routeForTest("POST", "/sessions/open", { engine: "fake-pg", name, cwd: realpathSync(WORK) });
      expect(open.status).toBe(200);
      expect(open.body).toMatchObject({ name, engine: "fake-pg", ready: true });
      const log = join(TANDEM_HOME, "transcripts", `${name}.log`);
      const line = `${"y".repeat(99)}\n`;
      while (statSync(log).size < 300 * 1024) appendFileSync(log, line.repeat(100));

      const frame = {
        type: CCM_FRAME_TYPES.httpRequest,
        request_id: "r1a37",
        method: "GET",
        path: `/sessions/${name}/read`,
        raw_query: "cursor=0",
        headers: {},
      };
      const response = await handleHubRequest(frame);
      expect(response.status_code).toBe(200);
      expect(JSON.stringify(response).length * 4).toBeLessThanOrEqual(1_048_576);
      const body = JSON.parse(Buffer.from(response.body_base64!, "base64").toString("utf8"));
      expect(body.more).toBe(true);
      expect(body.idle).toBe(false);
      expect(body.cursor).toBeGreaterThan(0);
      expect(body.cursor).toBeLessThanOrEqual(PAGE);
      expect(readFileSync(log).subarray(0, body.cursor).toString("utf8")).toContain(body.text.slice(-50));
    } finally {
      await routeForTest("POST", `/sessions/${name}/close`);
      delete process.env.TANDEM_ENABLED_ENGINES;
    }
  }, 60_000);
});
