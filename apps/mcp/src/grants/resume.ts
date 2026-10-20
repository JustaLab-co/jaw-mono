import type { GrantedPermission, PermissionState } from '@jaw.id/agent';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { isAddressEqual, isHex, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Tenant } from '@/connections/auth';
import type { Ask } from '@/connections/relay';
import { isLive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants, permissionRequests } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import { checkGranted, readOnChain, recordGrant, type GrantRequest, type ReadPermission } from './permission';
import { resumeOpen, type Claim, type Outcome, type Rebuild } from './requests';
import type { GrantKind } from './store';

export type SignRequest = { type: '0x45'; data: { message: string } } | { type: '0x01'; data: Record<string, unknown> };

export interface RevokeTarget {
  permissionId: Hex;
  chainId: number;
  permission: GrantedPermission;
  connectionId: string | null;
}

export interface RevokeReads {
  readPermission: ReadPermission;
  rereadMs: number;
}

export const REVOKE_READS: RevokeReads = { readPermission: readOnChain, rereadMs: 2_500 };

const SETTLE_READS = 6;

export const sameId = (id: string) => sql`lower(${grants.permissionId}) = ${id.toLowerCase()}`;

const hasAccount = (accounts: unknown, account: string) =>
  Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase());

export type SignPayload = { chainId: number; request: SignRequest };

export const signWork: Rebuild = (t, payload) => (ask, claim) => approveSign(ask, claim, t, payload as SignPayload);

async function approveSign(ask: Ask, claim: Claim, t: Tenant, { chainId, request }: SignPayload): Promise<Outcome> {
  if (!hasAccount(await ask('eth_requestAccounts', []), t.account)) {
    return { state: 'owner_declined', code: 'wrong_account' };
  }
  if (!(await claim())) return { state: 'expired', code: 'session_lost' };
  const signed = await ask('wallet_sign', [{ address: t.account, chainId: toHex(chainId), request }]);
  const signature = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .safeParse(signed).data;
  return signature ? { state: 'approved', signature } : { state: 'failed', code: 'wallet_answer_unreadable' };
}

export type GrantPayload = { kind: GrantKind; grant: GrantRequest };

export const grantWork =
  (read: ReadPermission): Rebuild =>
  (t, payload) =>
  (walletAsk, claim) =>
    askGrant(t, payload as GrantPayload, walletAsk, claim, read);

async function askGrant(
  t: Tenant,
  ask: GrantPayload,
  walletAsk: Ask,
  claim: Claim,
  read: ReadPermission
): Promise<Outcome> {
  if (!(await claim())) return { state: 'expired', code: 'session_lost' };
  const answer = await walletAsk('wallet_grantPermissions', [ask.grant]);
  const answered = (answer as { permissionId?: unknown } | null)?.permissionId;
  const permissionId = isHex(answered) ? answered : undefined;
  const checked = await checkGranted(t.chainId, ask.grant, ask.kind, answer, read);
  if (typeof checked === 'string') return { state: 'failed', code: checked, permissionId };
  if (!isAddressEqual(checked.account as Address, t.account)) {
    return { state: 'failed', code: 'wrong_account', permissionId };
  }
  try {
    const recorded = await getDb().transaction(async (tx) => {
      const [live] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, t.connectionId), isLive()))
        .for('update');
      if (live) await recordGrant(tx, t.connectionId, checked);
      return live !== undefined;
    });
    return recorded ? { state: 'approved', permissionId } : { state: 'failed', code: 'connection_ended', permissionId };
  } catch (err) {
    log('warn', { msg: 'granted permission not recorded', permissionId, error: errorLabel(err) });
    return { state: 'failed', code: 'not_recorded', permissionId };
  }
}

export const markRevoked = (id: string) =>
  getDb().transaction(async (tx) => {
    await tx
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(and(sameId(id), isNull(grants.revokedAt)));
    await tx
      .update(permissionRequests)
      .set({ code: null, updatedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(permissionRequests.method, 'revoke'),
          sql`lower(${permissionRequests.permissionId}) = ${id.toLowerCase()}`,
          eq(permissionRequests.state, 'approved'),
          eq(permissionRequests.code, 'unconfirmed')
        )
      );
  });

export const readState = (target: RevokeTarget, read: ReadPermission) =>
  read(target).catch((): PermissionState => ({ status: 'unavailable' }));

export const revokeWork =
  (deps: RevokeReads): Rebuild =>
  (t, target) =>
  (ask, claim) =>
    askRevoke(t, target as RevokeTarget, ask, claim, deps);

async function askRevoke(t: Tenant, target: RevokeTarget, ask: Ask, claim: Claim, deps: RevokeReads): Promise<Outcome> {
  const [account] = (await ask('eth_requestAccounts', [])) as unknown[];
  if (typeof account !== 'string' || !isAddressEqual(account as Address, t.account)) {
    return { state: 'failed', code: 'wrong_account' };
  }
  if (!(await claim())) return { state: 'expired', code: 'session_lost' };
  await ask('wallet_revokePermissions', [{ id: target.permissionId, address: t.account }]);
  for (let read = 0; read < SETTLE_READS; read++) {
    const state = await readState(target, deps.readPermission);
    if (state.status === 'ok' && state.revoked) {
      await markRevoked(target.permissionId);
      return { state: 'approved' };
    }
    await new Promise((resolve) => setTimeout(resolve, deps.rereadMs));
  }
  return { state: 'approved', code: 'unconfirmed' };
}

const REBUILDS = { sign: signWork, grant: grantWork(readOnChain), revoke: revokeWork(REVOKE_READS) };

export const resumeRequests = () => resumeOpen(REBUILDS);
