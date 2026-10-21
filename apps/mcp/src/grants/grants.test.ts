import { PERMISSION_MANAGER_ABI, type PermissionState } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFunctionData, erc20Abi } from 'viem';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  grantBudget,
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  owner,
  sessionFakes,
  setTestEnv,
  walletAnswers,
  walletsSettled,
  offlineSession,
} from '@/connections/testkit';
import type { DisconnectDeps } from '@/connections/disconnect';
import { spends } from '@/connections/scopes';
import { getDb } from '@/db/client';
import { connections, grants, payments, permissionRequests, settings } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { endConnection } from '@/connections/rows';
import { WalletBusy, type OpenWallet, type Wallet } from '@/connections/relay';
import { grantPermissions, retryReplacedRevokes } from '@/tools/grant-permissions';
import { NO_PAY_SCOPE } from '@/tools/reply';
import {
  budgetGrant,
  checkGranted,
  recordGrant,
  type GrantRequest,
  type NewGrant,
  type ReadPermission,
} from './permission';
import { liveGrants, LIVE_GRANTS_PER_CONNECTION, x402Budget } from './store';
import { withFloat } from '@/payments/float-lock';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const revokedAt = async (permissionId: string | undefined) =>
  (
    await getDb()
      .select()
      .from(grants)
      .where(eq(grants.permissionId, permissionId as string))
  )[0].revokedAt;

const onChain =
  (state: PermissionState): ReadPermission =>
  async () =>
    state;

async function connected(scope = 'wallet:read x402:pay') {
  const signer = owner();
  const c = await connect(signer, { scope });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const budget = spends(t.scopes) ? await grantBudget(t, signer) : undefined;
  return { c, t, signer, connectedWith: budget?.permissionId };
}

/** Asks for a budget through a wallet that answers as `answer` says, and waits for it to settle. */
async function ask(
  t: Tenant,
  signer: ReturnType<typeof owner>,
  opts: {
    perDay?: string;
    read?: ReadPermission;
    tamper?: (granted: Record<string, unknown>) => object;
    session?: Pick<DisconnectDeps, 'clients' | 'sender' | 'lockWaitMs'>;
    input?: Parameters<typeof grantPermissions>[1];
  } = {}
) {
  const asked: { method: string; params: unknown[] }[] = [];
  const honest = walletAnswers(signer);
  const answer = async (method: string, params: unknown[]) => {
    const granted = (await honest(method, params)) as Record<string, unknown>;
    return opts.tamper ? opts.tamper(granted) : granted;
  };
  const result = await grantPermissions(t, opts.input ?? { x402Budget: { perDay: opts.perDay ?? '1' } }, {
    openWallet: fakeWallet(answer, asked),
    readPermission: opts.read ?? approvedOnChain,
    session: opts.session ?? offlineSession,
  });
  await walletsSettled();
  return { result, grant: asked[0]?.params[0] as GrantRequest };
}

