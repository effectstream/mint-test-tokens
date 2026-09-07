import { useEffect, useRef, useState } from 'react';
import type { NetworkKey, NetworkOption, WalletOption, WalletState } from '../domain/model';
import { Check, ChevronDown, Wallet } from './Icons';

interface AppHeaderProps {
  network: NetworkKey;
  networks: readonly NetworkOption[];
  wallet: WalletState;
  actionsLocked: boolean;
  onNetworkChange: (network: NetworkKey) => void;
  onConnect: (wallet: WalletOption) => void;
  onDisconnect: () => void;
}

export function AppHeader({
  network,
  networks,
  wallet,
  actionsLocked,
  onNetworkChange,
  onConnect,
  onDisconnect,
}: AppHeaderProps) {
  const [networkOpen, setNetworkOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const networkMenu = useRef<HTMLDivElement>(null);
  const walletMenu = useRef<HTMLDivElement>(null);
  const current = networks.find((item) => item.key === network) ?? networks[0];

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!networkMenu.current?.contains(target)) setNetworkOpen(false);
      if (!walletMenu.current?.contains(target)) setWalletOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const walletOptions = wallet.kind === 'disconnected' || wallet.kind === 'error' ? wallet.wallets : [];

  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="Test wrapped assets home">
        <span className="brand-mark" aria-hidden="true">
          <i className="brand-orbit brand-orbit-a" />
          <i className="brand-orbit brand-orbit-b" />
        </span>
        <span className="brand-copy">
          <strong>Test wrapped</strong>
          <small>Midnight assets</small>
        </span>
      </a>

      <div className="header-actions">
        <div className="menu-wrap" ref={networkMenu}>
          <button
            className="network-button"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={networkOpen}
            disabled={actionsLocked}
            onClick={() => setNetworkOpen((open) => !open)}
          >
            <span className="live-dot" />
            <span>{current.label}</span>
            <ChevronDown width="16" height="16" />
          </button>
          {networkOpen && (
            <div className="popover network-menu" role="listbox" aria-label="Select network">
              <p className="popover-label">Midnight network</p>
              {networks.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.key === network}
                  className="menu-option"
                  key={option.key}
                  onClick={() => {
                    onNetworkChange(option.key);
                    setNetworkOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.key === network && <Check width="16" height="16" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {wallet.kind === 'connected' ? (
          <div className="wallet-connected">
            <span className="wallet-identicon" aria-hidden="true" />
            <span className="wallet-account">
              <small>{wallet.walletName}</small>
              <strong>{wallet.accountLabel}</strong>
            </span>
            <button className="text-button" type="button" disabled={actionsLocked} onClick={onDisconnect}>Disconnect</button>
          </div>
        ) : (
          <div className="menu-wrap" ref={walletMenu}>
            <button
              className="wallet-button"
              type="button"
              disabled={wallet.kind === 'discovering' || wallet.kind === 'connecting'}
              onClick={() => {
                if (walletOptions.length === 1 && walletOptions[0].compatible) onConnect(walletOptions[0]);
                else setWalletOpen((open) => !open);
              }}
            >
              <Wallet width="18" height="18" />
              {wallet.kind === 'discovering'
                ? 'Finding wallets…'
                : wallet.kind === 'connecting'
                  ? `Connecting ${wallet.walletName}…`
                  : 'Connect wallet'}
            </button>
            {walletOpen && (
              <div className="popover wallet-menu" role="dialog" aria-label="Wallet connection">
                <p className="popover-label">Choose a wallet</p>
                {walletOptions.length === 0 && (
                  <p className="wallet-empty">Open a compatible Midnight wallet extension, then reload this page.</p>
                )}
                {walletOptions.map((option) => (
                  <button
                    type="button"
                    className="wallet-option"
                    key={option.id}
                    disabled={!option.compatible}
                    onClick={() => {
                      onConnect(option);
                      setWalletOpen(false);
                    }}
                  >
                    {option.icon ? <img alt="" src={option.icon} /> : <span className="wallet-placeholder" />}
                    <span>
                      <strong>{option.name}</strong>
                      <small>{option.compatible ? `Connector ${option.apiVersion}` : 'Update required'}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
