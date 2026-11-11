// vitest setupFiles: runs before every root test file. No test may read or write the real
// user's home or the live Tandem install (2026-11-10: test runs deleted ~/.tandem and appended
// fixtures to ~/.tandem/events.log). os.homedir() follows HOME; os.userInfo().homedir is the
// account's real home and cannot be faked. Tests that set HOME/TANDEM_HOME themselves run after.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Live tests (TANDEM_LIVE=1) keep the real HOME: the codex/claude logins live there.
if (process.env.TANDEM_LIVE !== "1") {
  process.env.HOME = mkdtempSync(join(tmpdir(), "tandem-test-home-"));
}

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
const th = process.env.TANDEM_HOME;
if (th !== undefined) {
  const rel = relative(fold(real(userInfo().homedir)), fold(real(resolve(th))));
  if (rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    delete process.env.TANDEM_HOME;
  }
}
