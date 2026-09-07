import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MintSession, TokenView } from '../domain/model';
import { MintPanel } from './MintPanel';

const token: TokenView = {
  symbol: 'twBTC',
  name: 'Test-wrapped BTC',
  decimals: 8,
  privacy: 'shielded',
  faucetAmount: '1',
  faucetBaseUnits: '100000000',
  deploymentState: 'active',
  issuerAddress: '11'.repeat(32),
  tokenId: '22'.repeat(32),
  explorerUrl: null,
  sourceUrl: null,
  balance: { kind: 'ready', formatted: '0', isZero: true, updatedAt: new Date() },
};

const session: MintSession = {
  token,
  network: 'preview',
  registryKey: 'preview:revision',
  recipient: { kind: 'self' },
  state: { kind: 'idle' },
};

describe('contract recipient controls', () => {
  it('allows review of a compatible receiver address after chain acceptance', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(<MintPanel session={session} onClose={vi.fn()} onReview={onReview} onConfirm={vi.fn()} onReset={vi.fn()} />);

    const contract = screen.getByRole('button', { name: 'A contract' });
    expect((contract as HTMLButtonElement).disabled).toBe(false);
    await user.click(contract);
    await user.type(screen.getByRole('textbox', { name: 'Compatible contract address' }), '33'.repeat(32));
    await user.click(screen.getByRole('button', { name: /Review mint/ }));

    expect(onReview).toHaveBeenCalledWith({ kind: 'contract', address: '33'.repeat(32) });
  });
});
