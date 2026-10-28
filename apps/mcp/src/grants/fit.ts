import { ANY_FN_SEL, ANY_TARGET, EMPTY_CALLDATA_FN_SEL, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { readCurrentPeriods, readLiveness, type ReadDeps } from '@jaw.id/agent';
import { getAddress, isAddressEqual, size, slice, toFunctionSelector, type Address, type Hex } from 'viem';
import type { LiveGrant } from './store';

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

export type Refusal =
  | { reason: 'call-not-allowed'; target: Address; selector: Hex }
  | { reason: 'over-limit'; token: Address; spend: bigint; left: bigint }
  | { reason: 'over-limit'; onChain: true }
  | { reason: 'expired' }
  | { reason: 'no-grant' };

export class ChainUnreadable extends Error {
  constructor() {
    super('the grant could not be read from the chain');
  }
}

export interface Pending {
  token: string;
  amount: bigint;
  periodStart: number;
}

export interface FitContext {
  read: ReadDeps;
  pending: Pending[];
  nowSeconds: number;
}

// ERC-7528, how the permission manager names the chain's own coin.
export const NATIVE_TOKEN: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TRANSFER = toFunctionSelector('transfer(address,uint256)');
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const LOW_160 = (1n << 160n) - 1n;

const word = (data: Hex, offset: number) =>
  BigInt(`0x${data.slice(2 + offset * 2, 2 + offset * 2 + 64).padEnd(64, '0')}`);
const addressAt = (data: Hex, offset: number) =>
  getAddress(`0x${(word(data, offset) & LOW_160).toString(16).padStart(40, '0')}`);

type Spend = { token: Address; amount: bigint };

// The manager also charges any balance a limited token loses, which no calldata shows.
const SPENDS: Record<string, (call: Call, account: Address) => Spend | undefined> = {
  [TRANSFER]: (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  [toFunctionSelector('transferFrom(address,address,uint256)')]: (c, account) =>
    isAddressEqual(addressAt(c.data, 0x04), account) ? { token: c.to, amount: word(c.data, 0x44) } : undefined,
  [toFunctionSelector('approve(address,uint256)')]: (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  [toFunctionSelector('increaseAllowance(address,uint256)')]: (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  [toFunctionSelector('approve(address,address,uint160,uint48)')]: (c) =>
    isAddressEqual(c.to, PERMIT2) ? { token: addressAt(c.data, 0x04), amount: word(c.data, 0x44) } : undefined,
};

export function spendOf(calls: Call[], account: Address): Map<string, bigint> {
  const spent = new Map<string, bigint>();
  const add = ({ token, amount }: Spend) => {
    if (amount > 0n) spent.set(token.toLowerCase(), (spent.get(token.toLowerCase()) ?? 0n) + amount);
  };
  for (const call of calls) {
    add({ token: NATIVE_TOKEN, amount: call.value });
    const counted = size(call.data) >= 4 ? SPENDS[slice(call.data, 0, 4).toLowerCase()]?.(call, account) : undefined;
    if (counted) add(counted);
  }
  return spent;
}

function unlimitedRefused(calls: Call[], token: string): boolean {
  if (token === NATIVE_TOKEN.toLowerCase()) return true;
  return calls.some(
    (c) => c.to.toLowerCase() === token && size(c.data) >= 4 && slice(c.data, 0, 4).toLowerCase() === TRANSFER
  );
}

function callRefused(grant: LiveGrant, call: Call): Refusal | undefined {
  const length = size(call.data);
  const selector = length >= 4 ? slice(call.data, 0, 4) : EMPTY_CALLDATA_FN_SEL;
  const refused = { reason: 'call-not-allowed' as const, target: call.to, selector };
  if (length > 0 && length < 4) return refused;
  if (isAddressEqual(call.to, grant.account) || isAddressEqual(call.to, PERMISSIONS_MANAGER_ADDRESS)) return refused;
  const allowed = grant.permission.calls.some(
    (c) =>
      (isAddressEqual(c.target as Address, call.to) || isAddressEqual(c.target as Address, ANY_TARGET)) &&
      (c.selector.toLowerCase() === selector.toLowerCase() || c.selector.toLowerCase() === ANY_FN_SEL)
  );
  return allowed ? undefined : refused;
}

export const namesEveryTarget = (grant: LiveGrant, calls: Call[]) =>
  calls.every((call) => grant.permission.calls.some((c) => isAddressEqual(c.target as Address, call.to)));

export async function fit(grant: LiveGrant, calls: Call[], ctx: FitContext): Promise<Refusal | undefined> {
  for (const call of calls) {
    const refused = callRefused(grant, call);
    if (refused) return refused;
  }
  const { start, end } = grant.permission;
  if (ctx.nowSeconds < start || ctx.nowSeconds > end) return { reason: 'expired' };

  const target = { chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission };
  const spent = [...spendOf(calls, grant.account)];
  const [liveness, limits] = await Promise.all([
    readLiveness(target, ctx.read),
    Promise.all(spent.map(([token]) => readCurrentPeriods({ ...target, token }, ctx.read))),
  ]);
  // A mismatch is the stored struct not hashing to its id: this server's fault, not the grant's.
  if (liveness === 'unknown' || liveness === 'mismatch') throw new ChainUnreadable();
  if (liveness !== 'active') return { reason: 'no-grant' };

  for (const [i, [token, spend]] of spent.entries()) {
    const overLimit = { reason: 'over-limit' as const, token: getAddress(token), spend };
    if (limits[i].length === 0) {
      // The manager refuses a token the permission sets no limit on, but skips approve and
      // transferFrom on an ERC-721, which only the chain can tell apart: those it decides.
      if (unlimitedRefused(calls, token)) return { ...overLimit, left: 0n };
      continue;
    }
    for (const { allowance, period } of limits[i]) {
      if (period.status === 'outside-window') return { reason: 'expired' };
      if (period.status === 'unavailable') throw new ChainUnreadable();
      const held = ctx.pending
        .filter((p) => p.token === token && p.periodStart >= period.start && p.periodStart < period.end)
        .reduce((sum, p) => sum + p.amount, 0n);
      const used = period.spend + held;
      const left = BigInt(allowance) > used ? BigInt(allowance) - used : 0n;
      if (spend > left) return { ...overLimit, left };
    }
  }
  return undefined;
}
