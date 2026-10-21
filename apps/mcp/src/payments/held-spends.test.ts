import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { ChainClients } from '@jaw.id/agent';
import type { Address, Hex, PublicClient } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { chainView, heldSpends, noteCallsId, recordSend } from './sends';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CALLS = `0x${'ab'.repeat(32)}` as Hex;
const TX = `0x${'cd'.repeat(32)}` as Hex;

setTestEnv();

let client: PGlite;
beforeAll(async () => {
  client = await useTestDb();
});

/** An open execute of 0.25 USDC under a fresh grant, with its userOp hash noted. */
async function openRun() {
  const connectionId = `con_${randomUUID()}`;
  const permissionId = `0x${randomUUID().replaceAll('-', '').repeat(2)}`;
  await getDb()
    .insert(connections)
    .values({
      id: connectionId,
      status: 'active',
      account: ACCOUNT,
      chainId: 8453,
      clientId: 'client',
      clientName: 'client',
      scopes: ['wallet:read'],
      interactionUid: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: randomUUID(),
      activatedAt: new Date(),
    });
  const id = await getDb().transaction(async (tx) => {
    const id = await recordSend(tx, {
      connectionId,
      idempotencyKey: 'k',
      requestHash: 'h',
      permissionId,
      chainId: 8453,
      sender: ACCOUNT,
      token: USDC,
      amount: 250_000n,
      periodStart: Math.floor(Date.now() / 1000),
      fromBlock: 90n,
    });
    await noteCallsId(tx, [id], CALLS);
    return id;
  });
  return { connectionId, permissionId, id };
}

const node = {
  getBlockNumber: async () => 100n,
  getLogs: async () => [{ args: { userOpHash: CALLS, success: true }, transactionHash: TX }],
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

describe('held spends', () => {
  it('given the stored grant id, then the read holding the float lock looks the runs up by the permission index', async () => {
    const { permissionId } = await openRun();
    const query = vi.spyOn(client, 'query');
    await heldSpends(permissionId, getDb());
    const [text, params] = query.mock.calls.find(([q]) => q.includes('"sends"'))!;
    query.mockRestore();

    await client.exec('set enable_seqscan = off');
    const plan = await client.query<{ 'QUERY PLAN': string }>(`explain ${text}`, params);
    await client.exec('reset enable_seqscan');

    const shown = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(shown).toContain('sends_permission_id_created_at_index');
    expect(shown).toMatch(/Index Cond: .*permission_id = /);
  });

  it('given the stored grant id, then the open run is held', async () => {
    const { permissionId } = await openRun();

    const held = await heldSpends(permissionId, getDb());

    expect(held).toEqual([{ token: USDC.toLowerCase(), amount: 250_000n, periodStart: expect.any(Number) }]);
  });

  it('given a grant id in another case than the stored one, then the chain view still sees the run land', async () => {
    const { connectionId, permissionId, id } = await openRun();

    const view = await chainView(connectionId, `0x${permissionId.slice(2).toUpperCase()}`, 8453, clients);

    expect(view?.seen).toEqual(new Set([id]));
    expect(view?.ends).toEqual([{ id, end: { state: 'landed', txHash: TX } }]);
  });
});
