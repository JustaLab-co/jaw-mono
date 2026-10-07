import { eq, sql } from 'drizzle-orm';
import { getDb } from './client';
import { rateLimits, settings } from './schema';

export async function isPaused(): Promise<boolean> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, 'paused'));
  return row?.value === true;
}

// Fixed-window counter. Returns how many hits the key has in the current window.
export async function countHit(key: string, windowMs: number): Promise<number> {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const db = getDb();
  await db.delete(rateLimits).where(sql`${rateLimits.windowStart} < now() - interval '1 hour'`);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  return row.count;
}
