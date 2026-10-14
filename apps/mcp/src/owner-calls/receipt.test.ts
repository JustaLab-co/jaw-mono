import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { readReceipt } from './receipt';

setTestEnv();

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const TX = `0x${'ab'.repeat(32)}`;

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

  it('given an answer that is not JSON, then it throws', async () => {
    rpc(() => new Response('<html>', { status: 200 }));

    await expect(readReceipt(8453, CALLS_ID)).rejects.toThrow();
  });
});
