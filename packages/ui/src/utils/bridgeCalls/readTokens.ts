import { hexToString, parseAbi, type Client } from 'viem';
import { readContract } from 'viem/actions';
import { readKey, type TokenReads } from './table';
import type { TokenRef } from './view';

const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint256)']);

// Older tokens (MKR style) return the symbol as bytes32 instead of a string.
const BYTES32_SYMBOL_ABI = parseAbi(['function symbol() view returns (bytes32)']);

const MAX_DECIMALS = 36n;
const TIMEOUT_MS = 5_000;
const PRINTABLE_SYMBOL = /^[\x20-\x7E]{1,16}$/;

type Read = { symbol: string; decimals: number };

async function readSymbol(client: Client, address: TokenRef['address']): Promise<string> {
  try {
    return await readContract(client, { address, abi: ERC20_ABI, functionName: 'symbol' });
  } catch {
    const word = await readContract(client, { address, abi: BYTES32_SYMBOL_ABI, functionName: 'symbol' });
    return hexToString(word, { size: 32 });
  }
}

async function readToken(client: Client, address: TokenRef['address']): Promise<Read | undefined> {
  const [symbol, decimals] = await Promise.all([
    readSymbol(client, address),
    readContract(client, { address, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  const trimmed = symbol.trim();
  if (!PRINTABLE_SYMBOL.test(trimmed) || decimals > MAX_DECIMALS) return undefined;
  return { symbol: trimmed, decimals: Number(decimals) };
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
