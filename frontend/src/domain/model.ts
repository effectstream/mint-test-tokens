import type { CompatibilitySnapshot } from '@effectstream/mint-test-token-registry';

export type NetworkKey = 'preview' | 'preprod' | 'stagenet' | 'undeployed';
export type PrivacyKind = 'shielded' | 'unshielded';
export type DeploymentState = 'active' | 'superseded' | 'unavailable';

export interface NetworkOption {
  key: NetworkKey;
  label: string;
  shortLabel: string;
}

export const PUBLIC_NETWORKS: readonly NetworkOption[] = [
  { key: 'preview', label: 'Preview', shortLabel: 'Preview' },
  { key: 'preprod', label: 'Preprod', shortLabel: 'Preprod' },
  { key: 'stagenet', label: 'Stagenet', shortLabel: 'Stage' },
];

export const LOCAL_NETWORK: NetworkOption = {
  key: 'undeployed',
  label: 'Local (undeployed)',
  shortLabel: 'Local',
};

export type BalanceState =
  | { kind: 'disconnected' }
  | { kind: 'loading' }
  | { kind: 'refreshing'; formatted: string }
  | { kind: 'ready'; formatted: string; isZero: boolean; updatedAt: Date }
  | { kind: 'stale'; formatted: string; updatedAt: Date }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };

export interface TokenView {
  symbol: string;
  name: string;
  decimals: number;
  privacy: PrivacyKind;
  faucetAmount: string;
  faucetBaseUnits: string;
  deploymentState: DeploymentState;
  issuerAddress: string | null;
  tokenId: string | null;
  explorerUrl: string | null;
  sourceUrl: string | null;
  balance: BalanceState;
}

export interface RegistryView {
  network: NetworkKey;
  networkId: string;
  protocolFamily: 'midnight-1.x' | 'midnight-2.x';
  compatibility: CompatibilitySnapshot;
  chainIdentity: string;
  revision: string;
  verifiedAt: string | null;
  ready: boolean;
  clientCompatible: boolean;
  tokens: TokenView[];
}

export type DirectoryState =
  | { kind: 'loading'; network: NetworkKey }
  | { kind: 'ready'; registry: RegistryView; revalidating: boolean }
  | { kind: 'unavailable'; network: NetworkKey; message: string }
  | { kind: 'error'; network: NetworkKey; message: string };

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  apiVersion: string;
  compatible: boolean;
}

export type WalletState =
  | { kind: 'discovering' }
  | { kind: 'disconnected'; wallets: WalletOption[] }
  | { kind: 'connecting'; walletName: string }
  | {
      kind: 'connected';
      walletName: string;
      accountLabel: string;
      network: NetworkKey;
      capabilities: ReadonlySet<'shielded' | 'unshielded' | 'balance'>;
    }
  | { kind: 'error'; wallets: WalletOption[]; message: string };

export type RecipientKind = 'self' | 'user' | 'contract';

export type MintRecipient =
  | { kind: 'self' }
  | { kind: 'user'; address: string }
  | { kind: 'contract'; address: string };

export type MintState =
  | { kind: 'idle' }
  | { kind: 'reviewing' }
  | { kind: 'awaiting-approval' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; transactionId: string }
  | { kind: 'confirming'; transactionId: string }
  | { kind: 'confirmed'; transactionId: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'uncertain'; message: string; transactionId?: string }
  | { kind: 'failed'; message: string };

export interface MintSession {
  token: TokenView;
  network: NetworkKey;
  registryKey: string;
  recipient: MintRecipient;
  state: MintState;
}
