import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decide,
  payloadHash,
  signedPayload,
  type ApprovalRequest,
  type ChainClients,
  type GrantRequest,
  type PaymentBody,
} from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideFromPage, outcomeResponse, readForPage } from '@/approvals/page-api';
import { findById, recordDecision, sellerRequestOf } from '@/approvals/store';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, owner, setTestEnv, verifyLocally } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { approvalRequests, auditEvents, payments, settings } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { oneOffRow } from './one-off';
import { pay, type PayDeps } from './pay';
import { entriesFor, holdingRows, pulledUnderOtherGrants } from './store';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const SECRET = 'Bearer SELLER-SECRET';

const prices = new Map<string, string>();
const timeouts = new Map<string, number>();
let dropNextPaid = new Set<string>();
type Seen = {
  path: string;
  authorization?: string;
  key?: string;
  proof?: { payload: { signature: Hex; authorization: { from: Address; nonce: Hex } } };
};
const seen: Seen[] = [];
const paidRequests = () => seen.filter((s) => s.proof);

const seller = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://seller').pathname;
  const signed = req.headers['payment-signature'];
  const s: Seen = {
    path,
    authorization: req.headers.authorization,
    key: req.headers['idempotency-key'] as string | undefined,
  };
  seen.push(s);
  if (!signed) {
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: prices.get(path) ?? '5000',
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: timeouts.get(path) ?? 300,
        },
      ],
    };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  s.proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  if (dropNextPaid.delete(path)) return void req.socket.destroy();
  const receipt = { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:84532' };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end(JSON.stringify({ report: 'paid once from the account' }));
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;

setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const node = {
  getCode: async () => undefined,
  readContract: async () => 10_000_000n,
  waitForTransactionReceipt: async () => {
    throw new Error('no receipt');
  },
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };
const deps = (): PayDeps => ({
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: () => undefined,
  fetch: safeFetch(new Set([SELLER])),
});

beforeAll(useTestDb);
beforeEach(() => {
  seen.length = 0;
  prices.clear();
  timeouts.clear();
  dropNextPaid = new Set();
});

const url = (path: string) => `http://${SELLER}${path}`;

async function grantBudget(c: Awaited<ReturnType<typeof connect>>, perDay: string) {
  const asked = await callTool(c.access_token, 'jaw_request_budget', { perDay });
  const id = asked.structuredContent.requestId as string;
  const read = await readForPage(id);
  if (read.kind !== 'ok' || read.view.approve.type !== 'grant') throw new Error('no budget view');
  const grant: GrantRequest = read.view.approve.grant;
  const permissionId = `0x${Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)}`;
  const permission = {
    permissionId,
    account: grant.address,
    spender: grant.spender,
    start: 1_780_000_000,
    end: grant.expiry,
    salt: '0x1',
    calls: [{ target: USDC, selector: '0xa9059cbb' }],
    spends: grant.permissions.spends,
  };
  const decided = await decideFromPage(
    id,
    { verdict: 'approved', previewHash: read.view.previewHash, permission },
    verifyLocally,
    new Date(),
    async () => ({ status: 'ok', approved: true, revoked: false })
  );
  if (decided.kind !== 'ok') throw new Error(decided.kind);
  return permissionId;
}

/** A budget too small for the price, so the call ends in budget_exhausted and offers a one-off. */
async function offered(path: string) {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const permissionId = await grantBudget(c, '0.001');
  const refused = await pay(t, { url: url(path), headers: { Authorization: SECRET }, idempotencyKey: 'k1' }, deps());
  const oneOff = refused.structuredContent?.refusal?.oneOff;
  if (!oneOff) throw new Error(`no one-off: ${JSON.stringify(refused)}`);
  const read = await readForPage(oneOff.requestId);
  if (read.kind !== 'ok' || read.view.approve.type !== 'typed_data') throw new Error('no payment view');
  const view = read.view;
  const approve = view.approve as Extract<typeof view.approve, { type: 'typed_data' }>;
  const signature = await c.signer.signTypedData(approve.typedData as never);
  const post = { verdict: 'approved', signature, previewHash: view.previewHash };
  return { c, t, permissionId, refused, id: oneOff.requestId, view, signature, post };
}

const rowFor = async (approvalId: string) =>
  (await getDb().select().from(payments).where(eq(payments.approvalId, approvalId)))[0];

describe('a one-off payment after budget_exhausted', () => {
  it('pays once from the account with the owner signature, outside the budget', async () => {
    const { c, t, permissionId, refused, id, view, signature, post } = await offered('/report');
    expect(refused.structuredContent).toMatchObject({
      state: 'failed',
      refusal: { code: 'budget_exhausted', next: 'jaw_request_budget', oneOff: { requestId: id } },
      moneyMoved: false,
    });
    expect(refused.structuredContent?.refusal?.oneOff?.approveUrl).toBe(`http://keys.test/approve/${id}`);
    expect(refused.content[0].text).toContain(`http://keys.test/approve/${id}`);
    expect(view.preview).toMatchObject({ kind: 'payment', amount: '5000', payTo: PAY_TO, resource: url('/report') });
    expect(JSON.stringify(view)).not.toContain('SELLER-SECRET');
    const before = await entriesFor(permissionId, new Date());

    const decided = await decideFromPage(id, post, verifyLocally);
    expect(decided).toMatchObject({ kind: 'ok', view: { status: 'approved', payment: { kind: 'paid' } } });
    expect(JSON.stringify(await outcomeResponse(decided).json())).not.toContain('SELLER-SECRET');

    const [sent] = paidRequests();
    expect(paidRequests()).toHaveLength(1);
    expect(sent.proof?.payload.authorization.from).toBe(t.account);
    expect(sent.proof?.payload.signature).toBe(signature);
    expect(sent.authorization).toBe(SECRET);
    const row = await rowFor(id);
    expect(row).toMatchObject({
      idempotencyKey: `approval/${id}`,
      permissionId: null,
      payer: t.account.toLowerCase(),
      state: 'signed',
      kind: 'paid',
    });
    expect(sent.key).toBe(row.id);

    expect(await entriesFor(permissionId, new Date())).toEqual(before);
    await getDb().transaction(async (tx) => {
      expect(await holdingRows(tx, t.sessionAddress, 'none')).toEqual([]);
      expect(await pulledUnderOtherGrants(tx, t.connectionId, permissionId)).toBe(0n);
    });

    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({
      status: 'approved',
      payment: { paymentId: row.id, kind: 'paid', payment: { amount: '5000', payTo: PAY_TO } },
    });
    expect(status.content[1].text).toContain('paid once from the account');
    expect(paidRequests()).toHaveLength(1);
  });

  it('replays the refused key without the link', async () => {
    const { t } = await offered('/replay');
    const again = await pay(
      t,
      { url: url('/replay'), headers: { Authorization: SECRET }, idempotencyKey: 'k1' },
      deps()
    );
    expect(again.structuredContent).toMatchObject({ refusal: { code: 'budget_exhausted' } });
    expect(again.structuredContent?.refusal?.oneOff).toBeUndefined();
  });

  it('refuses price_changed and sends nothing when the price moved before the approval', async () => {
    const { c, id, post } = await offered('/moved');
    prices.set('/moved', '5001');
    const decided = await decideFromPage(id, post, verifyLocally);
    expect(decided).toMatchObject({
      kind: 'ok',
      view: { status: 'approved', payment: { state: 'failed', kind: 'refused', code: 'price_changed' } },
    });
    expect(paidRequests()).toEqual([]);
    expect(await rowFor(id)).toMatchObject({ state: 'failed', code: 'price_changed', nonce: null });
    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent.summary).toMatch(/Nothing was sent/);
  });

  it('refuses a decision after the challenge timed out, with no row and no request to the seller', async () => {
    timeouts.set('/short', 60);
    const { id, view, post } = await offered('/short');
    expect(new Date(view.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    const asked = seen.length;
    const late = new Date(Date.now() + 61_000);
    const decided = await decideFromPage(id, post, verifyLocally, late);
    expect(decided).toMatchObject({ kind: 'not_pending', view: { status: 'expired' } });
    expect(await rowFor(id)).toBeUndefined();
    expect(seen.length).toBe(asked);
  });

  it("refuses another account's signature and leaves the approval pending", async () => {
    const { id, view, post } = await offered('/stranger');
    const approve = view.approve as Extract<typeof view.approve, { type: 'typed_data' }>;
    const signature = await owner().signTypedData(approve.typedData as never);
    const asked = seen.length;
    expect((await decideFromPage(id, { ...post, signature }, verifyLocally)).kind).toBe('bad_signature');
    expect((await findById(id, new Date()))?.state.status).toBe('pending');
    expect(await rowFor(id)).toBeUndefined();
    expect(seen.length).toBe(asked);
  });

  it('sends once for two decisions with the same signature', async () => {
    const { id, post } = await offered('/twice');
    const both = await Promise.all([decideFromPage(id, post, verifyLocally), decideFromPage(id, post, verifyLocally)]);
    expect(both.map((d) => d.kind).sort()).toEqual(['not_pending', 'ok']);
    expect(paidRequests()).toHaveLength(1);
  });

  it('answers payments_paused before recording the decision, and the approval stays usable', async () => {
    const { id, post } = await offered('/paused');
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    try {
      const paused = await decideFromPage(id, post, verifyLocally);
      expect(paused.kind).toBe('payments_paused');
      expect(outcomeResponse(paused).status).toBe(503);
      expect((await findById(id, new Date()))?.state.status).toBe('pending');
    } finally {
      await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
    }
    expect(await decideFromPage(id, post, verifyLocally)).toMatchObject({
      kind: 'ok',
      view: { payment: { kind: 'paid' } },
    });
  });

  it('pays a decision stranded before the send once its lease lapsed, from jaw_request_status', async () => {
    const { c, id, signature, view } = await offered('/stranded');
    const request = (await findById(id, new Date())) as ApprovalRequest & { body: PaymentBody };
    const payload = signedPayload(request, 'approved');
    const evidence = {
      previewHash: view.previewHash,
      payloadHash: payloadHash(payload),
      proof: { type: 'signature' as const, signature, assertionRef: keccak256(signature) },
      decidedAt: new Date(),
    };
    const decided = decide(request, 'approved', evidence, new Date());
    if (!decided.ok) throw new Error('setup');
    const row = oneOffRow({ ...decided.request, body: request.body }, await sellerRequestOf(request.id));
    expect(await recordDecision(decided.request, { payment: row })).toBe(true);

    const waiting = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(waiting.structuredContent).toMatchObject({ status: 'approved', payment: { state: 'pending' } });
    expect(paidRequests()).toEqual([]);

    await getDb().execute(sql`update payments set lease_until = now() - interval '1 second' where approval_id = ${id}`);
    const resumed = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(resumed.structuredContent).toMatchObject({ payment: { kind: 'paid' } });
    await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(paidRequests()).toHaveLength(1);
  });

  it('resends the same proof under the same key when the answer to the send was lost', async () => {
    dropNextPaid = new Set(['/lost']);
    const { c, id, post } = await offered('/lost');
    expect(await decideFromPage(id, post, verifyLocally)).toMatchObject({
      view: { payment: { state: 'signed', code: 'no_response' } },
    });
    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ payment: { kind: 'paid' } });
    const [first, second] = paidRequests();
    expect(paidRequests()).toHaveLength(2);
    expect(second.proof).toEqual(first.proof);
    expect(second.key).toBe(first.key);
  });
});

