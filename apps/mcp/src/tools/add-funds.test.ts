import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet } from '@/connections/relay';
import { callTool, connect, fakeWallet, owner, setTestEnv, walletAnswers, walletsSettled } from '@/connections/testkit';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { sendCalls } from './owner-calls';
import { addFunds, type AddFundsDeps } from './add-funds';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

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
  const chains: number[] = [];
  const deps = (o: { held?: Promise<void>; answer?: Ask } = {}): AddFundsDeps => {
    const answers = walletAnswers(signer);
    const wallet = fakeWallet(async (method, params) => {
      await o.held;
      if (o.answer) return o.answer(method, params);
      return method === 'wallet_addFunds' ? null : answers(method, params);
    }, asked);
    const openWallet: OpenWallet = async (...args) => (chains.push(args[0]), wallet(...args));
    return { openWallet };
  };
  return { asked, deps, opened: () => chains.length, chains };
}

const rowsOf = (t: Tenant) =>
  getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId));

const urlOf = (r: Awaited<ReturnType<typeof addFunds>>) =>
  'structuredContent' in r ? r.structuredContent?.url : undefined;

const textOf = (r: Awaited<ReturnType<typeof addFunds>>) => r.content[0].text;
const refused = (r: Awaited<ReturnType<typeof addFunds>>) => 'isError' in r && r.isError;

