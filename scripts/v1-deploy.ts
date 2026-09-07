import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk";
import pino from "pino";
import * as Shielded from "../contracts/v1/managed/shielded/contract/index.js";
import * as Unshielded from "../contracts/v1/managed/unshielded/contract/index.js";
import { TOKEN_DEFINITIONS } from "../packages/registry/src/tokens.js";
import { validateRegistry } from "../packages/registry/src/semantic.js";
import type {
  CompatibilitySnapshot,
  DeploymentRecord,
  MaintenanceAuthorityStatus,
  NetworkIdentity,
  NetworkKey,
  TokenRegistry,
  TokenSymbol
} from "../packages/registry/src/types.js";
import { writeJsonAtomic, withFileLock } from "./lib/atomic-json.js";
import {
  beginDeployment,
  clearConfirmedAbsentIntent,
  completePendingDeployment,
  recordFinalizedDeployment,
  type DeploymentJournal
} from "./lib/deployment-journal.js";
import { endpointConfig, rpc } from "./lib/network-config.js";
import { deploymentRevision, markRegistryStale, publishReadyRegistry, readRegistry } from "./lib/registry-publisher.js";

const COMPATIBILITY: CompatibilitySnapshot = {
  profile: "v1",
  compiler: "0.31.1",
  compactRuntime: "0.16.0",
  ledger: "8.1.0",
  midnightJs: "4.1.1",
  walletSdk: "1.2.0"
};
const DEPLOYMENT_TOOLCHAIN = { runner: "@midnight-ntwrk/testkit-js", runnerVersion: "4.1.1", walletSdk: "1.1.0" } as const;
const TIMEOUT_MS = Number(process.env.MN_TIMEOUT_MS ?? 180_000);
const command = process.argv[2] ?? "deploy";
const rawNetwork = process.env.MN_NETWORK?.trim() ?? "undeployed";
if (!(["preview", "preprod", "undeployed"] as string[]).includes(rawNetwork)) {
  throw new Error("The v1 runner supports MN_NETWORK=preview|preprod|undeployed");
}
const networkKey = rawNetwork as NetworkKey;
const endpoints = endpointConfig(networkKey);
const root = resolve(new URL("..", import.meta.url).pathname);
const outputPath = resolve(root, "metadata", `metadata.${networkKey}.json`);

class DeploymentVerificationError extends Error {}
class MissingContractError extends DeploymentVerificationError {}

const withTimeout = async <T>(label: string, operation: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
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

const bytes32 = (text: string): Uint8Array => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > 32) throw new Error(`Domain exceeds 32 bytes: ${text}`);
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const asDate = (timestamp: number): string => new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp).toISOString();

