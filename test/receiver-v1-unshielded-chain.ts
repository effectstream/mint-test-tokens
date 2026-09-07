// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { createUnprovenCallTx, submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout } from "rxjs";
import * as Receiver from "../contracts/v1/managed/receiver/contract/index.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const seed = (await readFile(resolve(required("MN_SEED_FILE")), "utf8")).trim();
if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("Seed file must contain exactly 32 bytes of hex");
const receiverAddress = required("MN_RECEIVER_ADDRESS");
const issuerAddress = required("MN_UNSHIELDED_ISSUER_ADDRESS");
if (!/^[0-9a-f]{64}$/i.test(receiverAddress) || !/^[0-9a-f]{64}$/i.test(issuerAddress)) {
  throw new Error("Contract addresses must be 32 bytes of hex");
}

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
const receiverPath = resolve(root, "contracts/v1/managed/receiver");
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
const hexBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));

const receiverCompiled = CompiledContract.make(
  "receiver-test-fixture",
  Receiver.Contract as never,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(receiverPath),
);

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
  const runId = `${process.pid}-${Date.now()}`;
  const receiverProviders = initializeMidnightProviders(signerWallet, env, {
    privateStateStoreName: resolve(root, `.local/receiver-unshielded-resume-${runId}`),
    zkConfigPath: receiverPath,
  });
  const tokenId = ledger.rawTokenType(bytes32("mint-test-tokens:utwBTC"), issuerAddress);
  const tokenColor = hexBytes(tokenId);
  const expectedAmount = 1_000_000n;
  const balanceBefore = await withTimeout(
    "receiver unshielded balance query",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getUnshieldedBalance",
      args: [tokenColor],
    } as never),
  );
  assert.equal(balanceBefore.private.result, expectedAmount);

  const recipientAddress = recipientWallet.unshieldedKeystore.getAddress();
  const spend = await withTimeout(
    "receiver unshielded spend construction",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "spendUnshieldedToken",
      args: [
        {
          is_left: false,
          left: { bytes: new Uint8Array(32) },
          right: { bytes: hexBytes(recipientAddress) },
        },
        tokenColor,
        expectedAmount,
      ],
    } as never),
  );
  const finalized = await withTimeout(
    "receiver unshielded spend submit",
    submitTx(receiverProviders as never, {
      unprovenTx: spend.private.unprovenTx,
      circuitId: "spendUnshieldedToken",
    } as never),
  );
  await firstValueFrom(
    recipientWallet.wallet.state().pipe(
      filter(
        (state) =>
          state.isSynced &&
          (state.unshielded.balances[tokenId] ?? 0n) >= expectedAmount,
      ),
      timeout({ first: timeoutMs }),
    ),
  );
  const balanceAfter = await withTimeout(
    "receiver unshielded post-spend balance query",
    createUnprovenCallTx(receiverProviders as never, {
      compiledContract: receiverCompiled as never,
      contractAddress: receiverAddress,
      circuitId: "getUnshieldedBalance",
      args: [tokenColor],
    } as never),
  );
  assert.equal(balanceAfter.private.result, 0n);
  console.log(JSON.stringify({
    profile: "v1",
    resumed: true,
    receiverAddress,
    issuerAddress,
    tokenId,
    transaction: { unshieldedSpend: finalized.txId },
    balances: {
      receiverBefore: expectedAmount.toString(),
      receiverAfter: "0",
      recipientDiscovered: expectedAmount.toString(),
    },
  }));
} finally {
  await Promise.allSettled([recipientWallet.stop(), signerWallet.stop()]);
}
