/**
 * Words for the owner: networks by name, amounts with their token, receipts as links, times relative to now and
 * dates without a clock. Pure functions, for the result texts every tool builds.
 */
import { formatUnits, type Chain } from 'viem';
import * as viemChains from 'viem/chains';
import { SUPPORTED_CHAINS } from '@/connections/config';
import { caip2, proxyChains } from '@/lib/chain';

const isChain = (c: unknown): c is Chain =>
  typeof c === 'object' && c !== null && typeof (c as Chain).id === 'number' && typeof (c as Chain).name === 'string';

let catalog: Map<number, Chain> | undefined;

/** Every chain viem defines, the first definition of an id kept. */
function viemCatalog() {
  if (!catalog) {
    catalog = new Map();
    for (const c of Object.values(viemChains)) if (isChain(c) && !catalog.has(c.id)) catalog.set(c.id, c);
  }
  return catalog;
}

/** This server's chains first, then every chain JAW serves, then any chain viem knows. */
function chainOf(chainId: number): Chain | undefined {
  return SUPPORTED_CHAINS[chainId] ?? proxyChains().find((c) => c.id === chainId) ?? viemCatalog().get(chainId);
}

/** The network's name, as the wallet's screens show it, such as Base. The CAIP-2 id only for a chain nobody knows. */
export const chainName = (chainId: number): string => chainOf(chainId)?.name ?? caip2(chainId);

/** The transaction's page on the network's block explorer, when the network has one. */
export function explorerTxUrl(chainId: number, txHash: string): string | undefined {
  const url = chainOf(chainId)?.blockExplorers?.default.url;
  return url ? `${url.replace(/\/+$/, '')}/tx/${txHash}` : undefined;
}

/** A receipt the owner can open, or the transaction hash where the network has no explorer. */
export function receiptLine(chainId: number, txHash: string): string {
  const url = explorerTxUrl(chainId, txHash);
  return url ? `Receipt: ${url}` : `Transaction: ${txHash}`;
}

/** The network's own coin, such as ETH on Base. */
export const nativeSymbol = (chainId: number): string => chainOf(chainId)?.nativeCurrency.symbol ?? 'native coin';

/**
 * An amount as people read it, with its token: 1500000 at 6 decimals is "1.50 USDC", 1000000 is "1 USDC".
 * Exact, never rounded and never in scientific notation; a fraction shows at least two digits, like money.
 */
export function formatAmount(baseUnits: bigint | string, decimals: number, symbol: string): string {
  const [whole, fraction] = formatUnits(BigInt(baseUnits), decimals).split('.');
  return `${fraction ? `${whole}.${fraction.padEnd(2, '0')}` : whole} ${symbol}`;
}

const MINUTE_MS = 60_000;

/** How long the owner has to approve, as a request opens: "within the next 30 minutes". Rounds up. */
export function withinWindow(approveBy: Date, now = new Date()): string {
  const left = approveBy.getTime() - now.getTime();
  if (left <= 0) return 'with no time left to approve';
  const minutes = Math.ceil(left / MINUTE_MS);
  return minutes === 1 ? 'within the next minute' : `within the next ${minutes} minutes`;
}

/** What is left of a request's window, while it waits: "expires in 12 minutes". Rounds down, so it never overstates. */
export function expiresIn(approveBy: Date, now = new Date()): string {
  const left = approveBy.getTime() - now.getTime();
  if (left <= 0) return 'has expired';
  if (left < MINUTE_MS) return 'expires in under a minute';
  const minutes = Math.floor(left / MINUTE_MS);
  return minutes === 1 ? 'expires in 1 minute' : `expires in ${minutes} minutes`;
}

// By hand: the en-GB locale says "Sept" on some ICU versions and "Sep" on others.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day, in UTC with no time: "22 Nov 2026". */
export const onDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
