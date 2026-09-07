import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BalanceState, TokenView } from '../domain/model';
import { errorMessage, formatBaseUnits } from '../lib/format';
import type { ConnectedWalletSession } from './useWallet';

type BalanceMap = Record<string, BalanceState>;

function normalizeTokenId(value: string) {
  return value.toLowerCase().replace(/^0x/, '');
}

function balanceFor(source: Record<string, bigint>, tokenId: string): bigint {
  if (Object.hasOwn(source, tokenId)) return BigInt(source[tokenId]);
  const expected = normalizeTokenId(tokenId);
  const matches = Object.entries(source).filter(([key]) => normalizeTokenId(key) === expected);
  if (matches.length > 1) throw new Error(`Wallet returned duplicate forms of token ${tokenId}.`);
  return matches.length === 1 ? BigInt(matches[0][1]) : 0n;
}

export function useBalances(tokens: TokenView[], session: ConnectedWalletSession | null) {
  const [balances, setBalances] = useState<BalanceMap>({});
  const generation = useRef(0);
  const tokensKey = tokens.map((token) => `${token.tokenId ?? '-'}:${token.decimals}:${token.privacy}`).join('|');

  const refresh = useCallback(async (mode: 'loading' | 'refreshing' = 'refreshing') => {
    if (!session) {
      setBalances({});
      return;
    }
    const id = ++generation.current;
    setBalances((current) => Object.fromEntries(tokens.map((token) => {
      if (!token.tokenId) return [token.symbol, { kind: 'unsupported', message: 'No active token identity.' } satisfies BalanceState];
      const previous = current[token.symbol];
      if (mode === 'refreshing' && previous && (previous.kind === 'ready' || previous.kind === 'stale')) {
        return [token.symbol, { kind: 'refreshing', formatted: previous.formatted } satisfies BalanceState];
      }
      return [token.symbol, { kind: 'loading' } satisfies BalanceState];
    })));

    try {
      const [shielded, unshielded] = await Promise.all([
        session.api.getShieldedBalances(),
        session.api.getUnshieldedBalances(),
      ]);
      if (id !== generation.current) return;
      const updatedAt = new Date();
      setBalances(Object.fromEntries(tokens.map((token) => {
        if (!token.tokenId) return [token.symbol, { kind: 'unsupported', message: 'No active token identity.' } satisfies BalanceState];
        const amount = balanceFor(token.privacy === 'shielded' ? shielded : unshielded, token.tokenId);
        return [token.symbol, {
          kind: 'ready',
          formatted: formatBaseUnits(amount, token.decimals),
          isZero: amount === 0n,
          updatedAt,
        } satisfies BalanceState];
      })));
    } catch (error) {
      if (id !== generation.current) return;
      const message = errorMessage(error);
      setBalances((current) => Object.fromEntries(tokens.map((token) => {
        const previous = current[token.symbol];
        if (previous && (previous.kind === 'ready' || previous.kind === 'refreshing' || previous.kind === 'stale')) {
          return [token.symbol, {
            kind: 'stale',
            formatted: previous.formatted,
            updatedAt: previous.kind === 'ready' || previous.kind === 'stale' ? previous.updatedAt : new Date(),
          } satisfies BalanceState];
        }
        return [token.symbol, { kind: 'error', message } satisfies BalanceState];
      })));
    }
  }, [session, tokens, tokensKey]);

  useEffect(() => {
    generation.current += 1;
    setBalances({});
    if (!session || !tokens.some((token) => token.tokenId)) return;
    void refresh('loading');
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh, session, tokensKey]);

  return useMemo(() => ({ balances, refresh }), [balances, refresh]);
}
