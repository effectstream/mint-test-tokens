import assert from "node:assert/strict";
import { test } from "node:test";
import { firstValueFrom, of } from "rxjs";
import { LedgerParameters, verifySignature } from "@midnight-ntwrk/ledger-v8";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import {
  SDK12_DEPLOYMENT_TOOLCHAIN,
  Sdk12DeploymentWalletProvider,
  assertRestoredSnapshotBindings,
  createSdk12WalletConfiguration,
  deriveSdk12Identity,
  importSdk12UnboundTransaction,
  restoreSdk12WalletSnapshots
} from "../provider.js";
import type { WalletCliCheckpoint } from "../checkpoint.js";

const endpoints = {
  indexer: "http://127.0.0.1:31001/api/v4/graphql",
  indexerWS: "ws://127.0.0.1:31001/api/v4/graphql/ws",
  node: "http://127.0.0.1:31002",
  nodeWS: "ws://127.0.0.1:31002",
  proofServer: "http://127.0.0.1:31003"
};

test("seed derivation is bounded to documented 32/64-byte master seeds", () => {
  for (const bytes of [32, 64]) {
    const identity = deriveSdk12Identity("11".repeat(bytes));
    assert.match(identity.identityBinding, /^[0-9a-f]{64}$/);
    identity.zswapSecretKeys.clear();
    identity.dustSecretKey.clear();
    identity.nightSecretKey.fill(0);
  }
  for (const bytes of [0, 31, 33, 63, 65]) assert.throws(() => deriveSdk12Identity("11".repeat(bytes)), /32- or 64-byte/);
});

test("root ledger transactions cross into the isolated facade only through serialization", async () => {
  const rootLedger = await import(new URL("../../../node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_fs.js", import.meta.url).href) as typeof import("@midnight-ntwrk/ledger-v8");
  const rootTransaction = await rootLedger.Transaction.fromParts("preprod").prove({
    check: async () => { throw new Error("empty transaction unexpectedly requested a proof check"); },
    prove: async () => { throw new Error("empty transaction unexpectedly requested a proof"); }
  }, rootLedger.CostModel.initialCostModel());
  const imported = importSdk12UnboundTransaction(rootTransaction);
  assert.deepEqual(imported.serialize(), rootTransaction.serialize());
});

test("same-cohort cold snapshots restore offline and form the deployment provider interface", async () => {
  const identity = deriveSdk12Identity("22".repeat(32));
  const configuration = createSdk12WalletConfiguration(endpoints);
  const cold = {
    shielded: ShieldedWallet(configuration).startWithSecretKeys(identity.zswapSecretKeys),
    unshielded: UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(identity.keystore)),
    dust: DustWallet(configuration).startWithSecretKey(identity.dustSecretKey, LedgerParameters.initialParameters().dust)
  };
  const snapshots = {
    shielded: await cold.shielded.serializeState(),
    unshielded: await cold.unshielded.serializeState(),
    dust: await cold.dust.serializeState()
  };
  const restored = restoreSdk12WalletSnapshots(configuration, snapshots);
  const [shielded, unshielded, dust] = await Promise.all([
    restored.shielded.getAddress(), restored.unshielded.getAddress(), restored.dust.getAddress()
  ]);
  assert.equal(shielded.coinPublicKey.toHexString(), identity.zswapSecretKeys.coinPublicKey);
  assert.equal(unshielded.hexString, identity.keystore.getAddress());
  assert.equal(dust.data, identity.dustSecretKey.publicKey);
  const payload = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(verifySignature(identity.keystore.getPublicKey(), payload, identity.keystore.signData(payload)), true);
  assert.equal(typeof Sdk12DeploymentWalletProvider.prototype.balanceTx, "function");
  assert.equal(typeof Sdk12DeploymentWalletProvider.prototype.submitTx, "function");
  assert.deepEqual(SDK12_DEPLOYMENT_TOOLCHAIN, { runner: "@midnightntwrk/wallet-sdk-facade", runnerVersion: "4.1.0", walletSdk: "1.2.0" });
  identity.zswapSecretKeys.clear();
  identity.dustSecretKey.clear();
  identity.nightSecretKey.fill(0);
});

test("restored snapshot network, protocol and cursors must match the checkpoint witnesses", async () => {
  const identity = deriveSdk12Identity("33".repeat(32));
  const configuration = createSdk12WalletConfiguration(endpoints);
  const cold = {
    shielded: ShieldedWallet(configuration).startWithSecretKeys(identity.zswapSecretKeys),
    unshielded: UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(identity.keystore)),
    dust: DustWallet(configuration).startWithSecretKey(identity.dustSecretKey, LedgerParameters.initialParameters().dust)
  };
  const restored = restoreSdk12WalletSnapshots(configuration, {
    shielded: await cold.shielded.serializeState(),
    unshielded: await cold.unshielded.serializeState(),
    dust: await cold.dust.serializeState()
  });
  const [dust, shielded, unshielded] = await Promise.all([
    firstValueFrom(restored.dust.state),
    firstValueFrom(restored.shielded.state),
    firstValueFrom(restored.unshielded.state)
  ]);
  const checkpoint = {
    cursorWitnesses: {
      dust: { kind: "event", requestedId: dust.progress.appliedIndex.toString(), protocol: String(dust.state.protocolVersion) },
      shielded: { kind: "event", requestedId: shielded.progress.appliedIndex.toString(), protocol: String(shielded.state.protocolVersion) },
      unshielded: { kind: "event", requestedAppliedId: unshielded.progress.appliedId.toString() }
    }
  } as WalletCliCheckpoint;
  await assert.doesNotReject(assertRestoredSnapshotBindings(checkpoint, restored));
  await assert.rejects(assertRestoredSnapshotBindings({
    ...checkpoint,
    cursorWitnesses: { ...checkpoint.cursorWitnesses, dust: { ...checkpoint.cursorWitnesses.dust, requestedId: "1" } }
  } as WalletCliCheckpoint, restored), /cursor mismatch/);
  await assert.rejects(assertRestoredSnapshotBindings({
    ...checkpoint,
  } as WalletCliCheckpoint, {
    dust: { state: of(dust) },
    shielded: { state: of({ state: { ...shielded.state, protocolVersion: 999n }, progress: shielded.progress }) },
    unshielded: { state: of(unshielded) }
  } as unknown as Parameters<typeof assertRestoredSnapshotBindings>[1]), /protocol mismatch/);
  const wrongNetwork = {
    dust: { state: of({ state: { ...dust.state, networkId: "preview" }, progress: dust.progress }) },
    shielded: { state: of(shielded) },
    unshielded: { state: of(unshielded) }
  } as unknown as Parameters<typeof assertRestoredSnapshotBindings>[1];
  await assert.rejects(assertRestoredSnapshotBindings(checkpoint, wrongNetwork), /network mismatch/);
  identity.zswapSecretKeys.clear();
  identity.dustSecretKey.clear();
  identity.nightSecretKey.fill(0);
});
