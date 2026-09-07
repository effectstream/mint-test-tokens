import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRegistry, MetadataUnavailableError, registryView } from './metadata';

afterEach(() => vi.unstubAllGlobals());

describe('runtime token registry', () => {
  it('accepts the canonical six-token file and keeps unavailable identities empty', async () => {
    const body = await readFile(resolve(import.meta.dirname, '../../../metadata/metadata.preview.json'), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })));

    const registry = await fetchRegistry('preview');
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
