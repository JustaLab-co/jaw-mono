import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { connect, mcp, setTestEnv } from '@/connections/testkit';

setTestEnv();
beforeAll(useTestDb);

// Who acts for each tool: the session key inside the owner's budget, the owner in the wallet, or nobody.
const SIGNERS = {
  jaw_session_x402_pay: 'session',
  jaw_session_x402_quote: 'session',
  jaw_session_x402_discover: 'session',
  jaw_session_history: 'session',
  jaw_session_disconnect: 'session',
  jaw_request_budget: 'owner',
  jaw_swap: 'owner',
  jaw_send_calls: 'owner',
  jaw_status: 'none',
  jaw_add_funds: 'none',
  jaw_connections: 'none',
  jaw_revoke_connection: 'none',
  jaw_swap_status: 'none',
  jaw_get_calls_status: 'none',
} as const;

const RENAMED_AWAY = [
  'jaw_pay_and_fetch',
  'jaw_quote',
  'jaw_discover',
  'jaw_history',
  'jaw_disconnect',
  'jaw_send_calls_status',
];

describe('the tool names', () => {
  it('given the tools the server lists, then each one is in the signer table and the old names are gone', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });
    const listed: string[] = (await mcp(c.access_token, { method: 'tools/list' })).json.result.tools.map(
      (t: { name: string }) => t.name
    );
    expect([...listed].sort()).toEqual(Object.keys(SIGNERS).sort());
    for (const old of RENAMED_AWAY) expect(listed).not.toContain(old);
  });

  it.each(Object.entries(SIGNERS))('given %s signed by %s, then the jaw_session_ prefix matches', (name, signer) => {
    expect(name.startsWith('jaw_session_')).toBe(signer === 'session');
  });
});
