import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
import { deploymentRevision, markRegistryStale, publishReadyRegistry } from "../scripts/lib/registry-publisher.js";
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
