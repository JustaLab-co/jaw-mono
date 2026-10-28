// Fetches real quotes from Across and Relay and runs each through the signing screen's readers
// against the pinned table. A quote that comes back and does not read fails the run; a quote the API
// refuses is skipped. Catches shapes the pinned table cannot list: a new destination chain, a new swap router.
//
//   bun tools/verify/bridge-probe.mts      Exits 1 if any quote reads as unreadable.
import { zeroAddress, type Address } from 'viem';
import { readAcrossCall } from '../../packages/ui/src/utils/bridgeCalls/across.ts';
import { readBridgeApprove } from '../../packages/ui/src/utils/bridgeCalls/approve.ts';
import { BRIDGE_CHAINS, JAW_FEE_RECIPIENT } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';
import { readRelayCall } from '../../packages/ui/src/utils/bridgeCalls/relay.ts';
import { readRelayOrder } from '../../packages/ui/src/utils/bridgeCalls/relayOrder.ts';
import { snapshotContracts } from '../../packages/ui/src/utils/bridgeCalls/table.ts';
import type { BridgeCall } from '../../packages/ui/src/utils/bridgeCalls/view.ts';

type Provider = 'across' | 'relay';
type Pair = {
  name: string;
  from: number;
  to: number;
  send: Address;
  receive: Address;
  amount: bigint;
  only?: Provider;
};

const BASE = 8453;
const ARBITRUM = 42161;
const NATIVE = zeroAddress;
const USDC = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  [BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [ARBITRUM]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
} as const;
const WETH_ARBITRUM = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const NVDA_ROBINHOOD = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const TEN_USDC = 10_000_000n;
const ETH_AMOUNT = 10n ** 16n;
const ACCOUNT = '0x1111111111111111111111111111111111111111';

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
  { name: 'ETH Base -> ETH Optimism', from: BASE, to: 10, send: NATIVE, receive: NATIVE, amount: ETH_AMOUNT },
  // Across swaps small amounts into stocks through Uniswap and larger ones through LiFi.
  {
    name: 'USDC Base -> NVDA Robinhood, small',
    from: BASE,
    to: 4663,
    send: USDC[BASE],
    receive: NVDA_ROBINHOOD,
    amount: 3_000_000n,
    only: 'across',
  },
  {
    name: 'USDC Base -> NVDA Robinhood, large',
    from: BASE,
    to: 4663,
    send: USDC[BASE],
    receive: NVDA_ROBINHOOD,
    amount: 100_000_000n,
    only: 'across',
  },
];

class Skipped extends Error {}

let failed = 0;
let skipped = 0;
const line = (tag: string, text: string) => console.log(`${tag} ${text}`);
const show = (read: unknown) => JSON.stringify(read ?? 'undefined', (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

async function get(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let note: string;
    try {
      const res = await fetch(url, init);
      if (res.ok) return await res.json();
      const body = (await res.text()).slice(0, 200);
      if (res.status < 500 && res.status !== 429) throw new Skipped(`${res.status} ${body}`);
      note = `${res.status} ${body}`;
    } catch (err) {
      if (err instanceof Skipped) throw err;
      note = String(err);
    }
    if (attempt === 2) throw new Skipped(`no answer after 3 tries: ${note}`);
  }
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

async function acrossCalls(pair: Pair): Promise<BridgeCall[]> {
  const quote = await get(
    `https://app.across.to/api/swap/approval?${query({
      tradeType: 'exactInput',
      amount: String(pair.amount),
      inputToken: pair.send,
      originChainId: String(pair.from),
      outputToken: pair.receive,
      destinationChainId: String(pair.to),
      depositor: ACCOUNT,
      recipient: ACCOUNT,
      // Mirrors the fee the backend adds, which puts a transfer of the bought token in a destination swap.
      appFee: '0.0025',
      appFeeRecipient: JAW_FEE_RECIPIENT,
    })}`
  );
  if (!quote.swapTx) throw new Skipped('quote has no swapTx');
  const { chainId, to, data, value } = quote.swapTx;
  return [{ chainId, to, data, value }];
}

async function relayCalls(pair: Pair) {
  const quote = await get('https://api.relay.link/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: ACCOUNT,
      originChainId: pair.from,
      originCurrency: pair.send,
      destinationChainId: pair.to,
      destinationCurrency: pair.receive,
      amount: String(pair.amount),
      tradeType: 'EXACT_INPUT',
    }),
  });
  const items = (quote.steps ?? []).flatMap((step: any) => (step.kind === 'transaction' ? step.items : []));
  const calls: BridgeCall[] = items.map(({ data: tx }: any) => ({
    chainId: Number(tx.chainId),
    to: tx.to,
    data: tx.data,
    value: tx.value,
  }));
  return { calls, orderData: quote.protocol?.v2?.orderData };
}

