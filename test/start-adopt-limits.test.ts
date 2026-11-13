/**
 * U-R1A-18C-1: start and adopt checks.
 *  (a) every start records `@tandem_skip` (1 = its prompts off, 0 = not) in its new-session call; a reused
 *      or adopted session tagged 1, or untagged, answers 409 `needs owner` unless its folder is in
 *      permission_skip now;
 *  (b) the start runs `/usr/bin/env -- <the checked real program path>`, and a binding folder re-check
 *      runs right before new-session;
 *  (c) folders compare by the volume's own spelling (case rules), never by lower-casing;
 *  (d) an adopted folder is never trimmed or defaulted to HOME;
 *  (e) the screen is read again before a dialog key, and no key goes when the dialog has gone.
 *
 * tmux runs only on this file's own socket: TMUX is unset, TMUX_TMPDIR, HOME and TANDEM_HOME are
 * folders in a new r1a18c1- temp folder, set before any bridge import. afterAll ends every server
 * on a socket in that folder (`tmux -S`) and removes it. The only agent program is a /bin/sh fake.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const BOX = realpathSync.native(mkdtempSync(join(tmpdir(), "r1a18c1-")));
delete process.env.TMUX;
process.env.TMUX_TMPDIR = BOX;
const HOME = join(BOX, "home");
const TH = join(HOME, ".tandem");
const OWNER = join(TH, "harnesses");
const WORK = join(BOX, "work");
const PLAIN = join(WORK, "plain");
const SKIP = join(WORK, "skip");
const OTHER = join(BOX, "other");
const BIN = join(BOX, "bin");
const REAL = join(BOX, "real");
const LOGS = join(BOX, "logs");
for (const d of [HOME, PLAIN, SKIP, OTHER, BIN, REAL, LOGS, join(BOX, "work-evil")]) mkdirSync(d, { recursive: true });
mkdirSync(join(TH, "tmux"), { recursive: true, mode: 0o700 });
chmodSync(TH, 0o700);
chmodSync(join(TH, "tmux"), 0o700);
mkdirSync(OWNER, { mode: 0o700 });
chmodSync(OWNER, 0o700);
process.env.HOME = HOME;
process.env.TANDEM_HOME = TH;
delete process.env.TANDEM_HUB_LINK_URL;
delete process.env.TANDEM_HUB_LINK_TOKEN;
delete process.env.TANDEM_ALLOW_BYPASS;
process.env.CCM_CWD_ALLOWLIST = WORK;
process.env.TANDEM_ENABLED_ENGINES = "r1a18c1-a,r1a18c1-b";

/** The fake agent: the prompt `fake> `, then every byte it reads appended to the log ($1) in hex. */
const AGENT = join(BIN, "r1a18c1-agent");
writeFileSync(
  AGENT,
  [
    "#!/bin/sh",
    'log="$1"',
    "printf 'fake> '",
    "stty raw -echo 2>/dev/null",
    "while :; do",
    "  b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')",
    '  [ -n "$b" ] || exit 0',
    "  printf '%s\\n' \"$b\" >> \"$log\"",
    "done",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
/** b1: the program on PATH is a link to a real file elsewhere. */
const REAL_AGENT = join(REAL, "r1a18c1-agent");
copyFileSync(AGENT, REAL_AGENT);
chmodSync(REAL_AGENT, 0o755);
const LINK = join(BIN, "r1a18c1-link");
symlinkSync(REAL_AGENT, LINK);
const REAL_TMUX = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
process.env.PATH = `${BIN}:/usr/bin:/bin:${process.env.PATH ?? ""}`;

const LOG_A = join(LOGS, "a.log");
const LOG_B = join(LOGS, "b.log");
const RULES_TOML = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
debounce_ms = 300
`;
writeFileSync(join(OWNER, "r1a18c1-a.toml"), `name = "r1a18c1-a"\nprogram = "${AGENT}"\nargs = ["${LOG_A}"]\nhas_prompts = true\nskip_prompts_args = ["--r1a18c1-skip"]\n${RULES_TOML}`, { mode: 0o600 });
writeFileSync(join(OWNER, "r1a18c1-b.toml"), `name = "r1a18c1-b"\nprogram = "r1a18c1-link"\nargs = ["${LOG_B}"]\nhas_prompts = true\n${RULES_TOML}`, { mode: 0o600 });

const ts: Record<string, any> = await import("../bridge/terminal-session.ts");
const { TerminalSession, tmuxSocketPath } = ts;
const { HarnessSession, harnessDescriptor } = await import("../bridge/engines/harness-engine.ts");
const { route } = await import("../bridge/router.ts");
const { loadedHarnesses } = await import("../bridge/engine-registry.ts");
const { applyLimits, limitsGate } = await import("../bridge/limits.ts");
const { buildAllowlist, isCwdAllowed, getLive, unregisterLive } = await import("../bridge/sessions.ts");
const { callerFolder } = await import("../bridge/caller-tokens.ts");
const { makeOwnerIdProvider } = await import("../bridge/ownership.ts");
const { agentEntry, writeLimits } = await import("./fixtures/limits.ts");

const SOCK: string = tmuxSocketPath();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args: string[]) => {
  const env = { ...process.env };
  delete env.TMUX;
  return execFileSync(REAL_TMUX, ["-S", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
};
const tmuxHas = (name: string) => {
  try {
    tmux("has-session", "-t", `=ccm-${name}`);
    return true;
  } catch {
    return false;
  }
};
const fmt = (name: string, format: string) => tmux("display-message", "-p", "-t", `=ccm-${name}:`, format).replace(/\n$/, "");
const kill = (name: string) => {
  try {
    tmux("kill-session", "-t", `=ccm-${name}`);
  } catch {
    /* gone already */
  }
};
const keys = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const auditLog = join(TH, "bridge.log");
const auditLines = (): Record<string, unknown>[] =>
  existsSync(auditLog) ? readFileSync(auditLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const rq = (method: string, path: string, body: Record<string, unknown> = {}) => route({ method, path, query: new URLSearchParams(), body });
const open = (name: string, cwd: string, engine = "r1a18c1-a") => rq("POST", "/sessions/open", { engine, name, cwd });
async function close(name: string): Promise<void> {
  await rq("POST", `/sessions/${name}/close`).catch(() => undefined);
  unregisterLive(name);
  kill(name);
}
const owner = async () => await makeOwnerIdProvider()();
/** A session made by hand on the test's socket with this owner's engine and owner tags (and `@tandem_skip` when given). */
async function handMade(name: string, cwd: string, skip?: string): Promise<void> {
  tmux("new-session", "-d", "-s", `ccm-${name}`, "-x", "200", "-y", "50", "-c", cwd, "/usr/bin/env", "--", AGENT, LOG_A);
  tmux("set-option", "-t", `=ccm-${name}:`, "@tandem_engine", "r1a18c1-a");
  tmux("set-option", "-t", `=ccm-${name}:`, "@tandem_owner", await owner());
  if (skip !== undefined) tmux("set-option", "-t", `=ccm-${name}:`, "@tandem_skip", skip);
  await sleep(300);
}

const harnesses = loadedHarnesses();
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const AGENTS = {
  "r1a18c1-a": agentEntry(harnesses.get("r1a18c1-a")!),
  // pinned by the link path; the gate compares real paths
  "r1a18c1-b": { program: LINK, sha256: sha256(REAL_AGENT) },
};
function limits(fields: Record<string, unknown>): void {
  writeLimits(TH, { agents: AGENTS, ...fields });
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  try {
    applyLimits();
  } finally {
    spy.mockRestore();
  }
}
const DEFAULT = { folders: [WORK], permission_skip: [SKIP] };

beforeEach(() => limits(DEFAULT));
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  const out = execFileSync("/bin/sh", ["-c", 'find "$1" -type s -exec "$2" -S {} kill-server \\; ; echo "find rc=$?"', "sh", BOX, REAL_TMUX], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`r1a18c1 cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

const NEEDS_OWNER = /^needs owner: /;

describe("(a) the start-flag tag and the re-check on reuse and adoption", () => {
  it("(18C1) a1 a folders-only open is tagged 0; a permission_skip open is tagged 1 and starts with skip_prompts_args", async () => {
    try {
      const plain = await open("r1a18c1-a1p", PLAIN);
      expect(plain.status).toBe(200);
      expect(fmt("r1a18c1-a1p", "#{@tandem_skip}")).toBe("0");
      const skip = await open("r1a18c1-a1s", SKIP);
      expect(skip.status).toBe(200);
      expect(fmt("r1a18c1-a1s", "#{@tandem_skip}")).toBe("1");
      expect(fmt("r1a18c1-a1s", "#{pane_start_command}")).toContain("--r1a18c1-skip");
      expect(fmt("r1a18c1-a1p", "#{pane_start_command}")).not.toContain("--r1a18c1-skip");
    } finally {
      await close("r1a18c1-a1p");
      await close("r1a18c1-a1s");
    }
  }, 60_000);

  it("(18C1) a2 a skip=1 session whose folder left permission_skip: reopen is 409 needs owner, stays alive and registered, no key", async () => {
    const name = "r1a18c1-a2";
    try {
      expect((await open(name, SKIP)).status).toBe(200);
      limits({ folders: [WORK], permission_skip: [] });
      const keysBefore = keys(LOG_A).length;
      const before = auditLines().length;
      const res = await open(name, SKIP);
      expect(res.status).toBe(409);
      expect((res.body as any).error).toMatch(NEEDS_OWNER);
      const denied = auditLines().slice(before).filter((l) => l.denied === "skip-tag");
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ route: "POST /sessions/open", name });
      expect(tmuxHas(name)).toBe(true);
      expect(getLive(name)).toBeDefined();
      await sleep(500);
      expect(keys(LOG_A).length).toBe(keysBefore);
    } finally {
      await close(name);
    }
  }, 60_000);

  it("(18C1) a3 a skip=0 session reopened after permission_skip changed: 200 reused (pin)", async () => {
    const name = "r1a18c1-a3";
    try {
      expect((await open(name, PLAIN)).status).toBe(200);
      limits({ folders: [WORK], permission_skip: [] });
      const res = await open(name, PLAIN);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name, reused: true });
    } finally {
      await close(name);
    }
  }, 60_000);

  it("(18C1) a4 adopting a skip=1 session outside permission_skip is 409 and not registered; inside, it is adopted", async () => {
    const name = "r1a18c1-a4";
    try {
      expect((await open(name, SKIP)).status).toBe(200);
      unregisterLive(name);
      limits({ folders: [WORK], permission_skip: [] });
      const res = await open(name, SKIP);
      expect(res.status).toBe(409);
      expect((res.body as any).error).toMatch(NEEDS_OWNER);
      expect(getLive(name)).toBeUndefined();
      expect(tmuxHas(name)).toBe(true);
      limits(DEFAULT);
      const again = await open(name, SKIP);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ name, reused: true });
      expect(getLive(name)).toBeDefined();
    } finally {
      await close(name);
    }
  }, 60_000);

  it("(18C1) a5 an untagged session is refused outside permission_skip; inside, it is adopted and never tagged", async () => {
    try {
      await handMade("r1a18c1-a5", PLAIN);
      const res = await open("r1a18c1-a5", PLAIN);
      expect(res.status).toBe(409);
      expect((res.body as any).error).toMatch(NEEDS_OWNER);
      expect(getLive("r1a18c1-a5")).toBeUndefined();

      await handMade("r1a18c1-a5s", SKIP);
      const inside = await open("r1a18c1-a5s", SKIP);
      expect(inside.status).toBe(200);
      expect(inside.body).toMatchObject({ name: "r1a18c1-a5s", reused: true });
      expect(getLive("r1a18c1-a5s")).toBeDefined();
      expect(fmt("r1a18c1-a5s", "#{@tandem_skip}")).toBe("");
    } finally {
      await close("r1a18c1-a5");
      await close("r1a18c1-a5s");
    }
  }, 60_000);

  it("(18C1) a6 a tag of `yes`, `1 ` or empty reads as untagged: 409", async () => {
    const tags = ["yes", "1 ", ""];
    try {
      for (const [i, tag] of tags.entries()) {
        const name = `r1a18c1-a6-${i}`;
        await handMade(name, PLAIN, tag);
        const res = await open(name, PLAIN);
        expect(res.status, `tag ${JSON.stringify(tag)}`).toBe(409);
        expect((res.body as any).error).toMatch(NEEDS_OWNER);
        expect(getLive(name)).toBeUndefined();
      }
    } finally {
      for (const i of tags.keys()) await close(`r1a18c1-a6-${i}`);
    }
  }, 60_000);
});

