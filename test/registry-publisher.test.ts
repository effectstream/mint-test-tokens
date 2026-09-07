import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RegistryLockedError, withFileLock, writeJsonAtomic } from "../scripts/lib/atomic-json.js";
import {
  beginDeployment,
  completePendingDeployment,
  recordFinalizedDeployment,
  type DeploymentJournal
} from "../scripts/lib/deployment-journal.js";
import {
  deploymentIdentity,
  deploymentRevision,
  markRegistryStale,
  mergeResumeDeployments,
  metadataOutputPath,
  promoteReadyRegistry,
  publishReadyRegistry,
  readyDeploymentsForNetwork
} from "../scripts/lib/registry-publisher.js";
import { assertDeploymentProvenance, resolveReproducibleSourceRevision } from "../scripts/lib/deployment-provenance.js";
import { TOKEN_DEFINITIONS } from "../packages/registry/src/tokens.js";
import type { CompatibilitySnapshot, DeploymentRecord, NetworkIdentity, TokenSymbol } from "../packages/registry/src/types.js";

const network: NetworkIdentity = {
  key: "undeployed",
  displayName: "Local undeployed",
  protocolFamily: "midnight-1.x",
  networkId: "undeployed",
  chainId: "undeployed1",
  stackIdentity: "v1:genesis:runtime"
};
const compatibility: CompatibilitySnapshot = {
  profile: "v1",
  compiler: "0.31.1",
  compactRuntime: "0.16.0",
  ledger: "8.1.0",
  midnightJs: "4.1.1",
  walletSdk: "1.1.0"
};

const records = (suffix: string): Map<TokenSymbol, DeploymentRecord> => new Map(TOKEN_DEFINITIONS.map((token, index) => [
  token.symbol,
  {
    deploymentId: `${token.symbol}-${suffix}`,
    status: "active",
    contractAddress: index.toString(16).padStart(64, "0"),
    tokenId: (index + 10).toString(16).padStart(64, "0"),
    deploymentTransaction: `00${index.toString(16).padStart(64, "0")}`,
    deployedAt: "2026-09-07T10:00:00.000Z",
    verifiedAt: "2026-09-07T10:01:00.000Z",
    network: structuredClone(network),
    compatibility: structuredClone(compatibility),
    deploymentToolchain: { runner: "test-runner", runnerVersion: "1.0.0", walletSdk: "1.1.0" },
    confirmation: { blockHeight: "12", blockHash: `0x${index}` },
    maintenanceAuthority: { status: "unknown", address: null },
    artifact: {
      sourceRevision: "a".repeat(40),
      compilerVersion: compatibility.compiler,
      artifactSha256: "b".repeat(64),
      openZeppelinRelease: null
    }
  }
]));

