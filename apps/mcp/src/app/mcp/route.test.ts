import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { connect, mcp, setTestEnv } from '@/connections/testkit';

setTestEnv();
beforeAll(useTestDb);

// Pinned by hand. Only pay and disconnect read the session key, so nothing
// observable tells quote, discover and history apart from non-session tools.
const SIGNERS = {
  jaw_session_x402_pay: 'session',
  jaw_session_x402_quote: 'session',
  jaw_session_x402_discover: 'session',
  jaw_session_history: 'session',
  jaw_session_disconnect: 'session',
  jaw_session_execute: 'session',
  jaw_grant_permissions: 'owner',
  jaw_swap: 'owner',
  jaw_send_calls: 'owner',
  jaw_revoke_permission: 'owner',
  jaw_session_status: 'session',
  jaw_sign: 'owner',
  jaw_add_funds: 'none',
  jaw_connections: 'none',
  jaw_swap_status: 'none',
  jaw_get_calls_status: 'none',
  jaw_get_sign_status: 'none',
  jaw_get_assets: 'none',
  jaw_get_defi_positions: 'none',
  jaw_get_calls_history: 'none',
  jaw_get_permissions: 'none',
  jaw_get_capabilities: 'none',
  jaw_read_contracts: 'none',
  jaw_resolve_name: 'none',
} as const;

const RENAMED_AWAY = [
  'jaw_status',
  'jaw_pay_and_fetch',
  'jaw_quote',
  'jaw_discover',
  'jaw_history',
  'jaw_disconnect',
  'jaw_send_calls_status',
  'jaw_request_budget',
  'jaw_revoke_connection',
];

describe('the pinned tool names', () => {
  it('given the tools the server lists, then the list is the pinned set and the old names are gone', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });
    const listed: string[] = (await mcp(c.access_token, { method: 'tools/list' })).json.result.tools.map(
      (t: { name: string }) => t.name
    );
    expect([...listed].sort()).toEqual(Object.keys(SIGNERS).sort());
    for (const old of RENAMED_AWAY) expect(listed).not.toContain(old);
  });

  it.each(Object.entries(SIGNERS))(
    'given the pinned name %s for actor %s, then the jaw_session_ prefix marks the session tools',
    (name, signer) => {
      expect(name.startsWith('jaw_session_')).toBe(signer === 'session');
    }
  );
});