const statusOutcomes = async () =>
  (await getDb().select().from(auditEvents).where(eq(auditEvents.tool, 'jaw_request_status'))).map((e) => e.outcome);

describe('the audit record of jaw_request_status', () => {
  it('given a one-off refused with price_changed, when its status is read, then the outcome is price_changed', async () => {
    const { c, id, post } = await offered('/audit-moved');
    prices.set('/audit-moved', '5001');
    await decideFromPage(id, post, verifyLocally);
    await getDb().delete(auditEvents);
    await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(await statusOutcomes()).toEqual(['price_changed']);
  });

  it('given a one-off whose resend is lost again, when its status is read, then the outcome is unknown', async () => {
    dropNextPaid = new Set(['/audit-lost']);
    const { c, id, post } = await offered('/audit-lost');
    await decideFromPage(id, post, verifyLocally);
    await getDb().delete(auditEvents);
    dropNextPaid = new Set(['/audit-lost']);
    await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(await statusOutcomes()).toEqual(['unknown']);
  });
});

describe('the payment source', () => {
  it('refuses a row charged to both a budget and an approval, or to neither', async () => {
    const { id } = await offered('/source');
    const base = { connectionId: (await rowsOf(id)).connectionId, payer: '0x1', url: 'x', requestHash: 'h' };
    const insert = (key: string, over: object) =>
      getDb()
        .insert(payments)
        .values({ id: key, idempotencyKey: key, leaseUntil: new Date(), ...base, ...over });
    await expect(insert('both', { permissionId: '0xp', approvalId: id })).rejects.toThrow();
    await expect(insert('neither', {})).rejects.toThrow();
  });
});

const rowsOf = async (id: string) =>
  (await getDb().select().from(approvalRequests).where(eq(approvalRequests.id, id)))[0];
