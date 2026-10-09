import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as bundler from '@/approvals/bundler';
import { countPending } from '@/approvals/store';
import { getDb } from '@/db/client';
import { connections, payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { verifyBearer, type Tenant } from './auth';
import type { Scope } from './provider';
import { callTool, connect, mcp, setTestEnv, token } from './testkit';

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';
process.env.JAW_MCP_MAINNET_RPC_URL = 'http://127.0.0.1:9';
beforeAll(useTestDb);
afterEach(() => vi.restoreAllMocks());

const RECIPIENT = '0x2222222222222222222222222222222222222222';
const UNKNOWN = 'No such request for this connection.';
const GAS = { estimate: '20000', context: { token: RECIPIENT, gas: '40000' } } as const;

// jaw_request_status is left out: it checks the scope of the request's kind.
const TOOLS: Record<string, { needs: Scope; args: object }> = {
  jaw_status: { needs: 'wallet:read', args: {} },
  jaw_quote: { needs: 'wallet:read', args: { url: 'http://127.0.0.1:9/paid' } },
  jaw_add_funds: { needs: 'wallet:read', args: {} },
  jaw_resolve_name: { needs: 'wallet:read', args: { name: 'alice.eth' } },
  jaw_history: { needs: 'wallet:read', args: {} },
  jaw_disconnect: { needs: 'wallet:read', args: {} },
  jaw_request_budget: { needs: 'x402:pay', args: { perDay: '1' } },
  jaw_pay_and_fetch: { needs: 'x402:pay', args: { url: 'http://127.0.0.1:9/paid' } },
  jaw_prepare_transfer: { needs: 'wallet:send', args: { to: RECIPIENT, amount: '0.01' } },
  jaw_prepare_calls: { needs: 'wallet:send', args: { calls: [{ to: RECIPIENT, data: '0x' }] } },
  jaw_request_signature: { needs: 'wallet:send', args: { message: 'hello' } },
};

const PROFILES = ['wallet:read', 'wallet:read x402:pay', 'wallet:read wallet:send', 'wallet:read x402:pay wallet:send'];

const refusedFor = (result: { content: { text: string }[] }) =>
  result.content[0].text.match(/not granted (\S+)\./)?.[1];
const tenantOf = async (accessToken: string) => (await verifyBearer(accessToken))?.extra?.tenant as Tenant;
const refresh = (refreshToken: string, scope: string) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'jaw-cli', scope });

describe('the scope matrix', () => {
  it('given the tools the server lists, then each one is in the matrix', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });
    const listed = (await mcp(c.access_token, { method: 'tools/list' })).json.result.tools.map(
      (t: { name: string }) => t.name
    );
    expect(listed.sort()).toEqual([...Object.keys(TOOLS), 'jaw_request_status'].sort());
  });

  describe.each(PROFILES)('given a token with %s', (scope) => {
    it.each(Object.entries(TOOLS))(
      'when it calls %s, then only a missing scope refuses it, before any gas quote, request or payment',
      async (name, { needs, args }) => {
        const quoted = vi.spyOn(bundler, 'quoteGas').mockRejectedValue(new Error('no bundler'));
        const c = await connect(undefined, { scope });
        const t = await tenantOf(c.access_token);
        const result = await callTool(c.access_token, name, args);
        const granted = scope.split(' ').includes(needs);
        expect(refusedFor(result)).toBe(granted ? undefined : needs);
        if (granted) return;
        expect(result.isError).toBe(true);
        expect(quoted).not.toHaveBeenCalled();
        expect(await countPending(t.connectionId)).toBe(0);
        expect(await getDb().select().from(payments).where(eq(payments.connectionId, t.connectionId))).toEqual([]);
      }
    );
  });
});

describe('jaw_request_status, by the kind of the request', () => {
  it('given a token with wallet:read x402:pay and its own budget request, when it reads the status, then it gets it', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const id = (await callTool(c.access_token, 'jaw_request_budget', { perDay: '1' })).structuredContent.requestId;
    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ requestId: id, status: 'pending' });
  });

  it('given a transfer made under wallet:send and a refresh narrowed to wallet:read x402:pay, when it reads the status, then it answers like an unknown id', async () => {
    vi.spyOn(bundler, 'quoteGas').mockResolvedValue(GAS);
    const c = await connect(undefined, { scope: 'wallet:read x402:pay wallet:send' });
    const asked = await callTool(c.access_token, 'jaw_prepare_transfer', { to: RECIPIENT, amount: '0.01' });
    expect(asked.structuredContent).toMatchObject({ status: 'pending' });
    const narrowed = await refresh(c.refresh_token, 'wallet:read x402:pay');
    const status = await callTool(narrowed.body.access_token, 'jaw_request_status', {
      requestId: asked.structuredContent.requestId,
    });
    expect(status).toEqual({ content: [{ type: 'text', text: UNKNOWN }], isError: true });
  });

  it('given a token with wallet:read only, when it reads a budget request or an unknown id, then both answers are the unknown one', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay wallet:send' });
    const id = (await callTool(c.access_token, 'jaw_request_budget', { perDay: '1' })).structuredContent.requestId;
    const reader = await refresh(c.refresh_token, 'wallet:read');
    for (const requestId of [id, 'no-such-request']) {
      const status = await callTool(reader.body.access_token, 'jaw_request_status', { requestId });
      expect(status).toEqual({ content: [{ type: 'text', text: UNKNOWN }], isError: true });
    }
  });
});

describe('a refresh decides the scopes of the new token', () => {
  it('given all three scopes, when a refresh narrows to wallet:read wallet:send, then paying is refused', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay wallet:send' });
    const narrowed = await refresh(c.refresh_token, 'wallet:read wallet:send');
    const result = await callTool(narrowed.body.access_token, 'jaw_pay_and_fetch', { url: 'http://127.0.0.1:9/paid' });
    expect(result.content[0].text).toMatch(/^insufficient_scope: /);
    expect(refusedFor(result)).toBe('x402:pay');
  });

  it('given a refresh asking for x402:pay alone, when the new token calls a tool, then it gets 401', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const narrowed = await refresh(c.refresh_token, 'x402:pay');
    const res = await mcp(narrowed.body.access_token, {
      method: 'tools/call',
      params: { name: 'jaw_status', arguments: {} },
    });
    expect(res.status).toBe(401);
  });

  it('given a connection granted wallet:read x402:pay, when a refresh asks for all three, then it is refused and the refresh token still works', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const widened = await refresh(c.refresh_token, 'wallet:read x402:pay wallet:send');
    expect(widened).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
    const kept = await refresh(c.refresh_token, 'wallet:read x402:pay');
    expect(kept.body.scope).toBe('wallet:read x402:pay');
    const result = await callTool(kept.body.access_token, 'jaw_prepare_transfer', { to: RECIPIENT, amount: '0.01' });
    expect(refusedFor(result)).toBe('wallet:send');
  });
});

describe('the scopes a consent grants', () => {
  it.each(PROFILES)(
    'given a consent for %s, then the token and the connection row hold exactly those',
    async (scope) => {
      const c = await connect(undefined, { scope });
      expect(c.scope).toBe(scope);
      const t = await tenantOf(c.access_token);
      const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
      expect(row.scopes).toEqual(scope.split(' '));
    }
  );
});
