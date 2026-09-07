import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateRegistry } from "../../packages/registry/src/semantic.js";
import { TOKEN_DEFINITIONS, unavailableTokens } from "../../packages/registry/src/tokens.js";
import type {
  CompatibilitySnapshot,
  DeploymentRecord,
  NetworkIdentity,
  TokenRegistry,
  TokenSymbol
} from "../../packages/registry/src/types.js";
import { withFileLock, writeJsonAtomic } from "./atomic-json.js";

export type DeploymentSet = ReadonlyMap<TokenSymbol, DeploymentRecord>;

export function deploymentRevision(network: NetworkIdentity, deployments: DeploymentSet): string {
  const identities = TOKEN_DEFINITIONS.map(({ symbol }) => {
    const record = deployments.get(symbol);
    if (!record) throw new Error(`Cannot derive revision without ${symbol}`);
    return {
      symbol,
      deploymentId: record.deploymentId,
      contractAddress: record.contractAddress,
      tokenId: record.tokenId,
      artifactSha256: record.artifact.artifactSha256
    };
  });
  return createHash("sha256").update(JSON.stringify({ network, identities })).digest("hex");
}

export async function readRegistry(path: string): Promise<TokenRegistry | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as TokenRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function promoteReadyRegistry(options: {
  existing?: TokenRegistry;
  network: NetworkIdentity;
  compatibility: CompatibilitySnapshot;
  deployments: DeploymentSet;
  revision: string;
  generatedAt: string;
}): TokenRegistry {
  const { existing, network, compatibility, deployments, revision, generatedAt } = options;
  const existingBySymbol = new Map((existing?.tokens ?? unavailableTokens()).map((token) => [token.symbol, token]));
  const tokens = TOKEN_DEFINITIONS.map((definition) => {
    const deployment = deployments.get(definition.symbol);
    if (!deployment) throw new Error(`Cannot publish ready registry without ${definition.symbol}`);
    const old = existingBySymbol.get(definition.symbol);
    const history = (old?.deployments ?? [])
      .filter((item) => item.deploymentId !== deployment.deploymentId)
      .map((item) => ({
        ...item,
        status: "superseded" as const,
        deploymentToolchain: item.deploymentToolchain ?? null
      }));
    return {
      ...definition,
      faucet: { ...definition.faucet },
      activeDeploymentId: deployment.deploymentId,
      deployments: [...history, { ...deployment, status: "active" as const }]
    };
  });
  const registry: TokenRegistry = {
    schemaVersion: "1.0.0",
    registryRevision: revision,
    status: "ready",
    generatedAt,
    network,
    compatibility,
    tokens
  };
  const validation = validateRegistry(registry, network.key);
  if (!validation.ok) throw new Error(`Refusing invalid registry promotion:\n${validation.errors.join("\n")}`);
  return registry;
}

export async function publishReadyRegistry(
  path: string,
  options: Parameters<typeof promoteReadyRegistry>[0]
): Promise<TokenRegistry> {
  return withFileLock(path, async () => {
    const existing = await readRegistry(path);
    const registry = promoteReadyRegistry({ ...options, existing });
    await writeJsonAtomic(path, registry, 0o644);
    return registry;
  });
}

export async function markRegistryStale(path: string, network: NetworkIdentity): Promise<TokenRegistry | undefined> {
  return withFileLock(path, async () => {
    const existing = await readRegistry(path);
    if (!existing || existing.network.key !== network.key || existing.status === "stale") return existing;
    const stale: TokenRegistry = {
      ...existing,
      status: "stale",
      registryRevision: createHash("sha256").update(`${existing.registryRevision}:stale`).digest("hex"),
      generatedAt: new Date().toISOString()
    };
    const validation = validateRegistry(stale, network.key);
    if (!validation.ok) throw new Error(`Refusing invalid stale registry:\n${validation.errors.join("\n")}`);
    await writeJsonAtomic(path, stale, 0o644);
    return stale;
  });
}
