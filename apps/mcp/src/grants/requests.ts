import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Address } from 'viem';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { PageGone, resumeWallet, WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { findActive, type ConnectionRow } from '@/connections/rows';
import type { ConnectionScope } from '@/connections/scopes';
import { openResume, sealResume, type RelayResume } from '@/connections/seal';
import { heldSince, keepLease, leaseHeld, sessionLeaseEnd } from '@/connections/session-lease';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb, type Tx } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { canonical } from '@/lib/canonical';
import { errorLabel, log } from '@/lib/edge';
import { awaitsResume, countOpenLinks, FULL, linkLive, MAX_OPEN_PER_ACCOUNT, withLinkSlot } from '@/owner-calls/cap';

export type PermissionRequestRow = typeof permissionRequests.$inferSelect;

export interface Outcome {
  state: Exclude<PermissionRequestRow['state'], 'awaiting_owner'>;
  code?: string;
  permissionId?: string;
  signature?: string;
}

const dbNow = sql`statement_timestamp()`;
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

async function findHeld(t: Tenant, req: LinkKind): Promise<Held | undefined> {
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

const heldBy = (row: PermissionRequestRow) =>
  and(eq(permissionRequests.id, row.id), eq(permissionRequests.leaseHolder, row.leaseHolder!));

const pageGone = (asked: boolean): Outcome => ({ state: 'expired', code: asked ? LINK_LOST : 'session_lost' });

const NOT_THE_REQUEST = -32600;

function outcomeOf(err: unknown, row: PermissionRequestRow, asked: boolean, resumed: boolean): Outcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === USER_REJECTED) return { state: 'owner_declined' };
  if (err instanceof PageGone || (resumed && code === NOT_THE_REQUEST)) return pageGone(asked);
  if (typeof code === 'number') return { state: 'failed', code: `wallet_error:${code}` };
  if (Date.now() >= row.approveBy.getTime()) return { state: 'expired' };
  if (asked) return { state: 'expired', code: LINK_LOST };
  return { state: 'failed', code: 'unexpected' };
}

async function readSign(same: SQL | undefined): Promise<PermissionRequestRow | undefined> {
  await closeDead(same);
  const [row] = await getDb().select().from(permissionRequests).where(same);
  return row;
}

export const currentSign = (t: Tenant, idempotencyKey: string) => readSign(sameSign(t, idempotencyKey));

export const signById = (t: Tenant, id: string) =>
  readSign(
    and(
      eq(permissionRequests.method, 'sign'),
      eq(permissionRequests.connectionId, t.connectionId),
      eq(permissionRequests.id, id)
    )
  );

// An answer the owner gave still stands on a row that ended while its process could not renew.
const answered = (state: Outcome['state']) => state === 'approved' || state === 'owner_declined';

async function settle(row: PermissionRequestRow, { state, code, permissionId, signature }: Outcome) {
  const open = answered(state) ? or(awaiting, eq(permissionRequests.state, 'expired')) : awaiting;
  await update(and(heldBy(row), open), {
    state,
    code: code ?? null,
    sessionUntil: null,
    relay: null,
    ...(permissionId && { permissionId }),
    ...(signature && { signature }),
  });
}

type Held = { waiting: PermissionRequestRow };

export type Opened = { opened: PermissionRequestRow } | Held | 'account_busy' | 'wallet_busy';

/** Marks the row asked once, while its lease still holds. False when another link may have taken over. */
export type Claim = () => Promise<boolean>;

export type Work = (ask: Ask, claim: Claim) => Promise<Outcome>;

export type Rebuild = (t: Tenant, payload: unknown) => Work;
export type Rebuilds = Partial<Record<PermissionRequestRow['method'], Rebuild>>;

type LinkKind =
  | { method: 'grant' }
  | { method: 'revoke'; permissionId: string }
  | { method: 'sign'; idempotencyKey: string; requestHash: string; signKind: 'message' | 'typedData' };

export type LinkRequest = {
  chainId: number;
  approveBy: Date;
  payload: unknown;
  work: Work;
} & LinkKind;

/** Whether a revoke of this permission already waits, so asking again opens nothing. */
export const revokeHeld = async (t: Tenant, permissionId: string) =>
  (await findHeld(t, { method: 'revoke', permissionId }))?.waiting.permissionId?.toLowerCase() ===
  permissionId.toLowerCase();

