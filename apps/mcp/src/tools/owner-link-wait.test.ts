import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { verifyMessage, type Address, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { Ask, OpenWallet, Wallet } from '@/connections/relay';
import {
  callTool,
  connect,
  fakeWallet,
  ISSUER,
  mcp,
  owner as newSigner,
  setTestEnv,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { ownerCalls, permissionRequests } from '@/db/schema';
import { countHit } from '@/db/settings';
import { TEST_PG_URL, useTestDb, useTestPostgres, withoutOwnerCallsGuard } from '@/db/test-db';
import { openLink } from '@/grants/requests';
import { fakeChain } from '@/owner-calls/chain-testkit';
import type { ReadReceipt } from '@/owner-calls/receipt';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { SEND_STARTED } from '@/owner-calls/store';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';
import { sendCalls, sendCallsStatus } from './owner-calls';
import { FOR_AGENT } from './reply';
import { sign, signStatus } from './sign';

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const TX = `0x${'ab'.repeat(32)}`;
const TARGET: Address = '0x2222222222222222222222222222222222222222';
const POLL_MS = 20;
const quietChain = fakeChain({ head: 1_000_000n }).clients;

type Signer = ReturnType<typeof newSigner>;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
let gates: ReturnType<typeof gate>[] = [];
const held = () => {
  const g = gate();
  gates.push(g);
  return g;
};

const idle = (): Wallet => ({
  url: `http://keys.test/cli-bridge?session=idle-${randomBytes(4).toString('hex')}`,
  run: () => new Promise(() => {}),
  close: () => {},
});
const idleWallet: OpenWallet = async () => idle();

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  gates = [];
});
afterEach(async () => {
  for (const g of gates) g.open();
  await walletsSettled();
});

async function connected(signer: Signer = newSigner()) {
  const c = await connect(signer, { scope: 'wallet:read' });
  await walletsSettled();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { t, signer, token: c.access_token as string };
}

async function sendGated(t: Tenant, answer: () => unknown = () => ({ id: CALLS_ID })) {
  const answered = held();
  const ask: Ask = async (method) => {
    if (method === 'eth_requestAccounts') return [t.account];
    await answered.opened;
    return answer();
  };
  const first = await sendCalls(
    t,
    { calls: [{ to: TARGET, value: '1' }], idempotencyKey: `k-${randomBytes(4).toString('hex')}` },
    { openWallet: fakeWallet(ask), receipt: async () => null, clients: quietChain }
  );
  return { id: first.structuredContent!.id, first, answered };
}

const callsStatus = (
  t: Tenant,
  id: string,
  waitSeconds: number,
  receipt: ReadReceipt = async () => null,
  signal?: AbortSignal
) =>
  sendCallsStatus(
    t,
    { id, waitSeconds },
    { openWallet: idleWallet, receipt, clients: quietChain, pollMs: POLL_MS },
    { signal }
  );

const timed = async <T>(run: () => Promise<T>) => {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
};

