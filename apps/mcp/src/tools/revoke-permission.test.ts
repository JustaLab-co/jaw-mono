import { randomBytes } from 'node:crypto';
import type { GrantedPermission } from '@jaw.id/agent';
import { and, eq, sql } from 'drizzle-orm';
import { toFunctionSelector, type Hex } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { OpenWallet } from '@/connections/relay';
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
import type { ReadPermission } from '@/grants/permission';
import { x402Budget } from '@/grants/store';
import { grantPermissions } from './grant-permissions';
import { sendCalls } from './owner-calls';
import { revokePermission, type LookUp, type RevokeDeps } from './revoke-permission';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE = 8453;
const randomId = () => `0x${randomBytes(32).toString('hex')}` as Hex;

const tenantOf = async (token: string) => (await verifyBearer(token))?.extra?.tenant as Tenant;

async function connected(signer = owner(), scope?: string) {
  const c = await connect(signer, scope ? { scope } : {});
  const t = await tenantOf(c.access_token);
  return { c, t, signer, budget: (await x402Budget(t.connectionId))?.permissionId as Hex };
}

function fakeChain() {
  const revoked = new Set<string>();
  const read: ReadPermission = async ({ permissionId }) => ({
    status: 'ok',
    approved: true,
    revoked: revoked.has(permissionId.toLowerCase()),
  });
  return { revoked, read };
}

interface WalletOptions {
  decline?: boolean;
  held?: Promise<void>;
  signer?: ReturnType<typeof owner>;
}

/** JAW's permission store, holding every permission this server recorded. */
const storeOfGrants: LookUp = async (id) => {
  const row = await grantRow(id);
  return row ? { permission: row.permission as GrantedPermission, chainId: row.chainId } : 'not_found';
};

function setup(signer: ReturnType<typeof owner>, lookUp: LookUp = storeOfGrants) {
  const chain = fakeChain();
  const asked: { method: string; params: unknown[] }[] = [];
  let opened = 0;
  const deps = (o: WalletOptions = {}): RevokeDeps => {
    const answers = walletAnswers(o.signer ?? signer, o.decline ? ['wallet_revokePermissions'] : []);
    const wallet = fakeWallet(async (method, params) => {
      await o.held;
      if (method === 'wallet_revokePermissions' && !o.decline) {
        chain.revoked.add((params[0] as { id: string }).id.toLowerCase());
        return { success: true };
      }
      return answers(method, params);
    }, asked);
    const openWallet: OpenWallet = async (...args) => (opened++, wallet(...args));
    return { openWallet, readPermission: chain.read, lookUp, rereadMs: 1 };
  };
  return { chain, asked, deps, opened: () => opened };
}

function held() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const requestsOf = (permissionId: string) =>
  getDb()
    .select()
    .from(permissionRequests)
    .where(sql`lower(${permissionRequests.permissionId}) = ${permissionId.toLowerCase()}`);

const grantRow = async (permissionId: string) =>
  (await getDb().select().from(grants).where(eq(grants.permissionId, permissionId)))[0];

const urlOf = (r: Awaited<ReturnType<typeof revokePermission>>) =>
  'structuredContent' in r ? r.structuredContent?.url : undefined;

const orphanOf = (account: Hex, end = Math.floor(Date.now() / 1000) + 86_400): GrantedPermission => ({
  account,
  spender: `0x${randomBytes(20).toString('hex')}`,
  start: Math.floor(Date.now() / 1000) - 60,
  end,
  salt: '0x01',
  calls: [{ target: USDC, selector: toFunctionSelector('transfer(address,uint256)') }],
  spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }],
});

