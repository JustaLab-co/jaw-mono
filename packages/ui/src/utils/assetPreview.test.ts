import { describe, expect, it, vi } from 'vitest';
import {
  concat,
  createPublicClient,
  custom,
  encodeAbiParameters,
  ethAddress,
  pad,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { formatAssetAmount, mapAssetChanges, resolveTokenUnits, type RawAssetChange } from './assetPreview';

const publicClient = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('./publicClient', () => ({
  getJawPublicClient: () => publicClient.current,
  getPublicClient: () => publicClient.current,
  jawRpcUrl: () => 'https://rpc.test',
}));

// Imported after the mock so `simulateAssetChanges` resolves the stubbed client.
const { simulateAssetChanges } = await import('./assetPreview');

/** A viem `assetChanges` entry, in the shape `simulateCalls` returns. */
function change(
  address: string,
  diff: bigint,
  token: { decimals?: number; symbol?: string } = {},
  pre = 0n
): RawAssetChange {
  return { token: { address, ...token }, value: { pre, post: pre + diff, diff } };
}

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Two shapes an ERC-721 arrives in, named for the Base contracts they were observed on: viem
// reports the first as `decimals: 1` (its `tokenURI` answers, so it falls into `decimals() ?? 1`)
// and the second as `undefined` (both probes revert). The addresses are only fixtures — nothing
// here reaches a chain, so treat them as "a token shaped like this", not as a verified claim.
const BRZ = '0xa360c63e8e4e7ce584d8f41fb071bc80b56a3e93';
const AERO_POS = '0x827922686190790b37229fd06084350e74485b72';
// A token whose `decimals()` returns 0, which viem's `tokenURI_ || decimals_` guard reads as
// falsy and reports as `undefined`.
const ZERO_DEC = '0x0000000000000000000000000000000000000d00';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const BATCH_CALLDATA = '0xfeedface' as Hex;
/** The batch `resolveTokenUnits` replays ahead of its probes, distinctive so it is recognisable. */
const BATCH = { account: ACCOUNT, calls: [{ to: AERO_POS as Address, data: BATCH_CALLDATA }] };

describe('mapAssetChanges', () => {
  it('splits a swap into an outgoing and an incoming row', () => {
    const deltas = mapAssetChanges([
      change(ethAddress, -5_000_000_000_000_000n, { decimals: 18, symbol: 'ETH' }),
      change(USDC, 12_500_000n, { decimals: 6, symbol: 'USDC' }),
    ]);

    expect(deltas).toEqual([
      expect.objectContaining({ symbol: 'ETH', direction: 'out', amountFormatted: '0.005', isNative: true }),
      expect.objectContaining({ symbol: 'USDC', direction: 'in', amountFormatted: '12.5', isNative: false }),
    ]);
  });

  it('drops assets the batch left untouched', () => {
    // viem returns a row per candidate, diff included — a preview must not list a 0 change.
    expect(mapAssetChanges([change(USDC, 0n, { decimals: 6, symbol: 'USDC' }, 1_000_000n)])).toEqual([]);
  });

  it('renders a confirmed ERC-721 as a whole-token count, not "0.1"', () => {
    const [delta] = mapAssetChanges([change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })], new Set([BRZ.toLowerCase()]));

    expect(delta).toMatchObject({ decimals: 0, direction: 'out', amountFormatted: '1' });
  });

  it('keeps an ERC-721 whose decimals viem could not read at all', () => {
    const changes = [change(AERO_POS, 1n, { symbol: 'AERO-CL-POS' })];

    // Unconfirmed it has no usable unit, so it cannot be rendered as an amount...
    expect(mapAssetChanges(changes)).toEqual([]);
    // ...but ERC-165 makes it a count.
    expect(mapAssetChanges(changes, new Set([AERO_POS.toLowerCase()]))).toEqual([
      expect.objectContaining({ decimals: 0, direction: 'in', amountFormatted: '1' }),
    ]);
  });

  it('matches the ERC-721 set case-insensitively', () => {
    // viem lowercases every candidate today, but `mapAssetChanges` is an exported helper and
    // callers pass their own rows — the set lookup must not depend on which casing arrives.
    const [delta] = mapAssetChanges(
      [change(BRZ.toUpperCase().replace('0X', '0x'), -1n, { decimals: 1, symbol: 'BRZ' })],
      new Set([BRZ.toLowerCase()])
    );

    expect(delta.decimals).toBe(0);
  });

  it('drops an ERC-20 with no symbol', () => {
    // A bytes32 `symbol()` (MKR-style) fails viem's decode and arrives undefined.
    expect(mapAssetChanges([change(USDC, 1_000_000n, { decimals: 6 })])).toEqual([]);
  });

  it('treats the native pseudo-address as native whatever viem reports', () => {
    const [delta] = mapAssetChanges([change(ethAddress.toUpperCase().replace('0X', '0x'), 1n)]);

    expect(delta).toMatchObject({ isNative: true, decimals: 18, symbol: 'ETH' });
  });

  it('drops a token reporting decimals past a uint8 instead of formatting it', () => {
    // viem decodes the `decimals()` word as `uint256` and reports `Number` of it, so a contract
    // picks this number. `formatUnits` pads to that many digits, quadratically: 100_000 blocks
    // the render thread for ~4.5s, 1_000_000 for minutes, `Number(2n ** 200n)` throws
    // `RangeError: Out of memory`. A batch only has to touch such a contract to be measured.
    //
    // The inputs stop at the boundary rather than including a 1_000_000 — every value above 255
    // takes the same branch, and one that renders for minutes would turn a regression here from
    // a red test into a hung CI job.
    const hostile = [
      change(USDC, 1n, { decimals: 256, symbol: 'OVER' }),
      change(USDC, 1n, { decimals: Number(2n ** 200n), symbol: 'OOM' }),
      change(USDC, 1n, { decimals: -1, symbol: 'NEG' }),
      change(USDC, 1n, { decimals: 6.5, symbol: 'FRAC' }),
    ];

    expect(mapAssetChanges(hostile)).toEqual([]);
  });

  it('still formats the largest decimals a compliant token can declare', () => {
    // The bound is ERC-20's own `uint8`, not an arbitrary cutoff — 255 must still render.
    const [delta] = mapAssetChanges([change(USDC, 1n, { decimals: 255, symbol: 'MAX' })]);

    expect(delta).toMatchObject({ decimals: 255, direction: 'in' });
  });
});

