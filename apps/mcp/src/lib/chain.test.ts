import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { owner, setTestEnv } from '@/connections/testkit';

let down = false;
let silentBlockNumber = false;
const node = createServer(async (req, res) => {
  if (down) return void req.socket.destroy();
  let body = '';
  for await (const chunk of req) body += chunk;
  const { id, method } = JSON.parse(body);
  if (silentBlockNumber && method === 'eth_blockNumber') return;
  const result = method === 'eth_blockNumber' ? '0x1' : `0x${'0'.repeat(64)}`;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
await new Promise<void>((r) => node.listen(0, '127.0.0.1', r));
afterAll(() => {
  node.closeAllConnections();
  node.close();
});

setTestEnv();
process.env.JAW_MCP_RPC_URL = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
const { publicClientFor, verifyOnChain } = await import('./chain');

describe('publicClientFor', () => {
  it('builds a client for the chain the signature was made on, not the configured one', () => {
    expect(publicClientFor(8453).chain?.id).toBe(8453);
    expect(publicClientFor(84532).chain?.id).toBe(84532);
  });

  it('refuses a chain the server does not support', () => {
    expect(() => publicClientFor(1)).toThrow('not supported');
  });
});

describe('verifyOnChain', () => {
  const malformed = {
    chainId: 84532,
    address: owner().address,
    payload: { type: 'message' as const, message: 'hello' },
    signature: `0x${'11'.repeat(65)}` as const,
  };

  it('given a node that answers, when a malformed signature is checked, then it resolves false', async () => {
    down = false;
    await expect(verifyOnChain(malformed)).resolves.toBe(false);
  });

  it('given the node unreachable, when a signature it cannot recover locally is checked, then it rejects', async () => {
    down = true;
    await expect(verifyOnChain(malformed)).rejects.toThrow();
  }, 20_000);

  it('given a node that answers the verify and never the block number, when a malformed signature is checked, then it rejects within the probe bound', async () => {
    down = false;
    silentBlockNumber = true;
    const started = Date.now();
    try {
      await expect(verifyOnChain(malformed)).rejects.toThrow();
    } finally {
      silentBlockNumber = false;
    }
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 6_000);
});
