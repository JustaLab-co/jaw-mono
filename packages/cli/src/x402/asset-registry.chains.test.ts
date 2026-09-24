import { describe, it, expect } from 'vitest';
import { USDC_BY_NETWORK } from './asset-registry.js';

// Imported the way every other core use in this package is, because the lint
// rule that forbids a static one does not exempt tests. It costs nothing here:
// the rule is about CLI startup, and a test has none.
const { SUPPORTED_CHAINS } = await import('@jaw.id/core');

/**
 * Every chain the x402 registry names has to be one core can resolve. The payer
 * account runs on core: it builds the client, resolves the Multicall3 address
 * and names the chain on the grant screen. A registry entry core does not know
 * still works, which is why this went unnoticed, it just works worse. The owner
 * scan falls back to one slot per request, receipt polling loses `blockTime` and
 * takes viem's default, and the grant screen renders the number instead of a name.
 *
 * One direction only. Core is free to be much wider, and it is: a chain reaches
 * `SUPPORTED_CHAINS` when the wallet should offer it, and the registry when the
 * facilitator will settle there. Neither implies the other. What must never
 * happen is the second without the first.
 *
 */
describe('the x402 registry stays inside what core supports', () => {
  const supported = new Set(SUPPORTED_CHAINS.map((chain) => chain.id));

  it.each(Object.entries(USDC_BY_NETWORK))('%s is a chain core can resolve', (_network, asset) => {
    expect(supported).toContain(asset.chainId);
  });
});
