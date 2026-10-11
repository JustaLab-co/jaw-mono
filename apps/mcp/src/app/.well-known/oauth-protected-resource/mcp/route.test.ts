import { CONNECTION_SCOPES, type ConnectionScope } from '@jaw.id/agent';
import { describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { GET } from './route';

setTestEnv();

describe('the protected resource metadata', () => {
  it('given the scopes the server defines, when it is fetched, then scopes_supported lists every one', async () => {
    const res = await GET(new Request('http://localhost/.well-known/oauth-protected-resource/mcp') as never);
    expect((await res.json()).scopes_supported).toEqual(Object.keys(CONNECTION_SCOPES));
  });

  it('given every scope it advertises, when the pages look it up in @jaw.id/agent, then each has a label', async () => {
    const res = await GET(new Request('http://localhost/.well-known/oauth-protected-resource/mcp') as never);
    for (const scope of (await res.json()).scopes_supported as string[]) {
      expect(CONNECTION_SCOPES[scope as ConnectionScope], scope).toMatch(/\w/);
    }
  });
});
