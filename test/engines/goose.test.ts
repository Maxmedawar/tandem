/**
 * U-R1B-GOOSE: Goose's command-line agent (`goose session`, a line REPL) runs from its built-in
 * harness file (harnesses/goose.toml) through the one harness engine, with no code change. The
 * `goose` on PATH here is always a fake script; one case runs it in tmux, never the real Goose.
 *
 * tmux runs only on Tandem's own socket under the test TANDEM_HOME: before any tmux call
 * TMUX_TMPDIR is a new r1bgse- folder and TMUX is unset, so nothing here reaches the default
 * server where the live agents run. Its afterAll kills that server through its own -S socket,
 * then removes the folder.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../../bridge/harness-registry.ts";
import type { HarnessTerminal } from "../../bridge/engines/harness-engine.ts";
import type { SpawnOptions } from "../../bridge/terminal-session.ts";

const TMUX_BOX = mkdtempSync(join(tmpdir(), "r1bgse-"));
process.env.TMUX_TMPDIR = TMUX_BOX;
delete process.env.TMUX;
// Tandem's own socket under TANDEM_HOME (set below to join(tmp, "tandem")), read at cleanup.
const SOCK = () => join(tmp, "tandem", "tmux", "tandem");
afterAll(() => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", 'if test -S "$1"; then tmux -S "$1" kill-server; echo "tmux -S $1 kill-server rc=$?"; else echo "no private server left"; fi', "sh", SOCK()],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(`r1bgse cleanup: ${out.trim()}`);
  rmSync(TMUX_BOX, { recursive: true, force: true });
});

const tmp = mkdtempSync(join(tmpdir(), "r1bgse-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "r1bgse-")));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

// Read when the bridge modules load (transcripts, harness files).
process.env.TANDEM_HOME = join(tmp, "tandem");

const { loadHarnesses } = await import("../../bridge/harness-registry.ts");
const { readScreen } = await import("../../bridge/harness-detect.ts");
const { HarnessSession } = await import("../../bridge/engines/harness-engine.ts");
const { EngineDisabledError, EngineUnavailableError, loadedHarnesses, resetHarnessCache, resolveEngine } = await import(
  "../../bridge/engine-registry.ts"
);
const { spawnArgv, TerminalSession } = await import("../../bridge/terminal-session.ts");
const { routeForTest } = await import("../../bridge/router.ts");

const BUILTIN = fileURLToPath(new URL("../../harnesses/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const GSE_SCREENS = join(FIXTURES, "goose-screens");
const SCREENS = join(FIXTURES, "screens");
const IDLE_SRC = join(GSE_SCREENS, "idle-src.txt");
const NO_OWNER = join(tmp, "no-owner");
const HINT = "> Enter to send · Ctrl+J newline";
const Q_TOOL = "Goose would like to call the above tool, do you allow?";
const Q_PROMPT = "Do you allow this tool call?";
/**
 * A PATH folder holding an executable fake `goose` (it ignores its `session` argument): it prints
 * idle-src; for each line it reads it prints the line, the thinking spinner for about 1 s, clears
 * that line, then prints `reply: <line>`, a blank line and the prompt hint again (a REPL scrolls).
 */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
const FAKE_GOOSE = join(BIN, "goose");
writeFileSync(
  FAKE_GOOSE,
  `#!/bin/sh\ncat '${IDLE_SRC}'\nwhile IFS= read -r line; do\n  printf '%s\\n' "$line"\n  printf '◒  Thinking...  (Ctrl+C to interrupt)'\n  sleep 1\n  printf '\\r\\033[K'\n  printf 'reply: %s\\n\\n${HINT}\\n' "$line"\ndone\n`,
  { mode: 0o755 },
);

/** The built-in goose file as the loader reads it (no owner files, the fake on PATH). */
function builtinGoose(path = BIN): Harness {
  const { harnesses, errors } = loadHarnesses({ installDir: BUILTIN, ownerDir: NO_OWNER, path });
  expect(errors).toEqual([]);
  const h = harnesses.get("goose");
  expect(h).toBeDefined();
  return h!;
}

const screen = (file: string) => readFileSync(file, "utf8");
const isFile = (p: string) => statSync(p).isFile();

