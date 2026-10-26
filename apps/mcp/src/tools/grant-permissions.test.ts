import { PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toFunctionSelector, type Address, type Hex } from 'viem';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type OpenWallet, type Wallet } from '@/connections/relay';
import {
  approvedOnChain,
  callTool,
  grantBudget,
  connect,
  fakeWallet,
  mcp,
  owner,
  setTestEnv,
  walletAnswers,
  walletsSettled,
  offlineSession,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { countHit } from '@/db/settings';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import type { GrantRequest } from '@/grants/permission';
import { LIVE_GRANTS_PER_CONNECTION, x402Budget } from '@/grants/store';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { onDate } from '@/lib/owner-text';
import { grantPermissions, grantStatus, type GrantInput } from './grant-permissions';
import { FOR_AGENT } from './reply';
import { sign } from './sign';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const DAY_MS = 86_400_000;

async function connected(withBudget = true) {
  const signer = owner();
  const c = await connect(signer);
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const budget = withBudget ? await grantBudget(t, signer) : undefined;
  return { c, t, signer, connectedWith: budget?.permissionId };
}

/** Every checker in these tests is deployed unless a test says otherwise. */
const deployed = async () => '0x6080' as Hex;

async function grant(
  t: Tenant,
  signer: ReturnType<typeof owner>,
  input: GrantInput,
  tamper?: (granted: Record<string, unknown>) => object,
  codeAt: (chainId: number, address: Address) => Promise<Hex | undefined> = deployed
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
    session: offlineSession,
    readPermission: approvedOnChain,
    codeAt,
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
    expect('structuredContent' in result && result.structuredContent!.summary).toContain(
      'a spend limit of 2.50 USDC a day for paid services'
    );
    expect(await newestRow(t)).toMatchObject({
      kind: 'x402-budget',
      token: USDC,
      allowance: '2500000',
      period: 'day',
    });
    expect((await x402Budget(t.connectionId))?.allowance).toBe('2500000');
  });

  it('given a budget in force, when a new one is asked, then the reply says the revoke of the current one is only tried', async () => {
    const { t, signer } = await connected();

    const { result } = await grant(t, signer, { x402Budget: { perDay: '2' } });

    const summary = 'structuredContent' in result ? result.structuredContent!.summary : '';
    expect(spoken(result)).toContain('It replaces the current spend limit.');
    expect(summary).toContain('this server tries to revoke the current spend limit on chain');
    expect(summary).toContain('stays approved on chain until it expires or jaw_revoke_permission revokes it');
    expect(summary).not.toContain('then revokes');
  });

  it('when a client lists the tools, then no description says a replaced spend limit is surely revoked, and revoking one still approved is offered', async () => {
    const { c } = await connected();

    const { json } = await mcp(c.access_token, { method: 'tools/list' });

    const described = (name: string) => json.result.tools.find((t: { name: string }) => t.name === name).description;
    expect(described('jaw_grant_permissions')).toContain('a new one replaces the current one');
    expect(described('jaw_grant_permissions')).not.toContain('then revokes');
    expect(described('jaw_revoke_permission')).toContain(
      'to clear a replaced spend limit that jaw_connections lists as still approved'
    );
  });

  it('when a client lists the tools, then it is titled for people and marked as asking, not destroying', async () => {
    const { c } = await connected();

    const { json } = await mcp(c.access_token, { method: 'tools/list' });

    const tool = json.result.tools.find((t: { name: string }) => t.name === 'jaw_grant_permissions');
    expect(tool.title).toBe('Ask the owner for a permission');
    expect(tool.annotations).toEqual({ destructiveHint: false, openWorldHint: false });
    expect(tool.description).toContain('and that they can revoke it anytime from their wallet');
    expect(tool.description).not.toContain('one tap');
  });

  it('given the x402 preset, then the owner hears the link first, then what it allows and until when, in plain words', async () => {
    const { t, signer } = await connected(false);

    const { result } = await grant(t, signer, { x402Budget: { perDay: '1' } });

    if (!('structuredContent' in result)) throw new Error('refused');
    const { url } = result.structuredContent!;
    const [link, said] = spoken(result).split('\n');
    expect(link).toBe(`Open this link to approve: ${url}`);
    expect(said).toBe(
      `It asks the owner to approve a permission for this connection: a spend limit of 1 USDC a day for paid services, until ${onDate(t.expiresAt)}, within the next 30 minutes. ` +
        'Limits are enforced on chain, and the owner can revoke it anytime from their wallet.'
    );
    expect(leaks(spoken(result))).toEqual([]);
    expect(toAgent(result)).toEqual([
      `For the agent: Show the link now with one sentence of what it allows. Then call jaw_get_grant_status with id ${result.structuredContent!.id} and waitSeconds 30, and again while it answers awaiting_owner, until ${result.structuredContent!.approveBy}. Do not wait for the owner to say they approved.`,
    ]);
  });

  it('given a custom permission, then the owner hears how many actions, on which contracts, and each limit with its token and period', async () => {
    const { t, signer } = await connected(false);

    const { result } = await grant(t, signer, twoByTwo);

    expect(spoken(result)).toContain(
      `a permission for this connection: 2 allowed actions on 2 contracts (${WETH} and ${ROUTER}) with a limit of ` +
        `500000000000000000 smallest units of the token at ${WETH} a week and 2 USDC every 2 months, until `
    );
    expect(leaks(spoken(result))).toEqual([]);
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
    expect(request?.capabilities).toEqual({ prefundSpender: true });
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
    expect('structuredContent' in result && result.structuredContent!.expiresAt).toBe(
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
    expect(leaks(spoken(result))).toEqual([]);
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

  /**
   * A checker is part of the permission the owner approves: the manager asks it to approve every
   * call the rule allows. One that can never be granted is refused before a link is made, since the
   * owner's screen could not even estimate the grant.
   */
  describe('a call checker', () => {
    const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca' as const;
    const checked = (checker: string): GrantInput => ({
      calls: [{ target: WETH, functionSignature: 'transfer(address,uint256)', checker }],
    });

    it('is asked of the wallet with the call, and the summary names it', async () => {
      const { t, signer } = await connected();

      const { result, request } = await grant(t, signer, checked(CHECKER));

      expect(request?.permissions.calls[0].checker).toBe(CHECKER);
      expect('structuredContent' in result && result.structuredContent!.summary).toContain(`checked by ${CHECKER}`);
      expect(leaks(spoken(result))).toEqual([]);
    });

    it('is no checker when it is the zero address', async () => {
      const { t, signer } = await connected();

      const { result, request } = await grant(t, signer, checked('0x0000000000000000000000000000000000000000'));

      expect(request?.permissions.calls[0].checker).toBeUndefined();
      expect('structuredContent' in result && result.structuredContent!.summary).not.toContain('checked by');
    });

    it.each([
      ['the permission manager', () => PERMISSIONS_MANAGER_ADDRESS],
      ['the account itself', (t: Tenant) => t.account],
    ])('is refused by name when it is %s, and no wallet opens', async (_name, checker) => {
      const { t, signer } = await connected();

      const { result, opened } = await grant(t, signer, checked(checker(t)));

      expect(result.content[0].text).toMatch(/^checker_refused: /);
      expect(opened).toBe(0);
    });

    it('is refused by name when nothing is deployed there, and no wallet opens', async () => {
      const { t, signer } = await connected();

      const { result, opened } = await grant(t, signer, checked(CHECKER), undefined, async () => undefined);

      expect(result.content[0].text).toMatch(/^checker_has_no_code: /);
      expect(opened).toBe(0);
    });
  });

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

    expect(result.content[0].text).toContain(
      `already holds ${LIVE_GRANTS_PER_CONNECTION} permissions, the most it can`
    );
    expect(leaks(spoken(result))).toEqual([]);
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
    const { t, signer } = await connected(false);

    await grant(t, signer, twoByTwo);

    const granted = await newestRow(t);
    expect(await requestsOf(t)).toMatchObject([{ state: 'approved', permissionId: granted.permissionId }]);
  });

  it('given a wallet answer that is not what was asked, then the link records the id it answered, so it can be revoked', async () => {
    const { t, signer } = await connected(false);
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
      session: offlineSession,
      readPermission: approvedOnChain,
    };

    const first = await grantPermissions(t, twoByTwo, deps);
    const again = await grantPermissions(t, twoByTwo, deps);
    release();
    await walletsSettled();

    expect(opened).toBe(1);
    const url = 'structuredContent' in first && first.structuredContent!.url;
    const id = 'structuredContent' in first && first.structuredContent!.id;
    expect(again.content[0].text).toMatch(/^grant_in_progress: /);
    expect(toAgent(again)[0]).toContain(`Follow ${id} with jaw_get_grant_status.`);
    expect(spoken(again).split('\n')).toEqual([
      expect.stringMatching(
        /^An earlier permission request is still waiting for the owner, so this one was not opened\. It expires in (29|30) minutes\.$/
      ),
      `To approve or decline the earlier request: ${url}`,
    ]);
    expect(again.content[0].text).toContain(`\nTo approve or decline the earlier request: ${url}\n`);
    expect(toAgent(again)).toHaveLength(1);
    expect(toAgent(again)[0]).toContain(
      'This link is for the earlier request, not the one just asked for: never present it as the new one.'
    );
    expect(toAgent(again)[0]).toContain(
      'Once the earlier request is approved, declined or expired, ask for the new one again'
    );
    expect(leaks(spoken(again))).toEqual([]);
  });

  it('given the waiting grant has a saved relay session and its lease lapsed inside the stall grace, when asked again, then the refusal says the server is reconnecting', async () => {
    const { t, signer } = await connected();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer);
    const deps = {
      openWallet: fakeWallet(async (method, params) => (await held, honest(method, params))) as OpenWallet,
      readPermission: approvedOnChain,
      session: offlineSession,
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
    expect(again.content[0].text).toContain(
      'An earlier permission request is still open for the owner, so this one was not opened.'
    );
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
      session: offlineSession,
    };
    let opener!: ReturnType<typeof grantPermissions>;
    const fullOnceOpened = {
      openWallet: (async () => {
        await (opener = grantPermissions(t, twoByTwo, holding));
        throw new WalletBusy();
      }) as OpenWallet,
      readPermission: approvedOnChain,
      session: offlineSession,
    };

    const again = await grantPermissions(t, twoByTwo, fullOnceOpened);
    const first = await opener;
    release();
    await walletsSettled();

    const url = 'structuredContent' in first && first.structuredContent!.url;
    expect(again.content[0].text).toContain(
      'An earlier permission request is still waiting for the owner, so this one was not opened. It expires in'
    );
    expect(again.content[0].text).toContain(`\nTo approve or decline the earlier request: ${url}\n`);
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
      session: offlineSession,
      readPermission: approvedOnChain,
    };
    const first = await grantPermissions(t, twoByTwo, deps);
    const url = 'structuredContent' in first && first.structuredContent!.url;
    await vi.waitFor(() => expect(asked.map((a) => a.method)).toContain('wallet_grantPermissions'));

    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`now() - interval '61 seconds'` })
      .where(eq(permissionRequests.walletUrl, String(url)));
    const again = await grantPermissions(t, twoByTwo, deps);
    release();
    await walletsSettled();

    const summary = 'structuredContent' in again ? again.structuredContent!.summary : again.content[0].text;
    const newUrl = 'structuredContent' in again && again.structuredContent!.url;
    expect(summary.split('\n')[0]).toBe(`Open this link to approve: ${newUrl}`);
    expect(summary).not.toMatch(/link_lost: /);
    // The owner is told to leave the lost link alone; the lost link itself is for the agent.
    expect(spoken(again)).toContain(
      'An earlier permission link stopped working, so an answer given there may never arrive. If it is still open, do not approve it there.'
    );
    expect(spoken(again)).not.toContain(String(url));
    expect(toAgent(again).join('\n')).toContain(`The earlier link ${url} answers link_lost.`);
    expect(toAgent(again).join('\n')).toContain(
      'A permission approved on the earlier link can go live on chain without this server recording it'
    );
    expect(leaks(spoken(again))).toEqual([]);
    expect(newUrl).not.toBe(url);
    expect(opened).toBe(2);
  });
});

