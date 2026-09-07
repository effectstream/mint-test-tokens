import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRegistry } from "../packages/registry/src/semantic.js";
import type { CompatibilitySnapshot, NetworkIdentity, TokenRegistry } from "../packages/registry/src/types.js";

const clone = <T>(value: T): T => structuredClone(value);
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
  compiler: "0.33.0-rc.2",
  compactRuntime: "0.17.0-rc.3",
  ledger: "9.0.0-rc.5",
  midnightJs: "5.0.0-beta.6",
  walletSdk: "2.0.0-rc.4"
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
