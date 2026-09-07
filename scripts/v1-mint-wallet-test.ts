import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract, withContractScopedTransaction } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout, type Observable } from "rxjs";
import * as Shielded from "../contracts/v1/managed/shielded/contract/index.js";
import * as Unshielded from "../contracts/v1/managed/unshielded/contract/index.js";
import { validateRegistry } from "../packages/registry/src/semantic.js";
import { TOKEN_DEFINITIONS } from "../packages/registry/src/tokens.js";
import type { NetworkKey, TokenRegistry } from "../packages/registry/src/types.js";
import { waitForFundedDeploymentWallet } from "./lib/deployment-wallet.js";
import { endpointConfig } from "./lib/network-config.js";
import { validateMasterSeedHex } from "./lib/wallet-seed.js";

const TIMEOUT_MS = Number(process.env.MN_TIMEOUT_MS ?? 180_000);
const networkKey = (process.env.MN_NETWORK?.trim() ?? "undeployed") as NetworkKey;
if (!(["preview", "preprod", "undeployed"] as string[]).includes(networkKey)) throw new Error("v1 wallet test supports preview|preprod|undeployed");
const endpoints = endpointConfig(networkKey);
const root = resolve(new URL("..", import.meta.url).pathname);
const checkpointPath = process.env.MN_WALLET_CHECKPOINT_FILE?.trim();
if (checkpointPath && networkKey !== "preprod") throw new Error("MN_WALLET_CHECKPOINT_FILE is supported only with MN_NETWORK=preprod");
if (checkpointPath && process.env.MN_SKIP_RECIPIENT_SPEND !== "1") {
  throw new Error("Checkpoint-backed public smoke requires MN_SKIP_RECIPIENT_SPEND=1");
}

interface HeldWalletCliProfileLock {
  verify(): Promise<void>;
}

