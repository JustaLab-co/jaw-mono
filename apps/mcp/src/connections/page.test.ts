import type { PermissionState } from '@jaw.id/agent';
import { connectionsSignInTypedData } from '@jaw.id/agent';
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { listFromPage, revokeFromPage, type ConnectionView, type PageDeps } from './page';
import { budgetConnection, callTool, ISSUER, mcp, owner, setTestEnv, token, verifyLocally } from './testkit';
import { useTestDb } from '@/db/test-db';

setTestEnv();
let pg: PGlite;
beforeAll(async () => {
  pg = await useTestDb();
});

const CHAIN = 84532;
const MINUTE = 60_000;

async function proof(signer = owner(), expires = new Date(Date.now() + 10 * MINUTE).toISOString()) {
  const typedData = connectionsSignInTypedData(CHAIN, { issuer: ISSUER, expires });
  return { account: signer.address, chainId: CHAIN, expires, signature: await signer.signTypedData(typedData) };
}

let chain: PermissionState = { status: 'ok', approved: true, revoked: false };
const deps: PageDeps = {
  verify: verifyLocally,
  readPermission: async () => chain,
  readFloats: async (_chainId, payers) => payers.map(() => 70_000n),
};

const list = async (post: object) => {
  const out = await listFromPage(post, deps);
  if (out.kind !== 'ok') throw new Error(out.kind);
  return out.body as ConnectionView[];
};

const connectWithBudget = () => budgetConnection(deps.readPermission);

describe('connections page sign-in', () => {
  it.each([
    ['expired', -MINUTE],
    ['too far ahead', 20 * MINUTE],
  ])('refuses a proof that is %s', async (_name, offset) => {
    const signed = await proof(owner(), new Date(Date.now() + offset).toISOString());
    expect((await listFromPage(signed, deps)).kind).toBe('invalid_request');
  });

  it('refuses a proof signed by another account, for another server, or malformed', async () => {
    const [a, b] = [owner(), owner()];
    expect((await listFromPage({ ...(await proof(b)), account: a.address }, deps)).kind).toBe('bad_signature');

    const expires = new Date(Date.now() + MINUTE).toISOString();
    const elsewhere = connectionsSignInTypedData(CHAIN, { issuer: 'https://other.example', expires });
    const signature = await a.signTypedData(elsewhere);
    expect((await listFromPage({ account: a.address, chainId: CHAIN, expires, signature }, deps)).kind).toBe(
      'bad_signature'
    );

    expect((await listFromPage({ ...(await proof(a)), chainId: 1 }, deps)).kind).toBe('invalid_request');
    expect((await listFromPage({ ...(await proof(a)), chainId: 8453 }, deps)).kind).toBe('invalid_request');
    expect((await listFromPage({ ...(await proof(a)), signature: 'nope' }, deps)).kind).toBe('invalid_request');
    expect((await listFromPage(null, deps)).kind).toBe('invalid_request');
  });

  it('answers 503, not a refusal, when the signature cannot be checked', async () => {
    const down = { ...deps, verify: async () => Promise.reject(new Error('rpc down')) };
    expect((await listFromPage(await proof(), down)).kind).toBe('verification_unavailable');
  });
});

