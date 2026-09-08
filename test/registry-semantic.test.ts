import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deploymentDirectlySupportsCompatibility,
  deploymentSupportsCompatibility,
  validateRegistry
} from "../packages/registry/src/semantic.js";
import { encodeDomainSeparator } from "../packages/registry/src/domain.js";
import type {
  CompatibilitySnapshot,
  NetworkIdentity,
  TokenRegistry,
  VerifiedCompatibilitySnapshot
} from "../packages/registry/src/types.js";

const clone = <T>(value: T): T => structuredClone(value);
const expectInvalid = (value: unknown, pattern: RegExp): void => {
  const result = validateRegistry(value, "undeployed");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), pattern);
};
const base = JSON.parse(await readFile(new URL("../metadata/metadata.preview.json", import.meta.url), "utf8")) as TokenRegistry;

const v1Compatibility: CompatibilitySnapshot = {
  profile: "v1",
  compiler: "0.31.1",
  compactRuntime: "0.16.0",
  ledger: "8.1.0",
  midnightJs: "4.1.1",
  walletSdk: "1.2.0"
};
const v2Compatibility: CompatibilitySnapshot = {
  profile: "v2",
  compiler: "0.34.0",
  compactRuntime: "0.19.0",
  ledger: "1.0.0-rc.3",
  midnightJs: "5.0.0-beta.7",
  walletSdk: "2.0.0-beta.2"
};
const alignedV2Compatibility: VerifiedCompatibilitySnapshot = {
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

function makeReady(protocol: "v1" | "v2" = "v1"): TokenRegistry {
  const registry = clone(base);
  const network: NetworkIdentity = {
    key: "undeployed",
    displayName: "Local undeployed",
    protocolFamily: protocol === "v1" ? "midnight-1.x" : "midnight-2.x",
    networkId: "undeployed",
    chainId: "midnight_undeployed",
    stackIdentity: `${protocol}-stack-identity`
  };
  const compatibility = protocol === "v1" ? v1Compatibility : v2Compatibility;
  registry.status = "ready";
  registry.network = network;
  registry.compatibility = compatibility;
  registry.tokens = registry.tokens.map((token, index) => {
    const deploymentId = `${token.symbol}-deployment`;
    return {
      ...token,
      activeDeploymentId: deploymentId,
      deployments: [{
        deploymentId,
        status: "active",
        contractAddress: index.toString(16).padStart(64, "0"),
        tokenId: (index + 10).toString(16).padStart(64, "0"),
        deploymentTransaction: `00${index.toString(16).padStart(64, "0")}`,
        deployedAt: "2026-09-07T10:00:00.000Z",
        verifiedAt: "2026-09-07T10:01:00.000Z",
        network: clone(network),
        compatibility: clone(compatibility),
        deploymentToolchain: { runner: "test-runner", runnerVersion: "1.0.0", walletSdk: compatibility.walletSdk },
        confirmation: { blockHeight: "12", blockHash: `0x${index}` },
        maintenanceAuthority: { status: "unknown", address: null },
        artifact: {
          sourceRevision: "a".repeat(40),
          compilerVersion: compatibility.compiler,
          artifactSha256: "b".repeat(64),
          openZeppelinRelease: null
        }
      }]
    };
  });
  return registry;
}

test("accepts the committed unavailable preview registry", () => {
  assert.equal(validateRegistry(base, "preview").ok, true);
});

test("returns structured failures for malformed JSON without throwing", () => {
  const malformed = [null, {}, { ...base, network: null }, { ...base, tokens: [null] }];
  for (const value of malformed) {
    assert.doesNotThrow(() => validateRegistry(value));
    assert.equal(validateRegistry(value).ok, false);
  }
});

test("rejects wrong network, duplicate symbols, missing symbols, and an empty faucet", () => {
  assert.equal(validateRegistry(base, "preprod").ok, false);
  const duplicate = clone(base);
  duplicate.tokens[5] = clone(duplicate.tokens[0]);
  assert.equal(validateRegistry(duplicate).ok, false);
  const missing = clone(base);
  missing.tokens.pop();
  assert.equal(validateRegistry(missing).ok, false);
  const emptyFaucet = clone(base) as unknown as { tokens: Array<Record<string, unknown>> };
  emptyFaucet.tokens[0]!.faucet = {};
  assert.equal(validateRegistry(emptyFaucet).ok, false);
});

test("requires every ready token to select one verified active deployment", () => {
  const ready = makeReady();
  assert.equal(validateRegistry(ready, "undeployed").ok, true);
  ready.tokens[0]!.activeDeploymentId = "wrong-id";
  assert.equal(validateRegistry(ready, "undeployed").ok, false);
  ready.tokens[0]!.deployments[0]!.verifiedAt = "not-a-date";
  assert.equal(validateRegistry(ready, "undeployed").ok, false);
});

test("accepts additive client compatibility evidence while preserving deployment provenance", () => {
  const ready = makeReady("v2");
  ready.compatibility = clone(alignedV2Compatibility);
  for (const token of ready.tokens) {
    const deployment = token.deployments[0]!;
    deployment.compatibility = {
      profile: "v2",
      compiler: "0.33.0-rc.2",
      compactRuntime: "0.18.0-rc.1",
      ledger: "1.0.0-rc.3",
      midnightJs: "5.0.0-beta.6",
      walletSdk: "2.0.0-beta.2"
    };
    deployment.compatibilityVerifications = [{
      deploymentId: deployment.deploymentId,
      deploymentArtifactSha256: deployment.artifact.artifactSha256,
      compatibility: clone(alignedV2Compatibility),
      artifact: {
        sourceRevision: "c".repeat(40),
        compilerVersion: alignedV2Compatibility.compiler,
        artifactSha256: "d".repeat(64)
      },
      verifiedAt: "2026-09-07T11:00:00.000Z"
    }];
  }
  assert.equal(validateRegistry(ready, "undeployed").ok, true);
  const selected = ready.tokens[0]!.deployments[0]!;
  const evidenceArtifact = selected.compatibilityVerifications![0]!.artifact;
  assert.equal(deploymentDirectlySupportsCompatibility(selected, alignedV2Compatibility, evidenceArtifact), false);
  assert.equal(deploymentSupportsCompatibility(selected, alignedV2Compatibility, evidenceArtifact), true);
  assert.equal(deploymentSupportsCompatibility(selected, alignedV2Compatibility, evidenceArtifact), true);
  assert.equal(deploymentSupportsCompatibility(selected, alignedV2Compatibility, {
    ...evidenceArtifact,
    sourceRevision: "e".repeat(40)
  }), false);
  assert.equal(deploymentSupportsCompatibility(selected, alignedV2Compatibility, {
    ...evidenceArtifact,
    artifactSha256: "f".repeat(64)
  }), false);

  const withoutEvidence = clone(ready);
  delete withoutEvidence.tokens[0]!.deployments[0]!.compatibilityVerifications;
  expectInvalid(withoutEvidence, /active deployment compatibility mismatch/);

  const wrongDeployment = clone(ready);
  wrongDeployment.tokens[0]!.deployments[0]!.compatibilityVerifications![0]!.deploymentId = "wrong";
  expectInvalid(wrongDeployment, /deploymentId must match/);

  const wrongDeploymentDigest = clone(ready);
  wrongDeploymentDigest.tokens[0]!.deployments[0]!.compatibilityVerifications![0]!.deploymentArtifactSha256 = "e".repeat(64);
  expectInvalid(wrongDeploymentDigest, /deployment artifact digest/);

  const wrongCompiler = clone(ready);
  wrongCompiler.tokens[0]!.deployments[0]!.compatibilityVerifications![0]!.artifact.compilerVersion = "0.33.0";
  expectInvalid(wrongCompiler, /must match compatibility.compiler/);

  const partialTuple = clone(ready);
  const partialCompatibility = partialTuple.tokens[0]!.deployments[0]!.compatibilityVerifications![0]!.compatibility as unknown as { compactJs?: string };
  delete partialCompatibility.compactJs;
  expectInvalid(partialTuple, /compactJs must be non-empty/);

  const duplicate = clone(ready);
  duplicate.tokens[0]!.deployments[0]!.compatibilityVerifications!.push(
    clone(duplicate.tokens[0]!.deployments[0]!.compatibilityVerifications![0]!)
  );
  expectInvalid(duplicate, /duplicate compatibility verification/);
});

test("accepts an exact-current deployment without additive evidence and rejects the wrong client artifact", () => {
  const ready = makeReady("v2");
  const deployment = ready.tokens[0]!.deployments[0]!;
  const clientArtifact = {
    sourceRevision: deployment.artifact.sourceRevision,
    compilerVersion: deployment.artifact.compilerVersion,
    artifactSha256: deployment.artifact.artifactSha256
  };
  assert.equal(deploymentDirectlySupportsCompatibility(deployment, ready.compatibility, clientArtifact), true);
  assert.equal(deploymentSupportsCompatibility(deployment, ready.compatibility, clientArtifact), true);
  assert.equal(deploymentSupportsCompatibility(deployment, ready.compatibility, {
    ...clientArtifact,
    artifactSha256: "f".repeat(64)
  }), false);
});

test("preserves a superseded v1 record when the current active context is v2", () => {
  const ready = makeReady("v2");
  const historical = clone(makeReady("v1").tokens[0]!.deployments[0]!);
  historical.deploymentId = `${historical.deploymentId}-v1`;
  historical.status = "superseded";
  historical.deploymentToolchain = null;
  ready.tokens[0]!.deployments.push(historical);
  assert.equal(validateRegistry(ready, "undeployed").ok, true);
  ready.tokens[0]!.deployments[0]!.deploymentToolchain = null;
  assert.equal(validateRegistry(ready, "undeployed").ok, false);
});

test("defines domain bytes as UTF-8 right-zero-padded to 32 bytes", () => {
  const encoded = encodeDomainSeparator("twBTC");
  assert.equal(encoded.length, 32);
  assert.deepEqual([...encoded.slice(0, 5)], [...new TextEncoder().encode("twBTC")]);
  assert.deepEqual([...encoded.slice(5)], Array(27).fill(0));
  assert.throws(() => encodeDomainSeparator("é".repeat(17)), /32 UTF-8 bytes/);

  const invalid = clone(base);
  invalid.tokens[0]!.domainSeparator = "é".repeat(17);
  const validation = validateRegistry(invalid);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.ok(validation.errors.some((error) => error.includes("32 UTF-8 bytes")));
});
