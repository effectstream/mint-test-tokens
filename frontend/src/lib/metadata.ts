import {
  deploymentSupportsCompatibility,
  validateRegistry,
  type NetworkKey as RegistryNetworkKey,
  type TokenRecord,
  type TokenRegistry,
} from '@effectstream/mint-test-token-registry';
import type { BalanceState, NetworkKey, RegistryView, TokenView } from '../domain/model';
import { formatHumanAmount } from './format';
import { bundledClientArtifacts } from './clientArtifacts';
import { supportsRegistryCompatibility } from './compatibility';

export class MetadataUnavailableError extends Error {
  constructor(readonly network: NetworkKey) {
    super(`No metadata file is published for ${network}.`);
    this.name = 'MetadataUnavailableError';
  }
}

function activeDeployment(token: TokenRecord) {
  if (!token.activeDeploymentId) return null;
  return token.deployments.find((deployment) =>
    deployment.deploymentId === token.activeDeploymentId && deployment.status === 'active') ?? null;
}

function disconnectedBalance(): BalanceState {
  return { kind: 'disconnected' };
}

function tokenView(network: NetworkKey, token: TokenRecord): TokenView {
  const deployment = activeDeployment(token);
  return {
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    privacy: token.privacy,
    faucetAmount: formatHumanAmount(token.faucet.humanAmount),
    faucetBaseUnits: token.faucet.baseUnits,
    deploymentState: deployment ? 'active' : token.deployments.length ? 'superseded' : 'unavailable',
    issuerAddress: deployment?.contractAddress ?? null,
    tokenId: deployment?.tokenId ?? null,
    explorerUrl: null,
    sourceUrl: `https://github.com/effectstream/mint-test-tokens/blob/main/metadata/metadata.${network}.json`,
    balance: disconnectedBalance(),
  };
}

export function registryView(registry: TokenRegistry): RegistryView {
  const activeVerifiedDates = registry.tokens.flatMap((token) => {
    const deployment = activeDeployment(token);
    return deployment ? [deployment.verifiedAt] : [];
  });
  const clientCompatible = supportsRegistryCompatibility(registry.compatibility) && registry.tokens.every((token) => {
    const deployment = activeDeployment(token);
    const bundledArtifacts = bundledClientArtifacts(registry.compatibility.profile, token.privacy);
    const eligibleArtifacts = registry.network.key === 'undeployed' ? bundledArtifacts : bundledArtifacts.slice(0, 1);
    return deployment !== null && eligibleArtifacts.some(
      (clientArtifact) => deploymentSupportsCompatibility(deployment, registry.compatibility, clientArtifact),
    );
  });
  return {
    network: registry.network.key,
    networkId: registry.network.networkId,
    protocolFamily: registry.network.protocolFamily,
    compatibility: { ...registry.compatibility },
    chainIdentity: registry.network.chainId ?? registry.network.stackIdentity ?? registry.network.networkId,
    revision: registry.registryRevision,
    verifiedAt: activeVerifiedDates.sort().at(-1) ?? null,
    ready: registry.status === 'ready' && registry.tokens.every((token) => activeDeployment(token)),
    clientCompatible,
    tokens: registry.tokens.map((token) => tokenView(registry.network.key, token)),
  };
}

export async function fetchRegistry(network: NetworkKey, signal?: AbortSignal): Promise<TokenRegistry> {
  const response = await fetch(`/metadata.${network}.json`, {
    method: 'GET',
    cache: 'no-cache',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404) throw new MetadataUnavailableError(network);
  if (!response.ok) throw new Error(`Metadata request failed with HTTP ${response.status}.`);

  const mediaType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!mediaType.includes('application/json')) {
    throw new Error(`Expected JSON metadata but received ${mediaType || 'an unknown content type'}.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error('Metadata response is not valid JSON.');
  }
  const result = validateRegistry(value, network as RegistryNetworkKey);
  if (!result.ok) throw new Error(`Metadata validation failed: ${result.errors.join('; ')}`);
  return result.value;
}

export async function localMetadataAvailable(signal?: AbortSignal): Promise<boolean> {
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).get('local') === '1') return true;
  try {
    const response = await fetch('/metadata.undeployed.json', { method: 'HEAD', cache: 'no-store', signal });
    return response.ok && (response.headers.get('content-type')?.includes('application/json') ?? false);
  } catch {
    return false;
  }
}
