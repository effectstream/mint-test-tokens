import { TOKEN_DEFINITIONS } from "./tokens.js";
import type { NetworkKey, TokenRegistry } from "./types.js";

export type RegistryValidation =
  | { ok: true; value: TokenRegistry }
  | { ok: false; errors: string[] };

const NETWORK_KEYS = ["preview", "preprod", "stagenet", "undeployed"] as const;
const PROTOCOLS = ["midnight-1.x", "midnight-2.x"] as const;
const PROFILES = ["v1", "v2"] as const;
const REGISTRY_STATUSES = ["unavailable", "deploying", "ready", "stale"] as const;
const DEPLOYMENT_STATUSES = ["active", "superseded"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isNullableString = (value: unknown): value is string | null =>
  value === null || isNonEmptyString(value);
const isEnum = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === "string" && choices.includes(value as T);
const isDate = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
const isHex = (value: unknown, exactLength?: number): value is string =>
  typeof value === "string" && (!exactLength || value.length === exactLength) && /^[0-9a-f]+$/i.test(value);

function sameRecord(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const expectedKeys = Object.keys(expected);
  return Object.keys(actual).length === expectedKeys.length && expectedKeys.every((key) => actual[key] === expected[key]);
}

function validateNetwork(network: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isEnum(network.key, NETWORK_KEYS)) errors.push(`${path}.key is invalid`);
  if (!isNonEmptyString(network.displayName)) errors.push(`${path}.displayName must be non-empty`);
  if (!isEnum(network.protocolFamily, PROTOCOLS)) errors.push(`${path}.protocolFamily is invalid`);
  if (!isNonEmptyString(network.networkId)) errors.push(`${path}.networkId must be non-empty`);
  if (!isNullableString(network.chainId)) errors.push(`${path}.chainId must be null or non-empty`);
  if (!isNullableString(network.stackIdentity)) errors.push(`${path}.stackIdentity must be null or non-empty`);
}

function validateCompatibility(compatibility: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isEnum(compatibility.profile, PROFILES)) errors.push(`${path}.profile is invalid`);
  for (const field of ["compiler", "compactRuntime", "ledger", "midnightJs", "walletSdk"] as const) {
    if (!isNonEmptyString(compatibility[field])) errors.push(`${path}.${field} must be non-empty`);
  }
}