const SUPPORTS_INTERFACE = '0x01ffc9a7';
const DECIMALS = '0x313ce567';
// `supportsInterface(0x80ac58cd)`, written out rather than re-encoded from the source constant:
// re-encoding would make any interface id agree with itself, including a wrong one.
const ERC721_QUERY = `0x01ffc9a780ac58cd${'00'.repeat(28)}` as Hex;
const BLOCK = 31_337n;
const BLOCK_HEX = '0x7a69';

const word = (n: number | bigint) => `0x${n.toString(16).padStart(64, '0')}` as const;
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

/** A probe's on-chain outcome: the bytes it returned, or `revert` for a function it has not got. */
type Outcome = Hex | 'revert';

const ok = (returnData: Hex) => ({ status: '0x1', returnData, gasUsed: '0x0' });
const failed = (returnData: Hex = '0x') => ({ status: '0x0', returnData, gasUsed: '0x0' });
const outcome = (o: Outcome) => (o === 'revert' ? failed() : ok(o));
/** A revert carrying an `Error(string)` reason, the shape `classifyRevert` reads. */
const revertWith = (reason: string) =>
  failed(concat(['0x08c379a0', encodeAbiParameters([{ type: 'string' }], [reason])]));

interface Probe {
  to: Address;
  data: Hex;
  block: string;
}

/**
 * A client stubbed at the transport, so `resolveTokenUnits` runs its real `eth_simulateV1`
 * encoding, its real per-call status handling and its real ABI decoding — only the node is fake.
 * Stubbing higher up (at `client.call`, say) would skip the seam where a request failure and a
 * contract's "no" have to stay distinguishable, which is the behaviour these tests exist for.
 *
 * `answer` receives the 4-byte selector and the target, and answers the probe block only — the
 * batch `resolveTokenUnits` replays ahead of it always succeeds. `blocks` records every block's
 * calls in the order the node saw them, so the replay's position is assertable and not assumed.
 * Pass `transportError` to make the node itself fail.
 */
