import { ALLOWLIST, type ChainContracts } from '../allowlist';
import type { BackendQuote, CheckCode, QuoteRequest, Refused } from '../check';
import { clearsFloor, floorOf, sameAsset } from './assets';

const baseUnits = /^[1-9][0-9]*$/;

export function amountsCode(request: QuoteRequest, quote: BackendQuote): CheckCode | undefined {
  if (!baseUnits.test(request.amount) || quote.inputAmount !== request.amount) return 'input_amount';
  const { expectedOutputAmount, minOutputAmount } = quote;
  if (!baseUnits.test(expectedOutputAmount) || !baseUnits.test(minOutputAmount)) return 'output_amount';
  if (BigInt(minOutputAmount) > BigInt(expectedOutputAmount)) return 'output_amount';
  return undefined;
}

type Listed<P extends 'across' | 'relay'> = ChainContracts & Required<Pick<ChainContracts, P>>;

export type Route<P extends 'across' | 'relay'> =
  | { ok: true; origin: Listed<P>; destination: Listed<P> }
  | { ok: false; code: CheckCode };

/** Both chains listed for the provider, and both mainnet or both testnet. */
export function routeOf<P extends 'across' | 'relay'>(request: QuoteRequest, provider: P): Route<P> {
  const listed = (chain: ChainContracts | undefined): chain is Listed<P> => chain?.[provider] !== undefined;
  const origin = ALLOWLIST[request.originChainId];
  const destination = ALLOWLIST[request.destinationChainId];
  if (!listed(origin)) return { ok: false, code: 'unsupported_chain' };
  if (!listed(destination) || origin.testnet !== destination.testnet) return { ok: false, code: 'destination_chain' };
  return { ok: true, origin, destination };
}

export function floorRefusal(request: QuoteRequest, minOutputAmount: bigint, maxCostBps: bigint): Refused | undefined {
  const pair = sameAsset(request);
  if (!pair) return { ok: false, code: 'route_unsupported' };
  if (clearsFloor(request, minOutputAmount, pair, maxCostBps)) return undefined;
  const floor = floorOf(request.amount, pair, maxCostBps).toString();
  return { ok: false, code: 'output_floor', offered: minOutputAmount.toString(), floor };
}
