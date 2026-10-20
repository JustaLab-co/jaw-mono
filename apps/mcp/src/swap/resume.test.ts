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
import { swap, swapStatus, type SwapToolInput } from '@/tools/swap';
import { resumeSwaps } from './resume';
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

async function depositAskedThenRestarted({ stallAt = 2, approved = false, declines = false } = {}) {
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
    if (declines) throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    return { id: '0xcalls' };
  });
  if (approved) decide();
  await vi.waitFor(() => expect(page.ids).toHaveLength(stallAt));
  await lapse(id);
  return {
    t,
    id,
    key,
    url: first.structuredContent!.url!,
    quoteId: first.structuredContent!.quoteId!,
    page,
    server,
    decide,
  };
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
      await vi.waitFor(() => expect(page.asked()).toBe(3));
    }
  );

  it('given a resumer took the swap, when the old process hears the calls id first, then the swap records it', async () => {
    const { id, page, server } = await depositAskedThenRestarted();
    await resumeSwaps();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(undefined, { id: '0xcalls' });

    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ state: 'deposit_sent', callsId: '0xcalls' }));
  });

  it('given the owner declined the deposit, then nothing is stored to resume', async () => {
    const { id, page, decide } = await depositAskedThenRestarted({ declines: true });
    await resumeSwaps();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));
    decide();

    await vi.waitFor(async () => expect((await rowOf(id)).state).toBe('owner_declined'));
    await quiet();

    expect((await rowOf(id)).relay).toBeNull();
  });

  it('given a swap whose window passed while it waited for a resume, when the same key comes, then it is expired with nothing stored to resume', async () => {
    const { t, id, key } = await depositAskedThenRestarted();
    await getDb().execute(sql`alter table swaps disable trigger swaps_guard`);
    await getDb()
      .update(swaps)
      .set({ approveBy: sql`statement_timestamp() - interval '1 minute'` })
      .where(eq(swaps.id, id));
    await getDb().execute(sql`alter table swaps enable trigger swaps_guard`);

    await swap(t, { ...input, idempotencyKey: key }, { openWallet: stallsAfter(9).openWallet, pollMs: 0 });

    expect(await rowOf(id)).toMatchObject({ state: 'expired', relay: null });
  });

  it('given the page was closed, when the server rejoins, then the swap keeps the may-have-sent marker and nothing is stored to resume', async () => {
    const { id, page, url } = await depositAskedThenRestarted();
    page.close();
    await vi.waitFor(() =>
      expect(relay.sessions.get(new URL(url).searchParams.get('session')!)?.browser).toBeUndefined()
    );

    await Promise.all(await resumeSwaps());

    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED, relay: null });
  });

  it('given the resumed deposit is refused as another request under its id, then the swap keeps the may-have-sent marker and nothing is stored to resume', async () => {
    const { id, page } = await depositAskedThenRestarted();
    await getDb().execute(sql`alter table swaps disable trigger swaps_guard`);
    await getDb()
      .update(swaps)
      .set({ call: { chainId: 84532, to: USDC, data: '0xa9059cbb00', value: '0' } })
      .where(eq(swaps.id, id));
    await getDb().execute(sql`alter table swaps enable trigger swaps_guard`);

    await Promise.all(await resumeSwaps());

    await vi.waitFor(async () => expect((await rowOf(id)).relay).toBeNull());
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
    expect(page.asked()).toBe(2);
  });

  it('given the calls id was recorded and the wallet was being polled, when the server restarts, then nothing is asked again', async () => {
    const { id, page } = await depositAskedThenRestarted({ stallAt: 3, approved: true });
    expect(await rowOf(id)).toMatchObject({ state: 'deposit_sent', relay: null });

    await resumeSwaps();
    await quiet();

    expect(page.ids).toHaveLength(3);
  });
});
