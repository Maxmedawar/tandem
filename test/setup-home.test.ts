import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const LIVE = process.env.TANDEM_LIVE === "1";
const SETUP = new URL("./setup-home.ts", import.meta.url).href;

// Load the setup file in a fresh node with TANDEM_HOME=value (TANDEM_LIVE=1: no temp HOME made)
// and return what TANDEM_HOME is left as. Nothing is written under value; it is only stat-ed.
function afterSetup(value: string): string | null {
  const script = `await import(${JSON.stringify(SETUP)}); process.stdout.write(JSON.stringify(process.env.TANDEM_HOME ?? null));`;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: { ...process.env, TANDEM_LIVE: "1", TANDEM_HOME: value },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`setup probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// test/setup-home.ts (vitest setupFiles) must keep every root test away from the real
// user's home and the live Tandem install, whatever environment the suite starts from.
describe("test setup isolates HOME and TANDEM_HOME", () => {
  // Live tests (TANDEM_LIVE=1) keep the starting HOME by design; every other run gets a fresh one.
  it("HOME is a fresh tandem-test-home- dir under the tmpdir() from before the setup (TMPDIR moved since), unless TANDEM_LIVE=1", () => {
    const fresh = dirname(homedir()) === dirname(process.env.TMUX_TMPDIR ?? "") && realpathSync(dirname(homedir())) !== realpathSync(tmpdir()) && basename(homedir()).startsWith("tandem-test-home-");
    expect(fresh, `HOME=${homedir()} TANDEM_LIVE=${LIVE}`).toBe(!LIVE);
    if (!LIVE) expect(homedir()).not.toBe(userInfo().homedir);
    expect(statSync(homedir()).isDirectory()).toBe(true);
  });

  // CCM_* can name the live fabric database and the live hub with its token: none is inherited,
  // live mode included. Only the names are compared, never a value.
  it("no inherited CCM_ variable is left", () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith("CCM_"))).toEqual([]);
  });

  it("TANDEM_HOME is unset or outside the real home", () => {
    const th = process.env.TANDEM_HOME;
    if (th === undefined) return;
    const rel = relative(resolve(userInfo().homedir), resolve(th));
    const inside = rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
    expect(inside, `TANDEM_HOME=${th}`).toBe(false);
  });
});

// U-R1A-16: every inherited TANDEM_HERMES_* and the four TANDEM_* path variables are dropped,
// live mode included, and TANDEM_HERMES_DISABLE_LIVE is set to 1. Names are compared, values never
// printed: the probe reports only which names are left and whether the flag reads 1.
const DROPPED = [
  "TANDEM_HERMES_BASE_URL",
  "TANDEM_HERMES_WRITABLE_AGENTS",
  "TANDEM_HERMES_PASSWORD_PATH",
  "TANDEM_CONFIG_FILE",
  "TANDEM_DEVICE_READY_FILE",
  "TANDEM_OWNER_PASSWORD_FILE",
  "TANDEM_ENROLLMENT_STATE_DIR",
];
const leftOf = (env: NodeJS.ProcessEnv) => ({
  left: DROPPED.filter((k) => k in env),
  disableLive: env.TANDEM_HERMES_DISABLE_LIVE === "1",
});

describe("inherited Hermes and Tandem path variables are dropped (U-R1A-16)", () => {
  const dummy = mkdtempSync("/tmp/r1a16-setup-"); // only named in the dummy values, never written
  afterAll(() => rmSync(dummy, { recursive: true, force: true }));

  it("a fresh node started with all seven set (and the flag 0) keeps none and reads the flag as 1", () => {
    const script = `await import(${JSON.stringify(SETUP)}); const env = process.env; process.stdout.write(JSON.stringify({ left: ${JSON.stringify(DROPPED)}.filter((k) => k in env), disableLive: env.TANDEM_HERMES_DISABLE_LIVE === "1" }));`;
    const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_LIVE: "1", TANDEM_HERMES_DISABLE_LIVE: "0" };
    for (const k of DROPPED) env[k] = join(dummy, k.toLowerCase());
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, encoding: "utf8" });
    expect(r.status, "setup probe exit").toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ left: [], disableLive: true });
  });

  it("the same holds in this process", () => {
    expect(leftOf(process.env)).toEqual({ left: [], disableLive: true });
  });
});

describe("a TANDEM_HOME inside the real home is dropped, however it is spelled", () => {
  const home = userInfo().homedir;
  const absent = `.tandem-setup-home-probe-${process.pid}`; // never created
  const box = mkdtempSync(join(tmpdir(), "setup-home-link-"));
  const link = join(box, "home-link");
  beforeAll(() => symlinkSync(home, link, "junction")); // a link to the real home; nothing goes through it
  afterAll(() => unlinkSync(link));
  const swapCase = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

  const cases: [string, string, boolean][] = [
    ["the real home itself", home, true],
    ["an absent dir in the real home", join(home, absent), true],
    ["an absent dir reached through a symlink to the real home", join(link, absent), true],
    ["a dir outside the real home (kept)", join(box, "tandem"), false],
  ];
  if (process.platform === "darwin" || process.platform === "win32") {
    cases.push(["an absent dir in the real home spelled in another letter case", join(swapCase(home), absent), true]);
  }
  it.each(cases)("%s", (_name, value, dropped) => {
    expect(afterSetup(value)).toBe(dropped ? null : value);
  });
});

// TANDEM-B-TESTHOME-T2: the setup removes the temp HOME, the tmux folder and the short TMPDIR it made
// when the test file ends and at process exit; nothing in live mode, nothing it did not make.
// Each probe is a fresh node that imports the setup on a crafted env (no VITEST) and prints only the
// three folders the setup made, lengths and true/false; every other folder a case makes is under its
// own rtt2- folder, removed in afterAll.
describe("the setup removes what it made (TANDEM-B-TESTHOME-T2)", () => {
  const uid = process.getuid?.() ?? "user";
  const SHORT = realpathSync(process.platform === "darwin" ? "/private/tmp" : "/tmp");
  const boxes: string[] = [];
  const box = () => {
    const b = mkdtempSync(join(tmpdir(), "rtt2-"));
    boxes.push(b);
    return b;
  };
  const openUp = (d: string): void => {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return;
    chmodSync(d, 0o700);
    for (const n of readdirSync(d)) openUp(join(d, n));
  };
  afterAll(() => {
    for (const b of boxes) {
      openUp(b);
      rmSync(b, { recursive: true, force: true });
    }
  });
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  const canon = (p: string): string => {
    let head = resolve(p);
    let tail = "";
    while (!existsSync(head) && dirname(head) !== head) {
      tail = join(basename(head), tail);
      head = dirname(head);
    }
    const r = join(realpathSync(head), tail);
    return foldCase ? r.toLowerCase() : r;
  };
  const inside = (child: string, parent: string) => {
    const rel = relative(canon(parent), canon(child));
    return rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
  };
  const gone = (p: string | undefined) => !!p && lstatSync(p, { throwIfNoEntry: false }) === undefined;
  const tmuxNames = (names: string[]) => names.filter((k) => /^TMUX(_|$)/.test(k) && k !== "TMUX_TMPDIR");
  // a listening unix socket at path S that stays in place while the exit handlers run
  const listen = (s: string) =>
    `{ const sv = (await import("node:net")).createServer(); await new Promise((res, rej) => { sv.on("error", rej); sv.listen(${s}, () => { sv.unref(); res(); }); }); }`;

  type Out = { HOME?: string; TMUX_TMPDIR?: string; TMPDIR?: string; homeIsDir: boolean; tmuxIsDir: boolean; tmpIsDir: boolean; tmuxMode: number; tmuxLeft: string[]; P: Record<string, unknown> };
  // `extra` runs after the setup with fs = node:fs, H = its HOME and P = an object printed with the report.
  function probe(env: Record<string, string>, extra = "", cwd?: string) {
    const script = [
      'const fs = await import("node:fs");',
      "const P = {};",
      "await import(process.argv[1]);",
      "const H = process.env.HOME;",
      extra,
      "const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } };",
      "const e = process.env;",
      "let tmuxMode = 0; try { tmuxMode = fs.statSync(e.TMUX_TMPDIR).mode & 0o777 } catch {}",
      "process.stdout.write(JSON.stringify({ HOME: e.HOME, TMUX_TMPDIR: e.TMUX_TMPDIR, TMPDIR: e.TMPDIR, homeIsDir: isDir(e.HOME), tmuxIsDir: isDir(e.TMUX_TMPDIR), tmpIsDir: isDir(e.TMPDIR), tmuxMode, tmuxLeft: Object.keys(e).filter((k) => /^TMUX(_|$)/.test(k) && k !== 'TMUX_TMPDIR'), P }));",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, SETUP_URL], {
      env: { PATH: process.env.PATH ?? "", ...env },
      cwd,
      encoding: "utf8",
    });
    const out: Out = r.status === 0 ? JSON.parse(r.stdout) : { homeIsDir: false, tmuxIsDir: false, tmpIsDir: false, tmuxMode: 0, tmuxLeft: [], P: {} };
    return { status: r.status, stderr: r.stderr, out };
  }
  const SETUP_URL = new URL("./setup-home.ts", import.meta.url).href;

  it("(a) a non-live child leaves no HOME, no tmux folder and no stt- folder behind", () => {
    const b = box();
    const r = probe({ TMPDIR: b }, 'fs.mkdtempSync((await import("node:os")).tmpdir() + "/a-test-tmp-");');
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(r.out.homeIsDir && r.out.tmuxIsDir && r.out.tmpIsDir, "HOME, tmux folder and TMPDIR existed in the child").toBe(true);
    expect(gone(r.out.HOME), "HOME left after exit").toBe(true);
    expect(gone(r.out.TMUX_TMPDIR), "tmux folder left after exit").toBe(true);
    expect(gone(r.out.TMPDIR), "stt- folder left after exit").toBe(true);
    expect(readdirSync(b), "folders left in the probe's tmpdir").toEqual([]);
  });

  it("(b) files, nested folders, a 0500 folder and a 0400 file inside the temp HOME are all removed", () => {
    const extra = [
      'fs.writeFileSync(H + "/a.txt", "x");',
      'fs.mkdirSync(H + "/n/d/e", { recursive: true }); fs.writeFileSync(H + "/n/d/e/f", "y");',
      'fs.mkdirSync(H + "/ro"); fs.writeFileSync(H + "/ro/f", "z"); fs.chmodSync(H + "/ro/f", 0o400); fs.chmodSync(H + "/ro", 0o500);',
    ].join("\n");
    const r = probe({ TMPDIR: box() }, extra);
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(r.out.homeIsDir, "HOME existed in the child").toBe(true);
    expect(gone(r.out.HOME), "HOME left after exit").toBe(true);
  });

  it("(c) a symlink inside HOME to a file and to a folder outside: the links go, both targets and their bytes stay", () => {
    const b = box();
    const file = join(b, "target-file");
    writeFileSync(file, "file-bytes");
    chmodSync(file, 0o400);
    const dir = join(b, "target-dir");
    mkdirSync(dir);
    writeFileSync(join(dir, "inner"), "inner-bytes");
    const dirMode = statSync(dir).mode;
    const r = probe({ TMPDIR: b }, `fs.symlinkSync(${JSON.stringify(file)}, H + "/file-link"); fs.symlinkSync(${JSON.stringify(dir)}, H + "/dir-link");`);
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(gone(r.out.HOME), "HOME left after exit").toBe(true);
    expect(readFileSync(file, "utf8"), "file target bytes").toBe("file-bytes");
    expect(statSync(file).mode & 0o777, "file target mode").toBe(0o400);
    expect(readFileSync(join(dir, "inner"), "utf8"), "folder target bytes").toBe("inner-bytes");
    expect(statSync(dir).mode, "folder target mode").toBe(dirMode);
  });

  it("(d) TANDEM_LIVE=1: HOME, TMPDIR and a kept TMUX_TMPDIR are the inherited ones and stay; a made tmux folder stays too", () => {
    const b = box();
    const liveHome = join(b, "live-home");
    mkdirSync(liveHome);
    writeFileSync(join(liveHome, "keep"), "k");
    const own = join(b, "own-tmux");
    mkdirSync(own, { mode: 0o700 });
    const r = probe({ TANDEM_LIVE: "1", HOME: liveHome, TMPDIR: b, TMUX_TMPDIR: own });
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(r.out.HOME === liveHome && r.out.TMPDIR === b && r.out.TMUX_TMPDIR === own, "live HOME, TMPDIR and TMUX_TMPDIR kept").toBe(true);
    expect(existsSync(join(liveHome, "keep")) && existsSync(own) && existsSync(b), "live folders still there").toBe(true);
    const m = probe({ TANDEM_LIVE: "1", HOME: liveHome, TMPDIR: b });
    expect(m.status, `setup exit ${m.stderr}`).toBe(0);
    expect(!!m.out.TMUX_TMPDIR && basename(m.out.TMUX_TMPDIR).startsWith("tandem-test-tmux-"), "live run made a tmux folder").toBe(true);
    expect(existsSync(m.out.TMUX_TMPDIR!), "a live run's made tmux folder stays").toBe(true);
  });

  it("(e) tmux: TMUX, TMUX_PANE and TMUX_FOO dropped; non-live always a fresh folder; live replaces /tmp and a missing one", () => {
    const b = box();
    const own = join(b, "own-tmux");
    mkdirSync(own, { mode: 0o700 });
    writeFileSync(join(own, "keep"), "k");
    const inherited = { TMUX: `/tmp/tmux-${uid}/default,1,0`, TMUX_PANE: "%1", TMUX_FOO: "x" };
    for (const live of [{}, { TANDEM_LIVE: "1" }] as Record<string, string>[]) {
      const r = probe({ TMPDIR: b, HOME: b, ...live, ...inherited, TMUX_TMPDIR: own });
      expect(r.status, `setup exit ${r.stderr}`).toBe(0);
      expect(r.out.tmuxLeft, "TMUX names left").toEqual([]);
    }
    const n = probe({ TMPDIR: b, TMUX_TMPDIR: own });
    expect(n.status, `setup exit ${n.stderr}`).toBe(0);
    expect(n.out.TMUX_TMPDIR !== own && basename(n.out.TMUX_TMPDIR ?? "").startsWith("tandem-test-tmux-"), "non-live: a fresh tmux folder, never the inherited one").toBe(true);
    expect(n.out.tmuxMode, "fresh tmux folder mode").toBe(0o700);
    expect(readFileSync(join(own, "keep"), "utf8"), "inherited tmux folder untouched").toBe("k");
    for (const bad of ["/tmp", join(b, "missing")]) {
      const l = probe({ TANDEM_LIVE: "1", HOME: b, TMPDIR: b, TMUX_TMPDIR: bad });
      expect(l.status, `setup exit ${l.stderr}`).toBe(0);
      expect(basename(l.out.TMUX_TMPDIR ?? "").startsWith("tandem-test-tmux-") && l.out.tmuxIsDir, `live: fresh tmux folder for ${bad === "/tmp" ? "/tmp" : "a missing folder"}`).toBe(true);
    }
  });

  function fakeTmux(b: string) {
    const bin = join(b, "fake-bin");
    mkdirSync(bin);
    const log = join(bin, "calls.log");
    writeFileSync(log, "");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "TMUX=\${TMUX+set} $*" >> '${log}'\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
  }
  const plant = [
    'const TS = process.env.TMUX_TMPDIR + "/tmux-" + process.getuid(); fs.mkdirSync(TS, { recursive: true, mode: 0o700 });',
    listen('TS + "/default"'),
    'fs.mkdirSync(H + "/.tandem/tmux", { recursive: true });',
    listen('H + "/.tandem/tmux/tandem"'),
  ].join("\n");

  it("(f) tmux kill-server only as -S <made tmux folder>/tmux-<uid>/default and -S <made HOME>/.tandem/tmux/tandem, TMUX unset", () => {
    const b = box();
    const t = fakeTmux(b);
    const r = probe({ TMPDIR: b, PATH: t.PATH, TMUX: `/tmp/tmux-${uid}/default,1,0` }, plant);
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(t.calls().sort(), "tmux calls").toEqual(
      [`TMUX= -S ${join(r.out.TMUX_TMPDIR!, `tmux-${uid}`, "default")} kill-server`, `TMUX= -S ${join(r.out.HOME!, ".tandem", "tmux", "tandem")} kill-server`].sort(),
    );
    expect(gone(r.out.HOME) && gone(r.out.TMUX_TMPDIR), "made folders left after exit").toBe(true);
  });

  it("(f) tmux is never called for a kept or inherited folder, in live mode, or when no socket exists", () => {
    const b = box();
    const t = fakeTmux(b);
    const own = join(b, "own-tmux");
    mkdirSync(own, { mode: 0o700 });
    const liveHome = join(b, "live-home");
    mkdirSync(liveHome);
    expect(probe({ TANDEM_LIVE: "1", HOME: liveHome, TMPDIR: b, PATH: t.PATH, TMUX_TMPDIR: own }, plant).status, "live, kept folder").toBe(0);
    expect(probe({ TANDEM_LIVE: "1", HOME: liveHome, TMPDIR: b, PATH: t.PATH }, plant).status, "live, made folder").toBe(0);
    expect(probe({ TMPDIR: b, PATH: t.PATH, TMUX_TMPDIR: own }).status, "non-live, no socket").toBe(0);
    expect(probe({ TMPDIR: b, PATH: t.PATH }, 'fs.mkdirSync(H + "/.tandem/tmux", { recursive: true }); fs.writeFileSync(H + "/.tandem/tmux/tandem", "");').status, "non-live, a file not a socket").toBe(0);
    expect(t.calls(), "tmux calls").toEqual([]);
  });

  it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("(g) a real tmux server on <HOME>/.tandem/tmux/tandem is stopped at exit and the HOME is gone", () => {
    const b = box();
    const start = [
      'const S = H + "/.tandem/tmux/tandem"; fs.mkdirSync(H + "/.tandem/tmux", { recursive: true, mode: 0o700 });',
      'const cp = await import("node:child_process");',
      'cp.spawnSync("tmux", ["-S", S, "new-session", "-d", "-x", "80", "-y", "24", "sleep 600"], { stdio: "ignore" });',
      'P.pid = Number(cp.spawnSync("tmux", ["-S", S, "display-message", "-p", "#{pid}"], { encoding: "utf8" }).stdout.trim());',
    ].join("\n");
    const r = probe({ TMPDIR: b }, start);
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    const pid = r.out.P.pid as number;
    expect(pid > 0, "tmux server started").toBe(true);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        spawnSync("sleep", ["0.1"]);
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(pid, "SIGTERM"); // the server this case started; never any other
    expect(alive, "tmux server still running after exit").toBe(false);
    expect(gone(r.out.HOME), "HOME left after exit").toBe(true);
  });

  it("(h) non-live TMPDIR is an stt- folder directly under the short tmp root, outside HOME and the real home, gone after exit", () => {
    const r = probe({ TMPDIR: box() });
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    const t = r.out.TMPDIR ?? "";
    expect(basename(t).startsWith("stt-") && dirname(t) === SHORT && r.out.tmpIsDir, "TMPDIR is <short root>/stt-*").toBe(true);
    expect(inside(t, r.out.HOME!) || inside(t, userInfo().homedir), "TMPDIR inside HOME or the real home").toBe(false);
    expect(gone(t), "stt- folder left after exit").toBe(true);
  });

  it("(i) socket length: under the default user TMPDIR both tmux sockets fit 103 bytes and a 100-byte socket listens", () => {
    const tmp = process.platform === "darwin" ? spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim() : "/tmp";
    const extra = [
      'P.homeSock = Buffer.byteLength(H + "/.tandem/tmux/tandem");',
      'P.tmuxSock = Buffer.byteLength(process.env.TMUX_TMPDIR + "/tmux-" + process.getuid() + "/default");',
      'const T = process.env.TMPDIR; const SP = T + "/" + "s".repeat(100 - Buffer.byteLength(T) - 1); P.sockLen = Buffer.byteLength(SP);',
      'const sv = (await import("node:net")).createServer(); P.listens = await new Promise((res) => { sv.on("error", () => res(false)); sv.listen(SP, () => sv.close(() => res(true))); });',
    ].join("\n");
    const r = probe({ TMPDIR: tmp }, extra);
    try {
      expect(r.status, `setup exit ${r.stderr}`).toBe(0);
      console.log(`(i) TMPDIR length ${Buffer.byteLength(tmp)}; HOME tmux socket ${r.out.P.homeSock} bytes; TMUX_TMPDIR socket ${r.out.P.tmuxSock} bytes; probe socket ${r.out.P.sockLen} bytes`);
      expect(r.out.P.homeSock as number, "<HOME>/.tandem/tmux/tandem bytes").toBeLessThanOrEqual(103);
      expect(r.out.P.tmuxSock as number, "<TMUX_TMPDIR>/tmux-<uid>/default bytes").toBeLessThanOrEqual(103);
      expect(r.out.P.sockLen, "probe socket bytes").toBe(100);
      expect(r.out.P.listens, "a 100-byte socket under TMPDIR listens").toBe(true);
      expect(gone(r.out.HOME) && gone(r.out.TMUX_TMPDIR) && gone(r.out.TMPDIR), "made folders left after exit").toBe(true);
    } finally {
      // a red run must not leave its folders in the user temp dir: only the ones this probe printed
      for (const p of [r.out.HOME, r.out.TMUX_TMPDIR]) if (p && dirname(p) === dirname(join(tmp, "x")) && /^tandem-test-(home|tmux)-/.test(basename(p))) rmSync(p, { recursive: true, force: true });
    }
  });

  it("(j) cleanup refuses a remembered folder that resolves outside its root or without its prefix: left in place, contents unchanged", () => {
    const b = box();
    const elsewhere = join(b, "elsewhere");
    const stt = join(elsewhere, "stt-made-elsewhere");
    const other = join(b, "other-folder");
    const fakeHome = join(elsewhere, "tandem-test-home-elsewhere");
    for (const d of [stt, other, fakeHome]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "kept"), "k");
    }
    // only a folder the setup made (its own prefix) is swapped for a link
    const swap = (envName: string, prefix: string, target: string) =>
      `const D = process.env.${envName}; if ((await import("node:path")).basename(D).startsWith(${JSON.stringify(prefix)})) { fs.rmSync(D, { recursive: true }); fs.symlinkSync(${JSON.stringify(target)}, D); P.swapped = true; }`;
    const runs = [
      probe({ TMPDIR: b }, swap("TMPDIR", "stt-", stt)), // an stt- name made elsewhere
      probe({ TMPDIR: b }, swap("HOME", "tandem-test-home-", other)), // a tandem-test-home- link to a folder without the prefix
      probe({ TMPDIR: b }, swap("HOME", "tandem-test-home-", fakeHome)), // ... and to a prefixed folder under another root
    ];
    try {
      for (const r of runs) expect(r.status === 0 && r.out.P.swapped, `setup exit and swap ${r.stderr}`).toBe(true);
      for (const d of [stt, other, fakeHome]) expect(readFileSync(join(d, "kept"), "utf8"), `contents of ${basename(d)}`).toBe("k");
    } finally {
      // the links the probes left (the stt- one sits in the shared tmp root): remove the links only
      for (const r of runs) for (const p of [r.out.TMPDIR, r.out.HOME]) if (p && lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(p);
    }
  });

  it("(k) worker reuse: cleanup restores HOME, TMUX_TMPDIR and TMPDIR, the setup runs again in the same process with new folders, one exit listener", () => {
    const b = box();
    const origHome = join(b, "orig-home");
    const script = [
      'const fs = await import("node:fs");',
      "const e = process.env; const orig = { H: e.HOME, X: e.TMUX_TMPDIR, T: e.TMPDIR }; const n0 = process.listenerCount('exit');",
      "await import(process.argv[1]);",
      "const first = [e.HOME, e.TMUX_TMPDIR, e.TMPDIR];",
      "process.emit('exit', 0); // the cleanup, as at the end of a file",
      "const P = { restored: e.HOME === orig.H && e.TMUX_TMPDIR === orig.X && e.TMPDIR === orig.T, firstGone: first.every((p) => !fs.existsSync(p)) };",
      "await import(process.argv[1] + '?next-file');",
      "const second = [e.HOME, e.TMUX_TMPDIR, e.TMPDIR];",
      "P.secondNew = second.every((p, i) => p !== first[i] && fs.statSync(p).isDirectory());",
      "P.listeners = process.listenerCount('exit') - n0;",
      "process.stdout.write(JSON.stringify({ first, second, P }));",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, SETUP_URL], {
      env: { PATH: process.env.PATH ?? "", HOME: origHome, TMPDIR: b },
      encoding: "utf8",
    });
    expect(r.status, `setup exit ${r.stderr}`).toBe(0);
    expect(r.stderr.includes("could not isolate"), "second setup failed").toBe(false);
    const o = JSON.parse(r.stdout) as { first: string[]; second: string[]; P: Record<string, unknown> };
    expect(o.P, "after the first cleanup and the second setup").toEqual({ restored: true, firstGone: true, secondNew: true, listeners: 1 });
    expect([...o.first, ...o.second].filter((p) => !gone(p)), "folders left after exit").toEqual([]);
  });

  it("(f) SIGTERM (how vitest stops a fork worker; \"exit\" does not run): the made folders are removed and the signal still ends the process", () => {
    const b = box();
    const paths = join(b, "paths.json");
    const script = [
      "await import(process.argv[1]);",
      `(await import("node:fs")).writeFileSync(${JSON.stringify(paths)}, JSON.stringify([process.env.HOME, process.env.TMUX_TMPDIR, process.env.TMPDIR]));`,
      'process.kill(process.pid, "SIGTERM");',
      "setTimeout(() => {}, 10000);",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, SETUP_URL], {
      env: { PATH: process.env.PATH ?? "", TMPDIR: b },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(r.signal, `child ended by ${r.signal} status ${r.status} ${r.stderr}`).toBe("SIGTERM");
    const made = JSON.parse(readFileSync(paths, "utf8")) as string[];
    expect(made.filter((p) => !gone(p)), "folders left after SIGTERM").toEqual([]);
  });

  it("(l) a setup failure names the variable only", () => {
    const b = box();
    const file = join(b, "not-a-folder-7f3a9c");
    writeFileSync(file, "");
    const r = probe({ TMPDIR: file });
    expect(r.status === 0, "setup succeeded with TMPDIR = a file").toBe(false);
    expect(r.stderr.includes("test/setup-home.ts could not isolate HOME"), "failure names HOME").toBe(true);
    expect(r.stderr.includes("7f3a9c") || r.stderr.includes(b), "a value reached the failure output").toBe(false);
  });
});