describe('jaw_get_calls_status with waitSeconds', () => {
  it('given calls awaiting the owner, when the wallet sends them mid-wait, then it answers sent with the calls id before the wait ends', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    setTimeout(answered.open, 150);

    const { value, ms } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    expect(ms).toBeLessThan(5_000);
  });

  it('given sent calls, when the receipt appears mid-wait, then it answers landed with the tx hash', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    answered.open();
    await walletsSettled();
    let mined = false;
    setTimeout(() => (mined = true), 150);

    const { value, ms } = await timed(() =>
      callsStatus(t, id, 10, async () => (mined ? { success: true, txHash: TX } : null))
    );

    expect(value.structuredContent).toMatchObject({ state: 'landed', txHash: TX, callsId: CALLS_ID });
    expect(ms).toBeLessThan(5_000);
  });

  it('given calls the owner never answers, then it answers awaiting_owner once the seconds are up, not before', async () => {
    const { t } = await connected();
    const { id } = await sendGated(t);

    const { value, ms } = await timed(() => callsStatus(t, id, 1));

    expect(value.structuredContent!.state).toBe('awaiting_owner');
    expect(ms).toBeGreaterThanOrEqual(990);
  });

  it('given the wallet refused before sending, then it answers at once with the code the agent must act on', async () => {
    const { t } = await connected();
    const { id } = await sendGated(t);
    await withoutOwnerCallsGuard(() =>
      getDb().update(ownerCalls).set({ code: 'wallet_error:-32603' }).where(eq(ownerCalls.id, id))
    );

    const { value, ms } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent).toMatchObject({
      state: 'awaiting_owner',
      refusal: { code: 'wallet_error:-32603' },
    });
    expect(ms).toBeLessThan(1_000);
  });

  it('given the wallet started sending, then the wait goes on until the calls id arrives', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    await vi.waitFor(async () => {
      const [row] = await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id));
      expect(row.code).toBe(SEND_STARTED);
    });
    setTimeout(answered.open, 150);

    const { value } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
  });

  it('given a link that expired while the wallet was sending, then the wait goes on until the calls id lands', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    await vi.waitFor(async () => {
      const [row] = await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id));
      expect(row.code).toBe(SEND_STARTED);
    });
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ approveBy: sql`statement_timestamp() - interval '1 second'` })
        .where(eq(ownerCalls.id, id))
    );
    setTimeout(answered.open, 300);

    const { value, ms } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    expect(ms).toBeGreaterThanOrEqual(250);
  });

  it('given a status read while the owner has not answered, then the summary asks for another wait, not for the link to be shown again', async () => {
    const { t } = await connected();
    const first = await sendCalls(
      t,
      { calls: [{ to: TARGET, value: '1' }], idempotencyKey: 'unopened' },
      { openWallet: idleWallet, receipt: async () => null, clients: quietChain }
    );
    const id = first.structuredContent!.id;

    const result = await callsStatus(t, id, 0);

    // The link stays on the agent line, for when the owner asks for it again.
    expect(spoken(result)).toMatch(/^Still waiting for the owner to approve\. It expires in (29|30) minutes\.$/);
    expect(spoken(result)).not.toContain(first.structuredContent!.url!);
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Call jaw_get_calls_status again with id ${id} and waitSeconds 30 until ${first.structuredContent!.approveBy}. If the owner asks for the link, show it: ${first.structuredContent!.url}`,
    ]);
    expect(result.structuredContent!.summary).not.toContain('Open this link');
    expect(result.structuredContent!.summary).not.toContain('Show the link now');
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given the client drops the HTTP request, then its wait ends and gives its polling slot back', async () => {
    const { t, token } = await connected();
    const { id, answered } = await sendGated(t);
    const { POST } = await import('@/app/mcp/route');
    const dropped = [0, 1].map(() => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 300);
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'jaw_get_calls_status', arguments: { id, waitSeconds: 30 } },
      };
      return POST(
        new Request(`${ISSUER}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        }),
        { params: Promise.resolve({}) }
      )
        .then((res) => res.text())
        .catch(() => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    setTimeout(answered.open, 100);

    const { value, ms } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent).toMatchObject({ state: 'sent', callsId: CALLS_ID });
    expect(ms).toBeLessThan(3_000);
    await Promise.all(dropped);
  });

  it('given sent calls past their grace with no receipt, then it answers at once so the agent checks the chain', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    answered.open();
    await walletsSettled();
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ approveBy: sql`statement_timestamp() - interval '11 minutes'` })
        .where(eq(ownerCalls.id, id))
    );

    const { value, ms } = await timed(() => callsStatus(t, id, 10));

    expect(value.structuredContent!.summary).toContain('Not seen on chain by');
    expect(ms).toBeLessThan(1_000);
  });

  it('given sent calls the bundler forgot, when the status waits, then the chain logs are searched once, not on every reread', async () => {
    const { t } = await connected();
    const { id, answered } = await sendGated(t);
    answered.open();
    await walletsSettled();
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ sentBlock: 9_000n, updatedAt: sql`statement_timestamp() - interval '30 minutes'` })
        .where(eq(ownerCalls.id, id))
    );
    const chain = fakeChain({ head: 10_000n });
    const status = (waitSeconds: number) =>
      sendCallsStatus(
        t,
        { id, waitSeconds },
        { openWallet: idleWallet, receipt: async () => null, clients: chain.clients, pollMs: POLL_MS }
      );
    await status(0);
    const once = chain.ranges.length;

    await status(0.3);

    expect(once).toBeGreaterThan(0);
    expect(chain.ranges.length).toBe(2 * once);
  });

  it('given the client aborts the call, then the wait ends at once', async () => {
    const { t } = await connected();
    const { id } = await sendGated(t);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    const { ms } = await timed(() => callsStatus(t, id, 10, async () => null, abort.signal));

    expect(ms).toBeLessThan(2_000);
  });

  it('given a link just opened, then its summary tells the agent to wait on the status without the owner saying so', async () => {
    const { t } = await connected();
    const { id, first } = await sendGated(t);

    const summary = first.structuredContent!.summary;
    expect(summary.startsWith(`Open this link to approve: ${first.structuredContent!.url}\n`)).toBe(true);
    const [agent] = toAgent(first);
    expect(agent).toContain(`call jaw_get_calls_status with id ${id} and waitSeconds 30`);
    expect(agent).toContain(`until ${first.structuredContent!.approveBy}`);
    expect(agent).toContain('Do not wait for the owner to say they approved');
  });

  it('given waitSeconds over 45, then the server refuses the input, and takes 0', async () => {
    const { t, token } = await connected();
    const { id } = await sendGated(t);

    const over = await callTool(token, 'jaw_get_calls_status', { id, waitSeconds: 46 });
    const none = await callTool(token, 'jaw_get_calls_status', { id, waitSeconds: 0 });

    expect(over.isError).toBe(true);
    expect(JSON.stringify(over.content)).toContain('waitSeconds');
    expect(none.structuredContent).toMatchObject({ id, state: 'awaiting_owner' });
  });

  it('given a progressToken through the server, when nothing changes, then progress notifications reach the client before the result', async () => {
    const { t, token } = await connected();
    const { id } = await sendGated(t);

    const { text } = await mcp(token, {
      method: 'tools/call',
      params: { name: 'jaw_get_calls_status', arguments: { id, waitSeconds: 3 }, _meta: { progressToken: 'p1' } },
    });

    const messages = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    const progress = messages.filter((m) => m.method === 'notifications/progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].params).toMatchObject({ progressToken: 'p1', total: 3 });
    expect(messages.at(-1).result.structuredContent.state).toBe('awaiting_owner');
  });
});

