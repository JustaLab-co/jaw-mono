import { eq, sql } from 'drizzle-orm';
import { getDb } from './client';
import { rateLimits, settings } from './schema';

// A frozen database keeps the connection open and never answers, and postgres.js
// has no query timeout. The edge reads these first on every request, so giving up
// here turns a frozen database into a 503 instead of a hung request.
const DEADLINE_MS = 5_000;

function withinDeadline<T>(query: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('the database did not answer in time'), { code: 'ETIMEDOUT' })),
      DEADLINE_MS
    );
  });
  return Promise.race([query, late]).finally(() => clearTimeout(timer));
}

async function flag(key: string): Promise<boolean> {
  const [row] = await withinDeadline(getDb().select().from(settings).where(eq(settings.key, key)));
  return row?.value === true;
}

export const isPaused = () => flag('paused');

export const isPaymentsPaused = () => flag('payments_paused');

export async function countHit(key: string, windowMs: number): Promise<number> {
  // The window comes from the database clock, so replicas with skewed clocks share it.
  const windowStart = sql`to_timestamp(floor(extract(epoch from statement_timestamp()) * 1000 / ${windowMs}) * ${windowMs} / 1000.0)`;
  const db = getDb();
  // Old windows are swept now and then rather than on every request.
  if (Math.random() < 0.01) {
    await withinDeadline(db.delete(rateLimits).where(sql`${rateLimits.windowStart} < now() - interval '1 hour'`));
  }
  const [row] = await withinDeadline(
    db
      .insert(rateLimits)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count })
  );
  return row.count;
}
