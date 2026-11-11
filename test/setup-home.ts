// vitest setupFiles: runs before every root test file. No test may read or write the real
// user's home or the live Tandem install (2026-11-10: test runs deleted ~/.tandem and appended
// fixtures to ~/.tandem/events.log). os.homedir() follows HOME; os.userInfo().homedir is the
// account's real home and cannot be faked. Tests that set HOME/TANDEM_HOME themselves run after.
//
// Outside live mode the temp HOME, a private tmux folder and a short TMPDIR are made here and
// removed again when the test file ends (vitest afterAll) and at process exit (TANDEM-B-TESTHOME-T2).
// A failure names the variable, never its value.
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const LIVE = process.env.TANDEM_LIVE === "1";

function guard(name: string, rule: () => void): void {
  try {
    rule();
  } catch (err) {
    throw new Error(`test/setup-home.ts could not isolate ${name} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

// Canonical spelling of a path that may not exist yet: realpath of its deepest existing ancestor
// (symlinks, letter case), compared case-insensitively where the file system usually is.
const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(real(up), basename(p));
  }
};
const fold = (p: string): string => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);

// Cleanup state lives on globalThis: a reused worker (isolate: false) imports this file again per
// test file, and one exit listener per process must see every folder any of those imports made.
type Made = { dir: string; kind: "home" | "tmux" | "tmp"; root: string; env: "HOME" | "TMUX_TMPDIR" | "TMPDIR" };
type State = { made: Made[]; orig?: Record<string, string | undefined>; live: boolean; hooked?: boolean };
const KEY = Symbol.for("tandem.test.setup-home");
const g = globalThis as unknown as Record<symbol, State>;
const state: State = (g[KEY] ??= { made: [], live: LIVE });
state.live = LIVE;
const PREFIX = { home: /^tandem-test-home-/, tmux: /^tandem-test-tmux-/, tmp: /^stt-/ };

function removeTree(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) return; // files and symlinks go with rmSync; never chmod through a link
  chmodSync(dir, (st.mode & 0o7777) | 0o700);
  for (const name of readdirSync(dir)) removeTree(join(dir, name));
}
function killServer(socket: string): void {
  try {
    if (!lstatSync(socket).isSocket()) return;
  } catch {
    return;
  }
  const env = { ...process.env };
  delete env.TMUX;
  spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
}
function cleanup(): void {
  if (state.live) return; // live runs: nothing is removed, nothing is stopped
  const home = fold(real(userInfo().homedir));
  const uid = process.getuid?.() ?? "user";
  for (const m of state.made.splice(0)) {
    try {
      const r = realpathSync(m.dir);
      const ok = PREFIX[m.kind].test(basename(r)) && dirname(r) === realpathSync(m.root) && fold(r) !== home && !home.startsWith(fold(r) + sep);
      if (!ok) continue;
      if (m.kind === "tmux") killServer(join(m.dir, `tmux-${uid}`, "default"));
      if (m.kind === "home") killServer(join(m.dir, ".tandem", "tmux", "tandem"));
      removeTree(r);
      rmSync(r, { recursive: true, force: true });
    } catch {}
    // the next file in a reused worker must never start from a removed folder
    if (state.orig && process.env[m.env] === m.dir) {
      const was = state.orig[m.env];
      if (was === undefined) delete process.env[m.env];
      else process.env[m.env] = was;
    }
  }
  state.orig = undefined;
}
if (!state.hooked) {
  state.hooked = true;
  process.on("exit", cleanup); // cleanup reads only the shared state, so the first import's copy serves all
  // vitest stops its fork workers with SIGTERM, which skips "exit", and a file whose tests are all
  // skipped never runs afterAll: clean up on SIGTERM too, then let the signal end the process as before.
  const onTerm = (): void => {
    cleanup();
    process.off("SIGTERM", onTerm);
    process.kill(process.pid, "SIGTERM");
  };
  process.on("SIGTERM", onTerm);
}
if (process.env.VITEST) {
  const { afterAll } = await import("vitest");
  try {
    afterAll(cleanup);
  } catch {} // a child node that only inherited VITEST has no current suite: its exit listener cleans up
}

state.orig ??= { HOME: process.env.HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMPDIR: process.env.TMPDIR };
const TMP_ROOT = tmpdir(); // read before TMPDIR moves below; HOME and the tmux folder are made here
const make = (kind: Made["kind"], env: Made["env"], root: string, prefix: string): string => {
  const dir = mkdtempSync(join(root, prefix)); // mkdtemp makes it mode 0700
  state.made.push({ dir, kind, root, env });
  return dir;
};

// Live tests (TANDEM_LIVE=1) keep the real HOME: the codex/claude logins live there.
guard("HOME", () => {
  if (!LIVE) process.env.HOME = make("home", "HOME", TMP_ROOT, "tandem-test-home-");
});

// Always, live mode included: no inherited CCM_* (the live fabric database, the live hub and its
// token). A test that needs one sets it itself, after this file.
for (const k of Object.keys(process.env)) if (k.startsWith("CCM_")) delete process.env[k];

// Always, live mode included: no inherited TANDEM_HERMES_* (a live Hermes, its password file) and
// none of the live install's path variables; the real Hermes network stays off. A test that runs
// its own Hermes server sets its own values, after this file.
for (const k of Object.keys(process.env)) if (k.startsWith("TANDEM_HERMES_")) delete process.env[k];
for (const k of ["TANDEM_CONFIG_FILE", "TANDEM_DEVICE_READY_FILE", "TANDEM_OWNER_PASSWORD_FILE", "TANDEM_ENROLLMENT_STATE_DIR"]) {
  delete process.env[k];
}
process.env.TANDEM_HERMES_DISABLE_LIVE = "1";

const th = process.env.TANDEM_HOME;
if (th !== undefined) {
  const rel = relative(fold(real(userInfo().homedir)), fold(real(resolve(th))));
  if (rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    delete process.env.TANDEM_HOME;
  }
}

// tmux, live mode included: no inherited TMUX/TMUX_* (the live server), and a private TMUX_TMPDIR
// (tmux silently falls back to /tmp, the live server, when it is not a directory). Outside live
// mode always a fresh one; a live run keeps its own private folder.
for (const k of Object.keys(process.env)) if (/^TMUX(_|$)/.test(k) && k !== "TMUX_TMPDIR") delete process.env[k];
guard("TMUX_TMPDIR", () => {
  const dir = process.env.TMUX_TMPDIR;
  let keep = false;
  try {
    keep = LIVE && !!dir && statSync(dir).isDirectory() && !["/tmp", "/private/tmp"].includes(fold(realpathSync(dir)));
  } catch {}
  if (!keep) process.env.TMUX_TMPDIR = make("tmux", "TMUX_TMPDIR", TMP_ROOT, "tandem-test-tmux-");
});

// Tests' own mkdtemp(tmpdir()) folders go in a short private stt- folder removed at file end:
// short because macOS caps unix socket paths at 104 bytes. Live runs keep their TMPDIR.
if (!LIVE) {
  guard("TMPDIR", () => {
    let short = TMP_ROOT;
    try {
      const root = realpathSync(process.platform === "darwin" ? "/private/tmp" : "/tmp");
      accessSync(root, constants.W_OK);
      short = root;
    } catch {} // not writable: stay under TMP_ROOT
    process.env.TMPDIR = make("tmp", "TMPDIR", short, "stt-");
  });
}
