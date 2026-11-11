// vitest setupFiles: runs before every root test file. No test may read or write the real
// user's home or the live Tandem install (2026-11-10: test runs deleted ~/.tandem and appended
// fixtures to ~/.tandem/events.log). os.homedir() follows HOME; os.userInfo().homedir is the
// account's real home and cannot be faked. Tests that set HOME/TANDEM_HOME themselves run after.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Live tests (TANDEM_LIVE=1) keep the real HOME: the codex/claude logins live there.
if (process.env.TANDEM_LIVE !== "1") {
  process.env.HOME = mkdtempSync(join(tmpdir(), "tandem-test-home-"));
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const th = process.env.TANDEM_HOME;
if (th !== undefined) {
  const rel = relative(real(userInfo().homedir), real(th));
  if (rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    delete process.env.TANDEM_HOME;
  }
}