describe('connections list', () => {
  it("lists the signer's connections with identity, scopes, budget, float and recent events", async () => {
    const { c, sessionAddress, permissionId } = await connectWithBudget();
    await callTool(c.access_token, 'jaw_request_signature', { message: 'hi' });

    const [view] = await list(await proof(c.signer));
    expect(view).toMatchObject({
      status: 'active',
      chainId: CHAIN,
      client: { clientId: 'jaw-cli', name: 'JAW CLI', official: true },
      scopes: ['wallet:read', 'x402:pay', 'wallet:send'],
      payer: sessionAddress,
      float: '70000',
      budgets: [{ permissionId, allowance: '1000000', period: 'day', state: 'active' }],
    });
    expect(view.events.map((e) => [e.tool, e.outcome])).toEqual([
      ['jaw_request_signature', 'ok'],
      ['jaw_request_budget', 'ok'],
    ]);
    expect(view.events[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows another account none of the first one', async () => {
    const { c } = await connectWithBudget();
    expect(await list(await proof(owner()))).toEqual([]);
    expect((await list(await proof(c.signer))).length).toBe(1);
  });
});

describe('revoke from the page', () => {
  it('kills the access and refresh tokens and deletes the key wraps', async () => {
    const { c } = await connectWithBudget();
    const [view] = await list(await proof(c.signer));

    const out = await revokeFromPage(view.id, await proof(c.signer), deps);
    expect(out).toMatchObject({ kind: 'ok', body: { id: view.id, status: 'revoked' } });

    expect((await mcp(c.access_token, { method: 'tools/list' })).status).toBe(401);
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: 'jaw-cli',
    });
    expect(refreshed.status).toBe(400);
    const refreshRows = await pg.query(
      `select count(*)::int as n from oauth_payloads p join connections c on c.grant_id = p.grant_id where c.id = $1`,
      [view.id]
    );
    expect(refreshRows.rows).toEqual([{ n: 0 }]);
  });

  it('refuses a refresh of an ended connection whose token row survived', async () => {
    const { c, tenant } = await connectWithBudget();
    await pg.query(`update connections set status = 'revoked', revoked_at = now() where id = $1`, [
      tenant.connectionId,
    ]);
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: 'jaw-cli',
    });
    expect(refreshed.status).toBe(400);
    const wraps = await pg.query(
      `select count(*)::int as n from oauth_payloads p join connections c on c.grant_id = p.grant_id
        where c.id = $1 and p.key_wrap is not null and p.consumed_at is null and p.model = 'RefreshToken'`,
      [tenant.connectionId]
    );
    expect(wraps.rows).toEqual([{ n: 1 }]);
  });

  it('shows a connection past its end as expired', async () => {
    const { c, tenant } = await connectWithBudget();
    await pg.query(`update connections set expires_at = now() - interval '1 minute' where id = $1`, [
      tenant.connectionId,
    ]);
    expect((await list(await proof(c.signer)))[0].status).toBe('expired');
  });

  it('lists the budget for an on-chain revoke until the chain shows it revoked', async () => {
    const { c, permissionId } = await connectWithBudget();
    const [view] = await list(await proof(c.signer));
    await revokeFromPage(view.id, await proof(c.signer), deps);

    expect((await list(await proof(c.signer)))[0].budgets).toMatchObject([{ permissionId, state: 'revoke_on_chain' }]);
    chain = { status: 'ok', approved: true, revoked: true };
    try {
      expect((await list(await proof(c.signer)))[0].budgets).toMatchObject([{ permissionId, state: 'revoked' }]);
    } finally {
      chain = { status: 'ok', approved: true, revoked: false };
    }
  });

  it("is idempotent, and refuses another account's connection as not found", async () => {
    const { c } = await connectWithBudget();
    const [view] = await list(await proof(c.signer));
    expect((await revokeFromPage(view.id, await proof(owner()), deps)).kind).toBe('not_found');
    expect((await mcp(c.access_token, { method: 'tools/list' })).status).toBe(200);

    expect((await revokeFromPage(view.id, await proof(c.signer), deps)).kind).toBe('ok');
    expect(await revokeFromPage(view.id, await proof(c.signer), deps)).toMatchObject({
      kind: 'ok',
      body: { status: 'revoked' },
    });
  });
});

describe('connections routes', () => {
  it('tells the keys origin what to sign and refuses a bad proof with a fixed error', async () => {
    const { GET, POST } = await import('@/app/api/connections/route');
    const ctx = { params: Promise.resolve({}) };
    const got = await GET(new Request(`${ISSUER}/api/connections`), ctx);
    expect(got.headers.get('access-control-allow-origin')).toBe('http://keys.test');
    expect(await got.json()).toEqual({ issuer: ISSUER, chainId: CHAIN });

    const posted = await POST(new Request(`${ISSUER}/api/connections`, { method: 'POST', body: '{"account":1}' }), ctx);
    expect(posted.status).toBe(400);
    expect(await posted.json()).toEqual({ error: 'invalid_request' });
  });
});
