import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getAddress, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { replayingPage, stallsAfter, startRelay } from '@/connections/fake-relay';
import { connect, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { resumeSwaps, swap, swapStatus, type SwapToolInput } from '@/tools/swap';
import { swapRequest } from './quote';
import { claimSwap, SEND_STARTED, writeHeld } from './store';

const relay = await startRelay();
setTestEnv();
process.env.JAW_RELAY_URL = relay.url;
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterAll(() => relay.close());

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const input: SwapToolInput = {
  originChainId: 84532,
  originToken: USDC,
  destinationChainId: 42161,
  destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  amount: '1000000',
};

const rowOf = async (id: string) => (await getDb().select().from(swaps).where(eq(swaps.id, id)))[0];
const lapse = (id: string) => getDb().update(swaps).set({ sessionUntil: null }).where(eq(swaps.id, id));
const quiet = () => new Promise((r) => setTimeout(r, 300));

async function quoted(t: Tenant, key: string) {
  const claim = await claimSwap(t.connectionId, key, swapRequest(t, { ...input, originToken: USDC }));
  if (claim.kind !== 'run') throw new Error(`claimed ${claim.kind}`);
  const deposit = getAddress(`0x${randomBytes(20).toString('hex')}`);
  await writeHeld(
    { connectionId: t.connectionId, id: claim.row.id, token: claim.token },
    {
      quoteId: `aurora:${deposit}`,
      depositAddress: deposit,
      quote: { inputAmount: '1000000', expectedOutputAmount: '990000', minOutputAmount: '980000' },
      call: { chainId: 84532, to: USDC, data: '0xa9059cbb', value: '0' },
      paidAt: new Date(),
      leaseUntil: sql`statement_timestamp()`,
    }
  );
  return claim.row.id;
}

async function depositAskedThenRestarted({ stallAt = 2, approved = false } = {}) {
  const c = await connect(owner());
  await walletsSettled();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const key = `k_${randomBytes(4).toString('hex')}`;
  const id = await quoted(t, key);
  let decide!: () => void;
  const decided = new Promise<void>((r) => (decide = r));
  const server = stallsAfter(stallAt);
  const first = await swap(t, { ...input, idempotencyKey: key }, { openWallet: server.openWallet, pollMs: 0 });
  const page = await replayingPage(first.structuredContent!.url!, async (method) => {
    if (method === 'eth_requestAccounts') return [t.account];
    if (method === 'wallet_getCallsStatus') return { status: 400 };
    await decided;
    return { id: '0xcalls' };
  });
  if (approved) decide();
  await vi.waitFor(() => expect(page.ids).toHaveLength(stallAt));
  await lapse(id);
  return { t, id, quoteId: first.structuredContent!.quoteId!, page, decide };
}

describe('a swap deposit whose server restarted after the send started', () => {
  it.each(['while the server was down', 'after the server rejoined'])(
    'given the page is still open, when the owner approves %s, then a status read resumes it and the row records the calls id',
    async (when) => {
      const { t, id, quoteId, page, decide } = await depositAskedThenRestarted();
      expect(await rowOf(id)).toMatchObject({ code: SEND_STARTED, relay: expect.any(String) });
      if (when === 'while the server was down') decide();

      await swapStatus(t, { quoteId });
      await vi.waitFor(() => expect(page.ids.length).toBeGreaterThanOrEqual(4));
      decide();

      await vi.waitFor(
        async () => expect(await rowOf(id)).toMatchObject({ state: 'deposit_sent', callsId: '0xcalls' }),
        {
          timeout: 10_000,
        }
      );
      expect((await rowOf(id)).relay).toBeNull();
      expect(page.ids.slice(2, 4)).toEqual(page.ids.slice(0, 2));
      expect(page.asked()).toBe(3);
    }
  );

  it('given the calls id was recorded and the wallet was being polled, when the server restarts, then nothing is asked again', async () => {
    const { id, page } = await depositAskedThenRestarted({ stallAt: 3, approved: true });
    expect(await rowOf(id)).toMatchObject({ state: 'deposit_sent', relay: null });

    await resumeSwaps();
    await quiet();

    expect(page.ids).toHaveLength(3);
  });
});
