import { eq } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { Ask, OpenWallet } from '@/connections/relay';
import { callTool, connect, fakeWallet, mcp, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { ownerCalls, sends, settings } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { fakeChain } from '@/owner-calls/chain-testkit';
import { APPROVE_WINDOW_MS } from './owner-calls';
import { transfer, type TransferInput } from './send';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BOB: Address = '0x2222222222222222222222222222222222222222';
const CALLS_ID = `0x${'cd'.repeat(32)}`;

// The session key never signs a transfer: any use of it fails the test.
const session = vi.hoisted(() => ({ used: 0 }));
vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => {
    session.used++;
    return undefined;
  },
}));
const served = vi.hoisted(() => ({ opened: 0 }));
vi.mock('@/connections/relay', async (original) => ({
  ...(await original<object>()),
  ownerRelay: async () => {
    served.opened++;
    return { url: 'http://keys.test/cli-bridge?session=served', run: () => new Promise(() => {}), close: () => {} };
  },
}));
const names = vi.hoisted(() => new Map<string, string | null>());
vi.mock('./read', async (original) => ({
  ...(await original<object>()),
  resolveName: async (name: string) => {
    if (!names.has(name)) throw new Error('lookup failed');
    const address = names.get(name) ?? null;
    return { name, address, chainId: 'eip155:1', summary: '' };
  },
}));

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  session.used = 0;
  served.opened = 0;
  names.clear();
  asked = [];
});
afterEach(async () => {
  await walletsSettled();
  await getDb().delete(settings);
  expect(session.used).toBe(0);
});

let asked: { method: string; params: unknown[] }[] = [];
const quietChain = fakeChain({ head: 1_000_000n }).clients;

async function connected(scope = 'wallet:read') {
  const c = await connect(undefined, { scope });
  await walletsSettled();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { t, token: c.access_token as string };
}

const approves =
  (account: string): Ask =>
  async (method) => {
    if (method === 'eth_requestAccounts') return [account];
    if (method === 'wallet_sendCalls') return { id: CALLS_ID };
    throw new Error(`the test wallet does not answer ${method}`);
  };
const idle: OpenWallet = async () => ({
  url: 'http://keys.test/cli-bridge?session=idle',
  run: () => new Promise(() => {}),
  close: () => {},
});
const send = (t: Tenant, input: Partial<TransferInput> = {}, openWallet: OpenWallet = idle) =>
  transfer(t, { to: BOB, amount: '0.1', ...input }, { openWallet, receipt: async () => null, clients: quietChain });
const rowsOf = (connectionId: string) =>
  getDb().select().from(ownerCalls).where(eq(ownerCalls.connectionId, connectionId));

