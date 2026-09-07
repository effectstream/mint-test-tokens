import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MintRequest, TokenProtocolAdapter } from '@effectstream/mint-test-token-protocol-interface';
import type { TokenView } from '../domain/model';
import { useMintFlow } from './useMintFlow';
import type { ConnectedWalletSession } from './useWallet';

const twBTC: TokenView = {
  symbol: 'twBTC',
  name: 'Test-wrapped BTC',
  decimals: 8,
  privacy: 'shielded',
  faucetAmount: '1',
  faucetBaseUnits: '100000000',
  deploymentState: 'active',
  issuerAddress: 'issuer',
  tokenId: 'aabb',
  explorerUrl: null,
  sourceUrl: null,
  balance: { kind: 'disconnected' },
};

const wallet = {
  id: 1,
  walletId: 'wallet',
  walletName: 'Test wallet',
  network: 'preview',
  networkId: 'preview',
  shieldedAddress: 'shielded-address',
  shieldedCoinPublicKey: 'coin-key',
  shieldedEncryptionPublicKey: 'encryption-key',
  unshieldedAddress: 'user-address',
  api: {} as ConnectedWalletSession['api'],
} satisfies ConnectedWalletSession;

describe('mint flow', () => {
  it('uses the exact fixed integer amount and refreshes after finalization', async () => {
    let request: MintRequest | undefined;
    const refresh = vi.fn();
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: async () => ({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: '0xAABB' }),
      readBalance: async () => 0n,
      mint: async (value) => {
        request = value;
        return {
          transactionId: 'tx-1',
          status: 'submitted',
          receiptDelivery: 'encrypted-output',
          shieldedCoinInfo: { nonce: new Uint8Array(32), color: new Uint8Array(32), value: value.amount },
          waitForFinalization: async () => ({ transactionId: 'tx-1', blockHeight: 42n }),
        };
      },
    };
    const { result } = renderHook(() => useMintFlow({
      network: 'preview',
      registryKey: 'preview-rev-1',
      protocolFamily: 'midnight-1.x',
      adapter,
      wallet,
      onConfirmedToSelf: refresh,
    }));

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    await act(() => result.current.confirm());

    expect(request?.amount).toBe(100_000_000n);
    expect(request?.recipient).toEqual({
      kind: 'shielded-user',
      shieldedAddress: 'shielded-address',
      coinPublicKey: 'coin-key',
      encryptionPublicKey: 'encryption-key',
    });
    expect(result.current.session?.state).toEqual({ kind: 'confirmed', transactionId: 'tx-1' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reports a wallet rejection as cancelled with no blind retry', async () => {
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: async () => ({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: twBTC.tokenId! }),
      readBalance: async () => 0n,
      mint: async () => { throw { code: 'USER_REJECTED', reason: 'User declined request' }; },
    };
    const { result } = renderHook(() => useMintFlow({
      network: 'preview',
      registryKey: 'preview-rev-1',
      protocolFamily: 'midnight-1.x',
      adapter,
      wallet,
      onConfirmedToSelf: vi.fn(),
    }));

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    await act(() => result.current.confirm());
    await waitFor(() => expect(result.current.session?.state.kind).toBe('cancelled'));
  });

  it('keeps the known transaction id when finalization becomes uncertain', async () => {
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: async () => ({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: twBTC.tokenId! }),
      readBalance: async () => 0n,
      mint: async () => ({
        transactionId: 'tx-known',
        status: 'submitted',
        receiptDelivery: 'encrypted-output',
        waitForFinalization: async () => { throw new Error('Indexer connection closed.'); },
      }),
    };
    const { result } = renderHook(() => useMintFlow({
      network: 'preview',
      registryKey: 'preview-rev-1',
      protocolFamily: 'midnight-1.x',
      adapter,
      wallet,
      onConfirmedToSelf: vi.fn(),
    }));

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    await act(() => result.current.confirm());

    expect(result.current.session?.state).toMatchObject({ kind: 'uncertain', transactionId: 'tx-known' });
  });

  it('invalidates review when the canonical registry identity changes', async () => {
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: async () => ({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: twBTC.tokenId! }),
      readBalance: async () => 0n,
      mint: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ registryKey }) => useMintFlow({
        network: 'preview', registryKey, protocolFamily: 'midnight-1.x', adapter, wallet, onConfirmedToSelf: vi.fn(),
      }),
      { initialProps: { registryKey: 'preview-rev-1' } },
    );

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    rerender({ registryKey: 'preview-rev-2' });

    await waitFor(() => expect(result.current.session).toBeNull());
  });

  it('does not submit after the wallet changes during metadata preflight', async () => {
    let resolveMetadata: ((value: { name: string; symbol: string; decimals: number; tokenId: string }) => void) | undefined;
    const metadata = new Promise<{ name: string; symbol: string; decimals: number; tokenId: string }>((resolve) => {
      resolveMetadata = resolve;
    });
    const mint = vi.fn();
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: () => metadata,
      readBalance: async () => 0n,
      mint,
    };
    const replacement = { ...wallet, id: 2, walletId: 'replacement' };
    const { result, rerender } = renderHook(
      ({ connectedWallet }) => useMintFlow({
        network: 'preview', registryKey: 'preview-rev-1', protocolFamily: 'midnight-1.x', adapter,
        wallet: connectedWallet, onConfirmedToSelf: vi.fn(),
      }),
      { initialProps: { connectedWallet: wallet } },
    );

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.confirm(); });
    rerender({ connectedWallet: replacement });
    await act(async () => {
      resolveMetadata?.({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: twBTC.tokenId! });
      await pending;
    });

    expect(mint).not.toHaveBeenCalled();
    expect(result.current.session?.state).toMatchObject({ kind: 'failed' });
  });

  it('does not replace or reset an in-flight request', async () => {
    let resolveMint: ((value: Awaited<ReturnType<TokenProtocolAdapter['mint']>>) => void) | undefined;
    const submitted = new Promise<Awaited<ReturnType<TokenProtocolAdapter['mint']>>>((resolve) => { resolveMint = resolve; });
    const adapter: TokenProtocolAdapter = {
      protocolFamily: 'midnight-1.x',
      readMetadata: async () => ({ name: twBTC.name, symbol: twBTC.symbol, decimals: 8, tokenId: twBTC.tokenId! }),
      readBalance: async () => 0n,
      mint: () => submitted,
    };
    const { result } = renderHook(() => useMintFlow({
      network: 'preview', registryKey: 'preview-rev-1', protocolFamily: 'midnight-1.x', adapter, wallet,
      onConfirmedToSelf: vi.fn(),
    }));

    act(() => result.current.begin(twBTC));
    act(() => result.current.review({ kind: 'self' }));
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.confirm(); });
    await waitFor(() => expect(result.current.session?.state.kind).toBe('submitting'));
    act(() => result.current.begin({ ...twBTC, symbol: 'twETH' }));
    act(() => result.current.reset());
    expect(result.current.session?.token.symbol).toBe('twBTC');
    expect(result.current.session?.state.kind).toBe('submitting');
    await act(async () => {
      resolveMint?.({
        transactionId: 'tx-lock', status: 'submitted', receiptDelivery: 'encrypted-output',
        waitForFinalization: async () => ({ transactionId: 'tx-lock' }),
      });
      await pending;
    });
  });
});
