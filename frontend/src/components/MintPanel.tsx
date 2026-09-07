import { useEffect, useId, useState } from 'react';
import type { MintRecipient, MintSession, RecipientKind } from '../domain/model';
import { ArrowUpRight, Check, Shield, Unlock, X } from './Icons';

interface MintPanelProps {
  session: MintSession | null;
  onClose: () => void;
  onReview: (recipient: MintRecipient) => void;
  onConfirm: () => void;
  onReset: () => void;
}

function progressCopy(session: MintSession) {
  switch (session.state.kind) {
    case 'awaiting-approval': return ['Check your wallet', 'Review and approve the mint request in your wallet.'];
    case 'submitting': return ['Submitting transaction', 'Your approved transaction is being sent to the selected network.'];
    case 'submitted': return ['Transaction submitted', 'Waiting for the network and wallet to confirm the mint.'];
    case 'confirming': return ['Confirming mint', 'The transaction is on its way. Keep this page open to see the result.'];
    case 'confirmed': return ['Tokens minted', `${session.token.faucetAmount} ${session.token.symbol} reached the selected recipient.`];
    case 'cancelled': return ['Request cancelled', session.state.message];
    case 'uncertain': return ['Confirmation unknown', session.state.message];
    case 'failed': return ['Mint failed', session.state.message];
    default: return ['', ''];
  }
}

