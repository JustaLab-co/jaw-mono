'use client';

import { useEffect, useState } from 'react';
import { listCeremonies, type CeremonyListEntry } from '@jaw.id/core';
import type { Address } from 'viem';

/**
 * The account's recovery requests that can still complete, newest first: the `pending` half of
 * `Account.getRecovery`, read with no session behind it (`listCeremonies` with `pending`). What
 * the owner's warning and the guardian's "more than one open request" read.
 *
 * Read once per account. Null until the read lands, and when it fails: a warning nobody can be
 * sure of is not shown.
 *
 * @param account - The account to read; nothing is read without one
 */
export function usePendingRecoveries(account: Address | undefined, apiKey?: string): CeremonyListEntry[] | null {
  const [pending, setPending] = useState<CeremonyListEntry[] | null>(null);

  useEffect(() => {
    setPending(null);
    if (!account) return;

    let cancelled = false;
    listCeremonies(account, { pending: true }, apiKey)
      .then((entries) => {
        if (!cancelled) setPending(entries);
      })
      .catch(() => {
        // No answer: no warning. The next screen that opens reads again.
      });
    return () => {
      cancelled = true;
    };
  }, [account, apiKey]);

  return pending;
}
