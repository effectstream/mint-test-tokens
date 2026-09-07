/// <reference path="./fs-native-extensions.d.ts" />
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tryLock, unlock } from "fs-native-extensions";

const LOCK_MODE = 0o600;
const MAX_LOCK_METADATA_BYTES = 4096;

interface LockMetadata { nonce: string; pid: number; startedAt: string }

export interface HeldWalletCliProfileLock {
  verify(): Promise<void>;
  release(): Promise<void>;
}

export class WalletCliProfileLockError extends Error {
  constructor(readonly category: "LOCK_ACTIVE" | "LOCK_INSECURE" | "LOCK_METADATA_INVALID" | "LOCK_PATH_REPLACED" | "LOCK_UNSUPPORTED") {
    super(category);
    this.name = "WalletCliProfileLockError";
  }
}

const isMetadata = (value: unknown): value is LockMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).sort().join(",") === "nonce,pid,startedAt" &&
    typeof object.nonce === "string" && /^[a-z0-9-]{8,128}$/.test(object.nonce) &&
    typeof object.pid === "number" && Number.isSafeInteger(object.pid) && object.pid > 0 &&
    typeof object.startedAt === "string" && !Number.isNaN(Date.parse(object.startedAt));
};
const canonical = (metadata: LockMetadata): string => `${JSON.stringify(metadata)}\n`;

const validateDescriptor = async (handle: FileHandle): Promise<void> => {
  const status = await handle.stat({ bigint: true });
  const uid = process.getuid?.();
  if (!status.isFile() || status.nlink !== 1n || (uid !== undefined && status.uid !== BigInt(uid)) || (status.mode & 0o777n) !== BigInt(LOCK_MODE)) {
    throw new WalletCliProfileLockError("LOCK_INSECURE");
  }
};

const readMetadata = async (handle: FileHandle): Promise<LockMetadata> => {
  const status = await handle.stat();
  if (status.size < 1 || status.size > MAX_LOCK_METADATA_BYTES) throw new WalletCliProfileLockError("LOCK_METADATA_INVALID");
  const buffer = Buffer.alloc(status.size);
  const read = await handle.read(buffer, 0, buffer.length, 0);
  if (read.bytesRead !== buffer.length) throw new WalletCliProfileLockError("LOCK_METADATA_INVALID");
  try {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (!isMetadata(value) || canonical(value) !== buffer.toString("utf8")) throw new Error("non-canonical");
    return value;
  } catch {
    throw new WalletCliProfileLockError("LOCK_METADATA_INVALID");
  }
};

const verifyPath = async (path: string, handle: FileHandle): Promise<void> => {
  const [pathStatus, descriptorStatus] = await Promise.all([
    lstat(path, { bigint: true }).catch(() => undefined),
    handle.stat({ bigint: true })
  ]);
  if (!pathStatus || pathStatus.isSymbolicLink() || !pathStatus.isFile() || pathStatus.dev !== descriptorStatus.dev || pathStatus.ino !== descriptorStatus.ino) {
    throw new WalletCliProfileLockError("LOCK_PATH_REPLACED");
  }
};

const openLockFile = async (path: string): Promise<{ created: boolean; handle: FileHandle }> => {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW;
  try {
    return { created: true, handle: await open(path, flags | constants.O_CREAT | constants.O_EXCL, LOCK_MODE) };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw new WalletCliProfileLockError("LOCK_INSECURE");
  }
  try {
    return { created: false, handle: await open(path, flags) };
  } catch {
    throw new WalletCliProfileLockError("LOCK_INSECURE");
  }
};

export async function acquireWalletCliProfileLock(path: string): Promise<HeldWalletCliProfileLock> {
  const opened = await openLockFile(path);
  const handle = opened.handle;
  let held = false;
  const metadata: LockMetadata = { nonce: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  try {
    await validateDescriptor(handle);
    if (!opened.created) await readMetadata(handle);
    try { held = tryLock(handle.fd); } catch { throw new WalletCliProfileLockError("LOCK_UNSUPPORTED"); }
    if (!held) throw new WalletCliProfileLockError("LOCK_ACTIVE");
    await verifyPath(path, handle);
    const bytes = canonical(metadata);
    await handle.truncate(0);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } catch (error) {
    if (held) try { unlock(handle.fd); } catch { /* closing releases descriptor ownership */ }
    await handle.close().catch(() => undefined);
    if (error instanceof WalletCliProfileLockError) throw error;
    throw new WalletCliProfileLockError("LOCK_INSECURE");
  }
  let released = false;
  return {
    async verify() {
      if (released) throw new WalletCliProfileLockError("LOCK_PATH_REPLACED");
      await validateDescriptor(handle);
      await verifyPath(path, handle);
      const current = await readMetadata(handle);
      if (canonical(current) !== canonical(metadata)) throw new WalletCliProfileLockError("LOCK_METADATA_INVALID");
    },
    async release() {
      if (released) return;
      released = true;
      try { unlock(handle.fd); } finally { await handle.close(); }
    }
  };
}

export async function withWalletCliProfileLock<T>(path: string, action: (lock: HeldWalletCliProfileLock) => Promise<T>): Promise<T> {
  const lock = await acquireWalletCliProfileLock(path);
  try {
    return await action(lock);
  } finally {
    await lock.release();
  }
}
