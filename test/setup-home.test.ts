import { describe, it, expect } from "vitest";
import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { relative, resolve, isAbsolute, sep } from "node:path";

// test/setup-home.ts (vitest setupFiles) must keep every root test away from the real
// user's home and the live Tandem install, whatever environment the suite starts from.
describe("test setup isolates HOME and TANDEM_HOME", () => {
  it("HOME is a fresh temp dir, not the real home and not the starting HOME", () => {
    const real = userInfo().homedir;
    expect(homedir()).not.toBe(real);
    expect(homedir()).not.toBe("/tmp/testhome-run/home");
    expect(statSync(homedir()).isDirectory()).toBe(true);
  });

  it("TANDEM_HOME is unset or outside the real home", () => {
    const th = process.env.TANDEM_HOME;
    if (th === undefined) return;
    const rel = relative(resolve(userInfo().homedir), resolve(th));
    const inside = rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
    expect(inside, `TANDEM_HOME=${th}`).toBe(false);
  });
});
