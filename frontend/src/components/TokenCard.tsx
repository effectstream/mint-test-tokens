import { useState } from 'react';
import type { NetworkKey, TokenView, WalletState } from '../domain/model';
import { ArrowUpRight, Check, Copy, Refresh, Shield, Unlock } from './Icons';

interface TokenCardProps {
  token: TokenView;
  network: NetworkKey;
  wallet: WalletState;
  mintAvailable: boolean;
  onMint: (token: TokenView) => void;
  onRefreshBalance: (token: TokenView) => void;
}

function shortIdentity(value: string | null) {
  if (!value) return 'Not published';
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function CopyValue({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="identity-row">
      <span>{label}</span>
      <button
        type="button"
        className="identity-value"
        disabled={!value}
        title={value ?? `${label} unavailable`}
        onClick={() => void copy()}
      >
        <code>{shortIdentity(value)}</code>
        {value && (copied ? <Check width="15" height="15" /> : <Copy width="15" height="15" />)}
      </button>
    </div>
  );
}

function Balance({ token, onRefresh }: { token: TokenView; onRefresh: () => void }) {
  const balance = token.balance;

  if (balance.kind === 'disconnected') {
    return <span className="balance-empty">Connect to view</span>;
  }
  if (balance.kind === 'loading') {
    return <span className="balance-loading"><i />Reading balance</span>;
  }
  if (balance.kind === 'unsupported' || balance.kind === 'error') {
    return <span className="balance-error" title={balance.message}>Unavailable</span>;
  }

  const stale = balance.kind === 'stale';
  const refreshing = balance.kind === 'refreshing';

  return (
    <span className={`balance-value ${stale ? 'is-stale' : ''}`}>
      <strong>{balance.formatted}</strong>
      <button type="button" onClick={onRefresh} aria-label={`Refresh ${token.symbol} balance`}>
        <Refresh className={refreshing ? 'is-spinning' : ''} width="15" height="15" />
      </button>
    </span>
  );
}

export function TokenCard({ token, network, wallet, mintAvailable, onMint, onRefreshBalance }: TokenCardProps) {
  const deployed = token.deploymentState === 'active' && token.issuerAddress && token.tokenId;
  const connectedHere = wallet.kind === 'connected' && wallet.network === network;
  const canMint = Boolean(mintAvailable && deployed && connectedHere && wallet.capabilities.has(token.privacy));
  const tint = token.symbol.includes('BTC') ? 'btc' : token.symbol.includes('ETH') ? 'eth' : 'usd';

  return (
    <article className={`token-card tint-${tint}`}>
      <div className="token-head">
        <div className="token-emblem" aria-hidden="true">
          <span>{token.symbol.replace(/^u?tw/, '').slice(0, 1)}</span>
        </div>
        <div className="token-title">
          <div className="symbol-line">
            <h3>{token.symbol}</h3>
            <span className={`privacy-pill ${token.privacy}`}>
              {token.privacy === 'shielded' ? <Shield width="13" height="13" /> : <Unlock width="13" height="13" />}
              {token.privacy}
            </span>
          </div>
          <p>{token.name}</p>
        </div>
        <span className={`deployment-dot deployment-${token.deploymentState}`} title={token.deploymentState} />
      </div>

      <div className="amount-panel">
        <span className="eyebrow">Fixed mint</span>
        <strong>{token.faucetAmount} <small>{token.symbol}</small></strong>
        <span>{token.decimals} decimals</span>
      </div>

      <div className="identity-list">
        <CopyValue label="Token ID" value={token.tokenId} />
        <CopyValue label="Issuer" value={token.issuerAddress} />
      </div>

      <div className="balance-row">
        <span className="eyebrow">Your balance</span>
        <Balance token={token} onRefresh={() => onRefreshBalance(token)} />
      </div>

      <div className="token-actions">
        <button
          className="mint-button"
          type="button"
          disabled={!canMint}
          title={!deployed ? 'No verified deployment for this network' : !connectedHere ? 'Connect a wallet on this network' : !mintAvailable ? 'Minting support is unavailable for this protocol profile' : undefined}
          onClick={() => onMint(token)}
        >
          Mint {token.faucetAmount} {token.symbol}
        </button>
        {token.explorerUrl || token.sourceUrl ? (
          <a
            className="round-link"
            href={token.explorerUrl ?? token.sourceUrl ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`View ${token.symbol} canonical record`}
          >
            <ArrowUpRight width="18" height="18" />
          </a>
        ) : (
          <button className="round-link" type="button" disabled aria-label="Canonical record unavailable">
            <ArrowUpRight width="18" height="18" />
          </button>
        )}
      </div>
    </article>
  );
}
