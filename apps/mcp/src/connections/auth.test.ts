import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { connect, ISSUER, setTestEnv } from './testkit';

setTestEnv();
const { POST } = await import('@/app/mcp/route');

beforeAll(useTestDb);
afterEach(() => vi.restoreAllMocks());

const rpc = (body: object, token?: string) =>
  POST(
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    })
  );

const initialize = {
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

describe('/mcp behind OAuth', () => {
  it('answers 401 with resource_metadata in WWW-Authenticate without a token', async () => {
    const res = await rpc(initialize);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  it('serves initialize and tools/list to a connected client', async () => {
    const { access_token } = await connect();
    const init = await rpc(initialize, access_token);
    expect(init.status).toBe(200);
    expect(await init.text()).toContain('"name":"jaw"');
    const list = await rpc({ method: 'tools/list' }, access_token);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('"tools":[]');
  });

  it('refuses a token without wallet:read', async () => {
    const { access_token } = await connect(undefined, { scope: 'openid' });
    const res = await rpc(initialize, access_token);
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('never writes a token or key to the logs', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    const c = await connect();
    await rpc(initialize, c.access_token);
    await rpc(initialize, `${c.access_token}x`);
    const output = lines.join('\n');
    for (const secret of [c.access_token, c.refresh_token, c.access_token.split('.')[3]]) {
      expect(output).not.toContain(secret);
    }
  });
});
