import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hexToString, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import type { GrantRequest } from '@/grants/permission';
import { config } from './config';
import { CONNECTIONS_PER_ACCOUNT, SESSIONS_PER_CLIENT, SESSIONS_PER_IP } from './interaction';
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
// setWallet is sticky, so a test that makes the chain unreadable must not hand that on.
beforeEach(() => setWallet({ readPermission: approvedOnChain }));

const rowOf = async (uid: string) =>
  (await getDb().select().from(connections).where(eq(connections.interactionUid, uid)))[0];

const budgetsOf = async (connectionId: string) =>
  getDb().select().from(grants).where(eq(grants.connectionId, connectionId));

/** The session key the server can still open for a connection, as its address. */
const keptKey = (row: typeof connections.$inferSelect) =>
  row.sealedKey && privateKeyToAddress(open(config().ring, row.sealedKey as Sealed, row.id));

const stateOf = async (browser: Browser, uid: string) =>
  (await (await browser.get(`${ISSUER}/interaction/${uid}/status`)).json()) as { state: string; reason?: string };

/** A wallet whose sessions wait for the owner until `release`, counting how many were opened. */
function heldWallets() {
  let opened = 0;
  let release!: () => void;
  const released = new Promise<never>((_, reject) => (release = () => reject(new Error('the wallet session ended'))));
  released.catch(() => undefined);
  const openWallet: OpenWallet = async () => {
    opened++;
    return { url: `http://keys.test/cli-bridge?session=h${opened}`, run: () => released, close: () => undefined };
  };
  return { openWallet, opened: () => opened, release: async () => (release(), await new Promise(setImmediate)) };
}