test("publishes all six records atomically and preserves superseded history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-registry-"));
  const path = join(directory, "metadata.undeployed.json");
  try {
    const first = await publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: records("one"),
      revision: "one",
      generatedAt: "2026-09-07T10:02:00.000Z"
    });
    assert.equal(first.tokens.length, 6);
    const historicalWithoutProvenance = first;
    historicalWithoutProvenance.tokens[0]!.deployments[0]!.deploymentToolchain = null;
    await writeJsonAtomic(path, historicalWithoutProvenance, 0o644);
    const second = await publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: records("two"),
      revision: "two",
      generatedAt: "2026-09-07T10:03:00.000Z"
    });
    assert.equal(second.tokens[0]!.deployments[0]!.status, "superseded");
    assert.equal(second.tokens[0]!.deployments[0]!.deploymentToolchain, null);
    assert.equal(second.tokens[0]!.deployments[1]!.status, "active");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second);
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed incomplete promotion preserves the prior ready registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-preserve-"));
  const path = join(directory, "metadata.json");
  try {
    await publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: records("ready"),
      revision: "ready",
      generatedAt: "2026-09-07T10:02:00.000Z"
    });
    const before = await readFile(path, "utf8");
    const incomplete = records("incomplete");
    incomplete.delete("twBTC");
    await assert.rejects(publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: incomplete,
      revision: "must-not-publish",
      generatedAt: "2026-09-07T10:03:00.000Z"
    }), /without twBTC/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision changes with canonical identities and changed-stack stale marking invalidates readiness", async () => {
  const first = records("one");
  const second = records("two");
  assert.notEqual(deploymentRevision(network, first), deploymentRevision(network, second));
  const directory = await mkdtemp(join(tmpdir(), "mint-stale-"));
  const path = join(directory, "metadata.json");
  try {
    await publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: first,
      revision: deploymentRevision(network, first),
      generatedAt: "2026-09-07T10:02:00.000Z"
    });
    const changedStack = { ...network, protocolFamily: "midnight-2.x" as const, stackIdentity: "v2:new-genesis:new-runtime" };
    const stale = await markRegistryStale(path, changedStack);
    assert.equal(stale?.status, "stale");
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "stale");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic serialization failure removes its private temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-temp-"));
  const path = join(directory, "journal.json");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  try {
    await assert.rejects(writeJsonAtomic(path, circular), /circular/i);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects concurrent writers and removes the lock after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-lock-"));
  const path = join(directory, "metadata.json");
  let release!: () => void;
  const held = withFileLock(path, () => new Promise<void>((resolve) => { release = resolve; }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(withFileLock(path, async () => undefined), RegistryLockedError);
    release();
    await held;
    await withFileLock(path, async () => undefined);
  } finally {
    release?.();
    await held.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a finalized deployment pending until verification completes", () => {
  const fixture = records("pending").get("twBTC")!;
  const record = { ...fixture, deploymentId: `twBTC:${fixture.contractAddress}` };
  let journal: DeploymentJournal = {
    schemaVersion: 1,
    network,
    compatibility,
    deployments: []
  };
  journal = beginDeployment(journal, "twBTC", "2026-09-07T10:00:00.000Z");
  assert.equal(journal.inFlightDeployment?.symbol, "twBTC");
  journal = recordFinalizedDeployment(journal, record);
  assert.equal(journal.inFlightDeployment, undefined);
  assert.equal(journal.pendingDeployment?.record.contractAddress, record.contractAddress);

  assert.throws(() => {
    throw new Error("simulated post-finalization verification failure");
  }, /simulated/);
  assert.equal(journal.pendingDeployment?.record.contractAddress, record.contractAddress);

  journal = completePendingDeployment(journal, { ...record, verifiedAt: "2026-09-07T10:05:00.000Z" });
  assert.equal(journal.pendingDeployment, undefined);
  assert.equal(journal.deployments[0]?.contractAddress, record.contractAddress);
});

test("isolates configured metadata directories and rejects concurrent workflows for one output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-output-"));
  const first = metadataOutputPath("/repo", "undeployed", join(directory, "stack-one"));
  const second = metadataOutputPath("/repo", "undeployed", join(directory, "stack-two"));
  assert.notEqual(first, second);
  let release!: () => void;
  const held = withFileLock(`${first}.deployment-workflow`, () => new Promise<void>((resolve) => { release = resolve; }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(withFileLock(`${first}.deployment-workflow`, async () => undefined), RegistryLockedError);
    await withFileLock(`${second}.deployment-workflow`, async () => undefined);
  } finally {
    release?.();
    await held.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers deleted or partial journals from a valid same-stack ready registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-recovery-"));
  const path = join(directory, "metadata.undeployed.json");
  try {
    const canonical = await publishReadyRegistry(path, {
      network,
      compatibility,
      deployments: records("canonical"),
      revision: "canonical",
      generatedAt: "2026-09-07T10:02:00.000Z"
    });
    const recovered = readyDeploymentsForNetwork(canonical, network);
    assert.equal(recovered.size, 6);
    assert.deepEqual(mergeResumeDeployments([], recovered), recovered);
    const partial = [records("journal-old").get("twBTC")!];
    const repaired = mergeResumeDeployments(partial, recovered);
    assert.equal(repaired.size, 6);
    assert.equal(repaired.get("twBTC")?.deploymentId, recovered.get("twBTC")?.deploymentId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves same-address deployment history from a different stack", () => {
  const oldRecords = records("old-stack");
  const oldRegistry = promoteReadyRegistry({
    network,
    compatibility,
    deployments: oldRecords,
    revision: "old-stack",
    generatedAt: "2026-09-07T10:02:00.000Z"
  });
  const newNetwork = { ...network, stackIdentity: "v1:different-genesis:runtime" };
  const replacement = new Map([...oldRecords].map(([symbol, record]) => [symbol, {
    ...record,
    deploymentId: deploymentIdentity(symbol, newNetwork, record.contractAddress, `new-${record.deploymentTransaction}`),
    deploymentTransaction: `aa${record.deploymentTransaction}`,
    network: newNetwork
  }]));
  const promoted = promoteReadyRegistry({
    existing: oldRegistry,
    network: newNetwork,
    compatibility,
    deployments: replacement,
    revision: "new-stack",
    generatedAt: "2026-09-07T10:03:00.000Z"
  });
  for (const token of promoted.tokens) {
    assert.equal(token.deployments.length, 2);
    assert.equal(token.deployments[0]?.network.stackIdentity, network.stackIdentity);
    assert.equal(token.deployments[0]?.status, "superseded");
    assert.equal(token.deployments[1]?.network.stackIdentity, newNetwork.stackIdentity);
  }
});

test("rejects every mutated independently checkable provenance class", () => {
  const record = records("provenance").get("twBTC")!;
  const expected = {
    network,
    compatibility,
    deploymentToolchain: record.deploymentToolchain!,
    sourceRevision: record.artifact.sourceRevision,
    compilerVersion: record.artifact.compilerVersion,
    artifactSha256: record.artifact.artifactSha256,
    maintenanceAuthority: record.maintenanceAuthority,
    chainDeployment: {
      transactionHash: record.deploymentTransaction,
      blockHeight: record.confirmation.blockHeight,
      blockHash: record.confirmation.blockHash
    }
  };
  assert.doesNotThrow(() => assertDeploymentProvenance(record, expected));
  const mutations: DeploymentRecord[] = [
    { ...record, network: { ...record.network, chainId: "wrong" } },
    { ...record, compatibility: { ...record.compatibility, ledger: "wrong" } },
    { ...record, deploymentToolchain: { ...record.deploymentToolchain!, runnerVersion: "wrong" } },
    { ...record, artifact: { ...record.artifact, sourceRevision: "c".repeat(40) } },
    { ...record, artifact: { ...record.artifact, compilerVersion: "wrong" } },
    { ...record, artifact: { ...record.artifact, artifactSha256: "d".repeat(64) } },
    { ...record, maintenanceAuthority: { status: "retained", address: "authority" } },
    { ...record, deploymentTransaction: "ff" },
    { ...record, confirmation: { ...record.confirmation, blockHeight: "13" } },
    { ...record, confirmation: { ...record.confirmation, blockHash: "wrong" } }
  ];
  for (const mutation of mutations) {
    assert.throws(() => assertDeploymentProvenance(mutation, expected), /provenance mismatch/);
  }
});

test("requires source revision to resolve and match tracked source/artifact bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mint-source-revision-"));
  try {
    await mkdir(join(directory, "managed"));
    await writeFile(join(directory, "issuer.compact"), "export circuit mint(): [] {}\n");
    await writeFile(join(directory, "managed", "artifact"), "proof-bytes\n");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "tests@effectstream.invalid"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "registry test"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    assert.equal(resolveReproducibleSourceRevision(directory, revision, ["issuer.compact", "managed"]), revision);
    assert.throws(() => resolveReproducibleSourceRevision(directory, "0".repeat(40), ["issuer.compact", "managed"]), /does not resolve/);
    await writeFile(join(directory, "issuer.compact"), "changed\n");
    assert.throws(() => resolveReproducibleSourceRevision(directory, revision, ["issuer.compact", "managed"]), /do not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
