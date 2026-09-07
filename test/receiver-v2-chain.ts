// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnightntwrk/ledger-v9";
import {
  createUnprovenCallTx,
  deployContract,
  getPublicStates,
  submitTx,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { ZKConfigProvider } from "@midnight-ntwrk/midnight-js-types";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnightntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout } from "rxjs";
import * as Receiver from "../contracts/v2/managed/receiver/contract/index.js";
import * as ShieldedIssuer from "../contracts/v2/managed/shielded/contract/index.js";
import * as UnshieldedIssuer from "../contracts/v2/managed/unshielded/contract/index.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const seed = (await readFile(resolve(required("MN_SEED_FILE")), "utf8")).trim();
if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("Seed file must contain exactly 32 bytes of hex");

const env = {
  walletNetworkId: NetworkId.NetworkId.Undeployed,
  networkId: "undeployed",
  indexer: required("MN_INDEXER_URL"),
  indexerWS: required("MN_INDEXER_WS_URL"),
  node: required("MN_NODE_URL"),
  nodeWS: required("MN_NODE_WS_URL"),
  proofServer: required("MN_PROOF_SERVER_URL"),
  faucet: undefined,
};
const timeoutMs = Number(process.env.MN_TIMEOUT_MS ?? 240_000);
const root = resolve(new URL("..", import.meta.url).pathname);
const runId = `${process.pid}-${Date.now()}`;
const logger = pino({ level: "silent" });

const withTimeout = async <T>(label: string, promise: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const bytes32 = (text: string): Uint8Array => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > 32) throw new Error(`value exceeds 32 bytes: ${text}`);
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
};

const shieldedPath = resolve(root, "contracts/v2/managed/shielded");
const unshieldedPath = resolve(root, "contracts/v2/managed/unshielded");
const receiverPath = resolve(root, "contracts/v2/managed/receiver");

const shieldedCompiled = CompiledContract.make(
  "receiver-test-shielded-issuer",
  ShieldedIssuer.Contract as never,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(shieldedPath),
);
const unshieldedCompiled = CompiledContract.make(
  "receiver-test-unshielded-issuer",
  UnshieldedIssuer.Contract as never,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(unshieldedPath),
);
const receiverCompiled = CompiledContract.make(
  "receiver-test-fixture",
  Receiver.Contract as never,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(receiverPath),
);

class RoutingZkConfigProvider extends ZKConfigProvider<string> {
  constructor(
    private readonly route: (circuitId: string) => NodeZkConfigProvider<string>,
  ) {
    super();
  }

  getProverKey(circuitId: string) {
    return this.route(circuitId).getProverKey(circuitId);
  }

  getVerifierKey(circuitId: string) {
    return this.route(circuitId).getVerifierKey(circuitId);
  }

  getZKIR(circuitId: string) {
    return this.route(circuitId).getZKIR(circuitId);
  }
}

type RawCall = {
  public: { partitionedTranscript: ledger.PartitionedTranscript };
  private: {
    input: ledger.AlignedValue;
    output: ledger.AlignedValue;
    privateTranscriptOutputs: ledger.AlignedValue[];
    unprovenTx: ledger.UnprovenTransaction;
  };
};

type SerializableContractState = { serialize(): Uint8Array };

const callPrototype = (
  address: ledger.ContractAddress,
  circuitId: string,
  state: SerializableContractState,
  call: RawCall,
  communicationRandomness: ledger.CommunicationCommitmentRand,
): ledger.ContractCallPrototype => {
  const operation = ledger.ContractState.deserialize(state.serialize()).operation(circuitId);
  assert.ok(operation, `missing ${circuitId} operation at ${address}`);
  return new ledger.ContractCallPrototype(
    address,
    circuitId,
    operation,
    call.public.partitionedTranscript[0],
    call.public.partitionedTranscript[1],
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationRandomness,
    circuitId,
  );
};

