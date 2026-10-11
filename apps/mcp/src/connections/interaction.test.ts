import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import type { GrantRequest } from '@/grants/permission';
import type { OpenWallet } from './relay';
import {
  Browser,
  fakeWallet,
  ISSUER,
  owner,
  setTestEnv,
  startAuthorization,
  setWallet,
  walletAnswers,
  walletsSettled,
} from './testkit';

setTestEnv();
beforeAll(useTestDb);

const rowOf = async (uid: string) =>
  (await getDb().select().from(connections).where(eq(connections.interactionUid, uid)))[0];

const stateOf = async (browser: Browser, uid: string) =>
  (await (await browser.get(`${ISSUER}/interaction/${uid}/status`)).json()) as { state: string; reason?: string };

describe('connecting through the owner wallet', () => {
  it('given wallet:read alone, then the wallet is asked to sign in, never for a budget, and the connection is made', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    const signer = owner();
    setWallet({ openWallet: fakeWallet(walletAnswers(signer), asked) });
    const browser = new Browser();
    const start = await startAuthorization(browser, { scope: 'wallet:read' });
    await walletsSettled();
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'personal_sign']);
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'approved' });
    expect((await rowOf(start.uid!)).account).toBe(signer.address);
  });

  it('given a spending scope, then the wallet is asked once, for the default daily budget with the session key as spender', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    setWallet({ openWallet: fakeWallet(walletAnswers(owner()), asked) });
    const start = await startAuthorization(new Browser(), { scope: 'wallet:read x402:pay' });
    await walletsSettled();
    expect(asked.map((a) => a.method)).toEqual(['wallet_grantPermissions']);
    const grant = asked[0].params[0] as GrantRequest;
    const row = await rowOf(start.uid!);
    expect(grant.spender).toBe(row.sessionAddress);
    expect(grant.permissions.spends[0].allowance).toBe('1000000');
    expect(await getDb().select().from(grants).where(eq(grants.connectionId, row.id))).toHaveLength(1);
  });

  it('given a sign-in signed by another key, then nothing is stored and the page says it failed', async () => {
    const [claimed, signing] = [owner(), owner()];
    const honest = walletAnswers(signing);
    setWallet({
      openWallet: fakeWallet(async (method, params) =>
        method === 'eth_requestAccounts' ? [claimed.address] : honest(method, params)
      ),
    });
    const browser = new Browser();
    const start = await startAuthorization(browser, { scope: 'wallet:read' });
    await walletsSettled();
    expect(await rowOf(start.uid!)).toBeUndefined();
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'failed', reason: 'bad_signature' });
  });

  it('given the owner turns the budget down, then nothing is stored and the page says it failed', async () => {
    setWallet({ openWallet: fakeWallet(walletAnswers(owner(), ['wallet_grantPermissions'])) });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    expect(await rowOf(start.uid!)).toBeUndefined();
    expect((await stateOf(browser, start.uid!)).state).toBe('failed');
  });

  it('given the wallet has not answered yet, when the page reloads, then it shows the same link and opens no second session', async () => {
    let opened = 0;
    const waiting: OpenWallet = async () => {
      opened++;
      return { url: `http://keys.test/cli-bridge?session=s${opened}`, run: () => new Promise(() => {}) };
    };
    setWallet({ openWallet: waiting });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    const again = await (await browser.get(`${ISSUER}/interaction/${start.uid}`)).text();
    expect(opened).toBe(1);
    expect(again).toContain('session=s1');
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'waiting' });
  });

  it('given an approved connection, when completion comes without the ticket of its page, then it is refused', async () => {
    setWallet({ openWallet: fakeWallet(walletAnswers(owner())) });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    const res = await browser.get(`${ISSUER}/interaction/${start.uid}/complete?ticket=forged`);
    expect(res.status).toBe(400);
    expect((await rowOf(start.uid!)).status).toBe('pending');
  });

  it('given an interaction that does not exist, then the page answers 410 and opens no wallet', async () => {
    let opened = 0;
    setWallet({
      openWallet: async (chainId) => {
        opened++;
        return fakeWallet(walletAnswers(owner()))(chainId);
      },
    });
    const res = await new Browser().get(`${ISSUER}/interaction/abcdefghijklmnop`);
    expect(res.status).toBe(410);
    expect(opened).toBe(0);
  });
});
