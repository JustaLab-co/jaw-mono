// Fetches real quotes from Across and Relay and runs each through the signing screen's readers
// against the pinned table. A quote that comes back and does not read fails the run; a quote the API
// refuses is skipped. Catches shapes the pinned table cannot list: a new destination chain, a moved contract.
// Across quotes come through the proxy (JAW_PROXY_URL, default production).
//
//   bun tools/bridge-table/bridge-probe.mts      Exits 1 if any quote reads as unreadable.
import { zeroAddress, type Address } from 'viem';
import { readBridgeCall } from '../../packages/ui/src/utils/bridgeCalls/batch.ts';
import { BRIDGE_CHAINS } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';
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
const TEN_USDC = 10_000_000n;
const ETH_AMOUNT = 10n ** 16n;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const PROXY = process.env.JAW_PROXY_URL ?? 'https://api.justaname.id/proxy/v2';

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
];

class Skipped extends Error {}

let failed = 0;
let skipped = 0;
let acrossQuotes = 0;
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

// Across quotes come through the proxy, which holds the Across API key and returns
// the calls the wallet signs.
async function acrossCalls(pair: Pair): Promise<BridgeCall[]> {
  const query = new URLSearchParams({
    providers: 'across',
    originChainId: String(pair.from),
    destinationChainId: String(pair.to),
    originToken: pair.send,
    destinationToken: pair.receive,
    amount: String(pair.amount),
    depositor: ACCOUNT,
    recipient: ACCOUNT,
  });
  const quote = (await get(`${PROXY}/move-asset/quote?${query}`))?.result?.data;
  if (quote?.provider !== 'across') throw new Skipped(`proxy answered ${quote?.provider ?? 'no quote'}`);
  acrossQuotes++;
  return quote.transactions.map(({ chainId, to, data, value }: BridgeCall) => ({ chainId, to, data, value }));
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
    const calls = await acrossCalls(pair);
    let orders = 0;
    for (const call of calls) {
      const read = readBridgeCall(contracts, call, ACCOUNT);
      // A SpokePool deposit is what the proxy returns until it moves to Across API v1.
      if (read?.kind === 'order' || (read?.kind === 'deposit' && read.provider === 'across')) orders++;
      else if (read?.kind !== 'approve') return show(read);
    }
    return orders === 1 ? undefined : `${orders} orders in ${calls.length} calls`;
  }
  const { calls, orderData } = await relayCalls(pair);
  let deposits = 0;
  for (const call of calls) {
    const read = readBridgeCall(contracts, call, ACCOUNT);
    if (read?.kind === 'swap') {
      deposits++;
    } else if (read?.kind === 'deposit' && read.provider === 'relay') {
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

// One bridge out of every chain the table pins the prefunded store on, so a store that moves shows up.
function fromChain(id: number): Pair | undefined {
  const chain = BRIDGE_CHAINS[id];
  const usdc = Object.entries(chain.tokens).find(([, token]) => token.symbol === 'USDC')?.[0] as Address | undefined;
  if (!usdc) return undefined;
  const to = id === ARBITRUM ? BASE : ARBITRUM;
  return {
    name: `USDC ${chain.name} -> USDC ${BRIDGE_CHAINS[to].name}`,
    from: id,
    to,
    send: usdc,
    receive: USDC[to],
    amount: 10n ** BigInt(chain.tokens[usdc].decimals + 1),
    only: 'across',
  };
}

const fromChains = Object.entries(BRIDGE_CHAINS)
  .filter(([, chain]) => chain.across?.prefundedStore)
  .map(([id]) => fromChain(Number(id)));
const pairs = [...PAIRS, ...fromChains.filter((pair) => pair !== undefined)].filter(
  (pair, i, all) => all.findIndex((other) => other.name === pair.name) === i
);

for (const pair of pairs) {
  if (pair.only !== 'relay') await probe('across', pair);
  if (pair.only !== 'across') await probe('relay', pair);
}

// A missing or refused key, or a dead endpoint, skips every Across quote, which would read as a clean run.
if (acrossQuotes === 0) {
  failed++;
  line('FAIL', 'across: no quote came back, check the proxy and the skip lines above');
}

console.log(`\n${failed} unreadable, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
