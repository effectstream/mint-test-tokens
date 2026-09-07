import type {
  ConnectedWalletCapabilities,
  MintRequest,
  TokenProtocolAdapter,
} from '@effectstream/mint-test-token-protocol-interface';

export interface FinalizedTransactionLike {
  identifiers(): string[];
  serialize(): Uint8Array;
}

interface PublicDataProviderLike {
  queryContractState(address: string): Promise<unknown>;
  // SDK v1/v2 expose the same method with profile-specific block option types.
  // eslint is not used in this project; `any` here is the deliberate adapter seam.
  queryZSwapAndContractState?: (...args: any[]) => Promise<unknown>;
  watchForTxData(transactionId: string): Promise<{
    status: unknown;
    blockHeight?: number | bigint;
    blockHash?: string;
  }>;
  dispose?: () => void;
}

interface ZkConfigProviderLike {
  asKeyMaterialProvider(): unknown;
}

export interface ProtocolBridge {
  readonly protocolFamily: TokenProtocolAdapter['protocolFamily'];
  setNetworkId(networkId: string): void;
  createPublicDataProvider(indexerUri: string, indexerWsUri: string): PublicDataProviderLike;
  createZkConfigProvider(baseUrl: string, privacy: MintRequest['privacy']): ZkConfigProviderLike;
  createProofProvider(provingProvider: unknown): unknown;
  deserializeFinalizedTransaction(bytes: Uint8Array): FinalizedTransactionLike;
  submitMint(
    providers: Record<string, unknown>,
    request: MintRequest,
    networkId: string,
  ): Promise<{
    transactionId: string;
    shieldedCoinInfo?: { nonce: Uint8Array; color: Uint8Array; value: bigint };
  }>;
  readMetadata(
    publicDataProvider: PublicDataProviderLike,
    contractAddress: string,
  ): Promise<{ name: string; symbol: string; decimals: number; tokenId: string }>;
  isSuccessStatus(status: unknown): boolean;
}

export interface WalletSessionLike {
  api: ConnectedWalletCapabilities;
  networkId: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
}

export type DisposableProtocolAdapter = TokenProtocolAdapter & { dispose(): void };

function hexToBytes(value: string): Uint8Array {
  const hex = value.trim().replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('The wallet returned an invalid transaction encoding.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; reason?: unknown };
    const details = [value.code, value.reason].filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (details.length) return details.join(': ');
  }
  return 'The wallet could not complete the transaction request.';
}

function cancelled(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as { code?: unknown; reason?: unknown; message?: unknown; cause?: unknown };
    const code = String(value.code ?? '').toUpperCase();
    if (['4001', 'ACTION_REJECTED', 'USER_REJECTED', 'USER_CANCELLED', 'USER_CANCELED'].includes(code)) return true;
    const detail = [value.reason, value.message]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
    if (/\buser (?:rejected|declined|cancelled|canceled|denied|aborted)\b|\b(?:rejected|declined|cancelled|canceled|denied) by (?:the )?user\b/i.test(detail)) return true;
    current = value.cause;
  }
  return false;
}

function uncertainSubmission(error: unknown, transactionId: string): Error & { transactionId: string } {
  return Object.assign(
    new Error(`Wallet submission did not return a definite result: ${errorText(error)}`, { cause: error }),
    { transactionId },
  );
}

function normalizeTokenId(value: string): string {
  return value.toLowerCase().replace(/^0x/, '');
}

function patchPostBlockUpdate(provider: PublicDataProviderLike) {
  const query = provider.queryZSwapAndContractState;
  if (typeof query !== 'function') return;
  provider.queryZSwapAndContractState = async (...args: any[]) => {
    const result = await query.apply(provider, args);
    if (!Array.isArray(result) || result.length < 3) return result;
    const zswapState = result[0] as { postBlockUpdate?: (time: Date) => unknown };
    if (typeof zswapState?.postBlockUpdate !== 'function') return result;
    return [zswapState.postBlockUpdate(new Date()), result[1], result[2]];
  };
}

