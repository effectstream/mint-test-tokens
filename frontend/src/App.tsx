import { useEffect, useMemo, useState } from 'react';
import { AppHeader } from './components/AppHeader';
import { ArrowUpRight } from './components/Icons';
import { MintPanel } from './components/MintPanel';
import { TokenDirectory } from './components/TokenDirectory';
import {
  LOCAL_NETWORK,
  PUBLIC_NETWORKS,
  type DirectoryState,
  type NetworkKey,
  type TokenView,
} from './domain/model';
import { useBalances } from './hooks/useBalances';
import { useDirectory } from './hooks/useDirectory';
import { useMintFlow } from './hooks/useMintFlow';
import { useProtocolAdapter } from './hooks/useProtocolAdapter';
import { useWallet } from './hooks/useWallet';
import { localMetadataAvailable } from './lib/metadata';

function initialNetwork(): NetworkKey {
  const value = new URLSearchParams(window.location.search).get('network');
  return value === 'preview' || value === 'preprod' || value === 'stagenet' || value === 'undeployed'
    ? value
    : 'preview';
}

function withBalances(directory: DirectoryState, balances: Record<string, TokenView['balance']>): DirectoryState {
  if (directory.kind !== 'ready') return directory;
  return {
    ...directory,
    registry: {
      ...directory.registry,
      tokens: directory.registry.tokens.map((token) => ({
        ...token,
        balance: balances[token.symbol] ?? token.balance,
      })),
    },
  };
}

export function App() {
  const [network, setNetwork] = useState<NetworkKey>(initialNetwork);
  const [localEnabled, setLocalEnabled] = useState(network === 'undeployed');
  const directory = useDirectory(network);
  const registry = directory.state.kind === 'ready' ? directory.state.registry : null;
  const registryReady = registry?.ready === true && directory.state.kind === 'ready' && !directory.state.revalidating;
  const registryKey = useMemo(() => registry ? [
    registry.network,
    registry.networkId,
    registry.protocolFamily,
    ...Object.values(registry.compatibility),
    registry.revision,
    String(registryReady),
    ...registry.tokens.map((token) => `${token.symbol}:${token.issuerAddress ?? '-'}:${token.tokenId ?? '-'}`),
  ].join('|') : null, [registry, registryReady]);
  const wallet = useWallet(network, registry?.networkId ?? null);
  const tokens = useMemo(() => registry?.tokens ?? [], [registry]);
  const balanceController = useBalances(tokens, wallet.session);
  const adapterState = useProtocolAdapter(registryReady ? registry : null, wallet.session);
  const adapter = adapterState.adapter;
  const mint = useMintFlow({
    network,
    registryKey,
    registryReady,
    protocolFamily: registry?.protocolFamily ?? null,
    adapter,
    wallet: wallet.session,
    onConfirmedToSelf: () => void balanceController.refresh('refreshing'),
  });
  const renderedDirectory = useMemo(
    () => withBalances(directory.state, balanceController.balances),
    [balanceController.balances, directory.state],
  );
  const networks = useMemo(
    () => localEnabled ? [...PUBLIC_NETWORKS, LOCAL_NETWORK] : PUBLIC_NETWORKS,
    [localEnabled],
  );
  const mintInFlight = mint.session != null && [
    'awaiting-approval',
    'submitting',
    'submitted',
    'confirming',
  ].includes(mint.session.state.kind);

  useEffect(() => {
    const controller = new AbortController();
    void localMetadataAvailable(controller.signal).then((available) => {
      if (!controller.signal.aborted) setLocalEnabled(available);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('network', network);
    window.history.replaceState(null, '', url);
  }, [network]);

  return (
    <div className="app-shell">
      <div className="page-noise" />
      <AppHeader
        network={network}
        networks={networks}
        wallet={wallet.state}
        actionsLocked={mintInFlight}
        onNetworkChange={setNetwork}
        onConnect={(option) => void wallet.connect(option)}
        onDisconnect={wallet.disconnect}
      />

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Permissionless test faucet · Midnight</p>
            <h1>Wrapped assets<br /><em>for building.</em></h1>
            <p className="hero-lede">
              Canonical test tokens for product teams integrating shielded and unshielded assets. Inspect the registry, connect a wallet, and mint a fixed test amount.
            </p>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <span className="planet-ring ring-one" />
            <span className="planet-ring ring-two" />
            <span className="planet-core" />
            <span className="planet-node node-one" />
            <span className="planet-node node-two" />
            <span className="hero-note"><small>Native assets</small><strong>6 tokens · 2 privacy modes</strong></span>
          </div>
        </section>

        <section className="directory-section" aria-labelledby="directory-title">
          <div className="directory-inner">
            <div className="directory-toolbar">
              <div className="directory-heading">
                <h2 id="directory-title">Token directory</h2>
                <span>{registry ? `${registry.tokens.length} assets` : 'Loading registry'}</span>
              </div>
              {registry && (
                <div className="registry-meta">
                  <span><strong>{registry.protocolFamily}</strong> · {registry.chainIdentity}</span>
                  <a
                    className="registry-link"
                    href={`/metadata.${network}.json`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    JSON registry <ArrowUpRight width="14" height="14" />
                  </a>
                </div>
              )}
            </div>

            {wallet.state.kind === 'error' && (
              <div className="registry-warning" role="alert">Wallet connection: {wallet.state.message}</div>
            )}
            {adapterState.kind === 'error' && (
              <div className="registry-warning" role="alert">Minting unavailable: {adapterState.message}</div>
            )}

            <TokenDirectory
              directory={renderedDirectory}
              wallet={wallet.state}
              mintAvailable={adapter !== null && registryReady}
              onMint={mint.begin}
              onRefreshBalance={() => void balanceController.refresh('refreshing')}
              onRetryMetadata={() => void directory.reload()}
            />
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <p className="footer-copy">
          <strong>Test assets, openly documented.</strong>
          These tokens have no backing, redemption, or monetary value. On-chain state is the verification authority; this directory reflects its canonical published registry.
        </p>
        <nav className="footer-links" aria-label="Project links">
          <a href="https://github.com/effectstream/mint-test-tokens" target="_blank" rel="noreferrer noopener">GitHub</a>
          <a href={`/metadata.${network}.json`} target="_blank" rel="noreferrer noopener">Metadata JSON</a>
        </nav>
      </footer>

      <MintPanel
        session={mint.session}
        onClose={mint.close}
        onReview={mint.review}
        onConfirm={() => void mint.confirm()}
        onReset={mint.reset}
      />
    </div>
  );
}