describe('jaw_add_funds', () => {
  it("given no chainId and the owner opens the link, then the wallet shows Add Funds on the connection's chain and the reply carries the link and where to deposit", async () => {
    const { t, signer } = await connected();
    const { deps, asked, chains } = setup(signer);

    const result = await addFunds(t, {}, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent).toEqual({
      url: expect.stringMatching(/cli-bridge/),
      approveBy: expect.any(String),
      address: t.account,
      chains: ['eip155:84532'],
      summary: expect.stringContaining('call jaw_get_assets yourself'),
    });
    expect(textOf(result)).toContain(`anyone can send funds on eip155:84532 to ${t.account}`);
    expect(textOf(result)).not.toMatch(/USDC/);
    expect(chains).toEqual([t.chainId]);
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'wallet_addFunds']);
    expect(asked[1].params).toEqual([{ chainId: t.chainId }]);
    expect(await rowsOf(t)).toMatchObject([{ method: 'add_funds', chainId: t.chainId, state: 'approved', code: null }]);
  });

  it('given the tool is called over MCP, then it answers with an owner link', async () => {
    const { c } = await connected();
    // No relay runs in this test, so the link ends unanswered.
    const r = await callTool(c.access_token, 'jaw_add_funds', {});
    await walletsSettled();
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent.url).toEqual(expect.any(String));
  });

  it('given a chainId the wallet supports, then the link opens on that chain, the wallet shows Add Funds there and the reply names it', async () => {
    const { t, signer } = await connected();
    const { deps, asked, chains } = setup(signer);

    const result = await addFunds(t, { chainId: 8453 }, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent).toMatchObject({
      address: t.account,
      chains: ['eip155:8453'],
      summary: expect.stringContaining(`deposit to ${t.account} on eip155:8453`),
    });
    expect(chains).toEqual([8453]);
    expect(asked[1]).toEqual({ method: 'wallet_addFunds', params: [{ chainId: 8453 }] });
    expect(await rowsOf(t)).toMatchObject([{ chainId: 8453, state: 'approved' }]);
    expect(JSON.parse((await rowsOf(t))[0].payload!)).toEqual({ chainId: 8453 });
  });

  it('given a chainId the wallet does not support, then it is refused and no wallet opens', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    const result = await addFunds(t, { chainId: 324 }, deps());

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^unsupported_chain: Chain 324 /);
    expect(opened()).toBe(0);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given a link waiting on one chain, when the agent asks for another, then the waiting link is named, not returned, and the address still comes back', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const first = await addFunds(t, {}, holding);
    const other = await addFunds(t, { chainId: 8453 }, holding);
    const same = await addFunds(t, {}, holding);
    wait.release();
    await walletsSettled();

    expect(refused(other)).toBe(true);
    expect(textOf(other)).toMatch(/^add_funds_in_progress: /);
    expect(textOf(other)).toContain(`on eip155:${t.chainId} at ${urlOf(first)}`);
    expect(textOf(other)).toContain(`anyone can send funds on eip155:8453 to ${t.account}`);
    expect('structuredContent' in other).toBe(false);
    expect(urlOf(same)).toBe(urlOf(first));
    expect(opened()).toBe(1);
    expect(await rowsOf(t)).toMatchObject([{ chainId: t.chainId }]);
  });

  it('given three other links waiting on the account, then an Add Funds link still opens', async () => {
    const signer = owner();
    const others = [await connected(signer), await connected(signer), await connected(signer)];
    const { t } = await connected(signer);
    const { deps, opened } = setup(signer);
    // The owner opens none of these links until the end, so each keeps its slot.
    const wait = held();
    const declining = fakeWallet(async () => {
      await wait.promise;
      throw Object.assign(new Error('declined'), { code: USER_REJECTED });
    }, []);
    const openDeclining: OpenWallet = async (...args) => declining(...args);
    for (const o of others) {
      const r = await sendCalls(
        o.t,
        { calls: [{ to: '0x000000000000000000000000000000000000dEaD' }] },
        { openWallet: openDeclining, receipt: async () => null, clients: {} as never }
      );
      expect(r.isError ?? false).toBe(false);
    }

    const result = await addFunds(t, { chainId: 8453 }, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(urlOf(result)).toMatch(/cli-bridge/);
    expect(opened()).toBe(1);
  });

  it('given Add Funds links waiting on three connections, then jaw_send_calls on the account still opens', async () => {
    const signer = owner();
    const waiting = [await connected(signer), await connected(signer), await connected(signer)];
    const { t } = await connected(signer);
    const { deps } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    for (const w of waiting) expect(refused(await addFunds(w.t, {}, holding))).toBe(false);

    const send = await sendCalls(
      t,
      { calls: [{ to: '0x000000000000000000000000000000000000dEaD' }] },
      { openWallet: holding.openWallet, receipt: async () => null, clients: {} as never }
    );
    wait.release();
    await walletsSettled();

    expect(send.isError ?? false).toBe(false);
    expect(send.content[0].text).not.toMatch(/^account_busy: /);
  });

  it('given the wallet pool is full, then the refusal is wallet_busy and still names the address on the asked chain', async () => {
    const { t } = await connected();
    const busy: OpenWallet = async () => {
      throw new WalletBusy();
    };

    const result = await addFunds(t, { chainId: 8453 }, { openWallet: busy });

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^Too many owners are approving right now\. /);
    expect(textOf(result)).toContain(`anyone can send funds on eip155:8453 to ${t.account}`);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given the wallet is signed in to another account, then the screen is never shown and the request reads wrong_account', async () => {
    const { t } = await connected();
    const { deps, asked } = setup(owner());

    await addFunds(t, {}, deps());
    await walletsSettled();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    expect(await rowsOf(t)).toMatchObject([{ state: 'owner_declined', code: 'wrong_account' }]);
  });

  it('given the owner rejects in the wallet, then the request reads declined', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const rejecting = walletAnswers(signer, ['wallet_addFunds']);

    await addFunds(t, {}, deps({ answer: rejecting }));
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
    for (let i = 0; i < 15; i++) answers.push(await addFunds(t, {}, holding));
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

    const theirs = await addFunds(other.t, {}, holding);
    const ours = await addFunds(mine.t, {}, holding);
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
      await addFunds(t, {}, deps());
      await walletsSettled();
    }
    const over = await addFunds(t, {}, deps());

    expect(over.content[0].text).toMatch(/^rate_limited: /);
    expect(opened()).toBe(10);
  });
});

async function clearOfMinuteEdge() {
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
}