describe('budget grants', () => {
  it('gives the owner a wallet link that asks for a daily USDC allowance whose only spender is the session key', async () => {
    const { t, signer } = await connected();
    const { result, grant } = await ask(t, signer, { perDay: '1.5' });
    expect('structuredContent' in result && result.structuredContent.url).toMatch(/^http:\/\/keys\.test\/cli-bridge\?/);
    expect(grant).toMatchObject({
      spender: t.sessionAddress,
      chainId: '0x14a34',
      permissions: {
        calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
        spends: [{ token: USDC, allowance: '1500000', unit: 'day', multiplier: 1 }],
      },
      capabilities: { prefundSpender: true },
    });
  });

  it('given a budget request, then the wallet opens for the client of the connection', async () => {
    const { t, signer } = await connected();
    const opened: unknown[][] = [];
    const answers = fakeWallet(walletAnswers(signer));

    await grantPermissions(
      t,
      { x402Budget: { perDay: '1' } },
      {
        openWallet: async (...args) => {
          opened.push(args);
          return answers(...args);
        },
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    await walletsSettled();

    expect(opened).toHaveLength(1);
    expect(opened[0][2]).toMatchObject({ clientId: t.clientId, clientName: t.clientName });
  });

  it('given a token with wallet:read alone, when it asks for a budget, then it is refused naming x402:pay', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const refused = await callTool(reader.access_token, 'jaw_grant_permissions', { x402Budget: { perDay: '1' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(NO_PAY_SCOPE);
  });

  it('refuses a zero budget and a malformed amount', async () => {
    const { c } = await connected();
    expect((await callTool(c.access_token, 'jaw_grant_permissions', { x402Budget: { perDay: '0' } })).isError).toBe(
      true
    );
    expect((await callTool(c.access_token, 'jaw_grant_permissions', { x402Budget: { perDay: '1e3' } })).isError).toBe(
      true
    );
  });

  it('given the preset with calls, then the input is refused and the budget in force is unchanged', async () => {
    const { c, t, connectedWith } = await connected();
    const calls = [{ target: USDC, functionSignature: 'approve(address,uint256)' }];
    const refused = await callTool(c.access_token, 'jaw_grant_permissions', { x402Budget: { perDay: '1' }, calls });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('calls');
    expect(refused.structuredContent).toBeUndefined();
    await walletsSettled();
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('given a second budget, then x402 payments draw from the newer', async () => {
    const { t, signer, connectedWith } = await connected();
    const { grant } = await ask(t, signer, { perDay: '5' });
    const newer = await x402Budget(t.connectionId);
    expect(newer).toMatchObject({
      kind: 'x402-budget',
      spender: t.sessionAddress,
      allowance: '5000000',
      expiresAt: new Date(grant.expiry * 1000),
    });
    expect(newer?.permissionId).not.toBe(connectedWith);
  });

  it.each([
    ['another spender', { spender: '0x0000000000000000000000000000000000000bad' }],
    ['a longer life', { end: 1_999_999_999 }],
    ['an approve call', { calls: [{ target: USDC, selector: '0x095ea7b3' }] }],
    ['a larger allowance', { spends: [{ token: USDC, allowance: '9000000', unit: 'day', multiplier: 1 }] }],
  ])('keeps the budget it had when the wallet answers a permission with %s', async (_name, over) => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { tamper: (granted) => ({ ...granted, ...over }) });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it.each([
    ['not approved', { status: 'ok', approved: false, revoked: false }],
    ['revoked', { status: 'ok', approved: true, revoked: true }],
    ['another hash', { status: 'mismatch' }],
    ['unreadable', { status: 'unavailable' }],
  ] as const)('keeps the budget it had when the chain reads the new permission as %s', async (_name, state) => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { read: onChain(state) });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('keeps the budget it had when another account approves the permission', async () => {
    const { t, connectedWith } = await connected();
    await ask(t, owner());
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });
});

const rowOf = async (permissionId: string | undefined) =>
  (
    await getDb()
      .select()
      .from(grants)
      .where(eq(grants.permissionId, permissionId as string))
  )[0];

const decoded = (calls: { to: string; data: `0x${string}` }[]) =>
  calls.map((c) =>
    c.to === PERMISSIONS_MANAGER_ADDRESS
      ? decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: c.data }).functionName
      : decodeFunctionData({ abi: erc20Abi, data: c.data }).functionName
  );

const CUSTOM = {
  calls: [{ target: '0x4200000000000000000000000000000000000006', functionSignature: 'approve(address,uint256)' }],
  spends: [{ token: '0x4200000000000000000000000000000000000006', allowance: '7', unit: 'week' as const }],
};

describe('given a connection that approves a second budget', () => {
  it('when the revoke lands, then the first is replaced and revoked as spender, and the float stays in the payer', async () => {
    const { t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes();

    await ask(t, signer, { perDay: '0.5', session: deps });

    expect(sent).toHaveLength(1);
    expect(decoded(sent[0])).toEqual(['revokeAsSpender', 'approve']);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date), revokedAt: expect.any(Date) });
    const newer = await x402Budget(t.connectionId);
    expect(newer?.permissionId).not.toBe(connectedWith);
    expect(await rowOf(newer?.permissionId)).toMatchObject({ replacedAt: null, revokedAt: null });
  });

  it('when the payer cannot pay the fee, then the first stays replaced and approved, and jaw_connections names it for jaw_revoke_permission', async () => {
    const { c, t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes(undefined, 0n);

    await ask(t, signer, { perDay: '0.5', session: deps });

    expect(sent).toHaveLength(0);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date), revokedAt: null });
    expect((await x402Budget(t.connectionId))?.permissionId).not.toBe(connectedWith);
    const listed = await callTool(c.access_token, 'jaw_connections', {});
    const [view] = listed.structuredContent.connections;
    expect(view.grants.find((g: { permissionId: string }) => g.permissionId === connectedWith)).toMatchObject({
      status: 'replaced',
    });
    expect(listed.structuredContent.summary).toContain(connectedWith);
    expect(listed.structuredContent.summary).toContain('jaw_revoke_permission');
  });

  it('when payments are paused, then the first stays replaced and approved, and nothing is sent', async () => {
    const { t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes();
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    try {
      await ask(t, signer, { perDay: '0.5', session: deps });
    } finally {
      await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
    }

    expect(sent).toHaveLength(0);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date), revokedAt: null });
  });

  it('when a refill is still landing in the payer, then the first stays replaced and approved, and nothing is sent', async () => {
    const { t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes();
    await getDb()
      .insert(payments)
      .values({
        id: `pay_${randomBytes(8).toString('hex')}`,
        connectionId: t.connectionId,
        idempotencyKey: randomBytes(8).toString('hex'),
        requestHash: 'h',
        permissionId: connectedWith,
        payer: t.sessionAddress.toLowerCase(),
        url: 'https://seller.example/x',
        leaseUntil: new Date(Date.now() + 60_000),
        topUpAmount: '105000',
      });

    await ask(t, signer, { perDay: '0.5', session: deps });

    expect(sent).toHaveLength(0);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date), revokedAt: null });
  });

  it('when the revoke lands, then the owner link was already settled approved', async () => {
    const { t, signer } = await connected();
    const { deps } = sessionFakes();
    const states: string[] = [];
    const watching = {
      ...deps,
      sender: async (s: Parameters<typeof deps.sender>[0]) => {
        const [row] = await getDb()
          .select()
          .from(permissionRequests)
          .where(eq(permissionRequests.connectionId, t.connectionId));
        states.push(row.state);
        return deps.sender(s);
      },
    };

    await ask(t, signer, { perDay: '0.5', session: watching });

    expect(states).toEqual(['approved']);
  });

  it('when the revoke runs, then the owner wallet session has already ended', async () => {
    const { t, signer } = await connected();
    const { deps } = sessionFakes();
    let ended = false;
    const seen: boolean[] = [];
    const answers = fakeWallet(walletAnswers(signer));
    const openWallet: OpenWallet = async (...args) => {
      const wallet = await answers(...args);
      return { ...wallet, run: (work) => wallet.run(work).finally(() => (ended = true)) };
    };
    const sender = async (s: Parameters<typeof deps.sender>[0]) => (seen.push(ended), deps.sender(s));

    await grantPermissions(
      t,
      { x402Budget: { perDay: '0.5' } },
      { openWallet, readPermission: approvedOnChain, session: { ...deps, sender } }
    );
    await walletsSettled();

    expect(seen).toEqual([true]);
  });

  it('when a custom grant lands instead, then the budget is neither replaced nor revoked', async () => {
    const { t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes();

    await ask(t, signer, { input: CUSTOM, session: deps });

    expect(sent).toHaveLength(0);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: null, revokedAt: null });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('when the older one is recorded again, then the newer stays the budget in force', async () => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { perDay: '0.5' });
    const newer = (await x402Budget(t.connectionId))?.permissionId;

    await inTx(t.connectionId, await newGrantFrom(t.connectionId, connectedWith));

    expect((await x402Budget(t.connectionId))?.permissionId).toBe(newer);
  });

  it('given the cap full with the budget among the grants, when a new budget is asked, then it is approved in its place', async () => {
    const { t, signer, connectedWith } = await connected();
    for (let n = 1; n < LIVE_GRANTS_PER_CONNECTION; n++) await ask(t, signer, { input: CUSTOM });
    const { deps, sent } = sessionFakes();

    const { grant } = await ask(t, signer, { perDay: '2', session: deps });

    expect(grant).toBeDefined();
    expect((await x402Budget(t.connectionId))?.allowance).toBe('2000000');
    expect(decoded(sent[0])).toEqual(['revokeAsSpender', 'approve']);
    expect(await revokedAt(connectedWith)).toEqual(expect.any(Date));
  });

  it('given the cap full with a replaced budget left approved, when a grant is asked, then the revoke is retried and the wallet opens', async () => {
    const { t, signer, connectedWith } = await connected();
    for (let n = 2; n < LIVE_GRANTS_PER_CONNECTION; n++) await ask(t, signer, { input: CUSTOM });
    await ask(t, signer, { perDay: '0.5', session: sessionFakes(undefined, 0n).deps });
    expect(await liveGrants(t.connectionId)).toHaveLength(LIVE_GRANTS_PER_CONNECTION);
    const { deps, sent } = sessionFakes();

    const { grant } = await ask(t, signer, { input: CUSTOM, session: deps });

    expect(grant).toBeDefined();
    expect(decoded(sent[0])).toEqual(['revokeAsSpender', 'approve']);
    expect(await revokedAt(connectedWith)).toEqual(expect.any(Date));
  });
});

