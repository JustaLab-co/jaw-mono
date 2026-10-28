import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { PageGone, WalletBusy, WalletRefused, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { resumeRow, resumeTick, waitingIn, type Rejoin } from '@/connections/resume';
import { sealResume, type RelayResume } from '@/connections/seal';
import { heldSince, keepLease, leaseHeld, sessionLeaseEnd } from '@/connections/session-lease';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb, type Tx } from '@/db/client';
import { leasedRows } from '@/db/leased';
import { permissionRequests } from '@/db/schema';
import { canonical } from '@/lib/canonical';
import { errorLabel, log } from '@/lib/edge';
import { randomToken } from '@/lib/token';
import {
  countAddFundsLinks,
  countOpenLinks,
  FULL,
  linkLive,
  MAX_ADD_FUNDS_PER_ACCOUNT,
  MAX_OPEN_PER_ACCOUNT,
  withLinkSlot,
  type LinkBound,
} from '@/owner-calls/cap';

export type PermissionRequestRow = typeof permissionRequests.$inferSelect;

export interface Outcome {
  state: Exclude<PermissionRequestRow['state'], 'awaiting_owner'>;
  code?: string;
  permissionId?: string;
  signature?: string;
}

const dbNow = sql`statement_timestamp()`;
const leased = leasedRows<PermissionRequestRow>(permissionRequests);
const awaiting = eq(permissionRequests.state, 'awaiting_owner');

const ofConnection = (t: Tenant, req: LinkKind) =>
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
const lapsed = or(isNull(permissionRequests.sessionUntil), lte(permissionRequests.sessionUntil, heldSince));
const endCode = sql`case when ${permissionRequests.approveBy} <= ${dbNow} then null
  when ${permissionRequests.code} = ${ASKED} then ${LINK_LOST} else 'session_lost' end`;

const pastWindow = lte(permissionRequests.approveBy, dbNow);
const abandoned = and(lapsed, isNull(permissionRequests.relay));

const closeDead = (same: SQL | undefined, db: Tx = getDb()) =>
  update(and(same, awaiting, or(pastWindow, abandoned)), { state: 'expired', code: endCode, relay: null }, db);

const askedInWindow = and(awaiting, gt(permissionRequests.approveBy, dbNow), eq(permissionRequests.code, ASKED));
// Other connections wait on an asked revoke until its window ends, since the owner may still revoke there.
const notAskedRevoke = or(
  ne(permissionRequests.method, 'revoke'),
  sql`${permissionRequests.code} is distinct from ${ASKED}`,
  pastWindow
);

export const SIGN_KEPT_DAYS = 7;

export async function closeLapsedLinks(): Promise<number> {
  const ended = await getDb()
    .update(permissionRequests)
    .set({ state: 'expired', code: endCode, relay: null, updatedAt: dbNow })
    .where(and(awaiting, or(abandoned, and(lapsed, pastWindow)), notAskedRevoke))
    .returning({ id: permissionRequests.id });
  return ended.length;
}

async function findHeld(t: Tenant, req: LinkKind, rebuild?: Rebuild): Promise<Held | undefined> {
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
  return row && { waiting: rebuild ? rejoinIfWaiting(row, rebuild) : row };
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

/**
 * A link this connection lost after the owner was asked, named on the next new link so the owner leaves it alone.
 * The owner hears no link: a dead one is nothing they can use. The agent gets it, and the key when the link had one.
 */
export const lostLinkSaid = (lost: PermissionRequestRow, what: 'signing' | 'permission' | 'revoke') => ({
  say: `An earlier ${what} link stopped working, so an answer given there may never arrive. If it is still open, do not approve it there.`,
  next: `The earlier link ${lost.walletUrl}${lost.idempotencyKey ? ` under idempotencyKey ${lost.idempotencyKey}` : ''} answers link_lost.`,
});

const heldBy = (row: PermissionRequestRow) =>
  and(eq(permissionRequests.id, row.id), eq(permissionRequests.leaseHolder, row.leaseHolder!));

const pageGone = (asked: boolean): Outcome => ({ state: 'expired', code: asked ? LINK_LOST : 'session_lost' });

function outcomeOf(err: unknown, row: PermissionRequestRow, asked: boolean): Outcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === USER_REJECTED) return { state: 'owner_declined' };
  if (err instanceof PageGone) return pageGone(asked);
  if (typeof code === 'number') return { state: 'failed', code: `wallet_error:${code}` };
  if (err instanceof WalletRefused) return { state: 'failed', code: 'wallet_error:unknown' };
  if (Date.now() >= row.approveBy.getTime()) return { state: 'expired' };
  if (asked) return { state: 'expired', code: LINK_LOST };
  return { state: 'failed', code: 'unexpected' };
}

/** Reading a request that waits for its resume starts that resume. */
function rejoinIfWaiting<R extends PermissionRequestRow | undefined>(row: R, rebuild: Rebuild): R {
  if (row?.relay) void resumeRequest(row, rebuild);
  return row;
}