export function MintPanel({ session, onClose, onReview, onConfirm, onReset }: MintPanelProps) {
  const titleId = useId();
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('self');
  const [address, setAddress] = useState('');
  const [coinPublicKey, setCoinPublicKey] = useState('');
  const [encryptionPublicKey, setEncryptionPublicKey] = useState('');

  useEffect(() => {
    setRecipientKind('self');
    setAddress('');
    setCoinPublicKey('');
    setEncryptionPublicKey('');
  }, [session?.token.tokenId]);

  useEffect(() => {
    if (!session) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      const locked = ['awaiting-approval', 'submitting', 'submitted', 'confirming'].includes(session.state.kind);
      if (event.key === 'Escape' && !locked) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, session]);

  if (!session) return null;

  const { token, network, state } = session;
  const isInput = state.kind === 'idle';
  const isReview = state.kind === 'reviewing';
  const isProgress = !isInput && !isReview;
  const needsEncryption = token.privacy === 'shielded' && recipientKind === 'user';
  const canReview = recipientKind === 'self' || (
    address.trim().length > 0
    && (!needsEncryption || (coinPublicKey.trim().length > 0 && encryptionPublicKey.trim().length > 0))
  );
  const recipient: MintRecipient = recipientKind === 'self'
    ? { kind: 'self' }
    : recipientKind === 'contract'
      ? { kind: 'contract', address: address.trim() }
      : {
          kind: 'user',
          address: address.trim(),
          ...(needsEncryption ? {
            coinPublicKey: coinPublicKey.trim(),
            encryptionPublicKey: encryptionPublicKey.trim(),
          } : {}),
        };
  const [progressTitle, progressBody] = progressCopy(session);

  return (
    <div className="sheet-layer" role="presentation">
      <button className="sheet-backdrop" type="button" aria-label="Close mint panel" onClick={onClose} />
      <section className="mint-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet-handle" aria-hidden="true" />
        <button className="sheet-close" type="button" onClick={onClose} aria-label="Close">
          <X width="19" height="19" />
        </button>

        {(isInput || isReview) && (
          <>
            <div className="sheet-token">
              <span className="sheet-emblem">{token.symbol.replace(/^u?tw/, '').slice(0, 1)}</span>
              <div>
                <p className="eyebrow">Mint on {network}</p>
                <h2 id={titleId}>{token.faucetAmount} {token.symbol}</h2>
                <p>{token.name}</p>
              </div>
              <span className={`privacy-pill ${token.privacy}`}>
                {token.privacy === 'shielded' ? <Shield width="13" height="13" /> : <Unlock width="13" height="13" />}
                {token.privacy}
              </span>
            </div>

            {isInput ? (
              <form
                className="recipient-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canReview) onReview(recipient);
                }}
              >
                <fieldset>
                  <legend>Send tokens to</legend>
                  <div className="segmented-control">
                    {([
                      ['self', 'My wallet'],
                      ['user', 'Another user'],
                      ['contract', 'A contract'],
                    ] as const).map(([kind, label]) => (
                      <button
                        type="button"
                        className={recipientKind === kind ? 'active' : ''}
                        aria-pressed={recipientKind === kind}
                        key={kind}
                        onClick={() => setRecipientKind(kind)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                {recipientKind !== 'self' && (
                  <label className="field-label">
                    <span>{recipientKind === 'contract' ? 'Compatible contract address' : token.privacy === 'shielded' ? 'Shielded address' : 'Unshielded user address'}</span>
                    <input
                      autoComplete="off"
                      spellCheck="false"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      placeholder={recipientKind === 'contract' ? 'Contract address' : token.privacy === 'shielded' ? 'Recipient shielded address' : 'Recipient address'}
                    />
                  </label>
                )}

                {needsEncryption && (
                  <>
                    <label className="field-label">
                      <span>Shielded coin public key</span>
                      <input
                        autoComplete="off"
                        spellCheck="false"
                        value={coinPublicKey}
                        onChange={(event) => setCoinPublicKey(event.target.value)}
                        placeholder="Recipient coin key"
                      />
                    </label>
                    <label className="field-label">
                      <span>Shielded encryption public key</span>
                      <input
                        autoComplete="off"
                        spellCheck="false"
                        value={encryptionPublicKey}
                        onChange={(event) => setEncryptionPublicKey(event.target.value)}
                        placeholder="Recipient encryption key"
                      />
                      <small>The address and both keys are checked before approval so the recipient can discover the minted coin.</small>
                    </label>
                  </>
                )}

                {recipientKind === 'contract' && (
                  <p className="form-note">Only use a contract that implements the mint-test-token receiver interface. The issuer and receiver calls are submitted together, and the address is validated before wallet approval.</p>
                )}

                <div className="sheet-summary">
                  <span><small>Amount</small><strong>{token.faucetAmount} {token.symbol}</strong></span>
                  <span><small>Base units</small><code>{token.faucetBaseUnits}</code></span>
                </div>

                <button className="confirm-button" type="submit" disabled={!canReview}>
                  Review mint <ArrowUpRight width="17" height="17" />
                </button>
              </form>
            ) : (
              <div className="review-panel">
                <p className="eyebrow">Review request</p>
                <dl>
                  <div><dt>Network</dt><dd>{network}</dd></div>
                  <div><dt>Token</dt><dd>{token.name} · {token.symbol}</dd></div>
                  <div><dt>Amount</dt><dd>{token.faucetAmount} ({token.faucetBaseUnits} base units)</dd></div>
                  <div><dt>Recipient</dt><dd>{session.recipient.kind === 'self' ? 'Connected wallet' : session.recipient.kind === 'user' ? 'Another user' : 'Compatible contract'}</dd></div>
                  {session.recipient.kind !== 'self' && <div><dt>Address</dt><dd><code>{session.recipient.address}</code></dd></div>}
                </dl>
                <p className="form-note">Your wallet will show the final transaction before anything is submitted.</p>
                <div className="review-actions">
                  <button className="secondary-button" type="button" onClick={onReset}>Back</button>
                  <button className="confirm-button" type="button" onClick={onConfirm}>Continue to wallet</button>
                </div>
              </div>
            )}
          </>
        )}

        {isProgress && (
          <div className={`mint-progress state-${state.kind}`}>
            <span className="progress-orb" aria-hidden="true">
              {state.kind === 'confirmed' ? <Check width="30" height="30" /> : <i />}
            </span>
            <p className="eyebrow">{token.symbol} · {network}</p>
            <h2 id={titleId}>{progressTitle}</h2>
            <p>{progressBody}</p>
            {'transactionId' in state && state.transactionId && (
              <div className="transaction-id">
                <small>Transaction</small>
                <code>{state.transactionId}</code>
              </div>
            )}
            {(state.kind === 'cancelled' || state.kind === 'failed') && (
              <button className="secondary-button" type="button" onClick={onReset}>Review again</button>
            )}
            {(state.kind === 'confirmed' || state.kind === 'uncertain') && (
              <button className="confirm-button" type="button" onClick={onClose}>Done</button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