describe('given a replaced budget left approved on chain', () => {
  /** A server whose one tool answers at once, wrapped by the retry, with the tool's handler. */
  function serverWith(session: Pick<DisconnectDeps, 'clients' | 'sender'>) {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (...args: unknown[]) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as unknown as McpServer;
    retryReplacedRevokes(server, {
      openWallet: fakeWallet(walletAnswers(owner())),
      readPermission: approvedOnChain,
      session,
    });
    (server.registerTool as (...args: unknown[]) => unknown)('jaw_any', { description: 'any' }, async () => 'answered');
    return (t: Tenant) => handlers.get('jaw_any')!({}, { http: { authInfo: { extra: { tenant: t } } } });
  }

  it('when the connection calls any tool, then it answers and the revoke is retried in the background', async () => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { perDay: '0.5', session: sessionFakes(undefined, 0n).deps });
    const { deps, sent } = sessionFakes();

    expect(await serverWith(deps)(t)).toBe('answered');
    await walletsSettled();

    expect(decoded(sent[0])).toEqual(['revokeAsSpender', 'approve']);
    expect(await revokedAt(connectedWith)).toEqual(expect.any(Date));
  });

  it('when the retry cannot pay the fee, then the next tool call within minutes does not try again', async () => {
    const { t, signer } = await connected();
    await ask(t, signer, { perDay: '0.5', session: sessionFakes(undefined, 0n).deps });
    const { deps } = sessionFakes(undefined, 0n);
    let reads = 0;
    const counted = { ...deps, clients: { publicClient: (id: number) => (reads++, deps.clients.publicClient(id)) } };
    const call = serverWith(counted);

    await call(t);
    await walletsSettled();
    await call(t);
    await walletsSettled();

    expect(reads).toBe(1);
  });
});

