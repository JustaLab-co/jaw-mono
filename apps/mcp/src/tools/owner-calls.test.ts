import { randomBytes } from 'node:crypto';
import { getSupportedChains, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { eq, sql } from 'drizzle-orm';
import type { ChainClients } from '@jaw.id/agent';
import { toHex, type Address, type Hex } from 'viem';
import {
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  entryPoint09Address,
} from 'viem/account-abstraction';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { endConnection } from '@/connections/rows';
import { SESSION_RENEW_MS } from '@/connections/session-lease';
import {
  callTool,
  connect,
  fakeWallet,
  mcp,
  owner as newSigner,
  setTestEnv,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, ownerCalls, rateLimits, sends, settings } from '@/db/schema';
import { hitsThisWindow, TEST_PG_URL, useTestDb, useTestPostgres, withoutOwnerCallsGuard } from '@/db/test-db';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { gateCode } from '@/payments/render';
import { SEND_STARTED } from '@/owner-calls/store';
import * as store from '@/owner-calls/store';
import { fakeChain, type FakeEvent } from '@/owner-calls/chain-testkit';
import type { ReadReceipt } from '@/owner-calls/receipt';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';
import { sendCalls, sendCallsStatus, type SendCallsInput } from './owner-calls';
import { ACCOUNT_BUSY, FOR_AGENT } from './reply';

// The tool as the server registers it opens its wallets through the owner relay, counted here.
const served = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock('@/connections/relay', async (original) => ({
  ...(await original<object>()),
  ownerRelay: async (_chainId: number, _until: Date, client?: unknown) => {
    served.clients.push(client);
    return { url: 'http://keys.test/cli-bridge?session=served', run: () => new Promise(() => {}), close: () => {} };
  },
}));

// Holds the next request between reading its own key and counting the account's links.
const turn = vi.hoisted(() => ({ beforeCount: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('@/owner-calls/cap', async (original) => {
  const cap = await original<typeof import('@/owner-calls/cap')>();
  return {
    ...cap,
    countOpenLinks: async (...args: Parameters<typeof cap.countOpenLinks>) => {
      const wait = turn.beforeCount;
      turn.beforeCount = undefined;
      await wait?.();
      return cap.countOpenLinks(...args);
    },
  };
});

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

const quietChain = fakeChain({ head: 1_000_000n }).clients;

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  turn.beforeCount = undefined;
  served.clients = [];
  opened = [];
  asked = [];
  closed = [];
});
afterEach(async () => {
  await walletsSettled();
  await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
});

async function connected(scope = 'wallet:read', signer = newSigner()) {
  const c = await connect(signer, { scope });
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
  sendCalls(t, input(args), { openWallet, receipt: async () => null, clients: quietChain });
const rowsOf = (connectionId: string) =>
  getDb().select().from(ownerCalls).where(eq(ownerCalls.connectionId, connectionId));
const settle = async () => {
  await walletsSettled();
  await new Promise((resolve) => setImmediate(resolve));
};
// A session's end clears its lease with a write of its own; wait for it before retrying.
const sessionEnded = (connectionId: string) =>
  vi.waitFor(async () =>
    expect((await rowsOf(connectionId)).map((r) => r.sessionUntil)).not.toContainEqual(expect.any(Date))
  );
const rewrite = (id: string, set: { approveBy: ReturnType<typeof sql> }) =>
  withoutOwnerCallsGuard(() => getDb().update(ownerCalls).set(set).where(eq(ownerCalls.id, id)));

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
    expect(Date.parse(out.approveBy) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(Date.parse(out.approveBy) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
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

  it('given a call with capabilities, when it is sent through the server, then the input is refused and no wallet opens', async () => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_send_calls', {
      calls: [{ to: TARGET, capabilities: { paymasterService: { url: 'http://evil.test' } } }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Input validation error/);
    expect(served.clients).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given an unknown key beside the calls, when it is sent through the server, then the input is refused and no wallet opens', async () => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_send_calls', { calls: [{ to: TARGET }], atomic: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Input validation error/);
    expect(result.content[0].text).toContain('atomic');
    expect(served.clients).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given a valid call through the server, then the wallet opens once for the connection client', async () => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_send_calls', { calls: [{ to: TARGET }] });

    expect(result.isError).toBeFalsy();
    expect(served.clients).toEqual([expect.objectContaining({ clientId: t.clientId, clientName: t.clientName })]);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given no idempotency key, then one is made up, returned, and distinct per request', async () => {
    const { t } = await connected();
    const bare = (openWallet: OpenWallet) =>
      sendCalls(t, { calls: [CALL] }, { openWallet, receipt: async () => null, clients: quietChain });

    const first = await bare(wallet());
    await getDb()
      .update(ownerCalls)
      .set({ state: 'owner_declined', code: 'owner_declined' })
      .where(eq(ownerCalls.connectionId, t.connectionId));
    const second = await bare(wallet());

    expect(first.structuredContent!.idempotencyKey).toMatch(/^auto_[A-Za-z0-9_-]{16}$/);
    expect(second.structuredContent!.idempotencyKey).toMatch(/^auto_[A-Za-z0-9_-]{16}$/);
    expect(second.structuredContent!.idempotencyKey).not.toBe(first.structuredContent!.idempotencyKey);
  });

  it('given eleven calls or none, when they are sent through the server, then the input is refused before any wallet opens, and ten are served', async () => {
    const { t, token } = await connected();
    const many = (n: number) => Array.from({ length: n }, () => ({ to: TARGET }));

    const eleven = await callTool(token, 'jaw_send_calls', { calls: many(11) });
    const none = await callTool(token, 'jaw_send_calls', { calls: [] });
    const ten = await callTool(token, 'jaw_send_calls', { calls: many(10) });

    for (const refused of [eleven, none]) {
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('Input validation error');
      expect(refused.content[0].text).toContain('calls');
    }
    expect(ten.isError).toBeFalsy();
    expect(served.clients).toHaveLength(1);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  const BAD_INPUT: [string, Record<string, unknown>][] = [
    ['a value with a leading zero', { calls: [{ to: TARGET, value: '007' }] }],
    ['a value of 2^256', { calls: [{ to: TARGET, value: (2n ** 256n).toString() }] }],
    ['a value that is not decimal', { calls: [{ to: TARGET, value: '0x10' }] }],
    ['calldata that is not hex', { calls: [{ to: TARGET, data: '0xzzzzzzzz' }] }],
    ['calldata shorter than a selector', { calls: [{ to: TARGET, data: '0x1234' }] }],
    ['calldata over 24 KiB', { calls: [{ to: TARGET, data: `0x${'ab'.repeat(24_577)}` }] }],
    ['an idempotency key with a space', { calls: [{ to: TARGET }], idempotencyKey: 'has space' }],
    ['an idempotency key over 100 characters', { calls: [{ to: TARGET }], idempotencyKey: 'k'.repeat(101) }],
    ['a target that is not an address', { calls: [{ to: 'not an address' }] }],
  ];

  it.each(BAD_INPUT)('given %s, then the input is refused and no wallet opens', async (_name, args) => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_send_calls', args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Input validation error/);
    expect(served.clients).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given calldata of exactly 24 KiB and a value of 2^256 - 1, then both are accepted', async () => {
    const { t } = await connected();

    const result = await send(t, {
      calls: [{ to: TARGET, data: `0x${'ab'.repeat(24_576)}`, value: (2n ** 256n - 1n).toString() }],
    });

    expect(result.structuredContent!.state).toBe('awaiting_owner');
  });

  it('given a lower-case target, then it is stored and answered checksummed', async () => {
    const { t } = await connected();

    const result = await send(
      t,
      { calls: [{ to: '0xdac17f958d2ee523a2206206994597c13d831ec7' }] },
      wallet(owner(t.account))
    );
    await settle();

    expect(result.structuredContent!.calls[0].to).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    expect((await rowsOf(t.connectionId))[0].calls[0].to).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    expect((asked[1].params[0] as { calls: { to: string }[] }).calls[0].to).toBe(
      '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    );
  });

  it('given a selector in upper case, then the answer shows it in lower case', async () => {
    const { t } = await connected();

    const result = await send(t, { calls: [{ to: TARGET, data: '0xA9059CBB' }] });

    expect(result.structuredContent!.calls[0].selector).toBe('0xa9059cbb');
  });

  it('given calldata in upper case, then it is stored and sent to the wallet in lower case, and the lower-case request replays', async () => {
    const { t } = await connected();

    const first = await send(t, { calls: [{ to: TARGET, data: '0xA9059CBB00AB' }] }, wallet(owner(t.account)));
    await settle();
    const again = await send(t, { calls: [{ to: TARGET, data: '0xa9059cbb00ab' }] });

    expect((await rowsOf(t.connectionId))[0].calls[0].data).toBe('0xa9059cbb00ab');
    expect((asked[1].params[0] as { calls: { data: string }[] }).calls[0].data).toBe('0xa9059cbb00ab');
    expect(again.structuredContent!.id).toBe(first.structuredContent!.id);
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
      summary: 'The owner declined this in the wallet. Nothing was sent.',
    });
    expect(again.structuredContent!.url).toBeUndefined();
    expect(opened).toHaveLength(1);
  });

  it.each([4100, 4200, 4900, 4901, 5700, 5710, -32602])(
    'given a wallet that refuses wallet_sendCalls with %i, which it only returns before submitting, then the row is owner_declined and the key says nothing was sent',
    async (code) => {
      const { t } = await connected();
      const refuse = () => {
        throw Object.assign(new Error('the wallet refused'), { code });
      };

      await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: refuse })));
      await settle();
      const again = await send(t);

      expect((await rowsOf(t.connectionId))[0]).toMatchObject({
        state: 'owner_declined',
        code: `wallet_error:${code}`,
      });
      expect(again.structuredContent).toMatchObject({
        state: 'owner_declined',
        refusal: { code: `wallet_error:${code}` },
      });
      expect(again.structuredContent!.url).toBeUndefined();
      expect(spoken(again)).toBe('The wallet turned this request down before sending it. Nothing was sent.');
      expect(toAgent(again).join('\n')).toContain(`refused the calls with ${code} before sending them`);
      expect(toAgent(again).join('\n')).toContain('new idempotencyKey');
      expect(opened).toHaveLength(1);
    }
  );

  it.each([-32000, -32603, -32003, 4002, undefined])(
    'given a wallet that fails wallet_sendCalls with %s, which can follow a submission, then the row keeps the send marker and the key says the wallet may have sent',
    async (code) => {
      const { t } = await connected();
      const fail = () => {
        throw Object.assign(new Error('the wallet failed'), { code });
      };

      await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: fail })));
      await settle();
      const again = await send(t);

      expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
      expect(again.structuredContent!.summary).toContain('may have sent');
      expect(again.structuredContent!.url).toBeUndefined();
    }
  );

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
    expect(again.structuredContent!.summary).toContain('answered 4200 when asked');
    expect(again.structuredContent!.summary).not.toContain('wallet_error:');
    expect(spoken(again)).toBe('The wallet could not open this request. Nothing was sent.');
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
    expect(spoken(again)).toContain('may have sent');
    expect(toAgent(again).join('\n')).toContain(again.structuredContent!.id);
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

  it('given a wallet that returns the account in another case, then the owner is accepted', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(`0x${t.account.slice(2).toUpperCase()}`)));
    await settle();

    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it.each([
    ['empty', ''],
    ['257 characters', 'x'.repeat(257)],
    ['300 characters', 'x'.repeat(300)],
  ])('given a calls id that is %s, then the row keeps the send marker and is not sent', async (_name, id) => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: () => ({ id }) })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
  });

  it('given a calls id of 256 characters, then it is stored', async () => {
    const { t } = await connected();
    const id = 'x'.repeat(256);

    await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: () => ({ id }) })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'sent', callsId: id });
  });

  it('given a calls id of one character, then it is stored', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: () => ({ id: 'x' }) })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'sent', callsId: 'x' });
  });

  it.each([
    ['null', null],
    ['an object', {}],
    ['a list of numbers', [1234]],
    ['an empty list', []],
  ])('given an account answer of %s, then wrong_account and wallet_sendCalls is never asked', async (_name, answer) => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { eth_requestAccounts: () => answer })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'owner_declined', code: 'wrong_account' });
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
  });

  it('given the owner account anywhere in the accounts answered, then the owner is accepted', async () => {
    const { t } = await connected();

    await send(t, {}, wallet(owner(t.account, { eth_requestAccounts: () => [OTHER, t.account] })));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'sent', callsId: CALLS_ID });
  });

  it('given a calls id write that fails once, then it is written again and the row is sent', async () => {
    const { t } = await connected();
    const write = vi.spyOn(store, 'markSent').mockRejectedValueOnce(new Error('db blip'));

    try {
      await send(t, {}, wallet(owner(t.account)));
      await settle();

      expect(write).toHaveBeenCalledTimes(2);
      expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    } finally {
      write.mockRestore();
    }
  });

  describe('a wallet that fails the account request without a code', () => {
    let threw = 0;
    let sessions: Promise<unknown>[] = [];
    beforeEach(() => {
      threw = 0;
      sessions = [];
    });
    const failing = (t: Tenant, before: Promise<unknown> = Promise.resolve()): Wallet => ({
      ...idle(),
      run: (work) => {
        const fail = async () => {
          await before;
          threw++;
          throw new Error('relay closed');
        };
        const session = work(owner(t.account, { eth_requestAccounts: fail }));
        sessions.push(session);
        return session;
      },
    });

    it('given time left, then the row says wallet_error:unknown', async () => {
      const { t } = await connected();

      await send(
        t,
        {},
        wallet(undefined, () => failing(t))
      );

      await vi.waitFor(async () => expect((await rowsOf(t.connectionId))[0].code).toBe('wallet_error:unknown'));
    });

    const codeWithLeft = async (msLeft: number) => {
      const { t } = await connected();
      const gate = Promise.withResolvers<void>();

      await send(
        t,
        {},
        wallet(undefined, () => failing(t, gate.promise))
      );
      const [row] = await rowsOf(t.connectionId);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(row.approveBy.getTime() - msLeft);
        gate.resolve();
        await vi.waitFor(() => expect(threw).toBe(1));
        await Promise.allSettled(sessions);
        await settle();
      } finally {
        vi.useRealTimers();
      }

      return (await rowsOf(t.connectionId))[0].code;
    };

    it('given the session is within five seconds of its end, then nothing is recorded', async () => {
      expect(await codeWithLeft(2_000)).toBeNull();
      expect(await codeWithLeft(4_500)).toBeNull();
    });

    it('given the session has more than five seconds left, then the code is recorded', async () => {
      expect(await codeWithLeft(5_500)).toBe('wallet_error:unknown');
    });
  });
});