async function readClosed(same: SQL | undefined): Promise<PermissionRequestRow | undefined> {
  await closeDead(same);
  const [row] = await getDb().select().from(permissionRequests).where(same);
  return row;
}

export const currentSign = async (t: Tenant, idempotencyKey: string, rebuild: Rebuild) =>
  rejoinIfWaiting(await readClosed(sameSign(t, idempotencyKey)), rebuild);

export const requestById = (t: Tenant, method: 'sign' | 'grant', id: string) =>
  readClosed(
    and(
      eq(permissionRequests.method, method),
      eq(permissionRequests.connectionId, t.connectionId),
      eq(permissionRequests.id, id)
    )
  );

// An answer the owner gave still stands on a row that ended while its process could not renew.
const answered = (state: Outcome['state']) => state === 'approved' || state === 'owner_declined';

async function settle(row: PermissionRequestRow, { state, code, permissionId, signature }: Outcome) {
  // The owner's answer is recorded by whichever run heard it; anything else only by the run that holds the row.
  const mine = answered(state)
    ? and(eq(permissionRequests.id, row.id), or(awaiting, eq(permissionRequests.state, 'expired')))
    : and(heldBy(row), awaiting);
  await update(mine, {
    state,
    code: code ?? null,
    sessionUntil: null,
    relay: null,
    ...(permissionId && { permissionId }),
    ...(signature && { signature }),
  });
}

type Held = { waiting: PermissionRequestRow };

export type Opened = { opened: PermissionRequestRow } | Held | 'account_busy' | 'add_funds_busy' | 'wallet_busy';

/** Marks the row asked once, while its lease still holds. False when another link may have taken over. */
export type Claim = () => Promise<boolean>;

export type Work = (ask: Ask, claim: Claim) => Promise<Outcome>;

/** Undefined when the stored payload is not one this method sent. */
export type Rebuild = (t: Tenant, payload: unknown) => Work | undefined;
export type Rebuilds = Partial<Record<PermissionRequestRow['method'], Rebuild>>;

type LinkKind =
  | { method: 'grant' }
  | { method: 'add_funds' }
  | { method: 'revoke'; permissionId: string }
  | { method: 'sign'; idempotencyKey: string; requestHash: string; signKind: 'message' | 'typedData' };

export type LinkRequest = {
  chainId: number;
  approveBy: Date;
  payload: unknown;
  rebuild: Rebuild;
  /** Runs once the outcome is stored, so slow follow-up work never holds the row open. */
  settled?: (outcome: Outcome) => Promise<void>;
} & LinkKind;

/** Whether a revoke of this permission already waits, so asking again opens nothing. */
export const revokeHeld = async (t: Tenant, permissionId: string) =>
  (await findHeld(t, { method: 'revoke', permissionId }))?.waiting.permissionId?.toLowerCase() ===
  permissionId.toLowerCase();

/** The chain of the Add Funds link this connection already waits on, if any, so asking again opens nothing. */
export const addFundsHeldOn = async (t: Tenant) => (await findHeld(t, { method: 'add_funds' }))?.waiting.chainId;

/** Add Funds links stay out of the account's open-link cap, so they are never account_busy, and have a bound of their own. */
export function openLink(
  t: Tenant,
  req: LinkRequest & { method: 'add_funds' },
  openWallet: OpenWallet
): Promise<Exclude<Opened, 'account_busy'>>;
export function openLink(
  t: Tenant,
  req: LinkRequest & { method: Exclude<LinkKind['method'], 'add_funds'> },
  openWallet: OpenWallet
): Promise<Exclude<Opened, 'add_funds_busy'>>;
export async function openLink(t: Tenant, req: LinkRequest, openWallet: OpenWallet): Promise<Opened> {
  const work = req.rebuild(t, req.payload);
  if (!work) throw new Error(`the ${req.method} request does not match what a resume rebuilds`);
  const existing = async (): Promise<Held | undefined> => {
    const stored = req.method === 'sign' ? await currentSign(t, req.idempotencyKey, req.rebuild) : undefined;
    return stored ? { waiting: stored } : findHeld(t, req, req.rebuild);
  };
  const held = await existing();
  if (held) return held;
  // A request racing this one may have stored its link since the check above: answer it rather than refuse.
  const refuse = async (code: 'account_busy' | 'add_funds_busy' | 'wallet_busy') => (await existing()) ?? code;
  const addFunds = req.method === 'add_funds';
  const bound: LinkBound = addFunds
    ? { max: MAX_ADD_FUNDS_PER_ACCOUNT, count: countAddFundsLinks }
    : { max: MAX_OPEN_PER_ACCOUNT, count: countOpenLinks };
  const full = addFunds ? 'add_funds_busy' : 'account_busy';
  if ((await bound.count(t.account)) >= bound.max) return refuse(full);
  const { approveBy } = req;
  let wallet: Wallet;
  try {
    wallet = await openWallet(req.chainId, approveBy, t);
  } catch (err) {
    if (err instanceof WalletBusy) return refuse('wallet_busy');
    throw err;
  }
  let row: PermissionRequestRow | undefined | typeof FULL;
  try {
    const write = async (tx: Tx) => {
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
          leaseHolder: randomToken(),
          payload: canonical(req.payload),
          namesLost: lost?.id,
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    };
    row = await withLinkSlot(t.account, undefined, write, bound);
  } finally {
    if (!row || row === FULL) wallet.close();
  }
  if (row === FULL || !row) return refuse(row === FULL ? full : 'wallet_busy');
  follow(row, wallet, work, false, req.settled);
  return { opened: row };
}

