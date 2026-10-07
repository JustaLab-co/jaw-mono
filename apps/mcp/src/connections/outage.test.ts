import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { connect, ISSUER, REDIRECT, setTestEnv, token } from './testkit';

setTestEnv();
const { PgAdapter } = await import('./adapter');
const { GET: details } = await import('@/app/interaction/[uid]/details/route');

beforeAll(useTestDb);
afterEach(() => vi.restoreAllMocks());

const unreachable = () => Object.assign(new Error('Failed query'), { cause: { code: 'ENOTFOUND' } });

describe('OAuth routes while the database is unreachable', () => {
  it('the token endpoint answers 503, not a 500 server_error', async () => {
    const c = await connect();
    vi.spyOn(PgAdapter.prototype, 'find').mockRejectedValue(unreachable());
    const r = await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' });
    expect(r.status).toBe(503);
  });

  it('the authorization endpoint answers 503', async () => {
    vi.spyOn(PgAdapter.prototype, 'upsert').mockRejectedValue(unreachable());
    const { oauth } = await import('./provider');
    const params = new URLSearchParams({
      client_id: 'jaw-cli',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'wallet:read',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    const res = await oauth(new Request(`${ISSUER}/oauth/authorize?${params}`));
    expect(res.status).toBe(503);
  });

  it('the interaction routes answer 503', async () => {
    vi.spyOn(PgAdapter.prototype, 'find').mockRejectedValue(unreachable());
    const res = await details(new Request(`${ISSUER}/interaction/abcdefghijklmnop/details`), {
      params: Promise.resolve({ uid: 'abcdefghijklmnop' }),
    });
    expect(res.status).toBe(503);
  });
});