describe('the link reply', () => {
  it('given a budget and a custom grant live, when a budget is asked, then it sums what they let move per token and says the current budget is replaced', async () => {
    const { t, signer } = await connected();
    await ask(t, signer, { input: CUSTOM });

    const { result } = await ask(t, signer, { perDay: '5' });

    const summary = 'structuredContent' in result ? result.structuredContent.summary : '';
    expect(summary).toContain(
      'The 2 grant(s) approved on chain for this connection already let the session key move up to 7 base units of 0x4200000000000000000000000000000000000006 per week, 1 USDC per day.'
    );
    expect(summary).toContain('replaces the current one');
  });

  it('given a limit for all time, then the reply says in total', async () => {
    const { t, signer } = await connected();
    await ask(t, signer, { input: { ...CUSTOM, spends: [{ ...CUSTOM.spends[0], unit: 'forever' as const }] } });

    const { result } = await ask(t, signer, { input: CUSTOM });

    const summary = 'structuredContent' in result ? result.structuredContent.summary : '';
    expect(summary).toContain('7 base units of 0x4200000000000000000000000000000000000006 in total');
  });

  it('given only custom grants, when a custom grant is asked, then it does not speak of replacing a budget', async () => {
    const { t, signer } = await connected('wallet:read x402:pay');
    await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));

    const { result } = await ask(t, signer, { input: CUSTOM });

    const summary = 'structuredContent' in result ? result.structuredContent.summary : '';
    expect(summary).toContain('No grant approved on chain for this connection lets the session key move tokens yet.');
    expect(summary).not.toContain('replaces');
  });
});

