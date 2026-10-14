import { PERMISSION_MANAGER_ABI, type PermissionState } from '@jaw.id/agent';
import { and, eq, isNull } from 'drizzle-orm';
import { decodeFunctionData } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  owner,
  setTestEnv,
  walletAnswers,
  sessionFakes,
  walletsSettled,
  type SessionCall,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { requestBudget } from '@/tools/request-budget';
import { NO_PAY_SCOPE } from '@/tools/reply';
import type { GrantRequest, ReadPermission } from './permission';
import { currentGrant } from './store';

setTestEnv();
beforeAll(useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const MANAGER = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8';
const revokedAsSpender = (batch: SessionCall[]) =>
  batch
    .filter((c) => c.to === MANAGER)
    .map((c) => decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: c.data }))
    .map((d) => (d.functionName === 'revokeAsSpender' ? d.args[0] : undefined));

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
  return { c, t, signer, connectedWith: (await currentGrant(t.connectionId))?.permissionId };
}

/** Asks for a budget through a wallet that answers as `answer` says, and waits for it to settle. */
async function ask(
  t: Tenant,
  signer: ReturnType<typeof owner>,
  opts: {
    perDay?: string;
    read?: ReadPermission;
    tamper?: (granted: Record<string, unknown>) => object;
    session?: ReturnType<typeof sessionFakes>['deps'];
  } = {}
) {
  const asked: { method: string; params: unknown[] }[] = [];
  const honest = walletAnswers(signer);
  const answer = async (method: string, params: unknown[]) => {
    const granted = (await honest(method, params)) as Record<string, unknown>;
    return opts.tamper ? opts.tamper(granted) : granted;
  };
  const result = await requestBudget(t, opts.perDay ?? '1', {
    openWallet: fakeWallet(answer, asked),
    readPermission: opts.read ?? approvedOnChain,
    ...(opts.session ?? sessionFakes().deps),
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

    await requestBudget(t, '1', {
      openWallet: async (...args) => {
        opened.push(args);
        return answers(...args);
      },
      readPermission: approvedOnChain,
      ...sessionFakes().deps,
    });
    await walletsSettled();

    expect(opened).toHaveLength(1);
    expect(opened[0]).toHaveLength(3);
    expect(opened[0][2]).toMatchObject({ clientId: t.clientId, clientName: t.clientName });
  });

  it('given a token with wallet:read alone, when it asks for a budget, then it is refused naming x402:pay', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const refused = await callTool(reader.access_token, 'jaw_request_budget', { perDay: '1' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(NO_PAY_SCOPE);
  });

  it('refuses a zero budget and a malformed amount', async () => {
    const { c } = await connected();
    expect((await callTool(c.access_token, 'jaw_request_budget', { perDay: '0' })).isError).toBe(true);
    expect((await callTool(c.access_token, 'jaw_request_budget', { perDay: '1e3' })).isError).toBe(true);
  });

  it('given a client that still passes calls, then the input is refused and the budget in force is unchanged', async () => {
    const { c, t, connectedWith } = await connected();
    const calls = [{ to: USDC, functionSignature: 'approve(address,uint256)' }];
    const refused = await callTool(c.access_token, 'jaw_request_budget', { perDay: '1', calls });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('calls');
    expect(refused.structuredContent).toBeUndefined();
    await walletsSettled();
    expect((await currentGrant(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('makes the permission the budget in force once the chain shows it approved, and marks the older one replaced', async () => {
    const { t, signer, connectedWith } = await connected();
    const { grant } = await ask(t, signer, { perDay: '5' });
    const now = await currentGrant(t.connectionId);
    expect(now).toMatchObject({
      spender: t.sessionAddress,
      allowance: '5000000',
      expiresAt: new Date(grant.expiry * 1000),
    });
    expect(now?.permissionId).not.toBe(connectedWith);
    const unreplaced = await getDb()
      .select({ id: grants.permissionId })
      .from(grants)
      .where(and(eq(grants.connectionId, t.connectionId), isNull(grants.replacedAt)));
    expect(unreplaced).toEqual([{ id: now?.permissionId }]);
  });

  it.each([
    ['another spender', { spender: '0x0000000000000000000000000000000000000bad' }],
    ['a longer life', { end: 1_999_999_999 }],
    ['an approve call', { calls: [{ target: USDC, selector: '0x095ea7b3' }] }],
    ['a larger allowance', { spends: [{ token: USDC, allowance: '9000000', unit: 'day', multiplier: 1 }] }],
  ])('keeps the budget it had when the wallet answers a permission with %s', async (_name, over) => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { tamper: (granted) => ({ ...granted, ...over }) });
    expect((await currentGrant(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it.each([
    ['not approved', { status: 'ok', approved: false, revoked: false }],
    ['revoked', { status: 'ok', approved: true, revoked: true }],
    ['another hash', { status: 'mismatch' }],
    ['unreadable', { status: 'unavailable' }],
  ] as const)('keeps the budget it had when the chain reads the new permission as %s', async (_name, state) => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { read: onChain(state) });
    expect((await currentGrant(t.connectionId))?.permissionId).toBe(connectedWith);
  });

  it('keeps the budget it had when another account approves the permission', async () => {
    const { t, connectedWith } = await connected();
    await ask(t, owner());
    expect((await currentGrant(t.connectionId))?.permissionId).toBe(connectedWith);
  });
});

describe('given a connection whose budget the owner replaces', () => {
  it('when the new budget lands, then the session key revokes the old one on chain and keeps its float', async () => {
    const { t, signer, connectedWith } = await connected();
    const old = (await currentGrant(t.connectionId))?.permission;
    const { deps, sent } = sessionFakes();

    await ask(t, signer, { perDay: '0.5', session: deps });

    expect(sent).toHaveLength(1);
    expect(revokedAsSpender(sent[0])).toEqual([
      expect.objectContaining({ spender: old?.spender, salt: BigInt(old?.salt ?? 0) }),
    ]);
    // Only the revoke and the fee cap: nothing goes back to the owner.
    expect(sent[0].map((c) => c.to)).toEqual([MANAGER, USDC]);
    expect(await revokedAt(connectedWith)).not.toBeNull();
    expect(await revokedAt((await currentGrant(t.connectionId))?.permissionId)).toBeNull();
  });

  it('when the revoke does not land, then the next budget retries it', async () => {
    const { t, signer, connectedWith } = await connected();
    await ask(t, signer, { perDay: '0.5', session: sessionFakes({ status: 'reverted' }).deps });
    expect(await revokedAt(connectedWith)).toBeNull();
    const second = (await currentGrant(t.connectionId))?.permissionId;

    const { deps, sent } = sessionFakes();
    await ask(t, signer, { perDay: '0.2', session: deps });

    expect(revokedAsSpender(sent[0])).toHaveLength(2);
    expect(await revokedAt(connectedWith)).not.toBeNull();
    expect(await revokedAt(second)).not.toBeNull();
  });
});
