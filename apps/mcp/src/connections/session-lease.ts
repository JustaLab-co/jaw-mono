import { sql } from 'drizzle-orm';
import { errorLabel, log } from '@/lib/edge';

export const SESSION_LEASE_MS = 30_000;
export const SESSION_RENEW_MS = 10_000;
// A grant, revoke or sign link whose lease ended less than this ago may belong to a process whose
// renewals a database stall held up, so nothing takes it over before then.
export const SESSION_STALL_GRACE_MS = 60_000;

/** The database clock decides, so replicas with skewed clocks agree on who holds a link. */
export const sessionLeaseEnd = sql`statement_timestamp() + ${SESSION_LEASE_MS} * interval '1 millisecond'`;

/** A lease ending after this may still be held. */
export const heldSince = sql`statement_timestamp() - ${SESSION_STALL_GRACE_MS} * interval '1 millisecond'`;

/** A cheap pre-check on this process's clock. The conditional update in reopenLink decides. */
export const leaseHeld = (until: Date | null) => until !== null && until.getTime() > Date.now();

/**
 * Renews a row's lease while its relay session runs. `renew` resolves empty once the row
 * moved on or another process took its url. The returned stop waits for every
 * renewal in flight, then clears the lease so a retry can reopen at once.
 */
export function keepLease(renew: () => Promise<unknown>, end: () => Promise<unknown>): () => Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const timer = setInterval(() => {
    const run: Promise<void> = renew()
      .then(
        (held) => {
          if (!held) clearInterval(timer);
        },
        (err: unknown) => log('warn', { msg: 'session lease not renewed', error: errorLabel(err) })
      )
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
  }, SESSION_RENEW_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.all(inFlight);
    await end().catch((err: unknown) => log('warn', { msg: 'session lease not cleared', error: errorLabel(err) }));
  };
}