describe('jaw_send_calls refusals', () => {
  const ENTRY_POINTS = [
    ['0.6', entryPoint06Address],
    ['0.7', entryPoint07Address],
    ['0.8', entryPoint08Address],
    ['0.9', entryPoint09Address],
  ] as const;

  it.each([
    ['the account', (t: Tenant) => t.account],
    ['the permission manager', () => PERMISSIONS_MANAGER_ADDRESS],
    ['the account in lower case', (t: Tenant) => t.account.toLowerCase()],
    ...ENTRY_POINTS.flatMap(([version, address]) => [
      [`EntryPoint ${version}`, () => address],
      [`EntryPoint ${version} in lower case`, () => address.toLowerCase()],
    ]),
  ] as [string, (t: Tenant) => string][])(
    'given a call to %s, then call_target_refused and no wallet opens',
    async (_name, target) => {
      const { t } = await connected();

      const result = await send(t, { calls: [CALL, { to: target(t) as Address }] });

      expect(result[gateCode]).toBe('call_target_refused');
      expect(result.isError).toBe(true);
      expect(opened).toEqual([]);
      expect(await rowsOf(t.connectionId)).toEqual([]);
    }
  );

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

  const otherChain = () => getSupportedChains(true).find((chain) => chain.id !== 84532)!.id;
  it.each([
    ['chain', () => ({ chainId: otherChain() })],
    [
      'value',
      () => ({
        calls: [
          { ...CALL, value: '6' },
          { to: OTHER, value: '7' },
        ],
      }),
    ],
    [
      'calldata',
      () => ({
        calls: [
          { ...CALL, data: '0xa9059cbc' },
          { to: OTHER, value: '7' },
        ],
      }),
    ],
    [
      'target',
      () => ({
        calls: [
          { ...CALL, to: OTHER },
          { to: OTHER, value: '7' },
        ],
      }),
    ],
    ['order', () => ({ calls: [{ to: OTHER, value: '7' }, CALL] })],
  ])('given the same key with only the %s changed, then idempotency_conflict', async (_name, change) => {
    const { t } = await connected();
    await send(t);

    const result = await send(t, change());

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
    expect(result.content[0].text).toMatch(/^calls_in_progress: /);
    expect(spoken(result)).toMatch(
      new RegExp(
        `^An earlier request is still waiting for the owner's approval, so this one was not opened\\. It expires in (29|30) minutes\\.\\nTo approve or decline the earlier request: ${first.structuredContent!.url!.replace(/[.?]/g, '\\$&')}$`
      )
    );
    expect(toAgent(result).join('\n')).toContain(first.structuredContent!.id);
    expect(toAgent(result).join('\n')).toContain('idempotencyKey agent-key');
    expect(opened).toHaveLength(1);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given a request awaiting the owner, when another key asks, then the link it shows reads as the earlier request, never the new one', async () => {
    const { t } = await connected();
    const first = await send(t);

    const result = await send(t, { idempotencyKey: 'second' });

    expect(spoken(result)).toContain('earlier request');
    expect(spoken(result).split('\n').at(-1)).toBe(
      `To approve or decline the earlier request: ${first.structuredContent!.url}`
    );
    expect(toAgent(result)).toHaveLength(1);
    expect(toAgent(result)[0]).toContain(
      'This link is for the earlier request, not the one just asked for: never present it as the new one.'
    );
    expect(toAgent(result)[0]).toContain(
      'Once the earlier request is approved, declined or expired, send the new one again.'
    );
    expect(leaks(spoken(result))).toEqual([]);
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
    expect(spoken(old)).toBe('The owner did not approve within 30 minutes. Nothing was sent.');
    expect(toAgent(old)).toEqual([`${FOR_AGENT} If the owner still wants it, ask again with a new idempotencyKey.`]);
  });

  it('given the server restarted while awaiting the owner, then the same key gets a new url on the same row and approveBy', async () => {
    const { t } = await connected();
    const first = await send(t, {}, wallet(undefined, ended));
    await settle();
    await sessionEnded(t.connectionId);

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
    await sessionEnded(t.connectionId);
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

  it('given the same key opens its link while a retry of it finds the owner pool full, then the retry answers that link', async () => {
    const { t } = await connected();
    let opener!: ReturnType<typeof send>;
    const fullOnceOpened: OpenWallet = async () => {
      await (opener = send(t));
      throw new WalletBusy();
    };

    const retry = await send(t, {}, fullOnceOpened);

    expect(retry[gateCode]).toBeUndefined();
    expect(retry.structuredContent!.url).toBe((await opener).structuredContent!.url);
  });

  it('given a link that would reopen and the owner pool is full, then wallet_busy', async () => {
    const { t } = await connected();
    await send(t, {}, wallet(undefined, ended));
    await settle();
    await sessionEnded(t.connectionId);

    const result = await send(t, {}, busy);

    expect(result[gateCode]).toBe('wallet_busy');
  });

  it('given a link that reopened, then the owner answering it sends the calls', async () => {
    const { t } = await connected();
    await send(t, {}, wallet(undefined, ended));
    await settle();
    await sessionEnded(t.connectionId);

    await send(t, {}, wallet(owner(t.account)));
    await settle();

    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'sent', callsId: CALLS_ID });
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
    await sessionEnded(t.connectionId);
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });

    const result = await send(t);

    expect(result[gateCode]).toBe('payments_paused');
    expect(opened).toHaveLength(1);
  });

  it('given nine links this minute, when the tenth opens, then it is served', async () => {
    const { t } = await connected();
    await hitsThisWindow(`owner-calls:${t.connectionId}`, 9, RATE_WINDOW_MS);

    const result = await send(t);

    expect(result.structuredContent!.state).toBe('awaiting_owner');
  });

  it('given ten hits on the connection counter this minute, when a link is asked for, then rate_limited and nothing is stored', async () => {
    const { t } = await connected();
    await hitsThisWindow(`owner-calls:${t.connectionId}`, 10, RATE_WINDOW_MS);

    const result = await send(t);

    expect(result[gateCode]).toBe('rate_limited');
    expect(opened).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  describe('links open at once per account', () => {
    const sameAccount = async (n: number) => {
      const signer = newSigner();
      return Promise.all(Array.from({ length: n }, () => connected('wallet:read', signer).then((c) => c.t)));
    };

    it('given two links open on the account, when the same key opens the third while a retry of it is checking, then the retry answers that link', async () => {
      const [a, b, c] = await sameAccount(3);
      await send(a);
      await send(b);
      let opener!: ReturnType<typeof send>;
      turn.beforeCount = () => (opener = send(c));

      const retry = await send(c);

      expect(retry[gateCode]).toBeUndefined();
      expect(retry.structuredContent!.url).toBe((await opener).structuredContent!.url);
    });

    it('given two links open on the account, when the same key opens the third while a retry of it opens its wallet, then the retry answers that link and closes its wallet', async () => {
      const [a, b, c] = await sameAccount(3);
      await send(a);
      await send(b);
      let opener!: ReturnType<typeof send>;
      const openerFirst: OpenWallet = async (chainId, until) => {
        await (opener = send(c));
        return wallet()(chainId, until);
      };

      const retry = await send(c, {}, openerFirst);

      expect(retry[gateCode]).toBeUndefined();
      expect(retry.structuredContent!.url).toBe((await opener).structuredContent!.url);
      expect(closed).toHaveLength(1);
    });

    it('given three links open across connections of one account, when a fourth connection asks, then account_busy and no wallet opens', async () => {
      const [a, b, c, d] = await sameAccount(4);
      for (const t of [a, b, c]) await send(t);

      const result = await send(d);

      expect(result[gateCode]).toBe('account_busy');
      expect(result.content[0].text).toBe(ACCOUNT_BUSY);
      expect(opened).toHaveLength(3);
      expect(await rowsOf(d.connectionId)).toEqual([]);
    });

    it('given six connections of one account asking at once, when every one passed the count before any inserted, then three links stay open and the rest close their wallets', async () => {
      const connections = await sameAccount(6);
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const gated: OpenWallet = async (...args) => {
        if (++arrived === connections.length) release();
        await barrier;
        return wallet()(...args);
      };

      const results = await Promise.all(connections.map((t) => send(t, {}, gated)));

      const states = results.map((r) => r.structuredContent?.state ?? r[gateCode]);
      expect(states.filter((s) => s === 'awaiting_owner')).toHaveLength(3);
      expect(states.filter((s) => s === 'account_busy')).toHaveLength(3);
      expect(
        await getDb().select().from(ownerCalls).where(eq(ownerCalls.account, connections[0].account))
      ).toHaveLength(3);
      expect(closed).toHaveLength(3);
    });

    it('given three links open on one account, when another account asks, then it is served', async () => {
      const [a, b, c] = await sameAccount(3);
      for (const t of [a, b, c]) await send(t);
      const { t: other } = await connected();

      const result = await send(other);

      expect(result.structuredContent!.state).toBe('awaiting_owner');
    });

    it('given five connections of one account sending at once, then three links open and every other wallet is closed', async () => {
      const ts = await sameAccount(5);
      const urls: string[] = [];
      let allOpen = () => {};
      const gate = new Promise<void>((resolve) => {
        allOpen = () => resolve();
      });
      // Every request holds its wallet until all five have one, so all of them got past the early count.
      const openAll: OpenWallet = async (chainId, until) => {
        const w = await wallet()(chainId, until);
        urls.push(w.url);
        if (urls.length === ts.length) allOpen();
        await gate;
        return w;
      };

      const results = await Promise.all(ts.map((t) => send(t, {}, openAll)));

      expect(results.filter((r) => r.structuredContent?.state === 'awaiting_owner')).toHaveLength(3);
      expect(results.filter((r) => r[gateCode] === 'account_busy')).toHaveLength(2);
      const stored = (await Promise.all(ts.map((t) => rowsOf(t.connectionId)))).flat();
      expect(stored.map((r) => r.state)).toEqual(['awaiting_owner', 'awaiting_owner', 'awaiting_owner']);
      const kept = stored.map((r) => r.walletUrl);
      expect(urls).toHaveLength(5);
      expect([...closed].sort()).toEqual(urls.filter((u) => !kept.includes(u)).sort());
    });

    it('given two links open and a third that expired, when a connection asks, then it is served', async () => {
      const [a, b, c, d] = await sameAccount(4);
      await send(a);
      await send(b);
      const lapsed = await send(c);
      await rewrite(lapsed.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });

      const result = await send(d);

      expect(result.structuredContent!.state).toBe('awaiting_owner');
    });

    it('given a link that was declined, then it does not count', async () => {
      const [a, b, c, d] = await sameAccount(4);
      await send(a);
      await send(b);
      await send(c, {}, wallet(owner(c.account, { eth_requestAccounts: rejected })));
      await vi.waitFor(async () => expect((await rowsOf(c.connectionId))[0].state).toBe('owner_declined'));

      const result = await send(d);

      expect(result.structuredContent!.state).toBe('awaiting_owner');
    });

    it('given the account address in another case on a row, then it still counts', async () => {
      const [a, b, c, d] = await sameAccount(4);
      for (const t of [a, b, c]) await send(t);
      await withoutOwnerCallsGuard(() =>
        getDb().execute(sql`update owner_calls set account = upper(account) where connection_id = ${a.connectionId}`)
      );

      const result = await send(d);

      expect(result[gateCode]).toBe('account_busy');
    });

    it('given three links open and one whose process lost its session, when it is sent again, then it reopens', async () => {
      const [a, b, c] = await sameAccount(3);
      await send(a, {}, wallet(undefined, ended));
      await settle();
      await sessionEnded(a.connectionId);
      await send(b);
      await send(c);

      const result = await send(a, {}, wallet());

      expect(result.structuredContent!.url).toBeDefined();
      expect(opened).toHaveLength(4);
    });

    it('given three other links open, when a link whose session is lost is sent again, then account_busy and no wallet opens', async () => {
      const [a, b, c, d] = await sameAccount(4);
      await send(a, {}, wallet(undefined, ended));
      await settle();
      await sessionEnded(a.connectionId);
      await send(b);
      await send(c);
      await store.insertOwnerCall({
        connectionId: d.connectionId,
        key: 'direct',
        requestHash: 'h',
        chainId: d.chainId,
        account: d.account,
        calls: [{ to: TARGET, data: '0x', value: '0' }],
        walletUrl: 'http://keys.test/cli-bridge?session=direct',
        approveBy: new Date(Date.now() + 60_000),
      });
      const before = opened.length;

      const result = await send(a, {}, wallet());

      expect(result[gateCode]).toBe('account_busy');
      expect(opened).toHaveLength(before);
    });
  });

  describe('the limit per account', () => {
    const accountKey = (t: Tenant) => `owner-calls-account:${t.account.toLowerCase()}`;

    it('given twenty links this minute across two connections of one account, when a third connection asks, then rate_limited and nothing is stored', async () => {
      const signer = newSigner();
      const { t: first } = await connected('wallet:read', signer);
      const { t: second } = await connected('wallet:read', signer);
      const { t: third } = await connected('wallet:read', signer);
      await hitsThisWindow(accountKey(first), 10, RATE_WINDOW_MS);
      await hitsThisWindow(accountKey(second), 10, RATE_WINDOW_MS);

      const result = await send(third);

      expect(result[gateCode]).toBe('rate_limited');
      expect(opened).toEqual([]);
      expect(await rowsOf(third.connectionId)).toEqual([]);
    });

    it('given links on two connections of one account, then each one counts against the account', async () => {
      const signer = newSigner();
      const { t: first } = await connected('wallet:read', signer);
      const { t: second } = await connected('wallet:read', signer);

      await send(first);
      await send(second);

      const [{ hits }] = await getDb()
        .select({ hits: sql<number>`sum(${rateLimits.count})::int` })
        .from(rateLimits)
        .where(eq(rateLimits.key, accountKey(first)));
      expect(hits).toBe(2);
    });

    it('given nineteen links this minute on the account, when the twentieth opens, then it is served', async () => {
      const { t } = await connected();
      await hitsThisWindow(accountKey(t), 19, RATE_WINDOW_MS);

      const result = await send(t);

      expect(result.structuredContent!.state).toBe('awaiting_owner');
    });

    it('given links on another account, then they do not count', async () => {
      const { t } = await connected();
      const { t: stranger } = await connected();
      await hitsThisWindow(accountKey(stranger), 25, RATE_WINDOW_MS);

      const result = await send(t);

      expect(result.structuredContent!.state).toBe('awaiting_owner');
    });
  });

  it('given a wallet that fails to open for another reason than a full pool, then the error is not hidden as wallet_busy', async () => {
    const { t } = await connected();
    const broken: OpenWallet = async () => {
      throw new Error('relay unreachable');
    };

    await expect(send(t, {}, broken)).rejects.toThrow('relay unreachable');
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given a link that opens, then the wallet is opened for the connection client', async () => {
    const { t } = await connected();
    const clients: unknown[] = [];
    const spy: OpenWallet = async (_chainId, _until, client) => {
      clients.push(client);
      return idle();
    };

    await send(t, {}, spy);

    expect(clients).toEqual([expect.objectContaining({ clientId: t.clientId, clientName: t.clientName })]);
  });

  it('given a link that reopens, then the wallet is opened for the connection client', async () => {
    const { t } = await connected();
    await send(t, {}, wallet(undefined, ended));
    await settle();
    await sessionEnded(t.connectionId);
    const clients: unknown[] = [];
    const spy: OpenWallet = async (_chainId, _until, client) => {
      clients.push(client);
      return idle();
    };

    await send(t, {}, spy);

    expect(clients).toEqual([expect.objectContaining({ clientId: t.clientId, clientName: t.clientName })]);
  });

  it('given a row past approve_by that nobody expired yet, then the link does not reopen', async () => {
    const { t } = await connected();
    const first = await send(t, {}, wallet(undefined, ended));
    await settle();
    await sessionEnded(t.connectionId);
    await rewrite(first.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });
    const [row] = await rowsOf(t.connectionId);

    expect(await store.reopenLink(row, 'http://keys.test/cli-bridge?session=late')).toBeUndefined();
  });

  describe('two requests at once', () => {
    const together = () => {
      let reached = 0;
      const both = Promise.withResolvers<void>();
      const openWallet: OpenWallet = async () => {
        if (++reached === 2) both.resolve();
        await both.promise;
        return idle();
      };
      return { openWallet, receipt: async () => null, clients: quietChain };
    };

    it('given two keys, then one gets the link, the other calls_in_progress, and its wallet is closed', async () => {
      const { t } = await connected();
      const deps = together();

      const results = await Promise.all([
        sendCalls(t, input({ idempotencyKey: 'a' }), deps),
        sendCalls(t, input({ idempotencyKey: 'b' }), deps),
      ]);

      expect(results.map((r) => r[gateCode]).filter(Boolean)).toEqual(['calls_in_progress']);
      expect(closed).toHaveLength(1);
      expect(await rowsOf(t.connectionId)).toHaveLength(1);
    });

    it('given one key, then both get the one row and the loser closes its wallet', async () => {
      const { t } = await connected();
      const deps = together();

      const [a, b] = await Promise.all([sendCalls(t, input(), deps), sendCalls(t, input(), deps)]);

      expect(a.structuredContent!.id).toBe(b.structuredContent!.id);
      expect(closed).toHaveLength(1);
      expect(await rowsOf(t.connectionId)).toHaveLength(1);
    });

    it('given one key on a link that died, then only one new link survives', async () => {
      const { t } = await connected();
      await send(t, {}, wallet(undefined, ended));
      await settle();
      await sessionEnded(t.connectionId);
      const deps = together();

      await Promise.all([sendCalls(t, input(), deps), sendCalls(t, input(), deps)]);

      const [row] = await rowsOf(t.connectionId);
      expect(closed).toHaveLength(1);
      expect(closed).not.toContain(row.walletUrl);
    });

    it('given one key with other calls, then the loser is idempotency_conflict', async () => {
      const { t } = await connected();
      const deps = together();

      const results = await Promise.all([
        sendCalls(t, input({ calls: [CALL] }), deps),
        sendCalls(t, input({ calls: [{ to: OTHER, value: '7' }] }), deps),
      ]);

      expect(results.map((r) => r[gateCode]).filter(Boolean)).toEqual(['idempotency_conflict']);
    });

    it('given two keys, then the loser names the open request', async () => {
      const { t } = await connected();
      const deps = together();

      const results = await Promise.all([
        sendCalls(t, input({ idempotencyKey: 'a' }), deps),
        sendCalls(t, input({ idempotencyKey: 'b' }), deps),
      ]);

      const [row] = await rowsOf(t.connectionId);
      const loser = results.find((r) => r[gateCode] === 'calls_in_progress')!;
      expect(loser.content[0].text).toContain(row.id);
      expect(loser.content[0].text).toContain(row.idempotencyKey);
    });
  });

  it('given calls sent as jaw_send_calls through the server, then the tool needs only wallet:read', async () => {
    const { token } = await connected('wallet:read');

    const result = await callTool(token, 'jaw_send_calls', { calls: [{ to: TARGET }], chainId: 324 });

    expect(result.content[0].text).toMatch(/^unsupported_chain: /);
  });
});