describe('jaw_get_grant_status', () => {
  const POLL_MS = 20;
  const status = (t: Tenant, id: string, waitSeconds = 0) => grantStatus(t, { id, waitSeconds }, { pollMs: POLL_MS });

  const idleWallet: OpenWallet = async (): Promise<Wallet> => ({
    url: `http://keys.test/cli-bridge?session=idle-${randomBytes(4).toString('hex')}`,
    run: () => new Promise(() => {}),
    close: () => {},
  });

  /** Opens a grant link whose wallet answers only once released. */
  async function gated(
    t: Tenant,
    signer: ReturnType<typeof owner>,
    input: GrantInput = twoByTwo,
    refuse: string[] = []
  ) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const honest = walletAnswers(signer, refuse);
    const first = await grantPermissions(t, input, {
      openWallet: fakeWallet(async (method, params) => {
        if (method === 'wallet_grantPermissions') await held;
        return honest(method, params);
      }),
      session: offlineSession,
      readPermission: approvedOnChain,
    });
    if (!('structuredContent' in first)) throw new Error('refused');
    return { first: first.structuredContent!, release };
  }

  async function idle(t: Tenant) {
    const first = await grantPermissions(t, twoByTwo, {
      openWallet: idleWallet,
      session: offlineSession,
      readPermission: approvedOnChain,
    });
    if (!('structuredContent' in first)) throw new Error('refused');
    return first.structuredContent!;
  }

  const setRow = (id: string, set: Parameters<ReturnType<ReturnType<typeof getDb>['update']>['set']>[0]) =>
    getDb().update(permissionRequests).set(set).where(eq(permissionRequests.id, id));

  it('given a new grant, then its reply carries an id the status tool follows, waiting for the owner, with the link', async () => {
    const { t, signer } = await connected();
    const { first, release } = await gated(t, signer);

    expect(first).toMatchObject({
      id: expect.stringMatching(/^pr_[A-Za-z0-9_-]{22}$/),
      state: 'awaiting_owner',
      kind: 'custom',
    });
    expect(first.url).toMatch(/^http:\/\/keys\.test\//);
    expect(first.summary).not.toContain('jaw_session_status');
    expect((await status(t, first.id)).structuredContent).toMatchObject({
      id: first.id,
      state: 'awaiting_owner',
      url: first.url,
      approveBy: first.approveBy,
    });
    release();
    await walletsSettled();
  });

  it('given a grant awaiting the owner, when the owner approves mid-wait, then it answers approved with the permission now in force', async () => {
    const { t, signer } = await connected();
    const { first, release } = await gated(t, signer);
    setTimeout(release, 150);

    const started = Date.now();
    const result = await status(t, first.id, 10);
    await walletsSettled();

    expect(Date.now() - started).toBeLessThan(5_000);
    const granted = await newestRow(t);
    expect(result.structuredContent).toMatchObject({ state: 'approved', permissionId: granted.permissionId });
    expect(result.structuredContent!.url).toBeUndefined();
    expect(result.structuredContent!.refusal).toBeUndefined();
    expect(spoken(result)).toBe(`The owner approved the permission. It is in force until ${onDate(t.expiresAt)}.`);
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Its permission id is ${granted.permissionId}. Run the actions it allows with jaw_session_execute.`,
    ]);
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given a status read while the owner has not answered, then it asks for another wait and keeps the link for the agent only', async () => {
    const { t, signer } = await connected();
    const { first, release } = await gated(t, signer);

    const result = await status(t, first.id);

    expect(spoken(result)).toMatch(
      /^Still waiting for the owner to approve the permission\. It expires in (29|30) minutes\.$/
    );
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Call jaw_get_grant_status again with id ${first.id} and waitSeconds 30 until ${first.approveBy}. If the owner asks for the link, show it: ${first.url}`,
    ]);
    expect(result.structuredContent!.summary).not.toContain('Open this link');
    release();
    await walletsSettled();
  });

  it('given the owner declines, then owner_declined with no link and no permission', async () => {
    const { t, signer } = await connected();
    const { first, release } = await gated(t, signer, twoByTwo, ['wallet_grantPermissions']);
    release();
    await walletsSettled();

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'owner_declined', refusal: { code: 'owner_declined' } });
    expect(result.structuredContent!.url).toBeUndefined();
    expect(result.structuredContent!.permissionId).toBeUndefined();
    expect(spoken(result)).toBe('The owner declined the permission. Nothing changed.');
  });

  it('given a link nobody answered past its window, then expired, without claiming nothing was granted', async () => {
    const { t } = await connected();
    const first = await idle(t);
    await setRow(first.id, { approveBy: sql`now() - interval '1 second'` });

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'expired' } });
    // An approval in the last moments can land on chain after the window, so the owner is not told nothing changed.
    expect(spoken(result)).toBe('The owner did not approve within 30 minutes.');
    expect(toAgent(result)[0]).toContain('jaw_get_permissions lists the account');
  });

  it('given a link whose process stopped renewing it before the owner was asked, then expired with session_lost', async () => {
    const { t } = await connected();
    const first = await idle(t);
    await setRow(first.id, { sessionUntil: sql`statement_timestamp() - interval '5 minutes'` });

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'session_lost' } });
    expect(spoken(result)).toBe('The permission link stopped working before the owner saw it. Nothing changed.');
  });

  it('given a link lost after the owner was asked, then expired with link_lost, and the agent learns how a permission approved there ends', async () => {
    const { t } = await connected();
    const first = await idle(t);
    await setRow(first.id, { code: 'asked', sessionUntil: sql`statement_timestamp() - interval '5 minutes'` });

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'link_lost' } });
    expect(spoken(result)).toBe(
      'The permission link stopped working after the owner opened it, so an answer given there may never arrive. If it is still open, do not approve it there.'
    );
    expect(toAgent(result)[0]).toContain('only jaw_revoke_permission with its id from the wallet ends it');
  });

  it('given a wallet answer that is not what was asked, then failed with the permission it answered, named for revoking', async () => {
    const { t, signer } = await connected();
    let answered: string | undefined;
    const { result: first } = await grant(t, signer, twoByTwo, (granted) => {
      answered = granted.permissionId as string;
      return { ...granted, spends: [] };
    });
    if (!('structuredContent' in first)) throw new Error('refused');

    const result = await status(t, first.structuredContent!.id);

    expect(result.structuredContent).toMatchObject({
      state: 'failed',
      permissionId: answered,
      refusal: { code: 'grant_mismatch' },
    });
    expect(spoken(result)).toBe(
      'The wallet approved a permission this server could not record, so it may be in force on chain without this connection using it.'
    );
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} The request ended with grant_mismatch. Revoke ${answered} with jaw_revoke_permission, then ask again if the owner still wants it.`,
    ]);
  });

  it('given a new spend limit approved while the one it replaced is still approved on chain, then the agent hears so until its revoke lands', async () => {
    const { t, signer, connectedWith } = await connected();
    const { result: first } = await grant(t, signer, { x402Budget: { perDay: '2' } });
    if (!('structuredContent' in first)) throw new Error('refused');
    const id = first.structuredContent!.id;

    const before = await status(t, id);

    expect(before.structuredContent).toMatchObject({ state: 'approved', kind: 'x402-budget' });
    expect(spoken(before)).toBe(
      `The owner approved the spend limit for paid services. It is in force until ${onDate(t.expiresAt)}.`
    );
    expect(toAgent(before)[0]).toContain('The spend limit it replaced is still approved on chain');
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, connectedWith!));

    const after = await status(t, id);

    expect(toAgent(after)[0]).not.toContain('The spend limit it replaced');
    expect(toAgent(after)[0]).toContain('payments draw from it now');
  });

  it('given a spend limit a newer one replaced, then its status says so and not that payments draw from it', async () => {
    const { t, signer } = await connected();
    const { result: older } = await grant(t, signer, { x402Budget: { perDay: '2' } });
    await grant(t, signer, { x402Budget: { perDay: '3' } });
    if (!('structuredContent' in older)) throw new Error('refused');

    const result = await status(t, older.structuredContent!.id);

    expect(result.structuredContent!.state).toBe('approved');
    expect(spoken(result)).toBe(
      'The owner approved the spend limit for paid services, and a newer one has since replaced it.'
    );
    expect(toAgent(result)[0]).not.toContain('payments draw from it');
    expect(toAgent(result)[0]).not.toContain('The spend limit it replaced');
  });

  it('given an approved permission revoked since, then its status says it was revoked, not that it is in force', async () => {
    const { t, signer } = await connected();
    const { result: first } = await grant(t, signer, twoByTwo);
    if (!('structuredContent' in first)) throw new Error('refused');
    const granted = await newestRow(t);
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, granted.permissionId));

    const result = await status(t, first.structuredContent!.id);

    expect(spoken(result)).toBe('The owner approved the permission, and it has since been revoked.');
    expect(toAgent(result)[0]).not.toContain('jaw_session_execute');
  });

  it('given an approved permission past its end, then its status says it expired', async () => {
    const { t, signer } = await connected();
    const { result: first } = await grant(t, signer, twoByTwo);
    if (!('structuredContent' in first)) throw new Error('refused');
    const granted = await newestRow(t);
    await getDb()
      .update(grants)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(grants.permissionId, granted.permissionId));

    expect(spoken(await status(t, first.structuredContent!.id))).toBe(
      'The owner approved the permission, and it has since expired.'
    );
  });

  it('given an approval from another account than the connected one, then failed without pointing at a revoke that would refuse it', async () => {
    const { t } = await connected();
    const first = await idle(t);
    const other = `0x${'ab'.repeat(32)}`;
    await setRow(first.id, { state: 'failed', code: 'wrong_account', permissionId: other, relay: null });

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'failed', refusal: { code: 'wrong_account' } });
    expect(spoken(result)).toBe(
      'The owner approved with another account than the one connected here, so nothing was recorded for this connection.'
    );
    expect(toAgent(result)[0]).toContain(`That account can revoke ${other} from its own wallet.`);
    expect(toAgent(result)[0]).not.toContain('jaw_revoke_permission');
  });

  it('given a wallet that could not grant, then failed with the code it answered and nothing said to be in force', async () => {
    const { t } = await connected();
    const first = await idle(t);
    await setRow(first.id, { state: 'failed', code: 'wallet_error:4100' });

    const result = await status(t, first.id);

    expect(result.structuredContent).toMatchObject({ state: 'failed', refusal: { code: 'wallet_error:4100' } });
    expect(result.structuredContent!.permissionId).toBeUndefined();
    expect(spoken(result)).toBe('The wallet could not approve this permission. Nothing changed.');
    expect(toAgent(result)[0]).toContain('The request ended with wallet_error:4100.');
  });

  it('given a waiting link that replaced one lost after the owner was asked, then its status warns not to approve the lost one', async () => {
    const { t } = await connected();
    const lost = await idle(t);
    await setRow(lost.id, { code: 'asked', sessionUntil: sql`statement_timestamp() - interval '5 minutes'` });
    const first = await idle(t);

    const result = await status(t, first.id);

    expect(result.structuredContent!.state).toBe('awaiting_owner');
    expect(spoken(result)).toContain(
      'An earlier permission link stopped working, so an answer given there may never arrive. If it is still open, do not approve it there.'
    );
    expect(toAgent(result).join('\n')).toContain(`The earlier link ${lost.url} answers link_lost.`);
  });

  it('given a waiting link whose server is rejoining it, then its status says the server is reconnecting', async () => {
    const { t } = await connected();
    const first = await idle(t);
    // Inside the stall grace no rejoin starts, so the read sees the row exactly as written.
    await setRow(first.id, { relay: 'saved', sessionUntil: sql`now() - interval '30 seconds'` });

    const result = await status(t, first.id);

    expect(result.structuredContent!.state).toBe('awaiting_owner');
    expect(toAgent(result)[0]).toContain('reconnecting to the owner');
  });

  it("given another connection's grant id, then not_found, in plain words for the owner", async () => {
    const other = await connected();
    const { t } = await connected();
    const first = await idle(t);

    const result = await status(other.t, first.id);

    expect(result.content[0].text).toMatch(/^not_found: /);
    expect(spoken(result)).toBe('That permission request was not found on this connection.');
  });

  it('given the id of a sign request on the same connection, then not_found', async () => {
    const { t } = await connected();
    const signed = await sign(t, { message: 'hello', idempotencyKey: 'grant-status' }, { openWallet: idleWallet });

    expect((await status(t, signed.structuredContent!.id)).content[0].text).toMatch(/^not_found: /);
  });

  it('given 30 grant status reads in the last minute on the connection, then the next is rate_limited', async () => {
    const { t } = await connected();
    const first = await idle(t);
    for (let i = 0; i < 30; i++) await countHit(`owner-grant-status:${t.connectionId}`, RATE_WINDOW_MS);

    expect((await status(t, first.id)).content[0].text).toMatch(/^rate_limited: /);
  });

  it('given the tools list, then jaw_get_grant_status is titled, read-only, and takes an id and a bounded wait', async () => {
    const { c } = await connected();

    const { json } = await mcp(c.access_token, { method: 'tools/list' });

    const tool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_get_grant_status');
    expect(tool.title).toBe('Check a permission request');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.inputSchema.properties.waitSeconds).toMatchObject({ maximum: 45 });
    expect(tool.inputSchema.required).toEqual(['id']);
    const grantTool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_grant_permissions');
    expect(grantTool.description).toContain('Then call jaw_get_grant_status with the id and waitSeconds 30');
    expect(grantTool.description).not.toContain('jaw_session_status');
  });
});
