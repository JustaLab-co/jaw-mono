import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, toFunctionSelector, type Hex } from 'viem';

import { setDappOrigin } from '@jaw.id/core/internal';

import { getJawPublicClient, getPublicClient, jawRpcUrl } from './publicClient';
import { getChainLabel } from './resolveChainLabel';
import { fetchTokenBalance } from './tokenBalance';
import { createTokenResolver } from './clearSigning';

// Base — carries a Multicall3 address in viem's chain definition.
const CHAIN_WITH_MULTICALL = 8453;
// Not in SUPPORTED_CHAINS, so the client is built without a chain and viem has
// no Multicall3 address to batch through.
const CHAIN_WITHOUT_MULTICALL = 999_999;

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const HOLDER = '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b';
const TOKENS = [
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  '0x4200000000000000000000000000000000000006',
  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
];

const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

const SELECTOR = {
  decimals: toFunctionSelector('function decimals() view returns (uint8)'),
  symbol: toFunctionSelector('function symbol() view returns (string)'),
};

/**
 * Result for one inner call. `balanceOf` (and anything unrecognised) answers with
 * its position in the batch so a caller can prove it got *its own* result back;
 * `decimals`/`symbol` answer with properly encoded ERC-20 types so the token
 * metadata pair decodes.
 */
function answer(callData: Hex | undefined, index: number): Hex {
  const selector = callData?.slice(0, 10);
  if (selector === SELECTOR.decimals) {
    return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 }) as Hex;
  }
  if (selector === SELECTOR.symbol) {
    return encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'TKN' }) as Hex;
  }
  return word(BigInt(index + 1));
}

const json = (id: number, result: Hex) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Stub `fetch` with a node that answers `eth_call` — both plain and wrapped in a
 * Multicall3 `aggregate3`. Returns the list of request bodies actually sent, so
 * a test can assert how many round-trips a fan-out cost.
 *
 * `revertFor` marks target addresses whose call reverts, which inside an
 * `aggregate3` comes back as `success: false` on that entry alone — the shape the
 * `allowFailure` isolation claim rests on.
 */
function stubRpc(options: { revertFor?: string[]; unavailable?: boolean } = {}) {
  const bodies: { method: string; to?: string; data?: Hex; dappOrigin: string | null }[] = [];
  const reverts = new Set((options.revertFor ?? []).map((a) => a.toLowerCase()));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (options.unavailable) {
        bodies.push({ method: 'unavailable', dappOrigin: null });
        return new Response('service unavailable', { status: 503 });
      }
      const body = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params: [{ to?: string; data?: Hex }];
      };
      bodies.push({
        method: body.method,
        to: body.params?.[0]?.to,
        data: body.params?.[0]?.data,
        dappOrigin: new Headers(init.headers).get('x-dapp-origin'),
      });

      const { to, data } = body.params[0];

      if (to?.toLowerCase() === MULTICALL3) {
        const { args } = decodeFunctionData({ abi: aggregate3Abi, data: data as Hex });
        const calls = args[0] as readonly { target: string; callData: Hex }[];
        return json(
          body.id,
          encodeFunctionResult({
            abi: aggregate3Abi,
            functionName: 'aggregate3',
            result: calls.map((call, i) =>
              reverts.has(call.target.toLowerCase())
                ? { success: false, returnData: '0x' as Hex }
                : { success: true, returnData: answer(call.callData, i) }
            ),
          }) as Hex
        );
      }

      if (to && reverts.has(to.toLowerCase())) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'reverted' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return json(body.id, answer(data, 0));
    })
  );

  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setDappOrigin(undefined);
});