describe('jaw_transfer', () => {
  it('given a recipient address, then it asks the owner for one USDC transfer from the account and nothing comes out of the budget', async () => {
    const { t } = await connected();

    const result = await send(t);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      state: 'awaiting_owner',
      url: expect.stringMatching(/^http:\/\/keys\.test\/cli-bridge/),
      from: t.account,
      calls: [{ to: USDC, value: '0', selector: '0xa9059cbb' }],
      recipient: { address: BOB, name: null },
    });
    const [row] = await rowsOf(t.connectionId);
    expect(row.account).toBe(t.account);
    expect(decodeFunctionData({ abi: erc20Abi, data: row.calls[0].data as Hex }).args).toEqual([BOB, 100_000n]);
    expect(await getDb().select().from(sends).where(eq(sends.connectionId, t.connectionId))).toEqual([]);
  });

  it('given an ENS name, then the answer carries the address it resolved to', async () => {
    const { t } = await connected();
    names.set('helloo.justan.id', BOB);

    const result = await send(t, { to: 'helloo.justan.id' });

    expect(result.structuredContent).toMatchObject({ recipient: { address: BOB, name: 'helloo.justan.id' } });
    expect(result.content[0].text).toContain(
      `approve sending 0.1 USDC to ${BOB} (helloo.justan.id) from ${t.account}.`
    );
    expect(result.content[0].text).not.toContain('wei');
    const [row] = await rowsOf(t.connectionId);
    expect(decodeFunctionData({ abi: erc20Abi, data: row.calls[0].data as Hex }).args[0]).toBe(BOB);
  });

  it('given the owner approves, then the owner wallet sends the transfer', async () => {
    const { t } = await connected();

    await send(t, {}, fakeWallet(approves(t.account), asked));
    await walletsSettled();

    const sent = asked.find((a) => a.method === 'wallet_sendCalls');
    const [{ calls }] = sent?.params as [{ calls: { to: Address; data: Hex }[] }];
    expect(calls).toHaveLength(1);
    expect(calls[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([BOB, 100_000n]);
  });

  it('given the same idempotency key again, then it answers the same request and opens no second link', async () => {
    const { t } = await connected();

    const first = await send(t, { idempotencyKey: 'pay-bob' });
    const again = await send(t, { idempotencyKey: 'pay-bob' });

    expect(again.structuredContent).toMatchObject({ id: first.structuredContent!.id, recipient: { address: BOB } });
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given the same idempotency key for another recipient, then it is refused and opens no second link', async () => {
    const { t } = await connected();

    await send(t, { idempotencyKey: 'pay-bob' });
    const other = await send(t, { idempotencyKey: 'pay-bob', to: '0x3333333333333333333333333333333333333333' });

    expect(other.isError).toBe(true);
    expect(other.content[0].text).toMatch(/^idempotency_conflict: /);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given the same key for a name the resolver cannot read now, then it answers the stored request', async () => {
    const { t } = await connected();
    names.set('helloo.justan.id', BOB);
    const first = await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello' });
    names.clear();

    const again = await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello' });

    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ id: first.structuredContent!.id, recipient: { address: BOB } });
  });

  it('given the same key for a name that now resolves elsewhere, then it answers the stored request and its recipient', async () => {
    const { t } = await connected();
    names.set('helloo.justan.id', BOB);
    const first = await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello' });
    names.set('helloo.justan.id', '0x3333333333333333333333333333333333333333');

    const again = await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello' });

    expect(again.structuredContent).toMatchObject({ id: first.structuredContent!.id, recipient: { address: BOB } });
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given the same key for another amount, then it is refused and opens no second link', async () => {
    const { t } = await connected();
    names.set('helloo.justan.id', BOB);

    await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello' });
    const other = await send(t, { to: 'helloo.justan.id', idempotencyKey: 'pay-hello', amount: '0.2' });

    expect(other.content[0].text).toMatch(/^idempotency_conflict: /);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given a transfer that reverted, when it is retried, then it answers an error naming the recipient', async () => {
    const { t } = await connected();
    await send(t, { idempotencyKey: 'pay-bob' });
    const mine = eq(ownerCalls.connectionId, t.connectionId);
    await getDb().update(ownerCalls).set({ state: 'sent', callsId: CALLS_ID }).where(mine);
    await getDb()
      .update(ownerCalls)
      .set({ state: 'reverted', txHash: `0x${'ef'.repeat(32)}` })
      .where(mine);

    const again = await send(t, { idempotencyKey: 'pay-bob' });

    expect(again.isError).toBe(true);
    expect(again.structuredContent).toMatchObject({ state: 'reverted', recipient: { address: BOB } });
    expect(again.content[0].text).toContain(`Transfer of 0.1 USDC to ${BOB}. Reverted on chain`);
  });

  it('given a mixed case address, then it is checksummed, and refused when the checksum is wrong', async () => {
    const { t } = await connected();
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01';

    const typo = await send(t, { to: lower.replace('0xab', '0xAB') });
    const result = await send(t, { to: lower });

    expect(typo).toMatchObject({ isError: true });
    expect(typo.content[0].text).toContain('checksum');
    expect(result.structuredContent).toMatchObject({ recipient: { address: getAddress(lower) } });
  });

  it('given a name that does not resolve, then it is refused by name and no link opens', async () => {
    const { t } = await connected();
    names.set('nobody.eth', null);

    const unresolved = await send(t, { to: 'nobody.eth' });
    const failed = await send(t, { to: 'down.eth' });

    expect(unresolved.content[0].text).toBe('nobody.eth does not resolve to an address.');
    expect(failed.content[0].text).toContain('could not be resolved');
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given an amount of zero, then it refuses by name and no link opens', async () => {
    const { t } = await connected();

    const result = await send(t, { amount: '0' });

    expect(result).toMatchObject({ isError: true, content: [{ text: 'A transfer of zero sends nothing.' }] });
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given payments paused on the server, then it refuses before a link opens', async () => {
    const { t } = await connected();
    await getDb().insert(settings).values({ key: 'payments_paused', value: 'true' });

    const result = await send(t);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^payments_paused: /);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given a connection with only wallet:read, when it calls the tool, then the owner gets a link', async () => {
    const { t, token } = await connected('wallet:read');

    const result = await callTool(token, 'jaw_transfer', { to: BOB, amount: '0.1' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ state: 'awaiting_owner', recipient: { address: BOB } });
    expect(result.content[0].text).toBe(result.structuredContent.summary);
    expect(JSON.parse(result.content.at(-1).text)).toEqual(result.structuredContent);
    expect(served.opened).toBe(1);
    expect(await rowsOf(t.connectionId)).toHaveLength(1);
  });

  it('given the tool list, then jaw_transfer and jaw_send_calls say one request awaits the owner at a time, and for how long', async () => {
    const { token } = await connected();

    const { tools } = (await mcp(token, { method: 'tools/list' })).json.result;

    for (const name of ['jaw_transfer', 'jaw_send_calls']) {
      const { description } = tools.find((tool: { name: string }) => tool.name === name);
      expect(description, name).toContain('calls_in_progress');
      expect(description, name).toContain(`${APPROVE_WINDOW_MS / 60_000} minutes`);
    }
  });
});
