import { sql } from 'drizzle-orm';
import { errorLabel, log } from '@/lib/edge';

export const SESSION_LEASE_MS = 30_000;
export const SESSION_RENEW_MS = 10_000;

/** The database clock decides, so replicas with skewed clocks agree on who holds a link. */
export const sessionLeaseEnd = sql`statement_timestamp() + ${SESSION_LEASE_MS} * interval '1 millisecond'`;

/** A cheap pre-check on this process's clock. The conditional update in reopenLink decides. */
export const leaseHeld = (until: Date | null) => until !== null && until.getTime() > Date.now();

/**
 * Renews a row's lease while its relay session runs. `renew` resolves empty once the row
 * moved on or another process took its url. The returned stop waits for a renewal in
 * flight, then clears the lease so a retry can reopen at once.
 */
export function keepLease(renew: () => Promise<unknown>, end: () => Promise<unknown>): () => Promise<void> {
  let inFlight: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    inFlight = renew().then(
      (held) => {
        if (!held) clearInterval(timer);
      },
      (err: unknown) => log('warn', { msg: 'session lease not renewed', error: errorLabel(err) })
    );
  }, SESSION_RENEW_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
    await end().catch((err: unknown) => log('warn', { msg: 'session lease not cleared', error: errorLabel(err) }));
  };
}