const TX = `0x${'ab'.repeat(32)}`;
const STATUS_KEY = 'status-key';

const pastApproveBy = (minutes: number) => ({
  approveBy: sql`statement_timestamp() - make_interval(mins => ${minutes})`,
});

const check = (t: Tenant, id: string, receipt: ReadReceipt = async () => null) =>
  sendCallsStatus(t, { id }, { openWallet: wallet(), receipt, clients: quietChain });

async function sentRow() {
  const { t, token } = await connected();
  const first = await send(t, { idempotencyKey: STATUS_KEY }, wallet(owner(t.account)));
  await settle();
  return { t, token, id: first.structuredContent!.id };
}

describe('jaw_get_calls_status', () => {
  it('given a sent row whose receipt succeeded, then landed with the tx hash and the row is concluded', async () => {
    const { t, id } = await sentRow();
    const receipt = vi.fn<ReadReceipt>(async () => ({ success: true, txHash: TX }));

    const result = await check(t, id, receipt);

    expect(receipt).toHaveBeenCalledWith(t.chainId, CALLS_ID);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ state: 'landed', txHash: TX, callsId: CALLS_ID });
    expect(result.structuredContent!.summary).toBe(
      `Done. It went through on Base Sepolia. Receipt: https://sepolia.basescan.org/tx/${TX}`
    );
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'landed', txHash: TX });
  });

  it('given a sent row whose receipt failed, then reverted, isError and the tx hash', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id, async () => ({ success: false, txHash: TX }));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ state: 'reverted', txHash: TX });
    expect(spoken(result)).toBe(
      `It failed on Base Sepolia: nothing moved, and the owner paid the network fee. Receipt: https://sepolia.basescan.org/tx/${TX}`
    );
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Say what likely went wrong if you know. Simulate with jaw_simulate_calls before asking again.`,
    ]);
  });

  it('given a landed row, then the chain is not read again', async () => {
    const { t, id } = await sentRow();
    await check(t, id, async () => ({ success: true, txHash: TX }));
    const receipt = vi.fn<ReadReceipt>(async () => ({ success: false, txHash: TX }));

    const result = await check(t, id, receipt);

    expect(receipt).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ state: 'landed' });
  });

  it('given a sent row with no receipt yet, then the summary carries no unreadable-chain note', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id);

    expect(result.structuredContent!.summary).not.toContain('could not be read');
  });

  it('given the tools list, then jaw_get_calls_status is an open-world read', async () => {
    const { token } = await connected();

    const { json } = await mcp(token, { method: 'tools/list' });

    const status = json.result.tools.find((x: { name: string }) => x.name === 'jaw_get_calls_status');
    expect(status.annotations).toMatchObject({ openWorldHint: true });
  });

  it('given a sent row with no receipt yet, then it stays sent and says to call again', async () => {
    const { t, id } = await sentRow();

    const result = await check(t, id);

    expect(result.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    expect(spoken(result)).toBe('Approved. The transaction is on its way on Base Sepolia and not confirmed yet.');
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Call jaw_get_calls_status again with id ${id} and waitSeconds 30 until it lands.`,
    ]);
    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it.each([1, 9])(
    'given a sent row %i minutes past approveBy with no receipt, then it is still not mined yet',
    async (minutes) => {
      const { t, id } = await sentRow();
      await rewrite(id, pastApproveBy(minutes));

      const result = await check(t, id);

      expect(spoken(result)).toContain('not confirmed yet');
    }
  );

  it('given a sent row 11 minutes past approveBy with no receipt, then it says to check the account', async () => {
    const { t, id } = await sentRow();
    await rewrite(id, pastApproveBy(11));

    const result = await check(t, id);

    expect(result.structuredContent!.state).toBe('sent');
    expect(spoken(result)).toBe(
      "The owner approved, but the transaction has not shown up on Base Sepolia. Do not send it again until the wallet's activity is checked."
    );
    expect(toAgent(result).join('\n')).toContain('Not seen on chain by');
    expect(toAgent(result).join('\n')).toContain('check the account before sending these calls again');
  });

  it('given a send_started row 11 minutes past approveBy, then it says nothing was seen and to check the account', async () => {
    const { t } = await connected();
    const dropped = owner(t.account, {
      wallet_sendCalls: () => {
        throw new Error('socket closed');
      },
    });
    const first = await send(t, {}, wallet(dropped));
    await settle();
    await rewrite(first.structuredContent!.id, pastApproveBy(11));

    const result = await check(t, first.structuredContent!.id);

    expect(result.structuredContent!.summary).toMatch(/^Nothing has shown up on Base Sepolia for this request/);
    expect(toAgent(result).join('\n')).toMatch(
      /Nothing was seen by .*check the account before sending these calls again/
    );
  });

  it('given a send_started row 9 minutes past approveBy, then it still says the wallet may have sent', async () => {
    const { t } = await connected();
    const dropped = owner(t.account, {
      wallet_sendCalls: () => {
        throw new Error('socket closed');
      },
    });
    const first = await send(t, {}, wallet(dropped));
    await settle();
    await rewrite(first.structuredContent!.id, pastApproveBy(9));

    const result = await check(t, first.structuredContent!.id);

    expect(result.structuredContent!.summary).toContain('may have sent');
  });

  it('given a bundler that cannot be read, then the stored row answers with a note, nothing is written and the read is logged', async () => {
    const { t, id } = await sentRow();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await check(t, id, async () => {
        throw new Error('rpc down');
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent!.state).toBe('sent');
      // A note for the agent, never read out to the owner.
      expect(toAgent(result).join('\n')).toContain(
        'The chain could not be read right now; this is the request as last stored.'
      );
      expect(spoken(result)).not.toContain('could not be read');
      expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
      const lines = logged.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('owner calls receipt not read') && line.includes(id))).toBe(true);
      expect(lines.some((line) => line.includes('owner calls status write failed'))).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });

  it('given a receipt that was read but the write fails, then the stored row answers without the unreadable note and the write is logged', async () => {
    const { t, id } = await sentRow();
    const write = vi.spyOn(store, 'conclude').mockRejectedValueOnce(new Error('db blip'));
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await check(t, id, async () => ({ success: true, txHash: TX }));

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent!.state).toBe('sent');
      expect(result.structuredContent!.summary).not.toContain('could not be read');
      expect(spoken(result)).toContain('not confirmed yet');
      const lines = logged.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('owner calls status write failed') && line.includes(id))).toBe(true);
      expect(lines.some((line) => line.includes('owner calls receipt not read'))).toBe(false);
    } finally {
      write.mockRestore();
      logged.mockRestore();
    }
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

  it('given 29 reads this minute, when the 30th comes, then it answers', async () => {
    const { t, id } = await sentRow();
    await hitsThisWindow(`owner-calls-status:${t.connectionId}`, 29, RATE_WINDOW_MS);

    const result = await check(t, id);

    expect(result[gateCode]).toBeUndefined();
    expect(result.structuredContent!.id).toBe(id);
  });

  it('given more than 30 reads this minute, then rate_limited', async () => {
    const { t, id } = await sentRow();
    await hitsThisWindow(`owner-calls-status:${t.connectionId}`, 30, RATE_WINDOW_MS);

    const result = await check(t, id);

    expect(result[gateCode]).toBe('rate_limited');
  });

  it('given a wallet:read token, then the tool is served and answers an unknown id with not_found', async () => {
    const { token } = await connected('wallet:read');

    const result = await callTool(token, 'jaw_get_calls_status', { id: `oc_${'A'.repeat(22)}` });

    expect(result.content[0].text).toMatch(/^not_found: /);
  });

  it.each(['nope', `oc_${'A'.repeat(21)}`, `oc_${'A'.repeat(23)}`, `xx_${'A'.repeat(22)}`])(
    'given the malformed id %s, then the input is refused by the schema, not looked up',
    async (id) => {
      const { token } = await connected('wallet:read');

      const result = await callTool(token, 'jaw_get_calls_status', { id });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Input validation error/);
      expect(result.content[0].text).not.toMatch(/not_found/);
    }
  );
});

