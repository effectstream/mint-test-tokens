import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout } from "rxjs";
import * as Shielded from "../contracts/v1/managed/shielded/contract/index.js";

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
  faucet: undefined
};

setNetworkId("undeployed");
const logger = pino({ level: "silent" });
const wallet = await MidnightWalletProvider.build(logger, env, seed);
await wallet.start(true);

try {
  const zkConfigPath = resolve("contracts/v1/managed/shielded");
  const providers = initializeMidnightProviders(wallet, env, {
    privateStateStoreName: resolve(".local/v1-smoke-private-state"),
    zkConfigPath
  });
  const compiled = CompiledContract.make("mint-test-token-shielded", Shielded.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath)
  );
  const domain = new Uint8Array(32);
  domain.set(new TextEncoder().encode("mint-test-tokens:twBTC"));
  const deployed = await deployContract(providers as never, {
    compiledContract: compiled,
    args: ["Test-wrapped BTC", "twBTC", 8n, domain]
  });
  const contractAddress = deployed.deployTxData.public.contractAddress;
  const tokenId = ledger.rawTokenType(domain, contractAddress);
  const coinPublicKey = wallet.getCoinPublicKey();
  const recipient = {
    is_left: true,
    left: { bytes: Uint8Array.from(Buffer.from(coinPublicKey, "hex")) },
    right: { bytes: new Uint8Array(32) }
  };
  const amount = 100000000n;
  const mint = await deployed.callTx.mint(recipient, amount, Uint8Array.from(randomBytes(32)));
  await firstValueFrom(wallet.wallet.state().pipe(
    filter((state) => state.isSynced && (state.shielded.balances[tokenId] ?? 0n) >= amount),
    timeout({ first: 120_000 })
  ));
  console.log(JSON.stringify({
    contractAddress,
    tokenId,
    deploymentTransactionId: deployed.deployTxData.public.txId ?? null,
    mintTransactionId: mint.public.txId ?? null,
    discoveredBalance: amount.toString()
  }));
} finally {
  await wallet.stop();
}
