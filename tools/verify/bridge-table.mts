// Diffs BRIDGE_CHAINS against the live sources it was read from: Across deployed-addresses.json
// and the per-chain AcrossEventEmitter files, and Relay /chains. Fields with no upstream list
// (swapRouter, wrappedNative, tokens) are not checked.
//
//   bun tools/verify/bridge-table.mts      Exits 1 on any difference.
import { BRIDGE_CHAINS } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';

type RelayRouters = { erc20Router?: string };
type RelayChain = {
  id: number;
  solverAddresses?: string[];
  contracts?: RelayRouters & { v3?: RelayRouters; 'v3.2'?: RelayRouters };
  protocol?: { v2?: { depository?: string; chainId?: string } };
};

const ACROSS_ADDRESSES =
  'https://raw.githubusercontent.com/across-protocol/contracts/master/broadcast/deployed-addresses.json';
const ACROSS_DEPLOYMENTS = 'https://raw.githubusercontent.com/across-protocol/contracts/master/deployments';
const RELAY = 'https://api.relay.link/chains';
const RELAY_TESTNETS = 'https://api.testnets.relay.link/chains';

// Avalanche and Arc have no deployments folder; their emitter is listed in deployed-addresses.json.
const EMITTER_URLS: Readonly<Record<number, string>> = {
  1: `${ACROSS_DEPLOYMENTS}/mainnet/AcrossEventEmitter.json`,
  8453: `${ACROSS_DEPLOYMENTS}/base/AcrossEventEmitter.json`,
  10: `${ACROSS_DEPLOYMENTS}/optimism/AcrossEventEmitter.json`,
  42161: `${ACROSS_DEPLOYMENTS}/arbitrum/AcrossEventEmitter.json`,
  59144: `${ACROSS_DEPLOYMENTS}/linea/AcrossEventEmitter.json`,
  56: `${ACROSS_DEPLOYMENTS}/bsc/AcrossEventEmitter.json`,
  137: `${ACROSS_DEPLOYMENTS}/polygon/AcrossEventEmitter.json`,
  57073: `${ACROSS_DEPLOYMENTS}/ink/AcrossEventEmitter.json`,
  1868: `${ACROSS_DEPLOYMENTS}/soneium/AcrossEventEmitter.json`,
  130: `${ACROSS_DEPLOYMENTS}/unichain/AcrossEventEmitter.json`,
  143: `${ACROSS_DEPLOYMENTS}/monad/AcrossEventEmitter.json`,
  43114: ACROSS_ADDRESSES,
  5042: ACROSS_ADDRESSES,
};

const get = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

const across = (await get(ACROSS_ADDRESSES)).chains;
const relay: RelayChain[] = [...(await get(RELAY)).chains, ...(await get(RELAY_TESTNETS)).chains];

let diffs = 0;
function report(same: boolean, line: string) {
  if (!same) diffs++;
  console.log(`${same ? 'ok  ' : 'DIFF'} ${line}`);
}
function compare(chainId: number, field: string, pinned: string | undefined, live: string | undefined) {
  report(pinned?.toLowerCase() === live?.toLowerCase(), `${chainId} ${field} pinned=${pinned} live=${live}`);
}
function compareSet(chainId: number, field: string, pinned: readonly string[], live: readonly string[]) {
  const has = (list: readonly string[], a: string) => list.some((b) => b.toLowerCase() === a.toLowerCase());
  const added = live.filter((a) => !has(pinned, a));
  const dropped = pinned.filter((a) => !has(live, a));
  report(
    !added.length && !dropped.length,
    `${chainId} ${field} pinned=${pinned.length} live=${live.length} added=[${added}] dropped=[${dropped}]`
  );
}

for (const [id, entry] of Object.entries(BRIDGE_CHAINS)) {
  const chainId = Number(id);
  if (entry.across) {
    const live = across[id]?.contracts ?? {};
    compare(chainId, 'across.spokePool', entry.across.spokePool, live.SpokePool?.address);
    compare(chainId, 'across.periphery', entry.across.periphery, live.SpokePoolPeriphery?.address);
    // Robinhood's handler and emitter are not in Across's files. The handler is the target of Across's
    // own quotes with the Avalanche handler's bytecode, and the emitter's bytecode equals Base's.
    const listed = chainId !== 4663;
    if (listed)
      compare(chainId, 'across.multicallHandler', entry.across.multicallHandler, live.MulticallHandler?.address);
    if (entry.across.eventEmitter && listed) {
      const url = EMITTER_URLS[chainId];
      let emitter = live.AcrossEventEmitter?.address;
      if (url && url !== ACROSS_ADDRESSES) emitter = (await get(url)).address;
      compare(chainId, 'across.eventEmitter', entry.across.eventEmitter, emitter);
    }
  }
  if (entry.relay) {
    const live = relay.find((chain) => chain.id === chainId);
    compare(chainId, 'relay.depository', entry.relay.depository, live?.protocol?.v2?.depository);
    compare(chainId, 'relay.protocolChain', entry.relay.protocolChain, live?.protocol?.v2?.chainId);
    const routers = [live?.contracts, live?.contracts?.v3, live?.contracts?.['v3.2']].map((c) => c?.erc20Router);
    const listedRouters = new Set(routers.flatMap((r) => (r ? [r.toLowerCase()] : [])));
    compareSet(chainId, 'relay.erc20Routers', entry.relay.erc20Routers, [...listedRouters]);
    compareSet(chainId, 'relay.solvers', entry.relay.solvers, live?.solverAddresses ?? []);
  }
}

console.log(`\n${diffs} difference(s)`);
process.exit(diffs ? 1 : 0);