const composeClaimedIssuerCall = (
  issuerCallPrototype: ledger.ContractCallPrototype,
  issuerCallCommitment: ledger.CommunicationCommitment,
  receiverAddress: ledger.ContractAddress,
  receiverState: SerializableContractState,
  receiverCircuitId: string,
  receiverCall: RawCall,
): ledger.UnprovenTransaction => {
  const receiverTx = receiverCall.private.unprovenTx;
  const fallibleOffers = [...(receiverTx.fallibleOffer?.values() ?? [])];
  assert.ok(fallibleOffers.length <= 1, "single receiver call must have at most one fallible offer");
  const intent = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000))
    .addCall(issuerCallPrototype)
    .addCall(callPrototype(
      receiverAddress,
      receiverCircuitId,
      receiverState,
      receiverCall,
      ledger.communicationCommitmentRandomness(),
    ));
  const realIssuerCalls = intent.actions.filter(
    (action): action is ledger.ContractCall<ledger.PreProof> =>
      "communicationCommitment" in action &&
      action.communicationCommitment === issuerCallCommitment,
  );
  assert.equal(
    realIssuerCalls.length,
    1,
    "final intent must contain exactly one issuer call with the claimed commitment",
  );
  return ledger.Transaction.fromPartsRandomized(
    env.networkId,
    receiverTx.guaranteedOffer,
    fallibleOffers[0],
    intent,
  );
};

const callCommitment = (
  prototype: ledger.ContractCallPrototype,
): ledger.CommunicationCommitment => {
  const probe = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000)).addCall(prototype);
  assert.equal(probe.actions.length, 1, "issuer commitment probe must contain one call");
  const call = probe.actions[0];
  assert.ok("communicationCommitment" in call, "issuer action must be a contract call");
  return call.communicationCommitment;
};

const hexBytes = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));

const hexField = (value: string): bigint => {
  const encoded = hexBytes(value);
  assert.ok(encoded.length > 0, "empty serialized field");
  const mode = encoded[0] & 0b11;
  if (mode === 0b11) {
    const payloadLength = (encoded[0] >> 2) + 4;
    assert.equal(encoded.length, payloadLength + 1, "invalid SCALE field length");
    const littleEndian = encoded.slice(1);
    const decoded = BigInt(`0x${Buffer.from(littleEndian).reverse().toString("hex") || "0"}`);
    assert.ok(decoded <= ledger.maxField(), "decoded field exceeds scalar modulus");
    return decoded;
  }
  const encodedLength = 1 << mode;
  assert.equal(encoded.length, encodedLength, "invalid compact SCALE field length");
  let compact = 0n;
  for (let index = encodedLength - 1; index >= 0; index -= 1) {
    compact = (compact << 8n) | BigInt(encoded[index]);
  }
  return compact >> 2n;
};

const signerWallet = await withTimeout(
  "signer wallet build",
  MidnightWalletProvider.build(logger, env, seed),
);
const recipientWallet = await withTimeout(
  "recipient wallet build",
  MidnightWalletProvider.build(logger, env, randomBytes(32).toString("hex")),
);

setNetworkId("undeployed");
await withTimeout("signer wallet start", signerWallet.start(true));
await withTimeout("recipient wallet start", recipientWallet.start(false));

