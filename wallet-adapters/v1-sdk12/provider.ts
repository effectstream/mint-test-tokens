import { createHash } from "node:crypto";
import {
  addressFromKey,
  DustSecretKey,
  signatureVerifyingKey,
  Transaction,
  ZswapSecretKeys,
  type FinalizedTransaction
} from "@midnight-ntwrk/ledger-v8";
import { InMemoryTransactionHistoryStorage, NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { WalletEntrySchema, WalletFacade, mergeWalletEntries, type DefaultConfiguration } from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles, type Role } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { UnshieldedWallet, createKeystore, type UnshieldedKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { firstValueFrom, type Observable } from "rxjs";
import {
  chainFingerprint,
  validateCheckpointChain,
  validateCheckpointFiles,
  type WalletCliCheckpoint
} from "./checkpoint.js";

export const SDK12_DEPLOYMENT_TOOLCHAIN = Object.freeze({
  runner: "@midnightntwrk/wallet-sdk-facade",
  runnerVersion: "4.1.0",
  walletSdk: "1.2.0"
});

type Sdk12UnboundTransaction = Parameters<WalletFacade["balanceUnboundTransaction"]>[0];

export function importSdk12UnboundTransaction(transaction: { serialize(): Uint8Array }): Sdk12UnboundTransaction {
  // Contract proving runs in the root dependency context while the restored
  // facade is deliberately isolated. Cross the WASM boundary as bytes so no
  // object pointer from the root ledger instance reaches the SDK1.2 instance.
  return Transaction.deserialize("signature", "proof", "pre-binding", transaction.serialize());
}

export interface Sdk12EndpointConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
  proofServer: string;
}

