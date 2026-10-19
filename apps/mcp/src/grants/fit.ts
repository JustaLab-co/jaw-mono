import { ANY_FN_SEL, ANY_TARGET, EMPTY_CALLDATA_FN_SEL, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { readCurrentPeriods, readLiveness, type ReadDeps } from '@jaw.id/agent';
import { decodeErrorResult, getAddress, isAddressEqual, parseAbi, size, slice, type Address, type Hex } from 'viem';
import type { LiveGrant } from './store';

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** Why the session key will not send a batch under a grant. */
export type Refusal =
  | { reason: 'call-not-allowed'; target: Address; selector: Hex }
  // The token and what was left are unknown when the permission manager refused on chain.
  | { reason: 'over-limit'; token?: Address; spend?: bigint; left?: bigint }
  | { reason: 'expired' }
  | { reason: 'no-grant' };

/** The chain could not say whether the batch fits, which is not a refusal of it. */
export class ChainUnreadable extends Error {
  constructor() {
    super('the grant could not be read from the chain');
  }
}

export interface FitContext {
  read: ReadDeps;
  /** What earlier sends under the grant move and the chain may not count yet, by lowercase token. */
  pending: Map<string, bigint>;
  nowSeconds: number;
}

// ERC-7528, how the permission manager names the chain's own coin.
const NATIVE_TOKEN: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const LOW_160 = (1n << 160n) - 1n;

const word = (data: Hex, offset: number) =>
  BigInt(`0x${data.slice(2 + offset * 2, 2 + offset * 2 + 64).padEnd(64, '0')}`);
const addressAt = (data: Hex, offset: number) =>
  getAddress(`0x${(word(data, offset) & LOW_160).toString(16).padStart(40, '0')}`);

type Spend = { token: Address; amount: bigint };

/**
 * What a call moves as the permission manager counts it from calldata, by selector.
 * The manager also charges any balance a limited token loses, which no calldata shows.
 */
const SPENDS: Record<string, (call: Call, account: Address) => Spend | undefined> = {
  // transfer(address,uint256)
  '0xa9059cbb': (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  // transferFrom(address,address,uint256), counted only out of the account
  '0x23b872dd': (c, account) =>
    isAddressEqual(addressAt(c.data, 0x04), account) ? { token: c.to, amount: word(c.data, 0x44) } : undefined,
  // approve(address,uint256)
  '0x095ea7b3': (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  // increaseAllowance(address,uint256)
  '0x39509351': (c) => ({ token: c.to, amount: word(c.data, 0x24) }),
  // Permit2 approve(address,address,uint160,uint48)
  '0x87517c45': (c) =>
    isAddressEqual(c.to, PERMIT2) ? { token: addressAt(c.data, 0x04), amount: word(c.data, 0x44) } : undefined,
};

/** What the batch moves of each token, by lowercase token. */
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

/**
 * The first reason the permission manager would refuse the batch, checked before any
 * userOp: every call against the grant's calls, then its end, then the chain for
 * whether it still stands and what each spend limit has left this period.
 */
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
  if (liveness === 'unknown') throw new ChainUnreadable();
  if (liveness !== 'active') return { reason: 'no-grant' };

  for (const [i, [token, spend]] of spent.entries()) {
    const overLimit = { reason: 'over-limit' as const, token: getAddress(token), spend };
    // The manager refuses a token the permission sets no limit on.
    if (limits[i].length === 0) return { ...overLimit, left: 0n };
    for (const { allowance, period } of limits[i]) {
      if (period.status === 'outside-window') return { reason: 'expired' };
      if (period.status === 'unavailable') throw new ChainUnreadable();
      const used = period.spend + (ctx.pending.get(token) ?? 0n);
      const left = BigInt(allowance) > used ? BigInt(allowance) - used : 0n;
      if (spend > left) return { ...overLimit, left };
    }
  }
  return undefined;
}

const MANAGER_ERRORS = parseAbi([
  'error JustaPermissionManager_UnauthorizedCall(address target, bytes4 selector)',
  'error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)',
  'error JustaPermissionManager_NoSpendPermissions()',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
  'error JustaPermissionManager_BeforePermissionStart(uint48 currentTimestamp, uint48 start)',
  'error JustaPermissionManager_UnauthorizedPermission()',
]);

function refusalOf(data: Hex): Refusal | undefined {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: MANAGER_ERRORS, data });
  } catch {
    return undefined;
  }
  switch (decoded.errorName) {
    case 'JustaPermissionManager_UnauthorizedCall':
      return { reason: 'call-not-allowed', target: decoded.args[0], selector: decoded.args[1] };
    case 'JustaPermissionManager_ExceededSpendLimit':
    case 'JustaPermissionManager_NoSpendPermissions':
      return { reason: 'over-limit' };
    case 'JustaPermissionManager_AfterPermissionEnd':
    case 'JustaPermissionManager_BeforePermissionStart':
      return { reason: 'expired' };
    case 'JustaPermissionManager_UnauthorizedPermission':
      return { reason: 'no-grant' };
  }
}

// The manager's error can sit inside another: an account that wraps what its call reverted
// with, or an EntryPoint log. So it is looked for at every byte, not only at the start.
function refusalWithin(blob: string): Refusal | undefined {
  for (let at = 2; at + 8 <= blob.length; at += 2) {
    const refused = refusalOf(`0x${blob.slice(at)}`);
    if (refused) return refused;
  }
  return undefined;
}

function textsOf(failure: unknown): string[] {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  for (let at = failure; at && typeof at === 'object' && !seen.has(at); at = (at as { cause?: unknown }).cause) {
    seen.add(at);
    const { message, details, data } = at as { message?: unknown; details?: unknown; data?: unknown };
    for (const t of [message, details, data]) if (typeof t === 'string') texts.push(t);
  }
  if (typeof failure === 'string') texts.push(failure);
  return texts;
}

/**
 * The refusal a permission manager revert names, found in a failed send, where the
 * bundler carries the revert data in its error when simulation fails, or in the logs
 * of a userOp that reverted on chain.
 */
export function refusalOfRevert(failure: unknown): Refusal | undefined {
  for (const text of textsOf(failure)) {
    for (const blob of text.match(/0x[0-9a-fA-F]{8,}/g) ?? []) {
      const refused = refusalWithin(blob);
      if (refused) return refused;
    }
  }
  return undefined;
}
