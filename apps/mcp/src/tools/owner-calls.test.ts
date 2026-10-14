import { randomBytes } from 'node:crypto';
import { getSupportedChains, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { eq, sql } from 'drizzle-orm';
import { toHex, type Address } from 'viem';
import { entryPoint08Address } from 'viem/account-abstraction';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { endConnection } from '@/connections/rows';
import { callTool, connect, fakeWallet, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, ownerCalls, sends, settings } from '@/db/schema';
import { countHit } from '@/db/settings';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { gateCode } from '@/payments/render';
import type { ReadReceipt } from '@/owner-calls/receipt';
import { sendCalls, sendCallsStatus, type SendCallsInput } from './owner-calls';

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const TARGET: Address = '0x2222222222222222222222222222222222222222';
const OTHER: Address = '0x3333333333333333333333333333333333333333';
const SECRET_DATA = `0xa9059cbb${'5ec2e7'.repeat(10)}`;
const CALL = { to: TARGET, data: '0xa9059cbb', value: '5' };

let opened: { chainId: number; until: Date }[] = [];
let asked: { method: string; params: unknown[] }[] = [];
let closed: string[] = [];

const idle = (): Wallet => {
  const url = `http://keys.test/cli-bridge?session=idle-${randomBytes(4).toString('hex')}`;
  return { url, run: () => new Promise(() => {}), close: () => closed.push(url) };
};
const ended = (): Wallet => ({
  url: `http://keys.test/cli-bridge?session=ended-${opened.length}`,
  run: () => Promise.resolve(undefined as never),
  close: () => {},
});
const wallet =
  (answer?: Ask, make: () => Wallet = idle): OpenWallet =>
  async (chainId, until) => {
    opened.push({ chainId, until });
    return answer ? fakeWallet(answer, asked)(chainId, until) : make();
  };
const busy: OpenWallet = async () => {
  throw new WalletBusy();
};

const rejected = () => {
  throw Object.assign(new Error('User rejected the request'), { code: 4001 });
};
const owner =
  (account: string, over: Record<string, () => unknown> = {}): Ask =>
  async (method) => {
    const answer = over[method];
    if (answer) return answer();
    if (method === 'eth_requestAccounts') return [account];
    if (method === 'wallet_sendCalls') return { id: CALLS_ID };
    throw new Error(`the test wallet does not answer ${method}`);
  };

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  opened = [];
  asked = [];
  closed = [];
});
afterEach(async () => {
  await walletsSettled();
  await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
});

async function connected(scope = 'wallet:read') {
  const c = await connect(undefined, { scope });
  await walletsSettled();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { t, token: c.access_token as string };
}

const input = (over: Partial<SendCallsInput> = {}): SendCallsInput => ({
  calls: [CALL, { to: OTHER, value: '7' }],
  idempotencyKey: 'agent-key',
  ...over,
});
const send = (t: Tenant, args: Partial<SendCallsInput> = {}, openWallet = wallet()) =>
  sendCalls(t, input(args), { openWallet, receipt: async () => null });
const rowsOf = (connectionId: string) =>
  getDb().select().from(ownerCalls).where(eq(ownerCalls.connectionId, connectionId));
const settle = async () => {
  await walletsSettled();
  await new Promise((resolve) => setImmediate(resolve));
};
const rewrite = async (id: string, set: { approveBy: ReturnType<typeof sql> }) => {
  await getDb().execute(sql`alter table owner_calls disable trigger owner_calls_guard`);
  await getDb().update(ownerCalls).set(set).where(eq(ownerCalls.id, id));
  await getDb().execute(sql`alter table owner_calls enable trigger owner_calls_guard`);
};