describe("(b) the start runs what was checked, where it was checked", () => {
  it("(18C1) b1 a program found through a symlink starts by its real path, never the link", async () => {
    const name = "r1a18c1-b1";
    try {
      const res = await open(name, PLAIN, "r1a18c1-b");
      expect(res.status).toBe(200);
      const start = fmt(name, "#{pane_start_command}");
      expect(start).toContain(REAL_AGENT);
      expect(start.indexOf("/usr/bin/env")).toBeLessThan(start.indexOf(REAL_AGENT));
      expect(start).not.toContain(LINK);
    } finally {
      await close(name);
    }
  }, 60_000);

  it("(18C1) b2 a folderCheck refusal right before new-session: FolderRefusedError, no session, no token; through route() 403", async () => {
    const name = "r1a18c1-b2";
    const variant = existsSync(join(WORK, "PLAIN")) ? join(WORK, "PLAIN") : PLAIN;
    const seen: string[] = [];
    let caught: unknown;
    try {
      const s = await TerminalSession.spawn({
        name,
        cwd: variant,
        allowlist: [WORK],
        descriptor: harnessDescriptor(harnesses.get("r1a18c1-a")!),
        folderCheck: (c: string) => {
          seen.push(c);
          return "limits: r1a18c1 refused";
        },
      });
      await s.close();
    } catch (e) {
      caught = e;
    }
    expect(ts.FolderRefusedError).toBeTypeOf("function");
    expect(caught).toBeInstanceOf(ts.FolderRefusedError);
    expect((caught as Error).message).toBe("limits: r1a18c1 refused");
    expect(tmuxHas(name)).toBe(false);
    expect(callerFolder(name)).toBeUndefined();
    expect(seen).toEqual([PLAIN]);

    // The limits file changes between the router's check and the start.
    const routed = "r1a18c1-b2r";
    const realSpawn = TerminalSession.spawn;
    vi.spyOn(TerminalSession, "spawn").mockImplementation((async (o: unknown) => {
      limits({ folders: [OTHER], permission_skip: [] });
      return realSpawn.call(TerminalSession, o);
    }) as never);
    try {
      const before = auditLines().length;
      const res = await open(routed, PLAIN);
      expect(res.status).toBe(403);
      expect((res.body as any).error).toMatch(/^limits: cwd .* is not inside the limits file's folders/);
      expect(tmuxHas(routed)).toBe(false);
      expect(getLive(routed)).toBeUndefined();
      expect(auditLines().slice(before)).toContainEqual(expect.objectContaining({ name: routed, denied: "limits" }));
    } finally {
      await close(routed);
    }
  }, 60_000);
});

describe("(c) folders compare by the volume's case rules", () => {
  const variant = join(dirname(WORK), basename(WORK).toUpperCase());
  const insensitive = existsSync(join(dirname(BOX), basename(BOX).toUpperCase()));

  it(`(18C1) c1 a case variant of an allowed folder: ${insensitive ? "case-insensitive volume, the same folder" : "case-sensitive volume, a different folder"}`, async () => {
    if (insensitive) {
      expect(isCwdAllowed(variant, buildAllowlist(WORK))).toBe(true);
      expect(limitsGate().folder(variant)).toBeUndefined();
      const name = "r1a18c1-c1";
      try {
        const res = await open(name, join(variant, "plain"));
        expect(res.status).toBe(200);
        expect((res.body as any).cwd).toBe(PLAIN);
        expect(getLive(name)!.cwd).toBe(PLAIN);
      } finally {
        await close(name);
      }
    } else {
      expect(isCwdAllowed(variant, buildAllowlist(WORK))).toBe(false);
      expect(limitsGate().folder(variant)).toMatch(/^limits: /);
    }
  }, 60_000);

  it("(18C1) c2 /work never holds /work-evil (pin)", () => {
    expect(isCwdAllowed(join(BOX, "work-evil"), buildAllowlist(WORK))).toBe(false);
    expect(limitsGate().folder(join(BOX, "work-evil"))).toMatch(/^limits: /);
  });
});

describe("(d) the adopted folder is read as itself", () => {
  it("(18C1) d1 folders with a trailing and a leading space are adopted exactly", async () => {
    const trailing = join(WORK, "r1a18c1 sp ");
    const leading = join(WORK, " r1a18c1-lead");
    mkdirSync(trailing);
    mkdirSync(leading);
    try {
      for (const [name, dir] of [["r1a18c1-d1t", trailing], ["r1a18c1-d1l", leading]] as const) {
        await handMade(name, dir, "0");
        const res = await open(name, PLAIN);
        expect(res.status, name).toBe(200);
        expect(res.body).toMatchObject({ name, reused: true });
        expect((res.body as any).cwd).toBe(dir);
        expect(getLive(name)!.cwd).toBe(dir);
      }
    } finally {
      await close("r1a18c1-d1t");
      await close("r1a18c1-d1l");
    }
  }, 60_000);

  it("(18C1) d2 a folder name ending in a newline is adopted as itself or refused, never trimmed", async () => {
    const nl = join(WORK, "r1a18c1-nl\n");
    mkdirSync(nl);
    const name = "r1a18c1-d2";
    try {
      await handMade(name, nl, "0");
      const res = await open(name, PLAIN);
      if (res.status === 200) {
        expect((res.body as any).cwd).toBe(nl);
      } else {
        expect(getLive(name)).toBeUndefined();
      }
      expect((res.body as any).cwd).not.toBe(join(WORK, "r1a18c1-nl"));
      expect(getLive(name)?.cwd).not.toBe(join(WORK, "r1a18c1-nl"));
    } finally {
      await close(name);
    }
  }, 60_000);

  it("(18C1) d3 a failed folder read refuses the adoption (no HOME default)", async () => {
    const name = "r1a18c1-d3";
    // A tmux stand-in first on PATH: after the provenance read it ends the session, so the folder read fails.
    const shimDir = join(BOX, "shim");
    mkdirSync(shimDir, { recursive: true });
    const hook = join(shimDir, "hook.sh");
    writeFileSync(hook, `"${REAL_TMUX}" -S "${SOCK}" kill-session -t "=ccm-${name}"\nrm -f "$0"\n`);
    writeFileSync(
      join(shimDir, "tmux"),
      [
        "#!/bin/sh",
        `"${REAL_TMUX}" "$@"`,
        "rc=$?",
        `case "$*" in *"@tandem_owner}"*) [ -f "${hook}" ] && sh "${hook}" ;; esac`,
        "exit $rc",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const savedPath = process.env.PATH;
    try {
      tmux("new-session", "-d", "-s", "r1a18c1-keeper", "sleep", "600");
      await handMade(name, PLAIN, "0");
      process.env.PATH = `${shimDir}:${savedPath}`;
      const adopted = await TerminalSession.attachExisting(name, [HOME], harnessDescriptor(harnesses.get("r1a18c1-a")!), owner);
      expect(tmuxHas(name)).toBe(false);
      expect(adopted).toBeUndefined();
    } finally {
      process.env.PATH = savedPath;
      kill(name);
      try {
        tmux("kill-session", "-t", "=r1a18c1-keeper");
      } catch {
        /* gone */
      }
    }
  }, 60_000);
});

describe("(e) the screen is read again before a dialog key", () => {
  const TRUST_ROW = { name: "folder-trust", kind: "trust", match: ["(?i)trust this folder"], answer: "Yes, I trust this folder", highlight: "❯" };
  const DIALOG = " Do you trust this folder?\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm\n";
  const STATES = { working: ["^fake is thinking\\z"], idle: ["^fake>\\z"], debounce_ms: 300, precedence: ["working", "idle"] };
  const harness = (name: string, log: string) =>
    ({
      name: "r1a18c1-a", program: AGENT, programPath: AGENT, args: [log],
      skip_prompts_args: [], resume: [], fork: [], has_prompts: true, states: STATES, dialogs: [TRUST_ROW],
      delivery: "notice", permission_hook: false, reports_context: false, source: "owner", file: join(OWNER, `${name}.toml`), kind: "agent",
    }) as any;
  /** capture() shows the dialog for its first `dialogReads` calls, then the real screen. */
  function screens(dialogReads: number): void {
    const real = (TerminalSession.prototype as any).capture;
    let n = 0;
    (vi.spyOn(TerminalSession.prototype as never, "capture" as never) as any).mockImplementation((async function (this: unknown) {
      n += 1;
      return n <= dialogReads ? DIALOG : real.call(this);
    }) as never);
  }

  it("(18C1) e1 the dialog has gone at the re-read: no key, the start ends ready", async () => {
    const name = "r1a18c1-e1";
    const log = join(LOGS, "e1.log");
    screens(1);
    const s = await HarnessSession.spawn(harness(name, log), { name, cwd: PLAIN, allowlist: [WORK], dialogAnswers: "safe" } as any);
    try {
      expect(s.ready).toBe(true);
      await sleep(500);
      expect(keys(log)).toEqual([]);
    } finally {
      await s.close();
      kill(name);
    }
  }, 60_000);

  it("(18C1) e2 the re-read still shows the dialog: the key is sent once (pin)", async () => {
    const name = "r1a18c1-e2";
    const log = join(LOGS, "e2.log");
    screens(2);
    const s = await HarnessSession.spawn(harness(name, log), { name, cwd: PLAIN, allowlist: [WORK], dialogAnswers: "safe" } as any);
    try {
      expect(s.ready).toBe(true);
      await sleep(500);
      expect(keys(log)).toEqual(["0d"]);
    } finally {
      await s.close();
      kill(name);
    }
  }, 60_000);
});