describe('jaw_revoke_permission', () => {
  it("given this connection's own budget, when the owner revokes it, then the chain shows it revoked and payments have no budget left", async () => {
    const { t, signer, budget } = await connected();
    const { deps, asked, chain } = setup(signer);

    const result = await revokePermission(t, { permissionId: budget }, deps());
    await walletsSettled();

    expect(urlOf(result)).toMatch(/cli-bridge/);
    expect(asked.find((a) => a.method === 'wallet_revokePermissions')?.params).toEqual([
      { id: budget, address: t.account },
    ]);
    expect(chain.revoked.has(budget.toLowerCase())).toBe(true);
    expect((await grantRow(budget)).revokedAt).not.toBeNull();
    expect(await x402Budget(t.connectionId)).toBeUndefined();
    expect(await requestsOf(budget)).toMatchObject([{ method: 'revoke', state: 'approved' }]);
  });

  it("given another connection's grant on the account, then it is revoked and jaw_connections lists it revoked", async () => {
    const signer = owner();
    const other = await connected(signer);
    const me = await connected(signer, 'wallet:read');
    const { deps } = setup(signer);

    const result = await revokePermission(me.t, { permissionId: other.budget }, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent?.connection).toBe(other.t.connectionId);
    const listed = await callTool(me.c.access_token, 'jaw_connections', {});
    const theirs = (listed.structuredContent.connections as { id: string; grants: object[] }[]).find(
      (c) => c.id === other.t.connectionId
    );
    expect(theirs?.grants).toMatchObject([{ permissionId: other.budget, kind: 'x402-budget', status: 'revoked' }]);
  });

  it('given a permission granted on chain that this server never recorded, then it is found in the permission store and revoked', async () => {
    const { t, signer } = await connected();
    const id = randomId();
    const { deps, chain } = setup(signer, async (asked) =>
      asked === id ? { permission: orphanOf(t.account), chainId: t.chainId } : 'not_found'
    );

    const result = await revokePermission(t, { permissionId: id }, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent?.connection).toBeNull();
    expect(chain.revoked.has(id)).toBe(true);
    expect(await requestsOf(id)).toMatchObject([{ state: 'approved', connectionId: t.connectionId }]);
  });

  it('given a grant the wallet answered but this server did not record, when it is revoked, then jaw_connections stops listing it as unrecorded', async () => {
    const { c, t, signer } = await connected();
    const id = randomId();
    await getDb()
      .insert(permissionRequests)
      .values({
        id: `pr_${t.connectionId}_orphan`,
        connectionId: t.connectionId,
        method: 'grant',
        chainId: t.chainId,
        account: t.account,
        permissionId: id,
        state: 'failed',
        code: 'not_recorded',
        walletUrl: 'http://keys.test/cli-bridge',
        approveBy: new Date(),
      });
    const unrecorded = async () =>
      (
        (await callTool(c.access_token, 'jaw_connections', {})).structuredContent.connections as {
          unrecorded: string[];
        }[]
      )[0].unrecorded;
    expect(await unrecorded()).toEqual([id]);
    const { deps } = setup(signer, async () => ({ permission: orphanOf(t.account), chainId: t.chainId }));

    await revokePermission(t, { permissionId: id }, deps());
    await walletsSettled();

    expect(await unrecorded()).toEqual([]);
  });

  it('given an id no permission of this account has, then it is refused by name and no wallet opens', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    const result = await revokePermission(t, { permissionId: randomId() }, deps());

    expect(result.content[0].text).toMatch(/^unknown_permission: /);
    expect(opened()).toBe(0);
  });

  it('given a recorded grant the permission store does not hold, then it is refused by name and no wallet opens', async () => {
    const { t, signer, budget } = await connected();
    const { deps, opened } = setup(signer, async () => 'not_found');

    const result = await revokePermission(t, { permissionId: budget }, deps());

    expect(result.content[0].text).toMatch(/^not_in_store: /);
    expect(opened()).toBe(0);
  });

  it('given this connection already waits on a revoke of another permission, then a second is refused and no wallet opens', async () => {
    const signer = owner();
    const mine = await connected(signer);
    const other = await connected(signer);
    const { deps, opened } = setup(signer);
    const wait = held();

    await revokePermission(mine.t, { permissionId: mine.budget }, deps({ held: wait.promise }));
    const second = await revokePermission(mine.t, { permissionId: other.budget }, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    expect(second.content[0].text).toMatch(/^revoke_in_progress: /);
    expect(opened()).toBe(1);
  });

  it('given three revokes of different permissions from one connection racing past the first check, then one link opens and the others are refused', async () => {
    const { t, signer } = await connected(owner(), 'wallet:read');
    const ids = [randomId(), randomId(), randomId()];
    const { deps } = setup(signer, async () => ({ permission: orphanOf(t.account), chainId: t.chainId }));
    const wait = held();
    const holding = deps({ held: wait.promise });
    const allChecked = Promise.withResolvers<void>();
    let checked = 0;
    const openWallet: OpenWallet = async (...args) => {
      if (++checked === ids.length) allChecked.resolve();
      await allChecked.promise;
      return holding.openWallet(...args);
    };

    const results = await Promise.all(
      ids.map((permissionId) => revokePermission(t, { permissionId }, { ...holding, openWallet }))
    );
    const open = await getDb()
      .select()
      .from(permissionRequests)
      .where(and(eq(permissionRequests.connectionId, t.connectionId), eq(permissionRequests.state, 'awaiting_owner')));
    wait.release();
    await walletsSettled();

    expect(open).toHaveLength(1);
    expect(results.filter((r) => urlOf(r))).toHaveLength(1);
    expect(results.filter((r) => /^revoke_in_progress: /.test(r.content[0].text))).toHaveLength(2);
  });

  it.each<[string, (t: Tenant, deps: RevokeDeps) => RevokeDeps]>([
    ['the permission store cannot be read', (_t, deps) => ({ ...deps, lookUp: async () => 'unavailable' })],
    [
      'the chain cannot be read',
      (t, deps) => ({
        ...deps,
        lookUp: async () => ({ permission: orphanOf(t.account), chainId: t.chainId }),
        readPermission: async () => ({ status: 'unavailable' }),
      }),
    ],
    [
      'the permission already ended',
      (t, deps) => ({ ...deps, lookUp: async () => ({ permission: orphanOf(t.account, 1_000), chainId: t.chainId }) }),
    ],
  ])('given %s, then it is refused by name and no wallet opens', async (_name, change) => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    const result = await revokePermission(t, { permissionId: randomId() }, change(t, deps()));

    expect(result.content[0].text).toMatch(/^(lookup_unavailable|chain_unreadable|expired): /);
    expect(opened()).toBe(0);
  });

  it('given the wallet revoked but the chain does not show it yet, then the request reads approved and unconfirmed', async () => {
    const { t, signer, budget } = await connected();
    const { deps } = setup(signer);
    const fresh = deps();
    let reads = 0;
    const lagging: RevokeDeps = {
      ...fresh,
      readPermission: async () => ({ status: 'ok', approved: true, revoked: reads++ > 100 }),
    };

    await revokePermission(t, { permissionId: budget }, lagging);
    await walletsSettled();

    expect(await requestsOf(budget)).toMatchObject([{ state: 'approved', code: 'unconfirmed' }]);
    expect((await grantRow(budget)).revokedAt).toBeNull();
  });

  it('given an unconfirmed revoke the chain now shows, when asked again, then the request and the grant settle revoked with no new link', async () => {
    const { t, signer, budget } = await connected();
    const { deps, chain, opened } = setup(signer);
    const fresh = deps();
    const lagging: RevokeDeps = {
      ...fresh,
      readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
    };
    await revokePermission(t, { permissionId: budget }, lagging);
    await walletsSettled();
    chain.revoked.add(budget.toLowerCase());

    const again = await revokePermission(t, { permissionId: budget }, fresh);

    expect(again.content[0].text).toMatch(/^already_revoked: /);
    expect(opened()).toBe(1);
    expect(await requestsOf(budget)).toMatchObject([{ state: 'approved', code: null }]);
    expect((await grantRow(budget)).revokedAt).not.toBeNull();
  });

  it("given another account's grant, then it is refused as unknown and no wallet opens", async () => {
    const theirs = await connected();
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer, async () => ({
      permission: orphanOf(theirs.t.account),
      chainId: t.chainId,
    }));

    const result = await revokePermission(t, { permissionId: theirs.budget }, deps());

    expect(result.content[0].text).toMatch(/^unknown_permission: /);
    expect(opened()).toBe(0);
    expect((await grantRow(theirs.budget)).revokedAt).toBeNull();
  });

  it('given a chain the permission was not granted on, then it is refused by name and no wallet opens', async () => {
    const { t, signer, budget } = await connected();
    const { deps, opened } = setup(signer);

    const result = await revokePermission(t, { permissionId: budget, chainId: BASE }, deps());

    expect(result.content[0].text).toMatch(/^wrong_chain: /);
    expect(opened()).toBe(0);
  });

  it('given the owner declines in the wallet, then the grant stays live and the request reads declined', async () => {
    const { t, signer, budget } = await connected();
    const { deps } = setup(signer);

    await revokePermission(t, { permissionId: budget }, deps({ decline: true }));
    await walletsSettled();

    expect((await grantRow(budget)).revokedAt).toBeNull();
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(budget);
    expect(await requestsOf(budget)).toMatchObject([{ state: 'owner_declined' }]);
  });

  it('given the wallet is signed in to another account, then nothing is revoked', async () => {
    const { t, signer, budget } = await connected();
    const { deps, asked } = setup(signer);

    await revokePermission(t, { permissionId: budget }, deps({ signer: owner() }));
    await walletsSettled();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    expect((await grantRow(budget)).revokedAt).toBeNull();
    expect(await requestsOf(budget)).toMatchObject([{ state: 'failed', code: 'wrong_account' }]);
  });

  it('given a permission already revoked on chain, then it is refused by name, marked revoked, and no wallet opens', async () => {
    const { t, signer, budget } = await connected();
    const { deps, chain, opened } = setup(signer);
    chain.revoked.add(budget.toLowerCase());

    const result = await revokePermission(t, { permissionId: budget }, deps());

    expect(result.content[0].text).toMatch(/^already_revoked: /);
    expect(opened()).toBe(0);
    expect((await grantRow(budget)).revokedAt).not.toBeNull();
  });

  it('given a revoke still waiting for the owner, when this connection asks again, then the same link comes back, and another app gets no link', async () => {
    const signer = owner();
    const { t, budget } = await connected(signer);
    const other = await connected(signer, 'wallet:read');
    const { deps, opened } = setup(signer);
    const wait = held();

    const first = await revokePermission(t, { permissionId: budget }, deps({ held: wait.promise }));
    const again = await revokePermission(t, { permissionId: budget }, deps({ held: wait.promise }));
    const theirs = await revokePermission(other.t, { permissionId: budget }, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(1);
    expect(urlOf(again)).toBe(urlOf(first));
    expect(theirs.content[0].text).toMatch(/^revoke_in_progress: /);
    expect(urlOf(theirs)).toBeUndefined();
  });

  it('given the process holding a waiting revoke stopped renewing its lease, then a new ask opens a fresh link and the old session never asks the wallet', async () => {
    const { t, signer, budget } = await connected();
    const { deps, opened, asked } = setup(signer);
    const wait = held();
    const first = await revokePermission(t, { permissionId: budget }, deps({ held: wait.promise }));
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`now() - interval '1 second'` })
      .where(eq(permissionRequests.walletUrl, urlOf(first)!));

    const again = await revokePermission(t, { permissionId: budget }, deps());
    const lost = (await requestsOf(budget)).find((r) => r.walletUrl === urlOf(first));
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(2);
    expect(urlOf(again)).not.toBe(urlOf(first));
    expect(lost).toMatchObject({ state: 'expired', code: 'session_lost' });
    expect(asked.filter((a) => a.method === 'wallet_revokePermissions')).toHaveLength(1);
  });

  it('given the session already asked the owner when its lease lapsed, then the next ask opens a new link that names the lost one, and an answer in the first still settles', async () => {
    const { t, signer, budget } = await connected();
    const { deps, opened, chain } = setup(signer);
    const answers = walletAnswers(signer);
    const asked: { method: string; params: unknown[] }[] = [];
    const wait = held();
    const wallet = fakeWallet(async (method, params) => {
      if (method !== 'wallet_revokePermissions') return answers(method, params);
      await wait.promise;
      chain.revoked.add(budget.toLowerCase());
      return { success: true };
    }, asked);
    const holding = deps();
    const first = await revokePermission(t, { permissionId: budget }, { ...holding, openWallet: wallet });
    await vi.waitFor(() => expect(asked.map((a) => a.method)).toContain('wallet_revokePermissions'));
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`now() - interval '1 second'` })
      .where(eq(permissionRequests.walletUrl, urlOf(first)!));

    const again = await revokePermission(t, { permissionId: budget }, holding);
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(1);
    expect(urlOf(again)).not.toBe(urlOf(first));
    expect(again.content[0].text).toMatch(/link_lost: /);
    expect(again.content[0].text).toContain(urlOf(first));
    const firstRow = (await requestsOf(budget)).find((r) => r.walletUrl === urlOf(first));
    expect(firstRow).toMatchObject({ state: 'approved' });
    expect((await grantRow(budget)).revokedAt).not.toBeNull();
  });

  it('given three grant and revoke links waiting on the account, then a fourth link of any kind is refused', async () => {
    const signer = owner();
    const [a, b, c] = [await connected(signer), await connected(signer), await connected(signer)];
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    const grantWallet: OpenWallet = (...args) => holding.openWallet(...args);

    await revokePermission(a.t, { permissionId: a.budget }, holding);
    await revokePermission(b.t, { permissionId: b.budget }, holding);
    await grantPermissions(
      c.t,
      { x402Budget: { perDay: '1' } },
      { openWallet: grantWallet, readPermission: approvedOnChain }
    );
    const revoke = await revokePermission(c.t, { permissionId: c.budget }, holding);
    const send = await sendCalls(
      c.t,
      { calls: [{ to: USDC }] },
      {
        openWallet: holding.openWallet,
        receipt: async () => null,
        clients: {} as never,
      }
    );
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(3);
    expect(revoke.content[0].text).toMatch(/^account_busy: /);
    expect(send.content[0].text).toMatch(/^account_busy: /);
  });
});