function validateDeployment(deployment: Record<string, unknown>, symbol: string, errors: string[]): void {
  const path = `${symbol} deployment`;
  if (!isNonEmptyString(deployment.deploymentId)) errors.push(`${path}.deploymentId must be non-empty`);
  if (!isEnum(deployment.status, DEPLOYMENT_STATUSES)) errors.push(`${path}.status is invalid`);
  if (!isHex(deployment.contractAddress, 64)) errors.push(`${path}.contractAddress must be 32-byte hex`);
  if (!isHex(deployment.tokenId, 64)) errors.push(`${path}.tokenId must be 32-byte hex`);
  if (!isHex(deployment.deploymentTransaction)) errors.push(`${path}.deploymentTransaction must be hex`);
  if (!isDate(deployment.deployedAt)) errors.push(`${path}.deployedAt must be a date-time`);
  if (!isDate(deployment.verifiedAt)) errors.push(`${path}.verifiedAt must be a date-time`);

  if (!isObject(deployment.network)) {
    errors.push(`${path}.network must be an object`);
  } else {
    validateNetwork(deployment.network, `${path}.network`, errors);
  }
  if (!isObject(deployment.compatibility)) {
    errors.push(`${path}.compatibility must be an object`);
  } else {
    validateCompatibility(deployment.compatibility, `${path}.compatibility`, errors);
    if (isObject(deployment.network) && isEnum(deployment.compatibility.profile, PROFILES)) {
      const expectedProtocol = deployment.compatibility.profile === "v1" ? "midnight-1.x" : "midnight-2.x";
      if (deployment.network.protocolFamily !== expectedProtocol) {
        errors.push(`${path} compatibility profile does not match its protocol family`);
      }
    }
  }
  if (!isObject(deployment.deploymentToolchain)) {
    errors.push(`${path}.deploymentToolchain must be an object`);
  } else {
    for (const field of ["runner", "runnerVersion", "walletSdk"] as const) {
      if (!isNonEmptyString(deployment.deploymentToolchain[field])) errors.push(`${path}.deploymentToolchain.${field} must be non-empty`);
    }
  }
  if (!isObject(deployment.confirmation)) {
    errors.push(`${path}.confirmation must be an object`);
  } else {
    if (typeof deployment.confirmation.blockHeight !== "string" || !/^(0|[1-9][0-9]*)$/.test(deployment.confirmation.blockHeight)) {
      errors.push(`${path}.confirmation.blockHeight is invalid`);
    }
    if (!isNonEmptyString(deployment.confirmation.blockHash)) errors.push(`${path}.confirmation.blockHash must be non-empty`);
  }
  if (!isObject(deployment.maintenanceAuthority)) {
    errors.push(`${path}.maintenanceAuthority must be an object`);
  } else {
    const authority = deployment.maintenanceAuthority;
    if (!isEnum(authority.status, ["retained", "renounced", "unknown"] as const)) errors.push(`${path}.maintenanceAuthority.status is invalid`);
    if (!(authority.address === null || isNonEmptyString(authority.address))) errors.push(`${path}.maintenanceAuthority.address is invalid`);
    if (authority.status === "retained" && !isNonEmptyString(authority.address)) errors.push(`${path} retained authority requires an address`);
    if (authority.status === "renounced" && authority.address !== null) errors.push(`${path} renounced authority requires a null address`);
  }
  if (!isObject(deployment.artifact)) {
    errors.push(`${path}.artifact must be an object`);
  } else {
    if (!isHex(deployment.artifact.sourceRevision, 40)) errors.push(`${path}.artifact.sourceRevision must be a git SHA`);
    if (!isNonEmptyString(deployment.artifact.compilerVersion)) errors.push(`${path}.artifact.compilerVersion must be non-empty`);
    if (!isHex(deployment.artifact.artifactSha256, 64)) errors.push(`${path}.artifact.artifactSha256 must be a SHA-256`);
    if (!(deployment.artifact.openZeppelinRelease === null || isNonEmptyString(deployment.artifact.openZeppelinRelease))) {
      errors.push(`${path}.artifact.openZeppelinRelease is invalid`);
    }
  }
}

