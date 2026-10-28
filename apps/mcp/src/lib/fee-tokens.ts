import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import { isAddress, withTimeout, zeroAddress } from 'viem';
import { config } from '@/connections/config';
import { errorLabel, log } from './edge';
import { chainName, listed, nativeSymbol } from './owner-text';

/** How long a link's reply waits on the fee tokens before it says they could not be read. */
const FEE_TOKENS_WAIT_MS = 3_000;

// A symbol is the issuer's text, written into the server's own sentence, so only a plain one is kept.
// Latin letters only, so a symbol spelled with a lookalike letter from another script is not passed on as the real one.
const PLAIN_SYMBOL = /^[A-Za-z0-9\p{Sc}.-]{1,16}$/u;

/** A token the wallet pays the network fee in; the zero address is the network's coin. */
export type FeeToken = { symbol: string; address: string };

/** The tokens the wallet pays the network fee in on one chain, as wallet_getCapabilities lists them. */
export type ReadFeeTokens = (chainId: number) => Promise<FeeToken[]>;

// The wallet lists the coin at the zero address; some readers write it as 0xeeee…eeee.
const COINS = [zeroAddress, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
const isCoin = (t: FeeToken) => COINS.includes(t.address.toLowerCase());

/** The wallet offers a token other than the coin for the fee only when the owner holds at least this much of it. */
const MIN_FEE_TOKEN_HELD = 0.5;

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

// The tokens do not depend on the account, so every reader shares one cached answer with feeTokenOf and the wallet.
export const readFeeTokens: ReadFeeTokens = async (chainId) => {
  const found = await handleGetCapabilitiesRequest(
    { method: 'wallet_getCapabilities', params: [] },
    config().paymasterApiKey,
    true
  );
  const caps = Object.entries(found as object).find(([hex]) => Number(hex) === chainId)?.[1];
  return feeTokenList(caps);
};

/** The fee tokens on one chain, or undefined when they could not be read in time. */
export async function feeTokensOn(read: ReadFeeTokens, chainId: number): Promise<FeeToken[] | undefined> {
  try {
    return await withTimeout(() => read(chainId), {
      timeout: FEE_TOKENS_WAIT_MS,
      errorInstance: new Error('the fee tokens were not read in time'),
    });
  } catch (err) {
    log('warn', { msg: 'fee tokens unreadable', chainId, error: errorLabel(err) });
    return undefined;
  }
}

/**
 * Who pays a link's network fee: the tokens read for its chain, or no tokens when they could not be read.
 * Absent where they were not asked for, such as on a status read.
 */
export type Fee = { tokens?: FeeToken[] };

/** The fee tokens for a link about to open, read while it opens; undefined when there is no reader. */
export async function feeFor(read: ReadFeeTokens | undefined, chainId: number): Promise<Fee | undefined> {
  if (!read) return undefined;
  return { tokens: await feeTokensOn(read, chainId) };
}

/** "ETH, USDC or EURe": the tokens as the owner hears them. */
export const tokenChoice = (symbols: string[]) => listed(symbols).replace(/ and ([^,]+)$/, ' or $1');

/** For the agent: where the fee tokens come from, and what to do with them. */
export function feeTokensNext(chainId: number, tokens: FeeToken[] | undefined) {
  const network = chainName(chainId);
  if (tokens === undefined) {
    return (
      `The tokens that pay the network fee on ${network} could not be read: check jaw_get_capabilities for ${network} ` +
      "before telling the owner what pays it, and never assume it is the network's coin."
    );
  }
  // With no token besides the coin, or none listed at all, the wallet pays the fee in the coin.
  if (tokens.every(isCoin)) {
    return (
      `On ${network} the wallet pays the network fee in the network's coin, ${nativeSymbol(chainId)}, from the owner's ` +
      'balance there, so the owner needs a little of it beyond what the request spends.'
    );
  }
  return (
    `On ${network} the wallet pays the network fee in ${tokenChoice(tokens.map((t) => t.symbol))}, from the owner's ` +
    "balance there. Never tell the owner the fee needs the network's coin. The wallet offers a token other than the coin " +
    `for the fee only when the owner holds at least ${MIN_FEE_TOKEN_HELD} of it there. If the request spends the whole ` +
    'balance of a token that pays the fee and the wallet says the funds are short, the owner can keep a little of it ' +
    'back, or hold another of those tokens there.'
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
  const erc20 = tokens.filter((t) => t.address && !isCoin(t));
  if (!erc20.length) return `The wallet lists no token other than ${network}'s coin to pay the network fee there.`;
  return (
    `This check paid the fee in ${network}'s coin, but the wallet can also pay it in ` +
    `${tokenChoice(erc20.map((t) => `${t.symbol} (${t.address})`))}. Before saying the balance is short, check again ` +
    "with paymaster {mode:'erc20', token} set to one of those the owner holds there. The wallet offers one for the " +
    `fee only when the owner holds at least ${MIN_FEE_TOKEN_HELD} of it there.`
  );
}