function stubClient(answer: (selector: string, to: string) => Outcome, transportError?: Error) {
  const blocks: Probe[][] = [];
  const probes: Probe[] = [];
  let requests = 0;
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }: { method: string; params: readonly unknown[] }) {
        if (method !== 'eth_simulateV1') throw new Error(`unexpected ${method}`);
        requests++;
        if (transportError) throw transportError;
        const [{ blockStateCalls }, block] = params as [{ blockStateCalls: { calls: Probe[] }[] }, string];
        return blockStateCalls.map((b, blockIndex) => {
          const recorded = b.calls.map((c) => ({ to: c.to, data: c.data, block }));
          blocks.push(recorded);
          return {
            number: block,
            calls: b.calls.map((c) => {
              if (blockIndex === 0) return ok('0x'); // the replayed batch
              probes.push({ to: c.to, data: c.data, block });
              return outcome(answer(c.data.slice(0, 10), c.to.toLowerCase()));
            }),
          };
        });
      },
    }),
  });
  return { client, blocks, probes, requestCount: () => requests };
}

describe('resolveTokenUnits', () => {
  it('confirms an ERC-721 that viem guessed at decimals 1', async () => {
    const { client, probes } = stubClient(() => word(1));
    const changes = [change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })];

    const units = await resolveTokenUnits(client, changes, BLOCK, BATCH);

    expect(units.erc721).toEqual(new Set([BRZ.toLowerCase()]));
    expect(units.changes).toEqual(changes);
    // A `1` is already a usable unit, so only the interface question goes out.
    expect(probes.map((p) => p.data.slice(0, 10))).toEqual([SUPPORTS_INTERFACE]);
  });

  it('recovers a 0-decimal ERC-20 that viem reported as undefined', async () => {
    const { client } = stubClient((selector) => (selector === SUPPORTS_INTERFACE ? 'revert' : word(0)));
    const changes = [change(ZERO_DEC, 42n, { symbol: 'ZERO' })];

    const units = await resolveTokenUnits(client, changes, BLOCK, BATCH);

    expect(units.erc721.size).toBe(0);
    expect(units.changes[0].token.decimals).toBe(0);
    // Without the recovery the row is dropped outright — a transfer missing from a signing screen.
    expect(mapAssetChanges(units.changes, units.erc721)).toEqual([
      expect.objectContaining({ symbol: 'ZERO', decimals: 0, direction: 'in', amountFormatted: '42' }),
    ]);
    expect(mapAssetChanges(changes)).toEqual([]);
  });

  it('lets ERC-165 outrank a decimals() answer', async () => {
    // A contract can answer both. A confirmed NFT is a count whatever `decimals()` claims.
    const { client } = stubClient((selector) => (selector === SUPPORTS_INTERFACE ? word(1) : word(6)));

    const units = await resolveTokenUnits(client, [change(AERO_POS, 1n, { symbol: 'POS' })], BLOCK, BATCH);

    expect(units.erc721).toEqual(new Set([AERO_POS.toLowerCase()]));
    expect(units.changes[0].token.decimals).toBeUndefined();
  });

  it('asks every question in one request, whatever the candidate count', async () => {
    const { client, probes, requestCount } = stubClient(() => word(1));

    await resolveTokenUnits(
      client,
      [change(AERO_POS, 1n, { symbol: 'POS' }), change(ZERO_DEC, 1n, { symbol: 'ZERO' })],
      BLOCK,
      BATCH
    );

    expect(requestCount()).toBe(1);
    // Two tokens, each asked both questions. Order between the groups is an implementation detail.
    expect(probes).toHaveLength(4);
    expect(new Set(probes.map((p) => p.data.slice(0, 10)))).toEqual(new Set([SUPPORTS_INTERFACE, DECIMALS]));
  });

  it('reads the probes at the block the balances were measured against', async () => {
    const { client, probes } = stubClient(() => word(1));

    await resolveTokenUnits(client, [change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })], BLOCK, BATCH);

    expect(probes.every((p) => p.block === BLOCK_HEX)).toBe(true);
  });

  it('rejects when the request fails, rather than reading that as "not an NFT"', async () => {
    // One failed request must never read as every candidate answering "no" — that would drop
    // NFTs and unreadable-decimals tokens from the preview and show no error for it.
    const { client } = stubClient(() => word(1), new Error('503 Service Unavailable'));

    await expect(resolveTokenUnits(client, [change(BRZ, -1n, { decimals: 1 })], BLOCK, BATCH)).rejects.toThrow();
  });

  it('rejects rather than degrading when the node reverts the probe request wholesale', async () => {
    // The distinction the structural `eth_simulateV1` status exists for. Through N batched
    // `readContract`s this arrived as an `ExecutionRevertedError` per call — the same shape a
    // single token missing `decimals()` produces — so a batch-wide failure read as "every
    // candidate answered no" and silently shortened the asset list.
    const { client } = stubClient(() => word(1), new Error('execution reverted'));

    await expect(
      resolveTokenUnits(client, [change(BRZ, -1n, { decimals: 1 }), change(AERO_POS, 1n, {})], BLOCK, BATCH)
    ).rejects.toThrow();
  });

  it('keeps the rest of the batch when one token answers with junk', async () => {
    // The other direction of the same guard: a per-call failure is local to its call, so a
    // hostile token cannot empty the preview for the assets beside it.
    const huge = `0x${(2n ** 200n).toString(16).padStart(64, '0')}` as const;
    const { client } = stubClient((selector, to) => {
      if (selector === SUPPORTS_INTERFACE) return 'revert';
      return to === ZERO_DEC ? huge : word(0);
    });

    const units = await resolveTokenUnits(
      client,
      [change(ZERO_DEC, 42n, { symbol: 'HUGE' }), change(AERO_POS, 7n, { symbol: 'FINE' })],
      BLOCK,
      BATCH
    );

    expect(units.changes[0].token.decimals).toBeUndefined();
    expect(units.changes[1].token.decimals).toBe(0);
    expect(mapAssetChanges(units.changes, units.erc721)).toEqual([
      expect.objectContaining({ symbol: 'FINE', decimals: 0, amountFormatted: '7' }),
    ]);
  });

  it('reads a decimals() past the safe-integer range as no answer', async () => {
    // viem decodes `uint8` by reading the whole 32-byte word and range-checking it only
    // against `Number.MAX_SAFE_INTEGER`, so a hostile token can throw from *decoding*. That
    // is still the contract answering, and it stays local to its own probe.
    const huge = `0x${(2n ** 200n).toString(16).padStart(64, '0')}` as const;
    const { client } = stubClient((selector) => (selector === SUPPORTS_INTERFACE ? 'revert' : huge));

    const units = await resolveTokenUnits(client, [change(ZERO_DEC, 42n, { symbol: 'HUGE' })], BLOCK, BATCH);

    expect(units.changes[0].token.decimals).toBeUndefined();
    expect(mapAssetChanges(units.changes, units.erc721)).toEqual([]);
  });

  it('reads return data short of a word as no answer', async () => {
    // Not the same shape as `0x`: there are bytes, just not 32 of them.
    const { client } = stubClient(() => `0x${'00'.repeat(16)}` as const);

    const units = await resolveTokenUnits(client, [change(AERO_POS, 1n, { symbol: 'POS' })], BLOCK, BATCH);

    expect(units.erc721.size).toBe(0);
    expect(units.changes[0].token.decimals).toBeUndefined();
  });

  it('reads empty return data as no answer', async () => {
    // A candidate with no code: the call succeeds and returns nothing at all.
    const { client } = stubClient(() => '0x');

    const units = await resolveTokenUnits(client, [change(AERO_POS, 1n, { symbol: 'POS' })], BLOCK, BATCH);

    expect(units.erc721.size).toBe(0);
    expect(units.changes[0].token.decimals).toBeUndefined();
  });

  it('reads a reverted probe as no answer', async () => {
    const { client } = stubClient(() => 'revert');
    const changes = [change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })];

    const units = await resolveTokenUnits(client, changes, BLOCK, BATCH);

    expect(units.erc721.size).toBe(0);
    expect(units.changes).toEqual(changes);
  });

  it('reads a non-boolean supportsInterface answer as "not an NFT"', async () => {
    const { client } = stubClient((selector) => (selector === SUPPORTS_INTERFACE ? word(2) : word(6)));

    const units = await resolveTokenUnits(client, [change(AERO_POS, 1n, { symbol: 'POS' })], BLOCK, BATCH);

    expect(units.erc721.size).toBe(0);
    expect(units.changes[0].token.decimals).toBe(6);
  });

  it('probes only what viem could have guessed wrong', async () => {
    const { client, probes } = stubClient(() => 'revert');

    await resolveTokenUnits(
      client,
      [
        change(USDC, 5n, { decimals: 6, symbol: 'USDC' }), // readable decimals
        change(BRZ, 0n, { decimals: 1, symbol: 'BRZ' }), // ambiguous, but the batch left it alone
        change(ethAddress, 5n, {}), // native is measured directly, never probed
        change(AERO_POS, 1n, { decimals: 1, symbol: 'POS' }), // the only suspect
      ],
      BLOCK,
      BATCH
    );

    expect(probes.map((p) => p.to.toLowerCase())).toEqual([AERO_POS.toLowerCase()]);
  });

  it('treats decimals 1 as ambiguous and 2 as an answer', async () => {
    // Pins *our* reading of viem's `decimals() ?? 1` fallback, not the fallback itself: the
    // stub answers at the transport and never reaches `simulateCalls`, so nothing here can
    // catch upstream moving that sentinel. Nothing in this suite can. A release inside
    // `^2.55.16` that changed it would silently render every NFT as "0.1" again, which is why
    // `resolveTokenUnits` spells out the expression it depends on.
    const { client, probes } = stubClient(() => 'revert');

    await resolveTokenUnits(
      client,
      [change(BRZ, 1n, { decimals: 1, symbol: 'ONE' }), change(USDC, 1n, { decimals: 2, symbol: 'TWO' })],
      BLOCK,
      BATCH
    );

    expect(probes.map((p) => p.to.toLowerCase())).toEqual([BRZ.toLowerCase()]);
  });

  it('asks for the ERC-721 interface id and no other', async () => {
    // `ERC721_QUERY` is written out in this file rather than re-encoded from the source constant,
    // so changing the interface id under test fails here instead of agreeing with itself.
    const { client, probes } = stubClient(() => 'revert');

    await resolveTokenUnits(client, [change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })], BLOCK, BATCH);

    expect(probes[0].data).toBe(ERC721_QUERY);
  });

  it('replays the batch in the block ahead of the probes', async () => {
    // Why it matters: viem reads its own `decimals`/`tokenURI` after the batch, so a token the
    // batch itself brings into existence answers viem but would revert on a probe against the
    // bare base block — leaving viem's `1` in place and rendering one NFT as "0.1". Still one
    // request; the batch just runs first inside it.
    const { client, blocks, requestCount } = stubClient(() => word(1));

    await resolveTokenUnits(client, [change(BRZ, -1n, { decimals: 1, symbol: 'BRZ' })], BLOCK, BATCH);

    expect(requestCount()).toBe(1);
    expect(blocks.map((b) => b.map((c) => c.data))).toEqual([[BATCH_CALLDATA], [ERC721_QUERY]]);
  });

  it('asks nothing when every token reported readable decimals', async () => {
    const { client, requestCount } = stubClient(() => word(1));
    const changes = [change(USDC, 5n, { decimals: 6, symbol: 'USDC' })];

    const units = await resolveTokenUnits(client, changes, BLOCK, BATCH);

    expect(requestCount()).toBe(0);
    expect(units.changes).toEqual(changes);
    expect(units.erc721.size).toBe(0);
  });
});

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ETH_BALANCE = word(10n ** 18n);

