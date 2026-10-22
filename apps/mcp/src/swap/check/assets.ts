import { getAddress, isAddress } from 'viem';
import { ASSETS, MAX_ROUTE_COST_BPS } from '../allowlist';
import type { QuoteRequest } from '../check';

export type AssetPair = { decimalsIn: number; decimalsOut: number };

const assetOf = (chainId: number, token: string) =>
  isAddress(token, { strict: false }) ? ASSETS[chainId]?.[getAddress(token)] : undefined;

export function sameAsset(request: QuoteRequest): AssetPair | undefined {
  const origin = assetOf(request.originChainId, request.originToken);
  const destination = assetOf(request.destinationChainId, request.destinationToken);
  if (!origin || !destination || origin.asset !== destination.asset) return undefined;
  return { decimalsIn: origin.decimals, decimalsOut: destination.decimals };
}

export function clearsFloor(request: QuoteRequest, minOutputAmount: bigint, pair: AssetPair): boolean {
  if (!/^[1-9][0-9]*$/.test(request.amount)) return false;
  const listed = sameAsset(request);
  if (!listed || listed.decimalsIn !== pair.decimalsIn || listed.decimalsOut !== pair.decimalsOut) return false;
  const out = minOutputAmount * 10n ** BigInt(pair.decimalsIn) * 10_000n;
  const floor = BigInt(request.amount) * 10n ** BigInt(pair.decimalsOut) * (10_000n - MAX_ROUTE_COST_BPS);
  return out >= floor;
}