function fakeTerminal() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fake: HarnessTerminal = {
    name: "r1bgse-fake",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t '=ccm-r1bgse-fake'",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => ({ report: `report: ${text}`, cursor: 1, status: "done" as const }),
    readSince: async (cursor: number) => ({ text: "", cursor, idle: true }),
    applyControls: async () => [],
    interrupt: async (...args: unknown[]) => {
      calls.push({ method: "interrupt", args });
    },
    close: async () => {},
    screen: async () => "",
  };
  return { fake, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHarnessCache();
});

describe("goose: the built-in harness file", () => {
  it("loads with no error, kind agent, with every value of the file", () => {
    const h = builtinGoose();
    expect(h).toMatchObject({
      name: "goose",
      program: "goose",
      source: "builtin",
      file: join(BUILTIN, "goose.toml"),
      kind: "agent",
      programPath: FAKE_GOOSE,
      has_prompts: true,
      history: "~/.local/share/goose/sessions",
      delivery: "notice",
    });
    expect(h.args).toEqual(["session"]);
    expect(h.skip_prompts_args).toEqual([]);
    expect(h.resume).toEqual(["--resume", "--session-id", "{id}"]);
    expect(h.fork).toEqual(["--resume", "--fork", "--session-id", "{id}"]);
    expect(h.account_env).toBeUndefined();
    expect(h.keys).toEqual({ interrupt: ["C-c"], approve: "Enter", deny: "Escape" });
    expect(h.states?.precedence).toEqual(["waiting_for_approval", "working", "idle"]);
    expect(h.hook).toBeUndefined();
    expect(h.adapter).toBeUndefined();
    expect(h.logo).toBeUndefined();
    expect(h.dialogs).toBeUndefined();
  });

  it("a goose that is a symlink to an executable named goose is kind agent", () => {
    const pkg = mkdtempSync(join(tmp, "pkg-"));
    const real = join(pkg, "goose");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const bin = mkdtempSync(join(tmp, "linkbin-"));
    symlinkSync(real, join(bin, "goose"));
    const h = builtinGoose(bin);
    expect(h.programPath).toBe(join(bin, "goose"));
    expect(h.kind).toBe("agent");
  });

  it.each([
    ["idle-src.txt", "idle"],
    ["idle-interrupted-src.txt", "idle"],
    ["idle-maybeexit-src.txt", "idle"],
    // D5: an answered approval (`◇`) left in scrollback does not block idle.
    ["idle-after-approval-src.txt", "idle"],
    ["working-src.txt", "working"],
    ["waiting_for_approval-src.txt", "waiting_for_approval"],
    ["waiting_for_approval-prompt-src.txt", "waiting_for_approval"],
  ])("%s reads %s through the built-in file", (file, state) => {
    expect(readScreen(builtinGoose(), screen(join(GSE_SCREENS, file)))).toBe(state);
  });

  it.each(["unknown-telemetry-src.txt", "unknown-noprovider-src.txt", "unknown-summarize-src.txt"])(
    "%s is neither idle nor working nor waiting_for_approval",
    (file) => {
      expect(["idle", "working", "waiting_for_approval"]).not.toContain(readScreen(builtinGoose(), screen(join(GSE_SCREENS, file))));
    },
  );

  // D1: the prompt is never anchored at column 0; any newline key letter; no greeting needed.
  it.each([
    ["no leading space", (t: string) => t],
    ["1 leading space", (t: string) => t.replace(HINT, ` ${HINT}`)],
    ["3 leading spaces", (t: string) => t.replace(HINT, `   ${HINT}`)],
    ["a `│ ` before the prompt", (t: string) => t.replace(HINT, `│ ${HINT}`)],
    ["Ctrl+K as the newline key", (t: string) => t.replace("Ctrl+J", "Ctrl+K")],
    ["a lower-case newline key (Ctrl+k)", (t: string) => t.replace("Ctrl+J", "Ctrl+k")],
    ["the greeting removed", () => `${HINT}\n`],
  ])("D1: idle-src with %s reads idle", (_label, edit) => {
    const text = screen(IDLE_SRC);
    expect(text).toContain(HINT);
    expect(readScreen(builtinGoose(), edit(text))).toBe("idle");
  });

  it("D1: a typed line (`> hello`, no hint) alone is not idle", () => {
    expect(readScreen(builtinGoose(), screen(IDLE_SRC).replace(HINT, "> hello"))).not.toBe("idle");
    expect(readScreen(builtinGoose(), "> hello\n")).not.toBe("idle");
  });

  // D2 and D5: both tool questions, the ASCII fallback, and an answered or cancelled prompt.
  const APPROVALS = [
    ["waiting_for_approval-src.txt", Q_TOOL],
    ["waiting_for_approval-prompt-src.txt", Q_PROMPT],
  ] as const;
  it.each(APPROVALS)("D2: %s with the ASCII fallback `*  ` reads waiting_for_approval", (file, q) => {
    const text = screen(join(GSE_SCREENS, file));
    expect(text).toContain(`◆  ${q}`);
    expect(readScreen(builtinGoose(), text.replace(`◆  ${q}`, `*  ${q}`))).toBe("waiting_for_approval");
    // The whole menu in cliclack's ASCII fallback (`*`, `|`, `>`, `—`).
    const ascii = text.replace(`◆  ${q}`, `*  ${q}`).replaceAll("│  ● ", "|  > ").replaceAll("│  ○ ", "|    ").replace(/^└$/m, "—");
    expect(readScreen(builtinGoose(), ascii)).toBe("waiting_for_approval");
  });

  it.each(APPROVALS)("D2/D5: %s answered (`◇  `) or cancelled (`■  `) is not waiting_for_approval", (file, q) => {
    const text = screen(join(GSE_SCREENS, file));
    for (const sym of ["◇", "■"]) {
      expect(readScreen(builtinGoose(), text.replace(`◆  ${q}`, `${sym}  ${q}`))).not.toBe("waiting_for_approval");
    }
  });

  it.each([Q_TOOL, Q_PROMPT])("menu context: `%s` in reply text, with no select row after it, is not waiting_for_approval", (q) => {
    const h = builtinGoose();
    for (const line of [q, `◆  ${q}`, `*  ${q}`, `> ${q}`]) {
      const text = `${screen(IDLE_SRC).replace(HINT, "> what does goose ask?")}It asks:\n${line}\nand then lists the choices.\n\n${HINT}\n`;
      expect(readScreen(h, text)).toBe("idle");
    }
  });

  // Audit (U-R1B-GOOSE): a REPL draws what it waits on last, so each rule ends at the screen's end.
  // A reply quoting the whole menu, the spinner hint or a prompt hint above the real bottom line
  // must not lock the owner out (approval), hold every send (working) or let an agent type into a
  // confirm (idle).
  const ASK = screen(IDLE_SRC).replace(HINT, "> what does the goose approval menu look like?");
  const MENU_TOOL = `◆  ${Q_TOOL}\n│  ● Allow (Allow the tool call once)\n│  ○ Always Allow\n│  ○ Deny\n│  ○ Cancel\n└`;
  const MENU_PROMPT = `◆  ${Q_PROMPT}\n│  ● Allow (Allow the tool call once)\n│  ○ Deny\n│  ○ Cancel\n└`;
  const MENU_ASCII = `*  ${Q_TOOL}\n|  > Allow (Allow the tool call once)\n|    Always Allow\n|    Deny\n|    Cancel\n—`;
  const CONFIRM = (q: string) => `◆  ${q}\n│  ● Yes / ○ No\n└`;
  it.each([
    ["a reply quoting the tool menu in a code block above the prompt", `${ASK}It looks like this:\n\`\`\`\n${MENU_TOOL}\n\`\`\`\n\n${HINT}\n`, "idle"],
    ["a reply quoting the prompt-tool menu above the prompt", `${ASK}${MENU_PROMPT}\n\n${HINT}\n`, "idle"],
    ["a reply quoting the ASCII menu above the prompt", `${ASK}${MENU_ASCII}\n\n${HINT}\n`, "idle"],
    ["a reply quoting the header and first row above the prompt", `${ASK}◆  ${Q_PROMPT}\n│  ● Allow\n\n${HINT}\n`, "idle"],
    ["a reply quoting `(Ctrl+C to interrupt)` above the prompt", `${ASK}It shows (Ctrl+C to interrupt) while it works.\n\n${HINT}\n`, "idle"],
    ["a quoted prompt hint above the usage-data question", `${ASK}${HINT}\n\n${screen(join(GSE_SCREENS, "unknown-telemetry-src.txt"))}`, "unknown"],
    ["a quoted prompt hint above an elicitation confirm", `${ASK}${HINT}\n\n${CONFIRM("Approve this action?")}`, "unknown"],
    ["a quoted Interrupted hint above the top-up confirm", `${ASK}> Interrupted, what should goose work on instead?\n${CONFIRM("Open the top-up URL in your browser?")}`, "unknown"],
    ["a quoted prompt hint while the spinner runs", `${ASK}${HINT}\n◐  Thinking...  (Ctrl+C to interrupt)`, "working"],
    ["a quoted menu above the real menu", `${ASK}${MENU_PROMPT}\n\n${MENU_TOOL}\n`, "waiting_for_approval"],
    ["the real menu with the cursor moved to Deny", MENU_TOOL.replace("● Allow (Allow the tool call once)", "○ Allow").replace("○ Deny", "● Deny (Deny the tool call)"), "waiting_for_approval"],
    ["a cancelled approval (`■`, Operation cancelled.) above the prompt", `${ASK}■  ${Q_TOOL}\n│  Cancel\n└  Operation cancelled.\n\n${HINT}\n`, "idle"],
    ["an answered approval while the tool runs", `${ASK}◇  ${Q_PROMPT}\n│  Allow\n│\na.txt`, "unknown"],
    ["the spinner's ASCII frame", `${ASK}O  Waddling...  (Ctrl+C to interrupt)`, "working"],
    ["a punctuation newline key (Ctrl+])", screen(IDLE_SRC).replace("Ctrl+J", "Ctrl+]"), "idle"],
  ])("audit: %s", (_label, text, state) => {
    expect(readScreen(builtinGoose(), text)).toBe(state);
  });

  it("never idle: every approval and unknown screen and every other agent's idle screen in the screens folder", () => {
    const h = builtinGoose();
    const files = readdirSync(SCREENS).filter(
      (f) => /-(?:waiting_for_approval|unknown)-[^/]*\.txt$/.test(f) || (/-idle-[^/]*\.txt$/.test(f) && !f.startsWith("goose-")),
    );
    expect(files.length).toBeGreaterThanOrEqual(26);
    expect(files.some((f) => /-idle-/.test(f))).toBe(true);
    const idle = files.filter((f) => readScreen(h, screen(join(SCREENS, f))) === "idle");
    expect(idle).toEqual([]);
  });

  // The folder list is read at run time, so the screen folders of later agents are swept too.
  const OTHER_FOLDERS = [
    "dialogs",
    ...readdirSync(FIXTURES).filter((f) => f.endsWith("-screens") && f !== "goose-screens" && statSync(join(FIXTURES, f)).isDirectory()),
  ];
  it("the swept folders include dialogs and every other *-screens folder", () => {
    expect(OTHER_FOLDERS).toContain("dialogs");
    expect(OTHER_FOLDERS).toContain("cursor-screens");
    expect(OTHER_FOLDERS).not.toContain("goose-screens");
  });
  it.each(OTHER_FOLDERS)("never idle: every file in test/fixtures/%s", (folder) => {
    const h = builtinGoose();
    const files = readdirSync(join(FIXTURES, folder)).filter((f) => isFile(join(FIXTURES, folder, f)));
    expect(files.length).toBeGreaterThan(0);
    const idle = files.filter((f) => readScreen(h, screen(join(FIXTURES, folder, f))) === "idle");
    expect(idle).toEqual([]);
  });

  it("an owner goose.toml is refused and the built-in stays", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const owner = join(home, "harnesses");
    mkdirSync(owner);
    chmodSync(owner, 0o700);
    writeFileSync(join(owner, "goose.toml"), 'name = "goose"\nprogram = "/usr/bin/true"\nhas_prompts = false\n', { mode: 0o600 });
    const res = loadHarnesses({ installDir: BUILTIN, ownerDir: owner, path: BIN });
    expect(res.errors).toContainEqual({
      file: join(owner, "goose.toml"),
      reason: "built-in name: an owner file cannot replace a built-in",
    });
    expect(res.harnesses.get("goose")?.source).toBe("builtin");

    vi.stubEnv("TANDEM_HOME", home);
    vi.stubEnv("PATH", BIN);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    resetHarnessCache();
    const loaded = loadedHarnesses().get("goose");
    expect(loaded?.source).toBe("builtin");
    expect(loaded?.file).toBe(join(BUILTIN, "goose.toml"));
  });

  it("disabled gives EngineDisabledError; enabled with a goose on PATH gives the harness; enabled with none gives EngineUnavailableError", async () => {
    vi.stubEnv("TANDEM_HOME", join(tmp, "empty-home"));
    vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
    vi.stubEnv("TANDEM_ENABLED_ENGINES", undefined);
    resetHarnessCache();
    await expect(resolveEngine("goose")).rejects.toThrow(EngineDisabledError);

    vi.stubEnv("TANDEM_ENABLED_ENGINES", "goose");
    resetHarnessCache();
    const r = await resolveEngine("goose");
    expect(r.id).toBe("goose");
    expect(r.harness?.source).toBe("builtin");
    expect(r.harness?.file).toBe(join(BUILTIN, "goose.toml"));
    expect(r.harness?.programPath).toBe(FAKE_GOOSE);

    vi.stubEnv("PATH", `${mkdtempSync(join(tmp, "empty-bin-"))}:/usr/bin:/bin`);
    resetHarnessCache();
    await expect(resolveEngine("goose")).rejects.toThrow(EngineUnavailableError);
    await expect(resolveEngine("goose")).rejects.toThrow(/"goose"/);
  });

  it("GET /sessions?engine=goose is 200 and every row is engine goose", async () => {
    const res = await routeForTest("GET", "/sessions", {}, "engine=goose");
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions?: { engine?: string }[] }).sessions ?? [];
    expect(sessions.every((s) => s.engine === "goose")).toBe(true);
  });
});

