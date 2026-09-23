'use client';

import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { getPermissionFromRelay, type StorePermissionApiResponse } from '@jaw.id/core';
import {
  classifyPermissionLookupFailure,
  validatePermissionRevocation,
  type RevocationProblem,
} from '../utils/permissionExecution';

export interface UsePermissionRevocationOptions {
  /** The permission to revoke. Absent means a malformed request — see `missing-id`. */
  permissionId?: Hex;
  apiKey?: string;
  chainId?: number;
  /**
   * The account signing the revocation — the request's own address, not whichever wallet happens to
   * be connected. Only the granter can revoke, so passing the connected wallet reports
   * `not-granter` whenever a request names another account the same passkey owns.
   */
  from?: Address;
  /** Skip entirely on the grant screen, which shares these components. */
  enabled?: boolean;
}

export interface UsePermissionRevocationResult {
  /**
   * The stored permission, once it lands. Callers build the revoke call and the spend/call rows
   * from this, so it is returned rather than kept private — the fetch happens once.
   */
  permission: StorePermissionApiResponse | null;
  loading: boolean;
  /** A named reason this revocation would revert or achieve nothing, or null. */
  problem: RevocationProblem | null;
}

/**
 * Resolves the permission behind a revocation, and names what is wrong with it.
 *
 * The twin of `usePermissionExecution` for the other direction. It exists because this wiring lived
 * twice — once in the SDK's own handler (AppSpecific) and once in the keys popup (CrossPlatform) —
 * and the copies drifted: one passed the request's address as `from`, the other the connected
 * wallet, so the popup reported `not-granter` and blocked legitimate revocations. One hook means one
 * `from`, and that class of drift can't recur.
 *
 * Unlike the execution hook, an unresolved permission BLOCKS: the revoke call is built from this
 * record, so with no data there is nothing to submit. `isBlockingRevocationProblem` encodes that.
 *
 * Callers keep their own "details loading" flag: they still fetch token metadata off the returned
 * permission, and their Confirm gate must stay closed until that lands too.
 */
export function usePermissionRevocation({
  permissionId,
  apiKey,
  chainId,
  from,
  enabled = true,
}: UsePermissionRevocationOptions): UsePermissionRevocationResult {
  const [permission, setPermission] = useState<StorePermissionApiResponse | null>(null);
  const [unresolved, setUnresolved] = useState<'missing-id' | 'not-found' | 'lookup-failed' | null>(null);

  useEffect(() => {
    setPermission(null);
    setUnresolved(null);
    if (!enabled) return;
    // Terminal, not pending: a revocation is *about* a permission, so an absent id is a
    // malformed request rather than an absence.
    if (!permissionId) {
      setUnresolved('missing-id');
      return;
    }

    let cancelled = false;
    getPermissionFromRelay(permissionId, apiKey)
      .then((relay) => {
        if (!cancelled) setPermission(relay);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUnresolved(classifyPermissionLookupFailure(err));
      });

    return () => {
      cancelled = true;
    };
  }, [permissionId, apiKey, enabled]);

  if (!enabled) return { permission: null, loading: false, problem: null };
  if (unresolved) return { permission: null, loading: false, problem: unresolved };
  // Derived, not stored: a `loading` initialised to false would report "no problem" for the first
  // render, briefly enabling Confirm on a permission nothing is known about yet.
  if (!permission) return { permission: null, loading: true, problem: null };

  return {
    permission,
    loading: false,
    problem: validatePermissionRevocation({
      permission: {
        account: permission.account,
        spender: permission.spender,
        end: Number(permission.end),
        chainId: String(permission.chainId ?? ''),
      },
      from,
      chainId,
      now: Math.floor(Date.now() / 1000),
    }),
  };
}