/** A saved relay session whose process stopped renewing: the server is rejoining the owner's open link. */
export const reconnecting = (row: PermissionRequestRow) => row.relay !== null && !leaseHeld(row.sessionUntil);
export const RECONNECTING = " This server is reconnecting to the owner's open link.";

/** Work the server still runs after it answered, such as what a settled link triggers. */
export const followUps = new Set<Promise<void>>();

function follow(
  row: PermissionRequestRow,
  wallet: Wallet,
  work: Work,
  resumed = false,
  settled?: LinkRequest['settled']
) {
  const mine = and(heldBy(row), awaiting);
  const stop = keepLease(
    async () => {
      const held = await leased.renew(row);
      if (!held) wallet.close();
      return held;
    },
    // A resumed run that ends without settling counts as a failed rejoin, so the backoff and the try cap apply.
    () => (resumed ? leased.miss(row) : leased.release(row))
  );
  let asked = row.code === ASKED;
  const claim: Claim = async () => {
    const leased = and(
      mine,
      gt(permissionRequests.sessionUntil, heldSince),
      or(isNull(permissionRequests.code), eq(permissionRequests.code, ASKED))
    );
    asked = (await update(leased, { code: ASKED })) !== undefined;
    return asked;
  };
  const ended = (err: unknown) => {
    log('warn', { msg: 'permission request ended', permissionRequestId: row.id, error: errorLabel(err) });
    return outcomeOf(err, row, asked);
  };
  let rejoinable = row.relay !== null;
  const joined = async (resume: RelayResume) => {
    if (await leased.saveRelay(row, sealResume(config().ring, resume, row.id))) rejoinable = true;
  };
  // A run that fails on the way, not on an answer, leaves the row to the next resume.
  const onTheWay = (err: unknown) =>
    rejoinable && !(err instanceof PageGone) && typeof (err as { code?: unknown } | undefined)?.code !== 'number';
  let answered: Outcome | undefined;
  // Counted from the moment the outcome is stored, so nothing waiting on followUps misses it.
  let after: PromiseWithResolvers<void> | undefined;
  void wallet
    .run(async (ask) => {
      const outcome = await work(ask, claim).catch((err: unknown) => {
        if (onTheWay(err)) throw err;
        return ended(err);
      });
      answered = outcome;
      await settle(row, outcome);
      if (settled) {
        after = Promise.withResolvers();
        followUps.add(after.promise);
      }
    }, joined)
    .catch((err: unknown) => {
      if (answered) throw err;
      if (onTheWay(err))
        return log('warn', {
          msg: 'permission request left to resume',
          permissionRequestId: row.id,
          error: errorLabel(err),
        });
      return settle(row, ended(err));
    })
    .catch((err: unknown) =>
      log('warn', { msg: 'permission request not settled', permissionRequestId: row.id, error: errorLabel(err) })
    )
    .finally(stop)
    // After the wallet session ends, so the owner's page closes and its relay slot frees at once.
    .then(() => answered && settled?.(answered))
    .catch((err: unknown) =>
      log('warn', { msg: 'permission request follow-up failed', permissionRequestId: row.id, error: errorLabel(err) })
    )
    .finally(() => {
      if (!after) return;
      followUps.delete(after.promise);
      after.resolve();
    });
}

const parsed = (payload: string | null): unknown => {
  try {
    return JSON.parse(payload ?? '');
  } catch {
    return undefined;
  }
};

const rejoinWith = (rebuildOf: (row: PermissionRequestRow) => Rebuild): Rejoin<PermissionRequestRow> => ({
  idField: 'permissionRequestId',
  take: leased.take,
  release: leased.release,
  failed: leased.failed,
  lost: (row) => settle(row, pageGone(row.code === ASKED)),
  connectionEnded: (row) => settle(row, { state: 'failed', code: 'connection_ended' }),
  start: (row, t) => {
    const payload = parsed(row.payload);
    if (payload === undefined) return undefined;
    const work = rebuildOf(row)(t, payload);
    return work && ((wallet) => follow(row, wallet, work, true));
  },
});

export const waitingRequests = (rebuilds: Rebuilds) =>
  waitingIn(
    (limit) =>
      leased.toResume(
        limit,
        inArray(permissionRequests.method, Object.keys(rebuilds) as PermissionRequestRow['method'][])
      ),
    rejoinWith((row) => rebuilds[row.method]!)
  );

export const resumeOpen = (rebuilds: Rebuilds) => resumeTick([waitingRequests(rebuilds)]);

export const resumeRequest = (row: PermissionRequestRow, rebuild: Rebuild) =>
  resumeRow(
    row,
    rejoinWith(() => rebuild)
  );
