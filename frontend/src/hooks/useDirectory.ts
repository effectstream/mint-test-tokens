import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryState, NetworkKey } from '../domain/model';
import { fetchRegistry, MetadataUnavailableError, registryView } from '../lib/metadata';
import { errorMessage } from '../lib/format';

export function useDirectory(network: NetworkKey) {
  const [state, setState] = useState<DirectoryState>({ kind: 'loading', network });
  const request = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const load = useCallback(async (selectedNetwork: NetworkKey, revalidate = false) => {
    const id = ++request.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;

    setState((current) => {
      if (revalidate && current.kind === 'ready' && current.registry.network === selectedNetwork) {
        return { ...current, revalidating: true };
      }
      return { kind: 'loading', network: selectedNetwork };
    });

    try {
      const registry = await fetchRegistry(selectedNetwork, controller.signal);
      if (id !== request.current) return;
      setState({ kind: 'ready', registry: registryView(registry), revalidating: false });
    } catch (error) {
      if (id !== request.current || controller.signal.aborted) return;
      if (error instanceof MetadataUnavailableError) {
        setState({ kind: 'unavailable', network: selectedNetwork, message: error.message });
      } else {
        setState({ kind: 'error', network: selectedNetwork, message: errorMessage(error) });
      }
    }

  }, []);

  useEffect(() => {
    void load(network);
    return () => {
      request.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, [load, network]);

  return {
    state,
    reload: useCallback(() => load(network, true), [load, network]),
  };
}
