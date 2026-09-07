import { useEffect, useState } from 'react';
import type { TokenProtocolAdapter } from '@effectstream/mint-test-token-protocol-interface';
import type { RegistryView } from '../domain/model';
import type { ConnectedWalletSession } from './useWallet';

type DisposableAdapter = TokenProtocolAdapter & { dispose(): void };

export type ProtocolAdapterState =
  | { kind: 'idle'; adapter: null }
  | { kind: 'loading'; adapter: null }
  | { kind: 'ready'; adapter: DisposableAdapter }
  | { kind: 'error'; adapter: null; message: string };

export function useProtocolAdapter(
  registry: RegistryView | null,
  session: ConnectedWalletSession | null,
): ProtocolAdapterState {
  const [state, setState] = useState<ProtocolAdapterState>({ kind: 'idle', adapter: null });

  useEffect(() => {
    let active = true;
    let adapter: DisposableAdapter | undefined;
    if (!registry || !session) {
      setState({ kind: 'idle', adapter: null });
      return;
    }

    setState({ kind: 'loading', adapter: null });
    void (registry.protocolFamily === 'midnight-1.x'
      ? import('../../protocols/v1/src/adapter').then((module) => module.createV1Adapter(session))
      : import('../../protocols/v2/src/adapter').then((module) => module.createV2Adapter(session)))
      .then((loaded) => {
        adapter = loaded;
        if (active) setState({ kind: 'ready', adapter: loaded });
        else loaded.dispose();
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error && error.message
          ? error.message
          : 'The selected Midnight protocol adapter could not be loaded.';
        setState({ kind: 'error', adapter: null, message });
      });

    return () => {
      active = false;
      adapter?.dispose();
    };
  }, [registry, session]);

  return state;
}
