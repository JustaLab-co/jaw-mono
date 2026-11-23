// Fetches real quotes from Across and Relay and runs each through the signing screen's readers
// against the pinned table. A quote that comes back and does not read fails the run; a quote the API
// refuses is skipped. Catches shapes the pinned table cannot list: a new destination chain, a moved contract.
// Across quotes come through the proxy (JAW_PROXY_URL, default production).
//
//   bun tools/bridge-table/bridge-probe.mts      Exits 1 if any quote reads as unreadable.
import { readBridgeCall } from '../../packages/ui/src/utils/bridgeCalls/batch.ts';
import { BRIDGE_CHAINS } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';
import { readRelayOrder } from '../../packages/ui/src/utils/bridgeCalls/relayOrder.ts';
import { snapshotContracts } from '../../packages/ui/src/utils/bridgeCalls/table.ts';
import type { BridgeCall } from '../../packages/ui/src/utils/bridgeCalls/view.ts';
import { probePairs, type Pair, type Provider } from './pairs.mts';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const PROXY = process.env.JAW_PROXY_URL ?? 'https://api.justaname.id/proxy/v2';

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

// Returns what the quote's one bridge call reads as, or what is wrong with the quote. A Relay order the
// screen does not show is only a warning: it still shows the deposit, and Relay picks the solver per quote.
async function readQuote(provider: Provider, pair: Pair): Promise<{ read: string } | { problem: string }> {
  if (provider === 'across') {
    const calls = await acrossCalls(pair);
    const orders: string[] = [];
    for (const call of calls) {
      const read = readBridgeCall(contracts, call, ACCOUNT);
      // A SpokePool deposit is what the proxy returns until it moves to Across API v1.
      if (read?.kind === 'order' || (read?.kind === 'deposit' && read.provider === 'across')) orders.push(read.kind);
      else if (read?.kind !== 'approve') return { problem: show(read) };
    }
    return orders.length === 1 ? { read: orders[0] } : { problem: `${orders.length} orders in ${calls.length} calls` };
  }
  const { calls, orderData } = await relayCalls(pair);
  const deposits: string[] = [];
  for (const call of calls) {
    const read = readBridgeCall(contracts, call, ACCOUNT);
    if (read?.kind === 'swap') {
      deposits.push(read.kind);
    } else if (read?.kind === 'deposit' && read.provider === 'relay') {
      deposits.push(read.kind);
      const order = readRelayOrder(contracts, { orderData }, read);
      if (order?.kind === 'unshown') line('warn', `${labelOf('relay', pair)}: ${order.reason}`);
    } else if (read?.kind !== 'approve') {
      return { problem: show(read) };
    }
  }
  return deposits.length === 1
    ? { read: deposits[0] }
    : { problem: `${deposits.length} deposits in ${calls.length} calls` };
}

async function probe(provider: Provider, pair: Pair) {
  const label = labelOf(provider, pair);
  try {
    const quote = await readQuote(provider, pair);
    if ('problem' in quote) {
      failed++;
      line('FAIL', `${label}: ${quote.problem}`);
    } else {
      line('ok  ', `${label}: ${quote.read}`);
    }
  } catch (err) {
    if (!(err instanceof Skipped)) throw err;
    skipped++;
    line('skip', `${label}: ${err.message}`);
  }
}

const { pairs, unprobed } = probePairs(BRIDGE_CHAINS);
for (const reason of unprobed) {
  skipped++;
  line('skip', `across ${reason}`);
}

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
