import { randomBytes } from 'node:crypto';
import { errorLabel, log } from '@/lib/edge';
import { tenantOf, type Tenant } from './auth';
import { config } from './config';
import { resumeWallet, WalletBusy, type Wallet } from './relay';
import { findActive, type ConnectionRow } from './rows';
import { openResume } from './seal';

export const RESUMES_PER_TICK = 10;

export const newHolder = () => randomBytes(16).toString('base64url');

export type Lost = 'connection_ended' | 'unopenable' | 'page_gone';

type Resumable = {
  id: string;
  connectionId: string;
  walletUrl: string | null;
  relay: string | null;
  approveBy: Date | null;
};

export interface Rejoin<R extends Resumable> {
  idField: 'permissionRequestId' | 'ownerCallId' | 'swapId';
  take: (row: R) => Promise<R | undefined>;
  release: (row: R) => Promise<unknown>;
  lost: (row: R, why: Lost) => Promise<unknown>;
  /** Undefined when the stored work cannot be rebuilt. */
  start: (row: R, t: Tenant) => ((wallet: Wallet) => void) | undefined;
}

export async function resumeEach<R extends Resumable>(find: () => Promise<R[]>, rejoin: Rejoin<R>) {
  try {
    return (await find()).map((row) => resumeRow(row, rejoin));
  } catch (err) {
    log('warn', { msg: 'relay sessions to resume not read', error: errorLabel(err) });
    return [];
  }
}

export const resumeRow = <R extends Resumable>(row: R, rejoin: Rejoin<R>): Promise<void> =>
  resumeOne(row, rejoin).catch((err: unknown) =>
    log('warn', { msg: 'relay session not resumed', [rejoin.idField]: row.id, error: errorLabel(err) })
  );

async function resumeOne<R extends Resumable>(found: R, { take, release, lost, start }: Rejoin<R>) {
  const row = await take(found);
  if (!row) return;
  const connection = await findActive(row.connectionId);
  if (!connection) return void (await lost(row, 'connection_ended'));
  const t = tokenlessTenant(connection);
  const relay = openResume(config().ring, row.relay!, row.id);
  const sameLink = relay !== undefined && relay.session === sessionOf(row.walletUrl!);
  const run = sameLink && start(row, t);
  if (!run) return void (await lost(row, 'unopenable'));
  let wallet: Wallet | undefined;
  try {
    wallet = await resumeWallet(relay, row.walletUrl!, row.approveBy!, t);
  } catch (err) {
    await release(row);
    if (err instanceof WalletBusy) return;
    throw err;
  }
  if (!wallet) return void (await lost(row, 'page_gone'));
  run(wallet);
}

const sessionOf = (walletUrl: string) => new URL(walletUrl).searchParams.get('session');

// No scopes, so a scope check on a resumed run fails closed.
const tokenlessTenant = (c: ConnectionRow): Tenant =>
  tenantOf(c, [], () => {
    throw new Error('a resumed request has no session key');
  });