describe('getPublicClient', () => {
  it('returns the same instance for the same chain and RPC URL', () => {
    const url = jawRpcUrl(CHAIN_WITH_MULTICALL, 'key-a');
    expect(getPublicClient(CHAIN_WITH_MULTICALL, url)).toBe(getPublicClient(CHAIN_WITH_MULTICALL, url));
  });

  it('returns distinct instances for different RPC URLs', () => {
    const a = getPublicClient(CHAIN_WITH_MULTICALL, jawRpcUrl(CHAIN_WITH_MULTICALL, 'key-b'));
    const b = getPublicClient(CHAIN_WITH_MULTICALL, jawRpcUrl(CHAIN_WITH_MULTICALL, 'key-c'));
    expect(a).not.toBe(b);
  });

  it('builds the JAW RPC URL with and without an API key', () => {
    expect(jawRpcUrl(8453, 'abc')).toContain('chainId=8453&api-key=abc');
    expect(jawRpcUrl(8453)).toContain('chainId=8453');
    expect(jawRpcUrl(8453)).not.toContain('api-key');
  });

  // This is what lets a dialog's fee-token balance fan-out and clear-signing's
  // token resolver share one aggregate3 — and, by the same token, fail together.
  it('shares one instance with the explicit JAW RPC URL', () => {
    const apiKey = 'key-shared';
    expect(getJawPublicClient(CHAIN_WITH_MULTICALL, apiKey)).toBe(
      getPublicClient(CHAIN_WITH_MULTICALL, jawRpcUrl(CHAIN_WITH_MULTICALL, apiKey))
    );
  });

  // Attaching the chain definition costs viem's own UrlRequiredError guard: `http()`
  // resolves `url || chain.rpcUrls.default.http[0]`, so an empty URL would silently
  // route wallet traffic to the chain's public node instead of the proxy.
  it('refuses an empty RPC URL rather than falling back to the chain public node', () => {
    expect(() => getPublicClient(CHAIN_WITH_MULTICALL, '')).toThrow(/No RPC URL configured/);
  });
});

// keys.jaw.id mounts these dialogs, so a keyless read leaves with keys' Origin and
// the backend needs the header to know which dApp it serves.
describe('x-dapp-origin', () => {
  const DAPP = 'https://dapp.example';
  const THIRD_PARTY_RPC = 'https://rpc.third-party.test';

  it('names the dApp on a JAW RPC url', async () => {
    const bodies = stubRpc();
    setDappOrigin(DAPP);

    await fetchTokenBalance(TOKENS[0], HOLDER, jawRpcUrl(CHAIN_WITHOUT_MULTICALL), CHAIN_WITHOUT_MULTICALL);

    expect(bodies[0].dappOrigin).toBe(DAPP);
  });

  it('sends nothing when no dApp was set', async () => {
    const bodies = stubRpc();

    await fetchTokenBalance(TOKENS[0], HOLDER, jawRpcUrl(CHAIN_WITHOUT_MULTICALL), CHAIN_WITHOUT_MULTICALL);

    expect(bodies[0].dappOrigin).toBeNull();
  });

  it('never tells a third-party RPC which dApp the user is on', async () => {
    const bodies = stubRpc();
    setDappOrigin(DAPP);

    await fetchTokenBalance(TOKENS[0], HOLDER, THIRD_PARTY_RPC, CHAIN_WITHOUT_MULTICALL);

    expect(bodies[0].dappOrigin).toBeNull();
  });

  // What lets clientCache stay keyed on (chainId, rpcUrl): the dApp arrives after
  // the client exists.
  it('picks up a dApp set after the client was cached', async () => {
    const bodies = stubRpc();
    const rpcUrl = jawRpcUrl(CHAIN_WITH_MULTICALL, 'key-late-origin');
    const client = getPublicClient(CHAIN_WITH_MULTICALL, rpcUrl);

    setDappOrigin(DAPP);
    await fetchTokenBalance(TOKENS[0], HOLDER, rpcUrl, CHAIN_WITH_MULTICALL);

    expect(getPublicClient(CHAIN_WITH_MULTICALL, rpcUrl)).toBe(client);
    expect(bodies[0].dappOrigin).toBe(DAPP);
  });

  it('names the dApp on the chain label lookup', async () => {
    const bodies = stubRpc();
    setDappOrigin(DAPP);

    await getChainLabel(42161, jawRpcUrl(1));

    expect(bodies[0].dappOrigin).toBe(DAPP);
  });
});

