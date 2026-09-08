import values from '../../.generated/client-artifacts.json';
import type { PrivacyKind } from '../domain/model';

export interface ClientArtifactIdentity {
  sourceRevision: string;
  compilerVersion: string;
  artifactSha256: string;
}

export type BrowserProfile = 'v1' | 'v2';

export const BUNDLED_CLIENT_ARTIFACTS = values as Readonly<
  Record<BrowserProfile, Readonly<Record<PrivacyKind, readonly Readonly<ClientArtifactIdentity>[]>>>
>;

export function bundledClientArtifacts(profile: BrowserProfile, privacy: PrivacyKind): readonly ClientArtifactIdentity[] {
  return BUNDLED_CLIENT_ARTIFACTS[profile][privacy].map((identity) => ({ ...identity }));
}