/** Browser-safe structural and semantic validation. JSON Schema validation remains a build gate. */
export function validateRegistry(value: unknown, expectedNetwork?: NetworkKey): RegistryValidation {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["registry must be an object"] };
  if (value.schemaVersion !== "1.0.0") errors.push("unsupported schemaVersion");
  if (!isNonEmptyString(value.registryRevision)) errors.push("registryRevision must be non-empty");
  if (!isEnum(value.status, REGISTRY_STATUSES)) errors.push("invalid registry status");
  if (!isDate(value.generatedAt)) errors.push("generatedAt must be a date-time");
  if (!isObject(value.network)) errors.push("network must be an object");
  if (!isObject(value.compatibility)) errors.push("compatibility must be an object");
  if (!Array.isArray(value.tokens)) errors.push("tokens must be an array");
  if (!isObject(value.network) || !isObject(value.compatibility) || !Array.isArray(value.tokens)) {
    return { ok: false, errors };
  }

  const network = value.network;
  const compatibility = value.compatibility;
  const tokenValues = value.tokens;
  validateNetwork(network, "network", errors);
  validateCompatibility(compatibility, "compatibility", errors);
  if (isEnum(compatibility.profile, PROFILES) && isEnum(network.protocolFamily, PROTOCOLS)) {
    const expectedProtocol = compatibility.profile === "v1" ? "midnight-1.x" : "midnight-2.x";
    if (network.protocolFamily !== expectedProtocol) errors.push("compatibility profile does not match network protocol family");
  }
  if (expectedNetwork && network.key !== expectedNetwork) errors.push(`expected ${expectedNetwork}, received ${String(network.key)}`);
  if (network.key !== "undeployed" && isEnum(network.key, NETWORK_KEYS) && network.networkId !== network.key) {
    errors.push("public networkId must equal the registry network key");
  }

  const bySymbol = new Map<string, Record<string, unknown>>();
  for (const token of tokenValues) {
    if (!isObject(token) || !isNonEmptyString(token.symbol)) {
      errors.push("each token must be an object with a symbol");
      continue;
    }
    if (bySymbol.has(token.symbol)) errors.push(`duplicate token symbol ${token.symbol}`);
    bySymbol.set(token.symbol, token);
  }

  for (const definition of TOKEN_DEFINITIONS) {
    const token = bySymbol.get(definition.symbol);
    if (!token) {
      errors.push(`missing token ${definition.symbol}`);
      continue;
    }
    const expected = definition as unknown as Record<string, unknown>;
    for (const field of ["name", "decimals", "privacy", "domainSeparator"] as const) {
      if (token[field] !== expected[field]) errors.push(`${definition.symbol}.${field} mismatch`);
    }
    if (!isObject(token.faucet) || !sameRecord(token.faucet, expected.faucet as Record<string, unknown>)) {
      errors.push(`${definition.symbol}.faucet mismatch`);
    }
    if (!(token.activeDeploymentId === null || isNonEmptyString(token.activeDeploymentId))) {
      errors.push(`${definition.symbol}.activeDeploymentId is invalid`);
    }
    if (!Array.isArray(token.deployments)) {
      errors.push(`${definition.symbol}.deployments must be an array`);
      continue;
    }

    const ids = new Set<string>();
    const active: Record<string, unknown>[] = [];
    for (const deployment of token.deployments) {
      if (!isObject(deployment)) {
        errors.push(`${definition.symbol} deployment must be an object`);
        continue;
      }
      validateDeployment(deployment, definition.symbol, errors);
      if (isNonEmptyString(deployment.deploymentId)) {
        if (ids.has(deployment.deploymentId)) errors.push(`${definition.symbol} has duplicate deploymentId`);
        ids.add(deployment.deploymentId);
      }
      if (deployment.status === "active") {
        active.push(deployment);
        if (deployment.deploymentId !== token.activeDeploymentId) errors.push(`${definition.symbol} has an unselected active deployment`);
        if (isObject(deployment.network)) {
          if (deployment.network.key !== network.key) errors.push(`${definition.symbol} active deployment network key mismatch`);
          if (deployment.network.protocolFamily !== network.protocolFamily) errors.push(`${definition.symbol} active deployment protocol mismatch`);
          if (deployment.network.stackIdentity !== network.stackIdentity) errors.push(`${definition.symbol} active deployment stack mismatch`);
        }
        if (isObject(deployment.compatibility) && deployment.compatibility.profile !== compatibility.profile) {
          errors.push(`${definition.symbol} active deployment compatibility mismatch`);
        }
      }
    }
    if (token.activeDeploymentId === null) {
      if (active.length) errors.push(`${definition.symbol} has active deployment but null activeDeploymentId`);
    } else if (active.length !== 1 || active[0]?.deploymentId !== token.activeDeploymentId) {
      errors.push(`${definition.symbol} activeDeploymentId does not select exactly one active deployment`);
    }
  }
  if (bySymbol.size !== TOKEN_DEFINITIONS.length) errors.push("registry must contain exactly the six canonical symbols");

  if (value.status === "ready") {
    if (!isNonEmptyString(network.chainId) || !isNonEmptyString(network.stackIdentity)) errors.push("ready registry requires chainId and stackIdentity");
    for (const definition of TOKEN_DEFINITIONS) {
      if (!isNonEmptyString(bySymbol.get(definition.symbol)?.activeDeploymentId)) {
        errors.push(`ready registry requires active ${definition.symbol} deployment`);
      }
    }
  } else if (value.status === "unavailable") {
    for (const definition of TOKEN_DEFINITIONS) {
      if (bySymbol.get(definition.symbol)?.activeDeploymentId !== null) {
        errors.push(`unavailable registry cannot activate ${definition.symbol}`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as TokenRegistry };
}