/**
 * Drives one whole `simulateAssetChanges` against a fake node, so the wiring between
 * `getBlockNumber`, viem's `traceAssetChanges` and `resolveTokenUnits` is covered rather than
 * assumed. The three `eth_simulateV1` requests are answered by ordinal: viem's log discovery,
 * viem's balance measurement (six blocks: batch, ETH post, asset post, decimals, tokenURI,
 * symbol — see `simulateCalls.js` upstream), then ours.
 *
 * The fixture is one ERC-721 the batch itself deploys, with a reverting `decimals()` and an
 * answering `tokenURI` — the shape viem hands back as `decimals: 1`, which the preview must
 * render as a count. Because it has no code at the base block, it answers our ERC-165 probe only
 * when the batch was replayed ahead of it in the same request; a probe block on its own gets
 * nothing, which is what rendered one NFT as "0.1".
 *
 * Answers are keyed off the exact calldata, not just "request 3", so a probe asking the wrong
 * question — a different interface id, the two probe groups swapped — fails here.
 */
function stubNode({ batchReverts = false, senderRejected = false } = {}) {
  const blockParams: unknown[] = [];
  let blockNumberCalls = 0;
  let simulations = 0;
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }: { method: string; params: readonly unknown[] }) {
        if (method === 'eth_blockNumber') {
          blockNumberCalls++;
          return BLOCK_HEX;
        }
        // viem's pre-balance probes: the ETH one carries no `to`, the token one targets its
        // deployed staticcall helper. Both must return a word to count as a balance.
        if (method === 'eth_call') {
          const [request] = params as [{ to?: Address }];
          return request.to === undefined ? ETH_BALANCE : word(0);
        }
        if (method !== 'eth_simulateV1') throw new Error(`unexpected ${method}`);
        const [{ blockStateCalls }, block] = params as [{ blockStateCalls: { calls: unknown[] }[] }, string];
        blockParams.push(block);
        simulations++;

        // ADI's node, for a sender that has code: every call is refused before it runs (EIP-3607),
        // reported per call as a failure that spent no gas and returned no data.
        if (senderRejected && simulations <= 2)
          return blockStateCalls.map((b) => ({ number: block, calls: b.calls.map(() => failed()) }));

        if (simulations === 1)
          return [
            {
              number: block,
              calls: [
                {
                  ...ok('0x'),
                  logs: [
                    {
                      address: AERO_POS,
                      topics: [TRANSFER_TOPIC, pad(zeroAddress), pad(ACCOUNT)],
                      data: word(1),
                    },
                  ],
                },
              ],
            },
          ];

        if (simulations === 2) {
          const batch = batchReverts
            ? [revertWith('ERC20: transfer amount exceeds balance'), ok('0x')]
            : [ok('0x'), ok('0x')];
          return [
            { number: block, calls: batch },
            { number: block, calls: [ok(ETH_BALANCE)] }, // ETH post, unchanged, so no ETH row
            { number: block, calls: [ok(word(1))] }, // NFT count post: 0 -> 1
            { number: block, calls: [failed()] }, // decimals() reverts
            { number: block, calls: [ok(str('ipfs://1'))] }, // ...but tokenURI answers
            { number: block, calls: [ok(str('PUNK'))] },
          ];
        }

        // Ours: [batch replay, metadata probes]. A single block means the probes ran with nothing
        // ahead of them, so the fixture's contract is not yet deployed and cannot answer.
        const probeBlock = blockStateCalls.length - 1;
        return blockStateCalls.map((b, i) => ({
          number: block,
          calls: b.calls.map((c) => {
            if (i !== probeBlock) return ok('0x'); // the replayed batch
            if (blockStateCalls.length === 1) return failed(); // no code at the base block
            return (c as { data: Hex }).data === ERC721_QUERY ? ok(word(1)) : failed();
          }),
        }));
      },
    }),
  });
  publicClient.current = client;
  return { blockParams, blockNumberCalls: () => blockNumberCalls, simulations: () => simulations };
}