const contracts = snapshotContracts();
const labelOf = (provider: Provider, pair: Pair) => `${provider.padEnd(6)} ${pair.name}`;

// Returns what is wrong with the quote, or undefined when every call reads. A Relay order the screen
// does not show is only a warning: it still shows the deposit, and Relay picks the solver per quote.
async function problemOf(provider: Provider, pair: Pair): Promise<string | undefined> {
  if (provider === 'across') {
    const [call] = await acrossCalls(pair);
    const read = readAcrossCall(contracts, call);
    return read?.kind === 'deposit' ? undefined : show(read);
  }
  const { calls, orderData } = await relayCalls(pair);
  let deposits = 0;
  for (const call of calls) {
    const read = readRelayCall(contracts, call) ?? readBridgeApprove(contracts, call);
    if (read?.kind === 'deposit') {
      deposits++;
      const order = readRelayOrder(contracts, { orderData }, read);
      if (order?.kind === 'unshown') line('warn', `${labelOf('relay', pair)}: ${order.reason}`);
    } else if (read?.kind !== 'approve') {
      return show(read);
    }
  }
  return deposits === 1 ? undefined : `${deposits} deposits in ${calls.length} calls`;
}

async function probe(provider: Provider, pair: Pair) {
  const label = labelOf(provider, pair);
  try {
    const problem = await problemOf(provider, pair);
    if (problem) failed++;
    line(problem ? 'FAIL' : 'ok  ', problem ? `${label}: ${problem}` : label);
  } catch (err) {
    if (!(err instanceof Skipped)) throw err;
    skipped++;
    line('skip', `${label}: ${err.message}`);
  }
}

// One bridge into every chain the table lists for Across, so a new destination shape shows up.
async function intoChain(id: number, name: string): Promise<Pair | undefined> {
  const tokens: { address: Address; symbol: string; decimals: number }[] = await get(
    `https://app.across.to/api/swap/tokens?${query({ chainId: String(id) })}`
  ).catch(() => []);
  const token = tokens.find((t) => t.symbol === 'USDC') ?? tokens.find((t) => t.symbol === 'WETH');
  if (!token) return undefined;
  const usdc = token.symbol === 'USDC';
  return {
    name: `${usdc ? 'USDC' : 'ETH'} Base -> ${token.symbol} ${name}`,
    from: BASE,
    to: id,
    send: usdc ? USDC[BASE] : NATIVE,
    receive: token.address,
    amount: usdc ? TEN_USDC : ETH_AMOUNT,
    only: 'across',
  };
}

const intoChains = await Promise.all(
  Object.entries(BRIDGE_CHAINS)
    .filter(([id, chain]) => chain.across && Number(id) !== BASE)
    .map(([id, chain]) => intoChain(Number(id), chain.name))
);
const pairs = [...PAIRS, ...intoChains.filter((pair) => pair !== undefined)].filter(
  (pair, i, all) => all.findIndex((other) => other.name === pair.name) === i
);

for (const pair of pairs) {
  if (pair.only !== 'relay') await probe('across', pair);
  if (pair.only !== 'across') await probe('relay', pair);
}

console.log(`\n${failed} unreadable, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
