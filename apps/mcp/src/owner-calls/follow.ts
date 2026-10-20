import { config } from '@/connections/config';
import type { Ask, Wallet } from '@/connections/relay';
import { sealResume } from '@/connections/seal';
import { keepLease } from '@/connections/session-lease';
import type { Leased } from '@/db/leased';
import { errorLabel, log } from '@/lib/edge';

type Held = { id: string; leaseHolder: string | null };

/** Runs an owner calls or swap approval on `wallet` while this process holds the row. */
export function followOwner<R extends Held>(
  leased: Leased<R>,
  row: R,
  wallet: Wallet,
  work: (ask: Ask) => Promise<void>,
  idField: 'ownerCallId' | 'swapId'
): void {
  const stop = keepLease(
    async () => {
      const held = await leased.renew(row);
      if (!held && (await leased.holderOf(row)) !== row.leaseHolder) wallet.close();
      return held;
    },
    () => leased.end(row)
  );
  void wallet
    .run(work, (resume) => leased.saveRelay(row, sealResume(config().ring, resume, row.id)))
    .catch((err: unknown) => log('warn', { msg: 'owner approval ended', [idField]: row.id, error: errorLabel(err) }))
    .finally(stop);
}
