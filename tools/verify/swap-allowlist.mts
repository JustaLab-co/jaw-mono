// Diffs apps/mcp/src/swap/allowlist.ts against the live sources it was read from:
// Across deployed-addresses.json and the per-chain AcrossEventEmitter files, and Relay /chains.
// Wrapped native tokens and USDC are not in those sources; check them on chain.
//
//   bun tools/verify/swap-allowlist.mts      Exits 1 on any difference.
import { ALLOWLIST, SOURCES } from '../../apps/mcp/src/swap/allowlist.ts';

type RelayChain = {
  id: number;
  solverAddresses: string[];
  contracts?: { erc20Router?: string };
  protocol?: { v2?: { depository?: string; chainId?: string } };
};

const get = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

const across = (await get(SOURCES.across)).chains;
const relay: RelayChain[] = [...(await get(SOURCES.relay)).chains, ...(await get(SOURCES.relayTestnets)).chains];

let diffs = 0;
function report(same: boolean, line: string) {
  if (!same) diffs++;
  console.log(`${same ? 'ok  ' : 'DIFF'} ${line}`);
}
function compare(chainId: number, field: string, pinned: string | undefined, live: string | undefined) {
  report(pinned?.toLowerCase() === live?.toLowerCase(), `${chainId} ${field} pinned=${pinned} live=${live}`);
}

for (const [id, entry] of Object.entries(ALLOWLIST)) {
  const chainId = Number(id);
  if (entry.across) {
    const live = across[id]?.contracts ?? {};
    compare(chainId, 'across.spokePool', entry.across.spokePool, live.SpokePool?.address);
    compare(chainId, 'across.periphery', entry.across.periphery, live.SpokePoolPeriphery?.address);
    compare(chainId, 'across.multicallHandler', entry.across.multicallHandler, live.MulticallHandler?.address);
    if (entry.across.eventEmitter) {
      const url = SOURCES.acrossEventEmitter[chainId];
      const emitter = url === SOURCES.across ? live.AcrossEventEmitter?.address : (await get(url)).address;
      compare(chainId, 'across.eventEmitter', entry.across.eventEmitter, emitter);
    }
  }
  if (entry.relay) {
    const live = relay.find((chain) => chain.id === chainId);
    compare(chainId, 'relay.depository', entry.relay.depository, live?.protocol?.v2?.depository);
    compare(chainId, 'relay.protocolChain', entry.relay.protocolChain, live?.protocol?.v2?.chainId);
    compare(chainId, 'relay.erc20Router', entry.relay.erc20Router, live?.contracts?.erc20Router);
    const pinned = entry.relay.solvers.map((s) => s.toLowerCase());
    const listed = live?.solverAddresses ?? [];
    const added = listed.filter((s) => !pinned.includes(s.toLowerCase()));
    const dropped = pinned.filter((s) => !listed.some((l) => l.toLowerCase() === s));
    report(
      !added.length && !dropped.length,
      `${chainId} relay.solvers pinned=${pinned.length} live=${listed.length} added=[${added}] dropped=[${dropped}]`
    );
  }
}

console.log(`\n${diffs} difference(s)`);
process.exit(diffs ? 1 : 0);