describe('opening the wallet session', () => {
  it('given the page loads, then no wallet session is open until the owner clicks Open JAW', async () => {
    const held = heldWallets();
    setWallet({ openWallet: held.openWallet });
    const browser = new Browser();
    const start = await startAuthorization(browser, {}, { click: false });
    await browser.get(`${ISSUER}/interaction/${start.uid}`);
    expect(held.opened()).toBe(0);
    const clicked = await browser.post(`${ISSUER}/interaction/${start.uid}/open`);
    expect(await clicked.json()).toEqual({ url: 'http://keys.test/cli-bridge?session=h1' });
    expect(held.opened()).toBe(1);
    await held.release();
  });

  it('given a browser without the interaction cookie, when it asks to open the session, then it is refused and nothing opens', async () => {
    const held = heldWallets();
    setWallet({ openWallet: held.openWallet });
    const start = await startAuthorization(new Browser(), { scope: 'wallet:read' });
    const before = held.opened();
    const res = await new Browser().post(`${ISSUER}/interaction/${start.uid}/open`);
    expect(res.status).toBe(400);
    expect(held.opened()).toBe(before);
    await held.release();
  });

  it('given one address holds its share of sessions, then another authorization from it is refused, and one from elsewhere opens', async () => {
    const held = heldWallets();
    setWallet({ openWallet: held.openWallet });
    const from = (ip: string) => ({ headers: { 'x-real-ip': ip } });
    for (let i = 0; i < SESSIONS_PER_IP; i++) {
      expect((await startAuthorization(new Browser(), {}, from('198.51.100.7'))).opened?.status).toBe(200);
    }
    const refused = (await startAuthorization(new Browser(), {}, from('198.51.100.7'))).opened;
    expect(refused?.status).toBe(429);
    expect((await startAuthorization(new Browser(), {}, from('198.51.100.8'))).opened?.status).toBe(200);
    expect(held.opened()).toBe(SESSIONS_PER_IP + 1);
    await held.release();
    expect((await startAuthorization(new Browser(), {}, from('198.51.100.7'))).opened?.status).toBe(200);
  });

  it('given one client holds its share of sessions, then another authorization for it is refused whatever the address', async () => {
    const held = heldWallets();
    setWallet({ openWallet: held.openWallet });
    for (let i = 0; i < SESSIONS_PER_CLIENT; i++) {
      await startAuthorization(new Browser(), {}, { headers: { 'x-real-ip': `203.0.113.${i}` } });
    }
    const refused = (await startAuthorization(new Browser(), {}, { headers: { 'x-real-ip': '192.0.2.1' } })).opened;
    expect(refused?.status).toBe(429);
    expect(held.opened()).toBe(SESSIONS_PER_CLIENT);
    await held.release();
  });
});

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

  it('given an authorization, then the wallet opens for the client that asked', async () => {
    const opened: unknown[][] = [];
    const answers = fakeWallet(walletAnswers(owner()));
    setWallet({
      openWallet: async (...args) => {
        opened.push(args);
        return answers(...args);
      },
    });
    const start = await startAuthorization(new Browser(), { scope: 'wallet:read' });
    await walletsSettled();

    const row = await rowOf(start.uid!);
    expect(opened).toHaveLength(1);
    expect(opened[0][2]).toMatchObject({ clientId: row.clientId, clientName: row.clientName });
    expect(row.clientId).toBe('jaw-cli');
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

  it('given a failed approval, when the owner clicks again and approves, then the budget names the same spender', async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    setWallet({
      openWallet: fakeWallet(walletAnswers(owner()), asked),
      readPermission: async () => ({ status: 'unavailable' }),
    });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    setWallet({ readPermission: approvedOnChain });
    await browser.post(`${ISSUER}/interaction/${start.uid}/open`);
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

  it('given the wallet has not answered yet, when the page reloads and the owner clicks again, then it hands out the same link and opens no second session', async () => {
    const held = heldWallets();
    setWallet({ openWallet: held.openWallet });
    const browser = new Browser();
    const start = await startAuthorization(browser);
    const again = await (await browser.get(`${ISSUER}/interaction/${start.uid}`)).text();
    const clicked = await (await browser.post(`${ISSUER}/interaction/${start.uid}/open`)).json();
    expect(held.opened()).toBe(1);
    expect(clicked).toEqual({ url: 'http://keys.test/cli-bridge?session=h1' });
    // The ticket and the code come from the interaction, so a reload on another replica shows the same ones.
    expect(again).toContain(`"ticket":"${start.ticket}"`);
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'waiting' });
    await held.release();
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

async function fillConnections(account: string, n: number) {
  for (let i = 0; i < n; i++) {
    await getDb()
      .insert(connections)
      .values({
        id: `conn_fill_${randomBytes(8).toString('hex')}`,
        status: 'active',
        account,
        chainId: config().chain.id,
        clientId: 'jaw-cli',
        clientName: 'JAW CLI',
        scopes: ['wallet:read'],
        sessionAddress: privateKeyToAddress(generatePrivateKey()),
        interactionUid: `fill_${randomBytes(8).toString('hex')}`,
        ticketHash: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        grantId: `fill_grant_${randomBytes(8).toString('hex')}`,
        activatedAt: new Date(),
      });
  }
}

describe('per-account connection cap', () => {
  it('given an account at the cap, then a new connection is refused after sign-in', async () => {
    const signer = owner();
    await fillConnections(signer.address, CONNECTIONS_PER_ACCOUNT);
    setWallet({ openWallet: fakeWallet(walletAnswers(signer)) });
    const browser = new Browser();
    const start = await startAuthorization(browser, { scope: 'wallet:read' });
    await walletsSettled();
    expect(await stateOf(browser, start.uid!)).toEqual({
      state: 'failed',
      reason: 'too many active connections; revoke one first',
    });
  });

  it('given an account one under the cap, then a new connection succeeds', async () => {
    const signer = owner();
    await fillConnections(signer.address, CONNECTIONS_PER_ACCOUNT - 1);
    setWallet({ openWallet: fakeWallet(walletAnswers(signer)) });
    const browser = new Browser();
    const start = await startAuthorization(browser, { scope: 'wallet:read' });
    await walletsSettled();
    expect(await stateOf(browser, start.uid!)).toEqual({ state: 'approved' });
  });
});

// Last: the session it opens counts against the client's share until the interaction ends.
describe('the owner window', () => {
  it('given the owner clicks Open JAW, then the wallet waits for them close to thirty minutes', async () => {
    const held = heldWallets();
    let until: Date | undefined;
    setWallet({ openWallet: (chainId, at, client) => ((until = at), held.openWallet(chainId, at, client)) });
    await startAuthorization(new Browser());
    expect(until!.getTime() - Date.now()).toBeGreaterThan(28.9 * 60_000);
    expect(until!.getTime() - Date.now()).toBeLessThanOrEqual(29 * 60_000);
    await held.release();
  });
});