describe('jaw_send_calls link', () => {
  it('given a connection with only wallet:read, when it sends two calls, then it gets a link and nothing is spent', async () => {
    const { t } = await connected();

    const result = await send(t);

    const out = result.structuredContent!;
    expect(result.isError).toBeFalsy();
    expect(out).toMatchObject({
      state: 'awaiting_owner',
      idempotencyKey: 'agent-key',
      chainId: t.chainId,
      from: t.account,
      totalValue: '12',
      calls: [
        { to: TARGET, value: '5', selector: '0xa9059cbb' },
        { to: OTHER, value: '7', selector: null },
      ],
    });
    expect(out.id).toMatch(/^oc_[A-Za-z0-9_-]{22}$/);
    expect(out.url).toMatch(/^http:\/\/keys\.test\/cli-bridge/);
    expect(Date.parse(out.approveBy) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(out.approveBy) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(opened).toHaveLength(1);
    expect(opened[0].chainId).toBe(t.chainId);
    expect(opened[0].until.toISOString()).toBe(out.approveBy);
    expect(await getDb().select().from(sends).where(eq(sends.connectionId, t.connectionId))).toEqual([]);
    expect(await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId))).toEqual([]);
  });

  it('given calldata from the client, when the link is answered, then only the selector appears in the result', async () => {
    const { t } = await connected();

    const result = await send(t, { calls: [{ to: TARGET, data: SECRET_DATA }] });

    expect(JSON.stringify(result)).not.toContain('5ec2e7');
    expect(result.structuredContent!.calls).toEqual([{ to: TARGET, value: '0', selector: '0xa9059cbb' }]);
    expect(result.structuredContent!.summary).not.toContain(SECRET_DATA);
  });

  it('given a call with capabilities or an unknown key, when it is sent, then the input is refused and no wallet opens', async () => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_send_calls', {
      calls: [{ to: TARGET, capabilities: { paymasterService: { url: 'http://evil.test' } } }],
    });

    expect(result.isError).toBe(true);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });
});

describe('jaw_send_calls approval', () => {
  it('given an owner who approves, then the wallet is asked the account and exactly one wallet_sendCalls with the server envelope', async () => {
    const { t } = await connected();

    const result = await send(t, {}, wallet(owner(t.account)));
    await settle();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'wallet_sendCalls']);
    expect(asked[1].params).toEqual([
      {
        version: '2.0.0',
        chainId: toHex(t.chainId),
        from: t.account,
        atomicRequired: true,
        calls: [
          { to: TARGET, data: '0xa9059cbb', value: '0x5' },
          { to: OTHER, data: '0x', value: '0x7' },
        ],
      },
    ]);
    const [row] = await rowsOf(t.connectionId);
    expect(row).toMatchObject({ id: result.structuredContent!.id, state: 'sent', callsId: CALLS_ID, code: null });
  });

  it('given an owner who rejects at the send, then the row is owner_declined and the key answers it', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: rejected })));
    await settle();
    const again = await send(t);

    expect(again.structuredContent).toMatchObject({
      state: 'owner_declined',
      refusal: { code: 'owner_declined' },
      summary: 'The owner declined the calls in the wallet. Nothing was sent.',
    });
    expect(again.structuredContent!.url).toBeUndefined();
    expect(opened).toHaveLength(1);
  });

  it('given an owner who rejects the account request, then the row is owner_declined', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { eth_requestAccounts: rejected })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'owner_declined', code: 'owner_declined' });
  });

  it('given a wallet that signs in with another account, then wrong_account and wallet_sendCalls is never asked', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(OTHER)));
    await settle();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    const [row] = await rowsOf(t.connectionId);
    expect(row).toMatchObject({ state: 'owner_declined', code: 'wrong_account' });
    const again = await send(t);
    expect(again.structuredContent!.summary).toContain('another account');
  });

  it('given a wallet that fails the account request with a code, then the open row says so until a new link opens', async () => {
    const { t } = await connected();
    const fail = () => {
      throw Object.assign(new Error('unsupported'), { code: 4200 });
    };
    const lingering = (): Wallet => ({
      ...idle(),
      run: (work) => {
        void work(owner(t.account, { eth_requestAccounts: fail }));
        return new Promise(() => {});
      },
    });

    await send(t, {}, wallet(undefined, lingering));
    await vi.waitFor(async () => expect((await rowsOf(t.connectionId))[0].code).toBe('wallet_error:4200'));
    const again = await send(t);

    expect(again.structuredContent).toMatchObject({ state: 'awaiting_owner', refusal: { code: 'wallet_error:4200' } });
    expect(again.structuredContent!.url).toBeUndefined();
    expect(again.structuredContent!.summary).toContain('4200');
    expect(opened).toHaveLength(1);
  });

  it('given a send the wallet answered without a calls id, then the key gets no new link and a may-have-sent summary', async () => {
    const { t } = await connected();

    await send(
      t,
      {},
      wallet(
        owner(t.account, {
          wallet_sendCalls: () => {
            throw new Error('socket closed');
          },
        })
      )
    );
    await settle();
    const again = await send(t, {}, wallet());

    expect(again.structuredContent).toMatchObject({ state: 'awaiting_owner', refusal: { code: 'send_started' } });
    expect(again.structuredContent!.url).toBeUndefined();
    expect(again.structuredContent!.summary).toContain('may have sent');
    expect(again.structuredContent!.summary).toContain(again.structuredContent!.id);
    expect(opened).toHaveLength(1);
  });

  it('given a row already past approveBy when the owner answers, then the wallet is never asked to send', async () => {
    const { t } = await connected();
    const gate = Promise.withResolvers<void>();
    const slow: Ask = async (method, params) => {
      if (method === 'eth_requestAccounts') await gate.promise;
      return owner(t.account)(method, params);
    };

    const first = await send(t, {}, wallet(slow));
    await rewrite(first.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });
    gate.resolve();
    await settle();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
  });
});

