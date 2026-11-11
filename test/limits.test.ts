/**
 * U-R1A-17: the limits file ($TANDEM_HOME/limits.toml) is the ceiling on what sessions may start
 * on this computer, for `folders`, `agents`, `shell` and `permission_skip`. It is read once at
 * start; a change on disk is not used until applyLimits() runs at this computer, and raises a
 * notice until then; nothing remote can widen it.
 *
 * Requests go through handleHubRequest as the hub sends them, with the env switches on
 * (TANDEM_ENABLED_ENGINES, TANDEM_CWD_ALLOWLIST), so the file is the only thing that changes.
 * tmux runs only on a private socket: TMUX_TMPDIR is a new /tmp/r1a17- folder and TMUX is unset
 * before any tmux call; afterAll kills that server through its own -S socket and removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentEntry, writeLimits } from "./fixtures/limits.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-cli.sh", import.meta.url));
const BOX = realpathSync(mkdtempSync("/tmp/r1a17-"));
process.env.TMUX_TMPDIR = BOX;
delete process.env.TMUX;
const SOCK = join(BOX, `tmux-${process.getuid!()}`, "default");
const TH = join(BOX, "tandem");
const OWNER = join(TH, "harnesses");
const LIMITS = join(TH, "limits.toml");
const WORK = join(BOX, "work");
const SKIP = join(WORK, "skip");
const OTHER = join(BOX, "other");
/** Executable fakes: `bash` (fake-cli.sh under a shell's name) and `other-cli` (another program). */
const BIN = join(BOX, "bin");
/** Only a fake `claude` (never run), first on PATH so the built-in claude file finds it. */
const CLAUDE_BIN = join(BOX, "claude-bin");
for (const dir of [OWNER, SKIP, OTHER, BIN, CLAUDE_BIN]) mkdirSync(dir, { recursive: true });
chmodSync(TH, 0o700);
chmodSync(OWNER, 0o700);
const FAKE_BASH = join(BIN, "bash");
const OTHER_CLI = join(BIN, "other-cli");
copyFileSync(FAKE, FAKE_BASH);
copyFileSync(FAKE, OTHER_CLI);
chmodSync(FAKE_BASH, 0o755);
chmodSync(OTHER_CLI, 0o755);
writeFileSync(join(CLAUDE_BIN, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

const RULES = `[states]
working = ['^fake is thinking\\z']
idle = ['^fake>\\z']
waiting_for_approval = ['\\(y/n\\)\\z']
debounce_ms = 300
`;
writeFileSync(join(OWNER, "fake-a.toml"), `name = "fake-a"\nprogram = "${FAKE}"\nhas_prompts = true\nskip_prompts_args = ["--r1a17-skip"]\n${RULES}`, { mode: 0o600 });
writeFileSync(join(OWNER, "fake-bash.toml"), `name = "fake-bash"\nprogram = "${FAKE_BASH}"\nhas_prompts = false\n${RULES}`, { mode: 0o600 });

// The env switches, all on: the limits file is the only gate these cases move.
process.env.TANDEM_HOME = TH;
process.env.CCM_CWD_ALLOWLIST = `${WORK}:${OTHER}`;
process.env.TANDEM_ENABLED_ENGINES = "fake-a,fake-bash,shell,claude";
process.env.TANDEM_WAIT_MS = "8000";
process.env.PATH = `${CLAUDE_BIN}:${process.env.PATH ?? ""}`;
delete process.env.TANDEM_ALLOW_BYPASS;

// The start read: no file yet. Its stderr line is caught here.
const startLines: string[] = [];
const startSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
  startLines.push(String(chunk));
  return true;
}) as never);
const limits = await import("../bridge/limits.ts");
const { handleHubRequest } = await import("../bridge/hub-rpc.ts");
const { loadedHarnesses } = await import("../bridge/engine-registry.ts");
const { getLive, unregisterLive } = await import("../bridge/sessions.ts");
const { HarnessSession } = await import("../bridge/engines/harness-engine.ts");
const { TerminalSession } = await import("../bridge/terminal-session.ts");
const { CCM_FRAME_TYPES } = await import("../hub/src/protocol.ts");
const harnesses = loadedHarnesses();
startSpy.mockRestore();

