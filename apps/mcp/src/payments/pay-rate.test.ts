import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { connect, setTestEnv } from '@/connections/testkit';
import { useTestDb } from '@/db/test-db';
import { pay, PAY_RATE_LIMIT, type PayDeps } from './pay';

// The count is set rather than reached, so a run that crosses a window boundary cannot split it.
const hits = vi.hoisted(() => ({ count: 0, keys: [] as string[] }));
vi.mock('@/db/settings', async (actual) => ({
  ...(await actual<typeof import('@/db/settings')>()),
  countHit: async (key: string) => {
    hits.keys.push(key);
    return hits.count;
  },
}));

setTestEnv();
beforeAll(useTestDb);

describe('the per-connection pay rate limit', () => {
  it.each([
    [PAY_RATE_LIMIT, false],
    [PAY_RATE_LIMIT + 1, true],
  ])('given hit %i on a connection in one window, when it pays, then rate_limited is %s', async (count, limited) => {
    hits.count = 0;
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    hits.count = count;

    const result = await pay(t, { url: 'https://seller.test/x', idempotencyKey: `rate-${count}` }, {} as PayDeps);

    expect(hits.keys.at(-1)).toBe(`pay:${t.connectionId}`);
    // Past the gate, a connection with no budget is refused at the next one.
    expect(result.content[0].text).toMatch(limited ? /^rate_limited/ : /^no_grant/);
  });
});
