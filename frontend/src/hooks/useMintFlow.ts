import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MintRequest,
  Recipient,
  TokenProtocolAdapter,
} from '@effectstream/mint-test-token-protocol-interface';
import type { MintRecipient, MintSession, NetworkKey, TokenView } from '../domain/model';
import { errorMessage, isUserCancellation } from '../lib/format';
import type { ConnectedWalletSession } from './useWallet';

function protocolRecipient(
  draft: MintRecipient,
  token: TokenView,
  wallet: ConnectedWalletSession,
  protocolFamily: TokenProtocolAdapter['protocolFamily'],
): Recipient {
  if (draft.kind === 'contract') {
    return {
      kind: 'contract',
      contractAddress: draft.address,
      receiverCapability: protocolFamily === 'midnight-1.x'
        ? 'mint-test-token-receiver-v1'
        : 'mint-test-token-receiver-v2',
    };
  }
  if (token.privacy === 'unshielded') {
    return {
      kind: 'unshielded-user',
      userAddress: draft.kind === 'self' ? wallet.unshieldedAddress : draft.address,
    };
  }
  if (draft.kind === 'self') {
    return {
      kind: 'shielded-user',
      shieldedAddress: wallet.shieldedAddress,
      coinPublicKey: wallet.shieldedCoinPublicKey,
      encryptionPublicKey: wallet.shieldedEncryptionPublicKey,
    };
  }
  if (!draft.coinPublicKey || !draft.encryptionPublicKey) {
    throw new Error('Shielded recipients require their address, coin public key, and encryption public key.');
  }
  return {
    kind: 'shielded-user',
    shieldedAddress: draft.address,
    coinPublicKey: draft.coinPublicKey,
    encryptionPublicKey: draft.encryptionPublicKey,
  };
}

function uncertainTransaction(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { transactionId?: unknown };
  return typeof value.transactionId === 'string' && value.transactionId ? value.transactionId : undefined;
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase().replace(/^0x/, '') === right.toLowerCase().replace(/^0x/, '');
}

function activeState(kind: MintSession['state']['kind']): boolean {
  return ['awaiting-approval', 'submitting', 'submitted', 'confirming'].includes(kind);
}