describe('simulateAssetChanges', () => {
  const calls = [{ to: AERO_POS as Address, data: '0x12345678' as Hex }];

  it('renders an ERC-721 the batch deploys as a whole-token count, not "0.1"', async () => {
    const node = stubNode();

    const result = await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    expect(result.willRevert).toBe(false);
    expect(result.deltas).toEqual([
      expect.objectContaining({ symbol: 'PUNK', decimals: 0, direction: 'in', amountFormatted: '1', isNative: false }),
    ]);
    // Discovery, measurement, metadata. Two of those exist only because `traceAssetChanges` is
    // on — without it viem returns no `assetChanges` and this preview is silently empty.
    expect(node.simulations()).toBe(3);
  });

  it('pins every simulation and probe to one block, resolved once', async () => {
    const node = stubNode();

    await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    expect(node.blockParams).toEqual([BLOCK_HEX, BLOCK_HEX, BLOCK_HEX]);
    // Ours is the only one: handing viem the number stops it resolving its own, and the metadata
    // probes reuse it instead of reading `latest` a block or two later.
    expect(node.blockNumberCalls()).toBe(1);
  });

  it('reports a reverting batch instead of an asset list, and stops probing', async () => {
    const node = stubNode({ batchReverts: true });

    const result = await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    expect(result).toMatchObject({ willRevert: true, deltas: [], revertCause: 'balance' });
    expect(node.simulations()).toBe(2);
  });

  it('rejects, rather than reporting a revert, when the node refused to run the batch', async () => {
    stubNode({ senderRejected: true });

    // Nothing executed, so nothing is known about whether the batch lands. Reading this as a
    // revert put "likely to fail" on every transaction from a deployed account on ADI.
    await expect(simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls })).rejects.toThrow(
      /refused to execute/
    );
  });
});

