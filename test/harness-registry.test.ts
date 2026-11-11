import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses, type Harness } from "../bridge/harness-registry.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/harnesses/", import.meta.url));
const temps: string[] = [];

/** A temp folder with empty built-in, owner (0700) and bin folders. */
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "harness-"));
  temps.push(tmp);
  const builtin = join(tmp, "builtin");
  const owner = join(tmp, "owner");
  const bin = join(tmp, "bin");
  for (const d of [builtin, owner, bin]) mkdirSync(d);
  chmodSync(owner, 0o700);
  const put = (dir: string, fixture: string, as = fixture) =>
    writeFileSync(join(dir, as), readFileSync(join(FIXTURES, fixture), "utf8").replaceAll("@TMP@", tmp));
  const text = (name: string, extra = "") =>
    `name = "${name}"\nprogram = "agent"\nhas_prompts = false\n${extra}`;
  return { tmp, builtin, owner, bin, put, text };
}

function cleanup() {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
}

const onPath = (prog: string) =>
  (process.env.PATH ?? "").split(":").some((d) => d !== "" && existsSync(join(d, prog)));

const BASE = { args: [], skip_prompts_args: [], resume: [], fork: [], delivery: "notice", permission_hook: false, reports_context: false };

describe("loadHarnesses: one load over every fixture", () => {
  let s: ReturnType<typeof setup>;
  let res: ReturnType<typeof loadHarnesses>;

  // [file, folder, expected reason] - each file is refused for this one reason.
  const REFUSED: [string, "builtin" | "owner", RegExp][] = [
    ["bad-name-mismatch.toml", "owner", /does not match the file name/],
    ["Bad_Name.toml", "owner", /bad file name/],
    ["bad-unknown-field.toml", "owner", /unknown field color/],
    ["bad-unknown-subfield.toml", "owner", /unknown field states\.workin/],
    ["bad-wrong-type.toml", "owner", /wrong type for args/],
    ["bad-missing-has-prompts.toml", "owner", /missing has_prompts/],
    ["bad-program.toml", "owner", /bad program/],
    ["bad-program-relative.toml", "owner", /bad program/],
    ["bad-account-env.toml", "owner", /bad account_env/],
    ["bad-history.toml", "owner", /bad history/],
    ["bad-debounce.toml", "owner", /bad states\.debounce_ms/],
    ["bad-precedence.toml", "owner", /bad states\.precedence/],
    ["bad-pattern.toml", "owner", /bad pattern in states\.working/],
    ["bad-key-newline.toml", "owner", /bad key in keys\.approve/],
    ["bad-key-word.toml", "owner", /bad key in keys\.approve/],
    ["bad-keys-five.toml", "owner", /keys\.approve: at most 4 keys/],
    ["bad-delivery.toml", "owner", /bad delivery/],
    ["bad-delivery-hook.toml", "owner", /delivery = "hook" needs hook/],
    ["bad-adapter-owner.toml", "owner", /adapter is allowed only in a built-in file/],
    ["bad-adapter-other.toml", "builtin", /bad adapter/],
    ["bad-logo.toml", "owner", /bad logo/],
    ["bad-args-newline.toml", "owner", /forbidden character in args/],
    ["bad-args-nul.toml", "owner", /forbidden character in args/],
    ["bad-args-backtick.toml", "owner", /forbidden character in args/],
    ["bad-args-dollar.toml", "owner", /forbidden character in args/],
    ["bad-args-semicolon.toml", "owner", /forbidden character in args/],
    ["bad-args-pipe.toml", "owner", /forbidden character in args/],
    ["bad-args-amp.toml", "owner", /forbidden character in args/],
    ["bad-args-lt.toml", "owner", /forbidden character in args/],
    ["bad-args-gt.toml", "owner", /forbidden character in args/],
    ["bad-args-brace-open.toml", "owner", /forbidden character in args/],
    ["bad-args-brace-close.toml", "owner", /forbidden character in args/],
    ["bad-history-subst.toml", "owner", /forbidden character in history/],
    ["bad-resume-placeholder.toml", "owner", /forbidden character in resume/],
    ["bad-toml-syntax.toml", "owner", /TOML syntax error/],
    ["big.toml", "owner", /over 64 KiB/],
    ["linked.toml", "owner", /symlink/],
    ["x.toml", "owner", /not a regular file/],
    ["dup-a.toml", "owner", /duplicate owner name/],
    ["dup-b.toml", "owner", /duplicate owner name/],
    ["claude.toml", "owner", /built-in name/],
    // review-fix rows (U-R1A-08-R1): a program string tmux or sh -c would read as something else.
    ["bad-program-space.toml", "owner", /bad program/],
    ["bad-program-glob.toml", "owner", /bad program/],
    ["bad-program-quote.toml", "owner", /bad program/],
    ["bad-program-backslash.toml", "owner", /bad program/],
    ["bad-program-dash.toml", "owner", /bad program/],
    // review-fix rows: control and hidden characters beyond C0.
    ["bad-args-c1.toml", "owner", /forbidden character in args/],
    ["bad-args-line-separator.toml", "owner", /forbidden character in args/],
    ["bad-args-bidi.toml", "owner", /forbidden character in args/],
    // TOML tricks and look-alike names (guard rows).
    ["bad-toml-duplicate-key.toml", "owner", /TOML syntax error/],
    ["bad-proto.toml", "owner", /unknown field __proto__/],
    ["bad-keys-unknown.toml", "owner", /unknown field keys\.submit/],
    ["Pi.toml", "owner", /bad file name/],
    ["\u0440i.toml", "owner", /bad file name/],
    // review-fix rows: an owner file writable by group or others.
    ["group-writable.toml", "owner", /writable by group or others/],
    ["world-writable.toml", "owner", /writable by group or others/],
  ];

  const LOADED: [string, "builtin" | "owner", "agent" | "shell"][] = [
    ["pi", "builtin", "agent"],
    ["claude", "builtin", "agent"],
    ["opencode", "owner", "agent"],
    ["fake-agent", "owner", "agent"],
    ["agentx", "owner", "agent"],
    ["states-defaults", "owner", "agent"],
    ["bash", "owner", "shell"],
    ["python", "owner", "shell"],
    ["env", "owner", "shell"],
    ["runs-nothing", "owner", "shell"],
    ["agentlink", "owner", "shell"],
  ];

  beforeAll(() => {
    s = setup();
    const { tmp, builtin, owner, bin, put, text } = s;
    for (const f of ["pi.toml", "claude.toml", "bad-adapter-other.toml"]) put(builtin, f);
    for (const f of ["opencode.toml", "fake-agent.toml", "bash.toml", "python.toml", "env.toml", "runs-nothing.toml"])
      put(owner, f);
    put(owner, "claude-impostor.toml", "claude.toml");
    for (const [f, dir] of REFUSED) if (f.startsWith("bad-")) put(dir === "builtin" ? builtin : owner, f);
    // Built at run time: file names, symlinks, size, FIFO, duplicates, subfolder, programs.
    writeFileSync(join(owner, "Bad_Name.toml"), text("bad-name"));
    writeFileSync(join(owner, "Pi.toml"), text("Pi"));
    writeFileSync(join(owner, "\u0440i.toml"), text("\u0440i"));
    writeFileSync(join(owner, "group-writable.toml"), text("group-writable"));
    chmodSync(join(owner, "group-writable.toml"), 0o664);
    writeFileSync(join(owner, "world-writable.toml"), text("world-writable"));
    chmodSync(join(owner, "world-writable.toml"), 0o646);
    writeFileSync(join(owner, "big.toml"), text("big", `# ${"x".repeat(70_000)}\n`));
    writeFileSync(join(tmp, "elsewhere.toml"), text("linked"));
    symlinkSync(join(tmp, "elsewhere.toml"), join(owner, "linked.toml"));
    execFileSync("mkfifo", [join(owner, "x.toml")]);
    writeFileSync(join(owner, "dup-a.toml"), text("dup-a"));
    writeFileSync(join(owner, "dup-b.toml"), text("dup-a"));
    mkdirSync(join(owner, "sub"));
    writeFileSync(join(owner, "sub", "hidden.toml"), text("hidden"));
    writeFileSync(join(owner, "notes.txt"), "not a harness");
    writeFileSync(join(owner, "states-defaults.toml"), text("states-defaults", "\n[states]\nidle = ['^> $']\n"));
    writeFileSync(join(bin, "agentx"), "#!/usr/bin/env node\nconsole.log('agentx')\n", { mode: 0o755 });
    writeFileSync(join(owner, "agentx.toml"), 'name = "agentx"\nprogram = "agentx"\nhas_prompts = true\n');
    symlinkSync("/bin/sh", join(bin, "agentlink"));
    writeFileSync(join(owner, "agentlink.toml"), `name = "agentlink"\nprogram = "${join(bin, "agentlink")}"\nhas_prompts = true\n`);
    res = loadHarnesses({ installDir: builtin, ownerDir: owner, path: bin });
  });
  afterAll(cleanup);

  it.each(REFUSED)("refuses %s (%s folder): %s", (file, dir, reason) => {
    const path = join(dir === "builtin" ? s.builtin : s.owner, file);
    const hits = res.errors.filter((e) => e.file === path);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(reason);
    expect([...res.harnesses.values()].some((h) => h.file === path)).toBe(false);
  });

  it.each(LOADED)("loads %s from the %s folder as %s", (name, source, kind) => {
    const h = res.harnesses.get(name);
    expect(h?.source).toBe(source);
    expect(h?.kind).toBe(kind);
  });

  it("refuses exactly the listed files and loads exactly the listed names; a bad file never stops the others", () => {
    expect(res.errors.map((e) => basename(e.file)).sort()).toEqual(REFUSED.map((r) => r[0]).sort());
    expect([...res.harnesses.keys()].sort()).toEqual(LOADED.map((l) => l[0]).sort());
  });

  it("pi, opencode and fake-agent keep every value as written, with defaults filled and absent fields unset", () => {
    expect(res.harnesses.get("pi")).toStrictEqual({
      ...BASE, name: "pi", program: "pi", has_prompts: false,
      resume: ["--session", "{id}"], fork: ["--fork", "{id}"],
      source: "builtin", file: join(s.builtin, "pi.toml"), kind: "agent",
    });
    expect(res.harnesses.get("opencode")).toStrictEqual({
      ...BASE, name: "opencode", program: "opencode", has_prompts: true,
      skip_prompts_args: ["--auto"], resume: ["--session", "{id}"],
      source: "owner", file: join(s.owner, "opencode.toml"), kind: "agent",
    });
    expect(res.harnesses.get("fake-agent")).toStrictEqual({
      name: "fake-agent", program: "fake-agent", args: ["--color", "never"], skip_prompts_args: ["--yes"],
      resume: ["--resume", "{id}"], fork: ["--fork-from", "{id}"], has_prompts: true,
      account_env: "FAKE_AGENT_HOME", history: "~/.fake-agent/history.jsonl",
      states: {
        working: ["esc to interrupt", "Thinking"], idle: ["^> $"], waiting_for_approval: ["Allow (this|once)\\?"],
        debounce_ms: 800, precedence: ["working", "waiting_for_approval", "idle"],
      },
      keys: { approve: "y", deny: ["Escape", "n"], interrupt: ["C-c", "C-c"] },
      delivery: "hook", hook: "fake-agent-notify --quiet", permission_hook: true, reports_context: true,
      logo: "fake-agent.svg", source: "owner", file: join(s.owner, "fake-agent.toml"), kind: "agent",
    });
  });

  it("a present states table gets debounce_ms 1500 and the default precedence", () => {
    expect(res.harnesses.get("states-defaults")?.states).toStrictEqual({
      idle: ["^> $"], debounce_ms: 1500, precedence: ["waiting_for_approval", "working", "idle"],
    });
  });

  it("the built-in claude stays when an owner claude.toml (program /bin/sh) sits beside it", () => {
    const h = res.harnesses.get("claude") as Harness;
    expect(h.source).toBe("builtin");
    expect(h.program).toBe("claude");
    expect(h.file).toBe(join(s.builtin, "claude.toml"));
  });

  it("programPath: PATH lookup with fs, absolute path kept, not found stays unset", () => {
    expect(res.harnesses.get("agentx")?.programPath).toBe(join(s.bin, "agentx"));
    expect(res.harnesses.get("agentlink")?.programPath).toBe(join(s.bin, "agentlink"));
    expect(res.harnesses.get("bash")?.programPath).toBeUndefined();
    expect(res.harnesses.get("env")?.programPath).toBe("/usr/bin/env");
  });

  it("a .toml in an owner subfolder is not read, and other files are ignored", () => {
    expect(res.harnesses.has("hidden")).toBe(false);
    expect(res.errors.some((e) => e.file.includes(join(s.owner, "sub")) || e.file.endsWith("notes.txt"))).toBe(false);
  });

  it("loading runs nothing: runs-nothing loads and @TMP@/ran does not exist", () => {
    expect(res.harnesses.get("runs-nothing")?.args).toEqual(["-c", `touch ${s.tmp}/ran`]);
    expect(existsSync(join(s.tmp, "ran"))).toBe(false);
  });
});

