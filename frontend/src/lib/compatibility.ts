import {
  compatibilitySnapshotsEqual,
  type CompatibilitySnapshot,
} from '@effectstream/mint-test-token-registry';

export const SUPPORTED_COMPATIBILITY: Readonly<Record<'v1' | 'v2', CompatibilitySnapshot>> = Object.freeze({
  v1: Object.freeze({
    profile: 'v1',
    compiler: '0.31.1',
    compactRuntime: '0.16.0',
    ledger: '8.1.0',
    midnightJs: '4.1.1',
    walletSdk: '1.2.0',
  }),
  v2: Object.freeze({
    profile: 'v2',
    compiler: '0.34.0',
    language: '0.26.0',
    compactJs: '2.5.5-rc.8',
    compactRuntime: '0.19.0',
    ledger: '1.0.0-rc.3',
    onchainRuntime: '4.0.0-rc.3',
    midnightJs: '5.0.0-beta.7',
    walletSdk: '2.0.0-beta.2',
  }),
});

export function supportsRegistryCompatibility(actual: CompatibilitySnapshot): boolean {
  const expected = SUPPORTED_COMPATIBILITY[actual.profile];
  return compatibilitySnapshotsEqual(actual, expected);
}

export function compatibilityMismatchMessage(
  actual: CompatibilitySnapshot,
  clientCompatible = true,
): string | null {
  if (!supportsRegistryCompatibility(actual)) {
    return `This ${actual.profile.toUpperCase()} registry uses a different Midnight release than this site build. Open a matching site release or select another network.`;
  }
  return clientCompatible
    ? null
    : 'The selected deployments have not been verified with this site release. Open a matching site release or select another network.';
}
