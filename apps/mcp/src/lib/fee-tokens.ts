import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import { isAddress, numberToHex, withTimeout, zeroAddress } from 'viem';
import { config } from '@/connections/config';
import { chainName, listed } from './owner-text';

/** How long a link's reply waits on the fee tokens before it says they could not be read. */
const FEE_TOKENS_WAIT_MS = 3_000;

// A symbol is the issuer's text, written into the server's own sentence, so only a plain one is kept.
const PLAIN_SYMBOL = /^[\p{L}\p{N}\p{Sc}.-]{1,16}$/u;

/** A token the wallet pays the network fee in; the zero address is the network's coin. */
export type FeeToken = { symbol: string; address: string };

/** The tokens the wallet pays the network fee in on one chain, by symbol, as wallet_getCapabilities lists them. */
export type ReadFeeTokens = (account: string, chainId: number) => Promise<string[]>;
/** The same tokens with their addresses, for a check that names the token paying the fee. */
export type ReadFeeTokenList = (account: string, chainId: number) => Promise<FeeToken[]>;

/** The tokens one chain's capabilities offer for the fee; none when the chain offers no fee token. */
export function feeTokenList(caps: unknown): FeeToken[] {
  if (typeof caps !== 'object' || caps === null) return [];
  const fee = (caps as { feeToken?: { supported?: unknown; tokens?: unknown } }).feeToken;
  if (fee?.supported !== true || !Array.isArray(fee.tokens)) return [];
  const tokens = fee.tokens as ({ symbol?: unknown; address?: unknown; feeToken?: unknown } | null)[];
  const seen = new Set<string>();
  return tokens.flatMap((t) => {
    if (t?.feeToken === false || typeof t?.symbol !== 'string' || !PLAIN_SYMBOL.test(t.symbol)) return [];
    if (seen.has(t.symbol)) return [];
    seen.add(t.symbol);
    const address = typeof t.address === 'string' && isAddress(t.address, { strict: false }) ? t.address : '';
    return [{ symbol: t.symbol, address }];
  });
}

/** The symbols one chain's capabilities offer as fee tokens; none when the chain offers no fee token. */
export const feeTokenSymbols = (caps: unknown): string[] => feeTokenList(caps).map((t) => t.symbol);

export const readFeeTokenList: ReadFeeTokenList = async (account, chainId) => {
  const found = await handleGetCapabilitiesRequest(
    { method: 'wallet_getCapabilities', params: [account, [numberToHex(chainId)]] },
    config().paymasterApiKey,
    config().chain.testnet === true
  );
  const caps = Object.entries(found as object).find(([hex]) => Number(hex) === chainId)?.[1];
  return feeTokenList(caps);
};

export const readFeeTokens: ReadFeeTokens = async (account, chainId) =>
  (await readFeeTokenList(account, chainId)).map((t) => t.symbol);

/** The fee tokens on one chain, or undefined when they could not be read in time. */
export async function feeTokensOn<T>(
  read: (account: string, chainId: number) => Promise<T[]>,
  account: string,
  chainId: number
): Promise<T[] | undefined> {
  try {
    return await withTimeout(() => read(account, chainId), {
      timeout: FEE_TOKENS_WAIT_MS,
      errorInstance: new Error('the fee tokens were not read in time'),
    });
  } catch {
    return undefined;
  }
}

/** "ETH, USDC or EURe": the tokens as the owner hears them. */
export const tokenChoice = (symbols: string[]) => listed(symbols).replace(/ and ([^,]+)$/, ' or $1');

/** For the agent: where the fee tokens come from, and what to do with them. */
export function feeTokensNext(chainId: number, symbols: string[] | undefined) {
  const network = chainName(chainId);
  if (symbols === undefined) {
    return (
      `The tokens that pay the network fee on ${network} could not be read: check jaw_get_capabilities for ${network} ` +
      "before telling the owner what pays it, and never assume it is the network's coin."
    );
  }
  if (!symbols.length) return `The wallet lists no token that pays the network fee on ${network}.`;
  return (
    `On ${network} the wallet pays the network fee in ${tokenChoice(symbols)}, from the owner's balance there. ` +
    "Never tell the owner the fee needs the network's coin. If the request spends the whole balance of a token that " +
    'pays the fee and the wallet says the funds are short, the owner can keep a little of it back, or hold another of those tokens there.'
  );
}

/**
 * For the agent, after a check that failed before its calls ran with the fee paid in the network's coin: the tokens
 * to check again with before telling the owner the balance is short.
 */
export function feeRetryNext(chainId: number, tokens: FeeToken[] | undefined) {
  const network = chainName(chainId);
  if (tokens === undefined) {
    return (
      `This check paid the fee in ${network}'s coin. Before saying the balance is short, read the fee tokens for ` +
      `${network} with jaw_get_capabilities and check again with paymaster {mode:'erc20', token} set to one the owner holds there.`
    );
  }
  const erc20 = tokens.filter((t) => t.address && t.address.toLowerCase() !== zeroAddress);
  if (!erc20.length) return `The wallet lists no token other than ${network}'s coin to pay the network fee there.`;
  return (
    `This check paid the fee in ${network}'s coin, but the wallet can also pay it in ` +
    `${tokenChoice(erc20.map((t) => `${t.symbol} (${t.address})`))}. Before saying the balance is short, check again ` +
    "with paymaster {mode:'erc20', token} set to one of those the owner holds there; a check that passes that way is " +
    'one the owner can approve.'
  );
}
