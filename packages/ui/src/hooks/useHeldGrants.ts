import { useEffect, useState } from 'react';
import { decodeFunctionData, erc20Abi, isAddressEqual, numberToHex, parseAbi, type Address } from 'viem';
import {
  buildRevokePermissionCall,
  handleGetPermissionsRequest,
  PERMISSIONS_MANAGER_ADDRESS,
  type SpendPeriod,
  type StorePermissionApiResponse,
} from '@jaw.id/core';
import { getPublicClient } from '../utils/publicClient';
import { isNativeToken } from '../utils/tokenBalance';

export interface HeldTotal {
  token: Address;
  unit: SpendPeriod;
  multiplier: number;
  allowance: bigint;
}

export interface HeldGrants {
  count: number;
  totals: HeldTotal[];
}

export type HeldTokenInfo = Record<string, { decimals: number; symbol: string }>;

export type HeldGrantsState =
  | { status: 'loading' }
  | { status: 'unreadable' }
  | { status: 'ready'; held: HeldGrants; tokenInfo: HeldTokenInfo; tokenInfoSettled: boolean };

const LOOKUP_TIMEOUT_MS = 8_000;

const MANAGER_ABI = parseAbi([
  'struct CallPermission { address target; bytes4 selector; address checker; }',
  'struct SpendLimit { address token; uint160 allowance; uint8 unit; uint16 multiplier; }',
  'struct Permission { address account; address spender; uint48 start; uint48 end; uint256 salt; CallPermission[] calls; SpendLimit[] spends; }',
  'function isRevoked(Permission permission) view returns (bool)',
  'function revoke(Permission permission)',
]);

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
      const multiplier = spend.unit === 'forever' ? 1 : spend.multiplier;
      const key = `${spend.token.toLowerCase()}:${spend.unit}:${multiplier}`;
      const total = totals.get(key);
      if (total) total.allowance += BigInt(spend.allowance);
      else
        totals.set(key, {
          token: spend.token as Address,
          unit: spend.unit,
          multiplier,
          allowance: BigInt(spend.allowance),
        });
    }
  }
  return { count: rows.length, totals: [...totals.values()] };
}

// The struct core approved, taken from core's own revoke call rather than rebuilt here.
const approvedStruct = (row: StorePermissionApiResponse) =>
  decodeFunctionData({ abi: MANAGER_ABI, data: buildRevokePermissionCall(row).data }).args[0];

async function dropProvenRevoked(rows: StorePermissionApiResponse[], chainId: number, rpcUrl: string) {
  const client = getPublicClient(chainId, rpcUrl);
  const revoked = await Promise.all(
    rows.map(async (row) => {
      try {
        return await client.readContract({
          address: PERMISSIONS_MANAGER_ADDRESS as Address,
          abi: MANAGER_ABI,
          functionName: 'isRevoked',
          args: [approvedStruct(row)],
        });
      } catch {
        return false;
      }
    })
  );
  return rows.filter((_, i) => !revoked[i]);
}

async function readHeld(args: UseHeldGrantsArgs): Promise<HeldGrants> {
  const rows = (await handleGetPermissionsRequest(
    { method: 'wallet_getPermissions', params: [{ address: args.address, chainId: numberToHex(args.chainId) }] },
    args.apiKey
  )) as StorePermissionApiResponse[];
  const live = liveForSpender(rows, { spender: args.spender, chainId: args.chainId, now: Date.now() / 1000 });
  return totalsOf(args.rpcUrl ? await dropProvenRevoked(live, args.chainId, args.rpcUrl) : live);
}

function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function readTokenInfo(totals: HeldTotal[], chainId: number, rpcUrl: string): Promise<HeldTokenInfo> {
  const client = getPublicClient(chainId, rpcUrl);
  const tokens = [...new Set(totals.map((t) => t.token.toLowerCase()))].filter((t) => !isNativeToken(t));
  const info: HeldTokenInfo = {};
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const [decimals, symbol] = await Promise.all([
          client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'decimals' }),
          client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'symbol' }),
        ]);
        info[token] = { decimals, symbol };
      } catch {
        // Left out: the row keeps the address and the raw allowance.
      }
    })
  );
  return info;
}

export interface UseHeldGrantsArgs {
  address: Address;
  spender: Address;
  chainId: number;
  apiKey?: string;
  rpcUrl?: string;
}

export function useHeldGrants({ address, spender, chainId, apiKey, rpcUrl }: UseHeldGrantsArgs): HeldGrantsState {
  const [state, setState] = useState<HeldGrantsState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
    let cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      setState({ status: 'unreadable' });
    }, LOOKUP_TIMEOUT_MS);
    readHeld({ address, spender, chainId, apiKey, rpcUrl })
      .then(async (held) => {
        if (cancelled) return;
        clearTimeout(timer);
        if (!rpcUrl || held.totals.length === 0) {
          setState({ status: 'ready', held, tokenInfo: {}, tokenInfoSettled: true });
          return;
        }
        setState({ status: 'ready', held, tokenInfo: {}, tokenInfoSettled: false });
        const tokenInfo = await within(readTokenInfo(held.totals, chainId, rpcUrl), {});
        if (!cancelled) setState({ status: 'ready', held, tokenInfo, tokenInfoSettled: true });
      })
      .catch((error: unknown) => {
        console.warn('[useHeldGrants] Could not read the spender grants:', error);
        if (!cancelled) setState({ status: 'unreadable' });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, spender, chainId, apiKey, rpcUrl]);

  return state;
}
