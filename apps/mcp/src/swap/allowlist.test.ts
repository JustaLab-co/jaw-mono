import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAddress, zeroAddress, type Address } from 'viem';
import { isProxyChain } from '@/lib/chain';
import { ALLOWLIST, APP_FEE, ASSETS, MAX_ROUTE_COST_BPS, SOURCES } from './allowlist';
import acrossQuote from './fixtures/prod-across-quote.json';
import relayQuote from './fixtures/prod-relay-quote.json';

const allowlisted = Object.entries(ALLOWLIST).map(([id, entry]) => ({ chainId: Number(id), ...entry }));
const assets = Object.entries(ASSETS).map(([id, tokens]) => ({ chainId: Number(id), tokens: Object.entries(tokens) }));

function everyAddress(): Address[] {
  const fromAllowlist = allowlisted.flatMap(({ across, relay }) => [
    ...(across ? Object.values(across) : []),
    ...(relay ? [relay.depository, relay.erc20Router, ...relay.solvers] : []),
  ]);
  const fromAssets = assets.flatMap(({ tokens }) => tokens.map(([token]) => token as Address));
  return [...fromAllowlist, ...fromAssets, APP_FEE.recipient];
}

describe('given the pinned swap allowlist', () => {
  it('then every chain it names is a chain the server serves', () => {
    const chains = [...allowlisted, ...assets].map(({ chainId }) => chainId);
    expect(chains.filter((chainId) => !isProxyChain(chainId))).toEqual([]);
  });

  it('then every address is written in its checksummed form', () => {
    expect(everyAddress().filter((address) => getAddress(address) !== address)).toEqual([]);
  });

  it('then USDC has 6 decimals except on BNB Chain, where it has 18, and ETH has 18', () => {
    const wrong = assets.flatMap(({ chainId, tokens }) =>
      tokens
        .filter(([, { asset, decimals }]) => decimals !== (asset === 'USDC' && chainId !== 56 ? 6 : 18))
        .map(([token]) => `${chainId}:${token}`)
    );
    expect(wrong).toEqual([]);
  });

  it('then no chain lists a token, a solver or an Across contract twice', () => {
    for (const { chainId, tokens } of assets) {
      const lower = tokens.map(([token]) => token.toLowerCase());
      expect(new Set(lower).size, `assets on ${chainId}`).toBe(lower.length);
    }
    for (const { chainId, across, relay } of allowlisted) {
      if (relay) expect(new Set(relay.solvers).size, `solvers on ${chainId}`).toBe(relay.solvers.length);
      if (across) expect(new Set(Object.values(across)).size, `across on ${chainId}`).toBe(Object.keys(across).length);
    }
  });

  it('then each Relay protocol chain name maps back to one chain id', () => {
    const names = allowlisted.flatMap(({ relay }) => (relay ? [relay.protocolChain] : []));
    expect(new Set(names).size).toBe(names.length);
  });

  it('then every Relay chain has at least one solver', () => {
    expect(allowlisted.filter(({ relay }) => relay && relay.solvers.length === 0)).toEqual([]);
  });

  it('then where native ETH is an asset, the Across wrapped native token is ETH with 18 decimals', () => {
    for (const { chainId, across } of allowlisted) {
      if (!across || !ASSETS[chainId]?.[zeroAddress]) continue;
      expect(ASSETS[chainId][across.wrappedNative], `wrapped native on ${chainId}`).toEqual({
        asset: 'ETH',
        decimals: 18,
      });
    }
  });

  it('then the contracts of the prod Across and Relay quotes are the Base entries', () => {
    const { across, relay } = ALLOWLIST[8453];
    const [approve, deposit] = acrossQuote.result.data.transactions;
    const [relayDeposit] = relayQuote.result.data.transactions;
    expect(approve.data.slice(34, 74)).toBe(across?.spokePool.slice(2).toLowerCase());
    expect(deposit.to.toLowerCase()).toBe(across?.spokePool.toLowerCase());
    expect(relayDeposit.to.toLowerCase()).toBe(relay?.depository.toLowerCase());
  });

  it('then the route cost floor is 300 bps and the app fee is 25 bps to the backend fee recipient', () => {
    expect(MAX_ROUTE_COST_BPS).toBe(300n);
    expect(APP_FEE).toEqual({ recipient: '0xC529EDD6D47C60923902514C7C0B3993ae42C2ec', maxBps: 25n });
  });

  it('then every source is an https URL', () => {
    expect(Object.values(SOURCES).filter((url) => !url.startsWith('https://'))).toEqual([]);
  });

  it('then the tables match the reviewed digest, so any change to an address or token updates this test', () => {
    const digest = createHash('sha256').update(JSON.stringify({ ALLOWLIST, ASSETS, SOURCES })).digest('hex');
    expect(digest).toBe('0301838b38042239ac603564489bb8302136ced5594490c3b768cf39bec6a944');
  });
});
