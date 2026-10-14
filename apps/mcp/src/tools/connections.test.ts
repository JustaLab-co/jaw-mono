import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  callTool,
  connect,
  fakeWallet,
  mcp,
  owner,
  sessionFakes,
  setTestEnv,
  verifyLocally,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import type { OpenWallet } from '@/connections/relay';
import { revokeConnection } from './connections';
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
  const confirmedBy = (signer: ReturnType<typeof owner>, float = 0n) => ({
    openWallet: fakeWallet(walletAnswers(signer)),
    verify: verifyLocally,
    clients: sessionFakes(undefined, float).deps.clients,
  });

  it('says how much float stays at the other connection once it ends, and that jaw_disconnect from it returns it', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const { connectionId, sessionAddress } = await tenantOf(other.access_token);

    const asked = await revokeConnection(await tenantOf(me.access_token), connectionId, confirmedBy(signer, 180_000n));

    expect('structuredContent' in asked && asked.structuredContent).toMatchObject({
      payer: sessionAddress,
      left: '180000',
    });
    const text = asked.content[0].text;
    expect(text).toContain(`0.18 USDC stays at ${sessionAddress}`);
    expect(text).toContain('jaw_disconnect');
  });

  it('given the payer cannot be read, then it says the float may stay, without an amount', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const { connectionId, sessionAddress } = await tenantOf(other.access_token);
    const unreadable = { publicClient: () => ({ readContract: () => Promise.reject(new Error('node down')) }) };

    const asked = await revokeConnection(await tenantOf(me.access_token), connectionId, {
      ...confirmedBy(signer),
      clients: unreadable as never,
    });

    expect('structuredContent' in asked && asked.structuredContent).toMatchObject({ left: null });
    expect(asked.content[0].text).toContain(`Whatever float is at ${sessionAddress} stays there`);
  });

  it('ends another connection of the same owner once the owner confirms in the wallet: its tokens stop working', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const id = (await tenantOf(other.access_token)).connectionId;

    const asked = await revokeConnection(await tenantOf(me.access_token), id, confirmedBy(signer));
    expect('structuredContent' in asked && asked.structuredContent.url).toMatch(/cli-bridge/);
    await walletsSettled();
    expect(await works(other.access_token)).toBe(false);
    expect(await works(me.access_token)).toBe(true);
  });

  it('given a revoke of that connection still waiting for the owner, when asked again, then it hands back the same link and opens no other session', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const t = await tenantOf(me.access_token);
    const id = (await tenantOf(other.access_token)).connectionId;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = () => resolve()));
    const signs = walletAnswers(signer);
    let opened = 0;
    const waiting = {
      ...confirmedBy(signer),
      openWallet: ((chainId, until) => {
        opened++;
        return fakeWallet(async (method, params) => answered.then(() => signs(method, params)))(chainId, until);
      }) as OpenWallet,
    };

    const [first, again] = await Promise.all([revokeConnection(t, id, waiting), revokeConnection(t, id, waiting)]);
    const later = await revokeConnection(t, id, waiting);
    answer();
    await walletsSettled();

    expect(opened).toBe(1);
    const url = 'structuredContent' in first && first.structuredContent.url;
    expect(url).toMatch(/cli-bridge/);
    expect('structuredContent' in again && again.structuredContent.url).toBe(url);
    expect('structuredContent' in later && later.structuredContent.url).toBe(url);
    expect(await works(other.access_token)).toBe(false);
  });

  it('given the wallet is signed in to another account, then nothing is revoked', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    await revokeConnection(
      await tenantOf(me.access_token),
      (await tenantOf(other.access_token)).connectionId,
      confirmedBy(owner())
    );
    await walletsSettled();
    expect(await works(other.access_token)).toBe(true);
  });

  it('given the owner turns it down in the wallet, then nothing is revoked', async () => {
    const signer = owner();
    const other = await connect(signer);
    const me = await connect(signer, { scope: 'wallet:read' });
    const declined = { ...confirmedBy(signer), openWallet: fakeWallet(walletAnswers(signer, ['personal_sign'])) };
    await revokeConnection(
      await tenantOf(me.access_token),
      (await tenantOf(other.access_token)).connectionId,
      declined
    );
    await walletsSettled();
    expect(await works(other.access_token)).toBe(true);
  });

  it('refuses to end the connection the call comes from, pointing at jaw_disconnect', async () => {
    const me = await connect();
    const result = await callTool(me.access_token, 'jaw_revoke_connection', {
      id: (await tenantOf(me.access_token)).connectionId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('jaw_disconnect');
  });

  it("refuses another account's connection as if it did not exist, before opening the wallet", async () => {
    const theirs = await connect(owner());
    const me = await connect(owner());
    const result = await callTool(me.access_token, 'jaw_revoke_connection', {
      id: (await tenantOf(theirs.access_token)).connectionId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('No active connection with that id for this account.');
    expect(await works(theirs.access_token)).toBe(true);
  });
});
