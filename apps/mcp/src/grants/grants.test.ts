import type { GrantedPermission, GrantRequest, PermissionState } from '@jaw.id/agent';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideFromPage, readForPage, type ReadPermission } from '@/approvals/page-api';
import { verifyBearer } from '@/connections/auth';
import {
  Browser,
  callTool,
  connect,
  follow,
  getDetails,
  owner,
  postConsent,
  REDIRECT,
  RESOURCE,
  setTestEnv,
  startAuthorization,
  token,
  verifyLocally,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { currentGrant } from './store';

setTestEnv();
beforeAll(useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const permissionId = () => `0x${randomBytes(32).toString('hex')}` as Hex;

const granted = (grant: GrantRequest, over: Partial<GrantedPermission> = {}, id = permissionId()) => ({
  permissionId: id,
  account: grant.address,
  spender: grant.spender,
  start: 1_780_000_000,
  end: grant.expiry,
  salt: '0x2a',
  calls: [{ target: grant.permissions.calls[0].target, selector: '0xa9059cbb' }],
  spends: grant.permissions.spends,
  ...over,
});

const onChain =
  (state: PermissionState): ReadPermission =>
  async () =>
    state;
const approvedOnChain = onChain({ status: 'ok', approved: true, revoked: false });

async function budgetView(id: string) {
  const read = await readForPage(id);
  if (read.kind !== 'ok' || read.view.approve.type !== 'grant') throw new Error(read.kind);
  return { view: read.view, grant: read.view.approve.grant };
}

async function requestBudget(perDay = '1') {
  const c = await connect();
  const sessionAddress = ((await verifyBearer(c.access_token))?.extra?.tenant as { sessionAddress: Hex })
    .sessionAddress;
  const result = await callTool(c.access_token, 'jaw_request_budget', { perDay });
  return { c, sessionAddress, result, id: result.structuredContent?.requestId as string };
}

describe('budget grants', () => {
  it('asks for a daily USDC transfer allowance whose only spender is the connection session key', async () => {
    const { c, sessionAddress, result, id } = await requestBudget('1.5');
    expect(result.structuredContent).toMatchObject({ status: 'pending', approveUrl: `http://keys.test/approve/${id}` });
    const { view, grant } = await budgetView(id);
    expect(view.preview).toMatchObject({
      kind: 'budget',
      account: c.signer.address,
      spender: sessionAddress,
      token: USDC,
      allowance: '1500000',
      period: 'day',
    });
    expect(grant).toMatchObject({
      address: c.signer.address,
      spender: sessionAddress,
      chainId: '0x14a34',
      permissions: {
        calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
        spends: [{ token: USDC, allowance: '1500000', unit: 'day', multiplier: 1 }],
      },
      capabilities: { prefundSpender: true },
    });
  });

  it('refuses a zero budget and a malformed amount', async () => {
    const c = await connect();
    expect((await callTool(c.access_token, 'jaw_request_budget', { perDay: '0' })).isError).toBe(true);
    expect((await callTool(c.access_token, 'jaw_request_budget', { perDay: '1e3' })).isError).toBe(true);
  });

  it('records the grant once the permission the page granted is approved on chain', async () => {
    const { c, id } = await requestBudget();
    const { view, grant } = await budgetView(id);
    const pid = permissionId();
    const post = { verdict: 'approved', previewHash: view.previewHash, permission: granted(grant, {}, pid) };
    expect(await decideFromPage(id, post, verifyLocally, new Date(), approvedOnChain)).toMatchObject({
      kind: 'ok',
      view: { status: 'approved' },
    });

    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ status: 'approved', permissionId: pid });
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    expect(await currentGrant(tenant.connectionId)).toMatchObject({
      permissionId: pid,
      spender: grant.spender,
      allowance: '1000000',
      expiresAt: new Date(grant.expiry * 1000),
    });
  });

  it.each([
    ['another spender', { spender: '0x0000000000000000000000000000000000000bad' }],
    ['a longer life', { end: 1_999_999_999 }],
    ['an approve call', { calls: [{ target: USDC, selector: '0x095ea7b3' }] }],
    ['a larger allowance', { spends: [{ token: USDC, allowance: '9000000', unit: 'day', multiplier: 1 }] }],
  ])('refuses a granted permission with %s and records nothing', async (_name, over) => {
    const { id } = await requestBudget();
    const { view, grant } = await budgetView(id);
    const post = { verdict: 'approved', previewHash: view.previewHash, permission: granted(grant, over) };
    expect((await decideFromPage(id, post, verifyLocally, new Date(), approvedOnChain)).kind).toBe('grant_mismatch');
    expect((await budgetView(id)).view.status).toBe('pending');
    expect(await getDb().select().from(grants).where(eq(grants.approvalId, id))).toEqual([]);
  });

  it.each([
    ['not approved', { status: 'ok', approved: false, revoked: false }, 'grant_not_found'],
    ['revoked', { status: 'ok', approved: true, revoked: true }, 'grant_not_found'],
    ['another hash', { status: 'mismatch' }, 'grant_mismatch'],
    ['unreadable', { status: 'unavailable' }, 'verification_unavailable'],
  ] as const)('refuses a permission the chain reads as %s', async (_name, state, kind) => {
    const { id } = await requestBudget();
    const { view, grant } = await budgetView(id);
    const post = { verdict: 'approved', previewHash: view.previewHash, permission: granted(grant) };
    expect((await decideFromPage(id, post, verifyLocally, new Date(), onChain(state))).kind).toBe(kind);
    expect((await budgetView(id)).view.status).toBe('pending');
  });

  it('keeps the same spender when the budget is raised, and the newest grant is the budget', async () => {
    const { c, id } = await requestBudget('1');
    const first = await budgetView(id);
    await decideFromPage(
      id,
      { verdict: 'approved', previewHash: first.view.previewHash, permission: granted(first.grant) },
      verifyLocally,
      new Date(),
      approvedOnChain
    );
    const raise = await callTool(c.access_token, 'jaw_request_budget', { perDay: '5' });
    const raised = permissionId();
    const second = await budgetView(raise.structuredContent.requestId);
    expect(second.grant.spender).toBe(first.grant.spender);
    await decideFromPage(
      raise.structuredContent.requestId,
      {
        verdict: 'approved',
        previewHash: second.view.previewHash,
        permission: granted(second.grant, {}, raised),
      },
      verifyLocally,
      new Date(),
      approvedOnChain
    );
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    expect(await currentGrant(tenant.connectionId)).toMatchObject({ permissionId: raised, allowance: '5000000' });
  });
});