describe('fetchTokenBalance batching', () => {
  it('folds a concurrent ERC-20 fan-out into one Multicall3 request', async () => {
    const bodies = stubRpc();
    const rpcUrl = 'https://rpc.test/multicall-fanout';

    const balances = await Promise.all(
      TOKENS.map((token) => fetchTokenBalance(token, HOLDER, rpcUrl, CHAIN_WITH_MULTICALL))
    );

    // Three reads, one round-trip, addressed to Multicall3.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].to?.toLowerCase()).toBe(MULTICALL3);
    // Each caller still gets its own decoded result, in its own order.
    expect(balances).toEqual([1n, 2n, 3n]);
  });

  it('falls back to one request per call when the chain has no Multicall3', async () => {
    const bodies = stubRpc();
    const rpcUrl = 'https://rpc.test/no-multicall';

    const balances = await Promise.all(
      TOKENS.map((token) => fetchTokenBalance(token, HOLDER, rpcUrl, CHAIN_WITHOUT_MULTICALL))
    );

    expect(bodies).toHaveLength(TOKENS.length);
    expect(bodies.every((b) => b.to?.toLowerCase() !== MULTICALL3)).toBe(true);
    expect(balances).toEqual([1n, 1n, 1n]);
  });

  it('does not batch when callers omit the chain id', async () => {
    const bodies = stubRpc();
    const rpcUrl = 'https://rpc.test/no-chain-id';

    await Promise.all(TOKENS.map((token) => fetchTokenBalance(token, HOLDER, rpcUrl)));

    expect(bodies).toHaveLength(TOKENS.length);
  });

  // The isolation half of `allowFailure`, which both doc comments rest on: a call
  // that reverts costs only its own caller, not the rest of the batch.
  it('rejects only the reverting caller, leaving the rest of the batch intact', async () => {
    const bodies = stubRpc({ revertFor: [TOKENS[1]] });
    const rpcUrl = 'https://rpc.test/partial-revert';

    const settled = await Promise.allSettled(
      TOKENS.map((token) => fetchTokenBalance(token, HOLDER, rpcUrl, CHAIN_WITH_MULTICALL))
    );

    expect(bodies).toHaveLength(1);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((settled[0] as PromiseFulfilledResult<bigint>).value).toBe(1n);
    expect((settled[2] as PromiseFulfilledResult<bigint>).value).toBe(3n);
  });
});

describe('createTokenResolver batching', () => {
  // The biggest fan-out in the dialog: N tokens × (decimals + symbol).
  it('folds decimals + symbol across several tokens into one Multicall3 request', async () => {
    const bodies = stubRpc();
    const resolve = createTokenResolver(CHAIN_WITH_MULTICALL, 'key-resolver');

    const infos = await Promise.all(TOKENS.map((token) => resolve(token)));

    // 3 tokens × 2 reads = 6 eth_calls, one round-trip.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].to?.toLowerCase()).toBe(MULTICALL3);
    expect(infos).toEqual(TOKENS.map((address) => ({ address, decimals: 6, symbol: 'TKN' })));
  });

  // tokenCache has no TTL, so a cached null lasts the session. One 503 on the shared
  // aggregate3 must not blank every token in the batch for good.
  it('does not negative-cache a transient RPC failure', async () => {
    const chainId = 8453;
    const token = '0x1111111111111111111111111111111111111111';

    stubRpc({ unavailable: true });
    expect(await createTokenResolver(chainId, 'key-transient')(token)).toBeNull();

    vi.unstubAllGlobals();
    stubRpc();
    expect(await createTokenResolver(chainId, 'key-transient')(token)).toEqual({
      address: token,
      decimals: 6,
      symbol: 'TKN',
    });
  });

  // The other half: a call that actually fails on-chain is proof the address is not a
  // token, so it stays cached and costs no further round-trips.
  it('negative-caches a reverting token and does not re-query it', async () => {
    const chainId = 8453;
    const token = '0x2222222222222222222222222222222222222222';

    stubRpc({ revertFor: [token] });
    expect(await createTokenResolver(chainId, 'key-revert')(token)).toBeNull();

    vi.unstubAllGlobals();
    const bodies = stubRpc();
    expect(await createTokenResolver(chainId, 'key-revert')(token)).toBeNull();
    expect(bodies).toHaveLength(0);
  });
});