export function useMintFlow({
  network,
  registryKey,
  protocolFamily,
  adapter,
  wallet,
  onConfirmedToSelf,
}: {
  network: NetworkKey;
  registryKey: string | null;
  protocolFamily: TokenProtocolAdapter['protocolFamily'] | null;
  adapter: TokenProtocolAdapter | null;
  wallet: ConnectedWalletSession | null;
  onConfirmedToSelf: () => void;
}) {
  const [session, setSession] = useState<MintSession | null>(null);
  const operation = useRef(0);
  const inFlight = useRef(false);
  const currentContext = useRef({ network, registryKey, protocolFamily, adapter, wallet });
  currentContext.current = { network, registryKey, protocolFamily, adapter, wallet };

  useEffect(() => {
    setSession((current) => {
      if (!current || (current.network === network && current.registryKey === registryKey)) return current;
      return current.state.kind === 'idle' || current.state.kind === 'reviewing' ? null : current;
    });
  }, [network, registryKey]);

  const begin = useCallback((token: TokenView) => {
    if (inFlight.current || !registryKey || !adapter || !wallet || wallet.network !== network || !token.issuerAddress || !token.tokenId) return;
    setSession({ token, network, registryKey, recipient: { kind: 'self' }, state: { kind: 'idle' } });
  }, [adapter, network, registryKey, wallet]);

  const review = useCallback((recipient: MintRecipient) => {
    setSession((current) => current && !activeState(current.state.kind)
      ? { ...current, recipient, state: { kind: 'reviewing' } }
      : current);
  }, []);

  const reset = useCallback(() => {
    setSession((current) => current && !activeState(current.state.kind)
      ? { ...current, state: { kind: 'idle' } }
      : current);
  }, []);

  const close = useCallback(() => {
    setSession((current) => {
      if (current && ['awaiting-approval', 'submitting', 'submitted', 'confirming'].includes(current.state.kind)) return current;
      return null;
    });
  }, []);

  const confirm = useCallback(async () => {
    if (!session || session.state.kind !== 'reviewing' || !adapter || !wallet || inFlight.current) return;
    if (
      !registryKey
      || session.registryKey !== registryKey
      || wallet.network !== session.network
      || adapter.protocolFamily !== protocolFamily
    ) {
      setSession((current) => current ? { ...current, state: { kind: 'failed', message: 'Wallet, adapter, and mint request no longer refer to the same network.' } } : current);
      return;
    }
    const context = { network, registryKey, protocolFamily, adapter, wallet };
    const contextIsCurrent = () => {
      const latest = currentContext.current;
      return latest.network === context.network
        && latest.registryKey === context.registryKey
        && latest.protocolFamily === context.protocolFamily
        && latest.adapter === context.adapter
        && latest.wallet?.id === context.wallet.id;
    };
    const token = session.token;
    if (!token.issuerAddress || !token.tokenId) return;
    const id = ++operation.current;
    inFlight.current = true;
    let submittedTransactionId: string | undefined;
    setSession((current) => current ? { ...current, state: { kind: 'awaiting-approval' } } : current);

    try {
      const onchain = await adapter.readMetadata(token.issuerAddress);
      if (
        onchain.name !== token.name
        || onchain.symbol !== token.symbol
        || onchain.decimals !== token.decimals
        || !sameIdentity(onchain.tokenId, token.tokenId)
      ) {
        throw new Error('On-chain token metadata does not match the selected canonical registry record.');
      }
      if (!contextIsCurrent()) {
        throw new Error('The wallet or canonical registry changed before submission. Review the current token record and try again.');
      }
      const recipient = protocolRecipient(session.recipient, token, wallet, adapter.protocolFamily);
      const amount = BigInt(token.faucetBaseUnits);
      if (amount <= 0n) throw new Error('Canonical faucet amount must be positive.');
      const request: MintRequest = {
        networkKey: session.network,
        contractAddress: token.issuerAddress,
        tokenId: token.tokenId,
        privacy: token.privacy,
        recipient,
        amount,
      };
      setSession((current) => current ? { ...current, state: { kind: 'submitting' } } : current);
      const submission = await adapter.mint(request);
      submittedTransactionId = submission.transactionId;
      if (id !== operation.current) return;
      setSession((current) => current ? { ...current, state: { kind: 'submitted', transactionId: submission.transactionId } } : current);
      setSession((current) => current ? { ...current, state: { kind: 'confirming', transactionId: submission.transactionId } } : current);
      await submission.waitForFinalization();
      if (id !== operation.current) return;

      const needsPrivateDelivery = token.privacy === 'shielded' && session.recipient.kind !== 'contract';
      if (needsPrivateDelivery && submission.receiptDelivery !== 'encrypted-output') {
        setSession((current) => current ? {
          ...current,
          state: {
            kind: 'uncertain',
            transactionId: submission.transactionId,
            message: 'The transaction confirmed, but the recipient wallet has not confirmed delivery. Do not submit it again; check the transaction and recipient wallet first.',
          },
        } : current);
        return;
      }

      setSession((current) => current ? { ...current, state: { kind: 'confirmed', transactionId: submission.transactionId } } : current);
      if (session.recipient.kind === 'self') onConfirmedToSelf();
    } catch (error) {
      if (id !== operation.current) return;
      const transactionId = uncertainTransaction(error) ?? submittedTransactionId;
      if (transactionId) {
        setSession((current) => current ? {
          ...current,
          state: {
            kind: 'uncertain',
            transactionId,
            message: `${errorMessage(error)} Check this transaction before trying again.`,
          },
        } : current);
      } else if (isUserCancellation(error)) {
        setSession((current) => current ? { ...current, state: { kind: 'cancelled', message: 'The wallet request was cancelled. Nothing was submitted.' } } : current);
      } else {
        setSession((current) => current ? { ...current, state: { kind: 'failed', message: errorMessage(error) } } : current);
      }
    } finally {
      if (id === operation.current) inFlight.current = false;
    }
  }, [adapter, network, onConfirmedToSelf, protocolFamily, registryKey, session, wallet]);

  return { session, begin, review, confirm, reset, close };
}