const newGrantFrom = async (
  connectionId: string,
  permissionId = `0x${randomBytes(32).toString('hex')}`
): Promise<NewGrant> => {
  const [row] = await getDb().select().from(grants).where(eq(grants.connectionId, connectionId));
  const { connectionId: _c, createdAt: _a, replacedAt: _r, revokedAt: _v, ...rest } = row;
  return { ...rest, permissionId };
};
const customFrom = async (connectionId: string): Promise<NewGrant> => ({
  ...(await newGrantFrom(connectionId)),
  kind: 'custom',
});
const inTx = (connectionId: string, g: NewGrant) => getDb().transaction((tx) => recordGrant(tx, connectionId, g));
describe('jaw_grant_permissions', () => {
  it('the wallet is given thirty minutes to answer', async () => {
    const { t, signer } = await connected();
    let until: Date | undefined;
    const answers = fakeWallet(walletAnswers(signer));
    await grantPermissions(
      t,
      { x402Budget: { perDay: '1' } },
      {
        openWallet: async (chainId, u, client) => {
          until = u;
          return answers(chainId, u, client);
        },
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    await walletsSettled();
    expect(until!.getTime() - Date.now()).toBeGreaterThan(29.9 * 60_000);
    expect(until!.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  it('a second request while the first waits gets the first link back as a refusal, and a third after it ends is served', async () => {
    const { t, signer } = await connected();
    const release = Promise.withResolvers<void>();
    const url = 'http://keys.test/cli-bridge?session=waiting';
    const ownerLeaves = async () => {
      await release.promise;
      throw new Error('owner left');
    };
    const waiting: Wallet = {
      url,
      run: async (work) => work(ownerLeaves),
      close: () => undefined,
    };
    let until: Date | undefined;
    const openWallet: OpenWallet = async (_chainId, at) => ((until = at), waiting);
    const deps = { openWallet, session: offlineSession, readPermission: approvedOnChain };

    const first = await grantPermissions(t, { x402Budget: { perDay: '1' } }, deps);
    const second = await grantPermissions(t, { x402Budget: { perDay: '1' } }, deps);

    expect('structuredContent' in first && first.structuredContent.url).toBe(url);
    expect('isError' in second && second.isError).toBe(true);
    expect(second.content[0].text).toContain(url);
    expect(second.content[0].text).toContain('still waiting');
    expect(second.content[0].text).toContain(until!.toISOString());

    release.resolve();
    await walletsSettled();
    await vi.waitFor(async () => {
      const third = await grantPermissions(
        t,
        { x402Budget: { perDay: '1' } },
        { ...deps, openWallet: fakeWallet(walletAnswers(signer)) }
      );
      expect('structuredContent' in third).toBe(true);
    });
    await walletsSettled();
  });

  it('a chain without USDC is refused before a wallet opens', async () => {
    const { t } = await connected();
    let opened = 0;
    const result = await grantPermissions(
      { ...t, chainId: 999_999 },
      { x402Budget: { perDay: '1' } },
      {
        openWallet: async () => {
          opened++;
          throw new Error('not reached');
        },
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    expect('isError' in result && result.isError).toBe(true);
    expect(result.content[0].text).toBe("USDC is not supported on this connection's chain.");
    expect(opened).toBe(0);
  });

  it('a full owner pool is told to try again, not thrown', async () => {
    const { t } = await connected();
    const result = await grantPermissions(
      t,
      { x402Budget: { perDay: '1' } },
      {
        openWallet: async () => {
          throw new WalletBusy();
        },
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    expect('isError' in result && result.isError).toBe(true);
    expect(result.content[0].text).toBe('Too many owners are approving right now. Try again in a minute.');
  });

  it('the owner is told the amount and the link, and the link is the wallet link', async () => {
    const { t, signer } = await connected();
    let walletUrl = '';
    const answers = fakeWallet(walletAnswers(signer));
    const result = await grantPermissions(
      t,
      { x402Budget: { perDay: '1.5' } },
      {
        openWallet: async (...args) => {
          const w = await answers(...args);
          walletUrl = w.url;
          return w;
        },
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    await walletsSettled();
    if (!('structuredContent' in result)) throw new Error('refused');
    expect(result.structuredContent.url).toBe(walletUrl);
    expect(result.structuredContent.summary).toContain(`open ${walletUrl} and approve 1.5 USDC a day until`);
    expect(result.structuredContent.summary).toContain('call jaw_session_status yourself');
    expect(result.structuredContent.summary).toContain('do not wait for the owner to say they approved');
  });

  it('a ten digit budget is refused by the schema', async () => {
    const { c } = await connected();
    const result = await callTool(c.access_token, 'jaw_grant_permissions', { x402Budget: { perDay: '1234567890' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Input validation error');
  });

  it('a connection that ended while the owner was approving gets no budget', async () => {
    const { t, signer } = await connected();
    const gate = Promise.withResolvers<void>();
    const honest = walletAnswers(signer);
    const before = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    await grantPermissions(
      t,
      { x402Budget: { perDay: '2' } },
      {
        openWallet: fakeWallet(async (m, p) => {
          await gate.promise;
          return honest(m, p);
        }),
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    await endConnection(t.connectionId, t.account);
    gate.resolve();
    await walletsSettled();
    const after = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    expect(after).toHaveLength(before.length);
  });
});

describe('the permission of a budget', () => {
  it('the grant asked of the wallet expires when the budget says', () => {
    const grant = budgetGrant({ chainId: 84532, spender: USDC, token: USDC, allowance: 1n, expiry: 1_234_567 });
    expect(grant.expiry).toBe(1_234_567);
  });

  type Spend = Record<string, unknown>;
  it.each<[string, (granted: Record<string, unknown>, spend: Spend) => object]>([
    [
      'a second call that sorts after the first',
      (granted) => ({
        ...granted,
        calls: [
          { target: USDC, selector: '0xa9059cbb' },
          { target: USDC, selector: '0xffffffff' },
        ],
      }),
    ],
    ['a second spend', (granted, spend) => ({ ...granted, spends: [spend, spend] })],
    ['another period', (granted, spend) => ({ ...granted, spends: [{ ...spend, unit: 'week' }] })],
    ['another multiplier', (granted, spend) => ({ ...granted, spends: [{ ...spend, multiplier: 2 }] })],
    [
      'another token',
      (granted, spend) => ({ ...granted, spends: [{ ...spend, token: '0x0000000000000000000000000000000000000bad' }] }),
    ],
  ])('keeps the budget it had when the wallet answers a permission with %s', async (_name, change) => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { tamper: (granted) => change(granted, (granted.spends as Spend[])[0]) });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('an answer without a hex permission id is an invalid response', async () => {
    const { t, signer } = await connected();
    const { grant } = await ask(t, signer);
    const answer = await walletAnswers(signer)('wallet_grantPermissions', [grant]);
    expect(
      await checkGranted(
        t.chainId,
        grant,
        'x402-budget',
        { ...(answer as object), permissionId: 'nope' },
        approvedOnChain
      )
    ).toBe('invalid_response');
    expect(await checkGranted(t.chainId, grant, 'x402-budget', answer, approvedOnChain)).toMatchObject({
      allowance: grant.permissions.spends[0].allowance,
    });
  });

  it.each([
    ['mismatch', { status: 'mismatch' }, 'grant_mismatch'],
    ['unavailable', { status: 'unavailable' }, 'verification_unavailable'],
    ['unapproved', { status: 'ok', approved: false, revoked: false }, 'grant_not_found'],
    ['revoked', { status: 'ok', approved: true, revoked: true }, 'grant_not_found'],
  ] as const)('M4 a chain that reads %s is refused as %s', async (_n, state, code) => {
    const { t, signer } = await connected();
    const { grant } = await ask(t, signer);
    const answer = await walletAnswers(signer)('wallet_grantPermissions', [grant]);
    expect(await checkGranted(t.chainId, grant, 'x402-budget', answer, onChain(state))).toBe(code);
  });

  it('recording the same budget twice is not an error', async () => {
    const { t } = await connected();
    const g = await newGrantFrom(t.connectionId);
    await inTx(t.connectionId, g);
    await expect(inTx(t.connectionId, g)).resolves.toBeUndefined();
  });

  it('given a grant of that id was already revoked, when it is recorded again, then it is not recorded as approved', async () => {
    const { t } = await connected();
    const g = await newGrantFrom(t.connectionId);
    await inTx(t.connectionId, g);
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, g.permissionId));

    await expect(inTx(t.connectionId, g)).rejects.toThrow(/revoked/);
    expect((await liveGrants(t.connectionId)).map((l) => l.permissionId)).not.toContain(g.permissionId);
  });

  it('when the newest budget expires, then x402 payments do not fall back to the one it replaced', async () => {
    const { t, connectedWith } = await connected();
    const newer = await newGrantFrom(t.connectionId);
    await inTx(t.connectionId, newer);
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(newer.permissionId);

    await getDb()
      .update(grants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(grants.permissionId, newer.permissionId));

    expect(await x402Budget(t.connectionId)).toBeUndefined();
    expect((await liveGrants(t.connectionId)).map((g) => g.permissionId)).toEqual([connectedWith]);
  });

  it('a revoked budget is neither the x402 budget nor live', async () => {
    const { t, connectedWith } = await connected();
    const newer = await newGrantFrom(t.connectionId);
    await inTx(t.connectionId, newer);
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, newer.permissionId));

    expect(await x402Budget(t.connectionId)).toBeUndefined();
    expect((await liveGrants(t.connectionId)).map((g) => g.permissionId)).toEqual([connectedWith]);
  });

  it('a custom grant is live but never the x402 budget, however new', async () => {
    const { t, connectedWith } = await connected();
    const custom: NewGrant = { ...(await newGrantFrom(t.connectionId)), kind: 'custom' };
    await inTx(t.connectionId, custom);

    expect((await x402Budget(t.connectionId))?.permissionId).toBe(connectedWith);
    expect((await liveGrants(t.connectionId)).map((g) => [g.permissionId, g.kind])).toEqual([
      [custom.permissionId, 'custom'],
      [connectedWith, 'x402-budget'],
    ]);
  });

  it('a connection at the cap of live grants is refused before a wallet opens, naming the cap', async () => {
    const { t } = await connected();
    for (let n = 1; n < LIVE_GRANTS_PER_CONNECTION; n++) await inTx(t.connectionId, await customFrom(t.connectionId));
    let opened = 0;

    const result = await grantPermissions(t, CUSTOM, {
      openWallet: async () => {
        opened++;
        throw new Error('not reached');
      },
      session: offlineSession,
      readPermission: approvedOnChain,
    });

    expect('isError' in result && result.isError).toBe(true);
    expect(result.content[0].text).toContain(`${LIVE_GRANTS_PER_CONNECTION} live grants`);
    expect(opened).toBe(0);
  });

  it('a grant past the cap is not recorded, and an expired one no longer counts against it', async () => {
    const { t } = await connected();
    for (let n = 1; n < LIVE_GRANTS_PER_CONNECTION; n++) await inTx(t.connectionId, await customFrom(t.connectionId));

    await expect(inTx(t.connectionId, await customFrom(t.connectionId))).rejects.toThrow(/live grants/);
    expect(await liveGrants(t.connectionId)).toHaveLength(LIVE_GRANTS_PER_CONNECTION);

    const [oldest] = (await liveGrants(t.connectionId)).slice(-1);
    await getDb()
      .update(grants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(grants.permissionId, oldest.permissionId));
    await expect(inTx(t.connectionId, await customFrom(t.connectionId))).resolves.toBeUndefined();
  });

  it('a replaced budget is never the x402 budget, and is still live to revoke', async () => {
    const { t, connectedWith } = await connected();
    const newer = await newGrantFrom(t.connectionId);
    await inTx(t.connectionId, newer);

    expect((await x402Budget(t.connectionId))?.permissionId).toBe(newer.permissionId);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date) });
    expect((await liveGrants(t.connectionId)).map((g) => g.permissionId)).toContain(connectedWith);
  });
});

describe('the migration that keeps one budget per connection', () => {
  it('marks every budget but the newest replaced, and leaves custom and revoked grants alone', async () => {
    const { t, connectedWith } = await connected();
    const newer = await newGrantFrom(t.connectionId);
    const custom = await customFrom(t.connectionId);
    await getDb()
      .insert(grants)
      .values([
        { ...newer, connectionId: t.connectionId, createdAt: new Date(Date.now() + 1_000) },
        { ...custom, connectionId: t.connectionId, createdAt: new Date(Date.now() + 2_000) },
      ]);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: null });

    const migration = readFileSync(join(__dirname, '../../drizzle/0034_replace_older_budgets.sql'), 'utf8');
    await getDb().execute(sql.raw(migration));

    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date) });
    expect(await rowOf(newer.permissionId)).toMatchObject({ replacedAt: null });
    expect(await rowOf(custom.permissionId)).toMatchObject({ replacedAt: null });
    expect((await x402Budget(t.connectionId))?.permissionId).toBe(newer.permissionId);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a payment holding the float', () => {
  it('when a newer budget lands, then the revoke gives up as busy and the first stays replaced and approved', async () => {
    const { t, signer, connectedWith } = await connected();
    const { deps, sent } = sessionFakes();
    const release = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const held = withFloat(t.connectionId, 5_000, async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;

    await ask(t, signer, { perDay: '0.5', session: { ...deps, lockWaitMs: 200 } });
    release.resolve();
    await held;

    expect(sent).toHaveLength(0);
    expect(await rowOf(connectedWith)).toMatchObject({ replacedAt: expect.any(Date), revokedAt: null });
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a budget landing while its connection ends', () => {
  it('a budget waits for a connection being ended, and is not recorded after it', async () => {
    const { t, signer } = await connected();
    const before = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    const ending = Promise.withResolvers<void>();
    const holding = getDb().transaction(async (tx) => {
      await tx.select().from(connections).where(eq(connections.id, t.connectionId)).for('update');
      ending.resolve();
      await new Promise((r) => setTimeout(r, 600));
      await tx
        .update(connections)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(connections.id, t.connectionId));
    });
    await ending.promise;

    await grantPermissions(
      t,
      { x402Budget: { perDay: '3' } },
      {
        openWallet: fakeWallet(walletAnswers(signer)),
        session: offlineSession,
        readPermission: approvedOnChain,
      }
    );
    await new Promise((r) => setTimeout(r, 250));
    const during = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
    await holding;
    await walletsSettled();
    const after = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));

    expect(during).toHaveLength(before.length);
    expect(after).toHaveLength(before.length);
  });
});