interface DerivedWalletIdentity {
  dustSecretKey: DustSecretKey;
  identityBinding: string;
  keystore: UnshieldedKeystore;
  nightSecretKey: Uint8Array;
  zswapSecretKeys: ZswapSecretKeys;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: Record<string, string>): string => `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;

const roleKey = (root: HDWallet, role: Role): Uint8Array => {
  const result = root.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (result.type !== "keyDerived") throw new Error(`wallet role ${role} cannot derive account 0/index 0`);
  return result.key;
};

export function deriveSdk12Identity(masterSeedHex: string): DerivedWalletIdentity {
  const seed = Buffer.from(masterSeedHex, "hex");
  if (![32, 64].includes(seed.length)) throw new Error("SDK1.2 adapter requires a 32- or 64-byte master seed");
  const result = HDWallet.fromSeed(seed);
  seed.fill(0);
  if (result.type !== "seedOk") throw new Error("SDK1.2 HD wallet rejected the master seed");
  const root = result.hdWallet;
  const keys: Uint8Array[] = [];
  try {
    const shielded = roleKey(root, Roles.Zswap); keys.push(shielded);
    const night = roleKey(root, Roles.NightExternal); keys.push(night);
    const dust = roleKey(root, Roles.Dust); keys.push(dust);
    const zswapSecretKeys = ZswapSecretKeys.fromSeed(shielded);
    const dustSecretKey = DustSecretKey.fromSeed(dust);
    const publicKey = signatureVerifyingKey(Buffer.from(night).toString("hex"));
    const unshieldedAddress = addressFromKey(publicKey);
    // createKeystore retains the provided array for later signing. Give it an
    // owned copy before the temporary HD role material is zeroed below.
    const nightSecretKey = Uint8Array.from(night);
    const keystore = createKeystore(nightSecretKey, NetworkId.NetworkId.PreProd);
    const identityBinding = sha256(canonicalJson({
      domain: "wallet-cli:public-role-binding:v1",
      dust: new DustAddress(dustSecretKey.publicKey).serialize().toString("hex"),
      shielded: Buffer.concat([
        Buffer.from(zswapSecretKeys.coinPublicKey, "hex"),
        Buffer.from(zswapSecretKeys.encryptionPublicKey, "hex")
      ]).toString("hex"),
      unshielded: Buffer.from(unshieldedAddress, "hex").toString("hex")
    }));
    return { dustSecretKey, identityBinding, keystore, nightSecretKey, zswapSecretKeys };
  } finally {
    for (const key of keys) key.fill(0);
    root.clear();
  }
}

const rpcGenesis = async (nodeUrl: string, timeoutMs: number): Promise<string> => {
  const response = await fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "chain_getBlockHash", params: [0] }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`SDK1.2 checkpoint genesis RPC returned HTTP ${response.status}`);
  const value = await response.json() as { id?: unknown; result?: unknown };
  if (value.id !== 1 || typeof value.result !== "string") throw new Error("SDK1.2 checkpoint genesis RPC response is invalid");
  return value.result;
};

const assertRestoredIdentity = async (input: {
  checkpoint: WalletCliCheckpoint;
  dust: ReturnType<ReturnType<typeof DustWallet>["restore"]>;
  identity: DerivedWalletIdentity;
  shielded: ReturnType<ReturnType<typeof ShieldedWallet>["restore"]>;
  unshielded: ReturnType<ReturnType<typeof UnshieldedWallet>["restore"]>;
}): Promise<void> => {
  const [dustAddress, shieldedAddress, unshieldedAddress] = await Promise.all([
    input.dust.getAddress(), input.shielded.getAddress(), input.unshielded.getAddress()
  ]);
  if (
    dustAddress.data !== input.identity.dustSecretKey.publicKey ||
    shieldedAddress.coinPublicKey.toHexString() !== input.identity.zswapSecretKeys.coinPublicKey ||
    shieldedAddress.encryptionPublicKey.toHexString() !== input.identity.zswapSecretKeys.encryptionPublicKey ||
    unshieldedAddress.hexString !== input.identity.keystore.getAddress()
  ) throw new Error("restored wallet identity differs from the supplied master seed");
  if (input.checkpoint.identityBinding !== input.identity.identityBinding) throw new Error("restored checkpoint identity binding mismatch");
};

type RestoredSnapshotBindings = Pick<RestoredSubwallets, "dust" | "shielded" | "unshielded">;

const assertSnapshotState = (input: {
  cursor: bigint;
  expectedCursor: string;
  networkId: string;
  protocolVersion: unknown;
  role: string;
}): string => {
  if (input.networkId !== NetworkId.NetworkId.PreProd) throw new Error(`${input.role} restored snapshot network mismatch`);
  if (input.cursor < 0n || input.cursor.toString(10) !== input.expectedCursor) throw new Error(`${input.role} restored snapshot cursor mismatch`);
  const protocol = String(input.protocolVersion);
  if (!/^(?:0|[1-9][0-9]*)$/.test(protocol)) throw new Error(`${input.role} restored snapshot protocol is invalid`);
  return protocol;
};

export async function assertRestoredSnapshotBindings(
  checkpoint: WalletCliCheckpoint,
  wallets: RestoredSnapshotBindings
): Promise<void> {
  const [dust, shielded, unshielded] = await Promise.all([
    firstValueFrom(wallets.dust.state),
    firstValueFrom(wallets.shielded.state),
    firstValueFrom(wallets.unshielded.state)
  ]);
  const dustWitness = checkpoint.cursorWitnesses.dust;
  const shieldedWitness = checkpoint.cursorWitnesses.shielded;
  const protocols = [assertSnapshotState({
    role: "dust",
    networkId: dust.state.networkId,
    protocolVersion: dust.state.protocolVersion,
    cursor: dust.progress.appliedIndex,
    expectedCursor: dustWitness.requestedId
  }), assertSnapshotState({
    role: "shielded",
    networkId: shielded.state.networkId,
    protocolVersion: shielded.state.protocolVersion,
    cursor: shielded.progress.appliedIndex,
    expectedCursor: shieldedWitness.requestedId
  }), assertSnapshotState({
    role: "unshielded",
    networkId: unshielded.state.networkId,
    protocolVersion: unshielded.state.protocolVersion,
    cursor: unshielded.progress.appliedId,
    expectedCursor: checkpoint.cursorWitnesses.unshielded.requestedAppliedId
  })];
  if (protocols.some((protocol) => protocol !== protocols[0])) throw new Error("restored snapshot protocol mismatch");
}

export class Sdk12DeploymentWalletProvider {
  readonly wallet: WalletFacade;
  readonly dustSecretKey: DustSecretKey;
  readonly zswapSecretKeys: ZswapSecretKeys;
  readonly unshieldedKeystore: UnshieldedKeystore;
  readonly #nightSecretKey: Uint8Array;
  #cleared = false;

  constructor(wallet: WalletFacade, identity: DerivedWalletIdentity) {
    this.wallet = wallet;
    this.dustSecretKey = identity.dustSecretKey;
    this.zswapSecretKeys = identity.zswapSecretKeys;
    this.unshieldedKeystore = identity.keystore;
    this.#nightSecretKey = identity.nightSecretKey;
  }

  async start(waitForFunds = false): Promise<void> {
    if (waitForFunds) throw new Error("SDK1.2 checkpoint adapter does not use the local-faucet startup path");
    await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
  }

  async stop(): Promise<void> {
    try {
      await this.wallet.stop();
    } finally {
      if (!this.#cleared) {
        this.#cleared = true;
        this.zswapSecretKeys.clear();
        this.dustSecretKey.clear();
        this.#nightSecretKey.fill(0);
      }
    }
  }

  async balanceTx(tx: { serialize(): Uint8Array }, ttl = new Date(Date.now() + 60 * 60 * 1000)): Promise<FinalizedTransaction> {
    const balanced = await this.wallet.balanceUnboundTransaction(importSdk12UnboundTransaction(tx), {
      shieldedSecretKeys: this.zswapSecretKeys,
      dustSecretKey: this.dustSecretKey
    }, { ttl });
    const signed = await this.wallet.signRecipe(balanced, (payload) => this.unshieldedKeystore.signData(payload));
    return this.wallet.finalizeRecipe(signed);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> { return this.wallet.submitTransaction(tx); }
  getCoinPublicKey(): string { return this.zswapSecretKeys.coinPublicKey; }
  getEncryptionPublicKey(): string { return this.zswapSecretKeys.encryptionPublicKey; }
}

export interface RestoredSdk12DeploymentWallet {
  checkpointGeneration: string;
  profileLockPath: string;
  provider: Sdk12DeploymentWalletProvider;
  toolchain: typeof SDK12_DEPLOYMENT_TOOLCHAIN;
}

type Sdk12WalletConfiguration = DefaultConfiguration;

export function createSdk12WalletConfiguration(endpoints: Sdk12EndpointConfig): Sdk12WalletConfiguration {
  return {
    costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
    indexerClientConnection: { indexerHttpUrl: endpoints.indexer, indexerWsUrl: endpoints.indexerWS },
    networkId: NetworkId.NetworkId.PreProd,
    provingServerUrl: new URL(endpoints.proofServer),
    relayURL: new URL(endpoints.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)
  };
}

export function restoreSdk12WalletSnapshots(
  configuration: Sdk12WalletConfiguration,
  snapshots: WalletCliCheckpoint["wallets"]
): {
  dust: ReturnType<ReturnType<typeof DustWallet>["restore"]>;
  shielded: ReturnType<ReturnType<typeof ShieldedWallet>["restore"]>;
  unshielded: ReturnType<ReturnType<typeof UnshieldedWallet>["restore"]>;
} {
  return {
    shielded: ShieldedWallet(configuration).restore(snapshots.shielded),
    unshielded: UnshieldedWallet(configuration).restore(snapshots.unshielded),
    dust: DustWallet(configuration).restore(snapshots.dust)
  };
}

type RestoredSubwallets = ReturnType<typeof restoreSdk12WalletSnapshots>;
interface LoadedSdk12Checkpoint {
  checkpoint: WalletCliCheckpoint;
  configuration: Sdk12WalletConfiguration;
  identity: DerivedWalletIdentity;
  profileLockPath: string;
  wallets: RestoredSubwallets;
}

const clearIdentity = (identity: DerivedWalletIdentity): void => {
  identity.zswapSecretKeys.clear();
  identity.dustSecretKey.clear();
  identity.nightSecretKey.fill(0);
};

const loadSdk12Checkpoint = async (input: {
  checkpointPath: string;
  endpoints: Sdk12EndpointConfig;
  masterSeedHex: string;
  timeoutMs: number;
  validateChain?: boolean;
}): Promise<LoadedSdk12Checkpoint> => {
  const identity = deriveSdk12Identity(input.masterSeedHex);
  let succeeded = false;
  try {
    const validated = await validateCheckpointFiles({
      checkpointPath: input.checkpointPath,
      expectedIdentityBinding: identity.identityBinding
    });
    const genesisHash = await rpcGenesis(input.endpoints.node, input.timeoutMs);
    if (chainFingerprint(genesisHash) !== validated.checkpoint.chainFingerprint) throw new Error("checkpoint chain fingerprint mismatch");
    if (input.validateChain !== false) {
      await validateCheckpointChain({
        checkpoint: validated.checkpoint,
        genesisHash,
        indexerWs: input.endpoints.indexerWS,
        timeoutMs: input.timeoutMs,
        unshieldedAddress: identity.keystore.getBech32Address().asString()
      });
    }
    const configuration = createSdk12WalletConfiguration(input.endpoints);
    const wallets = restoreSdk12WalletSnapshots(configuration, validated.checkpoint.wallets);
    await assertRestoredSnapshotBindings(validated.checkpoint, wallets);
    await assertRestoredIdentity({ checkpoint: validated.checkpoint, identity, ...wallets });
    succeeded = true;
    return {
      checkpoint: validated.checkpoint,
      configuration,
      identity,
      profileLockPath: validated.profileLockPath,
      wallets
    };
  } finally {
    if (!succeeded) clearIdentity(identity);
  }
};

export async function validateSdk12CheckpointReadOnly(input: {
  checkpointPath: string;
  endpoints: Sdk12EndpointConfig;
  masterSeedHex: string;
  timeoutMs: number;
}): Promise<{ checkpointGeneration: string; profileLockPath: string }> {
  const loaded = await loadSdk12Checkpoint(input);
  try {
    return { checkpointGeneration: loaded.checkpoint.generation, profileLockPath: loaded.profileLockPath };
  } finally {
    clearIdentity(loaded.identity);
  }
}

export async function restoreSdk12DeploymentWallet(input: {
  checkpointPath: string;
  endpoints: Sdk12EndpointConfig;
  masterSeedHex: string;
  timeoutMs: number;
  validateChain?: boolean;
}): Promise<RestoredSdk12DeploymentWallet> {
  const loaded = await loadSdk12Checkpoint(input);
  let succeeded = false;
  try {
    const facade = await WalletFacade.init({
      configuration: loaded.configuration,
      dust: () => loaded.wallets.dust,
      shielded: () => loaded.wallets.shielded,
      unshielded: () => loaded.wallets.unshielded
    });
    const provider = new Sdk12DeploymentWalletProvider(facade, loaded.identity);
    succeeded = true;
    return {
      checkpointGeneration: loaded.checkpoint.generation,
      profileLockPath: loaded.profileLockPath,
      provider,
      toolchain: SDK12_DEPLOYMENT_TOOLCHAIN
    };
  } finally {
    if (!succeeded) clearIdentity(loaded.identity);
  }
}

export type Sdk12FacadeStateSource = { state(): Observable<{ isSynced: boolean; dust: { balance(at: Date): bigint } }> };