describe('an unreadable wallet answer to the calls', () => {
  it('given the wallet answers sendCalls with no id, then the server logs a named code and the row keeps send_started', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { t } = await connected();
      const { id, answered } = await sendGated(t, () => ({ unexpected: true }));
      answered.open();
      await walletsSettled();

      const [row] = await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id));
      expect(row).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
      const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: 'owner calls answer unreadable',
          ownerCallId: id,
          code: 'wallet_answer_unreadable',
        })
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe('jaw_get_sign_status', () => {
  async function askGated(t: Tenant, signer: Signer, message = 'hello') {
    const answered = held();
    const ask: Ask = async (method) => {
      if (method === 'eth_requestAccounts') return [signer.address];
      await answered.opened;
      return signer.signMessage({ message });
    };
    const first = await sign(
      t,
      { message, idempotencyKey: `s-${randomBytes(4).toString('hex')}` },
      { openWallet: fakeWallet(ask) }
    );
    return { id: first.structuredContent!.id, first, answered };
  }
  const status = (t: Tenant, id: string, waitSeconds = 0) => signStatus(t, { id, waitSeconds }, { pollMs: POLL_MS });

  it('given a sign request, when the owner signs mid-wait, then it answers signed with a signature the account verifies', async () => {
    const { t, signer } = await connected();
    const { id, answered } = await askGated(t, signer, 'sign in to example.com');
    setTimeout(answered.open, 150);

    const { value, ms } = await timed(() => status(t, id, 10));

    expect(value.structuredContent).toMatchObject({ id, state: 'signed' });
    const signature = value.structuredContent!.signature as Hex;
    expect(await verifyMessage({ address: signer.address, message: 'sign in to example.com', signature })).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });

  it('given two calls waits polling on the connection, when the owner signs mid-wait, then the sign wait still answers at once', async () => {
    const { t, signer } = await connected();
    const calls = await sendGated(t);
    const { id, answered } = await askGated(t, signer);
    const busy = [callsStatus(t, calls.id, 2), callsStatus(t, calls.id, 2)];
    setTimeout(answered.open, 150);

    const { value, ms } = await timed(() => status(t, id, 10));

    expect(value.structuredContent!.state).toBe('signed');
    expect(ms).toBeLessThan(1_500);
    await Promise.all(busy);
  });

  it('given a status read while the owner has not signed, then the summary asks for another wait, not for the link to be shown again', async () => {
    const { t, signer } = await connected();
    const { id, first } = await askGated(t, signer);

    const result = await status(t, id);

    // The link stays on the agent line, for when the owner asks for it again.
    expect(spoken(result)).toMatch(/^Still waiting for the owner to sign\. It expires in (29|30) minutes\.$/);
    expect(spoken(result)).not.toContain(first.structuredContent!.url!);
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Call jaw_get_sign_status again with id ${id} and waitSeconds 30 until ${first.structuredContent!.approveBy}. If the owner asks for the link, show it: ${first.structuredContent!.url}`,
    ]);
    expect(result.structuredContent!.summary).not.toContain('Open this link');
    expect(result.structuredContent!.summary).not.toContain('Show the link now');
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given an id no sign request has, then not_found, in plain words for the owner', async () => {
    const { t } = await connected();

    const result = await status(t, `pr_${'A'.repeat(22)}`);

    expect(result.content[0].text).toMatch(/^not_found: /);
    expect(spoken(result)).toBe('That signing request was not found on this connection.');
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given 30 sign status reads in the last minute on the connection, then the next is rate_limited', async () => {
    const { t, signer } = await connected();
    const { id } = await askGated(t, signer);
    for (let i = 0; i < 30; i++) await countHit(`owner-sign-status:${t.connectionId}`, RATE_WINDOW_MS);

    expect((await status(t, id)).content[0].text).toMatch(/^rate_limited: /);
  });

  it('given no wait, then it answers the request as stored', async () => {
    const { t, signer } = await connected();
    const { id } = await askGated(t, signer);

    expect((await status(t, id)).structuredContent).toMatchObject({ id, state: 'awaiting_owner' });
  });

  it("given another connection's sign id, then not_found", async () => {
    const other = await connected();
    const { t, signer } = await connected();
    const { id } = await askGated(t, signer);

    expect((await status(other.t, id)).content[0].text).toMatch(/^not_found: /);
  });

  it('given the id of a grant link on the same connection, then not_found', async () => {
    const { t } = await connected();
    const opened = await openLink(
      t,
      {
        method: 'grant',
        chainId: t.chainId,
        approveBy: new Date(Date.now() + 60_000),
        payload: {},
        rebuild: () => () => new Promise(() => {}),
      },
      idleWallet
    );
    const id = typeof opened === 'object' && 'opened' in opened ? opened.opened.id : '';

    expect((await status(t, id)).content[0].text).toMatch(/^not_found: /);
  });

  it('given a sign link whose process stopped renewing it, then it answers expired', async () => {
    const { t } = await connected();
    const first = await sign(t, { message: 'hello', idempotencyKey: 'lapsed' }, { openWallet: idleWallet });
    const id = first.structuredContent!.id;
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`statement_timestamp() - interval '5 minutes'` })
      .where(eq(permissionRequests.id, id));

    expect((await status(t, id, 5)).structuredContent).toMatchObject({
      state: 'expired',
      refusal: { code: 'session_lost' },
    });
  });

  it('given a link just opened, then its summary tells the agent to wait on the sign status without the owner saying so', async () => {
    const { t, signer } = await connected();
    const { id, first } = await askGated(t, signer);

    const summary = first.structuredContent!.summary;
    expect(summary.startsWith(`Open this link to sign: ${first.structuredContent!.url}\n`)).toBe(true);
    const [agent] = toAgent(first);
    expect(agent).toContain(`call jaw_get_sign_status with id ${id} and waitSeconds 30`);
    expect(agent).toContain(`until ${first.structuredContent!.approveBy}`);
    expect(agent).toContain('Do not wait for the owner to say they signed');
    expect(agent).toContain(`send jaw_sign again with idempotencyKey ${first.structuredContent!.idempotencyKey}`);
  });

  it('given the tools list, then jaw_get_sign_status is titled and marked read-only', async () => {
    const { token } = await connected();

    const { json } = await mcp(token, { method: 'tools/list' });

    const tool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_get_sign_status');
    expect(tool.title).toBe('Check a signing request');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toContain(
      'While it waits, its result carries the link, so show it again if the owner asks.'
    );
  });

  it('given the tools list, then jaw_get_sign_status takes an id and a bounded wait', async () => {
    const { token } = await connected();

    const { json } = await mcp(token, { method: 'tools/list' });

    const tool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_get_sign_status');
    expect(tool.inputSchema.properties.waitSeconds).toMatchObject({ maximum: 45 });
    expect(tool.inputSchema.required).toEqual(['id']);
  });
});