const NOTICE = " (notice: the limits file changed on disk and is not applied; apply it at this computer)";
const EMPTY = { folders: [], shell: false, permission_skip: [], agents: {} };
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const entry = (name: string) => agentEntry(harnesses.get(name)!);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1a17 cleanup: ${out.trim()}`);
  rmSync(BOX, { recursive: true, force: true });
});

/** Runs `fn` with stderr captured; returns its result and the lines written. */
async function withStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}
const apply = () => withStderr(() => limits.applyLimits());
const notices = (lines: string[]) => lines.filter((l) => l.includes("changed on disk"));

let seq = 0;
/** One request as the hub sends it: a frame through handleHubRequest; the status and JSON body back. */
async function viaHub(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const frame = {
    type: CCM_FRAME_TYPES.httpRequest,
    request_id: `r1a17-${++seq}`,
    method,
    path,
    headers: {},
    ...(body !== undefined ? { body_base64: Buffer.from(JSON.stringify(body), "utf8").toString("base64") } : {}),
  };
  const res = await handleHubRequest(frame as never);
  return { status: res.status_code, body: JSON.parse(Buffer.from(res.body_base64 ?? "", "base64").toString("utf8")) };
}
const open = (name: string, engine: string, cwd: string, extra: Record<string, unknown> = {}) =>
  viaHub("POST", "/sessions/open", { name, engine, cwd, ...extra });
const close = (name: string) => viaHub("POST", `/sessions/${name}/close`);

const tmux = (...args: string[]) => execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pane = (name: string) => tmux("capture-pane", "-p", "-t", `=ccm-${name}:`);
const tmuxHas = (name: string) => {
  try {
    tmux("has-session", "-t", `=ccm-${name}`);
    return true;
  } catch {
    return false;
  }
};

function lastAudit(): Record<string, unknown> {
  const lines = readFileSync(join(homedir(), ".tandem", "bridge.log"), "utf8").split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

/** A 403 from the limits gate, with its audit line; `notice` says whether the error ends with the notice. */
function expectLimitsRefusal(res: { status: number; body: any }, name: string, engine: string, notice: boolean) {
  expect(res.status).toBe(403);
  expect(res.body.error).toMatch(/^limits: /);
  if (notice) expect(res.body.error.endsWith(NOTICE)).toBe(true);
  else expect(res.body.error).not.toContain("notice");
  expect(lastAudit()).toMatchObject({ route: "POST /sessions/open", name, engine, denied: "limits" });
}

let n = 0;
const uniq = (tag: string) => `r1a17-${tag}-${++n}`;

/**
 * One field, end to end: no file is 403; a file without the item is 403; that file edited on disk
 * to allow it, not applied, is still 403 with the notice (one stderr line for that digest); after
 * applyLimits() the open answers 200 on the private socket. Returns the open session's name.
 */
async function fieldSequence(o: { tag: string; engine: string; cwd: string; without: Record<string, unknown>; with: Record<string, unknown>; reason: RegExp }) {
  rmSync(LIMITS, { force: true });
  await apply();
  const none = uniq(o.tag);
  expectLimitsRefusal(await open(none, o.engine, o.cwd), none, o.engine, false);

  writeLimits(TH, o.without);
  await apply();
  const without = uniq(o.tag);
  const refused = await open(without, o.engine, o.cwd);
  expectLimitsRefusal(refused, without, o.engine, false);
  expect(refused.body.error).toMatch(o.reason);

  writeLimits(TH, o.with);
  appendFileSync(LIMITS, `# ${o.tag}\n`); // a digest no earlier case has seen
  const edited = uniq(o.tag);
  const first = await withStderr(() => open(edited, o.engine, o.cwd));
  expectLimitsRefusal(first.result, edited, o.engine, true);
  expect(first.result.body.error).toMatch(o.reason);
  const again = uniq(o.tag);
  const second = await withStderr(() => open(again, o.engine, o.cwd));
  expectLimitsRefusal(second.result, again, o.engine, true);
  expect(notices([...first.lines, ...second.lines])).toHaveLength(1);
  for (const name of [none, without, edited, again]) expect(tmuxHas(name)).toBe(false);

  await apply();
  const name = uniq(o.tag);
  const opened = await open(name, o.engine, o.cwd);
  expect(opened.status).toBe(200);
  expect(opened.body).toMatchObject({ name, engine: o.engine, ready: true });
  expect(tmuxHas(name)).toBe(true);
  return name;
}