export async function openLink(t: Tenant, req: LinkRequest, openWallet: OpenWallet): Promise<Opened> {
  const existing = async (): Promise<Held | undefined> => {
    const stored = req.method === 'sign' ? await currentSign(t, req.idempotencyKey) : undefined;
    return stored ? { waiting: stored } : findHeld(t, req);
  };
  const held = await existing();
  if (held) return held;
  // A request racing this one may have stored its link since the check above: answer it rather than refuse.
  const refuse = async (code: 'account_busy' | 'wallet_busy') => (await existing()) ?? code;
  if ((await countOpenLinks(t.account)) >= MAX_OPEN_PER_ACCOUNT) return refuse('account_busy');
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
          leaseHolder: newHolder(),
          payload: canonical(req.payload),
          namesLost: lost?.id,
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    });
  } finally {
    if (!row || row === FULL) wallet.close();
  }
  if (row === FULL || !row) return refuse(row === FULL ? 'account_busy' : 'wallet_busy');
  follow(row, wallet, req.work);
  return { opened: row };
}

/** A saved relay session whose process stopped renewing: the server is rejoining the owner's open link. */
export const reconnecting = (row: PermissionRequestRow) => row.relay !== null && !leaseHeld(row.sessionUntil);
export const RECONNECTING = " This server is reconnecting to the owner's open link.";

const newHolder = () => randomBytes(16).toString('base64url');

function follow(row: PermissionRequestRow, wallet: Wallet, work: Work, resumed = false) {
  const mine = and(heldBy(row), awaiting);
  const stop = keepLease(
    async () => {
      const held = await update(mine, { sessionUntil: sessionLeaseEnd });
      if (!held) wallet.close();
      return held;
    },
    () => update(mine, { sessionUntil: null })
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
    return outcomeOf(err, row, asked, resumed);
  };
  const joined = (resume: RelayResume) => update(mine, { relay: sealResume(config().ring, resume, row.id) });
  let answered = false;
  void wallet
    .run(async (ask) => {
      const outcome = await work(ask, claim).catch(ended);
      answered = true;
      await settle(row, outcome);
    }, joined)
    .catch((err: unknown) => {
      if (answered) throw err;
      return settle(row, ended(err));
    })
    .catch((err: unknown) =>
      log('warn', { msg: 'permission request not settled', permissionRequestId: row.id, error: errorLabel(err) })
    )
    .finally(stop);
}

const RESUMES_PER_TICK = 10;

const resumable = and(awaiting, gt(permissionRequests.approveBy, dbNow), lapsed, awaitsResume);

export async function resumeOpen(rebuilds: Rebuilds): Promise<Promise<void>[]> {
  try {
    const methods = Object.keys(rebuilds) as PermissionRequestRow['method'][];
    const rows = await getDb()
      .select()
      .from(permissionRequests)
      .where(and(resumable, inArray(permissionRequests.method, methods)))
      .orderBy(asc(permissionRequests.updatedAt))
      .limit(RESUMES_PER_TICK);
    return rows.map((row) => resumeRequest(row, rebuilds[row.method]!));
  } catch (err) {
    log('warn', { msg: 'permission requests not resumed', error: errorLabel(err) });
    return [];
  }
}

export const resumeRequest = (row: PermissionRequestRow, rebuild: Rebuild): Promise<void> =>
  resume(row, rebuild).catch((err: unknown) =>
    log('warn', { msg: 'permission request not resumed', permissionRequestId: row.id, error: errorLabel(err) })
  );

const parsed = (payload: string | null): unknown => {
  try {
    return JSON.parse(payload ?? '');
  } catch {
    return undefined;
  }
};

async function resume(found: PermissionRequestRow, rebuild: Rebuild) {
  const row = await update(and(eq(permissionRequests.id, found.id), resumable), {
    leaseHolder: newHolder(),
    sessionUntil: sessionLeaseEnd,
  });
  if (!row) return;
  const connection = await findActive(row.connectionId);
  if (!connection) return settle(row, { state: 'failed', code: 'connection_ended' });
  const relay = openResume(config().ring, row.relay!, row.id);
  const payload = parsed(row.payload);
  if (!relay || payload === undefined) return settle(row, { state: 'expired', code: LINK_LOST });
  const t = tokenlessTenant(connection);
  const work = rebuild(t, payload);
  let wallet: Wallet | undefined;
  try {
    wallet = await resumeWallet(relay, row.approveBy, t);
  } catch (err) {
    await update(heldBy(row), { sessionUntil: null });
    if (err instanceof WalletBusy) return;
    throw err;
  }
  if (!wallet) return settle(row, pageGone(row.code === ASKED));
  follow(row, wallet, work, true);
}

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