const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const APPROVE = '0x095ea7b3' as Hex;
const SWAP = '0x5ae401dc' as Hex;
// `Approval(address,address,uint256)`. Emitted by the approve leg and ignored by discovery:
// only a `Transfer` naming the account makes a token a candidate.
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

/** The token a `query(address,bytes)` probe names, read out of the first word of its calldata. */
const staticTarget = (data: Hex) => `0x${data.slice(34, 74)}`.toLowerCase();

const SWAP_TOKENS: Record<string, { post: Outcome; decimals: Outcome; tokenURI: Outcome; symbol: Outcome }> = {
  [USDC.toLowerCase()]: { post: word(0), decimals: word(6), tokenURI: 'revert', symbol: str('USDC') },
  // `decimals()` answers 0 and `tokenURI` reverts, so viem's `tokenURI_ || decimals_` guard
  // reads the `0n` as falsy and reports `undefined`, so the row vanishes unless it is recovered.
  [ZERO_DEC]: { post: word(42), decimals: word(0), tokenURI: 'revert', symbol: str('ZERO') },
};
const SWAP_PRE: Record<string, Hex> = { [USDC.toLowerCase()]: word(100_000_000), [ZERO_DEC]: word(0) };

/**
 * The batch this change exists for: an `approve` and a swap that only clears *because* of it.
 * Before viem 2.55.16 discovery probed each call on its own against current state, so the swap
 * reverted at the allowance check, which lost the token it pays out and took the preview with it.
 *
 * Three candidates come out of it: USDC (spent, and readable, so nothing probes it), a 0-decimal
 * ERC-20 (received, and the shape viem reports as `decimals: undefined`), and the router, which
 * viem adds for being a call target and which has to fall out for having no `balanceOf`.
 *
 * Answers are keyed off the token each probe names rather than its slot in viem's candidate list,
 * so the fixture does not quietly freeze an ordering upstream is free to change. `sims` records
 * the calldata of every block of every request, which is what makes "both calls got through"
 * assertable at each of the three places the batch is handed over.
 */
