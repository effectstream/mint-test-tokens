import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract, withContractScopedTransaction } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout } from "rxjs";
import * as Shielded from "../contracts/v1/managed/shielded/contract/index.js";
import * as Unshielded from "../contracts/v1/managed/unshielded/contract/index.js";
import { validateRegistry } from "../packages/registry/src/semantic.js";
import { TOKEN_DEFINITIONS } from "../packages/registry/src/tokens.js";
import type { NetworkKey, TokenRegistry } from "../packages/registry/src/types.js";
import { endpointConfig } from "./lib/network-config.js";

const TIMEOUT_MS = Number(process.env.MN_TIMEOUT_MS ?? 180_000);
const networkKey = (process.env.MN_NETWORK?.trim() ?? "undeployed") as NetworkKey;
if (!(["preview", "preprod", "undeployed"] as string[]).includes(networkKey)) throw new Error("v1 wallet test supports preview|preprod|undeployed");
const endpoints = endpointConfig(networkKey);
const root = resolve(new URL("..", import.meta.url).pathname);

const readSeed = async (name: string): Promise<string> => {
  const path = process.env[name]?.trim();
  if (!path) throw new Error(`Set ${name} to a private 32-byte hex seed file`);
  const value = (await readFile(resolve(path), "utf8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must contain exactly 32 bytes of hex`);
  return value;
};
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const zero = new Uint8Array(32);
const moduleFor = (privacy: "shielded" | "unshielded") => privacy === "shielded" ? Shielded : Unshielded;
const artifactPath = (privacy: "shielded" | "unshielded") => resolve(root, "contracts", "v1", "managed", privacy);
const selectedSymbol = process.env.MN_TOKEN_SYMBOL?.trim();
const selectedTokens = selectedSymbol ? TOKEN_DEFINITIONS.filter((token) => token.symbol === selectedSymbol) : TOKEN_DEFINITIONS;
if (!selectedTokens.length) throw new Error(`Unknown MN_TOKEN_SYMBOL=${selectedSymbol}`);
const waitSynced = async (wallet: MidnightWalletProvider) => firstValueFrom(wallet.wallet.state().pipe(
  filter((state) => state.isSynced),
  timeout({ first: TIMEOUT_MS })
));
const withTimeout = async <T>(label: string, operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const registry = JSON.parse(await readFile(resolve(root, "metadata", `metadata.${networkKey}.json`), "utf8")) as TokenRegistry;
const validation = validateRegistry(registry, networkKey);
if (!validation.ok || registry.status !== "ready" || registry.network.protocolFamily !== "midnight-1.x") {
  throw new Error(`A ready v1 registry is required: ${validation.ok ? registry.status : validation.errors.join("; ")}`);
}
const walletNetworkId = networkKey === "preview" ? NetworkId.NetworkId.Preview
  : networkKey === "preprod" ? NetworkId.NetworkId.PreProd
    : NetworkId.NetworkId.Undeployed;
const env = {
  walletNetworkId,
  networkId: endpoints.networkId,
  indexer: endpoints.indexer,
  indexerWS: endpoints.indexerWS,
  node: endpoints.node,
  nodeWS: endpoints.nodeWS,
  proofServer: endpoints.proofServer,
  faucet: undefined
};
setNetworkId(endpoints.networkId);
const logger = pino({ level: "silent" });
const [deployer, recipient] = await Promise.all([
  MidnightWalletProvider.build(logger, env, await readSeed("MN_SEED_FILE")),
  MidnightWalletProvider.build(logger, env, await readSeed("MN_RECIPIENT_SEED_FILE"))
]);
await Promise.all([deployer.start(true), recipient.start(false)]);

try {
  await Promise.all([waitSynced(deployer), waitSynced(recipient)]);
  const coinPublicKey = recipient.getCoinPublicKey();
  const encryptionPublicKey = recipient.getEncryptionPublicKey();
  const userAddress = recipient.unshieldedKeystore.getAddress();
  const returnAddresses = {
    shielded: await deployer.wallet.shielded.getAddress(),
    unshielded: await deployer.wallet.unshielded.getAddress()
  };
  for (const definition of selectedTokens) {
    const token = registry.tokens.find((item) => item.symbol === definition.symbol)!;
    const active = token.deployments.find((item) => item.deploymentId === token.activeDeploymentId && item.status === "active")!;
    const stateBefore = await waitSynced(recipient);
    const balancesBefore = definition.privacy === "shielded" ? stateBefore.shielded.balances : stateBefore.unshielded.balances;
    const before = balancesBefore[active.tokenId] ?? 0n;
    const path = artifactPath(definition.privacy);
    const providers = initializeMidnightProviders(deployer, env, {
      privateStateStoreName: resolve(root, ".local", "mint-wallet-v1"),
      zkConfigPath: path
    });
    const contractModule = moduleFor(definition.privacy);
    const compiled = CompiledContract.make(`mint-test-token-${definition.privacy}`, contractModule.Contract as never).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(path)
    );
    const contract = await findDeployedContract(providers as never, {
      compiledContract: compiled as never,
      contractAddress: active.contractAddress
    } as never);
    const amount = BigInt(definition.faucet.baseUnits);
    const finalized = await withTimeout(`${definition.symbol} mint`, definition.privacy === "shielded"
      ? withContractScopedTransaction(providers as never, async (txContext) => {
        await contract.callTx.mint(txContext, {
          is_left: true,
          left: { bytes: bytes(coinPublicKey) },
          right: { bytes: zero }
        }, amount, Uint8Array.from(randomBytes(32)));
      }, { additionalCoinEncPublicKeyMappings: new Map([[coinPublicKey, encryptionPublicKey]]) })
      : withContractScopedTransaction(providers as never, async (txContext) => {
        await contract.callTx.mint(txContext, {
          is_left: false,
          left: { bytes: zero },
          right: { bytes: bytes(userAddress) }
        }, amount);
      }));
    const stateAfterMint = await firstValueFrom(recipient.wallet.state().pipe(
      filter((state) => state.isSynced && ((definition.privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[active.tokenId] ?? 0n) >= before + amount),
      timeout({ first: TIMEOUT_MS })
    ));
    console.log(`[mint-wallet] ${definition.symbol} amount=${amount} tx=${finalized.public.txId} discovered=true`);

    const recipientAfterMint = (definition.privacy === "shielded" ? stateAfterMint.shielded.balances : stateAfterMint.unshielded.balances)[active.tokenId] ?? 0n;
    const returnStateBefore = await waitSynced(deployer);
    const returnBefore = (definition.privacy === "shielded" ? returnStateBefore.shielded.balances : returnStateBefore.unshielded.balances)[active.tokenId] ?? 0n;
    const recipe = await withTimeout(`${definition.symbol} spend construction`, recipient.wallet.transferTransaction([{
      type: definition.privacy,
      outputs: [{ type: active.tokenId as never, amount, receiverAddress: returnAddresses[definition.privacy] as never }]
    }], {
      shieldedSecretKeys: recipient.zswapSecretKeys,
      dustSecretKey: recipient.dustSecretKey
    }, { ttl: new Date(Date.now() + 30 * 60 * 1000) }));
    const signedRecipe = definition.privacy === "unshielded"
      ? await withTimeout(`${definition.symbol} spend signature`, recipient.wallet.signRecipe(recipe, (payload) => recipient.unshieldedKeystore.signData(payload)))
      : recipe;
    const finalizedSpend = await withTimeout(`${definition.symbol} spend finalization`, recipient.wallet.finalizeRecipe(signedRecipe));
    const spendTxId = await withTimeout(`${definition.symbol} spend submission`, recipient.wallet.submitTransaction(finalizedSpend));
    console.log(`[spend-wallet] ${definition.symbol} amount=${amount} tx=${spendTxId} submitted=true`);
    await firstValueFrom(recipient.wallet.state().pipe(
        filter((state) => state.isSynced && ((definition.privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[active.tokenId] ?? 0n) <= recipientAfterMint - amount),
        timeout({ first: TIMEOUT_MS })
      )).catch((error) => { throw new Error(`${definition.symbol} recipient spend balance did not synchronize: ${error instanceof Error ? error.message : String(error)}`); });
    await firstValueFrom(deployer.wallet.state().pipe(
        filter((state) => state.isSynced && ((definition.privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[active.tokenId] ?? 0n) >= returnBefore + amount),
        timeout({ first: TIMEOUT_MS })
      )).catch((error) => { throw new Error(`${definition.symbol} return-wallet balance did not synchronize: ${error instanceof Error ? error.message : String(error)}`); });
    console.log(`[spend-wallet] ${definition.symbol} amount=${amount} tx=${spendTxId} recipientSpent=true`);
  }
} finally {
  await Promise.all([deployer.stop(), recipient.stop()]);
}