describe('owner link lease between two processes', () => {
  // A wallet whose relay session stays up until the test ends it.
  const heldWallet = () => {
    let end = () => {};
    const open: OpenWallet = async (chainId, until) => {
      opened.push({ chainId, until });
      return {
        url: `http://keys.test/cli-bridge?session=held-${randomBytes(4).toString('hex')}`,
        run: () => new Promise<never>((resolve) => (end = () => resolve(undefined as never))),
        close: () => {},
      };
    };
    return { open, end: () => end() };
  };
  const leaseOf = async (id: string) => {
    const [row] = await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id));
    return row.sessionUntil;
  };
  const lapseLease = (id: string) =>
    getDb()
      .update(ownerCalls)
      .set({ sessionUntil: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(ownerCalls.id, id));
  const eventually = async (check: () => Promise<boolean>) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
      if (await check()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('the condition never held');
  };

  it('given process A follows the link, when process B gets the same key, then B opens no wallet and the url is A', async () => {
    const { t } = await connected();
    const first = await send(t, {}, heldWallet().open);

    const second = await send(t, {}, heldWallet().open);

    expect(second.structuredContent!.url).toBe(first.structuredContent!.url);
    expect(opened).toHaveLength(1);
    expect((await rowsOf(t.connectionId))[0].walletUrl).toBe(first.structuredContent!.url);
  });

  it('given the lease of A lapsed, when process B gets the same key, then B reopens the row with its own url', async () => {
    const { t } = await connected();
    const first = await send(t, {}, heldWallet().open);
    await lapseLease(first.structuredContent!.id);

    const second = await send(t, {}, heldWallet().open);

    expect(opened).toHaveLength(2);
    expect(second.structuredContent!.id).toBe(first.structuredContent!.id);
    expect(second.structuredContent!.url).not.toBe(first.structuredContent!.url);
    expect((await leaseOf(first.structuredContent!.id))!.getTime()).toBeGreaterThan(Date.now());
  });

  it('given A renews while its session lives, then the lease moves forward and B still cannot reopen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { t } = await connected();
      const first = await send(t, {}, heldWallet().open);
      const id = first.structuredContent!.id;
      await getDb()
        .update(ownerCalls)
        .set({ sessionUntil: sql`statement_timestamp() + interval '1 second'` })
        .where(eq(ownerCalls.id, id));
      const before = (await leaseOf(id))!.getTime();

      await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS);
      await eventually(async () => (await leaseOf(id))!.getTime() > before + 5_000);

      await send(t, {}, heldWallet().open);
      expect(opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('given the session of A ended, then the lease is cleared and B reopens at once', async () => {
    const { t } = await connected();
    const a = heldWallet();
    const first = await send(t, {}, a.open);
    const id = first.structuredContent!.id;

    a.end();
    await eventually(async () => (await leaseOf(id)) === null);
    const second = await send(t, {}, heldWallet().open);

    expect(opened).toHaveLength(2);
    expect(second.structuredContent!.url).not.toBe(first.structuredContent!.url);
  });

  it('given B reopened after a lapse, when A renews or ends, then the url and the lease of B stay', async () => {
    const { t } = await connected();
    const first = await send(t, {}, heldWallet().open);
    const [stale] = await rowsOf(t.connectionId);
    await lapseLease(first.structuredContent!.id);
    await send(t, {}, heldWallet().open);
    const [current] = await rowsOf(t.connectionId);

    expect(await store.renewSession(stale)).toBeUndefined();
    await store.endSession(stale);

    expect((await rowsOf(t.connectionId))[0].sessionUntil).toEqual(current.sessionUntil);
  });
});