function stubSwapNode({ swapReverts = false } = {}) {
  const sims: (Hex | undefined)[][][] = [];
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }: { method: string; params: readonly unknown[] }) {
        if (method === 'eth_blockNumber') return BLOCK_HEX;
        if (method === 'eth_call') {
          const [request] = params as [{ to?: Address; data: Hex }];
          if (request.to === undefined) return ETH_BALANCE;
          // The router has no `balanceOf`; empty data is not a balance, so it never becomes a row.
          return SWAP_PRE[staticTarget(request.data)] ?? '0x';
        }
        if (method !== 'eth_simulateV1') throw new Error(`unexpected ${method}`);
        const [{ blockStateCalls }, block] = params as [{ blockStateCalls: { calls: { data?: Hex }[] }[] }, string];
        sims.push(blockStateCalls.map((b) => b.calls.map((c) => c.data)));
        const probes = (calls: { data?: Hex }[], field: 'post' | 'decimals' | 'tokenURI' | 'symbol') =>
          calls.map((c) => outcome(SWAP_TOKENS[staticTarget(c.data as Hex)]?.[field] ?? 'revert'));

        if (sims.length === 1)
          return [
            {
              number: block,
              calls: [
                {
                  ...ok('0x'),
                  logs: [{ address: USDC, topics: [APPROVAL_TOPIC, pad(ACCOUNT), pad(ROUTER)], data: word(0) }],
                },
                {
                  ...ok('0x'),
                  logs: [
                    { address: USDC, topics: [TRANSFER_TOPIC, pad(ACCOUNT), pad(ROUTER)], data: word(100_000_000) },
                    { address: ZERO_DEC, topics: [TRANSFER_TOPIC, pad(ROUTER), pad(ACCOUNT)], data: word(42) },
                  ],
                },
              ],
            },
          ];

        if (sims.length === 2)
          return [
            // The batch, plus the sentinel call viem appends and slices back off.
            { number: block, calls: [ok('0x'), swapReverts ? revertWith('Too little received') : ok('0x'), ok('0x')] },
            { number: block, calls: [ok(ETH_BALANCE)] }, // ETH post, unchanged, so no ETH row
            { number: block, calls: probes(blockStateCalls[2].calls, 'post') },
            { number: block, calls: probes(blockStateCalls[3].calls, 'decimals') },
            { number: block, calls: probes(blockStateCalls[4].calls, 'tokenURI') },
            { number: block, calls: probes(blockStateCalls[5].calls, 'symbol') },
          ];

        // Ours: [batch replay, metadata probes]. Only the 0-decimal token is a suspect.
        return blockStateCalls.map((b, i) => ({
          number: block,
          calls: b.calls.map((c) => (i === 0 ? ok('0x') : c.data === ERC721_QUERY ? failed() : ok(word(0)))),
        }));
      },
    }),
  });
  publicClient.current = client;
  return { sims };
}

