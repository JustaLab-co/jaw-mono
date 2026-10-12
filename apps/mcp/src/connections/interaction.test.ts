import { eq } from 'drizzle-orm';
import { hexToString, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import type { GrantRequest } from '@/grants/permission';
import { config } from './config';
import type { OpenWallet } from './relay';
import { open, type Sealed } from './seal';
import {
  approvedOnChain,
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

const budgetsOf = async (connectionId: string) =>
  getDb().select().from(grants).where(eq(grants.connectionId, connectionId));

/** The session key the server can still open for a connection, as its address. */
const keptKey = (row: typeof connections.$inferSelect) =>
  row.sealedKey && privateKeyToAddress(open(config().ring, row.sealedKey as Sealed, row.id));

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

  it('given a spending scope, then after the sign-in the wallet is asked for the default daily budget with the session key as spender', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    setWallet({ openWallet: fakeWallet(walletAnswers(owner()), asked) });
    const start = await startAuthorization(new Browser(), { scope: 'wallet:read x402:pay' });
    await walletsSettled();
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'personal_sign', 'wallet_grantPermissions']);
    const grant = asked[2].params[0] as GrantRequest;
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

  it('given the owner turns the budget down, then no budget is stored and the page says it failed', async () => {
    setWallet({ openWallet: fakeWallet(walletAnswers(owner(), ['wallet_grantPermissions'])) });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    expect(await budgetsOf((await rowOf(start.uid!)).id)).toEqual([]);
    expect((await stateOf(browser, start.uid!)).state).toBe('failed');
  });

  it('given the wallet granted the budget but the chain cannot confirm it yet, then the spender key is kept and the connection cannot be completed', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    setWallet({
      openWallet: fakeWallet(walletAnswers(owner()), asked),
      readPermission: async () => ({ status: 'unavailable' }),
    });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    const row = await rowOf(start.uid!);
    // The grant sent its prefund to this address: only a key the server keeps can move it back.
    expect(keptKey(row)).toBe((asked[2].params[0] as GrantRequest).spender);
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'failed', reason: 'verification_unavailable' });
    const res = await browser.get(`${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    expect(res.status).toBe(400);
  });

  it('given a failed approval, when the page reloads and the owner approves, then the budget names the same spender', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    setWallet({
      openWallet: fakeWallet(walletAnswers(owner()), asked),
      readPermission: async () => ({ status: 'unavailable' }),
    });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    setWallet({ readPermission: approvedOnChain });
    await browser.get(`${ISSUER}/interaction/${start.uid}`);
    await walletsSettled();
    const spenders = asked
      .filter((a) => a.method === 'wallet_grantPermissions')
      .map((a) => (a.params[0] as GrantRequest).spender);
    expect(spenders).toHaveLength(2);
    expect(spenders[1]).toBe(spenders[0]);
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'approved' });
  });

  it('signs a text that names the app and what it asks for, with the code the page shows', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    const signer = owner();
    setWallet({ openWallet: fakeWallet(walletAnswers(signer), asked) });
    const start = await startAuthorization(new Browser(), { scope: 'wallet:read x402:pay' });
    await walletsSettled();
    const signed = hexToString(asked[1].params[0] as Hex);
    const code = start.html!.match(/<p class="code">([A-Z0-9]{6})<\/p>/)?.[1];
    expect(code).toBeDefined();
    expect(signed).toContain(`Code: ${code}`);
    expect(signed).toContain('Connect JAW CLI to mcp.test');
    expect(signed).toContain('Pay x402 services');
    expect(signed).toContain(`Account: ${signer.address}`);
  });

  it('given a budget approved from another account than the one that signed in, then no budget is stored', async () => {
    const [signing, granting] = [owner(), owner()];
    const [signIn, grant] = [walletAnswers(signing), walletAnswers(granting)];
    setWallet({
      openWallet: fakeWallet(async (method, params) =>
        method === 'wallet_grantPermissions' ? grant(method, params) : signIn(method, params)
      ),
    });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    expect(await budgetsOf((await rowOf(start.uid!)).id)).toEqual([]);
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'failed', reason: 'grant_mismatch' });
  });

  it('says the owner turned it down when the wallet answers 4001', async () => {
    setWallet({ openWallet: fakeWallet(walletAnswers(owner(), ['personal_sign'])) });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'failed', reason: 'turned down in the wallet' });
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
    // The ticket and the code come from the interaction, so a reload on another replica shows the same ones.
    expect(again).toContain(`"ticket":"${start.ticket}"`);
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
      openWallet: async (chainId, until) => {
        opened++;
        return fakeWallet(walletAnswers(owner()))(chainId, until);
      },
    });
    const res = await new Browser().get(`${ISSUER}/interaction/abcdefghijklmnop`);
    expect(res.status).toBe(410);
    expect(opened).toBe(0);
  });
});
