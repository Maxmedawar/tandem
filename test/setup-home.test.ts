import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";

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
  it("HOME is a fresh tandem-test-home- dir under tmpdir(), unless TANDEM_LIVE=1", () => {
    const fresh = dirname(homedir()) === tmpdir() && basename(homedir()).startsWith("tandem-test-home-");
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

describe("a TANDEM_HOME inside the real home is dropped, however it is spelled", () => {
  const home = userInfo().homedir;
  const absent = `.tandem-setup-home-probe-${process.pid}`; // never created
  const box = mkdtempSync(join(tmpdir(), "setup-home-link-"));
  const link = join(box, "home-link");
  symlinkSync(home, link, "junction"); // a link to the real home; nothing goes through it
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