describe('budget at consent', () => {
  async function consentWith(extra: object) {
    const signer = owner();
    const browser = new Browser();
    const start = await startAuthorization(browser);
    const d = await getDetails(start.uid!);
    const res = await postConsent(start.uid!, signer.address, await signer.signMessage({ message: d.message }), extra);
    return { signer, browser, start, res, body: await res.json() };
  }

  async function exchange(browser: Browser, next: string, verifier: string) {
    const redirected = await follow(browser, next, REDIRECT);
    const issued = await token({
      grant_type: 'authorization_code',
      code: redirected.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: 'jaw-cli',
      code_verifier: verifier,
      resource: RESOURCE,
    });
    return issued.body.access_token;
  }

  it('has a grant right after the token exchange when the budget was approved before the hand-back', async () => {
    const { signer, browser, start, body } = await consentWith({ budget: '1' });
    expect(body.budgetRequestId).toEqual(expect.any(String));
    const { view, grant } = await budgetView(body.budgetRequestId);
    expect(grant.address).toBe(signer.address);
    const pid = permissionId();
    const post = { verdict: 'approved', previewHash: view.previewHash, permission: granted(grant, {}, pid) };
    expect((await decideFromPage(body.budgetRequestId, post, verifyLocally, new Date(), approvedOnChain)).kind).toBe(
      'ok'
    );

    const access = await exchange(browser, body.next, start.verifier);
    const tenant = (await verifyBearer(access))?.extra?.tenant as { connectionId: string; sessionAddress: Hex };
    expect(grant.spender).toBe(tenant.sessionAddress);
    expect(await currentGrant(tenant.connectionId)).toMatchObject({ permissionId: pid });
  });

  it('creates no budget request when the budget is skipped, and status reads no_grant', async () => {
    const { browser, start, body } = await consentWith({});
    expect(body.budgetRequestId).toBeUndefined();
    const access = await exchange(browser, body.next, start.verifier);
    const status = await callTool(access, 'jaw_status', {});
    expect(status.structuredContent).toMatchObject({
      readiness: { status: 'not_ready', reason: 'no_grant' },
      budget: null,
    });
  });

  it.each(['0', 'lots', '-1', 1])('refuses consent with a budget of %j and creates no connection', async (budget) => {
    const { res, body } = await consentWith({ budget });
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_budget');
  });
});
