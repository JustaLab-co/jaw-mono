import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { owner, grantBudget, connect, setTestEnv } from '@/connections/testkit';
import { useTestDb } from '@/db/test-db';
import { pay, PAY_RATE_LIMIT, type PayDeps } from './pay';

// The count is set rather than reached, so a run that crosses a window boundary cannot split it.
const hits = vi.hoisted(() => ({ count: 0, keys: [] as string[], windows: [] as number[] }));
vi.mock('@/db/settings', async (actual) => ({
  ...(await actual<typeof import('@/db/settings')>()),
  countHit: async (key: string, windowMs: number) => {
    hits.keys.push(key);
    hits.windows.push(windowMs);
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
    const signer = owner();
    const c = await connect(signer, { scope: 'wallet:read x402:pay' });
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    await grantBudget(t, signer);
    hits.count = count;

    const unreadable = { readPermission: async () => ({ status: 'unavailable' }) } as unknown as PayDeps;
    const result = await pay(t, { url: 'https://seller.test/x', idempotencyKey: `rate-${count}` }, unreadable);

    // The refusal tells the agent to wait a minute.
    expect([hits.keys.at(-1), hits.windows.at(-1)]).toEqual([`pay:${t.connectionId}`, 60_000]);
    // Past the gate, the budget is read from a chain this test leaves unreachable.
    expect(result.structuredContent?.refusal?.code ?? result.content[0].text).toMatch(
      limited ? /^rate_limited/ : /^chain_unavailable/
    );
  });
});
