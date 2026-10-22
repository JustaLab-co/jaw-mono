import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { startRelay } from '@/connections/fake-relay';
import { ownerRelay, SESSION_LIMITS } from '@/connections/relay';
import { connect, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { MAX_ADD_FUNDS_PER_ACCOUNT, MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';
import { addFunds } from './add-funds';
import { sign } from './sign';

const relay = await startRelay();
setTestEnv();
process.env.JAW_RELAY_URL = relay.url;
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterAll(() => relay.close());

// Real owner relay sessions, none of which the owner opens, so each holds its slot in the account's share of the pool.
async function connections(n: number) {
  const signer = owner();
  const tenants: Tenant[] = [];
  for (let i = 0; i < n; i++) {
    const c = await connect(signer, { scope: 'wallet:read' });
    await walletsSettled();
    tenants.push((await verifyBearer(c.access_token))?.extra?.tenant as Tenant);
  }
  return tenants;
}

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;
const urlOf = (r: object) => ('structuredContent' in r ? (r.structuredContent as { url?: string })?.url : undefined);

describe('Add Funds links in the owner relay pool', () => {
  it('fit beside the open-link cap within the per-account relay limit', () => {
    expect(MAX_ADD_FUNDS_PER_ACCOUNT).toBeGreaterThan(0);
    expect(MAX_ADD_FUNDS_PER_ACCOUNT + MAX_OPEN_PER_ACCOUNT).toBe(SESSION_LIMITS.ownerPerAccount);
  });

  it('given Add Funds asked on as many connections as the relay holds per account, then the ones past the bound are refused and the next sign still opens', async () => {
    const tenants = await connections(SESSION_LIMITS.ownerPerAccount + 1);
    const asked = [];
    for (const t of tenants.slice(0, SESSION_LIMITS.ownerPerAccount)) {
      asked.push(await addFunds(t, {}, { openWallet: ownerRelay }));
    }

    const s = await sign(tenants[SESSION_LIMITS.ownerPerAccount], { message: 'hello', idempotencyKey: 'k1' } as never, {
      openWallet: ownerRelay,
    });

    expect(asked.slice(0, MAX_ADD_FUNDS_PER_ACCOUNT).map(urlOf)).toEqual(
      Array(MAX_ADD_FUNDS_PER_ACCOUNT).fill(expect.stringMatching(/cli-bridge/))
    );
    for (const r of asked.slice(MAX_ADD_FUNDS_PER_ACCOUNT)) expect(textOf(r)).toMatch(/^add_funds_busy: /);
    expect(JSON.stringify(s)).not.toMatch(/wallet_busy|account_busy/);
    expect(urlOf(s)).toMatch(/cli-bridge/);
  });

  it('given Add Funds links and other links waiting up to both bounds, then none is wallet_busy and the next of each kind is refused by its own bound', async () => {
    const tenants = await connections(MAX_ADD_FUNDS_PER_ACCOUNT + MAX_OPEN_PER_ACCOUNT + 2);
    const funding = tenants.slice(0, MAX_ADD_FUNDS_PER_ACCOUNT);
    const signing = tenants.slice(MAX_ADD_FUNDS_PER_ACCOUNT, MAX_ADD_FUNDS_PER_ACCOUNT + MAX_OPEN_PER_ACCOUNT);
    const [oneMoreFunds, oneMoreSign] = tenants.slice(-2);

    const funded = [];
    for (const t of funding) funded.push(await addFunds(t, {}, { openWallet: ownerRelay }));
    const signed = [];
    for (const [i, t] of signing.entries()) {
      signed.push(await sign(t, { message: 'hello', idempotencyKey: `k${i}` } as never, { openWallet: ownerRelay }));
    }
    const extraFunds = await addFunds(oneMoreFunds, {}, { openWallet: ownerRelay });
    const extraSign = await sign(oneMoreSign, { message: 'hello', idempotencyKey: 'extra' } as never, {
      openWallet: ownerRelay,
    });

    for (const r of [...funded, ...signed]) expect(urlOf(r)).toMatch(/cli-bridge/);
    expect(textOf(extraFunds)).toMatch(/^add_funds_busy: /);
    expect(textOf(extraFunds)).toContain(
      `anyone can send funds on eip155:${oneMoreFunds.chainId} to ${oneMoreFunds.account}`
    );
    expect(JSON.stringify(extraSign)).toContain('account_busy');
    expect(JSON.stringify([extraFunds, extraSign])).not.toContain('wallet_busy');
  });
});
