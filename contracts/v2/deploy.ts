import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnightntwrk/ledger-v9";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnightntwrk/wallet-sdk";
import pino from "pino";
import * as Shielded from "./managed/shielded/contract/index.js";
import * as Unshielded from "./managed/unshielded/contract/index.js";
import { encodeDomainSeparator } from "../../packages/registry/src/domain.js";
import { TOKEN_DEFINITIONS } from "../../packages/registry/src/tokens.js";
import {
  compatibilitySnapshotsEqual,
  deploymentSupportsCompatibility,
  validateRegistry
} from "../../packages/registry/src/semantic.js";
import type {
  ClientCompatibilityVerification,
  DeploymentRecord,
  MaintenanceAuthorityStatus,
  NetworkIdentity,
  NetworkKey,
  TokenRegistry,
  TokenSymbol,
  VerifiedCompatibilitySnapshot
} from "../../packages/registry/src/types.js";
import { writeJsonAtomic, withFileLock } from "../../scripts/lib/atomic-json.js";
import {
  beginDeployment,
  clearConfirmedAbsentIntent,
  completePendingDeployment,
  recordFinalizedDeployment,
  type DeploymentJournal
} from "../../scripts/lib/deployment-journal.js";
import {
  assertClientCompatibilityVerification,
  assertDeploymentProvenance,
  assertPinnedDeploymentArtifact,
  hashDirectory,
  queryChainDeployment,
  resolveReproducibleSourceRevision,
  sourcePathsForProfile,
  verifyEmbeddedCompilerMetadata
} from "../../scripts/lib/deployment-provenance.js";
import { waitForFundedDeploymentWallet } from "../../scripts/lib/deployment-wallet.js";
import { endpointConfig, rpc } from "../../scripts/lib/network-config.js";
import {
  deploymentIdentity,
  deploymentRevision,
  markRegistryStale,
  mergeResumeDeployments,
  metadataOutputPath,
  publishReadyRegistry,
  readRegistry,
  readyDeploymentsForNetwork
} from "../../scripts/lib/registry-publisher.js";
import { validateMasterSeedHex } from "../../scripts/lib/wallet-seed.js";

const COMPATIBILITY: VerifiedCompatibilitySnapshot = {
  profile: "v2",
  compiler: "0.34.0",
  language: "0.26.0",
  compactJs: "2.5.5-rc.8",
  compactRuntime: "0.19.0",
  ledger: "1.0.0-rc.3",
  onchainRuntime: "4.0.0-rc.3",
  midnightJs: "5.0.0-beta.7",
  walletSdk: "2.0.0-beta.2"
};
const DEPLOYMENT_TOOLCHAIN = { runner: "@midnight-ntwrk/testkit-js", runnerVersion: "5.0.0-beta.7", walletSdk: "2.0.0-beta.2" } as const;
const EMBEDDED_COMPILER_VERSION = "0.34.0";
const SOURCE_PATHS = sourcePathsForProfile("v2");
const TIMEOUT_MS = Number(process.env.MN_TIMEOUT_MS ?? 180_000);
const command = process.argv[2] ?? "deploy";
const rawNetwork = process.env.MN_NETWORK?.trim() ?? "undeployed";
if (!(["stagenet", "undeployed"] as string[]).includes(rawNetwork)) {
  throw new Error("The v2 runner supports MN_NETWORK=stagenet|undeployed");
}
const networkKey = rawNetwork as NetworkKey;
const endpoints = endpointConfig(networkKey);
const root = resolve(new URL("../..", import.meta.url).pathname);
const outputPath = metadataOutputPath(root, networkKey, process.env.MN_METADATA_OUTPUT_DIR);

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

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const asDate = (timestamp: number): string => new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp).toISOString();

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
    protocolFamily: "midnight-2.x",
    networkId: endpoints.networkId,
    chainId,
    stackIdentity: `${runtimeVersion}:${genesisHash}:${stack}`
  };
}

