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

/** The parts of `window.location` the local-registry policy reads. */
export type ProbeLocation = Pick<Location, 'hostname' | 'search'>;

const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * True when the origin's hostname is one that can plausibly host a local (undeployed)
 * registry: loopback, an unspecified address, an RFC 1918 or link-local address, an IPv6
 * unique-local or link-local address, or a reserved local-network name suffix.
 *
 * Public names are not local even when they resolve to a loopback address, so a public
 * deployment never probes for a file the release deliberately omits. Use `?local=1` to opt
 * such a host in.
 */
export function isLocalRegistryHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host === '0.0.0.0') return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [first, second] = octets;
    return first === 127
      || first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }

  if (!host.includes(':')) return false;
  if (host === '::1') return true;
  const [firstHextet] = host.split(':');
  if (!/^[0-9a-f]{1,4}$/.test(firstHextet)) return false;
  const prefix = Number.parseInt(firstHextet, 16);
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return (prefix >= 0xfc00 && prefix <= 0xfdff) || (prefix >= 0xfe80 && prefix <= 0xfebf);
}

/**
 * Whether this origin may request `/metadata.undeployed.json` at all. A public host never
 * does unless the URL asks for local mode explicitly, so its console stays free of the
 * expected 404 for a file the public release never contains.
 */
export function localMetadataProbeAllowed(location: ProbeLocation = window.location): boolean {
  if (import.meta.env.DEV) return true;
  const search = new URLSearchParams(location.search);
  return search.get('local') === '1'
    || search.get('network') === 'undeployed'
    || isLocalRegistryHost(location.hostname);
}

export async function localMetadataAvailable(
  signal?: AbortSignal,
  location: ProbeLocation = window.location,
): Promise<boolean> {
  if (import.meta.env.DEV || new URLSearchParams(location.search).get('local') === '1') return true;
  if (!localMetadataProbeAllowed(location)) return false;
  try {
    const response = await fetch('/metadata.undeployed.json', { method: 'HEAD', cache: 'no-store', signal });
    return response.ok && (response.headers.get('content-type')?.includes('application/json') ?? false);
  } catch {
    return false;
  }
}
