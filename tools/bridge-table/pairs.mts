import { zeroAddress, type Address } from 'viem';
import * as viemChains from 'viem/chains';
import type { BridgeChain, BridgeToken } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';

export type Provider = 'across' | 'relay';
export type Pair = {
  name: string;
  from: number;
  to: number;
  send: Address;
  receive: Address;
  amount: bigint;
  only?: Provider;
};
type Chains = Readonly<Record<number, BridgeChain>>;

const BASE = 8453;
const ARBITRUM = 42161;
const ROBINHOOD = 4663;
const NATIVE = zeroAddress;
const USDC = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  [BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [ARBITRUM]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
} as const;
const WETH_ARBITRUM = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
export const NVDA_ROBINHOOD = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const TEN_USDC = 10_000_000n;
const ETH_AMOUNT = 10n ** 16n;
// The probe asks mainnet APIs, so a testnet in the table has no route to probe.
const TESTNETS = new Set<number>(Object.values(viemChains).flatMap((chain) => (chain.testnet ? [chain.id] : [])));

const PAIRS: Pair[] = [
  {
    name: 'USDC Base -> USDC Arbitrum',
    from: BASE,
    to: ARBITRUM,
    send: USDC[BASE],
    receive: USDC[ARBITRUM],
    amount: TEN_USDC,
  },
  { name: 'USDC Ethereum -> USDC Optimism', from: 1, to: 10, send: USDC[1], receive: USDC[10], amount: TEN_USDC },
  {
    name: 'USDC Base -> WETH Arbitrum',
    from: BASE,
    to: ARBITRUM,
    send: USDC[BASE],
    receive: WETH_ARBITRUM,
    amount: TEN_USDC,
  },
  // Relay routes a same-chain swap through its approval proxy, not the depository.
  {
    name: 'USDC Base -> ETH Base',
    from: BASE,
    to: BASE,
    send: USDC[BASE],
    receive: NATIVE,
    amount: TEN_USDC,
    only: 'relay',
  },
  { name: 'ETH Base -> ETH Optimism', from: BASE, to: 10, send: NATIVE, receive: NATIVE, amount: ETH_AMOUNT },
  // Across swaps small amounts into stocks through Uniswap and larger ones through LiFi.
  {
    name: 'USDC Base -> NVDA Robinhood, small',
    from: BASE,
    to: ROBINHOOD,
    send: USDC[BASE],
    receive: NVDA_ROBINHOOD,
    amount: 3_000_000n,
    only: 'across',
  },
  {
    name: 'USDC Base -> NVDA Robinhood, large',
    from: BASE,
    to: ROBINHOOD,
    send: USDC[BASE],
    receive: NVDA_ROBINHOOD,
    amount: 100_000_000n,
    only: 'across',
  },
];

const tokenOn = (chain: BridgeChain, symbol: string) =>
  (Object.entries(chain.tokens) as [Address, BridgeToken][]).find(([, token]) => token.symbol === symbol);

// USDC when both chains list it, else ETH that arrives as WETH when both list WETH.
function bridge(chains: Chains, from: number, to: number): Pair | undefined {
  const [origin, destination] = [chains[from].name, chains[to].name];
  const usdc = tokenOn(chains[from], 'USDC');
  const receivedUsdc = tokenOn(chains[to], 'USDC');
  if (usdc && receivedUsdc) {
    const [send, { decimals }] = usdc;
    return {
      name: `USDC ${origin} -> USDC ${destination}`,
      from,
      to,
      send,
      receive: receivedUsdc[0],
      amount: 10n ** BigInt(decimals + 1),
      only: 'across',
    };
  }
  const weth = tokenOn(chains[to], 'WETH');
  if (!weth || !tokenOn(chains[from], 'WETH')) return undefined;
  return {
    name: `ETH ${origin} -> WETH ${destination}`,
    from,
    to,
    send: NATIVE,
    receive: weth[0],
    amount: ETH_AMOUNT,
    only: 'across',
  };
}

/**
 * The pairs to probe and why any Across mainnet chain has none. Every such chain gets a bridge into it,
 * so a new destination shape shows up, and one out of it when the table pins the prefunded store there,
 * so a store that moves shows up.
 */
export function probePairs(chains: Chains): { pairs: Pair[]; unprobed: string[] } {
  const pairs = [...PAIRS];
  const unprobed: string[] = [];
  for (const [key, chain] of Object.entries(chains)) {
    const id = Number(key);
    if (!chain.across || TESTNETS.has(id)) continue;
    const hub = id === BASE ? ARBITRUM : BASE;
    const into = bridge(chains, hub, id);
    if (!into) {
      unprobed.push(`${chain.name}: no USDC or WETH in the table`);
      continue;
    }
    pairs.push(into);
    const out = chain.across.prefundedStore && bridge(chains, id, hub);
    if (out) pairs.push(out);
  }
  const unique = pairs.filter((pair, i) => pairs.findIndex((other) => other.name === pair.name) === i);
  return { pairs: unique, unprobed };
}
