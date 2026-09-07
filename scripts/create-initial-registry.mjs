import { mkdir, writeFile } from "node:fs/promises";

const tokens = [
  ["twBTC", "Test-wrapped BTC", 8, "shielded", "1", "100000000"],
  ["twETH", "Test-wrapped ETH", 18, "shielded", "5", "5000000000000000000"],
  ["twUSDC", "Test-wrapped USDC", 6, "shielded", "10000", "10000000000"],
  ["twUSDM", "Test-wrapped USDM", 6, "shielded", "10000", "10000000000"],
  ["utwUSDC", "Unshielded-test-wrapped USDC", 6, "unshielded", "10000", "10000000000"],
  ["utwBTC", "Unshielded-test-wrapped BTC", 8, "unshielded", "1", "100000000"]
].map(([symbol, name, decimals, privacy, humanAmount, baseUnits]) => ({
  symbol,
  name,
  decimals,
  privacy,
  domainSeparator: `mint-test-tokens:${symbol}`,
  faucet: { humanAmount, baseUnits },
  activeDeploymentId: null,
  deployments: []
}));

const profiles = {
  preview: {
    displayName: "Preview", protocolFamily: "midnight-1.x", networkId: "preview",
    chainId: null, stackIdentity: null,
    compatibility: { profile: "v1", compiler: "0.31.1", compactRuntime: "0.16.0", ledger: "8.1.0", midnightJs: "4.1.1", walletSdk: "1.2.0" }
  },
  preprod: {
    displayName: "Preprod", protocolFamily: "midnight-1.x", networkId: "preprod",
    chainId: null, stackIdentity: null,
    compatibility: { profile: "v1", compiler: "0.31.1", compactRuntime: "0.16.0", ledger: "8.1.0", midnightJs: "4.1.1", walletSdk: "1.2.0" }
  },
  stagenet: {
    displayName: "Stagenet", protocolFamily: "midnight-2.x", networkId: "stagenet",
    chainId: "midnight_stagenet", stackIdentity: null,
    compatibility: { profile: "v2", compiler: "0.33.0-rc.2", compactRuntime: "0.18.0-rc.1", ledger: "1.0.0-rc.3", midnightJs: "5.0.0-beta.6", walletSdk: "2.0.0-beta.2" }
  }
};

await mkdir(new URL("../metadata/", import.meta.url), { recursive: true });
for (const [key, profile] of Object.entries(profiles)) {
  const registry = {
    schemaVersion: "1.0.0",
    registryRevision: "unreleased",
    status: "unavailable",
    generatedAt: "2026-09-07T00:00:00.000Z",
    network: {
      key,
      displayName: profile.displayName,
      protocolFamily: profile.protocolFamily,
      networkId: profile.networkId,
      chainId: profile.chainId,
      stackIdentity: profile.stackIdentity
    },
    compatibility: profile.compatibility,
    tokens
  };
  await writeFile(new URL(`../metadata/metadata.${key}.json`, import.meta.url), `${JSON.stringify(registry, null, 2)}\n`);
}
