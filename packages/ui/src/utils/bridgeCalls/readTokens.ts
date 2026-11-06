import { parseAbi, type Client } from 'viem';
import { call, readContract } from 'viem/actions';
import { SYMBOL_CALLDATA, decodeSymbol } from '../tokenSymbol';
import { readKey, type TokenReads } from './table';
import type { TokenRef } from './view';

const DECIMALS_ABI = parseAbi(['function decimals() view returns (uint256)']);

const MAX_DECIMALS = 36n;
const TIMEOUT_MS = 5_000;

type Read = { symbol: string; decimals: number };

async function readSymbol(client: Client, address: TokenRef['address']): Promise<string | undefined> {
  const { data } = await call(client, { to: address, data: SYMBOL_CALLDATA });
  return data && decodeSymbol(data);
}

async function readToken(client: Client, address: TokenRef['address']): Promise<Read | undefined> {
  const [symbol, decimals] = await Promise.all([
    readSymbol(client, address),
    readContract(client, { address, abi: DECIMALS_ABI, functionName: 'decimals' }),
  ]);
  if (!symbol || decimals > MAX_DECIMALS) return undefined;
  return { symbol, decimals: Number(decimals) };
}

/**
 * Asks each token for its own symbol and decimals, on its own chain. Only the display uses the
 * answer. A token that fails, times out or answers oddly is left out, so it keeps reading as unknown.
 */
export async function readTokens(
  refs: TokenRef[],
  clientFor: (chainId: number) => Client,
  timeoutMs = TIMEOUT_MS
): Promise<TokenReads> {
  const wanted = new Map(refs.map((ref) => [readKey(ref.chainId, ref.address), ref]));
  const reads = new Map<string, Read>();
  await Promise.all(
    [...wanted].map(async ([key, { chainId, address }]) => {
      const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs));
      try {
        const read = await Promise.race([readToken(clientFor(chainId), address), timeout]);
        if (read) reads.set(key, read);
      } catch {
        // No code, a revert or an answer that does not decode: the token stays unread.
      }
    })
  );
  return reads;
}
