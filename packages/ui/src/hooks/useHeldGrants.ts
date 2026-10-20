import { useEffect, useState } from 'react';
import { isAddressEqual, numberToHex, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import {
  handleGetPermissionsRequest,
  PERMISSIONS_MANAGER_ADDRESS,
  type SpendPeriod,
  type StorePermissionApiResponse,
} from '@jaw.id/core';
import { getPublicClient } from '../utils/publicClient';

/** One token and period across every live grant to the spender, summed. */
export interface HeldTotal {
  token: Address;
  unit: SpendPeriod;
  multiplier: number;
  allowance: bigint;
}

export interface HeldGrants {
  /** Live grants to the spender, spend limits or not. */
  count: number;
  totals: HeldTotal[];
}

/** `unknown` is never zero: the screen says it could not check. */
export type HeldGrantsState = { status: 'loading' } | { status: 'unknown' } | { status: 'ready'; held: HeldGrants };

const LOOKUP_TIMEOUT_MS = 8_000;

const MANAGER_ABI = parseAbi([
  'struct CallPermission { address target; bytes4 selector; address checker; }',
  'struct SpendLimit { address token; uint160 allowance; uint8 unit; uint16 multiplier; }',
  'struct Permission { address account; address spender; uint48 start; uint48 end; uint256 salt; CallPermission[] calls; SpendLimit[] spends; }',
  'function isRevoked(Permission permission) view returns (bool)',
]);

// The contract's PeriodUnit by declaration order. It has no year: the SDK grants
// one as twelve months, so the struct is rebuilt the same way or it hashes to
// a permission that does not exist.
const PERIOD_UNIT = { minute: 0, hour: 1, day: 2, week: 3, month: 4, forever: 5 } as const;

/** The index rows still live for this spender on this chain, once each. */
export function liveForSpender(
  rows: StorePermissionApiResponse[],
  { spender, chainId, now }: { spender: Address; chainId: number; now: number }
): StorePermissionApiResponse[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.permissionId.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return isAddressEqual(row.spender as Address, spender) && Number(row.chainId) === chainId && row.end > now;
  });
}

export function totalsOf(rows: StorePermissionApiResponse[]): HeldGrants {
  const totals = new Map<string, HeldTotal>();
  for (const row of rows) {
    for (const spend of row.spends) {
      const key = `${spend.token.toLowerCase()}:${spend.unit}:${spend.multiplier}`;
      const total = totals.get(key);
      if (total) total.allowance += BigInt(spend.allowance);
      else
        totals.set(key, {
          token: spend.token as Address,
          unit: spend.unit,
          multiplier: spend.multiplier,
          allowance: BigInt(spend.allowance),
        });
    }
  }
  return { count: rows.length, totals: [...totals.values()] };
}

function contractPermission(row: StorePermissionApiResponse) {
  return {
    account: row.account as Address,
    spender: row.spender as Address,
    start: row.start,
    end: row.end,
    salt: BigInt(row.salt),
    calls: row.calls.map((call) => ({
      target: call.target as Address,
      selector: call.selector as Hex,
      checker: (call.checker as Address) || zeroAddress,
    })),
    spends: row.spends.map((spend) => {
      const year = spend.unit === 'year';
      return {
        token: spend.token as Address,
        allowance: BigInt(spend.allowance),
        unit: PERIOD_UNIT[year ? 'month' : (spend.unit as keyof typeof PERIOD_UNIT)],
        multiplier: year ? spend.multiplier * 12 : spend.multiplier,
      };
    }),
  };
}

/**
 * The index is not told about a revocation the spender sends itself, so the
 * chain has the last word. A row whose read fails is kept: a total that is too
 * high is honest about the risk, one that is too low is not.
 */
async function dropRevoked(rows: StorePermissionApiResponse[], chainId: number, rpcUrl: string) {
  const client = getPublicClient(chainId, rpcUrl);
  const revoked = await Promise.all(
    rows.map((row) =>
      client
        .readContract({
          address: PERMISSIONS_MANAGER_ADDRESS as Address,
          abi: MANAGER_ABI,
          functionName: 'isRevoked',
          args: [contractPermission(row)],
        })
        .catch(() => false)
    )
  );
  return rows.filter((_, i) => !revoked[i]);
}

async function readHeld(args: UseHeldGrantsArgs & { address: Address; spender: Address }): Promise<HeldGrants> {
  const rows = (await handleGetPermissionsRequest(
    { method: 'wallet_getPermissions', params: [{ address: args.address, chainId: numberToHex(args.chainId) }] },
    args.apiKey
  )) as StorePermissionApiResponse[];
  const live = liveForSpender(rows, { spender: args.spender, chainId: args.chainId, now: Date.now() / 1000 });
  return totalsOf(args.rpcUrl ? await dropRevoked(live, args.chainId, args.rpcUrl) : live);
}

export interface UseHeldGrantsArgs {
  address?: Address;
  spender?: Address;
  chainId: number;
  apiKey?: string;
  rpcUrl?: string;
}

/**
 * What the spender already holds from this account, read by the wallet itself
 * so the app asking for more cannot understate it. Display only: nothing here
 * reaches the grant that is signed.
 */
export function useHeldGrants({ address, spender, chainId, apiKey, rpcUrl }: UseHeldGrantsArgs): HeldGrantsState {
  const [state, setState] = useState<HeldGrantsState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
    if (!address || !spender) {
      setState({ status: 'unknown' });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      setState({ status: 'unknown' });
    }, LOOKUP_TIMEOUT_MS);
    readHeld({ address, spender, chainId, apiKey, rpcUrl })
      .then((held) => !cancelled && setState({ status: 'ready', held }))
      .catch((error: unknown) => {
        console.warn('[useHeldGrants] Could not read the spender grants:', error);
        if (!cancelled) setState({ status: 'unknown' });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, spender, chainId, apiKey, rpcUrl]);

  return state;
}
