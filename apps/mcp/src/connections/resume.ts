import { errorLabel, log } from '@/lib/edge';
import { tenantOf, type Tenant } from './tenant';
import { config } from './config';
import { resumeWallet, WalletBusy, type Wallet } from './relay';
import { findActive, type ConnectionRow } from './rows';
import { openResume } from './seal';
import { REJOIN_TRIES } from '@/db/leased';

// The relay takes 20 new connections a minute from one IP, and fresh links share them.
export const REJOINS_PER_TICK_UNDER_RELAY_IP_LIMIT = 5;

type Resumable = {
  id: string;
  connectionId: string;
  walletUrl: string | null;
  relay: string | null;
  approveBy: Date | null;
  updatedAt: Date;
  resumeFailures: number;
};

export interface Rejoin<R extends Resumable> {
  idField: 'permissionRequestId' | 'ownerCallId' | 'swapId';
  take: (row: R) => Promise<R | undefined>;
  release: (row: R) => Promise<unknown>;
  /** Gives the row back with one more failed rejoin counted; returns it as written. */
  failed: (row: R) => Promise<(R & { resumeFailures: number }) | undefined>;
  /** Ends the wait for a resume: the page is gone, or the stored session cannot be used. */
  lost: (row: R) => Promise<unknown>;
  /** How the row ends when its connection ended; `lost` when absent. */
  connectionEnded?: (row: R) => Promise<unknown>;
  /** Undefined when the stored work cannot be rebuilt. */
  start: (row: R, t: Tenant) => ((wallet: Wallet) => void) | undefined;
}

type Waiting = { updatedAt: Date; resume: () => Promise<void> };

/** The rows of one table waiting for a resume, oldest first. */
export type WaitingIn = (limit: number) => Promise<Waiting[]>;

export const waitingIn =
  <R extends Resumable>(find: (limit: number) => Promise<R[]>, rejoin: Rejoin<R>): WaitingIn =>
  async (limit) =>
    (await find(limit)).map((row) => ({ updatedAt: row.updatedAt, resume: () => resumeRow(row, rejoin) }));

/** Starts the resumes that waited longest across every table, at most the cap in all. */
export async function resumeTick(tables: WaitingIn[]): Promise<Promise<void>[]> {
  const cap = REJOINS_PER_TICK_UNDER_RELAY_IP_LIMIT;
  try {
    const waiting = (await Promise.all(tables.map((find) => find(cap)))).flat();
    waiting.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    return waiting.slice(0, cap).map((w) => w.resume());
  } catch (err) {
    log('warn', { msg: 'relay sessions to resume not read', error: errorLabel(err) });
    return [];
  }
}

export const resumeRow = <R extends Resumable>(row: R, rejoin: Rejoin<R>): Promise<void> =>
  resumeOne(row, rejoin).catch((err: unknown) =>
    log('warn', { msg: 'relay session not resumed', [rejoin.idField]: row.id, error: errorLabel(err) })
  );

async function resumeOne<R extends Resumable>(
  found: R,
  { take, release, failed, lost, connectionEnded = lost, start }: Rejoin<R>
) {
  const row = await take(found);
  if (!row) return;
  if (row.resumeFailures >= REJOIN_TRIES) return void (await lost(row));
  const connection = await findActive(row.connectionId);
  if (!connection) return void (await connectionEnded(row));
  const t = tokenlessTenant(connection);
  const relay = openResume(config().ring, row.relay!, row.id);
  const sameLink = relay !== undefined && relay.session === sessionOf(row.walletUrl!);
  const run = sameLink && start(row, t);
  if (!run) return void (await lost(row));
  let wallet: Wallet | undefined;
  try {
    wallet = await resumeWallet(relay, row.walletUrl!, row.approveBy!, t);
  } catch (err) {
    if (err instanceof WalletBusy) return void (await release(row));
    const counted = await failed(row);
    if (counted && counted.resumeFailures >= REJOIN_TRIES) await lost(row);
    throw err;
  }
  if (!wallet) return void (await lost(row));
  run(wallet);
}

const sessionOf = (walletUrl: string) => new URL(walletUrl).searchParams.get('session');

// No scopes, so a scope check on a resumed run fails closed.
const tokenlessTenant = (c: ConnectionRow): Tenant =>
  tenantOf(c, [], () => {
    throw new Error('a resumed request has no session key');
  });