describe('jaw_send_calls refusals', () => {
  it.each([
    ['the account', (t: Tenant) => t.account],
    ['the permission manager', () => PERMISSIONS_MANAGER_ADDRESS],
    ['the entry point', () => entryPoint08Address],
    ['the account in lower case', (t: Tenant) => t.account.toLowerCase()],
    ['the entry point in lower case', () => entryPoint08Address.toLowerCase()],
  ])('given a call to %s, then call_target_refused and no wallet opens', async (_name, target) => {
    const { t } = await connected();

    const result = await send(t, { calls: [CALL, { to: target(t) as Address }] });

    expect(result[gateCode]).toBe('call_target_refused');
    expect(result.isError).toBe(true);
    expect(opened).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given a chain JAW does not support, then unsupported_chain and no wallet opens', async () => {
    const { t } = await connected();

    const result = await send(t, { chainId: 324 });

    expect(result[gateCode]).toBe('unsupported_chain');
    expect(opened).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given another chain JAW supports, then the relay opens on the connection chain and the envelope carries the call chain', async () => {
    const { t } = await connected();
    const other = getSupportedChains(true).find((chain) => chain.id !== t.chainId)!.id;

    const result = await send(t, { chainId: other }, wallet(owner(t.account)));
    await settle();

    expect(result.structuredContent!.chainId).toBe(other);
    expect(opened[0].chainId).toBe(t.chainId);
    expect((asked[1].params[0] as { chainId: string }).chainId).toBe(toHex(other));
  });

  it('given the same key and input while the link is live, then the same id and url and no second wallet', async () => {
    const { t } = await connected();

    const first = await send(t);
    const second = await send(t);

    expect(second.structuredContent).toMatchObject({
      id: first.structuredContent!.id,
      url: first.structuredContent!.url,
    });
    expect(opened).toHaveLength(1);
  });

  it('given the same key with other calls, then idempotency_conflict', async () => {
    const { t } = await connected();
    await send(t);

    const result = await send(t, { calls: [{ to: OTHER }] });

    expect(result[gateCode]).toBe('idempotency_conflict');
    expect(opened).toHaveLength(1);
  });

  it('given the same key with the same calls spelled in other case, then it is the same request', async () => {
    const { t } = await connected();
    const first = await send(t);

    const second = await send(t, {
      calls: [
        { ...CALL, to: TARGET.toLowerCase() as Address },
        { to: OTHER, value: '7' },
      ],
    });

    expect(second.structuredContent!.id).toBe(first.structuredContent!.id);
  });

  it('given a request awaiting the owner, when another key asks, then calls_in_progress names the open id and key', async () => {
    const { t } = await connected();
    const first = await send(t);

    const result = await send(t, { idempotencyKey: 'second' });

    expect(result[gateCode]).toBe('calls_in_progress');
    expect(result.content[0].text).toContain(first.structuredContent!.id);
    expect(result.content[0].text).toContain('agent-key');
    expect(opened).toHaveLength(1);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given a request that expired, when another key asks, then it gets its own link', async () => {
    const { t } = await connected();
    const first = await send(t);
    await rewrite(first.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });

    const result = await send(t, { idempotencyKey: 'second' });

    expect(result.structuredContent).toMatchObject({ state: 'awaiting_owner', idempotencyKey: 'second' });
    const old = await send(t);
    expect(old.structuredContent).toMatchObject({ state: 'expired' });
    expect(old.structuredContent!.url).toBeUndefined();
    expect(old.structuredContent!.summary).toContain('Use a new idempotencyKey');
  });

  it('given the server restarted while awaiting the owner, then the same key gets a new url on the same row and approveBy', async () => {
    const { t } = await connected();
    const first = await send(t, {}, wallet(undefined, ended));
    await settle();

    const second = await send(t, {}, wallet());

    expect(second.structuredContent!.id).toBe(first.structuredContent!.id);
    expect(second.structuredContent!.approveBy).toBe(first.structuredContent!.approveBy);
    expect(second.structuredContent!.url).toBeDefined();
    expect(second.structuredContent!.url).not.toBe(first.structuredContent!.url);
    expect(opened).toHaveLength(2);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given the connection ended, then connection_ended and no wallet opens', async () => {
    const { t } = await connected();
    await endConnection(t.connectionId, t.account);

    const result = await send(t);

    expect(result[gateCode]).toBe('connection_ended');
    expect(opened).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given the connection ended and a link that would reopen, then connection_ended and no wallet opens', async () => {
    const { t } = await connected();
    await send(t, {}, wallet(undefined, ended));
    await settle();
    await endConnection(t.connectionId, t.account);

    const result = await send(t);

    expect(result[gateCode]).toBe('connection_ended');
    expect(opened).toHaveLength(1);
  });

  it('given the owner pool is full, then wallet_busy and no row is stored', async () => {
    const { t } = await connected();

    const result = await send(t, {}, busy);

    expect(result[gateCode]).toBe('wallet_busy');
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given payments paused, then payments_paused and no wallet opens, while a stored row still answers', async () => {
    const { t } = await connected();
    const first = await send(t);
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });

    const stored = await send(t);
    const fresh = await send(t, { idempotencyKey: 'other' });

    expect(stored.structuredContent!.id).toBe(first.structuredContent!.id);
    expect(fresh[gateCode]).toBe('payments_paused');
    expect(opened).toHaveLength(1);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given payments paused and a link that would reopen, then payments_paused', async () => {
    const { t } = await connected();
    await send(t, {}, wallet(undefined, ended));
    await settle();
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });

    const result = await send(t);

    expect(result[gateCode]).toBe('payments_paused');
    expect(opened).toHaveLength(1);
  });

  it('given ten links this minute, when an eleventh would open, then rate_limited and nothing is stored', async () => {
    const { t } = await connected();
    for (let i = 0; i < 10; i++) await countHit(`owner-calls:${t.connectionId}`, RATE_WINDOW_MS);

    const result = await send(t);

    expect(result[gateCode]).toBe('rate_limited');
    expect(opened).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given calls sent as jaw_send_calls through the server, then the tool needs only wallet:read', async () => {
    const { token } = await connected('wallet:read');

    const result = await callTool(token, 'jaw_send_calls', { calls: [{ to: TARGET }], chainId: 324 });

    expect(result.content[0].text).toMatch(/^unsupported_chain: /);
  });
});

