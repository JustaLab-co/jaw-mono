import { randomBytes } from 'node:crypto';
import type { Address } from 'viem';
import { errorLabel, log } from '@/lib/edge';
import type { Tenant } from './auth';
import { config } from './config';
import { PageGone, resumeWallet, WalletBusy, type Ask, type Wallet } from './relay';
import { findActive, type ConnectionRow } from './rows';
import type { ConnectionScope } from './scopes';
import { openResume } from './seal';

export const RESUMES_PER_TICK = 10;

export const newHolder = () => randomBytes(16).toString('base64url');

export type Lost = 'connection_ended' | 'unopenable' | 'page_gone';

type Resumable = { id: string; connectionId: string; relay: string | null; approveBy: Date | null };

export interface Rejoin<R extends Resumable> {
  take: (row: R) => Promise<R | undefined>;
  release: (row: R) => Promise<unknown>;
  lost: (row: R, why: Lost) => Promise<unknown>;
  follow: (row: R, wallet: Wallet, t: Tenant) => void;
}

export async function resumeEach<R extends Resumable>(
  idField: 'permissionRequestId' | 'ownerCallId' | 'swapId',
  find: () => Promise<R[]>,
  rejoin: Rejoin<R>
) {
  try {
    for (const row of await find()) {
      void resumeOne(row, rejoin).catch((err: unknown) =>
        log('warn', { msg: 'relay session not resumed', [idField]: row.id, error: errorLabel(err) })
      );
    }
  } catch (err) {
    log('warn', { msg: 'relay sessions to resume not read', error: errorLabel(err) });
  }
}

async function resumeOne<R extends Resumable>(found: R, { take, release, lost, follow }: Rejoin<R>) {
  const row = await take(found);
  if (!row) return;
  const connection = await findActive(row.connectionId);
  if (!connection) return lost(row, 'connection_ended');
  const relay = openResume(config().ring, row.relay!, row.id);
  if (!relay) return lost(row, 'unopenable');
  const t = tokenlessTenant(connection);
  let wallet: Wallet | undefined;
  try {
    wallet = await resumeWallet(relay, row.approveBy!, t);
  } catch (err) {
    await release(row);
    if (err instanceof WalletBusy) return;
    throw err;
  }
  if (!wallet) return lost(row, 'page_gone');
  return follow(row, wallet, t);
}

const NOT_THE_REQUEST = -32600;

export const otherRequestAsGone =
  (ask: Ask): Ask =>
  (method, params) =>
    ask(method, params).catch((err: unknown) => {
      throw (err as { code?: unknown }).code === NOT_THE_REQUEST ? new PageGone() : err;
    });

const tokenlessTenant = (c: ConnectionRow): Tenant => ({
  connectionId: c.id,
  account: c.account as Address,
  chainId: c.chainId,
  clientId: c.clientId,
  clientName: c.clientName,
  scopes: c.scopes as ConnectionScope[],
  sessionAddress: c.sessionAddress as Address,
  expiresAt: c.expiresAt,
  sessionKey: () => {
    throw new Error('a resumed request has no session key');
  },
});