describe("goose: spawn (injected spawn function)", () => {
  async function spawned(opts: Partial<SpawnOptions> & { skipPrompts?: boolean }): Promise<string[]> {
    const seen: SpawnOptions[] = [];
    await HarnessSession.spawn(builtinGoose(), { name: "r1bgse-spawn", cwd: "/tmp/work", allowlist: ["/tmp"], ...opts }, async (o) => {
      seen.push(o);
      return fakeTerminal().fake;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.descriptor?.id).toBe("goose");
    return spawnArgv(seen[0]!.descriptor!, seen[0]!);
  }

  it("argv is exactly /usr/bin/env -- <programPath> session, also with TANDEM_ALLOW_BYPASS=1 and with skipPrompts (no skip flag)", async () => {
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GOOSE, "session"]);
    vi.stubEnv("TANDEM_ALLOW_BYPASS", "1");
    expect(await spawned({})).toEqual(["/usr/bin/env", "--", FAKE_GOOSE, "session"]);
    expect(await spawned({ skipPrompts: true })).toEqual(["/usr/bin/env", "--", FAKE_GOOSE, "session"]);
  });

  it.each([[{ model: "opus" }], [{ effort: "high" }], [{ allowBypass: true }], [{ allowBypass: false }]])(
    "%j throws before the spawn function is called",
    async (bad) => {
      let called = 0;
      await expect(
        HarnessSession.spawn(builtinGoose(), { name: "r1bgse-bad", cwd: "/tmp/work", allowlist: ["/tmp"], ...bad }, async () => {
          called += 1;
          return fakeTerminal().fake;
        }),
      ).rejects.toThrow(/Claude-only/);
      expect(called).toBe(0);
    },
  );

  it("interrupt hands exactly one C-c (the file's keys.interrupt)", async () => {
    const { fake, calls } = fakeTerminal();
    const session = new HarnessSession(builtinGoose(), fake);
    expect(session.engine).toBe("goose");
    await session.interrupt();
    expect(calls).toEqual([{ method: "interrupt", args: [["C-c"]] }]);
  });
});

describe("goose: a fake goose in tmux on Tandem's own socket", () => {
  it("spawns ready; a send of r1bgse-ok ends done with it in the report; a read gives idle; close", async () => {
    const name = `r1bgse-goose-${Math.random().toString(36).slice(2, 8)}`;
    const session = await HarnessSession.spawn(builtinGoose(), { name, cwd: WORK, allowlist: [WORK] }, (o) =>
      TerminalSession.spawn({ ...o, ownerIdProvider: async () => "r1bgse-owner" }),
    );
    try {
      expect(session.engine).toBe("goose");
      expect(session.ready).toBe(true);
      expect(session.readinessWarning).toBeUndefined();

      const sent = await session.send("r1bgse-ok");
      expect(sent.status).toBe("done");
      expect(sent.report).toContain("r1bgse-ok");

      // idle is debounced, so it can take a few reads.
      const deadline = Date.now() + 10_000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        state = (await session.read({ cursor: sent.cursor })).agentState;
        if (state === "idle") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(state).toBe("idle");
    } finally {
      await session.close();
    }
    expect(await session.isAlive()).toBe(false);
  }, 60_000);
});
