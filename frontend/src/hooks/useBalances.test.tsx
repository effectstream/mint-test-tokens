import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TokenView } from '../domain/model';
import { useBalances } from './useBalances';
import type { ConnectedWalletSession } from './useWallet';

function token(symbol: string, tokenId: string, privacy: TokenView['privacy'], decimals: number): TokenView {
  return {
    symbol,
    name: symbol,
    decimals,
    privacy,
    faucetAmount: '1',
    faucetBaseUnits: '1',
    deploymentState: 'active',
    issuerAddress: 'issuer',
    tokenId,
    explorerUrl: null,
    sourceUrl: null,
    balance: { kind: 'disconnected' },
  };
}

function wallet(
  id: number,
  shielded: () => Promise<Record<string, bigint>>,
  unshielded: () => Promise<Record<string, bigint>>,
): ConnectedWalletSession {
  return {
    id,
    walletId: `wallet-${id}`,
    walletName: 'Test wallet',
    network: 'preview',
    networkId: 'preview',
    shieldedAddress: 'shielded',
    shieldedCoinPublicKey: 'coin',
    shieldedEncryptionPublicKey: 'encryption',
    unshieldedAddress: 'user',
    api: {
      getShieldedBalances: shielded,
      getUnshieldedBalances: unshielded,
    } as ConnectedWalletSession['api'],
  };
}

describe('wallet balances', () => {
  it('distinguishes exact zero and formats both privacy modes', async () => {
    const tokens = [token('twBTC', 'abc', 'shielded', 8), token('utwUSDC', 'def', 'unshielded', 6)];
    const session = wallet(1, async () => ({ '0xABC': 0n }), async () => ({ def: 12_345_000n }));
    const { result } = renderHook(() => useBalances(tokens, session));

    await waitFor(() => expect(result.current.balances.twBTC?.kind).toBe('ready'));
    expect(result.current.balances.twBTC).toMatchObject({ kind: 'ready', formatted: '0', isZero: true });
    expect(result.current.balances.utwUSDC).toMatchObject({ kind: 'ready', formatted: '12.345', isZero: false });
  });

  it('ignores a late response from a replaced wallet session', async () => {
    let resolveOld: ((value: Record<string, bigint>) => void) | undefined;
    const oldShielded = new Promise<Record<string, bigint>>((resolve) => { resolveOld = resolve; });
    const tokens = [token('twBTC', 'abc', 'shielded', 8)];
    const first = wallet(1, () => oldShielded, async () => ({}));
    const second = wallet(2, async () => ({ abc: 200_000_000n }), async () => ({}));
    const { result, rerender } = renderHook(
      ({ session }) => useBalances(tokens, session),
      { initialProps: { session: first } },
    );

    await waitFor(() => expect(result.current.balances.twBTC?.kind).toBe('loading'));
    rerender({ session: second });
    await waitFor(() => expect(result.current.balances.twBTC).toMatchObject({ formatted: '2' }));
    await act(async () => resolveOld?.({ abc: 900_000_000n }));
    expect(result.current.balances.twBTC).toMatchObject({ formatted: '2' });
  });
});
