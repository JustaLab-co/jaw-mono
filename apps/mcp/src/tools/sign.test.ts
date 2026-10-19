import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { verifyMessage, verifyTypedData, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { callTool, connect, fakeWallet, owner as newSigner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { auditEvents, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { gateCode } from '@/payments/render';
import { sendCalls } from './owner-calls';
import { sign, type SignInput } from './sign';

setTestEnv();

type Signer = ReturnType<typeof newSigner>;

const TYPED = {
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: 84532,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  types: {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'Permit',
  message: {
    owner: '0x1111111111111111111111111111111111111111',
    spender: '0x2222222222222222222222222222222222222222',
    value: 1_000_000n,
    nonce: 0n,
    deadline: 1_900_000_000n,
  },
} as const;
const WIRE = JSON.parse(JSON.stringify(TYPED, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

let opened: Date[] = [];
let asked: { method: string; params: unknown[] }[] = [];

const idle = (): Wallet => ({
  url: `http://keys.test/cli-bridge?session=idle-${randomBytes(4).toString('hex')}`,
  run: () => new Promise(() => {}),
  close: () => {},
});
const idleWallet: OpenWallet = async (_chainId, until) => {
  opened.push(until);
  return idle();
};
const busy: OpenWallet = async () => {
  throw new WalletBusy();
};

type Wanted = { request: { type: string; data: { message: string } & typeof TYPED } };

const approves =
  (signer: Signer, over: Record<string, () => unknown> = {}): OpenWallet =>
  async (chainId, until) => {
    opened.push(until);
    const answer: Ask = async (method, params) => {
      if (over[method]) return over[method]();
      if (method === 'eth_requestAccounts') return [signer.address];
      const { request } = (params as [Wanted])[0];
      if (request.type === '0x45') return signer.signMessage({ message: request.data.message });
      return signer.signTypedData(TYPED);
    };
    return fakeWallet(answer, asked)(chainId, until);
  };
const rejected = () => {
  throw Object.assign(new Error('User rejected the request'), { code: 4001 });
};

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  opened = [];
  asked = [];
});
afterEach(walletsSettled);

async function connected(signer = newSigner()) {
  const c = await connect(signer, { scope: 'wallet:read' });
  await walletsSettled();
  return { t: (await verifyBearer(c.access_token))?.extra?.tenant as Tenant, signer, token: c.access_token as string };
}

const ask = (t: Tenant, input: Record<string, unknown>, openWallet: OpenWallet) =>
  sign(t, { message: 'hello', idempotencyKey: 'k1', ...input } as SignInput, { openWallet });
const typed = { message: undefined, typedData: WIRE };

describe('jaw_sign', () => {
  it('given a message, when the owner approves, then the key returns a signature the account verifies', async () => {
    const { t, signer } = await connected();
    const wallet = approves(signer);
    const message = 'sign in to example.com';

    const first = await ask(t, { message }, wallet);
    expect(first.structuredContent).toMatchObject({ state: 'awaiting_owner', kind: 'message', from: t.account });
    expect(first.structuredContent!.url).toMatch(/^http:\/\/keys\.test\/cli-bridge/);
    expect(Date.parse(first.structuredContent!.approveBy) - Date.now()).toBeGreaterThan(29 * 60_000);
    await walletsSettled();

    const again = await ask(t, { message }, wallet);
    expect(again.structuredContent!.state).toBe('signed');
    const signature = again.structuredContent!.signature as Hex;
    expect(await verifyMessage({ address: signer.address, message, signature })).toBe(true);
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'wallet_sign']);
    expect(asked[1].params[0]).toEqual({
      address: t.account,
      chainId: expect.stringMatching(/^0x/),
      request: { type: '0x45', data: { message } },
    });
    expect(opened).toHaveLength(1);
  });

  it('given typed data, when the owner approves, then the signature verifies and the wallet got the data unchanged', async () => {
    const { t, signer } = await connected();
    const wallet = approves(signer);

    await ask(t, typed, wallet);
    await walletsSettled();
    const done = await ask(t, typed, wallet);

    expect(done.structuredContent).toMatchObject({ state: 'signed', kind: 'typedData' });
    const signature = done.structuredContent!.signature as Hex;
    expect(await verifyTypedData({ address: signer.address, ...TYPED, signature })).toBe(true);
    expect(asked[1].params[0]).toMatchObject({ request: { type: '0x01', data: WIRE } });
  });

  it('given non-ASCII text, then the wallet gets the same text and the signature verifies', async () => {
    const { t, signer } = await connected();
    const message = 'Firmo: ñandú, 日本語, 🙂';
    const wallet = approves(signer);

    await ask(t, { message }, wallet);
    await walletsSettled();
    const done = await ask(t, { message }, wallet);

    expect(asked[1].params[0]).toMatchObject({ request: { data: { message } } });
    const signature = done.structuredContent!.signature as Hex;
    expect(await verifyMessage({ address: signer.address, message, signature })).toBe(true);
  });

  it('given an owner who declines, then the key answers owner_declined with no signature', async () => {
    const { t, signer } = await connected();
    const wallet = approves(signer, { wallet_sign: rejected });

    await ask(t, {}, wallet);
    await walletsSettled();
    const again = await ask(t, {}, wallet);

    expect(again.structuredContent).toMatchObject({ state: 'owner_declined', refusal: { code: 'owner_declined' } });
    expect(again.structuredContent!.signature).toBeUndefined();
    expect(again.structuredContent!.url).toBeUndefined();
  });

  it('given an owner signed in as another account, then nothing is signed', async () => {
    const { t } = await connected();
    const wallet = approves(newSigner());

    await ask(t, {}, wallet);
    await walletsSettled();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    expect((await ask(t, {}, wallet)).structuredContent).toMatchObject({
      state: 'owner_declined',
      refusal: { code: 'wrong_account' },
    });
  });

  it('given a wallet that answers with no signature, then the request fails and none is returned', async () => {
    const { t, signer } = await connected();
    const wallet = approves(signer, { wallet_sign: () => ({ nope: true }) });

    await ask(t, {}, wallet);
    await walletsSettled();

    expect((await ask(t, {}, wallet)).structuredContent).toMatchObject({
      state: 'failed',
      refusal: { code: 'wallet_answer_unreadable' },
    });
  });

  describe('before a link opens', () => {
    const refused = async (input: Record<string, unknown>, code: string) => {
      const { t } = await connected();
      const result = await ask(t, input, idleWallet);
      expect(result[gateCode]).toBe(code);
      expect(result.isError).toBe(true);
      expect(opened).toEqual([]);
    };

    it('given typed data with no types, then it is refused', () =>
      refused({ message: undefined, typedData: { primaryType: 'Permit', message: {} } }, 'invalid_typed_data'));

    it('given a primaryType that types does not define, then it is refused', () =>
      refused({ message: undefined, typedData: { ...WIRE, primaryType: 'Order' } }, 'invalid_typed_data'));

    it('given a value that does not fit its type, then it is refused', () =>
      refused(
        { message: undefined, typedData: { ...WIRE, message: { ...WIRE.message, spender: 'not an address' } } },
        'invalid_typed_data'
      ));

    it('given a message with an invisible character, then it is refused', () =>
      refused({ message: 'pay‮alice' }, 'invalid_message'));

    it('given an unsupported chain, then it is refused', () => refused({ chainId: 999_999_999 }, 'unsupported_chain'));

    it('given both a message and typed data, then the server rejects the input', async () => {
      const { token } = await connected();
      const result = await callTool(token, 'jaw_sign', { message: 'x', typedData: WIRE });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exactly one/);
    });
  });

  it('given a link nobody opened past its window, then the key answers expired', async () => {
    const { t } = await connected();
    const first = await ask(t, { idempotencyKey: 'late' }, idleWallet);
    expect(first.structuredContent!.state).toBe('awaiting_owner');
    await getDb()
      .update(permissionRequests)
      .set({ approveBy: sql`now() - interval '1 second'` })
      .where(eq(permissionRequests.walletUrl, first.structuredContent!.url!));

    const later = await ask(t, { idempotencyKey: 'late' }, idleWallet);

    expect(later.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'expired' } });
    expect(later.structuredContent!.url).toBeUndefined();
  });

  it('given the relay session ends with the window, then the key answers expired', async () => {
    const { t } = await connected();
    const endsWithWindow: OpenWallet = async (_chainId, until) => ({
      url: `http://keys.test/cli-bridge?session=ends-${randomBytes(4).toString('hex')}`,
      run: async () => {
        vi.setSystemTime(until.getTime() + 1_000);
        throw new Error('relay session closed');
      },
      close: () => {},
    });

    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      const first = await ask(t, { idempotencyKey: 'ends' }, endsWithWindow);
      await vi.waitFor(async () => {
        const [row] = await getDb()
          .select()
          .from(permissionRequests)
          .where(eq(permissionRequests.walletUrl, first.structuredContent!.url!));
        expect(row.state).not.toBe('awaiting_owner');
      });
    } finally {
      vi.useRealTimers();
    }
    const later = await ask(t, { idempotencyKey: 'ends' }, idleWallet);

    expect(later.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'expired' } });
  });

  it('given a server restart while the link waits, then the same key answers the same link', async () => {
    const { t } = await connected();
    const first = await ask(t, {}, idleWallet);

    vi.resetModules();
    const restarted = await import('./sign');
    const again = await restarted.sign(t, { message: 'hello', idempotencyKey: 'k1' }, { openWallet: idleWallet });

    expect(again.structuredContent!.url).toBe(first.structuredContent!.url);
    expect(opened).toHaveLength(1);
  });

  it('given a server restart after the owner signed, then the same key still returns the signature', async () => {
    const { t, signer } = await connected();
    await ask(t, {}, approves(signer));
    await walletsSettled();

    vi.resetModules();
    const restarted = await import('./sign');
    const again = await restarted.sign(t, { message: 'hello', idempotencyKey: 'k1' }, { openWallet: idleWallet });

    expect(again.structuredContent!.state).toBe('signed');
    const signature = again.structuredContent!.signature as Hex;
    expect(await verifyMessage({ address: signer.address, message: 'hello', signature })).toBe(true);
  });

  describe('a link whose session stopped renewing its lease', () => {
    const lapse = (url: string) =>
      getDb()
        .update(permissionRequests)
        .set({ sessionUntil: sql`now() - interval '1 second'` })
        .where(eq(permissionRequests.walletUrl, url));

    it('given the same key again, then it answers expired with session_lost and opens no second link', async () => {
      const { t } = await connected();
      const first = await ask(t, {}, idleWallet);
      await lapse(first.structuredContent!.url!);

      const again = await ask(t, {}, idleWallet);

      expect(again.structuredContent).toMatchObject({ state: 'expired', refusal: { code: 'session_lost' } });
      expect(again.structuredContent!.summary).toMatch(/lost the wallet session/);
      expect(opened).toHaveLength(1);
    });

    it('given the owner answers after all, then the same key returns the signature', async () => {
      const { t, signer } = await connected();
      let release!: () => void;
      const answered = new Promise<void>((resolve) => (release = resolve));
      const late = approves(signer, {
        wallet_sign: async () => {
          await answered;
          return signer.signMessage({ message: 'hello' });
        },
      });
      const first = await ask(t, {}, late);
      await vi.waitFor(() => expect(asked.map((a) => a.method)).toContain('wallet_sign'));
      await lapse(first.structuredContent!.url!);
      expect((await ask(t, {}, idleWallet)).structuredContent).toMatchObject({
        state: 'awaiting_owner',
        url: first.structuredContent!.url,
      });

      release();
      await walletsSettled();
      const done = await ask(t, {}, idleWallet);

      expect(done.structuredContent!.state).toBe('signed');
      const signature = done.structuredContent!.signature as Hex;
      expect(await verifyMessage({ address: signer.address, message: 'hello', signature })).toBe(true);
    });
  });

  it('given a sign link waiting on this connection, when another key asks, then sign_in_progress and no wallet opens', async () => {
    const { t } = await connected();
    await ask(t, { idempotencyKey: 'first' }, idleWallet);

    const second = await ask(t, { idempotencyKey: 'second', message: 'other' }, idleWallet);

    expect(second[gateCode]).toBe('sign_in_progress');
    expect(second.content[0].text).toMatch(/idempotencyKey first/);
    expect(opened).toHaveLength(1);
  });

  it('given two links waiting on the account, when the same key asks twice at once, then both answer one link', async () => {
    const signer = newSigner();
    const [a, b, c] = [await connected(signer), await connected(signer), await connected(signer)];
    await ask(a.t, { idempotencyKey: 'a' }, idleWallet);
    await ask(b.t, { idempotencyKey: 'b' }, idleWallet);

    const [x, y] = await Promise.all([
      ask(c.t, { idempotencyKey: 'c' }, idleWallet),
      ask(c.t, { idempotencyKey: 'c' }, idleWallet),
    ]);

    expect(x[gateCode]).toBeUndefined();
    expect(y[gateCode]).toBeUndefined();
    expect(y.structuredContent!.url).toBe(x.structuredContent!.url);
  });

  it('given the same key with other input, then it is an idempotency_conflict and no second link opens', async () => {
    const { t } = await connected();
    await ask(t, { message: 'one' }, idleWallet);

    const result = await ask(t, { message: 'two' }, idleWallet);

    expect(result[gateCode]).toBe('idempotency_conflict');
    expect(opened).toHaveLength(1);
  });

  it('given a retry while the link is open, then it answers the same link without a second wallet', async () => {
    const { t } = await connected();
    const a = await ask(t, {}, idleWallet);
    const b = await ask(t, {}, idleWallet);

    expect(b.structuredContent!.url).toBe(a.structuredContent!.url);
    expect(opened).toHaveLength(1);
  });

  it('given a full wallet pool, then wallet_busy', async () => {
    const { t } = await connected();
    expect((await ask(t, {}, busy))[gateCode]).toBe('wallet_busy');
  });

  describe('links open at once per account', () => {
    const sameAccount = async (n: number) => {
      const signer = newSigner();
      return Promise.all(Array.from({ length: n }, () => connected(signer).then((c) => c.t)));
    };

    it('given three links open across connections, when a fourth connection asks, then account_busy and no wallet opens', async () => {
      const [a, b, c, d] = await sameAccount(4);
      for (const [i, t] of [a, b, c].entries()) await ask(t, { idempotencyKey: `k${i}`, message: `m${i}` }, idleWallet);

      const result = await ask(d, { idempotencyKey: 'k9', message: 'm9' }, idleWallet);

      expect(result[gateCode]).toBe('account_busy');
      expect(opened).toHaveLength(3);
    });

    it('given four asks at once, then exactly one is refused', async () => {
      const ts = await sameAccount(4);

      const results = await Promise.all(
        ts.map((t, i) => ask(t, { idempotencyKey: `p${i}`, message: `m${i}` }, idleWallet))
      );

      expect(results.filter((r) => r[gateCode] === 'account_busy')).toHaveLength(1);
    });
  });

  it('given three sign links waiting on the account, then jaw_send_calls is refused as account_busy', async () => {
    const signer = newSigner();
    const [a, b, c] = [await connected(signer), await connected(signer), await connected(signer)];
    for (const [i, { t }] of [a, b, c].entries()) await ask(t, { idempotencyKey: `s${i}` }, idleWallet);

    const send = await sendCalls(
      c.t,
      { calls: [{ to: TYPED.domain.verifyingContract }] },
      { openWallet: idleWallet, receipt: async () => null, clients: {} as never }
    );

    expect(send.content[0].text).toMatch(/^account_busy: /);
    expect(opened).toHaveLength(3);
  });

  it('given a call through the server, then the audit row names the connection', async () => {
    const { t, token } = await connected();

    const result = await callTool(token, 'jaw_sign', { message: 'hi', chainId: 999_999_999 });

    expect(result.isError).toBe(true);
    const rows = await getDb().select().from(auditEvents).where(eq(auditEvents.tool, 'jaw_sign'));
    expect(rows.map((r) => r.connectionId)).toContain(t.connectionId);
  });
});
