import { TOKEN_DEFINITIONS } from "./tokens.js";
import type { NetworkKey, TokenRecord, TokenRegistry } from "./types.js";

export type RegistryValidation =
  | { ok: true; value: TokenRegistry }
  | { ok: false; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

/** Browser-safe semantic validation. JSON Schema validation remains a build gate. */
export function validateRegistry(value: unknown, expectedNetwork?: NetworkKey): RegistryValidation {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["registry must be an object"] };
  if (value.schemaVersion !== "1.0.0") errors.push("unsupported schemaVersion");
  if (!isObject(value.network)) errors.push("network must be an object");
  if (!isObject(value.compatibility)) errors.push("compatibility must be an object");
  if (!Array.isArray(value.tokens)) errors.push("tokens must be an array");
  if (errors.length) return { ok: false, errors };

  const registry = value as unknown as TokenRegistry;
  if (expectedNetwork && registry.network.key !== expectedNetwork) {
    errors.push(`expected ${expectedNetwork}, received ${registry.network.key}`);
  }
  if (registry.network.networkId !== registry.network.key && registry.network.key !== "undeployed") {
    errors.push("public networkId must equal the registry network key");
  }

  const bySymbol = new Map<string, TokenRecord>();
  for (const token of registry.tokens) {
    if (!isObject(token) || typeof token.symbol !== "string") {
      errors.push("each token must have a symbol");
      continue;
    }
    if (bySymbol.has(token.symbol)) errors.push(`duplicate token symbol ${token.symbol}`);
    bySymbol.set(token.symbol, token as unknown as TokenRecord);
  }

  for (const definition of TOKEN_DEFINITIONS) {
    const token = bySymbol.get(definition.symbol);
    if (!token) {
      errors.push(`missing token ${definition.symbol}`);
      continue;
    }
    const expected = definition as unknown as Record<string, unknown>;
    const actual = token as unknown as Record<string, unknown>;
    for (const field of ["name", "decimals", "privacy", "domainSeparator"] as const) {
      if (actual[field] !== expected[field]) errors.push(`${definition.symbol}.${field} mismatch`);
    }
    if (!isObject(actual.faucet) || !sameRecord(actual.faucet, expected.faucet as Record<string, unknown>)) {
      errors.push(`${definition.symbol}.faucet mismatch`);
    }

    const deployments = Array.isArray(token.deployments) ? token.deployments : [];
    const ids = new Set<string>();
    for (const deployment of deployments) {
      if (ids.has(deployment.deploymentId)) errors.push(`${definition.symbol} has duplicate deploymentId`);
      ids.add(deployment.deploymentId);
      if (deployment.network.key !== registry.network.key) errors.push(`${definition.symbol} deployment network key mismatch`);
      if (deployment.network.protocolFamily !== registry.network.protocolFamily) errors.push(`${definition.symbol} deployment protocol mismatch`);
      if (deployment.status === "active" && deployment.deploymentId !== token.activeDeploymentId) {
        errors.push(`${definition.symbol} has an unselected active deployment`);
      }
    }
    const active = deployments.filter((item) => item.status === "active");
    if (token.activeDeploymentId === null) {
      if (active.length) errors.push(`${definition.symbol} has active deployment but null activeDeploymentId`);
    } else if (active.length !== 1 || active[0]?.deploymentId !== token.activeDeploymentId) {
      errors.push(`${definition.symbol} activeDeploymentId does not select exactly one active deployment`);
    }
  }
  if (bySymbol.size !== TOKEN_DEFINITIONS.length) errors.push("registry must contain exactly the six canonical symbols");

  if (registry.status === "ready") {
    if (!registry.network.chainId || !registry.network.stackIdentity) errors.push("ready registry requires chainId and stackIdentity");
    for (const token of registry.tokens) {
      if (!token.activeDeploymentId) errors.push(`ready registry requires active ${token.symbol} deployment`);
    }
  } else if (registry.status === "unavailable") {
    for (const token of registry.tokens) {
      if (token.activeDeploymentId !== null) errors.push(`unavailable registry cannot activate ${token.symbol}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: registry };
}