describe("loadHarnesses: owner folder rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it.each([0o755, 0o770, 0o707])("owner folder mode %o: no owner file loads, one error", (mode) => {
    const { builtin, owner, bin, put } = setup();
    put(builtin, "claude.toml");
    put(owner, "pi.toml");
    chmodSync(owner, mode);
    const res = loadHarnesses({ installDir: builtin, ownerDir: owner, path: bin });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ file: owner, reason: expect.stringMatching(/mode 0700/) });
    expect([...res.harnesses.keys()]).toEqual(["claude"]);
  });

  it.skipIf(process.getuid?.() !== 0)("owner folder owned by another user: no owner file loads, one error", () => {
    const { builtin, owner, bin, put } = setup();
    put(owner, "pi.toml");
    chownSync(owner, 65534, 65534);
    const res = loadHarnesses({ installDir: builtin, ownerDir: owner, path: bin });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ file: owner, reason: expect.stringMatching(/not owned by the current user/) });
    expect(res.harnesses.size).toBe(0);
  });

  it.skipIf(process.getuid?.() !== 0)("owner file owned by another user: refused, the others load", () => {
    const { builtin, owner, bin, put } = setup();
    put(owner, "pi.toml");
    put(owner, "opencode.toml");
    chownSync(join(owner, "pi.toml"), 65534, 65534);
    const res = loadHarnesses({ installDir: builtin, ownerDir: owner, path: bin });
    expect(res.errors).toEqual([{ file: join(owner, "pi.toml"), reason: expect.stringMatching(/owner file is not owned by the current user/) }]);
    expect([...res.harnesses.keys()]).toEqual(["opencode"]);
  });

  it("a missing owner folder means no owner files and no error", () => {
    const { tmp, builtin, bin, put } = setup();
    put(builtin, "pi.toml");
    const res = loadHarnesses({ installDir: builtin, ownerDir: join(tmp, "missing"), path: bin });
    expect(res.errors).toEqual([]);
    expect([...res.harnesses.keys()]).toEqual(["pi"]);
  });

  it("defaults: core harnesses/ folder (only *.toml read) and $TANDEM_HOME/harnesses", () => {
    const { tmp, bin, put } = setup();
    const ownerDir = join(tmp, "home", "harnesses");
    mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    chmodSync(ownerDir, 0o700);
    put(ownerDir, "fake-agent.toml");
    vi.stubEnv("TANDEM_HOME", join(tmp, "home"));
    const res = loadHarnesses({ path: bin });
    expect(res.errors).toEqual([]);
    expect(res.harnesses.get("fake-agent")?.source).toBe("owner");
  });

  it.skipIf(!onPath("pi") || !onPath("opencode"))("mini: with the real PATH, pi and opencode are agents", () => {
    const { tmp, builtin, put } = setup();
    put(builtin, "pi.toml");
    put(builtin, "opencode.toml");
    const res = loadHarnesses({ installDir: builtin, ownerDir: join(tmp, "missing") });
    expect(res.errors).toEqual([]);
    const which = (prog: string) => execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", prog], { encoding: "utf8" }).trim();
    expect(res.harnesses.get("pi")).toMatchObject({ kind: "agent", programPath: which("pi") });
    expect(res.harnesses.get("opencode")).toMatchObject({ kind: "agent", programPath: which("opencode") });
  });
});

describe("loadHarnesses: reserved names (the session list filter reads all and terminal)", () => {
  afterEach(cleanup);

  it.each([
    ["owner", "all"],
    ["owner", "terminal"],
    ["builtin", "terminal"],
    ["builtin", "all"],
  ] as const)("a %s %s.toml is refused with reserved name", (folder, name) => {
    const s = setup();
    const dir = folder === "owner" ? s.owner : s.builtin;
    writeFileSync(join(dir, `${name}.toml`), s.text(name), { mode: 0o600 });
    const res = loadHarnesses({ installDir: s.builtin, ownerDir: s.owner, path: s.bin });
    expect(res.errors).toEqual([{ file: join(dir, `${name}.toml`), reason: expect.stringMatching(/reserved name/) }]);
    expect(res.harnesses.size).toBe(0);
  });
});
