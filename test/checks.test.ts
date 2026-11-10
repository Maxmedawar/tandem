import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
// Glob scripts/**/*.sh so later scripts are covered too.
const found = readdirSync(SCRIPTS, { recursive: true })
  .map(String)
  .filter((p) => p.endsWith(".sh"))
  .sort();

describe("scripts/**/*.sh", () => {
  it("the glob finds at least 2 scripts", () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it.each(found)("%s starts with #!/bin/sh and passes sh -n", (p) => {
    const file = join(SCRIPTS, p);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("#!/bin/sh");
    const r = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
