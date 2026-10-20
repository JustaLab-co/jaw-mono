import { randomBytes } from 'node:crypto';
import type { ChainClients } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { Ask, Wallet } from '@/connections/relay';
import { connect, fakeWallet, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { sign } from '@/tools/sign';
import { reconcile } from './run';

setTestEnv();

const noChain: ChainClients = {
  publicClient: () => {
    throw new Error('no chain in this test');
  },
};
const noReceipt = async () => null;

const run = () => reconcile(noChain, new Date(), noReceipt);

const signer = owner();
let t: Tenant;
let other: Tenant;
const tenantOf = async (token: string) => (await verifyBearer(token))?.extra?.tenant as Tenant;
beforeAll(async () => {
  await (TEST_PG_URL ? useTestPostgres() : useTestDb());
  t = await tenantOf((await connect(signer)).access_token);
  other = await tenantOf((await connect(signer)).access_token);
});
beforeEach(async () => {
  await getDb().delete(permissionRequests);
});

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);
const randomId = () => `0x${randomBytes(32).toString('hex')}` as Hex;

async function row(over: Partial<typeof permissionRequests.$inferInsert>) {
  const id = `pr_${randomBytes(8).toString('hex')}`;
  await getDb()
    .insert(permissionRequests)
    .values({
      id,
      connectionId: t.connectionId,
      method: 'grant',
      chainId: t.chainId,
      account: t.account,
      walletUrl: `http://keys.test/cli-bridge?${id}`,
      approveBy: secondsFromNow(600),
      sessionUntil: secondsFromNow(20),
      ...over,
    });
  return id;
}

const rowOf = async (id: string) =>
  (await getDb().select().from(permissionRequests).where(eq(permissionRequests.id, id)))[0];

