import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  exportKeyToHex,
  generateKeyPair,
  importKeyFromHex,
  type EncryptedEnvelope,
} from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, swaps } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { CALL_INVALID } from './calls';
import type { SwapRow } from './store';

// A relay that pairs the two roles of a session and forwards what each sends.
const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
const sessions = new Map<string, { cli?: WebSocket; browser?: WebSocket }>();
relay.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'ws://relay');
  const id = url.searchParams.get('session')!;
  const role = url.searchParams.get('role') as 'cli' | 'browser';
  const pair = sessions.get(id) ?? {};
  pair[role] = ws;
  sessions.set(id, pair);
  ws.on('message', (data) => (role === 'cli' ? pair.browser : pair.cli)?.send(String(data)));
});
await new Promise((r) => relay.once('listening', r));

setTestEnv();
process.env.JAW_RELAY_URL = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
const { ownerRelay } = await import('@/connections/relay');
const { approve } = await import('./approve');
beforeAll(useTestDb);
afterAll(() => relay.close());

type Inner = Record<string, unknown>;

/** The cli-bridge page: agrees the key, answers init and each request, and records what it got. */
async function page(link: string, answer: (method: string) => unknown) {
  const url = new URL(link);
  const keys = await generateKeyPair();
  const secret = await deriveSharedSecret(
    keys.privateKey,
    await importKeyFromHex('public', url.hash.slice('#pk='.length))
  );
  const ws = new WebSocket(`${url.searchParams.get('relay')}?session=${url.searchParams.get('session')}&role=browser`);
  const send = async (payload: Inner) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  const received: Inner[] = [];
  const shutdown = new Promise<void>((resolve) => {
    ws.on('message', async (data) => {
      const inner = await decryptMessage(secret, JSON.parse(String(data)) as EncryptedEnvelope);
      received.push(inner);
      if (inner.type === 'init') await send({ type: 'ready' });
      if (inner.type === 'rpc_request')
        await send({ type: 'rpc_response', id: inner.id, success: true, data: answer(String(inner.method)) });
      if (inner.type === 'shutdown') resolve();
    });
  });
  ws.on('open', async () =>
    ws.send(JSON.stringify({ type: 'key_exchange', publicKey: await exportKeyToHex('public', keys.publicKey) }))
  );
  return { received, shutdown };
}

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEPOSIT: Address = '0x3333333333333333333333333333333333333333';

async function awaitingOwner(call: SwapRow['call'], approveBy: Date): Promise<SwapRow> {
  const connectionId = `con_${randomUUID()}`;
  await getDb()
    .insert(connections)
    .values({
      id: connectionId,
      status: 'active',
      account: ACCOUNT,
      chainId: 84532,
      clientId: 'client',
      clientName: 'client',
      scopes: ['x402:pay'],
      interactionUid: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: randomUUID(),
      activatedAt: new Date(),
    });
  const id = `swp_${randomUUID()}`;
  const depositAddress = `0x${randomUUID().replaceAll('-', '')}00000000`;
  const [row] = await getDb()
    .insert(swaps)
    .values({
      id,
      connectionId,
      idempotencyKey: id,
      requestHash: id,
      paymentKey: `swap:${id}:1`,
      leaseHolder: id,
      leaseUntil: new Date(),
      originChainId: 8453,
      originToken: USDC,
      destinationChainId: 42161,
      destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      amount: '1000000',
      depositor: ACCOUNT,
      recipient: ACCOUNT,
      state: 'awaiting_owner',
      quoteId: `aurora:${depositAddress}`,
      depositAddress,
      quote: {},
      quoteFenced: '',
      call,
      quotedAt: new Date(),
      walletUrl: 'https://keys.test/cli-bridge',
      approveBy,
    })
    .returning();
  return row;
}

