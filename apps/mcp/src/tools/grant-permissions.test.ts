import { PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toFunctionSelector } from 'viem';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type OpenWallet } from '@/connections/relay';
import {
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  owner,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import type { GrantRequest } from '@/grants/permission';
import { LIVE_GRANTS_PER_CONNECTION, x402Budget } from '@/grants/store';
import { grantPermissions, type GrantInput } from './grant-permissions';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const DAY_MS = 86_400_000;

async function connected() {
  const signer = owner();
  const c = await connect(signer);
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { c, t, signer, connectedWith: (await x402Budget(t.connectionId))?.permissionId };
}

async function grant(
  t: Tenant,
  signer: ReturnType<typeof owner>,
  input: GrantInput,
  tamper?: (granted: Record<string, unknown>) => object
) {
  const asked: { method: string; params: unknown[] }[] = [];
  const honest = walletAnswers(signer);
  let opened = 0;
  const wallet = fakeWallet(async (method, params) => {
    const granted = (await honest(method, params)) as Record<string, unknown>;
    return tamper ? tamper(granted) : granted;
  }, asked);
  const result = await grantPermissions(t, input, {
    openWallet: async (...args) => (opened++, wallet(...args)),
    readPermission: approvedOnChain,
  });
  await walletsSettled();
  return { result, opened, request: asked[0]?.params[0] as GrantRequest | undefined };
}

const newestRow = async (t: Tenant) =>
  (
    await getDb()
      .select()
      .from(grants)
      .where(eq(grants.connectionId, t.connectionId))
      .orderBy(desc(grants.createdAt))
      .limit(1)
  )[0];

const secondsOf = (d: Date) => Math.floor(d.getTime() / 1000);

const requestsOf = (t: Tenant) =>
  getDb()
    .select()
    .from(permissionRequests)
    .where(and(eq(permissionRequests.connectionId, t.connectionId), eq(permissionRequests.method, 'grant')));

const twoByTwo: GrantInput = {
  calls: [
    { target: WETH, functionSignature: 'approve(address,uint256)' },
    { target: ROUTER, functionSignature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))' },
  ],
  spends: [
    { token: WETH, allowance: '500000000000000000', unit: 'week' },
    { token: USDC, allowance: '2000000', unit: 'month', multiplier: 2 },
  ],
};