describe('reconciler: owner link requests', () => {
  it('given a link past its window whose server stopped renewing it, when the reconciler runs, then it reads expired with no code', async () => {
    const id = await row({ approveBy: secondsFromNow(-1), sessionUntil: secondsFromNow(-61) });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: null });
  });

  it('given a link past its window whose server still holds it, then it stays for that server to settle', async () => {
    const id = await row({ approveBy: secondsFromNow(-1), sessionUntil: secondsFromNow(20) });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given a waiting link with no lease, as when its server ended without settling, then it reads session_lost', async () => {
    const id = await row({ sessionUntil: null });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given an asked link whose server stopped renewing it over a minute ago, then it reads link_lost', async () => {
    const id = await row({
      method: 'sign',
      idempotencyKey: 'k',
      requestHash: 'h',
      signKind: 'message',
      code: 'asked',
      sessionUntil: secondsFromNow(-61),
    });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: 'link_lost' });
  });

  it('given a grant or revoke link not yet asked whose server stopped renewing it over a minute ago, then both read session_lost', async () => {
    const grant = await row({ sessionUntil: secondsFromNow(-61) });
    const revoke = await row({ method: 'revoke', permissionId: randomId(), sessionUntil: secondsFromNow(-61) });

    await run();

    expect(await rowOf(grant)).toMatchObject({ state: 'expired', code: 'session_lost' });
    expect(await rowOf(revoke)).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given a link whose lease ended seconds ago, as in a database stall, or a held one, then both stay awaiting_owner', async () => {
    const stalled = await row({ sessionUntil: secondsFromNow(-10) });
    const held = await row({ method: 'revoke', permissionId: randomId(), sessionUntil: secondsFromNow(20) });

    await run();

    expect(await rowOf(stalled)).toMatchObject({ state: 'awaiting_owner', code: null });
    expect(await rowOf(held)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given an asked revoke whose server is gone, then it holds until its window ends for other connections, and ends with no code after', async () => {
    const lapsed = {
      method: 'revoke' as const,
      connectionId: other.connectionId,
      code: 'asked',
      sessionUntil: secondsFromNow(-600),
    };
    const inWindow = await row({ ...lapsed, permissionId: randomId() });
    const pastWindow = await row({
      ...lapsed,
      connectionId: t.connectionId,
      permissionId: randomId(),
      approveBy: secondsFromNow(-1),
    });

    await run();

    expect(await rowOf(inWindow)).toMatchObject({ state: 'awaiting_owner' });
    expect(await rowOf(pastWindow)).toMatchObject({ state: 'expired', code: null });
  });

  it('given an asked sign link the reconciler ended, when the connection asks to sign again, then the new link names the lost one', async () => {
    const lost = await row({
      method: 'sign',
      idempotencyKey: 'lost',
      requestHash: 'h',
      signKind: 'message',
      code: 'asked',
      sessionUntil: secondsFromNow(-61),
    });
    await run();
    const idle = async (): Promise<Wallet> => ({
      url: 'http://keys.test/cli-bridge?session=new',
      run: () => new Promise(() => {}),
      close: () => {},
    });

    const result = await sign(t, { message: 'again', idempotencyKey: 'again' }, { openWallet: idle });

    expect(result.structuredContent?.summary).toMatch(/^link_lost: .*cli-bridge\?pr_/);
    expect((await rowOf(lost)).state).toBe('expired');
  });

  const signRow = async () =>
    (await getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId)))[0];

  /** A wallet whose `method` waits for `release`, answering or failing as told. */
  function slowWallet(method: string, answer: (method: string) => unknown) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const ask: Ask = async (m) => {
      if (m === 'eth_requestAccounts' && method !== m) return [signer.address];
      await held;
      return answer(m);
    };
    return { openWallet: fakeWallet(ask), release };
  }

  it('given a link whose lease ended seconds ago, as in a database stall, when its connection asks again, then the same link stays and no new one opens', async () => {
    const held = await row({
      method: 'sign',
      idempotencyKey: 'held',
      requestHash: 'h',
      signKind: 'message',
      sessionUntil: secondsFromNow(-10),
    });
    let opened = 0;
    const idle = async (): Promise<Wallet> => (
      opened++, { url: 'http://keys.test/x', run: () => new Promise(() => {}), close: () => {} }
    );

    const result = await sign(t, { message: 'other', idempotencyKey: 'other' }, { openWallet: idle });

    expect(result.content[0].text).toMatch(/^sign_in_progress: /);
    expect(opened).toBe(0);
    expect(await rowOf(held)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given the owner signs after the link was ended past its window, then the signature still settles the request', async () => {
    const wallet = slowWallet('wallet_sign', () => '0xabcdef');
    await sign(t, { message: 'late', idempotencyKey: 'late' }, wallet);
    await vi.waitFor(async () => expect((await signRow()).code).toBe('asked'));
    await getDb()
      .update(permissionRequests)
      .set({ state: 'expired', code: null })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'approved', signature: '0xabcdef' });
  });

  it('given the owner declines after the link was ended, then the request reads owner_declined', async () => {
    const wallet = slowWallet('wallet_sign', () => {
      throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    });
    await sign(t, { message: 'no', idempotencyKey: 'no' }, wallet);
    await vi.waitFor(async () => expect((await signRow()).code).toBe('asked'));
    await getDb()
      .update(permissionRequests)
      .set({ state: 'expired', code: 'link_lost' })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'owner_declined' });
  });

  it('given the reconciler ended a link before its wallet session failed, then the failure does not replace session_lost', async () => {
    const wallet = slowWallet('eth_requestAccounts', () => {
      throw new Error('the wallet session ended');
    });
    await sign(t, { message: 'gone', idempotencyKey: 'gone' }, wallet);
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: secondsFromNow(-61) })
      .where(eq(permissionRequests.connectionId, t.connectionId));
    await run();

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given a session whose lease lapsed seconds ago in a stall, when the wallet answers, then it still asks the owner and the signature settles', async () => {
    const wallet = slowWallet('eth_requestAccounts', (m) =>
      m === 'eth_requestAccounts' ? [signer.address] : '0xbeef'
    );
    await sign(t, { message: 'stall', idempotencyKey: 'stall' }, wallet);
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: secondsFromNow(-10) })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'approved', signature: '0xbeef' });
  });
});
