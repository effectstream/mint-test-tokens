import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedWalletCapabilities } from '@effectstream/mint-test-token-protocol-interface';
import { useWallet } from './useWallet';

afterEach(() => {
  delete (window as Window & { midnight?: Record<string, unknown> }).midnight;
});

describe('wallet identity reconciliation', () => {
  it('disconnects a same-network connector session after its account changes', async () => {
    let shielded = {
      shieldedAddress: 'mn_shield-addr_preview1accounta',
      shieldedCoinPublicKey: 'mn_shield-cpk_preview1accounta',
      shieldedEncryptionPublicKey: 'mn_shield-epk_preview1accounta',
    };
    const api = {
      getConfiguration: async () => ({
        networkId: 'preview',
        indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws',
        substrateNodeUri: 'wss://node.example',
      }),
      getShieldedAddresses: async () => shielded,
      getUnshieldedAddress: async () => ({ unshieldedAddress: 'mn_addr_preview1accounta' }),
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getProvingProvider: async () => ({}),
      balanceUnsealedTransaction: async () => ({ tx: '00' }),
      submitTransaction: async () => undefined,
    } as ConnectedWalletCapabilities;
    (window as Window & { midnight?: Record<string, unknown> }).midnight = {
      testWallet: { name: 'Test wallet', apiVersion: '4.0.1', connect: vi.fn(async () => api) },
    };
    const { result } = renderHook(() => useWallet('preview', 'preview'));
    await waitFor(() => expect(result.current.state.kind).toBe('disconnected'));
    const option = result.current.state.kind === 'disconnected' ? result.current.state.wallets[0] : undefined;
    expect(option).toBeDefined();
    await act(async () => result.current.connect(option!));
    await waitFor(() => expect(result.current.session).not.toBeNull());

    shielded = { ...shielded, shieldedAddress: 'mn_shield-addr_preview1accountb' };
    await expect(result.current.session!.assertCurrent()).rejects.toThrow('wallet account changed');
    await waitFor(() => expect(result.current.session).toBeNull());
    expect(result.current.state).toMatchObject({ kind: 'error', message: expect.stringContaining('wallet account changed') });
  });
});