describe('simulateAssetChanges — dependent batch', () => {
  const calls = [
    { to: USDC as Address, data: APPROVE },
    { to: ROUTER as Address, data: SWAP },
  ];

  it('reports both legs of an approve-then-swap, and drops the router', async () => {
    stubSwapNode();

    const result = await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    expect(result.willRevert).toBe(false);
    expect(result.deltas).toEqual([
      expect.objectContaining({ symbol: 'USDC', decimals: 6, direction: 'out', amountFormatted: '100' }),
      // Recovered: viem reported this one as `decimals: undefined`, which drops the row outright.
      expect.objectContaining({ symbol: 'ZERO', decimals: 0, direction: 'in', amountFormatted: '42' }),
    ]);
    // The router emitted a log and is a call target, so viem measures it, but it answers no
    // `balanceOf`, and a candidate without a balance must not reach the screen as a row.
    expect(result.deltas.map((d) => d.address.toLowerCase())).not.toContain(ROUTER);
  });

  it('hands the whole batch to every simulation, not just its first call', async () => {
    const node = stubSwapNode();

    await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    const [discovery, measurement, metadata] = node.sims;
    expect(discovery[0]).toEqual([APPROVE, SWAP]);
    expect(measurement[0]).toEqual([APPROVE, SWAP, undefined]);
    // The replay is the reason the probes see post-batch state; a partial replay is a different
    // chain state than the one the amounts were measured against.
    expect(metadata[0]).toEqual([APPROVE, SWAP]);
  });

  it('reports a revert in a later call, not only in the first', async () => {
    const node = stubSwapNode({ swapReverts: true });

    const result = await simulateAssetChanges({ chainId: base.id, account: ACCOUNT, calls });

    // The approve succeeds; reading only the first result would call this batch healthy and
    // hand the user an asset list for a transaction that cannot land.
    expect(result).toMatchObject({ willRevert: true, deltas: [], revertCause: 'other' });
    expect(node.sims).toHaveLength(2);
  });
});

describe('formatAssetAmount', () => {
  it('caps display at 4 decimals', () => {
    expect(formatAssetAmount('1.23456789')).toBe('1.2346');
  });

  it('keeps large amounts out of scientific notation and ungrouped', () => {
    expect(formatAssetAmount('1000000000000')).toBe('1000000000000');
  });

  it('goes approximate past 2^53 — `Number` is the ceiling on this path', () => {
    // Recorded, not endorsed: the input is a `formatUnits` string but it is parsed with
    // `Number`, so a quadrillion-supply token renders with the tail zeroed. Fixing it means
    // formatting from the string's own digits (with carry) instead of via a double.
    expect(formatAssetAmount('123456789012345678901234.5678')).toBe('123456789012345690000000');
  });

  it('floors sub-0.0001 dust to a subscript form instead of "0"', () => {
    expect(formatAssetAmount('0.000000123')).toBe('0.0₆123');
  });

  it('leaves a plain zero alone', () => {
    expect(formatAssetAmount('0')).toBe('0');
  });
});
