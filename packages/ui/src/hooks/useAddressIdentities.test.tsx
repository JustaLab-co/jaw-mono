// @vitest-environment jsdom
// One address can be a name, a token and a known contract at once, and every dialog used to
// ask for each of those on its own. These pin the shared hook at the network edge: what each
// source answers, which answer the label prefers, and how few requests a screen costs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { encodeFunctionResult, erc20Abi, toCoinType, toFunctionSelector, type Hex } from 'viem';

import { clearAddressIdentityCache } from '../utils/addressIdentity';
import { tokenIconUrl } from '../utils/tokenIcon';
import { useAddressIdentities, useAddressIdentity, type UseAddressIdentityOptions } from './useAddressIdentities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Not in SUPPORTED_CHAINS, so token reads go out as plain eth_calls the stub can answer one by one.
const CHAIN = 999_999;
const MAINNET_RPC = 'https://rpc.test/mainnet';
const OPTIONS: UseAddressIdentityOptions = { mainnetRpcUrl: MAINNET_RPC, apiKey: 'key' };

const ALICE = '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b';
const BOB = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER = '0x4444444444444444444444444444444444444444';
// Its own address: the signing path's token cache has no reset, so a token another test
// resolved would answer from there.
const MKR = '0x5555555555555555555555555555555555555555';
const GATEWAY_TOKEN = '0x6666666666666666666666666666666666666666';
const RATE_LIMITED_TOKEN = '0x7777777777777777777777777777777777777777';

const SELECTOR = {
  decimals: toFunctionSelector('function decimals() view returns (uint8)'),
  symbol: toFunctionSelector('function symbol() view returns (string)'),
  name: toFunctionSelector('function name() view returns (string)'),
};

interface Network {
  ens?: Record<string, { name: string; avatar?: boolean }>;
  ensDown?: boolean;
  tokens?: Record<
    string,
    { name?: string; nameBehindGateway?: boolean; nameRpcError?: boolean; symbol: string; decimals: number }
  >;
  contracts?: Record<string, string>;
}

interface Calls {
  ens: URL[];
  index: number;
  descriptors: string[];
  rpc: { to?: string; data?: Hex }[];
}

const caip10 = (address: string) => `eip155:${CHAIN}:${address.toLowerCase()}`;

function rpcResult(id: number, result: Hex) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
}

function rpcRevert(id: number, data?: Hex) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data } }), {
    status: 200,
  });
}

// A JSON-RPC error code viem does not map, which it rethrows as a bare RpcRequestError.
function rpcUnknownError(id: number) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32029, message: 'rate limited' } }), {
    status: 200,
  });
}

// An EIP-3668 `OffchainLookup` revert: the read is refused, not answered.
const OFFCHAIN_LOOKUP: Hex = `0x556f1830${'00'.repeat(160)}`;

function stubNetwork(network: Network): Calls {
  const calls: Calls = { ens: [], index: 0, descriptors: [], rpc: [] };
  const lower = (record: Record<string, unknown> = {}) =>
    new Map(Object.entries(record).map(([address, value]) => [address.toLowerCase(), value]));
  const ens = lower(network.ens) as Map<string, { name: string; avatar?: boolean }>;
  const tokens = lower(network.tokens) as Map<
    string,
    { name?: string; nameBehindGateway?: boolean; nameRpcError?: boolean; symbol: string; decimals: number }
  >;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);

      if (url.pathname.startsWith('/ens/v2/reverse')) {
        calls.ens.push(url);
        if (network.ensDown) return new Response('down', { status: 503 });
        const data = url.searchParams.getAll('address').map((param) => {
          const [address, chain] = param.split('@eip155:');
          const hit = ens.get(address.toLowerCase());
          return {
            address: address.toLowerCase(),
            name: hit?.name ?? null,
            coinType: Number(toCoinType(Number(chain))),
            records: hit?.avatar ? { records: { texts: [{ key: 'avatar', value: 'https://x/a.png' }] } } : null,
          };
        });
        return new Response(JSON.stringify({ result: { data } }), { status: 200 });
      }

      if (url.hostname === 'raw.githubusercontent.com') {
        if (url.pathname.endsWith('/index.calldata.json')) {
          calls.index++;
          const index = Object.fromEntries(
            Object.keys(network.contracts ?? {}).map((address) => [caip10(address), `registry/${address}.json`])
          );
          return new Response(JSON.stringify(index), { status: 200 });
        }
        calls.descriptors.push(url.pathname);
        const address = (url.pathname.split('/').pop() ?? '').replace('.json', '');
        const contractName = network.contracts?.[address];
        return new Response(JSON.stringify({ metadata: { contractName } }), { status: 200 });
      }

      // Everything else is JSON-RPC: the JAW proxy for token reads, mainnet for chain labels.
      const body = JSON.parse(String(init?.body)) as { id: number; params: [{ to?: string; data?: Hex }] };
      const { to, data } = body.params[0] ?? {};
      if (input.startsWith(MAINNET_RPC)) return rpcRevert(body.id);
      calls.rpc.push({ to, data });

      const token = to ? tokens.get(to.toLowerCase()) : undefined;
      const selector = data?.slice(0, 10);
      if (!token) return rpcRevert(body.id);
      if (selector === SELECTOR.decimals) {
        return rpcResult(
          body.id,
          encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: token.decimals })
        );
      }
      if (selector === SELECTOR.symbol) {
        return rpcResult(
          body.id,
          encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: token.symbol })
        );
      }
      if (selector === SELECTOR.name && token.nameBehindGateway) return rpcRevert(body.id, OFFCHAIN_LOOKUP);
      if (selector === SELECTOR.name && token.nameRpcError) return rpcUnknownError(body.id);
      if (selector === SELECTOR.name && token.name) {
        return rpcResult(body.id, encodeFunctionResult({ abi: erc20Abi, functionName: 'name', result: token.name }));
      }
      return rpcRevert(body.id);
    })
  );

  return calls;
}

