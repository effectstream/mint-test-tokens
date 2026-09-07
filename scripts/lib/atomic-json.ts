import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export class RegistryLockedError extends Error {
  constructor(readonly lockPath: string) {
    super(`Registry is locked by another process: ${lockPath}`);
    this.name = "RegistryLockedError";
  }
}

export async function withFileLock<T>(targetPath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await mkdir(dirname(targetPath), { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RegistryLockedError(lockPath);
    throw error;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    return await action();
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeJsonAtomic(targetPath: string, value: unknown, mode = 0o600): Promise<void> {
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let file;
  try {
    file = await open(tempPath, "wx", mode);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(tempPath, targetPath);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
