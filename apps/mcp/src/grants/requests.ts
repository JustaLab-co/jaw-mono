import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { keepLease, leaseHeld, sessionLeaseEnd } from '@/connections/session-lease';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb, type Tx } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import { countOpenLinks, FULL, linkLive, MAX_OPEN_PER_ACCOUNT, withLinkSlot } from '@/owner-calls/cap';

export type PermissionRequestRow = typeof permissionRequests.$inferSelect;

export interface Outcome {
  state: Exclude<PermissionRequestRow['state'], 'awaiting_owner'>;
  code?: string;
  permissionId?: string;
  signature?: string;
}

const dbNow = sql`statement_timestamp()`;
const awaiting = eq(permissionRequests.state, 'awaiting_owner');

const ofConnection = (t: Tenant, req: LinkRequest) =>
  and(eq(permissionRequests.method, req.method), eq(permissionRequests.connectionId, t.connectionId));

const sameSign = (t: Tenant, idempotencyKey: string) =>
  and(
    eq(permissionRequests.method, 'sign'),
    eq(permissionRequests.connectionId, t.connectionId),
    eq(permissionRequests.idempotencyKey, idempotencyKey)
  );

const blockers = (t: Tenant, req: LinkRequest) =>
  req.method === 'revoke'
    ? or(
        ofConnection(t, req),
        and(
          eq(permissionRequests.method, 'revoke'),
          sql`lower(${permissionRequests.permissionId}) = ${req.permissionId.toLowerCase()}`
        )
      )
    : ofConnection(t, req);

async function update(where: SQL | undefined, set: PgUpdateSetSource<typeof permissionRequests>, db: Tx = getDb()) {
  const [row] = await db
    .update(permissionRequests)
    .set({ ...set, updatedAt: sql`statement_timestamp()` })
    .where(where)
    .returning();
  return row;
}

const ASKED = 'asked';
const lapsedBeforeAsk = and(
  or(isNull(permissionRequests.sessionUntil), lte(permissionRequests.sessionUntil, dbNow)),
  sql`${permissionRequests.code} is distinct from ${ASKED}`
);

const closeDead = (same: SQL | undefined, db: Tx = getDb()) =>
  update(
    and(same, awaiting, or(lte(permissionRequests.approveBy, dbNow), lapsedBeforeAsk)),
    { state: 'expired', code: sql`case when ${permissionRequests.approveBy} > ${dbNow} then 'session_lost' end` },
    db
  );

async function findHeld(same: SQL | undefined): Promise<Held | undefined> {
  const asked = and(awaiting, gt(permissionRequests.approveBy, dbNow), eq(permissionRequests.code, ASKED));
  const [row] = await getDb()
    .select()
    .from(permissionRequests)
    .where(and(same, or(linkLive, asked)));
  if (!row) return undefined;
  return leaseHeld(row.sessionUntil) ? { waiting: row } : { askedLost: row };
}

const ofRow = (row: PermissionRequestRow) => and(eq(permissionRequests.id, row.id), awaiting);

function outcomeOf(err: unknown, row: PermissionRequestRow): Outcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === USER_REJECTED) return { state: 'owner_declined' };
  if (typeof code === 'number') return { state: 'failed', code: `wallet_error:${code}` };
  if (Date.now() >= row.approveBy.getTime()) return { state: 'expired' };
  return { state: 'failed', code: 'unexpected' };
}

export async function currentSign(t: Tenant, idempotencyKey: string): Promise<PermissionRequestRow | undefined> {
  const same = sameSign(t, idempotencyKey);
  await closeDead(same);
  const [row] = await getDb().select().from(permissionRequests).where(same);
  return row;
}

async function settle(row: PermissionRequestRow, { state, code, permissionId, signature }: Outcome) {
  // A row given up on while its session still ran takes the answer that came after all.
  const lost = and(eq(permissionRequests.state, 'expired'), eq(permissionRequests.code, 'session_lost'));
  await update(and(eq(permissionRequests.id, row.id), or(awaiting, lost)), {
    state,
    code: code ?? null,
    sessionUntil: null,
    ...(permissionId && { permissionId }),
    ...(signature && { signature }),
  });
}

