import type { DirectoryState, NetworkKey, TokenView, WalletState } from '../domain/model';
import { TokenCard } from './TokenCard';

interface TokenDirectoryProps {
  directory: DirectoryState;
  wallet: WalletState;
  mintAvailable: boolean;
  onMint: (token: TokenView) => void;
  onRefreshBalance: (token: TokenView) => void;
  onRetryMetadata: (network: NetworkKey) => void;
}

function SkeletonCard() {
  return (
    <div className="token-card skeleton-card" aria-hidden="true">
      <div className="skeleton-row"><i className="skeleton-circle" /><i className="skeleton-line wide" /></div>
      <i className="skeleton-block" />
      <i className="skeleton-line" /><i className="skeleton-line wide" />
      <i className="skeleton-button" />
    </div>
  );
}

export function TokenDirectory({
  directory,
  wallet,
  mintAvailable,
  onMint,
  onRefreshBalance,
  onRetryMetadata,
}: TokenDirectoryProps) {
  if (directory.kind === 'loading') {
    return <div className="token-grid" aria-label="Loading token directory">{Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)}</div>;
  }

  if (directory.kind === 'unavailable' || directory.kind === 'error') {
    return (
      <section className="registry-empty">
        <span className="empty-orbit" aria-hidden="true"><i /><b /></span>
        <p className="eyebrow">Registry unavailable</p>
        <h2>{directory.kind === 'unavailable' ? 'This network is not published yet.' : 'The token directory could not be verified.'}</h2>
        <p>{directory.message}</p>
        <button type="button" className="secondary-button" onClick={() => onRetryMetadata(directory.network)}>Try again</button>
      </section>
    );
  }

  return (
    <>
      {!directory.registry.ready && (
        <div className="registry-warning" role="status">
          This registry is not ready. Token identities are shown for inspection; minting stays disabled.
        </div>
      )}
      <div className={`token-grid ${directory.revalidating ? 'is-revalidating' : ''}`}>
        {directory.registry.tokens.map((token) => (
          <TokenCard
            key={token.tokenId ?? token.symbol}
            token={token}
            network={directory.registry.network}
            wallet={wallet}
            mintAvailable={mintAvailable && directory.registry.ready && !directory.revalidating}
            onMint={onMint}
            onRefreshBalance={onRefreshBalance}
          />
        ))}
      </div>
    </>
  );
}
