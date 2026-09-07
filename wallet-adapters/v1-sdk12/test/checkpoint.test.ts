import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SDK12_CHECKPOINT_COHORT,
  assertStreamWitnessResult,
  assertUnshieldedWitnessResult,
  canonicalJson,
  chainFingerprint,
  parseStrictJson,
  validateCheckpointFiles,
  validateCheckpointValue,
  type WalletCliCheckpoint
} from "../checkpoint.js";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const seal = <T extends Record<string, unknown>>(value: T): T & { integrity: { algorithm: "sha256"; payloadDigest: string } } => ({
  ...value,
  integrity: { algorithm: "sha256", payloadDigest: sha256(canonicalJson(value)) }
});

const shieldedRow = { id: "41", maxId: "50", protocolVersion: "8", raw: "0a0b" };
const unshieldedRow = {
  __typename: "UnshieldedTransaction" as const,
  transaction: { id: 42, hash: "0xtx", raw: "0x0102", protocolVersion: 8, block: { hash: "0xblock" } },
  createdUtxos: [],
  spentUtxos: []
};

const fixture = (): Record<string, unknown> => seal({
  chainFingerprint: chainFingerprint(`0x${"1".repeat(64)}`),
  cursorWitnesses: {
    dust: { eventDigest: sha256(Buffer.from("0a0b", "hex")), kind: "event", protocol: "8", requestedId: "41", returnedId: "41", stream: "dustLedgerEvents" },
    shielded: { eventDigest: sha256(Buffer.from("0a0b", "hex")), kind: "event", protocol: "8", requestedId: "41", returnedId: "41", stream: "zswapLedgerEvents" },
    unshielded: {
      blockHash: "0xblock",
      eventDigest: sha256(canonicalJson(unshieldedRow)),
      kind: "event",
      requestedAppliedId: "42",
      returnedId: "42",
      stream: "unshieldedTransactions",
      transactionHash: "0xtx"
    }
  },
  derivation: { account: 0, index: 0 },
  envelopeVersion: 2,
  generation: "7",
  identityBinding: "a".repeat(64),
  kind: "midnight-balance-checkpoint",
  networkId: "preprod",
  profile: "deploy-wallet-02",
  savedAt: "2026-09-07T00:00:00.000Z",
  versions: SDK12_CHECKPOINT_COHORT,
  wallets: { dust: "dust-snapshot", shielded: "shielded-snapshot", unshielded: "unshielded-snapshot" }
});

const reseal = (value: Record<string, unknown>): Record<string, unknown> => {
  const payload = structuredClone(value);
  delete payload.integrity;
  return seal(payload);
};

test("strict checkpoint schema accepts the exact SDK 1.2 cohort", () => {
  assert.equal(validateCheckpointValue(fixture()).generation, "7");
  assert.throws(() => parseStrictJson('{"kind":1,"kind":2}'), /duplicate JSON key/);
});

test("strict checkpoint schema rejects malformed trust-boundary fields", () => {
  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["extra", (value) => { value.extra = true; }],
    ["cohort", (value) => { (value.versions as Record<string, unknown>).facade = "4.0.1"; }],
    ["network", (value) => { value.networkId = "preview"; }],
    ["profile", (value) => { value.profile = "../escape"; }],
    ["derivation", (value) => { (value.derivation as Record<string, unknown>).index = 1; }],
    ["generation", (value) => { value.generation = "0"; }],
    ["cursor-bound", (value) => { ((value.cursorWitnesses as Record<string, unknown>).dust as Record<string, unknown>).requestedId = "2147483648"; }],
    ["cursor-order", (value) => { ((value.cursorWitnesses as Record<string, unknown>).dust as Record<string, unknown>).returnedId = "40"; }],
    ["snapshot", (value) => { (value.wallets as Record<string, unknown>).dust = ""; }],
    ["identity", (value) => { value.identityBinding = "not-a-digest"; }]
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(fixture());
    mutate(candidate);
    assert.throws(() => validateCheckpointValue(reseal(candidate)), Error, label);
  }
  const corrupt = fixture();
  corrupt.generation = "8";
  assert.throws(() => validateCheckpointValue(corrupt), /integrity mismatch/);
});

test("checkpoint and manifest files must be owner-only, regular, matching files", async () => {
  const actualRoot = await mkdtemp(join(tmpdir(), "sdk12-checkpoint-"));
  await mkdir(join(actualRoot, "profiles", "deploy-wallet-02", "preprod"), { recursive: true });
  const profileDir = join(actualRoot, "profiles", "deploy-wallet-02");
  const checkpointPath = join(profileDir, "preprod", "checkpoint.json");
  const manifestPath = join(profileDir, "profile.json");
  const manifest = seal({
    createdAt: "2026-09-07T00:00:00.000Z",
    derivation: { account: 0, index: 0 },
    identityBinding: "a".repeat(64),
    kind: "wallet-cli-profile",
    manifestVersion: 2,
    profile: "deploy-wallet-02"
  });
  await writeFile(checkpointPath, JSON.stringify(fixture()), { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  assert.equal((await validateCheckpointFiles({ checkpointPath, expectedIdentityBinding: "a".repeat(64) })).checkpoint.generation, "7");
  await chmod(checkpointPath, 0o644);
  await assert.rejects(validateCheckpointFiles({ checkpointPath, expectedIdentityBinding: "a".repeat(64) }), /owner-only/);
  await chmod(checkpointPath, 0o600);
  await assert.rejects(validateCheckpointFiles({ checkpointPath, expectedIdentityBinding: "b".repeat(64) }), /identity binding mismatch/);
  const realCheckpoint = join(profileDir, "preprod", "real.json");
  await writeFile(realCheckpoint, JSON.stringify(fixture()), { mode: 0o600 });
  await chmod(checkpointPath, 0o600);
  await unlink(checkpointPath);
  await symlink(realCheckpoint, checkpointPath);
  await assert.rejects(validateCheckpointFiles({ checkpointPath, expectedIdentityBinding: "a".repeat(64) }), /owner-only/);
});

test("cursor witness checks reject origin, stale ids, changed bytes and changed chain fields", () => {
  const checkpoint = validateCheckpointValue(fixture());
  assert.doesNotThrow(() => assertStreamWitnessResult(checkpoint.cursorWitnesses.shielded, shieldedRow, "zswapLedgerEvents"));
  assert.throws(() => assertStreamWitnessResult(checkpoint.cursorWitnesses.shielded, { ...shieldedRow, id: "40" }, "zswapLedgerEvents"), /mismatch/);
  assert.throws(() => assertStreamWitnessResult(checkpoint.cursorWitnesses.shielded, { ...shieldedRow, raw: "0c0d" }, "zswapLedgerEvents"), /mismatch/);
  assert.throws(() => assertStreamWitnessResult({ kind: "origin", requestedId: "0" }, shieldedRow, "zswapLedgerEvents"), /cannot fund/);
  assert.doesNotThrow(() => assertUnshieldedWitnessResult(checkpoint.cursorWitnesses.unshielded, unshieldedRow));
  assert.throws(() => assertUnshieldedWitnessResult(checkpoint.cursorWitnesses.unshielded, { ...unshieldedRow, transaction: { ...unshieldedRow.transaction, block: { hash: "other" } } }), /mismatch/);
  assert.throws(() => assertUnshieldedWitnessResult({ kind: "origin", requestedAppliedId: "0" }, unshieldedRow), /cannot fund/);
  assert.throws(() => chainFingerprint("0x01"), /invalid canonical genesis/);
});
