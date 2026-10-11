import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, mcp, owner, setTestEnv } from '@/connections/testkit';
import { useTestDb } from '@/db/test-db';

setTestEnv();
beforeAll(useTestDb);

const tenantOf = async (token: string) => (await verifyBearer(token))?.extra?.tenant as Tenant;
const works = async (token: string) => (await mcp(token, { method: 'tools/list' })).status === 200;

describe('jaw_connections', () => {
  it("lists every connection of this account, marks this one, shows each budget, and no other account's", async () => {
    const signer = owner();
    const paying = await connect(signer, { scope: 'wallet:read x402:pay' });
    const reading = await connect(signer, { scope: 'wallet:read' });
    await connect(owner());

    const result = await callTool(reading.access_token, 'jaw_connections', {});
    const listed = result.structuredContent.connections as { id: string; current: boolean; budget: object | null }[];
    const [payingId, readingId] = [
      (await tenantOf(paying.access_token)).connectionId,
      (await tenantOf(reading.access_token)).connectionId,
    ];
    expect(listed.map((c) => c.id).sort()).toEqual([payingId, readingId].sort());
    expect(listed.find((c) => c.id === readingId)).toMatchObject({ current: true, budget: null });
    expect(listed.find((c) => c.id === payingId)).toMatchObject({ current: false, budget: { perDay: '1000000' } });
  });
});

describe('jaw_revoke_connection', () => {
  it('ends another connection of the same owner: its tokens stop working and it lists as revoked', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const id = (await tenantOf(other.access_token)).connectionId;

    const result = await callTool(me.access_token, 'jaw_revoke_connection', { id });
    expect(result.structuredContent.connection).toMatchObject({ id, status: 'revoked' });
    expect(await works(other.access_token)).toBe(false);
    expect(await works(me.access_token)).toBe(true);
  });

  it('refuses to end the connection the call comes from, pointing at jaw_disconnect', async () => {
    const me = await connect();
    const result = await callTool(me.access_token, 'jaw_revoke_connection', {
      id: (await tenantOf(me.access_token)).connectionId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('jaw_disconnect');
    expect(await works(me.access_token)).toBe(true);
  });

  it("refuses another account's connection as if it did not exist, and leaves it working", async () => {
    const theirs = await connect(owner());
    const me = await connect(owner());
    const result = await callTool(me.access_token, 'jaw_revoke_connection', {
      id: (await tenantOf(theirs.access_token)).connectionId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('No such connection for this account.');
    expect(await works(theirs.access_token)).toBe(true);
  });
});
