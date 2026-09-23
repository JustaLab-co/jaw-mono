'use client';

import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { getPermissionFromRelay } from '@jaw.id/core';
import {
  validatePermissionExecution,
  type ExecutionPermission,
  type PermissionProblem,
} from '../utils/permissionExecution';

export interface UsePermissionExecutionOptions {
  /** From `capabilities.permissions.id`. Absent for an ordinary transaction. */
  permissionId?: Hex;
  apiKey?: string;
  chainId?: number;
  /** The account signing the userOp — the permission's spender. */
  from?: Address;
  calls: { to?: string; data?: string }[];
}

export interface UsePermissionExecutionResult {
  /** The granter, whose assets move. Undefined until the permission resolves. */
  onBehalfOf?: Address;
  loading: boolean;
  /** A named reason this execution would revert, resolved once the permission arrives. */
  problem: PermissionProblem | null;
}

/**
 * Resolves the permission behind a permissioned execution.
 *
 * This costs a relay round-trip, so it deliberately does not gate the dialog: the screen renders
 * at once and the "On behalf of" row fills in when the answer lands, the way the fee row does.
 * Nothing here changes what is submitted — it only names, up front, the reverts the permissions
 * manager would produce anyway.
 */
export function usePermissionExecution({
  permissionId,
  apiKey,
  chainId,
  from,
  calls,
}: UsePermissionExecutionOptions): UsePermissionExecutionResult {
  const [permission, setPermission] = useState<ExecutionPermission | null>(null);
  const [unresolved, setUnresolved] = useState<'revoked' | 'lookup-failed' | null>(null);

  useEffect(() => {
    setPermission(null);
    setUnresolved(null);
    if (!permissionId) return;

    let cancelled = false;
    getPermissionFromRelay(permissionId, apiKey)
      .then((relay) => {
        if (cancelled) return;
        setPermission({
          account: relay.account,
          spender: relay.spender,
          start: Number(relay.start),
          end: Number(relay.end),
          chainId: String(relay.chainId ?? ''),
          calls: relay.calls ?? [],
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Only a relay 404 proves the permission is gone; anything else (5xx, network, CORS)
        // is our lookup failing, which must warn rather than dead-end the dialog. The status
        // lives directly on errors the core rethrows from structured bodies, and on
        // `response.status` for raw transport errors.
        const status =
          (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
        setUnresolved(status === 404 ? 'revoked' : 'lookup-failed');
      });

    return () => {
      cancelled = true;
    };
  }, [permissionId, apiKey]);

  if (!permissionId) return { loading: false, problem: null };
  if (unresolved) return { loading: false, problem: unresolved };
  // Derived, not stored: a `loading` state initialised to false would report "not permissioned"
  // for the first render, dropping the extra row and the badge for a frame.
  if (!permission) return { loading: true, problem: null };

  return {
    onBehalfOf: permission.account as Address,
    loading: false,
    problem: validatePermissionExecution({
      permission,
      from,
      chainId,
      calls,
      now: Math.floor(Date.now() / 1000),
    }),
  };
}