type Held = { waiting: PermissionRequestRow } | { askedLost: PermissionRequestRow };

export type Opened = { opened: PermissionRequestRow } | Held | 'account_busy' | 'wallet_busy';

/** Marks the row asked once, while its lease still holds. False when another link may have taken over. */
export type Claim = () => Promise<boolean>;

export type LinkRequest = {
  chainId: number;
  approveBy: Date;
  work: (ask: Ask, claim: Claim) => Promise<Outcome>;
} & (
  | { method: 'grant' }
  | { method: 'revoke'; permissionId: string }
  | { method: 'sign'; idempotencyKey: string; requestHash: string; signKind: 'message' | 'typedData' }
);

export async function openLink(t: Tenant, req: LinkRequest, openWallet: OpenWallet): Promise<Opened> {
  const blocking = blockers(t, req);
  const existing = async (): Promise<Held | undefined> => {
    const stored = req.method === 'sign' ? await currentSign(t, req.idempotencyKey) : undefined;
    return stored ? { waiting: stored } : findHeld(blocking);
  };
  const held = await existing();
  if (held) return held;
  if ((await countOpenLinks(t.account)) >= MAX_OPEN_PER_ACCOUNT) return 'account_busy';
  const { approveBy } = req;
  let wallet: Wallet;
  try {
    wallet = await openWallet(req.chainId, approveBy, t);
  } catch (err) {
    if (err instanceof WalletBusy) return 'wallet_busy';
    throw err;
  }
  let row: PermissionRequestRow | undefined | typeof FULL;
  try {
    row = await withLinkSlot(t.account, undefined, async (tx) => {
      await closeDead(blocking, tx);
      const [inserted] = await tx
        .insert(permissionRequests)
        .values({
          id: `pr_${randomBytes(16).toString('base64url')}`,
          connectionId: t.connectionId,
          method: req.method,
          chainId: req.chainId,
          account: t.account,
          permissionId: req.method === 'revoke' ? req.permissionId : null,
          ...(req.method === 'sign' && {
            idempotencyKey: req.idempotencyKey,
            requestHash: req.requestHash,
            signKind: req.signKind,
          }),
          walletUrl: wallet.url,
          approveBy,
          sessionUntil: sessionLeaseEnd,
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    });
  } finally {
    if (!row || row === FULL) wallet.close();
  }
  if (row === FULL || !row) return (await existing()) ?? (row === FULL ? 'account_busy' : 'wallet_busy');
  follow(row, wallet, req.work);
  return { opened: row };
}

function follow(row: PermissionRequestRow, wallet: Wallet, work: LinkRequest['work']) {
  const stop = keepLease(
    async () => {
      const held = await update(ofRow(row), { sessionUntil: sessionLeaseEnd });
      if (!held) wallet.close();
      return held;
    },
    () => update(ofRow(row), { sessionUntil: null })
  );
  const claim: Claim = async () => {
    const leased = and(ofRow(row), gt(permissionRequests.sessionUntil, dbNow), isNull(permissionRequests.code));
    return (await update(leased, { code: ASKED })) !== undefined;
  };
  const ended = (err: unknown) => {
    log('warn', { msg: 'permission request ended', permissionRequestId: row.id, error: errorLabel(err) });
    return outcomeOf(err, row);
  };
  let answered = false;
  void wallet
    .run(async (ask) => {
      const outcome = await work(ask, claim).catch(ended);
      answered = true;
      await settle(row, outcome);
    })
    .catch((err: unknown) => {
      if (answered) throw err;
      return settle(row, ended(err));
    })
    .catch((err: unknown) =>
      log('warn', { msg: 'permission request not settled', permissionRequestId: row.id, error: errorLabel(err) })
    )
    .finally(stop);
}
