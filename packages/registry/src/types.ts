export const SCHEMA_VERSION = "1.0.0" as const;
export type NetworkKey = "preview" | "preprod" | "stagenet" | "undeployed";
export type ProtocolFamily = "midnight-1.x" | "midnight-2.x";
export type TokenSymbol = "twBTC" | "twETH" | "twUSDC" | "twUSDM" | "utwUSDC" | "utwBTC";
export type Privacy = "shielded" | "unshielded";
export type RegistryStatus = "unavailable" | "deploying" | "ready" | "stale";
export type DeploymentStatus = "active" | "superseded";
export type MaintenanceAuthorityStatus = "retained" | "renounced" | "unknown";

export interface CompatibilitySnapshot {
  profile: "v1" | "v2";
  compiler: string;
  compactRuntime: string;
  ledger: string;
  midnightJs: string;
  walletSdk: string;
}

export interface ArtifactProvenance {
  sourceRevision: string;
  compilerVersion: string;
  artifactSha256: string;
  openZeppelinRelease: string | null;
}
export interface DeploymentToolchain {
  runner: string;
  runnerVersion: string;
  walletSdk: string;
}
export interface DeploymentRecord {
  deploymentId: string;
  status: DeploymentStatus;
  contractAddress: string;
  tokenId: string;
  deploymentTransaction: string;
  deployedAt: string;
  verifiedAt: string;
  network: NetworkIdentity;
  compatibility: CompatibilitySnapshot;
  deploymentToolchain: DeploymentToolchain;
  confirmation: { blockHeight: string; blockHash: string };
  maintenanceAuthority: {
    status: MaintenanceAuthorityStatus;
    address: string | null;
  };
  artifact: ArtifactProvenance;
}
export interface TokenRecord {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  privacy: Privacy;
  domainSeparator: string;
  faucet: { humanAmount: string; baseUnits: string };
  activeDeploymentId: string | null;
  deployments: DeploymentRecord[];
}
export interface NetworkIdentity {
  key: NetworkKey;
  displayName: string;
  protocolFamily: ProtocolFamily;
  networkId: string;
  chainId: string | null;
  stackIdentity: string | null;
}
export interface TokenRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  registryRevision: string;
  status: RegistryStatus;
  generatedAt: string;
  network: NetworkIdentity;
  compatibility: CompatibilitySnapshot;
  tokens: TokenRecord[];
}
