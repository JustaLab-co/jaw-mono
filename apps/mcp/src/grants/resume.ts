import { parseGrantedPermission, type GrantedPermission } from '@jaw.id/agent';
import { and, eq, sql } from 'drizzle-orm';
import { isAddressEqual, isHex, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Tenant } from '@/connections/auth';
import type { Ask } from '@/connections/relay';
import { isLive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import { checkGranted, readOnChain, recordGrant, type GrantRequest, type ReadPermission } from './permission';
import { waitingRequests, type Claim, type Outcome, type PermissionRequestRow, type Rebuild } from './requests';
import { markRevoked, readState, UNCONFIRMED } from './revokes';
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

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const signPayload = z.object({
  chainId: z.number().int().positive(),
  request: z.union([
    z.object({ type: z.literal('0x45'), data: z.object({ message: z.string() }) }),
    z.object({ type: z.literal('0x01'), data: z.record(z.string(), z.unknown()) }),
  ]),
});

const grantPayload = z.object({
  kind: z.enum(['x402-budget', 'custom']),
  grant: z.object({
    spender: address,
    expiry: z.number().int(),
    chainId: hex,
    permissions: z.object({
      calls: z.array(z.object({ target: address, functionSignature: z.string() })),
      spends: z.array(z.object({ token: address, allowance: z.string(), unit: z.string(), multiplier: z.number() })),
    }),
    capabilities: z.object({ prefundSpender: z.literal(true) }).optional(),
  }),
});

const revokePayload = z.object({
  permissionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  chainId: z.number().int().positive(),
  permission: z.unknown(),
  connectionId: z.string().nullable(),
});

export const signWork: Rebuild = (t, payload) => {
  const sent = signPayload.safeParse(payload).data;
  return sent && ((ask, claim) => approveSign(ask, claim, t, sent));
};

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

export type AddFundsPayload = { chainId: number };

const addFundsPayload = z.object({ chainId: z.number().int().positive() });

export const addFundsWork: Rebuild = (t, payload) => {
  const sent = addFundsPayload.safeParse(payload).data;
  return sent && ((ask, claim) => showAddFunds(ask, claim, t, sent));
};

/** The wallet answers null whether the owner funded or closed the screen, so approved means only that it closed. */
async function showAddFunds(ask: Ask, claim: Claim, t: Tenant, { chainId }: AddFundsPayload): Promise<Outcome> {
  if (!hasAccount(await ask('eth_requestAccounts', []), t.account)) {
    return { state: 'owner_declined', code: 'wrong_account' };
  }
  if (!(await claim())) return { state: 'expired', code: 'session_lost' };
  await ask('wallet_addFunds', [{ chainId }]);
  return { state: 'approved' };
}

export type GrantPayload = { kind: GrantKind; grant: GrantRequest };

/** The grant a request row asked for. Throws on a row this server did not write. */
export const grantAsked = (row: PermissionRequestRow): GrantPayload =>
  grantPayload.parse(JSON.parse(row.payload ?? 'null')) as GrantPayload;

export const grantWork =
  (read: ReadPermission): Rebuild =>
  (t, payload) => {
    const sent = grantPayload.safeParse(payload).data as GrantPayload | undefined;
    return sent && ((walletAsk, claim) => askGrant(t, sent, walletAsk, claim, read));
  };

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

export const revokeWork =
  (deps: RevokeReads): Rebuild =>
  (t, payload) => {
    const sent = revokePayload.safeParse(payload).data;
    const permission = sent && parseGrantedPermission(sent.permission);
    if (!sent || !permission) return undefined;
    const target = { ...sent, permissionId: sent.permissionId as Hex, permission };
    return (ask, claim) => askRevoke(t, target, ask, claim, deps);
  };

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
  return { state: 'approved', code: UNCONFIRMED };
}

const REBUILDS = {
  sign: signWork,
  grant: grantWork(readOnChain),
  revoke: revokeWork(REVOKE_READS),
  add_funds: addFundsWork,
};

export const requestsWaiting = waitingRequests(REBUILDS);