describe('the owner session for a swap', () => {
  it('B36: given a deposit on another chain, when the owner opens the link, then init is only the connection chain and the deposit asks for the stored call on the origin chain', async () => {
    const approveBy = new Date(Date.now() + 30_000);
    const call = {
      chainId: 8453,
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEPOSIT, 1_000_000n] }),
      value: '0',
    };
    const row = await awaitingOwner(call, approveBy);
    const wallet = await ownerRelay(84532, approveBy);
    const opened = await page(wallet.url, (method) => {
      if (method === 'eth_requestAccounts') return [ACCOUNT];
      if (method === 'wallet_sendCalls') return { id: '0xcalls', chainId: '0x2105' };
      return { status: 400 };
    });

    await wallet.run((ask) => approve(ask, row, ACCOUNT, 0));
    await opened.shutdown;

    const inits = opened.received.filter((m) => m.type === 'init');
    expect(inits).toEqual([{ type: 'init', chainId: 84532, appName: 'JAW MCP' }]);
    const requests = opened.received.filter((m) => m.type === 'rpc_request');
    expect(requests.map((m) => m.method)).toEqual(['eth_requestAccounts', 'wallet_sendCalls', 'wallet_getCallsStatus']);
    expect(requests[1].params).toEqual([
      {
        version: '2.0.0',
        chainId: '0x2105',
        from: ACCOUNT,
        atomicRequired: true,
        calls: [{ to: call.to, data: call.data, value: '0' }],
      },
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/paymaster/i);
  });

  const transfer = {
    chainId: 8453,
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEPOSIT, 1_000_000n] }),
    value: '0',
  };
  const approval = {
    kind: 'approve',
    chainId: 8453,
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DEPOSIT, 1_000_000n] }),
    value: '0',
  };

  async function ownerOpens(call: unknown) {
    const approveBy = new Date(Date.now() + 30_000);
    const row = await awaitingOwner(call as SwapRow['call'], approveBy);
    const wallet = await ownerRelay(84532, approveBy);
    const opened = await page(wallet.url, (method) => {
      if (method === 'eth_requestAccounts') return [ACCOUNT];
      if (method === 'wallet_sendCalls') return { id: `0x${randomUUID().replaceAll('-', '')}`, chainId: '0x2105' };
      return { status: 400 };
    });
    await wallet.run((ask) => approve(ask, row, ACCOUNT, 0));
    await opened.shutdown;
    const [after] = await getDb().select().from(swaps).where(eq(swaps.id, row.id));
    return { requests: opened.received.filter((m) => m.type === 'rpc_request'), after };
  }
  const sendCallsOf = (requests: Inner[]) => requests.find((m) => m.method === 'wallet_sendCalls')?.params;

  it('given a row written before arrays and a row with the same deposit as a one-element array, when the owner opens each link, then both send the same wallet_sendCalls params byte for byte', async () => {
    const legacy = await ownerOpens(transfer);
    const array = await ownerOpens([{ kind: 'deposit', ...transfer }]);

    const expected = [
      {
        version: '2.0.0',
        chainId: '0x2105',
        from: ACCOUNT,
        atomicRequired: true,
        calls: [{ to: USDC, data: transfer.data, value: '0' }],
      },
    ];
    expect(JSON.stringify(sendCallsOf(legacy.requests))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(sendCallsOf(array.requests))).toBe(JSON.stringify(expected));
  });

  it('given a row holding an approve then a deposit, when the owner opens the link, then both calls go in one batch in that order', async () => {
    const { requests } = await ownerOpens([approval, { kind: 'deposit', ...transfer }]);

    expect(sendCallsOf(requests)).toEqual([
      {
        version: '2.0.0',
        chainId: '0x2105',
        from: ACCOUNT,
        atomicRequired: true,
        calls: [
          { to: USDC, data: approval.data, value: '0' },
          { to: USDC, data: transfer.data, value: '0' },
        ],
      },
    ]);
  });

  it.each([
    ['an object without data', { chainId: 8453, to: USDC, value: '0' }],
    ['calls on two chains', [approval, { kind: 'deposit', ...transfer, chainId: 42161 }]],
    ['a deposit then an approve', [{ kind: 'deposit', ...transfer }, approval]],
  ])(
    'given a row whose call is %s, when the owner opens the link, then the wallet is asked nothing and the row is declined',
    async (_, call) => {
      const { requests, after } = await ownerOpens(call);

      expect(requests).toEqual([]);
      expect(after).toMatchObject({ state: 'owner_declined', code: CALL_INVALID, callsId: null });
    }
  );
});