async function hashDirectory(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await visit(directory);
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    hash.update(relative(directory, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function stackIdentity(): Promise<NetworkIdentity> {
  const [chainId, runtimeVersion, genesisHash] = await withTimeout("node identity", Promise.all([
    rpc<string>(endpoints.node, "system_chain"),
    rpc<string>(endpoints.node, "system_version"),
    rpc<string>(endpoints.node, "chain_getBlockHash", [0])
  ]));
  const stack = createHash("sha256").update(JSON.stringify({ chainId, runtimeVersion, genesisHash })).digest("hex");
  return {
    key: networkKey,
    displayName: endpoints.displayName,
    protocolFamily: "midnight-1.x",
    networkId: endpoints.networkId,
    chainId,
    stackIdentity: `${runtimeVersion}:${genesisHash}:${stack}`
  };
}

const moduleFor = (privacy: "shielded" | "unshielded") => privacy === "shielded" ? Shielded : Unshielded;
const artifactPath = (privacy: "shielded" | "unshielded") => resolve(root, "contracts", "v1", "managed", privacy);

async function verifyContract(
  token: (typeof TOKEN_DEFINITIONS)[number],
  contractAddress: string,
  publicData: Pick<PublicDataProvider, "queryContractState"> = indexerPublicDataProvider(endpoints.indexer, endpoints.indexerWS)
): Promise<{ tokenId: string; maintenanceAuthority: { status: MaintenanceAuthorityStatus; address: string | null } }> {
  const state = await withTimeout(`${token.symbol} state query`, publicData.queryContractState(contractAddress));
  if (!state) throw new MissingContractError(`${token.symbol}: no contract state at ${contractAddress}`);
  const localKeyDirectory = resolve(artifactPath(token.privacy), "keys");
  const localOps = (await readdir(localKeyDirectory)).filter((name) => name.endsWith(".verifier")).map((name) => name.slice(0, -9)).sort();
  const chainOps = state.operations().map((name) => typeof name === "string" ? name : Buffer.from(name).toString()).sort();
  if (localOps.join("\0") !== chainOps.join("\0")) throw new DeploymentVerificationError(`${token.symbol}: on-chain circuit set differs from local artifact`);
  for (const operation of localOps) {
    const local = new Uint8Array(await readFile(resolve(localKeyDirectory, `${operation}.verifier`)));
    const onChain = state.operation(operation)?.verifierKey;
    if (!onChain || !sameBytes(local, onChain)) throw new DeploymentVerificationError(`${token.symbol}: verifier key mismatch for ${operation}`);
  }
  const contractModule = moduleFor(token.privacy);
  const metadata = contractModule.ledger(state.data);
  const domain = bytes32(token.domainSeparator);
  if (metadata._name !== token.name || metadata._symbol !== token.symbol || metadata._decimals !== BigInt(token.decimals) || !sameBytes(metadata._domain, domain)) {
    throw new DeploymentVerificationError(`${token.symbol}: immutable on-chain metadata mismatch`);
  }
  const authority = state.maintenanceAuthority;
  const renounced = authority.committee.length === 0 && authority.threshold > 0;
  const address = renounced ? null : String(authority.committee[0] ?? "");
  return {
    tokenId: ledger.rawTokenType(domain, contractAddress),
    maintenanceAuthority: { status: renounced ? "renounced" : address ? "retained" : "unknown", address: address || null }
  };
}

async function verifyRegistry(registry: TokenRegistry): Promise<Map<TokenSymbol, DeploymentRecord>> {
  const validation = validateRegistry(registry, networkKey);
  if (!validation.ok) throw new Error(`Registry validation failed:\n${validation.errors.join("\n")}`);
  if (registry.status !== "ready") throw new Error(`${outputPath} is ${registry.status}, not ready`);
  const currentNetwork = await stackIdentity();
  if (registry.network.protocolFamily !== currentNetwork.protocolFamily || registry.network.chainId !== currentNetwork.chainId || registry.network.stackIdentity !== currentNetwork.stackIdentity) {
    throw new Error("Registry identity does not match the connected chain/runtime/genesis");
  }
  const verified = new Map<TokenSymbol, DeploymentRecord>();
  for (const token of registry.tokens) {
    const record = token.deployments.find((item) => item.deploymentId === token.activeDeploymentId && item.status === "active");
    if (!record) throw new Error(`${token.symbol}: missing selected active deployment`);
    const expected = TOKEN_DEFINITIONS.find((item) => item.symbol === token.symbol)!;
    const actual = await verifyContract(expected, record.contractAddress);
    if (actual.tokenId !== record.tokenId) throw new Error(`${token.symbol}: recorded token id mismatch`);
    verified.set(token.symbol, { ...record, verifiedAt: new Date().toISOString(), maintenanceAuthority: actual.maintenanceAuthority });
    console.log(`[verify] ${token.symbol} ${record.contractAddress} ${record.tokenId}`);
  }
  return verified;
}

async function deployAll(): Promise<void> {
  const seedPath = process.env.MN_SEED_FILE?.trim();
  if (!seedPath) throw new Error("Set MN_SEED_FILE to a private file containing exactly 32 bytes of hex");
  const seed = (await readFile(resolve(seedPath), "utf8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("MN_SEED_FILE must contain exactly 32 bytes of hex");
  const identity = await stackIdentity();
  const previousRegistry = await readRegistry(outputPath);
  if (previousRegistry?.status === "ready" && previousRegistry.network.key === identity.key &&
      (previousRegistry.network.protocolFamily !== identity.protocolFamily ||
       previousRegistry.network.chainId !== identity.chainId ||
       previousRegistry.network.stackIdentity !== identity.stackIdentity)) {
    await markRegistryStale(outputPath, identity);
  }
  const sourceRevision = process.env.SOURCE_REVISION?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("SOURCE_REVISION must be a full git SHA");
  const journalPath = resolve(root, ".local", "deployments", `v1-${networkKey}-${createHash("sha256").update(identity.stackIdentity!).digest("hex")}.json`);
  const walletNetworkId = networkKey === "preview" ? NetworkId.NetworkId.Preview
    : networkKey === "preprod" ? NetworkId.NetworkId.PreProd
      : NetworkId.NetworkId.Undeployed;
  setNetworkId(endpoints.networkId);
  const logger = pino({ level: "silent" });
  const wallet = await withTimeout("wallet build", MidnightWalletProvider.build(logger, {
    walletNetworkId,
    networkId: endpoints.networkId,
    indexer: endpoints.indexer,
    indexerWS: endpoints.indexerWS,
    node: endpoints.node,
    nodeWS: endpoints.nodeWS,
    proofServer: endpoints.proofServer,
    faucet: undefined
  }, seed));
  await withTimeout("wallet start", wallet.start(true));
  try {
    await withFileLock(journalPath, async () => {
      const stored = (await readRegistry(journalPath)) as unknown as Partial<DeploymentJournal> | undefined;
      let journal: DeploymentJournal = {
        schemaVersion: 1,
        network: identity,
        compatibility: COMPATIBILITY,
        deployments: stored?.deployments ?? [],
        ...(stored?.inFlightDeployment ? { inFlightDeployment: stored.inFlightDeployment } : {}),
        ...(stored?.pendingDeployment ? { pendingDeployment: stored.pendingDeployment } : {})
      };
      const saveJournal = async (): Promise<void> => writeJsonAtomic(journalPath, journal);
      if (journal.inFlightDeployment) {
        if (process.env.MN_CONFIRM_NO_DEPLOYMENT !== "1") {
          throw new Error(`${journal.inFlightDeployment.symbol}: prior deployment outcome is uncertain. Reconcile the node/indexer before retrying; set MN_CONFIRM_NO_DEPLOYMENT=1 only after confirming that no contract finalized.`);
        }
        journal = clearConfirmedAbsentIntent(journal);
        await saveJournal();
      }
      const records = new Map<TokenSymbol, DeploymentRecord>(journal.deployments.map((item) => [item.deploymentId.split(":")[0] as TokenSymbol, item]));
      if (journal.pendingDeployment) {
        const pending = journal.pendingDeployment;
        const token = TOKEN_DEFINITIONS.find((item) => item.symbol === pending.symbol);
        if (!token) throw new Error(`Unknown pending deployment symbol ${pending.symbol}`);
        try {
          const checked = await verifyContract(token, pending.record.contractAddress);
          if (checked.tokenId !== pending.record.tokenId) throw new DeploymentVerificationError(`${token.symbol}: pending token id mismatch`);
          const recovered: DeploymentRecord = {
            ...pending.record,
            verifiedAt: new Date().toISOString(),
            maintenanceAuthority: checked.maintenanceAuthority
          };
          records.set(token.symbol, recovered);
          journal = completePendingDeployment(journal, recovered);
          await saveJournal();
          console.log(`[recover] ${token.symbol} ${recovered.contractAddress}`);
        } catch (error) {
          if (!(error instanceof DeploymentVerificationError)) throw error;
          await markRegistryStale(outputPath, identity);
          throw new Error(`${error.message}. Finalized deployment remains pending in the private journal; do not redeploy until its chain outcome is reconciled.`);
        }
      }
      for (const token of TOKEN_DEFINITIONS) {
        const prior = records.get(token.symbol);
        if (prior) {
          try {
            const checked = await verifyContract(token, prior.contractAddress);
            if (checked.tokenId !== prior.tokenId) throw new Error("token id changed");
            records.set(token.symbol, { ...prior, compatibility: COMPATIBILITY, deploymentToolchain: DEPLOYMENT_TOOLCHAIN, verifiedAt: new Date().toISOString(), maintenanceAuthority: checked.maintenanceAuthority });
            console.log(`[resume] ${token.symbol} ${prior.contractAddress}`);
            continue;
          } catch (error) {
            if (!(error instanceof DeploymentVerificationError)) throw error;
            await markRegistryStale(outputPath, identity);
            if (process.env.MN_REDEPLOY_STALE !== "1") {
              throw new Error(`${error.message}. Registry marked stale; after confirming the reset or code mismatch, rerun with MN_REDEPLOY_STALE=1.`);
            }
            console.warn(`[redeploy-stale] ${token.symbol}: ${error.message}`);
            records.delete(token.symbol);
          }
        }
        const path = artifactPath(token.privacy);
        const providers = initializeMidnightProviders(wallet, {
          walletNetworkId,
          networkId: endpoints.networkId,
          indexer: endpoints.indexer,
          indexerWS: endpoints.indexerWS,
          node: endpoints.node,
          nodeWS: endpoints.nodeWS,
          proofServer: endpoints.proofServer,
          faucet: undefined
        }, { privateStateStoreName: resolve(root, ".local", "private-state", `v1-${networkKey}`), zkConfigPath: path });
        const contractModule = moduleFor(token.privacy);
        const compiled = CompiledContract.make(`mint-test-token-${token.privacy}`, contractModule.Contract as never).pipe(
          CompiledContract.withVacantWitnesses,
          CompiledContract.withCompiledFileAssets(path)
        );
        const artifactSha256 = await hashDirectory(path);
        journal = beginDeployment(journal, token.symbol, new Date().toISOString());
        await saveJournal();
        let deployed;
        try {
          deployed = await withTimeout(`${token.symbol} deploy`, deployContract(providers as never, {
            compiledContract: compiled as never,
            args: [token.name, token.symbol, BigInt(token.decimals), bytes32(token.domainSeparator)]
          } as never));
        } catch (error) {
          throw new Error(`${token.symbol}: deployment outcome is uncertain and remains marked in the private journal; reconcile the chain before retrying. ${error instanceof Error ? error.message : String(error)}`);
        }
        const address = deployed.deployTxData.public.contractAddress;
        const publicTx = deployed.deployTxData.public;
        const provisional: DeploymentRecord = {
          deploymentId: `${token.symbol}:${address}`,
          status: "active",
          contractAddress: address,
          tokenId: ledger.rawTokenType(bytes32(token.domainSeparator), address),
          deploymentTransaction: publicTx.txId,
          deployedAt: asDate(publicTx.blockTimestamp),
          verifiedAt: asDate(publicTx.blockTimestamp),
          network: identity,
          compatibility: COMPATIBILITY,
          deploymentToolchain: DEPLOYMENT_TOOLCHAIN,
          confirmation: { blockHeight: String(publicTx.blockHeight), blockHash: publicTx.blockHash },
          maintenanceAuthority: { status: "unknown", address: null },
          artifact: {
            sourceRevision,
            compilerVersion: COMPATIBILITY.compiler,
            artifactSha256,
            openZeppelinRelease: null
          }
        };
        journal = recordFinalizedDeployment(journal, provisional);
        await saveJournal();
        const checked = await verifyContract(token, address, providers.publicDataProvider);
        if (checked.tokenId !== provisional.tokenId) throw new DeploymentVerificationError(`${token.symbol}: finalized token id mismatch`);
        const record: DeploymentRecord = { ...provisional, verifiedAt: new Date().toISOString(), maintenanceAuthority: checked.maintenanceAuthority };
        records.set(token.symbol, record);
        journal = completePendingDeployment(journal, record);
        await saveJournal();
        console.log(`[deploy] ${token.symbol} ${address} ${record.tokenId}`);
      }
      const registry = await publishReadyRegistry(outputPath, {
        network: identity,
        compatibility: COMPATIBILITY,
        deployments: records,
        revision: deploymentRevision(identity, records),
        generatedAt: new Date().toISOString()
      });
      console.log(`[publish] ${outputPath} ${registry.registryRevision}`);
    });
  } finally {
    await wallet.stop();
  }
}

if (command === "deploy") {
  await deployAll();
} else if (command === "verify") {
  setNetworkId(endpoints.networkId);
  const registry = await readRegistry(outputPath);
  if (!registry) throw new Error(`No registry at ${outputPath}`);
  await verifyRegistry(registry);
  console.log(`[verify] ${registry.tokens.length} canonical tokens verified`);
} else {
  throw new Error("Usage: v1-deploy.ts deploy|verify");
}