let container: HTMLDivElement;
let root: Root;
const seen = new Map<string, ReturnType<typeof useAddressIdentity>>();
const renders = new Map<string, number>();

function Probe({
  id,
  address,
  options = OPTIONS,
}: {
  id: string;
  address?: string;
  options?: UseAddressIdentityOptions;
}) {
  const identity = useAddressIdentity(address, CHAIN, options);
  seen.set(id, identity);
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return null;
}

async function render(...elements: ReturnType<typeof createElement>[]) {
  await act(async () => {
    root.render(createElement('div', null, ...elements));
  });
}

/** Let every queued request answer and every resulting render land. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  clearAddressIdentityCache();
  seen.clear();
  renders.clear();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useAddressIdentity', () => {
  it('resolves the ENS name, token and clear-signing name of one address, with their icons', async () => {
    stubNetwork({
      ens: { [TOKEN]: { name: 'usdc.eth', avatar: true } },
      tokens: { [TOKEN]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 } },
      contracts: { [TOKEN]: 'Circle USDC' },
    });

    await render(createElement(Probe, { id: 'a', address: TOKEN }));
    await settle();

    expect(seen.get('a')).toMatchObject({
      ensName: 'usdc.eth',
      ensPlainName: 'usdc.eth',
      ensAvatar: 'https://metadata.ens.domains/mainnet/avatar/usdc.eth',
      tokenName: 'USD Coin',
      tokenSymbol: 'USDC',
      tokenIcon: tokenIconUrl(CHAIN, TOKEN),
      clearSigningName: 'Circle USDC',
      // No logo source for ERC-7730 contracts yet; the token endpoint 404s for most of them.
      clearSigningIcon: null,
      label: 'usdc.eth',
      loading: { ens: false, token: false, clearSigning: false },
    });
  });

  it('starts as the short address, loading every source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );

    await render(createElement(Probe, { id: 'a', address: ALICE }));

    expect(seen.get('a')).toMatchObject({
      ensName: null,
      tokenSymbol: null,
      clearSigningName: null,
      label: '0x71f2...969b',
      loading: { ens: true, token: true, clearSigning: true },
    });
  });

  it('labels with the clear-signing name when there is no ENS name', async () => {
    stubNetwork({ tokens: { [ROUTER]: { symbol: 'RTR', decimals: 18 } }, contracts: { [ROUTER]: 'Uniswap Router' } });

    await render(createElement(Probe, { id: 'a', address: ROUTER }));
    await settle();

    expect(seen.get('a')?.label).toBe('Uniswap Router');
  });

  it('labels with the token symbol when there is no ENS or clear-signing name', async () => {
    stubNetwork({ tokens: { [TOKEN]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 } } });

    await render(createElement(Probe, { id: 'a', address: TOKEN }));
    await settle();

    expect(seen.get('a')?.label).toBe('USDC');
  });

  it('labels with the short address when nothing resolves, and stops loading', async () => {
    stubNetwork({});

    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();

    expect(seen.get('a')).toMatchObject({
      label: '0x71f2...969b',
      loading: { ens: false, token: false, clearSigning: false },
    });
  });

  // Some tokens (MKR among them) answer name() with bytes32, which does not decode as a string.
  it('keeps the symbol of a token whose name() cannot be read', async () => {
    stubNetwork({ tokens: { [MKR]: { symbol: 'MKR', decimals: 18 } } });

    await render(createElement(Probe, { id: 'a', address: MKR }));
    await settle();

    expect(seen.get('a')).toMatchObject({ tokenName: null, tokenSymbol: 'MKR' });
  });

  it('returns null with no address', async () => {
    stubNetwork({});

    await render(createElement(Probe, { id: 'a' }));
    await settle();

    expect(seen.get('a')).toBeNull();
  });

  it('never shows the previous address its answer once the address changes', async () => {
    stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });

    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await render(createElement(Probe, { id: 'a', address: BOB }));
    await settle();

    expect(seen.get('a')).toMatchObject({ address: BOB, ensName: null, label: '0x2222...2222' });
  });
});

describe('request cost', () => {
  it('sends one ENS request for every address asked for in the same render', async () => {
    const calls = stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' }, [BOB]: { name: 'bob.eth' } } });

    await render(createElement(Probe, { id: 'a', address: ALICE }), createElement(Probe, { id: 'b', address: BOB }));
    await settle();

    expect(calls.ens).toHaveLength(1);
    expect(calls.ens[0].searchParams.getAll('address')).toEqual([`${ALICE}@eip155:${CHAIN}`, `${BOB}@eip155:${CHAIN}`]);
    expect(calls.ens[0].searchParams.get('records')).toBe('true');
    expect(seen.get('a')?.ensName).toBe('alice.eth');
    expect(seen.get('b')?.ensName).toBe('bob.eth');
  });

  it('downloads the clear-signing index once for every address on the screen', async () => {
    const calls = stubNetwork({});

    await render(createElement(Probe, { id: 'a', address: ALICE }), createElement(Probe, { id: 'b', address: BOB }));
    await settle();

    expect(calls.index).toBe(1);
  });

  it('asks once when two components want the same address', async () => {
    const calls = stubNetwork({ tokens: { [TOKEN]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 } } });

    await render(createElement(Probe, { id: 'a', address: TOKEN }), createElement(Probe, { id: 'b', address: TOKEN }));
    await settle();

    expect(calls.ens).toHaveLength(1);
    expect(calls.ens[0].searchParams.getAll('address')).toHaveLength(1);
    expect(calls.rpc.filter((c) => c.data?.startsWith(SELECTOR.name))).toHaveLength(1);
  });

  it('answers a later mount from the cache, on its first render', async () => {
    stubNetwork({
      ens: { [TOKEN]: { name: 'usdc.eth' } },
      tokens: { [TOKEN]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 } },
      contracts: { [TOKEN]: 'Circle USDC' },
    });
    await render(createElement(Probe, { id: 'a', address: TOKEN }));
    await settle();

    vi.unstubAllGlobals();
    const calls = stubNetwork({});
    await render(createElement(Probe, { id: 'b', address: TOKEN }));

    expect(seen.get('b')).toMatchObject({
      ensName: 'usdc.eth',
      tokenName: 'USD Coin',
      clearSigningName: 'Circle USDC',
      loading: { ens: false, token: false, clearSigning: false },
    });
    await settle();
    expect(calls.ens).toHaveLength(0);
    expect(calls.rpc).toHaveLength(0);
    expect(calls.index).toBe(0);
  });

  it('asks again after an ENS outage instead of remembering it as no name', async () => {
    stubNetwork({ ensDown: true, ens: { [ALICE]: { name: 'alice.eth' } } });
    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();
    expect(seen.get('a')).toMatchObject({ ensName: null, loading: { ens: false } });

    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
    await render(createElement(Probe, { id: 'b', address: ALICE }));
    await settle();

    expect(seen.get('b')?.ensName).toBe('alice.eth');
  });

  it('does not ask a proven non-token again on a later mount', async () => {
    stubNetwork({});
    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();

    vi.unstubAllGlobals();
    const calls = stubNetwork({});
    await render(createElement(Probe, { id: 'b', address: ALICE }));
    await settle();

    expect(calls.rpc).toHaveLength(0);
    expect(seen.get('b')).toMatchObject({ tokenSymbol: null, loading: { token: false } });
  });

  // The client refuses offchain lookups, so the revert says the read was refused, not that
  // the token has no name. Remembering it would blank the name for the whole session.
  it('asks again for a name() behind a CCIP-Read gateway', async () => {
    stubNetwork({ tokens: { [GATEWAY_TOKEN]: { nameBehindGateway: true, symbol: 'GW', decimals: 18 } } });
    await render(createElement(Probe, { id: 'a', address: GATEWAY_TOKEN }));
    await settle();
    expect(seen.get('a')).toMatchObject({ tokenName: null, tokenSymbol: 'GW' });

    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    stubNetwork({ tokens: { [GATEWAY_TOKEN]: { name: 'Gateway Token', symbol: 'GW', decimals: 18 } } });
    await render(createElement(Probe, { id: 'b', address: GATEWAY_TOKEN }));
    await settle();

    expect(seen.get('b')?.tokenName).toBe('Gateway Token');
  });

  it('asks again for a name() the node refused with an unmapped JSON-RPC error', async () => {
    stubNetwork({ tokens: { [RATE_LIMITED_TOKEN]: { nameRpcError: true, symbol: 'RL', decimals: 18 } } });
    await render(createElement(Probe, { id: 'a', address: RATE_LIMITED_TOKEN }));
    await settle();
    expect(seen.get('a')).toMatchObject({ tokenName: null, tokenSymbol: 'RL' });

    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    stubNetwork({ tokens: { [RATE_LIMITED_TOKEN]: { name: 'Rate Limited', symbol: 'RL', decimals: 18 } } });
    await render(createElement(Probe, { id: 'b', address: RATE_LIMITED_TOKEN }));
    await settle();

    expect(seen.get('b')?.tokenName).toBe('Rate Limited');
  });

  // Onboarding adds a subname and opens Connect straight away, before the reverse index has it.
  it('asks again for a name it missed once a minute has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      stubNetwork({});
      await render(createElement(Probe, { id: 'a', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
      await settle();
      act(() => root.unmount());

      vi.unstubAllGlobals();
      let calls = stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
      root = createRoot(container);
      await render(createElement(Probe, { id: 'b', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
      await settle();
      expect(calls.ens).toHaveLength(0);
      act(() => root.unmount());

      vi.setSystemTime(Date.now() + 60_001);
      vi.unstubAllGlobals();
      calls = stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
      root = createRoot(container);
      await render(createElement(Probe, { id: 'c', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
      await settle();

      expect(calls.ens).toHaveLength(1);
      expect(seen.get('c')?.ensName).toBe('alice.eth');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a name it found past that minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
      await render(createElement(Probe, { id: 'a', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
      await settle();
      act(() => root.unmount());

      vi.setSystemTime(Date.now() + 60_001);
      vi.unstubAllGlobals();
      const calls = stubNetwork({});
      root = createRoot(container);
      await render(createElement(Probe, { id: 'b', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
      await settle();

      expect(calls.ens).toHaveLength(0);
      expect(seen.get('b')?.ensName).toBe('alice.eth');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a mount once while its first answer is on the way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );

    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();

    expect(renders.get('a')).toBe(1);
  });

  it('upgrades a component that saw an outage once another one gets the answer', async () => {
    stubNetwork({ ensDown: true });
    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();
    expect(seen.get('a')?.ensName).toBeNull();

    vi.unstubAllGlobals();
    stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
    await render(createElement(Probe, { id: 'a', address: ALICE }), createElement(Probe, { id: 'b', address: ALICE }));
    await settle();

    expect(seen.get('b')?.ensName).toBe('alice.eth');
    expect(seen.get('a')?.ensName).toBe('alice.eth');
  });

  it('shows loading again while it retries after an outage', async () => {
    stubNetwork({ ensDown: true });
    await render(createElement(Probe, { id: 'a', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
    await settle();
    expect(seen.get('a')?.loading.ens).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );
    await render(createElement(Probe, { id: 'b', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));

    expect(seen.get('b')?.loading.ens).toBe(true);
  });

  it('does not re-render for an answer about another address', async () => {
    stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' }, [BOB]: { name: 'bob.eth' } } });
    await render(createElement(Probe, { id: 'a', address: ALICE }));
    await settle();
    const before = renders.get('a');

    const other = createRoot(document.createElement('div'));
    await act(async () => {
      other.render(createElement(Probe, { id: 'b', address: BOB }));
    });
    await settle();

    expect(seen.get('b')?.ensName).toBe('bob.eth');
    expect(renders.get('a')).toBe(before);
    act(() => other.unmount());
  });

  it('asks only the sources it was told to include', async () => {
    const calls = stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });

    await render(createElement(Probe, { id: 'a', address: ALICE, options: { ...OPTIONS, include: ['ens'] } }));
    await settle();

    expect(seen.get('a')).toMatchObject({ ensName: 'alice.eth', loading: { ens: false } });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.index).toBe(0);
  });
});

describe('useAddressIdentities', () => {
  it('files each answer under its address and chain', async () => {
    stubNetwork({ ens: { [ALICE]: { name: 'alice.eth' } } });
    let identities: ReturnType<typeof useAddressIdentities> = {};
    function List() {
      identities = useAddressIdentities(
        [
          { address: ALICE, chainId: CHAIN },
          { address: BOB, chainId: CHAIN },
        ],
        OPTIONS
      );
      return null;
    }

    await render(createElement(List));
    await settle();

    expect(identities[`${ALICE.toLowerCase()}:${CHAIN}`]?.ensName).toBe('alice.eth');
    expect(identities[`${BOB.toLowerCase()}:${CHAIN}`]?.ensName).toBeNull();
  });
});