const moduleFor = (privacy: "shielded" | "unshielded") => privacy === "shielded" ? Shielded : Unshielded;
const artifactPath = (privacy: "shielded" | "unshielded") => resolve(root, "contracts", "v2", "managed", privacy);
const artifactRelativePath = (privacy: "shielded" | "unshielded") => `contracts/v2/managed/${privacy}`;
const sourceRelativePath = (privacy: "shielded" | "unshielded") => `contracts/v2/${privacy}-token.compact`;

async function verifyContract(
  token: (typeof TOKEN_DEFINITIONS)[number],
  contractAddress: string,
  confirmation: DeploymentRecord["confirmation"],
  publicData: Pick<PublicDataProvider, "queryContractState"> = indexerPublicDataProvider(endpoints.indexer, endpoints.indexerWS)
): Promise<{
  tokenId: string;
  maintenanceAuthority: { status: MaintenanceAuthorityStatus; address: string | null };
  chainDeployment: Awaited<ReturnType<typeof queryChainDeployment>>;
}> {
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
  const domain = encodeDomainSeparator(token.domainSeparator);
  if (metadata._name !== token.name || metadata._symbol !== token.symbol || metadata._decimals !== BigInt(token.decimals) || !sameBytes(metadata._domain, domain)) {
    throw new DeploymentVerificationError(`${token.symbol}: immutable on-chain metadata mismatch`);
  }
  const authority = state.maintenanceAuthority;
  const renounced = authority.committee.length === 0 && authority.threshold > 0;
  const address = renounced ? null : String(authority.committee[0] ?? "");
  const chainDeployment = await withTimeout(
    `${token.symbol} deployment evidence`,
    queryChainDeployment(endpoints.indexer, contractAddress, confirmation.blockHeight)
  );
  return {
    tokenId: ledger.rawTokenType(domain, contractAddress),
    maintenanceAuthority: { status: renounced ? "renounced" : address ? "retained" : "unknown", address: address || null },
    chainDeployment
  };
}

async function verifyExistingDeploymentWithCurrentArtifacts(
  token: (typeof TOKEN_DEFINITIONS)[number],
  record: DeploymentRecord,
  currentNetwork: NetworkIdentity,
  sourceRevision: string
): Promise<{ record: DeploymentRecord; evidence?: ClientCompatibilityVerification }> {
  const path = artifactPath(token.privacy);
  const artifactSha256 = await hashDirectory(path);
  const clientArtifact = {
    sourceRevision,
    compilerVersion: COMPATIBILITY.compiler,
    artifactSha256
  };
  const directCurrentCompatibility = deploymentSupportsCompatibility(record, COMPATIBILITY, clientArtifact);
  assertPinnedDeploymentArtifact(root, record, artifactRelativePath(token.privacy), sourceRelativePath(token.privacy));
  await verifyEmbeddedCompilerMetadata(path, EMBEDDED_COMPILER_VERSION, COMPATIBILITY.compactRuntime);
  const actual = await verifyContract(token, record.contractAddress, record.confirmation);
  if (actual.tokenId !== record.tokenId) throw new DeploymentVerificationError(`${token.symbol}: recorded token id mismatch`);
  if (!record.deploymentToolchain) throw new Error(`${token.symbol}: active deployment lacks original toolchain provenance`);
  assertDeploymentProvenance(record, {
    network: currentNetwork,
    compatibility: directCurrentCompatibility ? COMPATIBILITY : record.compatibility,
    deploymentToolchain: directCurrentCompatibility ? DEPLOYMENT_TOOLCHAIN : record.deploymentToolchain,
    sourceRevision: directCurrentCompatibility ? sourceRevision : record.artifact.sourceRevision,
    compilerVersion: directCurrentCompatibility ? COMPATIBILITY.compiler : record.artifact.compilerVersion,
    artifactSha256: directCurrentCompatibility ? artifactSha256 : record.artifact.artifactSha256,
    maintenanceAuthority: actual.maintenanceAuthority,
    chainDeployment: actual.chainDeployment
  });
  if (directCurrentCompatibility) return { record };
  const storedEvidence = record.compatibilityVerifications?.find((candidate) =>
    compatibilitySnapshotsEqual(candidate.compatibility, COMPATIBILITY)
  );
  if (storedEvidence) {
    assertClientCompatibilityVerification(record, storedEvidence, {
      compatibility: COMPATIBILITY,
      sourceRevision,
      compilerVersion: COMPATIBILITY.compiler,
      artifactSha256
    });
  }
  const evidence: ClientCompatibilityVerification = storedEvidence ?? {
    deploymentId: record.deploymentId,
    deploymentArtifactSha256: record.artifact.artifactSha256,
    compatibility: COMPATIBILITY,
    artifact: clientArtifact,
    verifiedAt: new Date().toISOString()
  };
  return {
    evidence,
    record: {
      ...record,
      compatibilityVerifications: [
        ...(record.compatibilityVerifications ?? []).filter((candidate) =>
          !compatibilitySnapshotsEqual(candidate.compatibility, COMPATIBILITY)
        ),
        evidence
      ]
    }
  };
}

