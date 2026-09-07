import assert from "node:assert/strict";
import { chmod, chown, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireWalletCliProfileLock } from "../profile-lock.js";

const existingMetadata = `${JSON.stringify({ nonce: "existing-lock", pid: 123, startedAt: "2026-09-07T00:00:00.000Z" })}\n`;

test("wallet-cli compatible advisory lock excludes contenders and remains verifiable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk12-profile-lock-"));
  const path = join(directory, "session.lock");
  await writeFile(path, existingMetadata, { mode: 0o600 });
  const held = await acquireWalletCliProfileLock(path);
  await held.verify();
  await assert.rejects(acquireWalletCliProfileLock(path), { category: "LOCK_ACTIVE" });
  await held.release();
  const reacquired = await acquireWalletCliProfileLock(path);
  await reacquired.release();
});

test("wallet-cli compatible advisory lock securely creates the persistent lock file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk12-profile-lock-create-"));
  const path = join(directory, "session.lock");
  const held = await acquireWalletCliProfileLock(path);
  await held.verify();
  await held.release();
  const reacquired = await acquireWalletCliProfileLock(path);
  await reacquired.release();
});

test("simultaneous missing-file acquisition admits exactly one owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk12-profile-lock-race-"));
  const path = join(directory, "session.lock");
  const attempts = await Promise.allSettled([
    acquireWalletCliProfileLock(path),
    acquireWalletCliProfileLock(path)
  ]);
  const fulfilled = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWalletCliProfileLock>>> => item.status === "fulfilled");
  const rejected = attempts.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(["LOCK_ACTIVE", "LOCK_METADATA_INVALID"].includes(rejected[0]!.reason?.category));
  await fulfilled[0]!.value.verify();
  await fulfilled[0]!.value.release();
});

test("wallet-cli compatible advisory lock rejects a different filesystem owner", async (context) => {
  if (process.getuid?.() !== 0) {
    context.skip("requires the root user used by the Docker verification gate");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "sdk12-profile-lock-owner-"));
  const path = join(directory, "session.lock");
  await writeFile(path, existingMetadata, { mode: 0o600 });
  await chown(path, 65_534, 65_534);
  await assert.rejects(acquireWalletCliProfileLock(path), { category: "LOCK_INSECURE" });
});

test("wallet-cli compatible advisory lock rejects insecure mode and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk12-profile-lock-negative-"));
  const real = join(directory, "real.lock");
  const path = join(directory, "session.lock");
  await writeFile(real, existingMetadata, { mode: 0o600 });
  await symlink(real, path);
  await assert.rejects(acquireWalletCliProfileLock(path), { category: "LOCK_INSECURE" });
  await import("node:fs/promises").then(({ unlink }) => unlink(path));
  await writeFile(path, existingMetadata, { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(acquireWalletCliProfileLock(path), { category: "LOCK_INSECURE" });
});
