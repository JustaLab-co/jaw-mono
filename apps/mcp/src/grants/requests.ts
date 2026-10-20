import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Tenant } from '@/connections/auth';
import { WalletBusy, WalletRefused, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { keepLease, sessionLeaseEnd } from '@/connections/session-lease';
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

const othersRevoke = (t: Tenant, permissionId: string) =>
  and(
    eq(permissionRequests.method, 'revoke'),
    sql`lower(${permissionRequests.permissionId}) = ${permissionId.toLowerCase()}`,
    ne(permissionRequests.connectionId, t.connectionId)
  );

async function update(where: SQL | undefined, set: PgUpdateSetSource<typeof permissionRequests>, db: Tx = getDb()) {
  const [row] = await db
    .update(permissionRequests)
    .set({ ...set, updatedAt: sql`statement_timestamp()` })
    .where(where)
    .returning();
  return row;
}

const ASKED = 'asked';
export const LINK_LOST = 'link_lost';
const lapsed = or(isNull(permissionRequests.sessionUntil), lte(permissionRequests.sessionUntil, dbNow));
const endCode = sql`case when ${permissionRequests.approveBy} <= ${dbNow} then null
  when ${permissionRequests.code} = ${ASKED} then ${LINK_LOST} else 'session_lost' end`;

const pastWindow = lte(permissionRequests.approveBy, dbNow);

const closeDead = (same: SQL | undefined, db: Tx = getDb()) =>
  update(and(same, awaiting, or(pastWindow, lapsed)), { state: 'expired', code: endCode }, db);

async function findHeld(t: Tenant, req: LinkRequest): Promise<Held | undefined> {
  const askedInWindow = and(awaiting, gt(permissionRequests.approveBy, dbNow), eq(permissionRequests.code, ASKED));
  const [row] = await getDb()
    .select()
    .from(permissionRequests)
    .where(
      or(
        and(ofConnection(t, req), linkLive),
        req.method === 'revoke' ? and(othersRevoke(t, req.permissionId), or(linkLive, askedInWindow)) : undefined
      )
    )
    .orderBy(desc(eq(permissionRequests.connectionId, t.connectionId)))
    .limit(1);
  return row && { waiting: row };
}

const unnamed = sql`not exists (select 1 from ${permissionRequests} named where named.names_lost = ${permissionRequests.id})`;

async function lostLink(t: Tenant, req: LinkRequest, db: Tx) {
  const [row] = await db
    .select()
    .from(permissionRequests)
    .where(
      and(
        ofConnection(t, req),
        eq(permissionRequests.state, 'expired'),
        eq(permissionRequests.code, LINK_LOST),
        unnamed,
        gt(permissionRequests.approveBy, dbNow)
      )
    )
    .orderBy(desc(permissionRequests.updatedAt))
    .limit(1);
  return row;
}

export async function lostBefore(row: PermissionRequestRow): Promise<PermissionRequestRow | undefined> {
  if (!row.namesLost || row.state !== 'awaiting_owner') return undefined;
  const [lost] = await getDb()
    .select()
    .from(permissionRequests)
    .where(
      and(
        eq(permissionRequests.id, row.namesLost),
        eq(permissionRequests.code, LINK_LOST),
        gt(permissionRequests.approveBy, dbNow)
      )
    );
  return lost;
}

export const lostPreamble = (lost: PermissionRequestRow, what: string) =>
  `link_lost: this server lost the session of the earlier ${what} link ${lost.walletUrl} after asking the owner, so it may never hear an answer given there. `;

const ofRow = (row: PermissionRequestRow) => and(eq(permissionRequests.id, row.id), awaiting);

function outcomeOf(err: unknown, row: PermissionRequestRow, asked: boolean): Outcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === USER_REJECTED) return { state: 'owner_declined' };
  if (typeof code === 'number') return { state: 'failed', code: `wallet_error:${code}` };
  if (err instanceof WalletRefused) return { state: 'failed', code: 'wallet_error:unknown' };
  if (Date.now() >= row.approveBy.getTime()) return { state: 'expired' };
  if (asked) return { state: 'expired', code: LINK_LOST };
  return { state: 'failed', code: 'unexpected' };
}

export async function currentSign(t: Tenant, idempotencyKey: string): Promise<PermissionRequestRow | undefined> {
  const same = sameSign(t, idempotencyKey);
  await closeDead(same);
  const [row] = await getDb().select().from(permissionRequests).where(same);
  return row;
}

const givenUp = and(
  eq(permissionRequests.state, 'expired'),
  inArray(permissionRequests.code, ['session_lost', LINK_LOST])
);

async function settle(row: PermissionRequestRow, { state, code, permissionId, signature }: Outcome) {
  await update(and(eq(permissionRequests.id, row.id), or(awaiting, givenUp)), {
    state,
    code: code ?? null,
    sessionUntil: null,
    ...(permissionId && { permissionId }),
    ...(signature && { signature }),
  });
}

type Held = { waiting: PermissionRequestRow };

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
  const existing = async (): Promise<Held | undefined> => {
    const stored = req.method === 'sign' ? await currentSign(t, req.idempotencyKey) : undefined;
    return stored ? { waiting: stored } : findHeld(t, req);
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
      const theirs = req.method === 'revoke' ? othersRevoke(t, req.permissionId) : undefined;
      await closeDead(
        or(ofConnection(t, req), theirs && and(theirs, or(pastWindow, isNull(permissionRequests.code)))),
        tx
      );
      const lost = await lostLink(t, req, tx);
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
          namesLost: lost?.id,
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
  let asked = false;
  const claim: Claim = async () => {
    const leased = and(ofRow(row), gt(permissionRequests.sessionUntil, dbNow), isNull(permissionRequests.code));
    asked = (await update(leased, { code: ASKED })) !== undefined;
    return asked;
  };
  const ended = (err: unknown) => {
    log('warn', { msg: 'permission request ended', permissionRequestId: row.id, error: errorLabel(err) });
    return outcomeOf(err, row, asked);
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