export function createProtocolAdapter(
  session: WalletSessionLike,
  bridge: ProtocolBridge,
): DisposableProtocolAdapter {
  bridge.setNetworkId(session.networkId);
  let originalBalancedTransaction: string | undefined;
  const providerCache = new Map<MintRequest['privacy'], Promise<Record<string, unknown>>>();
  let disposed = false;

  const assertActiveSession = async () => {
    if (disposed) throw new Error('The wallet session was disconnected.');
    const configuration = await session.api.getConfiguration();
    if (disposed) throw new Error('The wallet session was disconnected.');
    if (configuration.networkId !== session.networkId) {
      throw new Error(`Wallet changed to ${configuration.networkId}; reconnect it to ${session.networkId}.`);
    }
    return configuration;
  };

  const configurationPromise = assertActiveSession();
  const publicDataProviderPromise = configurationPromise.then((configuration) => {
    if (disposed) throw new Error('The wallet session was disconnected.');
    const provider = bridge.createPublicDataProvider(configuration.indexerUri, configuration.indexerWsUri);
    patchPostBlockUpdate(provider);
    return provider;
  });

  const walletProvider = {
    getCoinPublicKey: () => session.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => session.shieldedEncryptionPublicKey,
    async balanceTx(transaction: { serialize(): Uint8Array }) {
      await assertActiveSession();
      const result = await session.api.balanceUnsealedTransaction(bytesToHex(transaction.serialize()));
      await assertActiveSession();
      originalBalancedTransaction = result.tx.replace(/^0x/i, '').toLowerCase();
      return bridge.deserializeFinalizedTransaction(hexToBytes(result.tx));
    },
  };

  const midnightProvider = {
    async submitTx(transaction: FinalizedTransactionLike) {
      const transactionId = transaction.identifiers()[0];
      if (!transactionId) throw new Error('The balanced transaction has no identifier.');
      const serialized = bytesToHex(transaction.serialize());
      const exactWalletBytes = originalBalancedTransaction ?? serialized;
      originalBalancedTransaction = undefined;
      try {
        await assertActiveSession();
        await session.api.submitTransaction(exactWalletBytes);
      } catch (error) {
        if (cancelled(error)) throw error;
        throw uncertainSubmission(error, transactionId);
      }
      return transactionId;
    },
  };

  const providersFor = (privacy: MintRequest['privacy']) => {
    const cached = providerCache.get(privacy);
    if (cached) return cached;
    const pending = (async () => {
      await assertActiveSession();
      const assetBase = `${window.location.origin}/contract/${bridge.protocolFamily === 'midnight-1.x' ? 'v1' : 'v2'}/${privacy}`;
      const zkConfigProvider = bridge.createZkConfigProvider(assetBase, privacy);
      const provingProvider = await session.api.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
      await assertActiveSession();
      return {
        publicDataProvider: await publicDataProviderPromise,
        zkConfigProvider,
        proofProvider: bridge.createProofProvider(provingProvider),
        walletProvider,
        midnightProvider,
      };
    })();
    providerCache.set(privacy, pending);
    return pending;
  };

  return {
    protocolFamily: bridge.protocolFamily,
    async mint(request) {
      await assertActiveSession();
      if (request.networkKey && request.amount <= 0n) throw new Error('Mint amount must be positive.');
      bridge.setNetworkId(session.networkId);
      const providers = await providersFor(request.privacy);
      const submitted = await bridge.submitMint(providers, request, session.networkId);
      const encryptedRecipient = request.privacy === 'shielded' && request.recipient.kind === 'shielded-user';
      return {
        transactionId: submitted.transactionId,
        status: 'submitted',
        shieldedCoinInfo: submitted.shieldedCoinInfo,
        receiptDelivery: encryptedRecipient ? 'encrypted-output' : 'not-required',
        async waitForFinalization() {
          try {
            const finalization = await (await publicDataProviderPromise).watchForTxData(submitted.transactionId);
            if (!bridge.isSuccessStatus(finalization.status)) {
              throw Object.assign(
                new Error(`Transaction ${submitted.transactionId} finalized without a complete success.`),
                { transactionId: submitted.transactionId },
              );
            }
            return {
              transactionId: submitted.transactionId,
              ...(finalization.blockHeight === undefined ? {} : { blockHeight: BigInt(finalization.blockHeight) }),
              ...(finalization.blockHash ? { blockHash: finalization.blockHash } : {}),
            };
          } catch (error) {
            if (error instanceof Error && /finalized without a complete success/.test(error.message)) throw error;
            throw Object.assign(
              new Error(`Transaction confirmation could not be determined: ${errorText(error)}`, { cause: error }),
              { transactionId: submitted.transactionId },
            );
          }
        },
      };
    },
    async readMetadata(contractAddress) {
      await assertActiveSession();
      bridge.setNetworkId(session.networkId);
      const result = await bridge.readMetadata(await publicDataProviderPromise, contractAddress);
      await assertActiveSession();
      return result;
    },
    async readBalance(tokenId) {
      await assertActiveSession();
      const [shielded, unshielded] = await Promise.all([
        session.api.getShieldedBalances(),
        session.api.getUnshieldedBalances(),
      ]);
      await assertActiveSession();
      const expected = normalizeTokenId(tokenId);
      const matches = [...Object.entries(shielded), ...Object.entries(unshielded)]
        .filter(([candidate]) => normalizeTokenId(candidate) === expected);
      if (matches.length > 1) throw new Error(`Wallet returned duplicate balance entries for ${tokenId}.`);
      return matches.length ? BigInt(matches[0][1]) : 0n;
    },
    dispose() {
      disposed = true;
      providerCache.clear();
      void publicDataProviderPromise.then((provider) => provider.dispose?.()).catch(() => undefined);
    },
  };
}