describe('a sent call the bundler no longer answers for', () => {
  const stale = async (clients: ChainClients, sentBlock: bigint | null = 9_000n) => {
    const { t } = await connected();
    const first = await send(t, { idempotencyKey: STATUS_KEY }, wallet(owner(t.account)));
    await settle();
    const id = first.structuredContent!.id;
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ sentBlock, updatedAt: sql`statement_timestamp() - interval '30 minutes'` })
        .where(eq(ownerCalls.id, id))
    );
    const status = () => sendCallsStatus(t, { id }, { openWallet: wallet(), receipt: async () => null, clients });
    return { t, id, status };
  };
  const mined = (over: Partial<FakeEvent> = {}): FakeEvent => ({
    userOpHash: CALLS_ID as Hex,
    block: 9_500n,
    txHash: TX as Hex,
    success: true,
    ...over,
  });

  it('given a log with success, then the row lands with the transaction of the log', async () => {
    const { t, id, status } = await stale(fakeChain({ head: 10_000n, events: [mined()] }).clients);

    const result = await status();

    expect(result.structuredContent).toMatchObject({ state: 'landed', txHash: TX });
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ id, state: 'landed', txHash: TX });
  });

  it('given a log with success false, then the row is reverted', async () => {
    const { status } = await stale(fakeChain({ head: 10_000n, events: [mined({ success: false })] }).clients);

    const result = await status();

    expect(result.structuredContent).toMatchObject({ state: 'reverted', txHash: TX });
    expect(result.isError).toBe(true);
  });

  it('given no log, then the row stays sent', async () => {
    const { t, status } = await stale(fakeChain({ head: 10_000n }).clients);

    expect((await status()).structuredContent!.state).toBe('sent');
    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it('given a node that cannot be read, then the stored row answers with the unreadable note and the row is unchanged', async () => {
    const { t, status } = await stale(fakeChain({ head: 10_000n, down: true }).clients);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await status();

      expect(result.structuredContent!.state).toBe('sent');
      expect(result.structuredContent!.summary).toContain('The chain could not be read right now');
      expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
    } finally {
      logged.mockRestore();
    }
  });

  it('given a head past the span searched from the sent block, then no log is read and the stored row answers', async () => {
    const chain = fakeChain({ head: 100_000n, events: [mined()] });
    const { t, id, status } = await stale(chain.clients);
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ approveBy: sql`statement_timestamp() - interval '1 hour'` })
        .where(eq(ownerCalls.id, id))
    );

    const result = await status();

    expect(chain.ranges).toEqual([]);
    expect(result.structuredContent!.state).toBe('sent');
    expect(result.structuredContent!.summary).toContain('Not seen on chain by');
    expect((await rowsOf(t.connectionId))[0].state).toBe('sent');
  });

  it('given a row sent without a recorded head, then the log is still found from the age of the row', async () => {
    const { status } = await stale(fakeChain({ head: 100_000n, events: [mined({ block: 99_500n })] }).clients, null);

    expect((await status()).structuredContent).toMatchObject({ state: 'landed', txHash: TX });
  });
});

