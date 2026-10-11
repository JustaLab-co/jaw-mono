import { describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { SCOPES } from '@/connections/provider';
import { GET } from './route';

setTestEnv();

describe('the protected resource metadata', () => {
  it('given the scopes the server defines, when it is fetched, then scopes_supported lists every one', async () => {
    const res = await GET(new Request('http://localhost/.well-known/oauth-protected-resource/mcp') as never);
    expect((await res.json()).scopes_supported).toEqual(Object.keys(SCOPES));
  });
});
