import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONFIG_KEYS = 64;
const CONFIG_KEY = /^TANDEM_[A-Z0-9_]+$/;

export class UnsafeRuntimeConfigError extends Error {}

async function assertProtectedRegularFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new UnsafeRuntimeConfigError("runtime configuration must be a regular file");
  }
  if (info.size > MAX_CONFIG_BYTES) {
    throw new UnsafeRuntimeConfigError("runtime configuration is too large");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new UnsafeRuntimeConfigError("runtime configuration permissions are too broad");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new UnsafeRuntimeConfigError("runtime configuration has the wrong owner");
  }
}

/** assertProtectedRegularFile's checks, made on the open descriptor so nothing can swap the file
 * between the check and the read: O_NOFOLLOW refuses a symlink, O_NONBLOCK keeps a FIFO from
 * blocking, then fstat. Returns the bytes. A missing file throws the plain ENOENT error. */
export function readProtectedRegularFileSync(file: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path.resolve(file), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UnsafeRuntimeConfigError("protected file is a symlink, not a regular file");
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new UnsafeRuntimeConfigError("protected file must be a regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new UnsafeRuntimeConfigError("protected file has the wrong owner");
    }
    if ((info.mode & 0o077) !== 0) throw new UnsafeRuntimeConfigError("protected file permissions are too broad");
    if (info.size > MAX_CONFIG_BYTES) throw new UnsafeRuntimeConfigError("protected file is over 64 KiB");
    // One byte past the cap tells a file that grew after the fstat.
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_CONFIG_BYTES) throw new UnsafeRuntimeConfigError("protected file is over 64 KiB");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

async function ensureProtectedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UnsafeRuntimeConfigError("runtime configuration directory is unsafe");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new UnsafeRuntimeConfigError("runtime configuration directory has the wrong owner");
  }
  await chmod(directory, 0o700);
}

function parseConfig(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnsafeRuntimeConfigError("runtime configuration is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnsafeRuntimeConfigError("runtime configuration must be a JSON object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CONFIG_KEYS) {
    throw new UnsafeRuntimeConfigError("runtime configuration has too many keys");
  }
  const config: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!CONFIG_KEY.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new UnsafeRuntimeConfigError("runtime configuration contains an invalid entry");
    }
    config[key] = value;
  }
  return config;
}

export async function readProtectedRuntimeConfig(file: string): Promise<Record<string, string>> {
  const resolved = path.resolve(file);
  await assertProtectedRegularFile(resolved);
  return parseConfig(await readFile(resolved, "utf8"));
}

/** Loads a setup-generated JSON configuration without overriding explicit
 * process environment values. With no explicit file, the caller may retain
 * its existing development `.env` fallback. */
export async function loadProtectedRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const requested = env.TANDEM_CONFIG_FILE?.trim();
  if (!requested) return false;
  const config = await readProtectedRuntimeConfig(requested);
  for (const [key, value] of Object.entries(config)) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export async function readProtectedSecretFile(file: string, minLength = 16, maxLength = 1024): Promise<string> {
  const resolved = path.resolve(file);
  await assertProtectedRegularFile(resolved);
  const value = (await readFile(resolved, "utf8")).replace(/[\r\n]+$/, "");
  if (value.length < minLength || value.length > maxLength || value.includes("\0")) {
    throw new UnsafeRuntimeConfigError("protected secret file has an invalid value");
  }
  return value;
}

/** Atomic 0600 writer used by setup helpers. The containing directory is
 * forced to 0700 and the temporary file is never created at a predictable
 * path. */
export async function writeProtectedFile(file: string, contents: string): Promise<void> {
  const resolved = path.resolve(file);
  const directory = path.dirname(resolved);
  await ensureProtectedDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, resolved);
    await chmod(resolved, 0o600);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function writeProtectedRuntimeConfig(file: string, values: Record<string, string>): Promise<void> {
  const checked = parseConfig(JSON.stringify(values));
  await writeProtectedFile(file, `${JSON.stringify(checked, null, 2)}\n`);
}
