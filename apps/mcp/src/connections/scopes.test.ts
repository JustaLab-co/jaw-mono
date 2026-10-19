import { JAW_RPC_URL } from '@jaw.id/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db/client';
import { connections, grants, payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { verifyBearer, type Tenant } from './auth';
import type { ConnectionScope } from './scopes';
import { callTool, connect, mcp, setTestEnv, token, walletsSettled } from './testkit';

// A tool that reaches the owner's wallet gets one the owner never approves in, not the relay.
const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock('./relay', async (original) => ({
  ...(await original<object>()),
  openRelay: async () => {
    opened.count++;
    return { url: 'http://keys.test/cli-bridge', run: () => Promise.reject(new Error('not approved')) };
  },
}));

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  String(input).startsWith(JAW_RPC_URL) ? Response.json({ jsonrpc: '2.0', id: 1, result: [] }) : realFetch(input, init)
);

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';
process.env.JAW_MCP_MAINNET_RPC_URL = 'http://127.0.0.1:9';
beforeAll(useTestDb);
afterEach(async () => {
  await walletsSettled();
  vi.restoreAllMocks();
});

const RECIPIENT = '0x2222222222222222222222222222222222222222';
const UNSUPPORTED_ORIGIN_CHAIN = 324;
const TESTNET = 11155111;

// `needs` is any one of these scopes.
const TOOLS: Record<string, { needs: ConnectionScope[]; args: object }> = {
  jaw_session_status: { needs: ['wallet:read'], args: {} },
  jaw_session_x402_quote: { needs: ['wallet:read'], args: { url: 'http://127.0.0.1:9/paid' } },
  jaw_add_funds: { needs: ['wallet:read'], args: {} },
  // No query, so it refuses before reaching the catalog.
  jaw_session_x402_discover: { needs: ['wallet:read'], args: {} },
  jaw_session_history: { needs: ['wallet:read'], args: {} },
  jaw_connections: { needs: ['wallet:read'], args: {} },
  jaw_revoke_permission: { needs: ['wallet:read'], args: { permissionId: `0x${'0'.repeat(64)}`, chainId: 1 } },
  jaw_session_disconnect: { needs: ['wallet:read'], args: {} },
  jaw_session_execute: {
    needs: ['x402:pay'],
    args: { permissionId: `0x${'0'.repeat(64)}`, calls: [{ to: RECIPIENT }] },
  },
  jaw_grant_permissions: { needs: ['x402:pay'], args: { x402Budget: { perDay: '1' } } },
  jaw_session_x402_pay: { needs: ['x402:pay'], args: { url: 'http://127.0.0.1:9/paid' } },
  jaw_swap: {
    needs: ['x402:pay'],
    args: {
      originChainId: UNSUPPORTED_ORIGIN_CHAIN,
      originToken: RECIPIENT,
      destinationChainId: 8453,
      destinationToken: RECIPIENT,
      amount: '1000000',
    },
  },
  jaw_swap_status: { needs: ['wallet:read'], args: { quoteId: `aurora:${RECIPIENT}` } },
  // An unsupported chain is refused in the tool body, after the scope check and before a wallet opens.
  jaw_send_calls: {
    needs: ['wallet:read'],
    args: { chainId: UNSUPPORTED_ORIGIN_CHAIN, calls: [{ to: RECIPIENT, data: '0xa9059cbb' }] },
  },
  jaw_get_calls_status: { needs: ['wallet:read'], args: { id: `oc_${'A'.repeat(22)}` } },
  jaw_get_assets: { needs: ['wallet:read'], args: { chainIds: [TESTNET] } },
  jaw_get_capabilities: { needs: ['wallet:read'], args: { chainIds: [TESTNET] } },
  jaw_get_calls_history: { needs: ['wallet:read'], args: {} },
  jaw_get_permissions: { needs: ['wallet:read'], args: {} },
};

const PROFILES = ['wallet:read', 'wallet:read x402:pay'];

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
    expect(listed.sort()).toEqual(Object.keys(TOOLS).sort());
  });

  describe.each(PROFILES)('given a token with %s', (scope) => {
    it.each(Object.entries(TOOLS))(
      'when it calls %s, then only a missing scope refuses it, before the wallet opens or anything is paid',
      async (name, { needs, args }) => {
        const c = await connect(undefined, { scope });
        await walletsSettled();
        const t = await tenantOf(c.access_token);
        const before = opened.count;
        const result = await callTool(c.access_token, name, args);
        const granted = needs.some((s) => scope.split(' ').includes(s));
        expect(refusedFor(result)).toBe(granted ? undefined : needs[0]);
        if (granted) return;
        expect(result.isError).toBe(true);
        expect(opened.count).toBe(before);
        expect(await getDb().select().from(payments).where(eq(payments.connectionId, t.connectionId))).toEqual([]);
      }
    );
  });
});

describe('a refresh decides the scopes of the new token', () => {
  it('given both scopes, when a refresh narrows to wallet:read, then paying is refused', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const narrowed = await refresh(c.refresh_token, 'wallet:read');
    const result = await callTool(narrowed.body.access_token, 'jaw_session_x402_pay', {
      url: 'http://127.0.0.1:9/paid',
    });
    expect(result.content[0].text).toMatch(/^insufficient_scope: /);
    expect(refusedFor(result)).toBe('x402:pay');
  });

  it('given a refresh asking for x402:pay alone, when the new token calls a tool, then it gets 401', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const narrowed = await refresh(c.refresh_token, 'x402:pay');
    const res = await mcp(narrowed.body.access_token, {
      method: 'tools/call',
      params: { name: 'jaw_session_status', arguments: {} },
    });
    expect(res.status).toBe(401);
  });

  it('given a connection granted wallet:read, when a refresh asks for x402:pay too, then it is refused and the refresh token still works', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });
    const widened = await refresh(c.refresh_token, 'wallet:read x402:pay');
    expect(widened).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
    const kept = await refresh(c.refresh_token, 'wallet:read');
    expect(kept.body.scope).toBe('wallet:read');
  });
});

describe('the scopes an authorization grants', () => {
  it.each(PROFILES)(
    'given an authorization for %s, then the token and the connection row hold exactly those',
    async (scope) => {
      const c = await connect(undefined, { scope });
      expect(c.scope).toBe(scope);
      const t = await tenantOf(c.access_token);
      const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
      expect(row.scopes).toEqual(scope.split(' '));
      // A budget only for what spends: wallet:read alone asks the wallet for a signature instead.
      const budgets = await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId));
      expect(budgets).toHaveLength(scope === 'wallet:read' ? 0 : 1);
    }
  );
});

describe('the removed wallet:send scope', () => {
  it('given an authorization that still asks for it, then the token and the connection hold the rest and no budget is asked', async () => {
    const c = await connect(undefined, { scope: 'wallet:read wallet:send' });
    expect(c.scope).toBe('wallet:read');
    const t = await tenantOf(c.access_token);
    expect(t.scopes).toEqual(['wallet:read']);
    const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
    expect(row.scopes).toEqual(['wallet:read']);
    expect(await getDb().select().from(grants).where(eq(grants.connectionId, t.connectionId))).toEqual([]);
  });

  it('given a refresh that asks for it, then it is refused invalid_scope naming it', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const widened = await refresh(c.refresh_token, 'wallet:read x402:pay wallet:send');
    expect(widened).toMatchObject({ status: 400, body: { error: 'invalid_scope', scope: 'wallet:send' } });
  });
});
