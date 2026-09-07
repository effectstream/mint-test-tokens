import { describe, expect, it, vi } from 'vitest';
import type { ConnectedWalletCapabilities, MintRequest } from '@effectstream/mint-test-token-protocol-interface';
import { createProtocolAdapter, type FinalizedTransactionLike, type ProtocolBridge } from './adapter-core';

describe('protocol adapter wallet boundary', () => {
  it('submits the wallet-balanced bytes and waits for an exact success', async () => {
    const submitTransaction = vi.fn(async () => undefined);
    const getProvingProvider = vi.fn(async () => ({ walletOwned: true }));
    const publicData = {
      queryContractState: vi.fn(),
      queryZSwapAndContractState: vi.fn(async () => null),
      watchForTxData: vi.fn(async () => ({ status: 'ok', blockHeight: 77, blockHash: 'block-77' })),
    };
    const api = {
      getConfiguration: async () => ({
        networkId: 'preview',
        indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws',
        substrateNodeUri: 'wss://node.example',
      }),
      getProvingProvider,
      balanceUnsealedTransaction: async () => ({ tx: 'aabbcc' }),
      submitTransaction,
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: 'user' }),
    } as ConnectedWalletCapabilities;
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x',
      setNetworkId: vi.fn(),
      createPublicDataProvider: () => publicData,
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({ source: 'site' }) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx-1'], serialize: () => new Uint8Array([9, 9]) }),
      isSuccessStatus: (status) => status === 'ok',
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint: async (providers) => {
        const finalized = await (providers.walletProvider as {
          balanceTx(tx: { serialize(): Uint8Array }): Promise<{ identifiers(): string[]; serialize(): Uint8Array }>;
        }).balanceTx({ serialize: () => new Uint8Array([1, 2]) });
        const transactionId = await (providers.midnightProvider as {
          submitTx(tx: typeof finalized): Promise<string>;
        }).submitTx(finalized);
        return { transactionId };
      },
    };
    const adapter = createProtocolAdapter({
      api,
      networkId: 'preview',
      shieldedAddress: 'shielded',
      shieldedCoinPublicKey: 'coin',
      shieldedEncryptionPublicKey: 'encryption',
      assertCurrent: api.getConfiguration,
    }, bridge);
    const request: MintRequest = {
      networkKey: 'preview',
      contractAddress: 'issuer',
      tokenId: 'id',
      privacy: 'unshielded',
      recipient: { kind: 'unshielded-user', userAddress: 'user' },
      amount: 1n,
    };

    const submission = await adapter.mint(request);
    expect(submitTransaction).toHaveBeenCalledWith('aabbcc');
    expect(getProvingProvider).toHaveBeenCalledWith({ source: 'site' });
    await expect(submission.waitForFinalization()).resolves.toEqual({
      transactionId: 'tx-1',
      blockHeight: 77n,
      blockHash: 'block-77',
    });
    adapter.dispose();
  });

  it('does not misclassify a chain rejection and keeps its transaction identifier', async () => {
    const api = {
      getConfiguration: async () => ({ networkId: 'preview', indexerUri: 'https://i', indexerWsUri: 'wss://i', substrateNodeUri: 'wss://n' }),
      getProvingProvider: async () => ({}),
      balanceUnsealedTransaction: async () => ({ tx: 'aabb' }),
      submitTransaction: async () => { throw new Error('transaction rejected by chain'); },
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: 'user' }),
    } as ConnectedWalletCapabilities;
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x',
      setNetworkId: () => undefined,
      createPublicDataProvider: () => ({ queryContractState: async () => null, watchForTxData: async () => ({ status: 'ok' }) }),
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({}) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx-uncertain'], serialize: () => new Uint8Array([2]) }),
      isSuccessStatus: () => true,
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint: async (providers) => {
        const tx = await (providers.walletProvider as any).balanceTx({ serialize: () => new Uint8Array([1]) });
        return { transactionId: await (providers.midnightProvider as any).submitTx(tx) };
      },
    };
    const adapter = createProtocolAdapter({
      api, networkId: 'preview', shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc',
      assertCurrent: api.getConfiguration,
    }, bridge);
    const request: MintRequest = {
      networkKey: 'preview', contractAddress: 'issuer', tokenId: 'id', privacy: 'unshielded',
      recipient: { kind: 'unshielded-user', userAddress: 'user' }, amount: 1n,
    };

    await expect(adapter.mint(request)).rejects.toMatchObject({ transactionId: 'tx-uncertain' });
  });

  it('stops before proving submission when the wallet network changes', async () => {
    let activeNetwork = 'preview';
    let releaseProvingProvider: (() => void) | undefined;
    let provingProviderStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { provingProviderStarted = resolve; });
    const provingProvider = new Promise<object>((resolve) => {
      releaseProvingProvider = () => resolve({ walletOwned: true });
    });
    const submitMint = vi.fn();
    const api = {
      getConfiguration: async () => ({
        networkId: activeNetwork,
        indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws',
        substrateNodeUri: 'wss://node.example',
      }),
      getProvingProvider: async () => {
        provingProviderStarted?.();
        return provingProvider;
      },
      balanceUnsealedTransaction: async () => ({ tx: 'aabb' }),
      submitTransaction: vi.fn(),
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: 'user' }),
    } as ConnectedWalletCapabilities;
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x',
      setNetworkId: vi.fn(),
      createPublicDataProvider: () => ({ queryContractState: async () => null, watchForTxData: async () => ({ status: 'ok' }) }),
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({}) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx'], serialize: () => new Uint8Array([1]) }),
      isSuccessStatus: () => true,
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint,
    };
    const adapter = createProtocolAdapter({
      api, networkId: 'preview', shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc',
      assertCurrent: api.getConfiguration,
    }, bridge);
    const pending = adapter.mint({
      networkKey: 'preview', contractAddress: 'issuer', tokenId: 'id', privacy: 'shielded',
      recipient: { kind: 'shielded-user', shieldedAddress: 'shielded', coinPublicKey: 'coin', encryptionPublicKey: 'enc' },
      amount: 1n,
    });

    await started;
    activeNetwork = 'preprod';
    releaseProvingProvider?.();

    await expect(pending).rejects.toThrow('Wallet changed to preprod');
    expect(submitMint).not.toHaveBeenCalled();
  });

  it('stops after a readiness-triggered disposal during proving', async () => {
    let releaseProvingProvider: (() => void) | undefined;
    let provingProviderStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { provingProviderStarted = resolve; });
    const provingProvider = new Promise<object>((resolve) => {
      releaseProvingProvider = () => resolve({ walletOwned: true });
    });
    const api = {
      getConfiguration: async () => ({
        networkId: 'preview', indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws', substrateNodeUri: 'wss://node.example',
      }),
      getProvingProvider: async () => {
        provingProviderStarted?.();
        return provingProvider;
      },
      balanceUnsealedTransaction: async () => ({ tx: 'aabb' }),
      submitTransaction: vi.fn(),
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: 'user' }),
    } as ConnectedWalletCapabilities;
    const submitMint = vi.fn();
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x', setNetworkId: vi.fn(),
      createPublicDataProvider: () => ({ queryContractState: async () => null, watchForTxData: async () => ({ status: 'ok' }) }),
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({}) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx'], serialize: () => new Uint8Array([1]) }),
      isSuccessStatus: () => true,
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint,
    };
    const adapter = createProtocolAdapter({
      api, networkId: 'preview', shieldedAddress: 'shielded', shieldedCoinPublicKey: 'coin', shieldedEncryptionPublicKey: 'enc',
      assertCurrent: api.getConfiguration,
    }, bridge);
    const pending = adapter.mint({
      networkKey: 'preview', contractAddress: 'issuer', tokenId: 'id', privacy: 'shielded',
      recipient: { kind: 'shielded-user', shieldedAddress: 'shielded', coinPublicKey: 'coin', encryptionPublicKey: 'enc' },
      amount: 1n,
    });

    await started;
    adapter.dispose();
    releaseProvingProvider?.();

    await expect(pending).rejects.toThrow('wallet session was disconnected');
    expect(submitMint).not.toHaveBeenCalled();
  });

  it('stops when the same-network account changes during proving-provider approval', async () => {
    let account = 'A';
    let releaseProvingProvider: (() => void) | undefined;
    let provingProviderStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { provingProviderStarted = resolve; });
    const provingProvider = new Promise<object>((resolve) => {
      releaseProvingProvider = () => resolve({ walletOwned: true });
    });
    const api = {
      getConfiguration: async () => ({
        networkId: 'preview', indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws', substrateNodeUri: 'wss://node.example',
      }),
      getProvingProvider: async () => {
        provingProviderStarted?.();
        return provingProvider;
      },
      balanceUnsealedTransaction: async () => ({ tx: 'aabb' }),
      submitTransaction: vi.fn(),
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: account, shieldedCoinPublicKey: account, shieldedEncryptionPublicKey: account }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: account }),
    } as ConnectedWalletCapabilities;
    const submitMint = vi.fn();
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x', setNetworkId: vi.fn(),
      createPublicDataProvider: () => ({ queryContractState: async () => null, watchForTxData: async () => ({ status: 'ok' }) }),
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({}) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx'], serialize: () => new Uint8Array([1]) }),
      isSuccessStatus: () => true,
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint,
    };
    const assertCurrent = async () => {
      if (account !== 'A') throw new Error('The wallet account changed.');
      return api.getConfiguration();
    };
    const adapter = createProtocolAdapter({
      api, networkId: 'preview', shieldedAddress: 'A', shieldedCoinPublicKey: 'A', shieldedEncryptionPublicKey: 'A',
      assertCurrent,
    }, bridge);
    const pending = adapter.mint({
      networkKey: 'preview', contractAddress: 'issuer', tokenId: 'id', privacy: 'shielded',
      recipient: { kind: 'shielded-user', shieldedAddress: 'A', coinPublicKey: 'A', encryptionPublicKey: 'A' },
      amount: 1n,
    });

    await started;
    account = 'B';
    releaseProvingProvider?.();

    await expect(pending).rejects.toThrow('wallet account changed');
    expect(submitMint).not.toHaveBeenCalled();
  });

  it('stops when the same-network account changes during wallet balancing', async () => {
    let account = 'A';
    let releaseBalance: (() => void) | undefined;
    let balanceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { balanceStarted = resolve; });
    const balanced = new Promise<{ tx: string }>((resolve) => {
      releaseBalance = () => resolve({ tx: 'aabb' });
    });
    const submitTransaction = vi.fn();
    const api = {
      getConfiguration: async () => ({
        networkId: 'preview', indexerUri: 'https://indexer.example/graphql',
        indexerWsUri: 'wss://indexer.example/graphql/ws', substrateNodeUri: 'wss://node.example',
      }),
      getProvingProvider: async () => ({}),
      balanceUnsealedTransaction: async () => {
        balanceStarted?.();
        return balanced;
      },
      submitTransaction,
      getShieldedBalances: async () => ({}),
      getUnshieldedBalances: async () => ({}),
      getShieldedAddresses: async () => ({ shieldedAddress: account, shieldedCoinPublicKey: account, shieldedEncryptionPublicKey: account }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: account }),
    } as ConnectedWalletCapabilities;
    const bridge: ProtocolBridge = {
      protocolFamily: 'midnight-1.x', setNetworkId: vi.fn(),
      createPublicDataProvider: () => ({ queryContractState: async () => null, watchForTxData: async () => ({ status: 'ok' }) }),
      createZkConfigProvider: () => ({ asKeyMaterialProvider: () => ({}) }),
      createProofProvider: (provider) => provider,
      deserializeFinalizedTransaction: () => ({ identifiers: () => ['tx'], serialize: () => new Uint8Array([1]) }),
      isSuccessStatus: () => true,
      readMetadata: async () => ({ name: 'Token', symbol: 'TKN', decimals: 6, tokenId: 'id' }),
      submitMint: async (providers) => {
        const transaction = await (providers.walletProvider as {
          balanceTx(tx: { serialize(): Uint8Array }): Promise<FinalizedTransactionLike>;
        }).balanceTx({ serialize: () => new Uint8Array([1]) });
        return {
          transactionId: await (providers.midnightProvider as {
            submitTx(tx: FinalizedTransactionLike): Promise<string>;
          }).submitTx(transaction),
        };
      },
    };
    const assertCurrent = async () => {
      if (account !== 'A') throw new Error('The wallet account changed.');
      return api.getConfiguration();
    };
    const adapter = createProtocolAdapter({
      api, networkId: 'preview', shieldedAddress: 'A', shieldedCoinPublicKey: 'A', shieldedEncryptionPublicKey: 'A',
      assertCurrent,
    }, bridge);
    const pending = adapter.mint({
      networkKey: 'preview', contractAddress: 'issuer', tokenId: 'id', privacy: 'unshielded',
      recipient: { kind: 'unshielded-user', userAddress: 'A' },
      amount: 1n,
    });

    await started;
    account = 'B';
    releaseBalance?.();

    await expect(pending).rejects.toThrow('wallet account changed');
    expect(submitTransaction).not.toHaveBeenCalled();
  });
});
