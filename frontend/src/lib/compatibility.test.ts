import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CompatibilitySnapshot } from '@effectstream/mint-test-token-registry';
import { describe, expect, it } from 'vitest';
import {
  compatibilityMismatchMessage,
  SUPPORTED_COMPATIBILITY,
  supportsRegistryCompatibility,
} from './compatibility';

describe('browser protocol compatibility', () => {
  it('accepts the exact isolated v1 and aligned v2 cohorts', async () => {
    expect(supportsRegistryCompatibility(SUPPORTED_COMPATIBILITY.v1)).toBe(true);
    expect(supportsRegistryCompatibility(SUPPORTED_COMPATIBILITY.v2)).toBe(true);

    const v1Package = JSON.parse(await readFile(resolve(import.meta.dirname, '../../protocols/v1/package.json'), 'utf8'));
    const v2Package = JSON.parse(await readFile(resolve(import.meta.dirname, '../../protocols/v2/package.json'), 'utf8'));
    expect(v1Package.dependencies['@midnight-ntwrk/compact-runtime']).toBe(SUPPORTED_COMPATIBILITY.v1.compactRuntime);
    expect(v1Package.dependencies['@midnight-ntwrk/compact-js']).toBe('2.5.1');
    expect(v1Package.dependencies['@midnight-ntwrk/midnight-js-contracts']).toBe(SUPPORTED_COMPATIBILITY.v1.midnightJs);
    expect(v1Package.dependencies['@midnight-ntwrk/ledger-v8']).toBe(SUPPORTED_COMPATIBILITY.v1.ledger);
    expect(v2Package.dependencies['@midnight-ntwrk/compact-runtime']).toBe(SUPPORTED_COMPATIBILITY.v2.compactRuntime);
    expect(v2Package.dependencies['@midnight-ntwrk/compact-js']).toBe(SUPPORTED_COMPATIBILITY.v2.compactJs);
    expect(v2Package.dependencies['@midnight-ntwrk/midnight-js-contracts']).toBe(SUPPORTED_COMPATIBILITY.v2.midnightJs);
    expect(v2Package.dependencies['@midnightntwrk/ledger-v9']).toBe(SUPPORTED_COMPATIBILITY.v2.ledger);
  });

  it('rejects the historical beta.6 Stagenet cohort without changing its record', () => {
    const historical: CompatibilitySnapshot = {
      profile: 'v2',
      compiler: '0.33.0-rc.2',
      compactRuntime: '0.18.0-rc.1',
      ledger: '1.0.0-rc.3',
      midnightJs: '5.0.0-beta.6',
      walletSdk: '2.0.0-beta.2',
    };
    expect(supportsRegistryCompatibility(historical)).toBe(false);
    expect(compatibilityMismatchMessage(historical)).toContain('different Midnight release');
    expect(historical).toEqual({
      profile: 'v2',
      compiler: '0.33.0-rc.2',
      compactRuntime: '0.18.0-rc.1',
      ledger: '1.0.0-rc.3',
      midnightJs: '5.0.0-beta.6',
      walletSdk: '2.0.0-beta.2',
    });
  });

  it.each<keyof CompatibilitySnapshot>([
    'compiler', 'language', 'compactJs', 'compactRuntime', 'ledger', 'onchainRuntime', 'midnightJs', 'walletSdk',
  ])('rejects a mismatch in %s', (field) => {
    const mismatched = { ...SUPPORTED_COMPATIBILITY.v2, [field]: 'other-version' };
    expect(supportsRegistryCompatibility(mismatched)).toBe(false);
  });

  it('distinguishes a deployment-evidence mismatch from a release tuple mismatch', () => {
    expect(compatibilityMismatchMessage(SUPPORTED_COMPATIBILITY.v2, false))
      .toContain('deployments have not been verified');
  });
});
