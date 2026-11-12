import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { tandemHome } from "./tandem-home.ts";
import { z } from "zod";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_ENROLLMENTS = 64;
const MAX_RECORD_BYTES = 4096;

const RecordSchema = z.object({
  version: z.literal(1),
  expiresAt: z.number().int().positive(),
}).strict();

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isRecordName(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/.test(name);
}

async function assertProtectedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("enrollment state directory is unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("enrollment state directory has the wrong owner");
  }
  await chmod(directory, 0o700);
}

export interface CreatedEnrollment {
  token: string;
  expiresAt: number;
}

/** A one-file-per-invitation store. Raw invitation tokens are never persisted.
 * Consumption is an atomic rename, so concurrent replays have exactly one
 * winner. A crash after the claim safely burns the invitation. */
export class FleetEnrollmentStore {
  private readonly directory: string;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async open(directory?: string): Promise<FleetEnrollmentStore> {
    const resolved = path.resolve(directory ?? path.join(tandemHome(), "fleet", "enrollments"));
    await assertProtectedDirectory(resolved);
    const store = new FleetEnrollmentStore(resolved);
    await store.prune();
    return store;
  }

  async create(ttlMs = DEFAULT_TTL_MS): Promise<CreatedEnrollment> {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TTL_MS) {
      throw new Error("enrollment TTL must be from 1 to 60 minutes");
    }
    await this.prune();
    const active = (await readdir(this.directory)).filter(isRecordName);
    if (active.length >= MAX_ACTIVE_ENROLLMENTS) throw new Error("too many active enrollment invitations");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + ttlMs;
      const target = path.join(this.directory, `${digestToken(token)}.json`);
      let handle;
      try {
        handle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await handle.writeFile(`${JSON.stringify({ version: 1, expiresAt })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await chmod(target, 0o600);
        return { token, expiresAt };
      } catch (error) {
        await handle?.close().catch(() => {});
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("could not allocate enrollment invitation");
  }

  async consume(token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return false;
    const source = path.join(this.directory, `${digestToken(token)}.json`);
    const claimed = path.join(this.directory, `.claimed.${randomUUID()}`);
    try {
      await rename(source, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const info = await lstat(claimed);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES || (info.mode & 0o077) !== 0) {
        return false;
      }
      const record = RecordSchema.safeParse(JSON.parse(await readFile(claimed, "utf8")));
      return record.success && record.data.expiresAt > Date.now();
    } catch {
      return false;
    } finally {
      await unlink(claimed).catch(() => {});
    }
  }

  async revoke(token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return false;
    try {
      await unlink(path.join(this.directory, `${digestToken(token)}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(this.directory)) {
      if (name.startsWith(".claimed.")) {
        await unlink(path.join(this.directory, name)).catch(() => {});
        continue;
      }
      if (!isRecordName(name)) continue;
      const target = path.join(this.directory, name);
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES || (info.mode & 0o077) !== 0) {
          await unlink(target);
          continue;
        }
        const parsed = RecordSchema.safeParse(JSON.parse(await readFile(target, "utf8")));
        if (!parsed.success || parsed.data.expiresAt <= now) await unlink(target);
      } catch {
        await unlink(target).catch(() => {});
      }
    }
  }
}
