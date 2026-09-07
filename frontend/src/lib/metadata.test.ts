import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unavailableTokens, type TokenRegistry } from '@effectstream/mint-test-token-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRegistry, MetadataUnavailableError, registryView } from './metadata';

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
