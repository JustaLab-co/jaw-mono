import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { Ask, OpenWallet } from '@/connections/relay';
import { callTool, connect, fakeWallet, owner, setTestEnv, walletAnswers, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { addFunds, type AddFundsDeps } from './add-funds';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

async function connected(signer = owner()) {
  const c = await connect(signer, { scope: 'wallet:read' });
  await walletsSettled();
  return { c, signer, t: (await verifyBearer(c.access_token))?.extra?.tenant as Tenant };
}

function held() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A wallet that closes the Add Funds screen with null, as the SDK does whether or not funds were sent. */
function setup(signer: ReturnType<typeof owner>) {
  const asked: { method: string; params: unknown[] }[] = [];
  let opened = 0;
  const deps = (o: { held?: Promise<void>; answer?: Ask } = {}): AddFundsDeps => {
    const answers = walletAnswers(signer);
    const wallet = fakeWallet(async (method, params) => {
      await o.held;
      if (o.answer) return o.answer(method, params);
      return method === 'wallet_addFunds' ? null : answers(method, params);
    }, asked);
    const openWallet: OpenWallet = async (...args) => (opened++, wallet(...args));
    return { openWallet };
  };
  return { asked, deps, opened: () => opened };
}

const rowsOf = (t: Tenant) =>
  getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId));

const urlOf = (r: Awaited<ReturnType<typeof addFunds>>) =>
  'structuredContent' in r ? r.structuredContent?.url : undefined;

describe('jaw_add_funds', () => {
  it("given the owner opens the link, then the wallet shows Add Funds on the connection's chain and the reply carries the link and where to send USDC", async () => {
    const { t, signer } = await connected();
    const { deps, asked } = setup(signer);

    const result = await addFunds(t, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent).toEqual({
      url: expect.stringMatching(/cli-bridge/),
      approveBy: expect.any(String),
      address: t.account,
      chains: ['eip155:84532'],
      asset: `eip155:84532/erc20:${USDC}`,
      paymentUri: `ethereum:${USDC}@84532/transfer?address=${t.account}`,
      summary: expect.stringContaining('call jaw_get_assets yourself'),
    });
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'wallet_addFunds']);
    expect(asked[1].params).toEqual([{ chainId: t.chainId }]);
    expect(await rowsOf(t)).toMatchObject([{ method: 'add_funds', state: 'approved', code: null }]);
  });

  it('given the tool is called over MCP, then it answers with an owner link', async () => {
    const { c } = await connected();
    // No relay runs in this test, so the link ends unanswered.
    const r = await callTool(c.access_token, 'jaw_add_funds', {});
    await walletsSettled();
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent.url).toEqual(expect.any(String));
  });

  it('given a chain with no USDC, then the link still opens and no USDC payment link is offered', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);

    const result = await addFunds({ ...t, chainId: 324 }, deps());
    await walletsSettled();

    const out = 'structuredContent' in result ? result.structuredContent : undefined;
    expect(out).toMatchObject({ url: expect.stringMatching(/cli-bridge/), chains: ['eip155:324'] });
    expect(out?.asset).toBeUndefined();
    expect(out?.paymentUri).toBeUndefined();
  });

  it('given the wallet is signed in to another account, then the screen is never shown and the request reads wrong_account', async () => {
    const { t } = await connected();
    const { deps, asked } = setup(owner());

    await addFunds(t, deps());
    await walletsSettled();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    expect(await rowsOf(t)).toMatchObject([{ state: 'owner_declined', code: 'wrong_account' }]);
  });

  it('given the owner rejects in the wallet, then the request reads declined', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const rejecting = walletAnswers(signer, ['wallet_addFunds']);

    await addFunds(t, deps({ answer: rejecting }));
    await walletsSettled();

    expect(await rowsOf(t)).toMatchObject([{ state: 'owner_declined' }]);
  });

  it('given a link still waiting for the owner, when the agent asks again many times, then each gets the same link and none is rate_limited', async () => {
    await clearOfMinuteEdge();
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const answers = [];
    for (let i = 0; i < 15; i++) answers.push(await addFunds(t, holding));
    wait.release();
    await walletsSettled();

    expect(new Set(answers.map(urlOf)).size).toBe(1);
    expect(urlOf(answers[0])).toMatch(/cli-bridge/);
    expect(opened()).toBe(1);
  });

  it('given another app on the account waits on its own link, then this connection gets a link of its own', async () => {
    const signer = owner();
    const mine = await connected(signer);
    const other = await connected(signer);
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const theirs = await addFunds(other.t, holding);
    const ours = await addFunds(mine.t, holding);
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(2);
    expect(urlOf(ours)).not.toBe(urlOf(theirs));
  });

  it('given ten links in a minute on one connection, when an eleventh comes, then it is rate_limited and no wallet opens', async () => {
    await clearOfMinuteEdge();
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    for (let i = 0; i < 10; i++) {
      await addFunds(t, deps());
      await walletsSettled();
    }
    const over = await addFunds(t, deps());

    expect(over.content[0].text).toMatch(/^rate_limited: /);
    expect(opened()).toBe(10);
  });
});

async function clearOfMinuteEdge() {
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
}
