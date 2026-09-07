import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedWalletCapabilities } from '@effectstream/mint-test-token-protocol-interface';
import type { NetworkKey, WalletOption, WalletState } from '../domain/model';
import { errorMessage, shortAddress } from '../lib/format';

interface InjectedWallet {
  name: string;
  icon?: string;
  apiVersion: string;
  connect(networkId: string): Promise<unknown>;
}

export interface ConnectedWalletSession {
  id: number;
  walletId: string;
  walletName: string;
  api: ConnectedWalletCapabilities;
  network: NetworkKey;
  networkId: string;
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  unshieldedAddress: string;
  assertCurrent(): Promise<Awaited<ReturnType<ConnectedWalletCapabilities['getConfiguration']>>>;
}

function sameConnectorValue(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function injectedWallets(): Map<string, InjectedWallet> {
  const namespace = (window as Window & { midnight?: Record<string, unknown> }).midnight;
  const result = new Map<string, InjectedWallet>();
  if (!namespace || typeof namespace !== 'object') return result;

  for (const [id, value] of Object.entries(namespace)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Partial<InjectedWallet>;
    if (
      typeof candidate.name === 'string'
      && typeof candidate.apiVersion === 'string'
      && typeof candidate.connect === 'function'
    ) {
      result.set(id, candidate as InjectedWallet);
    }
  }
  return result;
}

function isConnectedApi(value: unknown): value is ConnectedWalletCapabilities {
  if (!value || typeof value !== 'object') return false;
  const api = value as Partial<Record<keyof ConnectedWalletCapabilities, unknown>>;
  return [
    'getShieldedBalances',
    'getUnshieldedBalances',
    'getShieldedAddresses',
    'getUnshieldedAddress',
    'getConfiguration',
    'getProvingProvider',
    'balanceUnsealedTransaction',
    'submitTransaction',
  ].every((method) => typeof api[method as keyof ConnectedWalletCapabilities] === 'function');
}

function options(wallets: Map<string, InjectedWallet>): WalletOption[] {
  return [...wallets.entries()].map(([id, wallet]) => ({
    id,
    name: wallet.name,
    icon: wallet.icon,
    apiVersion: wallet.apiVersion,
    compatible: /^4\./.test(wallet.apiVersion),
  }));
}

export function useWallet(network: NetworkKey, networkId: string | null) {
  const wallets = useRef(new Map<string, InjectedWallet>());
  const sessionCounter = useRef(0);
  const [session, setSession] = useState<ConnectedWalletSession | null>(null);
  const [state, setState] = useState<WalletState>({ kind: 'discovering' });

  useEffect(() => {
    let attempts = 0;
    const discover = () => {
      wallets.current = injectedWallets();
      attempts += 1;
      if (wallets.current.size || attempts >= 20) {
        setState((current) => current.kind === 'discovering' || current.kind === 'disconnected'
          ? { kind: 'disconnected', wallets: options(wallets.current) }
          : current.kind === 'error'
            ? { ...current, wallets: options(wallets.current) }
            : current);
      }
    };
    discover();
    const timer = window.setInterval(discover, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    sessionCounter.current += 1;
    setSession(null);
    setState({ kind: 'disconnected', wallets: options(wallets.current) });
  }, [network, networkId]);

  const connect = useCallback(async (option: WalletOption) => {
    const selected = wallets.current.get(option.id);
    if (!selected) {
      setState({ kind: 'error', wallets: options(wallets.current), message: 'That wallet is no longer available.' });
      return;
    }
    if (!option.compatible) {
      setState({ kind: 'error', wallets: options(wallets.current), message: `${option.name} does not expose the required connector API.` });
      return;
    }
    if (!networkId) {
      setState({ kind: 'error', wallets: options(wallets.current), message: 'Verified network metadata must load before connecting.' });
      return;
    }

    const id = ++sessionCounter.current;
    setState({ kind: 'connecting', walletName: option.name });
    try {
      const value = await selected.connect(networkId);
      if (id !== sessionCounter.current) return;
      if (!isConnectedApi(value)) throw new Error('The wallet connection is missing required minting or balance capabilities.');
      const api = value;
      const [configuration, shielded, unshielded] = await Promise.all([
        api.getConfiguration(),
        api.getShieldedAddresses(),
        api.getUnshieldedAddress(),
      ]);
      if (id !== sessionCounter.current) return;
      if (configuration.networkId !== networkId) {
        throw new Error(`Wallet is on ${configuration.networkId}; select ${networkId} in the wallet and reconnect.`);
      }

      const assertCurrent = async () => {
        const [currentConfiguration, currentShielded, currentUnshielded] = await Promise.all([
          api.getConfiguration(),
          api.getShieldedAddresses(),
          api.getUnshieldedAddress(),
        ]);
        const networkChanged = currentConfiguration.networkId !== networkId;
        const accountChanged = !sameConnectorValue(currentShielded.shieldedAddress, shielded.shieldedAddress)
          || !sameConnectorValue(currentShielded.shieldedCoinPublicKey, shielded.shieldedCoinPublicKey)
          || !sameConnectorValue(currentShielded.shieldedEncryptionPublicKey, shielded.shieldedEncryptionPublicKey)
          || !sameConnectorValue(currentUnshielded.unshieldedAddress, unshielded.unshieldedAddress);
        if (networkChanged || accountChanged) {
          const message = networkChanged
            ? `Wallet changed to ${currentConfiguration.networkId}; reconnect it to ${networkId}.`
            : 'The wallet account changed; reconnect it before minting or reading balances.';
          if (id === sessionCounter.current) {
            sessionCounter.current += 1;
            setSession(null);
            setState({ kind: 'error', wallets: options(wallets.current), message });
          }
          throw new Error(message);
        }
        return currentConfiguration;
      };

      const connected: ConnectedWalletSession = {
        id,
        walletId: option.id,
        walletName: option.name,
        api,
        network,
        networkId,
        shieldedAddress: shielded.shieldedAddress,
        shieldedCoinPublicKey: shielded.shieldedCoinPublicKey,
        shieldedEncryptionPublicKey: shielded.shieldedEncryptionPublicKey,
        unshieldedAddress: unshielded.unshieldedAddress,
        assertCurrent,
      };
      setSession(connected);
      setState({
        kind: 'connected',
        walletName: option.name,
        accountLabel: shortAddress(unshielded.unshieldedAddress || shielded.shieldedAddress),
        network,
        capabilities: new Set(['shielded', 'unshielded', 'balance']),
      });
    } catch (error) {
      if (id !== sessionCounter.current) return;
      setSession(null);
      setState({ kind: 'error', wallets: options(wallets.current), message: errorMessage(error) });
    }
  }, [network, networkId]);

  const disconnect = useCallback(() => {
    sessionCounter.current += 1;
    setSession(null);
    setState({ kind: 'disconnected', wallets: options(wallets.current) });
  }, []);

  return useMemo(() => ({ state, session, connect, disconnect }), [connect, disconnect, session, state]);
}
