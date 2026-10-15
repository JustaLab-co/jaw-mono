import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { fakeChain, type FakeEvent } from './chain-testkit';
import type { OwnerCallRow } from './store';
import { findUserOpEvent, readReceipt, receiptOf } from './receipt';

setTestEnv();

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'ef'.repeat(32)}`;

function rpc(answer: () => Response | Promise<Response>) {
  const seen: { url: string; body: { method: string; params: unknown[] } }[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return answer();
  });
  return seen;
}

const result = (value: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result: value });

afterEach(() => vi.unstubAllGlobals());

describe('readReceipt', () => {
  it('posts JSON to the bundler', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal('fetch', async (_url: string, i: RequestInit) => {
      init = i;
      return result(null);
    });

    await readReceipt(8453, CALLS_ID);

    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('given a mined user operation, then it asks the bundler on that chain and returns success and the hash', async () => {
    const seen = rpc(() => result({ success: true, receipt: { transactionHash: TX } }));

    expect(await readReceipt(8453, CALLS_ID)).toEqual({ success: true, txHash: TX });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('chainId=8453');
    expect(seen[0].body).toMatchObject({ method: 'eth_getUserOperationReceipt', params: [CALLS_ID] });
  });

  it('given a reverted user operation, then success is false and the hash is kept', async () => {
    rpc(() => result({ success: false, receipt: { transactionHash: TX } }));

    expect(await readReceipt(8453, CALLS_ID)).toEqual({ success: false, txHash: TX });
  });

  it('given no receipt yet, then it returns null', async () => {
    rpc(() => result(null));

    expect(await readReceipt(8453, CALLS_ID)).toBeNull();
  });

  it.each([
    ['a receipt with no transaction hash', { success: true, receipt: {} }],
    ['a receipt with a malformed hash', { success: true, receipt: { transactionHash: '0x12' } }],
    ['a receipt with no success flag', { receipt: { transactionHash: TX } }],
    ['a receipt that is not an object', 'mined'],
  ])('given %s, then the RPC is unreadable', async (_name, value) => {
    rpc(() => result(value));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow();
  });

  it('given a JSON-RPC error, then it throws', async () => {
    rpc(() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow();
  });

  it('given an HTTP failure, then it throws', async () => {
    rpc(() => new Response('bad gateway', { status: 502 }));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow();
  });

  it('given an HTTP failure with a JSON body that says no receipt, then it throws instead of reading as pending', async () => {
    rpc(() => Response.json({ jsonrpc: '2.0', id: 1, result: null }, { status: 502 }));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow('502');
  });

  it('given any read, then the request ends after ten seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
      signals.push(init.signal);
      return result(null);
    });

    try {
      await readReceipt(8453, CALLS_ID);

      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(signals).toEqual([timeout.mock.results[0].value]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('given an answer that is not JSON, then it throws', async () => {
    rpc(() => new Response('<html>', { status: 200 }));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow();
  });
});

const event = (block: bigint, over: Partial<FakeEvent> = {}): FakeEvent => ({
  userOpHash: CALLS_ID as `0x${string}`,
  block,
  txHash: TX as `0x${string}`,
  success: true,
  ...over,
});

describe('findUserOpEvent', () => {
  it('given a successful event, then it returns success and the transaction of the log', async () => {
    const { clients } = fakeChain({ head: 10_000n, events: [event(9_500n)] });

    expect(await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 9_000n)).toEqual({
      success: true,
      txHash: TX,
    });
  });

  it('given an event whose user operation reverted, then success is false', async () => {
    const { clients } = fakeChain({ head: 10_000n, events: [event(9_500n, { success: false })] });

    expect(await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 9_000n)).toMatchObject({ success: false });
  });

  it('given events of other operations only, then it returns null', async () => {
    const other = event(9_500n, { userOpHash: `0x${'01'.repeat(32)}` });
    const { clients } = fakeChain({ head: 10_000n, events: [other] });

    expect(await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 9_000n)).toBeNull();
  });

  it('given a range wider than one chunk, then it finds an event in a later chunk and reads each block once', async () => {
    const { clients, ranges } = fakeChain({ head: 10_000n, events: [event(1_450n)] });

    const found = await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 1_000n);

    expect(found).toEqual({ success: true, txHash: TX });
    expect(ranges).toEqual([
      { from: 1_000n, to: 1_199n },
      { from: 1_200n, to: 1_399n },
      { from: 1_400n, to: 1_599n },
    ]);
  });

  it('given no event for a long range, then one call reads at most fifty chunks and ends before the head', async () => {
    const { clients, ranges } = fakeChain({ head: 1_000_000n });

    expect(await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 1_000n)).toBeNull();
    expect(ranges).toHaveLength(50);
    expect(ranges[49].to).toBe(10_999n);
  });

  it('given a range that ends at the head, then the last chunk stops at the head', async () => {
    const { clients, ranges } = fakeChain({ head: 1_350n });

    await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 1_000n);

    expect(ranges).toEqual([
      { from: 1_000n, to: 1_199n },
      { from: 1_200n, to: 1_350n },
    ]);
  });

  it('given a start past the head, then it reads no logs', async () => {
    const { clients, ranges } = fakeChain({ head: 100n });

    expect(await findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 101n)).toBeNull();
    expect(ranges).toEqual([]);
  });

  it('given a node that cannot be read, then it throws', async () => {
    const { clients } = fakeChain({ head: 10_000n, down: true });

    await expect(findUserOpEvent(clients, 84532, CALLS_ID as `0x${string}`, 9_000n)).rejects.toThrow();
  });
});

describe('receiptOf', () => {
  const NOW = Date.UTC(2026, 0, 1, 12);
  const row = (over: Partial<OwnerCallRow> = {}) =>
    ({
      chainId: 84532,
      callsId: CALLS_ID,
      sentBlock: 9_000n,
      updatedAt: new Date(NOW - 30 * 60_000),
      ...over,
    }) as OwnerCallRow;
  const none = async () => null;

  it('given a bundler receipt, then it is returned and the chain is not read', async () => {
    const { clients, ranges } = fakeChain({
      head: 10_000n,
      events: [event(9_500n, { txHash: OTHER_TX as `0x${string}` })],
    });

    const got = await receiptOf(row(), async () => ({ success: true, txHash: TX }), clients, NOW);

    expect(got).toEqual({ success: true, txHash: TX });
    expect(ranges).toEqual([]);
  });

  it('given no bundler receipt and a row past ten minutes, then the event on chain settles it', async () => {
    const { clients } = fakeChain({ head: 10_000n, events: [event(9_500n)] });

    expect(await receiptOf(row(), none, clients, NOW)).toEqual({ success: true, txHash: TX });
  });

  it('given no bundler receipt and a row under ten minutes, then the chain is not read', async () => {
    const { clients, ranges } = fakeChain({ head: 10_000n, events: [event(9_500n)] });

    expect(await receiptOf(row({ updatedAt: new Date(NOW - 9 * 60_000) }), none, clients, NOW)).toBeNull();
    expect(ranges).toEqual([]);
  });

  it('given the operation mined a few blocks before the recorded head, then it is still found', async () => {
    const { clients } = fakeChain({ head: 10_000n, events: [event(8_950n)] });

    expect(await receiptOf(row(), none, clients, NOW)).toEqual({ success: true, txHash: TX });
  });

  it('given a recorded head, then the search starts a margin before it and never at genesis', async () => {
    const { clients, ranges } = fakeChain({ head: 10_000n });

    await receiptOf(row(), none, clients, NOW);

    expect(ranges[0].from).toBe(8_900n);
  });

  it('given no recorded head, then the search starts from the age of the row in blocks with a margin', async () => {
    const { clients, ranges } = fakeChain({ head: 100_000n, blockSeconds: 2 });

    await receiptOf(row({ sentBlock: null }), none, clients, NOW);

    // 30 minutes at 2s per block is 900 blocks; 20% more and a 100 block margin.
    expect(ranges[0].from).toBe(100_000n - 900n - 180n - 100n);
  });

  it('given no recorded head and an event within that window, then it is found', async () => {
    const { clients } = fakeChain({ head: 100_000n, events: [event(99_300n)] });

    expect(await receiptOf(row({ sentBlock: null }), none, clients, NOW)).toEqual({ success: true, txHash: TX });
  });

  it('given a node that cannot be read, then it throws', async () => {
    const { clients } = fakeChain({ head: 10_000n, down: true });

    await expect(receiptOf(row(), none, clients, NOW)).rejects.toThrow();
  });
});