describe("limits file: start and parsing", () => {
  it("at start with no file: nothing is allowed, digest `missing`, one stderr line", () => {
    expect(limits.limitsSnapshot()).toEqual({ ...EMPTY, digest: "missing", problem: `no limits file at ${LIMITS}` });
    expect(startLines.filter((l) => l.startsWith("limits: "))).toEqual([`limits: no limits file at ${LIMITS}; nothing is allowed\n`]);
  });

  it("a full valid file loads", async () => {
    const text = [
      `folders = ["~/r1a17-proj", "${WORK}"]`,
      "shell = true",
      `permission_skip = ["${SKIP}"]`,
      "",
      "[agents]",
      `fake-a = { program = "${FAKE}", sha256 = "${sha256(FAKE)}" }`,
      `shell = { program = "/bin/sh" }`,
      "",
    ].join("\n");
    writeFileSync(LIMITS, text, { mode: 0o600 });
    chmodSync(LIMITS, 0o600);
    const { lines } = await apply();
    expect(lines).toEqual([]);
    expect(limits.limitsSnapshot()).toEqual({
      folders: [join(realpathSync(homedir()), "r1a17-proj"), WORK],
      shell: true,
      permission_skip: [SKIP],
      agents: { "fake-a": { program: FAKE, sha256: sha256(FAKE) }, shell: { program: "/bin/sh" } },
      digest: createHash("sha256").update(text).digest("hex"),
    });
  });

  const refusals: [string, string | (() => void), RegExp][] = [
    ["an unknown field", 'extra = true\n', /unknown field extra/],
    ["an unknown key in an agent", '[agents]\nfake-a = { program = "/bin/sh", args = [] }\n', /unknown field agents\.fake-a\.args/],
    ["a bad agent name", '[agents]\n"Bad Name" = { program = "/bin/sh" }\n', /bad agent name/],
    ["a wrong type (shell)", 'shell = "yes"\n', /wrong type for shell/],
    ["a wrong type (folders)", 'folders = "/tmp"\n', /wrong type for folders/],
    ["a wrong type (an agent)", '[agents]\nfake-a = "/bin/sh"\n', /wrong type for agents\.fake-a/],
    ["a missing program", '[agents]\nfake-a = { sha256 = "' + "a".repeat(64) + '" }\n', /agents\.fake-a\.program/],
    ["a relative path in folders", 'folders = ["work"]\n', /relative path in folders/],
    ["a relative program", '[agents]\nfake-a = { program = "fake-cli.sh" }\n', /relative path in agents\.fake-a\.program/],
    ["a control character", 'folders = ["/tmp/a\\u0007b"]\n', /control character in folders/],
    ["a bad sha256", '[agents]\nfake-a = { program = "/bin/sh", sha256 = "' + "A".repeat(64) + '" }\n', /bad sha256 in agents\.fake-a/],
    ["a TOML syntax error", 'folders = [\n', /TOML syntax error/],
    ["mode 0644", () => {
      writeFileSync(LIMITS, `folders = ["${WORK}"]\n`, { mode: 0o600 });
      chmodSync(LIMITS, 0o644);
    }, /permissions are too broad/],
    ["a symlink", () => {
      const real = join(BOX, "real-limits.toml");
      writeFileSync(real, `folders = ["${WORK}"]\n`, { mode: 0o600 });
      chmodSync(real, 0o600);
      symlinkSync(real, LIMITS);
    }, /symlink/],
    ["over 64 KiB", `folders = ["${WORK}"]\n${"# padding\n".repeat(7000)}`, /over 64 KiB/],
    ["a folders entry equal to the file's folder", `folders = ["${TH}"]\n`, /folders entry .* equals, holds or lies inside the limits file's folder/],
    ["a folders entry holding the file's folder", `folders = ["${BOX}"]\n`, /folders entry .* equals, holds or lies inside the limits file's folder/],
    ["a permission_skip entry inside the file's folder", `folders = ["${WORK}"]\npermission_skip = ["${join(TH, "sub")}"]\n`, /permission_skip entry .* equals, holds or lies inside the limits file's folder/],
  ];
  it.each(refusals)("%s refuses the whole file: nothing is allowed and the reason is named", async (_label, file, reason) => {
    rmSync(LIMITS, { force: true });
    if (typeof file === "string") {
      writeFileSync(LIMITS, file, { mode: 0o600 });
      chmodSync(LIMITS, 0o600);
    } else file();
    const { lines } = await apply();
    const snap = limits.limitsSnapshot();
    expect(snap).toMatchObject(EMPTY);
    expect(snap.problem).toMatch(reason);
    expect(lines).toEqual([`limits: ${snap.problem}; nothing is allowed\n`]);
    rmSync(LIMITS, { force: true });
  });
});

describe("limits file: each field through handleHubRequest (private tmux socket)", () => {
  it("folders: a cwd inside TANDEM_CWD_ALLOWLIST but outside `folders`", async () => {
    const agents = { "fake-a": entry("fake-a") };
    const name = await fieldSequence({
      tag: "folders", engine: "fake-a", cwd: OTHER,
      without: { folders: [WORK], agents }, with: { folders: [WORK, OTHER], agents },
      reason: /cwd .* is not inside the limits file's folders/,
    });
    expect((await close(name)).status).toBe(200);
  }, 60_000);

  it("agents: a fake agent not listed", async () => {
    const name = await fieldSequence({
      tag: "agents-none", engine: "fake-a", cwd: WORK,
      without: { folders: [WORK] }, with: { folders: [WORK], agents: { "fake-a": entry("fake-a") } },
      reason: /agent "fake-a" is not in the limits file's agents/,
    });
    expect((await close(name)).status).toBe(200);
  }, 60_000);

  it("agents: listed with another program", async () => {
    const name = await fieldSequence({
      tag: "agents-prog", engine: "fake-a", cwd: WORK,
      without: { folders: [WORK], agents: { "fake-a": { program: OTHER_CLI, sha256: sha256(OTHER_CLI) } } },
      with: { folders: [WORK], agents: { "fake-a": entry("fake-a") } },
      reason: /agent "fake-a" runs .* but the limits file pins /,
    });
    expect((await close(name)).status).toBe(200);
  }, 60_000);

  it("agents: an owner file with a wrong sha256 (and with none)", async () => {
    const { program } = entry("fake-a");
    const name = await fieldSequence({
      tag: "agents-sha", engine: "fake-a", cwd: WORK,
      without: { folders: [WORK], agents: { "fake-a": { program, sha256: "0".repeat(64) } } },
      with: { folders: [WORK], agents: { "fake-a": entry("fake-a") } },
      reason: /agent "fake-a" is an owner harness file and its program's sha256 is not the one the limits file pins/,
    });
    expect((await close(name)).status).toBe(200);

    writeLimits(TH, { folders: [WORK], agents: { "fake-a": { program } } });
    await apply();
    const unpinned = uniq("agents-sha");
    const res = await open(unpinned, "fake-a", WORK);
    expectLimitsRefusal(res, unpinned, "fake-a", false);
    expect(res.body.error).toMatch(/sha256/);
  }, 60_000);

  it("shell: an owner harness whose program is an executable fake named bash, with shell = false", async () => {
    expect(harnesses.get("fake-bash")?.kind).toBe("shell");
    const agents = { "fake-bash": entry("fake-bash") };
    const name = await fieldSequence({
      tag: "shell", engine: "fake-bash", cwd: WORK,
      without: { folders: [WORK], shell: false, agents }, with: { folders: [WORK], shell: true, agents },
      reason: /agent "fake-bash" runs a shell or interpreter and the limits file has shell = false/,
    });
    expect((await close(name)).status).toBe(200);
  }, 60_000);

  it("permission_skip: --r1a17-skip is on the screen only inside a permission_skip folder, also with TANDEM_ALLOW_BYPASS=1", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    const agents = { "fake-a": entry("fake-a") };
    rmSync(LIMITS, { force: true });
    await apply();
    const none = uniq("skip");
    expectLimitsRefusal(await open(none, "fake-a", SKIP), none, "fake-a", false);

    writeLimits(TH, { folders: [WORK], agents });
    await apply();
    const without = uniq("skip");
    expect((await open(without, "fake-a", SKIP)).status).toBe(200);
    expect(pane(without)).toContain("argc=0\n");
    expect(pane(without)).not.toContain("--r1a17-skip");

    writeLimits(TH, { folders: [WORK], permission_skip: [SKIP], agents });
    appendFileSync(LIMITS, "# skip\n"); // a digest no earlier case has seen
    const edited = uniq("skip");
    const first = await withStderr(() => open(edited, "fake-a", SKIP));
    expect(first.result.status).toBe(200);
    expect(pane(edited)).not.toContain("--r1a17-skip");
    expect(notices(first.lines)).toHaveLength(1);

    await apply();
    const inside = uniq("skip");
    expect((await open(inside, "fake-a", SKIP)).status).toBe(200);
    expect(pane(inside)).toContain("argc=1\narg=[--r1a17-skip]\n");
    const outside = uniq("skip");
    expect((await open(outside, "fake-a", WORK)).status).toBe(200);
    expect(pane(outside)).toContain("argc=0\n");
    expect(pane(outside)).not.toContain("--r1a17-skip");
    for (const name of [without, edited, inside, outside]) expect((await close(name)).status).toBe(200);
  }, 90_000);

  it("permission_skip: a relay start outside permission_skip is 403 before any spawn (claude enabled and pinned to a fake claude, TANDEM_ALLOW_BYPASS=1)", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    const claude = harnesses.get("claude")!;
    expect(claude.programPath).toBe(join(CLAUDE_BIN, "claude"));
    const spawn = vi.spyOn(TerminalSession, "spawn");
    const relay = (cwd: string) => viaHub("POST", "/relay/start", { goal: "r1a17 goal", cwd });
    const expect403 = (res: { status: number; body: any }) => {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/^limits: /);
      expect(lastAudit()).toMatchObject({ route: "POST /relay/start", denied: "limits" });
    };

    rmSync(LIMITS, { force: true });
    await apply();
    expect403(await relay(WORK));

    writeLimits(TH, { folders: [WORK], permission_skip: [SKIP], agents: { claude: agentEntry(claude) } });
    await apply();
    const outside = await relay(WORK);
    expect403(outside);
    expect(outside.body.error).toMatch(/is not inside the limits file's permission_skip/);
    // agents and folders hold for the relay too
    writeLimits(TH, { folders: [WORK], permission_skip: [SKIP] });
    await apply();
    expect403(await relay(SKIP));
    expect403(await relay(OTHER));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("an adopted session whose cwd is outside `folders` is 403 and not registered; inside, it is adopted", async () => {
    writeLimits(TH, { folders: [WORK], agents: { "fake-a": entry("fake-a") } });
    await apply();
    // A ccm- session that outlived a bridge restart: the tmux side is stubbed (adoption itself is
    // terminal-session.test.ts's), so only the router's limits check on the adopted cwd is tested.
    const survivor = (name: string, cwd: string) => ({
      id: name, engine: "fake-a", cwd, attachHint: () => `tmux attach -t '=ccm-${name}'`, close: async () => {},
    });
    vi.spyOn(TerminalSession, "engineTagOf").mockResolvedValue("fake-a");
    const adopt = vi.spyOn(HarnessSession, "attachExisting");

    const outside = uniq("adopt");
    adopt.mockResolvedValueOnce(survivor(outside, OTHER) as never);
    const res = await open(outside, "fake-a", WORK);
    expectLimitsRefusal(res, outside, "fake-a", false);
    expect(res.body.error).toMatch(/cwd .* is not inside the limits file's folders/);
    expect(getLive(outside)).toBeUndefined();

    const inside = uniq("adopt");
    adopt.mockResolvedValueOnce(survivor(inside, WORK) as never);
    expect(await open(inside, "fake-a", WORK)).toMatchObject({ status: 200, body: { name: inside, cwd: WORK, reused: true } });
    expect(getLive(inside)).toBeDefined();
    unregisterLive(inside);
    expect(adopt).toHaveBeenCalledTimes(2);
  });
});

describe("limits file: nothing remote can widen it", () => {
  it("GET /limits, POST /limits and POST /limits/apply are 404 and change nothing", async () => {
    writeLimits(TH, { folders: [WORK], agents: { "fake-a": entry("fake-a") } });
    await apply();
    const before = limits.limitsSnapshot();
    const body = { folders: [OTHER], shell: true, agents: { "fake-bash": entry("fake-bash") } };
    expect((await viaHub("GET", "/limits")).status).toBe(404);
    expect((await viaHub("POST", "/limits", body)).status).toBe(404);
    expect((await viaHub("POST", "/limits/apply", body)).status).toBe(404);
    expect(limits.limitsSnapshot()).toEqual(before);
  });

  it("an open body carrying limits, folders, agents, shell or permission_skip widens nothing", async () => {
    writeLimits(TH, { folders: [WORK], agents: { "fake-a": entry("fake-a") } });
    await apply();
    const before = limits.limitsSnapshot();
    const widen = {
      limits: { folders: [OTHER], shell: true, permission_skip: [WORK] },
      folders: [OTHER],
      agents: { "fake-bash": entry("fake-bash") },
      shell: true,
      permission_skip: [WORK],
    };
    const outside = uniq("remote");
    expectLimitsRefusal(await open(outside, "fake-a", OTHER, widen), outside, "fake-a", false);
    const shell = uniq("remote");
    expectLimitsRefusal(await open(shell, "fake-bash", WORK, widen), shell, "fake-bash", false);
    const inside = uniq("remote");
    expect((await open(inside, "fake-a", WORK, widen)).status).toBe(200);
    expect(pane(inside)).not.toContain("--r1a17-skip");
    expect((await close(inside)).status).toBe(200);
    expect(limits.limitsSnapshot()).toEqual(before);
    expect(existsSync(LIMITS)).toBe(true);
  }, 60_000);
});