describe('jaw_grant_permissions', () => {
  it('given the x402 preset, then the wallet is asked for the daily USDC budget until the connection ends, and a budget row is kept', async () => {
    const { t, signer } = await connected();

    const { result, request } = await grant(t, signer, { x402Budget: { perDay: '2.5' } });

    expect(request).toEqual({
      spender: t.sessionAddress,
      expiry: secondsOf(t.expiresAt),
      chainId: '0x14a34',
      permissions: {
        calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
        spends: [{ token: USDC, allowance: '2500000', unit: 'day', multiplier: 1 }],
      },
      capabilities: { prefundSpender: true },
    });
    expect('structuredContent' in result && result.structuredContent.summary).toContain('2.5 USDC a day');
    expect(await newestRow(t)).toMatchObject({
      kind: 'x402-budget',
      token: USDC,
      allowance: '2500000',
      period: 'day',
    });
    expect((await x402Budget(t.connectionId))?.allowance).toBe('2500000');
  });

  it('given two calls and two spends, then the wallet is asked for exactly those, and a custom row keeps them all', async () => {
    const { t, signer, connectedWith } = await connected();

    const { request } = await grant(t, signer, twoByTwo);

    expect(request?.permissions).toEqual({
      calls: twoByTwo.calls,
      spends: [
        { token: WETH, allowance: '500000000000000000', unit: 'week', multiplier: 1 },
        { token: USDC, allowance: '2000000', unit: 'month', multiplier: 2 },
      ],
    });
    expect(request?.capabilities).toBeUndefined();
    const row = await newestRow(t);
    expect(row).toMatchObject({ kind: 'custom', token: null, allowance: null, period: null });
    expect((row?.permission as { calls: unknown[]; spends: unknown[] }).spends).toHaveLength(2);
    expect((row?.permission as { calls: unknown[] }).calls).toHaveLength(2);
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('given a weekly WETH spend, then the custom row reads WETH, its allowance and week', async () => {
    const { t, signer } = await connected();

    await grant(t, signer, {
      calls: [{ target: WETH, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: WETH, allowance: '1000000000000000', unit: 'week' }],
    });

    expect(await newestRow(t)).toMatchObject({
      kind: 'custom',
      token: WETH,
      allowance: '1000000000000000',
      period: 'week',
    });
  });

  it('given an expiry past the end of the connection, then the wallet is asked to end it with the connection', async () => {
    const { t, signer } = await connected();

    const { result, request } = await grant(t, signer, {
      ...twoByTwo,
      expiresAt: new Date(Date.now() + 90 * DAY_MS).toISOString(),
    });

    expect(request?.expiry).toBe(secondsOf(t.expiresAt));
    expect('structuredContent' in result && result.structuredContent.expiresAt).toBe(
      new Date(secondsOf(t.expiresAt) * 1000).toISOString()
    );
  });

  it('given an expiry before the end of the connection, then the wallet is asked for that one', async () => {
    const { t, signer } = await connected();
    const expiresAt = new Date(Date.now() + 7 * DAY_MS);

    const { request } = await grant(t, signer, { ...twoByTwo, expiresAt: expiresAt.toISOString() });

    expect(request?.expiry).toBe(secondsOf(expiresAt));
  });

  it('given an expiry in the past, then it is refused by name and no wallet opens', async () => {
    const { t, signer } = await connected();

    const { result, opened } = await grant(t, signer, {
      ...twoByTwo,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect('isError' in result && result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^expiry_in_past: /);
    expect(opened).toBe(0);
  });

  it('given a wallet answer that differs in one spend, then no grant is recorded', async () => {
    const { t, signer } = await connected();
    const before = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));

    await grant(t, signer, twoByTwo, (granted) => {
      const [first, second] = granted.spends as Record<string, unknown>[];
      return { ...granted, spends: [first, { ...second, allowance: '2000001' }] };
    });

    const after = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    expect(after).toHaveLength(before.length);
  });

  it('given a wallet answer that drops one of two spends, then no grant is recorded', async () => {
    const { t, signer } = await connected();
    const before = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));

    await grant(t, signer, twoByTwo, (granted) => ({ ...granted, spends: (granted.spends as object[]).slice(0, 1) }));

    const after = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    expect(after).toHaveLength(before.length);
  });

  it('given a wallet answer with one call more than asked, then no grant is recorded', async () => {
    const { t, signer } = await connected();
    const before = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));

    await grant(t, signer, twoByTwo, (granted) => ({
      ...granted,
      calls: [...(granted.calls as object[]), { target: WETH, selector: '0x23b872dd' }],
    }));

    const after = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    expect(after).toHaveLength(before.length);
  });

  it('given an expiry inside the time the owner has to approve, then it is refused by name and no wallet opens', async () => {
    const { t, signer } = await connected();

    const { result, opened } = await grant(t, signer, {
      ...twoByTwo,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    expect(result.content[0].text).toMatch(/^expiry_too_soon: /);
    expect(opened).toBe(0);
  });

  it.each([
    ['the any-contract wildcard', () => '0x3232323232323232323232323232323232323232'],
    ['the permission manager', () => PERMISSIONS_MANAGER_ADDRESS],
    ['the account itself', (t: Tenant) => t.account],
  ])('given a call to %s, then it is refused by name and no wallet opens', async (_name, target) => {
    const { t, signer } = await connected();

    const { result, opened } = await grant(t, signer, {
      calls: [{ target: target(t), functionSignature: 'transfer(address,uint256)' }],
    });

    expect(result.content[0].text).toMatch(/^call_target_refused: /);
    expect(opened).toBe(0);
  });

  it.each([
    ['any function', 'fba3b554e(uint256)', '0x32323232'],
    ['an empty call', 'f31225173(uint256)', '0xe0e0e0e0'],
  ])(
    'given a signature that hashes to the selector for %s, then it is refused by name and no wallet opens',
    async (_name, functionSignature, selector) => {
      expect(toFunctionSelector(functionSignature)).toBe(selector);
      const { t, signer } = await connected();

      const { result, opened } = await grant(t, signer, { calls: [{ target: WETH, functionSignature }] });

      expect(result.content[0].text).toMatch(/^call_selector_refused: /);
      expect(opened).toBe(0);
    }
  );

  it.each<[string, GrantInput]>([
    ['the preset with calls', { x402Budget: { perDay: '1' }, calls: twoByTwo.calls }],
    [
      'the preset with an expiry',
      { x402Budget: { perDay: '1' }, expiresAt: new Date(Date.now() + DAY_MS).toISOString() },
    ],
    ['spends with no calls', { spends: twoByTwo.spends }],
    ['nothing', {}],
  ])('given %s, then it is refused before a wallet opens', async (_name, input) => {
    const { t, signer } = await connected();

    const { result, opened } = await grant(t, signer, input);

    expect('isError' in result && result.isError).toBe(true);
    expect(opened).toBe(0);
  });

  it('given custom grants up to the cap, then a further one is refused before a wallet opens', async () => {
    const { t, signer } = await connected();
    for (let n = 1; n < LIVE_GRANTS_PER_CONNECTION; n++) await grant(t, signer, twoByTwo);

    const { result, opened } = await grant(t, signer, twoByTwo);

    expect(result.content[0].text).toContain(`${LIVE_GRANTS_PER_CONNECTION} live grants`);
    expect(opened).toBe(0);
  });

  it('given a call that is not a function signature, then the schema refuses it', async () => {
    const { c } = await connected();

    const result = await callTool(c.access_token, 'jaw_grant_permissions', {
      calls: [{ target: WETH, functionSignature: 'transfer' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Input validation error');
  });

  it('given a period the wallet does not take, then the schema refuses it', async () => {
    const { c } = await connected();

    const result = await callTool(c.access_token, 'jaw_grant_permissions', {
      ...twoByTwo,
      spends: [{ token: WETH, allowance: '1', unit: 'fortnight' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Input validation error');
  });

  it('given an allowance past what a spend limit holds on chain, then the schema refuses it', async () => {
    const { c } = await connected();

    const result = await callTool(c.access_token, 'jaw_grant_permissions', {
      ...twoByTwo,
      spends: [{ token: WETH, allowance: (2n ** 160n).toString(), unit: 'week' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Input validation error');
  });

  it.each([
    ['without its token', { token: null }],
    ['with a weekly period', { period: 'week' as const }],
  ])('given a budget row %s, then the database refuses it', async (_name, change) => {
    const { t } = await connected();
    const [row] = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));

    const insert = getDb()
      .insert(grants)
      .values({ ...row, ...change, permissionId: `0x${randomBytes(32).toString('hex')}` });

    await expect(insert).rejects.toThrow();
  });

  it('given a custom grant shaped like a daily USDC budget, then x402 payments still draw from the budget', async () => {
    const { t, signer, connectedWith } = await connected();

    await grant(t, signer, {
      calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: USDC, allowance: '9000000', unit: 'day' }],
    });

    expect(await newestRow(t)).toMatchObject({ kind: 'custom', token: USDC, period: 'day' });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('given a yearly limit whose months overflow the multiplier, then the schema refuses it', async () => {
    const { c } = await connected();

    const result = await callTool(c.access_token, 'jaw_grant_permissions', {
      ...twoByTwo,
      spends: [{ token: WETH, allowance: '1', unit: 'year', multiplier: 5462 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Input validation error');
  });

  it('given an approval, then the owner link is recorded approved with the id the wallet granted', async () => {
    const { t, signer } = await connected();

    await grant(t, signer, twoByTwo);

    const granted = await newestRow(t);
    expect(await requestsOf(t)).toMatchObject([{ state: 'approved', permissionId: granted.permissionId }]);
  });

  it('given a wallet answer that is not what was asked, then the link records the id it answered, so it can be revoked', async () => {
    const { t, signer } = await connected();
    let answered: string | undefined;

    await grant(t, signer, twoByTwo, (granted) => {
      answered = granted.permissionId as string;
      return { ...granted, spends: [] };
    });

    expect(await requestsOf(t)).toMatchObject([{ state: 'failed', code: 'grant_mismatch', permissionId: answered }]);
  });

  it('given a grant still waiting for the owner, when asked again, then it is refused with that link and no other wallet opens', async () => {
    const { t, signer } = await connected();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer);
    let opened = 0;
    const deps = {
      openWallet: (async (...args) => (
        opened++, fakeWallet(async (method, params) => (await held, honest(method, params)))(...args)
      )) as OpenWallet,
      readPermission: approvedOnChain,
    };

    const first = await grantPermissions(t, twoByTwo, deps);
    const again = await grantPermissions(t, twoByTwo, deps);
    release();
    await walletsSettled();

    expect(opened).toBe(1);
    const url = 'structuredContent' in first && first.structuredContent.url;
    expect(again.content[0].text).toContain(`still waiting for the owner at ${url}`);
  });

  it('given the waiting grant has a saved relay session and its lease lapsed inside the stall grace, when asked again, then the refusal says the server is reconnecting', async () => {
    const { t, signer } = await connected();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer);
    const deps = {
      openWallet: fakeWallet(async (method, params) => (await held, honest(method, params))) as OpenWallet,
      readPermission: approvedOnChain,
    };
    await grantPermissions(t, twoByTwo, deps);
    // Inside the grace no rejoin starts, so the read sees the row exactly as written.
    await getDb()
      .update(permissionRequests)
      .set({ relay: 'saved', sessionUntil: sql`now() - interval '30 seconds'` })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    const again = await grantPermissions(t, twoByTwo, deps);
    release();
    await walletsSettled();

    expect(again.content[0].text).toContain('reconnecting to the owner');
    expect(again.content[0].text).not.toContain('still waiting for the owner');
  });

  it('given a grant opening its link while another ask finds the wallet pool full, then the other is told that link is waiting', async () => {
    const { t, signer } = await connected();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer);
    const holding = {
      openWallet: fakeWallet(async (method, params) => (await held, honest(method, params))),
      readPermission: approvedOnChain,
    };
    let opener!: ReturnType<typeof grantPermissions>;
    const fullOnceOpened = {
      openWallet: (async () => {
        await (opener = grantPermissions(t, twoByTwo, holding));
        throw new WalletBusy();
      }) as OpenWallet,
      readPermission: approvedOnChain,
    };

    const again = await grantPermissions(t, twoByTwo, fullOnceOpened);
    const first = await opener;
    release();
    await walletsSettled();

    const url = 'structuredContent' in first && first.structuredContent.url;
    expect(again.content[0].text).toContain(`still waiting for the owner at ${url}`);
  });

  it('given the lease of an asked grant link lapses, then the next ask opens a new link that warns not to approve the old one', async () => {
    const { t, signer } = await connected();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer);
    let opened = 0;
    const asked: { method: string; params: unknown[] }[] = [];
    const wallet = fakeWallet(async (method, params) => {
      if (method === 'wallet_grantPermissions') await held;
      return honest(method, params);
    }, asked);
    const deps = {
      openWallet: (async (...args) => (opened++, wallet(...args))) as OpenWallet,
      readPermission: approvedOnChain,
    };
    const first = await grantPermissions(t, twoByTwo, deps);
    const url = 'structuredContent' in first && first.structuredContent.url;
    await vi.waitFor(() => expect(asked.map((a) => a.method)).toContain('wallet_grantPermissions'));

    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`now() - interval '61 seconds'` })
      .where(eq(permissionRequests.walletUrl, String(url)));
    const again = await grantPermissions(t, twoByTwo, deps);
    release();
    await walletsSettled();

    const summary = 'structuredContent' in again ? again.structuredContent.summary : again.content[0].text;
    expect(summary).toMatch(/^link_lost: /);
    expect(summary).toContain(String(url));
    expect(summary).toMatch(/not to approve/);
    expect('structuredContent' in again && again.structuredContent.url).not.toBe(url);
    expect(opened).toBe(2);
  });
});
