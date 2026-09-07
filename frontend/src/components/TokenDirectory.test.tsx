import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryState, TokenView, WalletState } from '../domain/model';
import { TokenDirectory } from './TokenDirectory';

const token: TokenView = {
  symbol: 'twBTC',
  name: 'Test-wrapped BTC',
  decimals: 8,
  privacy: 'shielded',
  faucetAmount: '1',
  faucetBaseUnits: '100000000',
  deploymentState: 'active',
  issuerAddress: 'issuer-active-but-stale',
  tokenId: 'token-active-but-stale',
  explorerUrl: null,
  sourceUrl: null,
  balance: { kind: 'ready', formatted: '0', isZero: true, updatedAt: new Date() },
};

const wallet: WalletState = {
  kind: 'connected',
  walletName: 'Test wallet',
  accountLabel: 'account',
  network: 'preview',
  capabilities: new Set(['shielded', 'unshielded', 'balance']),
};

function directory(ready: boolean, revalidating = false): DirectoryState {
  return {
    kind: 'ready',
    revalidating,
    registry: {
      network: 'preview',
      networkId: 'preview',
      protocolFamily: 'midnight-1.x',
      chainIdentity: 'preview-chain',
      revision: ready ? 'ready-revision' : 'deploying-revision',
      verifiedAt: null,
      ready,
      tokens: [token],
    },
  };
}

describe('token directory readiness', () => {
  it('keeps mint disabled for non-ready or revalidating registries with active identities', () => {
    const props = {
      wallet,
      mintAvailable: true,
      onMint: vi.fn(),
      onRefreshBalance: vi.fn(),
      onRetryMetadata: vi.fn(),
    };
    const { rerender } = render(<TokenDirectory directory={directory(false)} {...props} />);
    expect((screen.getByRole('button', { name: 'Mint 1 twBTC' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('minting stays disabled');

    rerender(<TokenDirectory directory={directory(true, true)} {...props} />);
    expect((screen.getByRole('button', { name: 'Mint 1 twBTC' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<TokenDirectory directory={directory(true)} {...props} />);
    expect((screen.getByRole('button', { name: 'Mint 1 twBTC' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
