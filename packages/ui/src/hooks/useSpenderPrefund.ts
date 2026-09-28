import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { Account, PermissionsDetail, SpenderPrefundQuote } from '@jaw.id/core';
import { formatSpendAmount } from '../utils/displayFormat';
import type { SpenderPrefundDisplay } from '../components/PermissionDialog/types';

export interface UseSpenderPrefundArgs {
  account: Account | null;
  /** Whether the request asked for a prefund (`capabilities.prefundSpender === true`). */
  enabled: boolean;
  spender?: Address;
  permissions?: PermissionsDetail;
  /** The account granting, when it is not the one `account` was restored as. */
  address?: Address;
}

export interface UseSpenderPrefundResult {
  quote: SpenderPrefundQuote | null;
  /** True until the quote has settled, so the screen cannot be confirmed before it shows it. */
  loading: boolean;
}

/**
 * The spender prefund a grant would send, quoted once when the screen opens.
 *
 * Once, and not again while the screen stays open: the amount it shows is the
 * amount that goes out, so it must not move under the user. The buffer in the
 * quote is what covers gas moving in the meantime.
 *
 * A quote that fails settles to null, and the grant goes out without a prefund:
 * the grant is what the user came to do.
 */
export function useSpenderPrefund({
  account,
  enabled,
  spender,
  permissions,
  address,
}: UseSpenderPrefundArgs): UseSpenderPrefundResult {
  const [quote, setQuote] = useState<SpenderPrefundQuote | null>(null);
  const [settled, setSettled] = useState(false);

  // Keyed on what the request says, not on object identity. Callers rebuild the permissions
  // object on every render (keys does, from its request), and re-quoting on each would move the
  // amount under the user and flicker Confirm shut. Nothing in a permission is a bigint, so it
  // serialises as is.
  const requestKey = useMemo(
    () => (enabled ? JSON.stringify([spender, address, permissions]) : null),
    [enabled, spender, address, permissions]
  );
  const latest = useRef({ account, spender, permissions, address });
  latest.current = { account, spender, permissions, address };
  const hasAccount = !!account;

  useEffect(() => {
    setQuote(null);
    setSettled(false);
    if (requestKey === null) {
      setSettled(true);
      return;
    }
    const { account, spender, permissions, address } = latest.current;
    // Still loading: the account restores asynchronously, and settling here
    // would open the Confirm gate before the quote could run. Only its arrival
    // re-runs this; a later instance for the same request does not re-price.
    if (!account || !spender || !permissions) return;

    let cancelled = false;
    account
      .quoteSpenderPrefund(spender, permissions, address)
      .then((result) => {
        if (!cancelled) setQuote(result);
      })
      .catch((error) => {
        console.warn('[useSpenderPrefund] Could not quote the spender prefund, granting without it:', error);
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, hasAccount]);

  return { quote, loading: !settled };
}

/**
 * A quote as the grant screen shows it, in the token's own units. Base units,
 * named as such, when the token's decimals could not be read: scaled by a
 * guessed 18 the figure would be wrong by the same factor as the spend limits.
 */
export function describeSpenderPrefund(
  quote: SpenderPrefundQuote | null,
  tokenInfo?: { decimals: number | null; symbol: string }
): SpenderPrefundDisplay | null {
  if (!quote) return null;
  const unit = (value: bigint) => {
    const { amount, decimalsUnknown } = formatSpendAmount(value, tokenInfo?.decimals ?? null);
    return { amount, symbol: decimalsUnknown || !tokenInfo?.symbol ? 'base units' : tokenInfo.symbol };
  };

  if (quote.kind === 'transfer') {
    return { kind: 'transfer', ...unit(quote.amount) };
  }
  const { amount, symbol } = unit(quote.operationCost);
  return { kind: 'below-one-operation', operationCost: amount, symbol };
}
