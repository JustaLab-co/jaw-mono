import { getAddress, isAddress } from 'viem';
import { ASSETS, MAX_ROUTE_COST_BPS } from '../allowlist';
import type { QuoteRequest } from '../check';

export type AssetPair = { decimalsIn: number; decimalsOut: number };

export const assetOf = (chainId: number, token: string) =>
  isAddress(token, { strict: false }) ? ASSETS[chainId]?.[getAddress(token)] : undefined;

export function sameAsset(request: QuoteRequest): AssetPair | undefined {
  const origin = assetOf(request.originChainId, request.originToken);
  const destination = assetOf(request.destinationChainId, request.destinationToken);
  if (!origin || !destination || origin.asset !== destination.asset) return undefined;
  return { decimalsIn: origin.decimals, decimalsOut: destination.decimals };
}

export function clearsFloor(
  request: QuoteRequest,
  minOutputAmount: bigint,
  pair: AssetPair,
  maxCostBps = MAX_ROUTE_COST_BPS
): boolean {
  if (!/^[1-9][0-9]*$/.test(request.amount)) return false;
  const listed = sameAsset(request);
  if (!listed || listed.decimalsIn !== pair.decimalsIn || listed.decimalsOut !== pair.decimalsOut) return false;
  return minOutputAmount >= floorOf(request.amount, pair, maxCostBps);
}

/** The smallest output, in destination base units, that costs no more than maxCostBps. */
export function floorOf(amount: string, pair: AssetPair, maxCostBps: bigint): bigint {
  const scaled = BigInt(amount) * 10n ** BigInt(pair.decimalsOut) * (10_000n - maxCostBps);
  const divisor = 10n ** BigInt(pair.decimalsIn) * 10_000n;
  return (scaled + divisor - 1n) / divisor;
}