const readSeed = async (name: string): Promise<string> => {
  const path = process.env[name]?.trim();
  if (!path) throw new Error(`Set ${name} to a private 32- or 64-byte hex seed file`);
  return validateMasterSeedHex((await readFile(resolve(path), "utf8")).trim(), name);
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
type RecipientTokenState = { balances: Record<string, bigint> };
const waitRecipientState = async (wallet: MidnightWalletProvider, privacy: "shielded" | "unshielded"): Promise<RecipientTokenState> => {
  const synchronized: Promise<RecipientTokenState> = privacy === "shielded"
    ? wallet.wallet.shielded.waitForSyncedState()
    : wallet.wallet.unshielded.waitForSyncedState();
  return withTimeout(`recipient ${privacy} sync`, synchronized);
};
const withTimeout = async <T>(label: string, operation: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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
async function runMintWalletTest(
  deployer: MidnightWalletProvider,
  checkpointLock?: HeldWalletCliProfileLock
): Promise<void> {
  let recipient: MidnightWalletProvider | undefined;
  let operationError: unknown;
  try {
    const recipientWallet = await MidnightWalletProvider.build(logger, env, await readSeed("MN_RECIPIENT_SEED_FILE"));
    recipient = recipientWallet;
    const started = await Promise.allSettled([deployer.start(false), recipientWallet.start(false)]);
    const startFailure = started.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (startFailure) throw startFailure.reason;
    await waitForFundedDeploymentWallet(deployer.wallet, TIMEOUT_MS);
    await checkpointLock?.verify();
    if (checkpointPath) {
      await Promise.all([
        waitRecipientState(recipientWallet, "shielded"),
        waitRecipientState(recipientWallet, "unshielded")
      ]);
    } else {
      await waitSynced(recipientWallet);
    }

    const recipientTokenState = async (privacy: "shielded" | "unshielded"): Promise<RecipientTokenState> => {
      if (checkpointPath) return waitRecipientState(recipientWallet, privacy);
      const state = await waitSynced(recipientWallet);
      return { balances: privacy === "shielded" ? state.shielded.balances : state.unshielded.balances };
    };
    const coinPublicKey = recipientWallet.getCoinPublicKey();
    const encryptionPublicKey = recipientWallet.getEncryptionPublicKey();
    const userAddress = recipientWallet.unshieldedKeystore.getAddress();
    const returnAddresses = {
      shielded: await deployer.wallet.shielded.getAddress(),
      unshielded: await deployer.wallet.unshielded.getAddress()
    };

    for (const definition of selectedTokens) {
      const token = registry.tokens.find((item) => item.symbol === definition.symbol)!;
      const active = token.deployments.find((item) => item.deploymentId === token.activeDeploymentId && item.status === "active")!;
      const stateBefore = await recipientTokenState(definition.privacy);
      const before = stateBefore.balances[active.tokenId] ?? 0n;
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
      await checkpointLock?.verify();
      console.log(`[mint-wallet] ${definition.symbol} amount=${amount} intent=true`);
      const mintOperation = definition.privacy === "shielded"
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
      });
      const finalized = checkpointPath ? await mintOperation : await withTimeout(`${definition.symbol} mint`, mintOperation);
      await checkpointLock?.verify();
      console.log(`[mint-wallet] ${definition.symbol} amount=${amount} tx=${finalized.public.txId} confirmed=true`);
      const recipientState: Observable<RecipientTokenState> = definition.privacy === "shielded"
        ? recipientWallet.wallet.shielded.state
        : recipientWallet.wallet.unshielded.state;
      const stateAfterMint = await firstValueFrom(recipientState.pipe(
        filter((state) => (state.balances[active.tokenId] ?? 0n) >= before + amount),
        timeout({ first: TIMEOUT_MS })
      ));
      console.log(`[mint-wallet] ${definition.symbol} amount=${amount} tx=${finalized.public.txId} discovered=true`);
      if (process.env.MN_SKIP_RECIPIENT_SPEND === "1") {
        console.log(`[spend-wallet] ${definition.symbol} skipped=true`);
        continue;
      }

      const recipientAfterMint = stateAfterMint.balances[active.tokenId] ?? 0n;
      const returnStateBefore = await waitSynced(deployer);
      const returnBefore = (definition.privacy === "shielded" ? returnStateBefore.shielded.balances : returnStateBefore.unshielded.balances)[active.tokenId] ?? 0n;
      const recipe = await withTimeout(`${definition.symbol} spend construction`, recipientWallet.wallet.transferTransaction([{
        type: definition.privacy,
        outputs: [{ type: active.tokenId as never, amount, receiverAddress: returnAddresses[definition.privacy] as never }]
      }], {
        shieldedSecretKeys: recipientWallet.zswapSecretKeys,
        dustSecretKey: recipientWallet.dustSecretKey
      }, { ttl: new Date(Date.now() + 30 * 60 * 1000) }));
      const signedRecipe = definition.privacy === "unshielded"
        ? await withTimeout(`${definition.symbol} spend signature`, recipientWallet.wallet.signRecipe(recipe, (payload) => recipientWallet.unshieldedKeystore.signData(payload)))
        : recipe;
      const finalizedSpend = await withTimeout(`${definition.symbol} spend finalization`, recipientWallet.wallet.finalizeRecipe(signedRecipe));
      const spendTxId = await withTimeout(`${definition.symbol} spend submission`, recipientWallet.wallet.submitTransaction(finalizedSpend));
      console.log(`[spend-wallet] ${definition.symbol} amount=${amount} tx=${spendTxId} submitted=true`);
      await firstValueFrom(recipientWallet.wallet.state().pipe(
        filter((state) => state.isSynced && ((definition.privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[active.tokenId] ?? 0n) <= recipientAfterMint - amount),
        timeout({ first: TIMEOUT_MS })
      )).catch((error) => { throw new Error(`${definition.symbol} recipient spend balance did not synchronize: ${error instanceof Error ? error.message : String(error)}`); });
      await firstValueFrom(deployer.wallet.state().pipe(
        filter((state) => state.isSynced && ((definition.privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[active.tokenId] ?? 0n) >= returnBefore + amount),
        timeout({ first: TIMEOUT_MS })
      )).catch((error) => { throw new Error(`${definition.symbol} return-wallet balance did not synchronize: ${error instanceof Error ? error.message : String(error)}`); });
      console.log(`[spend-wallet] ${definition.symbol} amount=${amount} tx=${spendTxId} recipientSpent=true`);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const stopped = await Promise.allSettled([
      checkpointPath ? deployer.stop() : withTimeout("deployer wallet stop", deployer.stop(), 10_000),
      ...(recipient ? [withTimeout("recipient wallet stop", recipient.stop(), 10_000)] : [])
    ]);
    const failure = stopped.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure && operationError === undefined) throw failure.reason;
    if (failure) {
      console.error(`[wallet-stop] cleanup failed after the operation error: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
    }
  }
}

if (checkpointPath) {
  const [{ checkpointProfileLockPath }, { restoreSdk12DeploymentWallet }, { withWalletCliProfileLock }] = await Promise.all([
    import("../wallet-adapters/v1-sdk12/checkpoint.js"),
    import("../wallet-adapters/v1-sdk12/provider.js"),
    import("../wallet-adapters/v1-sdk12/profile-lock.js")
  ]);
  await withWalletCliProfileLock(checkpointProfileLockPath(checkpointPath), async (lock) => {
    await lock.verify();
    const restored = await restoreSdk12DeploymentWallet({
      checkpointPath,
      endpoints,
      masterSeedHex: await readSeed("MN_SEED_FILE"),
      timeoutMs: TIMEOUT_MS
    });
    await runMintWalletTest(restored.provider as unknown as MidnightWalletProvider, lock);
  });
} else {
  const deployer = await MidnightWalletProvider.build(logger, env, await readSeed("MN_SEED_FILE"));
  await runMintWalletTest(deployer);
}
