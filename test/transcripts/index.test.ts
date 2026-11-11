/**
 * U-R1A-37: transcript pointers (bridge/transcripts/index.ts). Every session Tandem starts for an
 * agent whose harness file names `history` gets a row with a pointer to its own history file and
 * that file's sha256; Tandem's pane logs live under TANDEM_HOME.
 *
 * HOME and TANDEM_HOME are temporary and set before the bridge modules load. tmux runs only on a
 * private socket: TMUX_TMPDIR is a new /tmp/r1a37- folder and TMUX is unset before any tmux call;
 * afterAll kills that socket's server and removes the folder.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("../fixtures/fake-cli.sh", import.meta.url));
const BOX = mkdtempSync("/tmp/r1a37-");
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, `tmux-${process.getuid!()}`, "default");
// Registered before any bridge import, so a failed import still removes the folder.
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "test -S $1 rc=0; tmux -S $1 kill-server rc=$?"; else echo "test -S $1 rc=1 (no private server left)"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a37 index cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});
const HOME = join(BOX, "home");
const TANDEM_HOME = join(BOX, "tandem");
const OWNER = join(TANDEM_HOME, "harnesses");
const OUTSIDE = join(BOX, "outside");
const FAKE_HIST = join(BOX, "fake-history");
const LINK_HIST = join(BOX, "link-history");
const IX_HIST = join(BOX, "ix-history");
const ORDER_HIST = join(BOX, "order-history");
for (const d of [HOME, OWNER, OUTSIDE, FAKE_HIST, LINK_HIST, IX_HIST, ORDER_HIST]) mkdirSync(d, { recursive: true });
chmodSync(OWNER, 0o700);
process.env.HOME = HOME;
process.env.TANDEM_HOME = TANDEM_HOME;

const RULES = `[states]\nworking = ['^fake is thinking\\z']\nidle = ['^fake>\\z']\ndebounce_ms = 300\n`;
const OWNER_FILES: Record<string, string> = {
  "fake-hist": `program = "${FAKE}"\nhas_prompts = true\nhistory = "${FAKE_HIST}"\n`,
  "fake-link": `program = "${FAKE}"\nhas_prompts = true\nhistory = "${LINK_HIST}"\n`,
  "fake-ix": `program = "${FAKE}"\nhas_prompts = true\nhistory = "${IX_HIST}"\n${RULES}`,
  "fake-none": `program = "${FAKE}"\nhas_prompts = true\n`,
  "fake-order": `program = "${FAKE}"\nhas_prompts = true\nhistory = "${ORDER_HIST}"\n`,
};
for (const [name, body] of Object.entries(OWNER_FILES)) {
  writeFileSync(join(OWNER, `${name}.toml`), `name = "${name}"\n${body}`, { mode: 0o600 });
}

// A failed import ends this file before any hook runs, so the folder goes here, then the failure.
const loaded = await Promise.all([
  import("../../bridge/transcripts/index.ts"),
  import("../../bridge/terminal-session.ts"),
  import("../../bridge/engines/harness-engine.ts"),
  import("../../bridge/engine-registry.ts"),
]).catch((e: unknown) => {
  rmSync(BOX, { recursive: true, force: true });
  throw e;
});
let tx = loaded[0];
const { TerminalSession } = loaded[1];
const { harnessDescriptor } = loaded[2];
const { loadedHarnesses } = loaded[3];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const tag = () => randomBytes(3).toString("hex");
/** A new working folder (its real spelling) for one case. */
const work = (label: string) => {
  const d = join(BOX, `work-${label}`);
  mkdirSync(d);
  return realpathSync(d);
};
const claudeFile = (cwd: string, id: string, body = '{"type":"user","message":{"content":"hi"}}\n') => {
  const dir = join(HOME, ".claude", "projects", slug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), body);
  return join(dir, `${id}.jsonl`);
};
const created = (st: { birthtimeMs: number; mtimeMs: number }) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
/** A new history file of `agent` for a session in `cwd`, where its reader (or its folder) finds it. */
const historyFile = (agent: string, cwd: string) => {
  const id = `${randomBytes(4).toString("hex")}-0000-0000-0000-${randomBytes(6).toString("hex")}`;
  if (agent === "claude") return claudeFile(cwd, id);
  if (agent === "fake-order") {
    writeFileSync(join(ORDER_HIST, `${id}.log`), "owner history\n");
    return join(ORDER_HIST, `${id}.log`);
  }
  const day = join(HOME, ".codex", "sessions", "2026", "11", "10");
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-11-10T00-00-00-${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n");
  return file;
};

describe("transcript pointers", () => {
  it("a claude row, a codex row and an owner harness with a history folder each get the path and a sha256 equal to the file's", async () => {
    expect(loadedHarnesses().get("fake-hist")?.history).toBe(FAKE_HIST);

    const cwdC = work("claude");
    const nameC = `r1a37-cl-${tag()}`;
    tx.noteSessionStart({ name: nameC, agent: "claude", cwd: cwdC, startedAtMs: Date.now() });
    await sleep(20);
    const fileC = claudeFile(cwdC, "11111111-2222-3333-4444-555555555555");

    const cwdX = work("codex");
    const nameX = `r1a37-cx-${tag()}`;
    tx.noteSessionStart({ name: nameX, agent: "codex", cwd: cwdX, startedAtMs: Date.now() });
    await sleep(20);
    const day = join(HOME, ".codex", "sessions", "2026", "11", "10");
    mkdirSync(day, { recursive: true });
    const fileX = join(day, "rollout-2026-11-10T00-00-00-00000000-0000-0000-0000-00000000000a.jsonl");
    writeFileSync(fileX, JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-0000-0000-00000000000a", cwd: cwdX } }) + "\n");

    const nameO = `r1a37-ow-${tag()}`;
    tx.noteSessionStart({ name: nameO, agent: "fake-hist", cwd: work("owner"), startedAtMs: Date.now() });
    await sleep(20);
    mkdirSync(join(FAKE_HIST, "deep", "er"), { recursive: true });
    const fileO = join(FAKE_HIST, "deep", "er", "session.log");
    writeFileSync(fileO, "owner agent history\n");

    for (const [name, agent, file, cwd] of [
      [nameC, "claude", fileC, cwdC],
      [nameX, "codex", fileX, cwdX],
      [nameO, "fake-hist", fileO, undefined],
    ] as const) {
      const p = await tx.transcriptFor(name);
      expect(p, name).toBeDefined();
      expect(p!.name).toBe(name);
      expect(p!.agent).toBe(agent);
      if (cwd) expect(p!.cwd).toBe(cwd);
      expect(p!.path).toBe(file);
      expect(p!.sha256).toBe(sha(file));
      expect(p!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p!.bytes).toBe(statSync(file).size);
      expect(typeof p!.startedAtMs).toBe("number");
      expect(typeof p!.recordedAtMs).toBe("number");
    }

    const read = await tx.readTranscript(nameC);
    expect(read?.pointer.path).toBe(fileC);
    expect(read?.messages).toEqual([{ role: "user", text: "hi" }]);
    // An agent with no reader gets the pointer only.
    const readO = await tx.readTranscript(nameO);
    expect(readO?.pointer.path).toBe(fileO);
    expect(readO?.messages).toBeUndefined();
  });

  it("shell and an agent with no history get no row", async () => {
    for (const agent of ["shell", "fake-none", "not-a-harness"]) {
      const name = `r1a37-no-${tag()}`;
      tx.noteSessionStart({ name, agent, cwd: work(`no-${agent}`), startedAtMs: Date.now() });
      expect(await tx.transcriptFor(name)).toBeUndefined();
      expect(await tx.readTranscript(name)).toBeUndefined();
    }
  });

  it("two sessions in one folder get two different files", async () => {
    const cwd = work("two");
    const a = `r1a37-two-a-${tag()}`;
    const b = `r1a37-two-b-${tag()}`;
    tx.noteSessionStart({ name: a, agent: "claude", cwd, startedAtMs: Date.now() });
    tx.noteSessionStart({ name: b, agent: "claude", cwd, startedAtMs: Date.now() });
    await sleep(20);
    const f1 = claudeFile(cwd, "aaaaaaaa-0000-0000-0000-000000000001");
    await sleep(20);
    const f2 = claudeFile(cwd, "aaaaaaaa-0000-0000-0000-000000000002");
    const [pa, pb] = [await tx.transcriptFor(a), await tx.transcriptFor(b)];
    expect(pa?.path).toBe(f1);
    expect(pb?.path).toBe(f2);
  });

  it("review-fix R1: two sessions started in one folder seconds apart, looked up in reverse order, each get their own file (claude, codex, an owner harness)", async () => {
    for (const agent of ["claude", "codex", "fake-order"]) {
      const cwd = work(`rev-${agent}`);
      const a = `r1a37-rev-a-${tag()}`;
      const b = `r1a37-rev-b-${tag()}`;
      const fa = historyFile(agent, cwd);
      await sleep(30);
      const fb = historyFile(agent, cwd);
      // A started 4 s before its first prompt made its file, B 3 s after A: A's file is inside B's window.
      const at = created(statSync(fa));
      tx.noteSessionStart({ name: a, agent, cwd, startedAtMs: at - 4000 });
      tx.noteSessionStart({ name: b, agent, cwd, startedAtMs: at - 1000 });
      expect((await tx.transcriptFor(b))?.path, `${agent} later session`).toBe(fb);
      expect((await tx.transcriptFor(a))?.path, `${agent} earlier session`).toBe(fa);
    }
  });

  it("review-fix R1: a session closed before its file appeared, or one not yet prompted, never takes a later session's file", async () => {
    for (const agent of ["claude", "codex", "fake-order"]) {
      // Closed with no file, then two sessions prompted in order and looked up in order.
      const cwd = work(`closed-${agent}`);
      const dead = `r1a37-dead-${tag()}`;
      const r = `r1a37-r-${tag()}`;
      const s = `r1a37-s-${tag()}`;
      tx.noteSessionStart({ name: dead, agent, cwd, startedAtMs: Date.now() - 5000 });
      await tx.noteSessionClose(dead);
      tx.noteSessionStart({ name: r, agent, cwd, startedAtMs: Date.now() - 4000 });
      tx.noteSessionStart({ name: s, agent, cwd, startedAtMs: Date.now() - 3000 });
      await sleep(20);
      const fr = historyFile(agent, cwd);
      await sleep(30);
      const fs = historyFile(agent, cwd);
      expect((await tx.transcriptFor(r))?.path, `${agent} first`).toBe(fr);
      expect((await tx.transcriptFor(s))?.path, `${agent} second`).toBe(fs);
      expect((await tx.transcriptFor(dead))?.path, `${agent} closed`).toBeUndefined();

      // An earlier session still open and not yet prompted: the later session's file stays its own.
      const cwd2 = work(`idle-${agent}`);
      const idle = `r1a37-idle-${tag()}`;
      const busy = `r1a37-busy-${tag()}`;
      tx.noteSessionStart({ name: idle, agent, cwd: cwd2, startedAtMs: Date.now() - 4000 });
      tx.noteSessionStart({ name: busy, agent, cwd: cwd2, startedAtMs: Date.now() - 3000 });
      await sleep(20);
      const fbusy = historyFile(agent, cwd2);
      expect((await tx.transcriptFor(busy))?.path, `${agent} prompted`).toBe(fbusy);
      await sleep(30);
      const fidle = historyFile(agent, cwd2);
      expect((await tx.transcriptFor(idle))?.path, `${agent} prompted later`).toBe(fidle);
    }
  });

  it("appending and then noteSessionClose changes the sha256; rows survive a module reload", async () => {
    const cwd = work("append");
    const name = `r1a37-ap-${tag()}`;
    tx.noteSessionStart({ name, agent: "claude", cwd, startedAtMs: Date.now() });
    await sleep(20);
    const file = claudeFile(cwd, "bbbbbbbb-0000-0000-0000-000000000001");
    const before = await tx.transcriptFor(name);
    expect(before?.sha256).toBe(sha(file));
    appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"text","text":"more"}]}}\n');
    await tx.noteSessionClose(name);

    vi.resetModules();
    tx = await import("../../bridge/transcripts/index.ts");
    const after = await tx.transcriptFor(name);
    expect(after?.path).toBe(file);
    expect(after?.sha256).toBe(sha(file));
    expect(after?.sha256).not.toBe(before?.sha256);
    expect(after?.bytes).toBe(statSync(file).size);
  });

  it("the transcripts folder is 0700 and the database 0600", () => {
    expect(statSync(join(TANDEM_HOME, "transcripts")).mode & 0o777).toBe(0o700);
    expect(statSync(join(TANDEM_HOME, "transcripts", "index.sqlite3")).mode & 0o777).toBe(0o600);
  });

  it("a symlink in a history folder pointing outside is never chosen", async () => {
    const name = `r1a37-ln-${tag()}`;
    tx.noteSessionStart({ name, agent: "fake-link", cwd: work("link"), startedAtMs: Date.now() });
    await sleep(20);
    writeFileSync(join(OUTSIDE, "secret.txt"), "outside the history folder\n");
    mkdirSync(join(OUTSIDE, "dir"));
    writeFileSync(join(OUTSIDE, "dir", "inner.txt"), "outside too\n");
    symlinkSync(join(OUTSIDE, "secret.txt"), join(LINK_HIST, "a-link.txt"));
    symlinkSync(join(OUTSIDE, "dir"), join(LINK_HIST, "b-dir"));
    expect((await tx.transcriptFor(name))?.path).toBeUndefined();
    await sleep(20);
    const real = join(LINK_HIST, "z-real.txt");
    writeFileSync(real, "inside\n");
    expect((await tx.transcriptFor(name))?.path).toBe(real);
  });

  it("one TerminalSession.spawn on a private socket creates its row and its log under $TANDEM_HOME/transcripts, nothing under $HOME/.tandem/transcripts", async () => {
    const harness = loadedHarnesses().get("fake-ix")!;
    expect(harness.history).toBe(IX_HIST);
    const cwd = work("ix");
    const name = `r1a37-ix-${tag()}`;
    const t0 = Date.now();
    const session = await TerminalSession.spawn({
      name,
      cwd,
      allowlist: [cwd],
      descriptor: harnessDescriptor(harness),
      ownerIdProvider: async () => "r1a37-owner",
    });
    try {
      expect(session.ready).toBe(true);
      const log = join(TANDEM_HOME, "transcripts", `${name}.log`);
      expect(existsSync(log)).toBe(true);
      expect(statSync(log).mode & 0o777).toBe(0o600);
      expect(statSync(join(TANDEM_HOME, "transcripts")).mode & 0o777).toBe(0o700);
      expect(existsSync(join(HOME, ".tandem", "transcripts"))).toBe(false);
      const p = await tx.transcriptFor(name);
      expect(p?.agent).toBe("fake-ix");
      expect(p?.cwd).toBe(cwd);
      expect(p!.startedAtMs).toBeGreaterThanOrEqual(t0);
      expect(p!.startedAtMs).toBeLessThanOrEqual(Date.now());
      writeFileSync(join(IX_HIST, "ix.log"), "ix history\n");
    } finally {
      await session.close();
    }
    const p = await tx.transcriptFor(name);
    expect(p?.path).toBe(join(IX_HIST, "ix.log"));
    expect(p?.sha256).toBe(sha(join(IX_HIST, "ix.log")));
  }, 30_000);
});
