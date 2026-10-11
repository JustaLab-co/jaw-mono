import { afterEach, expect, it, vi } from 'vitest';
import { databaseUnreachable } from '@/lib/edge';
import { setDb, type Db } from './client';
import { countHit, isPaused } from './settings';

afterEach(() => vi.useRealTimers());

// A frozen database: the connection is open and no query ever answers.
const never = () => new Promise<never>(() => {});
const chain: unknown = new Proxy(() => chain, {
  get: (_t, prop) =>
    prop === 'then' ? (ok: unknown, fail: unknown) => never().then(ok as never, fail as never) : chain,
  apply: () => chain,
});

it('gives up on a database that never answers, as an unreachable one', async () => {
  vi.useFakeTimers();
  setDb(chain as Db, 'pglite');
  const settled = [isPaused(), countHit('ip:203.0.113.7', 60_000)].map((read) => read.catch((err: unknown) => err));
  await vi.advanceTimersByTimeAsync(10_000);
  for (const err of await Promise.all(settled)) expect(databaseUnreachable(err)).toBe(true);
});

it('takes the float holder by name', () => {
  // @ts-expect-error without a holder, holds would not serialize across replicas
  expect(() => setDb(chain as Db)).not.toThrow();
});