async function verifyRegistry(registry: TokenRegistry): Promise<{
  records: Map<TokenSymbol, DeploymentRecord>;
  evidence: Map<TokenSymbol, ClientCompatibilityVerification>;
}> {
  const validation = validateRegistry(registry, networkKey);
  if (!validation.ok) throw new Error(`Registry validation failed:\n${validation.errors.join("\n")}`);
  if (registry.status !== "ready") throw new Error(`${outputPath} is ${registry.status}, not ready`);
  const currentNetwork = await stackIdentity();
  if (registry.network.protocolFamily !== currentNetwork.protocolFamily || registry.network.chainId !== currentNetwork.chainId || registry.network.stackIdentity !== currentNetwork.stackIdentity) {
    throw new Error("Registry identity does not match the connected chain/runtime/genesis");
  }
  const sourceRevision = resolveReproducibleSourceRevision(root, process.env.SOURCE_REVISION, SOURCE_PATHS);
  const verified = new Map<TokenSymbol, DeploymentRecord>();
  const evidence = new Map<TokenSymbol, ClientCompatibilityVerification>();
  for (const token of registry.tokens) {
    const record = token.deployments.find((item) => item.deploymentId === token.activeDeploymentId && item.status === "active");
    if (!record) throw new Error(`${token.symbol}: missing selected active deployment`);
    const expected = TOKEN_DEFINITIONS.find((item) => item.symbol === token.symbol)!;
    const result = await verifyExistingDeploymentWithCurrentArtifacts(expected, record, currentNetwork, sourceRevision);
    const clientArtifact = result.evidence?.artifact ?? record.artifact;
    if (!deploymentSupportsCompatibility(result.record, COMPATIBILITY, clientArtifact)) {
      throw new Error(`${token.symbol}: current client compatibility evidence did not bind to the deployment`);
    }
    const directCurrentCompatibility = compatibilitySnapshotsEqual(record.compatibility, COMPATIBILITY) &&
      record.artifact.sourceRevision === clientArtifact.sourceRevision &&
      record.artifact.compilerVersion === clientArtifact.compilerVersion &&
      record.artifact.artifactSha256 === clientArtifact.artifactSha256;
    if (compatibilitySnapshotsEqual(registry.compatibility, COMPATIBILITY) && !directCurrentCompatibility) {
      const stored = record.compatibilityVerifications?.find((candidate) =>
        compatibilitySnapshotsEqual(candidate.compatibility, COMPATIBILITY)
      );
      assertClientCompatibilityVerification(record, stored, {
        compatibility: COMPATIBILITY,
        sourceRevision,
        compilerVersion: COMPATIBILITY.compiler,
        artifactSha256: clientArtifact.artifactSha256
      });
    }
    verified.set(token.symbol, result.record);
    if (result.evidence) evidence.set(token.symbol, result.evidence);
    console.log(`[verify] ${token.symbol} ${record.contractAddress} ${record.tokenId} original-provenance+pinned-git+current-artifact+onchain-verifiers=verified`);
  }
  return { records: verified, evidence };
}

