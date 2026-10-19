import { randomBytes } from 'node:crypto';
import type { GrantedPermission } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import { toFunctionSelector, type Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
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

/** The chain as the permission manager answers it, revoked once the owner's wallet revokes. */
function chainOf() {
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

function setup(signer: ReturnType<typeof owner>, lookUp: LookUp = async () => 'not_found') {
  const chain = chainOf();
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
    return { openWallet, readPermission: chain.read, lookUp, settleMs: 1 };
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

  it('given an id no permission of this account has, then it is refused by name and no wallet opens', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    const result = await revokePermission(t, { permissionId: randomId() }, deps());

    expect(result.content[0].text).toMatch(/^unknown_permission: /);
    expect(opened()).toBe(0);
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

  it('given a revoke still waiting for the owner, when asked again from any connection, then the same link comes back and no other opens', async () => {
    const signer = owner();
    const { t, budget } = await connected(signer);
    const other = await connected(signer, 'wallet:read');
    const { deps, opened } = setup(signer);
    const wait = held();

    const first = await revokePermission(t, { permissionId: budget }, deps({ held: wait.promise }));
    const again = await revokePermission(other.t, { permissionId: budget }, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(1);
    expect(urlOf(again)).toBe(urlOf(first));
  });

  it('given the process holding a waiting revoke died, then the link is let go and a new ask opens a fresh one', async () => {
    const { t, signer, budget } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const first = await revokePermission(t, { permissionId: budget }, deps({ held: wait.promise }));
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`now() - interval '1 second'` })
      .where(eq(permissionRequests.walletUrl, urlOf(first)!));

    const again = await revokePermission(t, { permissionId: budget }, deps());
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(2);
    expect(urlOf(again)).not.toBe(urlOf(first));
    const rows = await requestsOf(budget);
    expect(rows.find((r) => r.walletUrl === urlOf(first))).toMatchObject({ state: 'expired', code: 'session_lost' });
    expect(rows.find((r) => r.walletUrl === urlOf(again))).toMatchObject({ state: 'approved' });
  });

  it('given three grant and revoke links waiting on the account, then a fourth link of any kind is refused', async () => {
    const signer = owner();
    const [a, b, c] = [await connected(signer), await connected(signer), await connected(signer)];
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    const grantWallet: OpenWallet = (...args) => holding.openWallet(...args);

    await revokePermission(a.t, { permissionId: a.budget }, holding);
    await revokePermission(a.t, { permissionId: b.budget }, holding);
    await grantPermissions(
      c.t,
      { x402Budget: { perDay: '1' } },
      { openWallet: grantWallet, readPermission: approvedOnChain }
    );
    const revoke = await revokePermission(b.t, { permissionId: c.budget }, holding);
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
