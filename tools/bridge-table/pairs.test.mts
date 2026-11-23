import { describe, expect, test } from 'bun:test';
import { BRIDGE_CHAINS, type BridgeChain } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';
import { NVDA_ROBINHOOD, probePairs } from './pairs.mts';

const SEPOLIAS = [11155111, 84532, 11155420, 421614];
const acrossPairs = () => probePairs(BRIDGE_CHAINS).pairs.filter((pair) => pair.only !== 'relay');
const chainIds = (keep: (chain: BridgeChain) => unknown) =>
  Object.entries(BRIDGE_CHAINS)
    .filter(([, chain]) => keep(chain))
    .map(([id]) => Number(id));

describe('probePairs', () => {
  test('bridges out of every chain the table pins a prefunded store on, Robinhood Chain included', () => {
    const stores = chainIds((chain) => chain.across?.prefundedStore);
    expect(stores).toContain(4663);
    const origins = new Set(acrossPairs().map((pair) => pair.from));
    expect(stores.filter((id) => !origins.has(id))).toEqual([]);
  });

  test('bridges into every Across mainnet chain', () => {
    const mainnets = chainIds((chain) => chain.across).filter((id) => !SEPOLIAS.includes(id));
    const destinations = new Set(acrossPairs().map((pair) => pair.to));
    expect(mainnets.filter((id) => !destinations.has(id))).toEqual([]);
  });

  test('swaps into NVDA on Robinhood Chain at a Uniswap size and a LiFi size', () => {
    const nvda = acrossPairs().filter((pair) => pair.to === 4663 && pair.receive === NVDA_ROBINHOOD);
    expect(nvda.map((pair) => pair.amount)).toEqual([3_000_000n, 100_000_000n]);
  });

  test('names a store chain it cannot pair instead of dropping it', () => {
    const bare = { ...BRIDGE_CHAINS[8453], name: 'Bare', tokens: {} };
    const { pairs, unprobed } = probePairs({ ...BRIDGE_CHAINS, 777777: bare });
    expect(pairs.filter((pair) => pair.from === 777777 || pair.to === 777777)).toEqual([]);
    expect(unprobed).toContain('Bare: no USDC or WETH in the table');
  });
});