async function deployAll(): Promise<void> {
  const seedPath = process.env.MN_SEED_FILE?.trim();
  if (!seedPath) throw new Error("Set MN_SEED_FILE to a private file containing exactly 32 or 64 bytes of hexadecimal master seed");
  const seed = validateMasterSeedHex((await readFile(resolve(seedPath), "utf8")).trim());
  const identity = await stackIdentity();
  const previousRegistry = await readRegistry(outputPath);
  if (previousRegistry?.status === "ready" && previousRegistry.network.key === identity.key &&
      (previousRegistry.network.protocolFamily !== identity.protocolFamily ||
       previousRegistry.network.chainId !== identity.chainId ||
       previousRegistry.network.stackIdentity !== identity.stackIdentity)) {
    await markRegistryStale(outputPath, identity);
    if (process.env.MN_REDEPLOY_STALE !== "1") {
      throw new Error(`Registry at ${outputPath} was marked stale after a chain/runtime/genesis change. Confirm the reset, then rerun with MN_REDEPLOY_STALE=1.`);
    }
  }
  if (previousRegistry?.status === "stale" && previousRegistry.network.key === identity.key && process.env.MN_REDEPLOY_STALE !== "1") {
    throw new Error(`Registry at ${outputPath} is stale. Reconcile the recorded deployment, then rerun with MN_REDEPLOY_STALE=1 only when replacement is intended.`);
  }
  const sourceRevision = resolveReproducibleSourceRevision(root, process.env.SOURCE_REVISION, SOURCE_PATHS);
  const workflowIdentity = createHash("sha256").update(`${outputPath}\0${identity.stackIdentity}`).digest("hex");
  const journalPath = resolve(root, ".local", "deployments", `v2-${networkKey}-${workflowIdentity}.json`);
  const walletNetworkId = networkKey === "stagenet" ? NetworkId.NetworkId.StageNet : NetworkId.NetworkId.Undeployed;
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
  try {
    await withTimeout("wallet start", wallet.start(false));
    await waitForFundedDeploymentWallet(wallet.wallet, TIMEOUT_MS);
    await withFileLock(journalPath, async () => {
      const stored = (await readRegistry(journalPath)) as unknown as Partial<DeploymentJournal> | undefined;
      const canonicalRecords = readyDeploymentsForNetwork(previousRegistry, identity);
      const recoveredRecords = mergeResumeDeployments(stored?.deployments ?? [], canonicalRecords);
      let journal: DeploymentJournal = {
        schemaVersion: 1,
        network: identity,
        compatibility: COMPATIBILITY,
        deployments: [...recoveredRecords.values()],
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
          const path = artifactPath(token.privacy);
          const pendingSourceRevision = resolveReproducibleSourceRevision(root, pending.record.artifact.sourceRevision, SOURCE_PATHS);
          const artifactSha256 = await hashDirectory(path);
          await verifyEmbeddedCompilerMetadata(path, EMBEDDED_COMPILER_VERSION, COMPATIBILITY.compactRuntime);
          const checked = await verifyContract(token, pending.record.contractAddress, pending.record.confirmation);
          if (checked.tokenId !== pending.record.tokenId) throw new DeploymentVerificationError(`${token.symbol}: pending token id mismatch`);
          const recovered: DeploymentRecord = {
            ...pending.record,
            deploymentId: deploymentIdentity(token.symbol, identity, pending.record.contractAddress, checked.chainDeployment.transactionHash),
            deploymentTransaction: checked.chainDeployment.transactionHash,
            confirmation: { blockHeight: checked.chainDeployment.blockHeight, blockHash: checked.chainDeployment.blockHash },
            verifiedAt: new Date().toISOString(),
            maintenanceAuthority: checked.maintenanceAuthority
          };
          assertDeploymentProvenance(recovered, {
            network: identity,
            compatibility: COMPATIBILITY,
            deploymentToolchain: DEPLOYMENT_TOOLCHAIN,
            sourceRevision: pendingSourceRevision,
            compilerVersion: COMPATIBILITY.compiler,
            artifactSha256,
            maintenanceAuthority: checked.maintenanceAuthority,
            chainDeployment: checked.chainDeployment
          });
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
            const compatible = await verifyExistingDeploymentWithCurrentArtifacts(token, prior, identity, sourceRevision);
            records.set(token.symbol, compatible.record);
            console.log(`[resume-compatible] ${token.symbol} ${prior.contractAddress}`);
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
        }, { privateStateStoreName: resolve(root, ".local", "private-state", `v2-${networkKey}-${workflowIdentity}`), zkConfigPath: path });
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
            args: [token.name, token.symbol, BigInt(token.decimals), encodeDomainSeparator(token.domainSeparator)]
          } as never));
        } catch (error) {
          throw new Error(`${token.symbol}: deployment outcome is uncertain and remains marked in the private journal; reconcile the chain before retrying. ${error instanceof Error ? error.message : String(error)}`);
        }
        const address = deployed.deployTxData.public.contractAddress;
        const publicTx = deployed.deployTxData.public;
        const provisional: DeploymentRecord = {
          deploymentId: deploymentIdentity(token.symbol, identity, address, publicTx.txId),
          status: "active",
          contractAddress: address,
          tokenId: ledger.rawTokenType(encodeDomainSeparator(token.domainSeparator), address),
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
        const checked = await verifyContract(token, address, provisional.confirmation, providers.publicDataProvider);
        if (checked.tokenId !== provisional.tokenId) throw new DeploymentVerificationError(`${token.symbol}: finalized token id mismatch`);
        const record: DeploymentRecord = {
          ...provisional,
          deploymentId: deploymentIdentity(token.symbol, identity, address, checked.chainDeployment.transactionHash),
          deploymentTransaction: checked.chainDeployment.transactionHash,
          confirmation: { blockHeight: checked.chainDeployment.blockHeight, blockHash: checked.chainDeployment.blockHash },
          verifiedAt: new Date().toISOString(),
          maintenanceAuthority: checked.maintenanceAuthority
        };
        assertDeploymentProvenance(record, {
          network: identity,
          compatibility: COMPATIBILITY,
          deploymentToolchain: DEPLOYMENT_TOOLCHAIN,
          sourceRevision,
          compilerVersion: COMPATIBILITY.compiler,
          artifactSha256,
          maintenanceAuthority: checked.maintenanceAuthority,
          chainDeployment: checked.chainDeployment
        });
        records.set(token.symbol, record);
        journal = completePendingDeployment(journal, record);
        await saveJournal();
        console.log(`[deploy] ${token.symbol} ${address} ${record.tokenId}`);
      }
      journal = { ...journal, deployments: [...records.values()] };
      await saveJournal();
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
  await withFileLock(`${outputPath}.deployment-workflow`, deployAll);
} else if (command === "verify") {
  setNetworkId(endpoints.networkId);
  const registry = await readRegistry(outputPath);
  if (!registry) throw new Error(`No registry at ${outputPath}`);
  await verifyRegistry(registry);
  console.log(`[verify] ${registry.tokens.length} canonical tokens verified`);
} else if (command === "verify-compatible") {
  setNetworkId(endpoints.networkId);
  const registry = await readRegistry(outputPath);
  if (!registry) throw new Error(`No registry at ${outputPath}`);
  const verified = await verifyRegistry(registry);
  console.log(JSON.stringify({
    network: networkKey,
    compatibility: COMPATIBILITY,
    deployments: [...verified.evidence.entries()].map(([symbol, evidence]) => ({ symbol, evidence }))
  }));
} else {
  throw new Error("Usage: v2-deploy.ts deploy|verify|verify-compatible");
}