try {
  const provider = (zkConfigPath: string, label: string) =>
    initializeMidnightProviders(signerWallet, env, {
      privateStateStoreName: resolve(root, `.local/receiver-chain-v2-${runId}-${label}`),
      zkConfigPath,
    });
  const shieldedProviders = provider(shieldedPath, "shielded");
  const unshieldedProviders = provider(unshieldedPath, "unshielded");
  const receiverProviders = provider(receiverPath, "receiver");

  const receiverDeploy = await withTimeout(
    "receiver deploy",
    deployContract(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      args: [],
    } as never),
  );
  const receiverAddress = receiverDeploy.deployTxData.public.contractAddress;
  const receiverAddressBytes = ledger.encodeContractAddress(receiverAddress);
  const shieldedDeploy = await withTimeout(
    "shielded issuer deploy",
    deployContract(shieldedProviders as never, {
      compiledContract: shieldedCompiled as never,
      args: ["Test Wrapped Bitcoin", "twBTC", 8n, bytes32("mint-test-tokens:twBTC")],
    } as never),
  );
  const shieldedIssuerAddress = shieldedDeploy.deployTxData.public.contractAddress;
  const unshieldedDeploy = await withTimeout(
    "unshielded issuer deploy",
    deployContract(unshieldedProviders as never, {
      compiledContract: unshieldedCompiled as never,
      args: ["Unshielded Test Wrapped BTC", "utwBTC", 8n, bytes32("mint-test-tokens:utwBTC")],
    } as never),
  );
  const unshieldedIssuerAddress = unshieldedDeploy.deployTxData.public.contractAddress;

  const zeroBytes = new Uint8Array(32);
  const shieldedAmount = 100_000_000n;
  const shieldedIssuerState = (
    await getPublicStates(shieldedProviders.publicDataProvider, shieldedIssuerAddress)
  ).contractState;
  const receiverStateBeforeShielded = (
    await getPublicStates(receiverProviders.publicDataProvider, receiverAddress)
  ).contractState;
  const shieldedMint = await withTimeout(
    "shielded mint call construction",
    createUnprovenCallTx(shieldedProviders as never, {
      compiledContract: shieldedCompiled as never,
      contractAddress: shieldedIssuerAddress,
      circuitId: "mint",
      args: [
        {
          is_left: false,
          left: { bytes: zeroBytes },
          right: { bytes: receiverAddressBytes },
        },
        shieldedAmount,
        Uint8Array.from(randomBytes(32)),
      ],
    } as never),
  );
  const shieldedIssuerCallRandomness = ledger.communicationCommitmentRandomness();
  const shieldedIssuerCallPrototype = callPrototype(
    shieldedIssuerAddress,
    "mint",
    shieldedIssuerState,
    shieldedMint as unknown as RawCall,
    shieldedIssuerCallRandomness,
  );
  const shieldedIssuerCallCommitment = callCommitment(shieldedIssuerCallPrototype);
  const shieldedReceive = await withTimeout(
    "shielded receive call construction",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "receiveShieldedTokenFromIssuer",
      args: [
        ledger.encodeContractAddress(shieldedIssuerAddress),
        hexBytes(ledger.entryPointHash("mint")),
        hexField(shieldedIssuerCallCommitment),
        shieldedMint.private.result,
      ],
    } as never),
  );

  const shieldedZk = new NodeZkConfigProvider<string>(shieldedPath);
  const receiverZk = new NodeZkConfigProvider<string>(receiverPath);
  const shieldedRoutingZk = new RoutingZkConfigProvider((id) =>
    id === "mint" ? shieldedZk : receiverZk,
  );
  const shieldedMerged = composeClaimedIssuerCall(
    shieldedIssuerCallPrototype,
    shieldedIssuerCallCommitment,
    receiverAddress,
    receiverStateBeforeShielded,
    "receiveShieldedTokenFromIssuer",
    shieldedReceive as unknown as RawCall,
  );
  const shieldedMintReceiveTx = await withTimeout(
    "shielded merged mint and receive",
    submitTx(
      {
        ...shieldedProviders,
        zkConfigProvider: shieldedRoutingZk,
        proofProvider: httpClientProofProvider(env.proofServer, shieldedRoutingZk),
      } as never,
      {
        unprovenTx: shieldedMerged,
        circuitId: ["mint", "receiveShieldedTokenFromIssuer"],
      } as never,
    ),
  );
  console.log(JSON.stringify({ checkpoint: "shieldedMintReceive", txId: shieldedMintReceiveTx.txId }));

  const shieldedBalanceAfterReceive = await createUnprovenCallTx(
    receiverProviders as never,
    {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getShieldedBalance",
    } as never,
  );
  assert.equal(shieldedBalanceAfterReceive.private.result, shieldedAmount);

  const recipientCoinPublicKey = recipientWallet.getCoinPublicKey();
  const shieldedSpend = await withTimeout(
    "shielded spend call construction",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "spendShieldedToken",
      args: [
        {
          is_left: true,
          left: { bytes: Uint8Array.from(Buffer.from(recipientCoinPublicKey, "hex")) },
          right: { bytes: zeroBytes },
        },
        shieldedAmount,
      ],
      additionalCoinEncPublicKeyMappings: new Map([
        [recipientCoinPublicKey, recipientWallet.getEncryptionPublicKey()],
      ]),
    } as never),
  );
  const shieldedSpendTx = await withTimeout(
    "shielded spend submit",
    submitTx(receiverProviders as never, {
      unprovenTx: shieldedSpend.private.unprovenTx,
      circuitId: "spendShieldedToken",
    } as never),
  );
  console.log(JSON.stringify({ checkpoint: "shieldedSpend", txId: shieldedSpendTx.txId }));
  const shieldedTokenId = ledger.rawTokenType(
    bytes32("mint-test-tokens:twBTC"),
    shieldedIssuerAddress,
  );
  await firstValueFrom(
    recipientWallet.wallet.state().pipe(
      filter(
        (state) =>
          state.isSynced &&
          (state.shielded.balances[shieldedTokenId] ?? 0n) >= shieldedAmount,
      ),
      timeout({ first: timeoutMs }),
    ),
  );
  const shieldedBalanceAfterSpend = await createUnprovenCallTx(
    receiverProviders as never,
    {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getShieldedBalance",
    } as never,
  );
  assert.equal(shieldedBalanceAfterSpend.private.result, 0n);

  const unshieldedAmount = 1_000_000n;
  const unshieldedIssuerState = (
    await getPublicStates(unshieldedProviders.publicDataProvider, unshieldedIssuerAddress)
  ).contractState;
  const receiverStateBeforeUnshielded = (
    await getPublicStates(receiverProviders.publicDataProvider, receiverAddress)
  ).contractState;
  const unshieldedMint = await withTimeout(
    "unshielded mint call construction",
    createUnprovenCallTx(unshieldedProviders as never, {
      compiledContract: unshieldedCompiled as never,
      contractAddress: unshieldedIssuerAddress,
      circuitId: "mint",
      args: [
        {
          is_left: true,
          left: { bytes: receiverAddressBytes },
          right: { bytes: zeroBytes },
        },
        unshieldedAmount,
      ],
    } as never),
  );
  const unshieldedIssuerCallRandomness = ledger.communicationCommitmentRandomness();
  const unshieldedIssuerCallPrototype = callPrototype(
    unshieldedIssuerAddress,
    "mint",
    unshieldedIssuerState,
    unshieldedMint as unknown as RawCall,
    unshieldedIssuerCallRandomness,
  );
  const unshieldedIssuerCallCommitment = callCommitment(unshieldedIssuerCallPrototype);
  const unshieldedReceive = await withTimeout(
    "unshielded receive call construction",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "receiveUnshieldedTokenFromIssuer",
      args: [
        ledger.encodeContractAddress(unshieldedIssuerAddress),
        hexBytes(ledger.entryPointHash("mint")),
        hexField(unshieldedIssuerCallCommitment),
        unshieldedMint.private.result,
        unshieldedAmount,
      ],
    } as never),
  );
  const unshieldedZk = new NodeZkConfigProvider<string>(unshieldedPath);
  const unshieldedRoutingZk = new RoutingZkConfigProvider((id) =>
    id === "mint" ? unshieldedZk : receiverZk,
  );
  const unshieldedMintReceiveTx = await withTimeout(
    "unshielded merged mint and receive",
    submitTx(
      {
        ...unshieldedProviders,
        zkConfigProvider: unshieldedRoutingZk,
        proofProvider: httpClientProofProvider(env.proofServer, unshieldedRoutingZk),
      } as never,
      {
        unprovenTx: composeClaimedIssuerCall(
          unshieldedIssuerCallPrototype,
          unshieldedIssuerCallCommitment,
          receiverAddress,
          receiverStateBeforeUnshielded,
          "receiveUnshieldedTokenFromIssuer",
          unshieldedReceive as unknown as RawCall,
        ),
        circuitId: ["mint", "receiveUnshieldedTokenFromIssuer"],
      } as never,
    ),
  );
  console.log(JSON.stringify({ checkpoint: "unshieldedMintReceive", txId: unshieldedMintReceiveTx.txId }));
  const unshieldedTokenId = ledger.rawTokenType(
    bytes32("mint-test-tokens:utwBTC"),
    unshieldedIssuerAddress,
  );
  const receiverBalance = await withTimeout(
    "receiver unshielded balance query",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getUnshieldedBalance",
      args: [unshieldedMint.private.result],
    } as never),
  );
  assert.equal(receiverBalance.private.result, unshieldedAmount);

  const recipientUserAddress = recipientWallet.unshieldedKeystore.getAddress();
  const unshieldedSpend = await withTimeout(
    "unshielded spend call construction",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "spendUnshieldedToken",
      args: [
        {
          is_left: false,
          left: { bytes: zeroBytes },
          right: { bytes: Uint8Array.from(Buffer.from(recipientUserAddress, "hex")) },
        },
        unshieldedMint.private.result,
        unshieldedAmount,
      ],
    } as never),
  );
  const unshieldedSpendTx = await withTimeout(
    "unshielded spend submit",
    submitTx(receiverProviders as never, {
      unprovenTx: unshieldedSpend.private.unprovenTx,
      circuitId: "spendUnshieldedToken",
    } as never),
  );
  console.log(JSON.stringify({ checkpoint: "unshieldedSpend", txId: unshieldedSpendTx.txId }));
  await firstValueFrom(
    recipientWallet.wallet.state().pipe(
      filter(
        (state) =>
          state.isSynced &&
          (state.unshielded.balances[unshieldedTokenId] ?? 0n) >= unshieldedAmount,
      ),
      timeout({ first: timeoutMs }),
    ),
  );
  const receiverBalanceAfterSpend = await withTimeout(
    "receiver unshielded post-spend balance query",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getUnshieldedBalance",
      args: [unshieldedMint.private.result],
    } as never),
  );
  assert.equal(receiverBalanceAfterSpend.private.result, 0n);

  console.log(
    JSON.stringify({
      profile: "v2",
      receiverAddress,
      shieldedIssuerAddress,
      unshieldedIssuerAddress,
      shieldedTokenId,
      unshieldedTokenId,
      transactions: {
        receiverDeploy: receiverDeploy.deployTxData.public.txId ?? null,
        shieldedIssuerDeploy: shieldedDeploy.deployTxData.public.txId ?? null,
        unshieldedIssuerDeploy: unshieldedDeploy.deployTxData.public.txId ?? null,
        shieldedMintReceive: shieldedMintReceiveTx.txId,
        shieldedSpend: shieldedSpendTx.txId,
        unshieldedMintReceive: unshieldedMintReceiveTx.txId,
        unshieldedSpend: unshieldedSpendTx.txId,
      },
      balances: {
        receiverShieldedAfterReceive: shieldedAmount.toString(),
        receiverShieldedAfterSpend: "0",
        recipientShieldedDiscovered: shieldedAmount.toString(),
        receiverUnshieldedAfterReceive: unshieldedAmount.toString(),
        receiverUnshieldedAfterSpend: "0",
        recipientUnshieldedDiscovered: unshieldedAmount.toString(),
      },
    }),
  );
} finally {
  await Promise.allSettled([recipientWallet.stop(), signerWallet.stop()]);
}