const TX = `0x${'ab'.repeat(32)}`;
const STATUS_KEY = 'status-key';

const check = (t: Tenant, id: string, receipt: ReadReceipt = async () => null) =>
  sendCallsStatus(t, { id }, { openWallet: wallet(), receipt });

async function sentRow() {
  const { t, token } = await connected();
  const first = await send(t, { idempotencyKey: STATUS_KEY }, wallet(owner(t.account)));
  await settle();
  return { t, token, id: first.structuredContent!.id };
}

describe('jaw_send_calls_status', () => {
  it('given a sent row whose receipt succeeded, then landed with the tx hash and the row is concluded', async () => {
    const { t, id } = await sentRow();
    const receipt = vi.fn<ReadReceipt>(async () => ({ success: true, txHash: TX }));

    const result = await check(t, id, receipt);

    expect(receipt).toHaveBeenCalledWith(t.chainId, CALLS_ID);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ state: 'landed', txHash: TX, callsId: CALLS_ID });
    expect(result.structuredContent!.summary).toBe(`Mined in ${TX}.`);
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'landed', txHash: TX });
  });

  it('given a sent row whose receipt failed, then reverted, isError and the tx hash', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id, async () => ({ success: false, txHash: TX }));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ state: 'reverted', txHash: TX });
    expect(result.structuredContent!.summary).toContain('owner paid the gas');
  });

  it('given a sent row with no receipt yet, then it stays sent and says to call again', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id);

    expect(result.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    expect(result.structuredContent!.summary).toContain('call jaw_send_calls_status again');
    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it('given a sent row long past approveBy with no receipt, then it says to check the account', async () => {
    const { t, id } = await sentRow();
    await rewrite(id, { approveBy: sql`statement_timestamp() - interval '11 minutes'` });

    const result = await check(t, id);

    expect(result.structuredContent!.state).toBe('sent');
    expect(result.structuredContent!.summary).toContain('check the account before sending these calls again');
  });

  it('given a bundler that cannot be read, then the stored row answers with a note and nothing is written', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id, async () => {
      throw new Error('rpc down');
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.state).toBe('sent');
    expect(result.structuredContent!.summary).toContain(
      'The chain could not be read right now; this is the request as last stored.'
    );
    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it('given a row past approveBy still awaiting the owner, then expired and the chain is not read', async () => {
    const { t } = await connected();
    const first = await send(t);
    await rewrite(first.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });
    const receipt = vi.fn<ReadReceipt>(async () => null);

    const result = await check(t, first.structuredContent!.id, receipt);

    expect(result.structuredContent!.state).toBe('expired');
    expect(receipt).not.toHaveBeenCalled();
  });

  it('given a row awaiting the owner, then it answers the link without reading the chain', async () => {
    const { t } = await connected();
    const first = await send(t);
    const receipt = vi.fn<ReadReceipt>(async () => null);

    const result = await check(t, first.structuredContent!.id, receipt);

    expect(result.structuredContent).toMatchObject({ state: 'awaiting_owner', url: first.structuredContent!.url });
    expect(receipt).not.toHaveBeenCalled();
  });

  it('given a send_started row with no calls id, then it answers the stored row and reads no receipt', async () => {
    const { t } = await connected();
    await send(
      t,
      {},
      wallet(
        owner(t.account, {
          wallet_sendCalls: () => {
            throw new Error('socket closed');
          },
        })
      )
    );
    await settle();
    const [row] = await rowsOf(t.connectionId);
    const receipt = vi.fn<ReadReceipt>(async () => ({ success: true, txHash: TX }));

    const result = await check(t, row.id, receipt);

    expect(receipt).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ state: 'awaiting_owner', refusal: { code: 'send_started' } });
    expect(result.structuredContent!.url).toBeUndefined();
    expect(result.structuredContent!.summary).toContain('may have sent');
  });

  it('given another connection id, then not_found, the same as an id that never existed', async () => {
    const { id } = await sentRow();
    const { t: other } = await connected();

    const foreign = await check(other, id);
    const missing = await check(other, `oc_${'A'.repeat(22)}`);

    expect(foreign[gateCode]).toBe('not_found');
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toEqual(missing.content);
  });

  it('given more than 30 reads this minute, then rate_limited', async () => {
    const { t, id } = await sentRow();
    for (let i = 0; i < 30; i++) await countHit(`owner-calls-status:${t.connectionId}`, RATE_WINDOW_MS);

    const result = await check(t, id);

    expect(result[gateCode]).toBe('rate_limited');
  });

  it('given a wallet:read token, then the tool is served and refuses a malformed id', async () => {
    const { token } = await connected('wallet:read');

    const result = await callTool(token, 'jaw_send_calls_status', { id: `oc_${'A'.repeat(22)}` });

    expect(result.content[0].text).toMatch(/^not_found: /);
    const bad = await callTool(token, 'jaw_send_calls_status', { id: 'nope' });
    expect(bad.isError).toBe(true);
  });
});