describe('the block recorded when a call is sent', () => {
  const sendWith = async (clients: ChainClients) => {
    const { t } = await connected();
    await sendCalls(t, input(), { openWallet: wallet(owner(t.account)), receipt: async () => null, clients });
    await settle();
    return (await rowsOf(t.connectionId))[0];
  };

  it('given a node that answers, then the row is sent with the head at that moment', async () => {
    const row = await sendWith(fakeChain({ head: 48_153_975n }).clients);

    expect(row).toMatchObject({ state: 'sent', callsId: CALLS_ID, sentBlock: 48_153_975n });
  });

  it('given a node that does not answer, then the row is still sent, with no block', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const row = await sendWith(fakeChain({ head: 1n, down: true }).clients);

      expect(row).toMatchObject({ state: 'sent', callsId: CALLS_ID, sentBlock: null });
    } finally {
      logged.mockRestore();
    }
  });
});

describe('what the owner hears from jaw_send_calls and jaw_get_calls_status', () => {
  const linkLine = (url: string) => `Open this link to approve: ${url}`;
  type Read = () => Promise<Awaited<ReturnType<typeof send>>>;

  it('given calls sent for approval, then the link comes first on its own line, then the network and amount in plain words, then the agent line', async () => {
    const { t } = await connected();

    const result = await send(t);

    const out = result.structuredContent!;
    const [first, second, third, agent, ...rest] = out.summary.split('\n');
    expect(first).toBe(linkLine(out.url!));
    expect(second).toBe(
      'It asks the owner to approve 2 actions from their wallet on Base Sepolia, moving 0.000000000000000012 ETH in total, within the next 30 minutes.'
    );
    expect(third).toBe('The owner pays the network fee in the wallet.');
    expect(agent).toBe(
      `${FOR_AGENT} Show the link now, on its own line, with one sentence of what this does and moves. ` +
        `Then call jaw_get_calls_status with id ${out.id} and waitSeconds 30, and again while it answers awaiting_owner, until ${out.approveBy}. ` +
        'Do not wait for the owner to say they approved.'
    );
    expect(rest).toEqual([]);
    expect(result.content[0].text).toBe(out.summary);
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given one call, then it is one action', async () => {
    const { t } = await connected();

    const result = await send(t, { calls: [{ to: TARGET }] });

    expect(spoken(result)).toContain('approve 1 action from their wallet on Base Sepolia, within the next 30 minutes');
    expect(spoken(result)).not.toContain('in total');
  });

  it('given a status read while the owner has not answered, then the owner hears when it expires, and the link goes to the agent for when the owner asks', async () => {
    const { t } = await connected();
    const first = await send(t);

    const result = await check(t, first.structuredContent!.id);

    expect(spoken(result)).toMatch(/^Still waiting for the owner to approve\. It expires in (29|30) minutes\.$/);
    expect(spoken(result)).not.toContain(first.structuredContent!.url!);
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Call jaw_get_calls_status again with id ${first.structuredContent!.id} and waitSeconds 30 until ${first.structuredContent!.approveBy}. If the owner asks for the link, show it: ${first.structuredContent!.url}`,
    ]);
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given the tools list, then each tool has its title and the send tells the agent to show the link first', async () => {
    const { token } = await connected();

    const { json } = await mcp(token, { method: 'tools/list' });

    const tool = (name: string) => json.result.tools.find((x: { name: string }) => x.name === name);
    expect(tool('jaw_send_calls').title).toBe('Send a transaction for the owner to approve');
    expect(tool('jaw_send_calls').description).toContain(
      'show it to the owner on its own line before anything else, with one plain sentence of what it does and moves; they cannot approve without it'
    );
    expect(tool('jaw_get_calls_status').title).toBe('Check an approval request');
    expect(tool('jaw_get_calls_status').description).toContain(
      'While it waits, its result carries the link, so show it again if the owner asks.'
    );
  });

  // Every state a request can be read in, and every refusal: none names a tool or an internal word to the owner.
  const STATES: [string, Read][] = [
    ['a request awaiting the owner', async () => send((await connected()).t)],
    [
      'a status read while waiting',
      async () => {
        const { t } = await connected();
        return check(t, (await send(t)).structuredContent!.id);
      },
    ],
    [
      'a request the owner declined',
      async () => {
        const { t } = await connected();
        await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: rejected })));
        await settle();
        return send(t);
      },
    ],
    [
      'a request the wallet refused before sending',
      async () => {
        const { t } = await connected();
        const refuse = () => {
          throw Object.assign(new Error('the wallet refused'), { code: 4100 });
        };
        await send(t, {}, wallet(owner(t.account, { wallet_sendCalls: refuse })));
        await settle();
        return send(t);
      },
    ],
    [
      'a request signed in with another account',
      async () => {
        const { t } = await connected();
        await send(t, {}, wallet(owner(OTHER)));
        await settle();
        return send(t);
      },
    ],
    [
      'a request that expired',
      async () => {
        const { t } = await connected();
        const first = await send(t);
        await rewrite(first.structuredContent!.id, { approveBy: sql`statement_timestamp() - interval '1 second'` });
        return send(t);
      },
    ],
    [
      'a request the wallet may have sent',
      async () => {
        const { t } = await connected();
        const dropped = owner(t.account, {
          wallet_sendCalls: () => {
            throw new Error('socket closed');
          },
        });
        await send(t, {}, wallet(dropped));
        await settle();
        return send(t);
      },
    ],
    [
      'a request the wallet may have sent, past its grace',
      async () => {
        const { t } = await connected();
        const dropped = owner(t.account, {
          wallet_sendCalls: () => {
            throw new Error('socket closed');
          },
        });
        const first = await send(t, {}, wallet(dropped));
        await settle();
        await rewrite(first.structuredContent!.id, pastApproveBy(11));
        return check(t, first.structuredContent!.id);
      },
    ],
    ['sent calls not mined yet', async () => (({ t, id }) => check(t, id))(await sentRow())],
    [
      'sent calls not seen past their grace',
      async () => {
        const { t, id } = await sentRow();
        await rewrite(id, pastApproveBy(11));
        return check(t, id);
      },
    ],
    [
      'sent calls on a chain that cannot be read',
      async () => {
        const { t, id } = await sentRow();
        const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          return await check(t, id, async () => {
            throw new Error('rpc down');
          });
        } finally {
          logged.mockRestore();
        }
      },
    ],
    [
      'calls that landed',
      async () => (({ t, id }) => check(t, id, async () => ({ success: true, txHash: TX })))(await sentRow()),
    ],
    [
      'calls that reverted',
      async () => (({ t, id }) => check(t, id, async () => ({ success: false, txHash: TX })))(await sentRow()),
    ],
  ];

  it.each(STATES)('given %s, then the owner hears no tool and no internal word', async (_name, read) => {
    const result = await read();

    expect(spoken(result).trim()).not.toBe('');
    expect(leaks(spoken(result))).toEqual([]);
  });

  const REFUSALS: [string, string, Read][] = [
    ['an unsupported chain', 'unsupported_chain', async () => send((await connected()).t, { chainId: 324 })],
    [
      'a call to the account itself',
      'call_target_refused',
      async () => {
        const { t } = await connected();
        return send(t, { calls: [{ to: t.account as Address }] });
      },
    ],
    [
      'a call to an EntryPoint',
      'call_target_refused',
      async () => send((await connected()).t, { calls: [{ to: entryPoint08Address }] }),
    ],
    [
      'the same key with other calls',
      'idempotency_conflict',
      async () => {
        const { t } = await connected();
        await send(t);
        return send(t, { calls: [CALL] });
      },
    ],
    [
      'another request waiting',
      'calls_in_progress',
      async () => {
        const { t } = await connected();
        await send(t);
        return send(t, { idempotencyKey: 'second' });
      },
    ],
    [
      'every link slot of the account taken',
      'account_busy',
      async () => {
        const signer = newSigner();
        const ts = [];
        for (let i = 0; i < 4; i++) ts.push((await connected('wallet:read', signer)).t);
        for (const t of ts.slice(0, 3)) await send(t);
        return send(ts[3]);
      },
    ],
    ['a full owner pool', 'wallet_busy', async () => send((await connected()).t, {}, busy)],
    [
      'an ended connection',
      'connection_ended',
      async () => {
        const { t } = await connected();
        await endConnection(t.connectionId, t.account);
        return send(t);
      },
    ],
    [
      'payments paused',
      'payments_paused',
      async () => {
        const { t } = await connected();
        await getDb().insert(settings).values({ key: 'payments_paused', value: true });
        return send(t);
      },
    ],
    [
      'too many links this minute',
      'rate_limited',
      async () => {
        const { t } = await connected();
        await hitsThisWindow(`owner-calls:${t.connectionId}`, 10, RATE_WINDOW_MS);
        return send(t);
      },
    ],
    [
      'too many status reads this minute',
      'rate_limited',
      async () => {
        const { t, id } = await sentRow();
        await hitsThisWindow(`owner-calls-status:${t.connectionId}`, 30, RATE_WINDOW_MS);
        return check(t, id);
      },
    ],
    ['an unknown id', 'not_found', async () => check((await connected()).t, `oc_${'A'.repeat(22)}`)],
  ];

  it.each(REFUSALS)(
    'given %s, then the code comes first, the owner hears no tool and no internal word, and the agent gets its own line',
    async (_name, code, read) => {
      const result = await read();

      expect(result[gateCode]).toBe(code);
      expect(result.content[0].text.startsWith(`${code}: `)).toBe(true);
      expect(spoken(result).trim()).not.toBe('');
      expect(leaks(spoken(result))).toEqual([]);
      for (const line of toAgent(result)) expect(line.startsWith(FOR_AGENT)).toBe(true);
    }
  );
});
