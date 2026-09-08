import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unavailableTokens, type TokenRegistry } from '@effectstream/mint-test-token-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRegistry, MetadataUnavailableError, registryView } from './metadata';
import { bundledClientArtifacts } from './clientArtifacts';

afterEach(() => vi.unstubAllGlobals());

const unavailableRegistry: TokenRegistry = {
  schemaVersion: '1.0.0',
  registryRevision: 'unreleased',
  status: 'unavailable',
  generatedAt: '2026-09-07T00:00:00.000Z',
  network: {
    key: 'preprod',
    displayName: 'Preprod',
    protocolFamily: 'midnight-1.x',
    networkId: 'preprod',
    chainId: null,
    stackIdentity: null,
  },
  compatibility: {
    profile: 'v1',
    compiler: '0.31.1',
    compactRuntime: '0.16.0',
    ledger: '8.1.0',
    midnightJs: '4.1.1',
    walletSdk: '1.2.0',
  },
  tokens: unavailableTokens(),
};

describe('runtime token registry', () => {
  it('accepts the canonical six-token unavailable fixture and keeps identities empty', async () => {
    const body = JSON.stringify(unavailableRegistry);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })));

    const registry = await fetchRegistry('preprod');
    const view = registryView(registry);

    expect(view.tokens.map((token) => token.symbol)).toEqual([
      'twBTC', 'twETH', 'twUSDC', 'twUSDM', 'utwUSDC', 'utwBTC',
    ]);
    expect(view.tokens.map((token) => token.faucetBaseUnits)).toEqual([
      '100000000', '5000000000000000000', '10000000000', '10000000000', '10000000000', '100000000',
    ]);
    expect(view.tokens.every((token) => token.issuerAddress === null && token.tokenId === null)).toBe(true);
    expect(view.ready).toBe(false);
    expect(view.clientCompatible).toBe(false);
  });

  it('keeps a historical v2 registry visible without enabling its old client stack', async () => {
    const registry = JSON.parse(await readFile(
      resolve(import.meta.dirname, '../../../metadata/metadata.stagenet.json'),
      'utf8',
    )) as TokenRegistry;
    registry.compatibility = { ...registry.tokens[0].deployments[0].compatibility };
    for (const token of registry.tokens) {
      for (const deployment of token.deployments) delete deployment.compatibilityVerifications;
    }
    const view = registryView(registry);

    expect(view.ready).toBe(true);
    expect(view.clientCompatible).toBe(false);
    expect(view.tokens.every((token) => token.issuerAddress && token.tokenId)).toBe(true);
  });

  it('maps every active Stagenet deployment from the ready public registry', async () => {
    const body = await readFile(resolve(import.meta.dirname, '../../../metadata/metadata.stagenet.json'), 'utf8');
    const request = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', request);

    const registry = await fetchRegistry('stagenet');
    const view = registryView(registry);

    expect(request).toHaveBeenCalledWith('/metadata.stagenet.json', expect.objectContaining({
      method: 'GET',
      cache: 'no-cache',
    }));
    expect(view.ready).toBe(true);
    expect(view.clientCompatible).toBe(true);
    expect(view.revision).toBe(registry.registryRevision);
    expect(view.protocolFamily).toBe('midnight-2.x');
    expect(view.compatibility).toEqual(registry.compatibility);
    expect(view.tokens).toHaveLength(6);

    for (const token of registry.tokens) {
      const active = token.deployments.find((deployment) => deployment.deploymentId === token.activeDeploymentId);
      const mapped = view.tokens.find((candidate) => candidate.symbol === token.symbol);
      expect(active?.status).toBe('active');
      expect(mapped).toMatchObject({
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        privacy: token.privacy,
        deploymentState: 'active',
        issuerAddress: active?.contractAddress,
        tokenId: active?.tokenId,
        faucetBaseUnits: token.faucet.baseUnits,
      });
    }
  });

  it('accepts current v1 deployments through their original artifact provenance', async () => {
    const registry = JSON.parse(await readFile(
      resolve(import.meta.dirname, '../../../metadata/metadata.preview.json'),
      'utf8',
    )) as TokenRegistry;
    const view = registryView(registry);

    expect(view.ready).toBe(true);
    expect(view.clientCompatible).toBe(true);
  });

  it('requires exact independently bundled v2 client evidence for every active deployment', async () => {
    const aligned = JSON.parse(await readFile(
      resolve(import.meta.dirname, '../../../metadata/metadata.stagenet.json'),
      'utf8',
    )) as TokenRegistry;

    expect(registryView(aligned).clientCompatible).toBe(true);

    for (const mutate of [
      (registry: TokenRegistry) => {
        const token = registry.tokens[0];
        const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
        deployment.compatibilityVerifications![0].artifact.sourceRevision = 'e'.repeat(40);
      },
      (registry: TokenRegistry) => {
        const token = registry.tokens[0];
        const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
        deployment.compatibilityVerifications![0].artifact.artifactSha256 = 'f'.repeat(64);
      },
      (registry: TokenRegistry) => {
        const token = registry.tokens[0];
        const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
        deployment.compatibilityVerifications![0].compatibility.midnightJs = '5.0.0-beta.6';
      },
    ]) {
      const mismatched = structuredClone(aligned);
      mutate(mismatched);
      expect(registryView(mismatched).clientCompatible).toBe(false);
    }

    const buildOnlyIdentity = structuredClone(aligned);
    const token = buildOnlyIdentity.tokens[0];
    const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
    deployment.compatibilityVerifications![0].artifact = bundledClientArtifacts('v2', token.privacy).at(-1)!;
    expect(registryView(buildOnlyIdentity).clientCompatible).toBe(false);
  });

  it('accepts same-build local metadata updates and rejects an unverified local source revision', async () => {
    const registry = JSON.parse(await readFile(
      resolve(import.meta.dirname, '../../../metadata/metadata.stagenet.json'),
      'utf8',
    )) as TokenRegistry;
    registry.network = {
      ...registry.network,
      key: 'undeployed',
      displayName: 'Local',
      networkId: 'undeployed',
      chainId: null,
      stackIdentity: 'local-stack-a',
    };
    for (const token of registry.tokens) {
      const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId);
      if (!deployment) throw new Error(`Missing active deployment for ${token.symbol}`);
      const checkoutArtifact = bundledClientArtifacts('v2', token.privacy).at(-1)!;
      deployment.network = { ...registry.network };
      deployment.compatibility = { ...registry.compatibility };
      deployment.artifact = {
        ...deployment.artifact,
        ...checkoutArtifact,
      };
      delete deployment.compatibilityVerifications;
    }

    const first = registryView(registry);
    expect(first.clientCompatible).toBe(true);

    const hotUpdate = structuredClone(registry);
    for (const [index, token] of hotUpdate.tokens.entries()) {
      const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
      deployment.contractAddress = (index + 1).toString(16).padStart(64, '0');
      deployment.tokenId = (index + 7).toString(16).padStart(64, '0');
    }
    expect(registryView(hotUpdate).clientCompatible).toBe(true);

    const wrongSource = structuredClone(hotUpdate);
    const token = wrongSource.tokens[0];
    const deployment = token.deployments.find((candidate) => candidate.deploymentId === token.activeDeploymentId)!;
    deployment.artifact.sourceRevision = 'a'.repeat(40);
    expect(registryView(wrongSource).clientCompatible).toBe(false);
  });

  it('treats a real HTTP 404 as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
    await expect(fetchRegistry('undeployed')).rejects.toBeInstanceOf(MetadataUnavailableError);
  });

  it('rejects an HTML fallback before parsing it as registry data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html />', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));
    await expect(fetchRegistry('preview')).rejects.toThrow('Expected JSON metadata');
  });
});
