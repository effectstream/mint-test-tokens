import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  CompatibilitySnapshot,
  ClientCompatibilityVerification,
  DeploymentRecord,
  DeploymentToolchain,
  MaintenanceAuthorityStatus,
  NetworkIdentity
} from "../../packages/registry/src/types.js";

const GIT_OBJECT_MAX_BUFFER = 64 * 1024 * 1024;

export interface ChainDeploymentEvidence {
  transactionHash: string;
  blockHeight: string;
  blockHash: string;
}

export function sourcePathsForProfile(profile: "v1" | "v2"): readonly string[] {
  const root = `contracts/${profile}`;
  return [
    `${root}/shielded-token.compact`,
    `${root}/unshielded-token.compact`,
    `${root}/managed/shielded`,
    `${root}/managed/unshielded`
  ];
}

export async function hashDirectory(directory: string): Promise<string> {
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

function resolveExactCommit(repositoryRoot: string, requestedRevision: string): string {
  if (!/^[0-9a-f]{40}$/i.test(requestedRevision)) throw new Error("SOURCE_REVISION must be a full git SHA");
  let revision: string;
  try {
    revision = execFileSync(
      "git", ["rev-parse", "--verify", `${requestedRevision}^{commit}`],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim().toLowerCase();
  } catch {
    throw new Error(`SOURCE_REVISION does not resolve to a commit: ${requestedRevision}`);
  }
  if (revision !== requestedRevision.toLowerCase()) throw new Error("SOURCE_REVISION must identify the resolved commit exactly");
  return revision;
}

/** Hash a directory exactly as hashDirectory does, but from immutable bytes in a pinned Git commit. */
export function hashGitDirectory(repositoryRoot: string, requestedRevision: string, directory: string): string {
  const revision = resolveExactCommit(repositoryRoot, requestedRevision);
  const prefix = directory.replace(/\/+$/, "");
  const listed = execFileSync(
    "git", ["ls-tree", "-r", "--name-only", revision, "--", prefix],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const files = listed ? listed.split("\n").sort() : [];
  if (!files.length) throw new Error(`SOURCE_REVISION does not contain artifact directory: ${prefix}`);
  const hash = createHash("sha256");
  for (const path of files) {
    const contents = execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: repositoryRoot,
      maxBuffer: GIT_OBJECT_MAX_BUFFER
    });
    hash.update(relative(prefix, path));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Re-establish the original deployment artifact declaration from its pinned Git bytes. */
export function assertPinnedDeploymentArtifact(
  repositoryRoot: string,
  record: DeploymentRecord,
  managedArtifactPath: string,
  sourcePath: string
): void {
  const revision = resolveExactCommit(repositoryRoot, record.artifact.sourceRevision);
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${sourcePath}`], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch {
    throw new Error(`Deployment provenance source is absent from ${revision}: ${sourcePath}`);
  }
  const artifactSha256 = hashGitDirectory(repositoryRoot, revision, managedArtifactPath);
  if (artifactSha256 !== record.artifact.artifactSha256) {
    throw new Error("Deployment provenance mismatch: pinned artifact digest");
  }
  const info = JSON.parse(execFileSync(
    "git", ["show", `${revision}:${managedArtifactPath}/compiler/contract-info.json`],
    { cwd: repositoryRoot, encoding: "utf8" }
  )) as { "compiler-version"?: unknown; "runtime-version"?: unknown };
  const embeddedCompiler = record.artifact.compilerVersion.replace(/-rc\.\d+$/, "");
  if (info["compiler-version"] !== embeddedCompiler) {
    throw new Error("Deployment provenance mismatch: pinned embedded compiler version");
  }
  if (info["runtime-version"] !== record.compatibility.compactRuntime) {
    throw new Error("Deployment provenance mismatch: pinned embedded runtime version");
  }
}

/** Resolve a full commit and prove that every declared source/artifact path matches it byte-for-byte. */
export function resolveReproducibleSourceRevision(
  repositoryRoot: string,
  requestedRevision: string | undefined,
  relevantPaths: readonly string[]
): string {
  const candidate = requestedRevision?.trim() || execFileSync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const revision = resolveExactCommit(repositoryRoot, candidate);

  for (const path of relevantPaths) {
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}:${path}`], {
        cwd: repositoryRoot,
        stdio: ["ignore", "ignore", "pipe"]
      });
    } catch {
      throw new Error(`SOURCE_REVISION does not contain required path: ${path}`);
    }
  }
  const changed = execFileSync(
    "git", ["diff", "--name-only", revision, "--", ...relevantPaths],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const untracked = execFileSync(
    "git", ["ls-files", "--others", "--exclude-standard", "--", ...relevantPaths],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const ignored = execFileSync(
    "git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...relevantPaths],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const mismatches = [changed, untracked, ignored].filter(Boolean).join("\n");
  if (mismatches) throw new Error(`Source/artifact bytes do not match SOURCE_REVISION ${revision}:\n${mismatches}`);
  return revision;
}

export function assertClientCompatibilityVerification(
  record: DeploymentRecord,
  evidence: ClientCompatibilityVerification | undefined,
  expected: {
    compatibility: CompatibilitySnapshot;
    sourceRevision: string;
    compilerVersion: string;
    artifactSha256: string;
  }
): asserts evidence is ClientCompatibilityVerification {
  const mismatches: string[] = [];
  if (!evidence) throw new Error("Client compatibility verification is missing");
  if (evidence.deploymentId !== record.deploymentId) mismatches.push("deployment id");
  if (evidence.deploymentArtifactSha256 !== record.artifact.artifactSha256) mismatches.push("deployment artifact digest");
  const compatibilityFields = [
    "profile", "compiler", "language", "compactJs", "compactRuntime",
    "ledger", "onchainRuntime", "midnightJs", "walletSdk"
  ] as const;
  if (!compatibilityFields.every((field) => evidence.compatibility[field] === expected.compatibility[field])) {
    mismatches.push("compatibility declaration");
  }
  if (evidence.artifact.sourceRevision !== expected.sourceRevision) mismatches.push("source revision");
  if (evidence.artifact.compilerVersion !== expected.compilerVersion) mismatches.push("compiler declaration");
  if (evidence.artifact.artifactSha256 !== expected.artifactSha256) mismatches.push("client artifact digest");
  if (mismatches.length) throw new Error(`Client compatibility verification mismatch: ${mismatches.join(", ")}`);
}

export async function verifyEmbeddedCompilerMetadata(
  managedArtifactPath: string,
  expectedCompilerVersion: string,
  expectedRuntimeVersion: string
): Promise<void> {
  const value = JSON.parse(await readFile(resolve(managedArtifactPath, "compiler", "contract-info.json"), "utf8")) as {
    "compiler-version"?: unknown;
    "runtime-version"?: unknown;
  };
  if (value["compiler-version"] !== expectedCompilerVersion) {
    throw new Error(`Embedded compiler version mismatch: expected ${expectedCompilerVersion}, received ${String(value["compiler-version"])}`);
  }
  if (value["runtime-version"] !== expectedRuntimeVersion) {
    throw new Error(`Embedded runtime version mismatch: expected ${expectedRuntimeVersion}, received ${String(value["runtime-version"])}`);
  }
}

const same = (actual: unknown, expected: unknown): boolean => JSON.stringify(actual) === JSON.stringify(expected);

/**
 * Compare every registry field that the checked-out release and current chain can establish.
 * Toolchain values are release declarations; source bytes, artifact digest, authority and chain
 * deployment evidence are independently re-established by the caller.
 */
export function assertDeploymentProvenance(record: DeploymentRecord, expected: {
  network: NetworkIdentity;
  compatibility: CompatibilitySnapshot;
  deploymentToolchain: DeploymentToolchain;
  sourceRevision: string;
  compilerVersion: string;
  artifactSha256: string;
  maintenanceAuthority: { status: MaintenanceAuthorityStatus; address: string | null };
  chainDeployment: ChainDeploymentEvidence;
}): void {
  const mismatches: string[] = [];
  if (!same(record.network, expected.network)) mismatches.push("network identity");
  if (!same(record.compatibility, expected.compatibility)) mismatches.push("compatibility declaration");
  if (!same(record.deploymentToolchain, expected.deploymentToolchain)) mismatches.push("deployment toolchain declaration");
  if (record.artifact.sourceRevision !== expected.sourceRevision) mismatches.push("source revision");
  if (record.artifact.compilerVersion !== expected.compilerVersion) mismatches.push("compiler declaration");
  if (record.artifact.artifactSha256 !== expected.artifactSha256) mismatches.push("artifact digest");
  if (record.artifact.openZeppelinRelease !== null) mismatches.push("OpenZeppelin release declaration");
  if (!same(record.maintenanceAuthority, expected.maintenanceAuthority)) mismatches.push("maintenance authority");
  if (record.deploymentTransaction !== expected.chainDeployment.transactionHash) mismatches.push("deployment transaction");
  if (record.confirmation.blockHeight !== expected.chainDeployment.blockHeight) mismatches.push("confirmation block height");
  if (record.confirmation.blockHash !== expected.chainDeployment.blockHash) mismatches.push("confirmation block hash");
  if (mismatches.length) throw new Error(`Deployment provenance mismatch: ${mismatches.join(", ")}`);
}

export async function queryChainDeployment(
  indexerUrl: string,
  contractAddress: string,
  blockHeight: string
): Promise<ChainDeploymentEvidence> {
  const height = Number(blockHeight);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`Invalid confirmation block height: ${blockHeight}`);
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query Deployment($address: HexEncoded!, $height: Int!) {
        contractAction(address: $address, offset: { blockOffset: { height: $height } }) {
          __typename
          address
          transaction { hash block { height hash } }
        }
      }`,
      variables: { address: contractAddress, height }
    })
  });
  if (!response.ok) throw new Error(`Deployment evidence query HTTP ${response.status}`);
  const body = await response.json() as {
    data?: { contractAction?: {
      __typename?: string;
      address?: string;
      transaction?: { hash?: string; block?: { height?: number; hash?: string } };
    } | null };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) throw new Error(`Deployment evidence query failed: ${body.errors.map((item) => item.message).join("; ")}`);
  const action = body.data?.contractAction;
  if (action?.__typename !== "ContractDeploy" || action.address !== contractAddress) {
    throw new Error(`No contract deployment for ${contractAddress} at block ${blockHeight}`);
  }
  const transactionHash = action.transaction?.hash;
  const actualHeight = action.transaction?.block?.height;
  const blockHash = action.transaction?.block?.hash;
  if (!transactionHash || actualHeight !== height || !blockHash) throw new Error("Incomplete contract deployment evidence from indexer");
  return { transactionHash, blockHeight: String(actualHeight), blockHash };
}
