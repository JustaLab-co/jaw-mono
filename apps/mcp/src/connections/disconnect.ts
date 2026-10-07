import {
  firstOperationCost,
  PERMISSION_MANAGER_ABI,
  toContractPermission,
  usdcForNetwork,
  type GrantedPermission,
  type PermissionState,
} from '@jaw.id/agent';
import { Account, jawPaymasterUrl, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { readUserOp } from '@/approvals/bundler';
import { readOnChain, type ReadPermission } from '@/approvals/page-api';
import { refusal } from '@/approvals/tools';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { publicClientFor } from '@/lib/chain';
import { errorLabel, log } from '@/lib/edge';
import { holdingRows } from '@/payments/store';
import type { Tenant } from './auth';
import { config } from './config';
import { endConnection } from './page';

type SessionCall = { to: Address; data: Hex };

export interface DisconnectDeps {
  readPermission: ReadPermission;
  readFloat: (chainId: number, payer: Address) => Promise<bigint>;
  /** Sends the calls from the session key's own account and answers the tx hash once it succeeded on chain. */
  send: (t: Tenant, calls: SessionCall[]) => Promise<Hex>;
}

export const disconnectOutput = z.object({
  revoked: z.array(z.string()).describe('Budgets revoked on chain as spender by this call'),
  swept: z.string().describe('USDC base units returned to the account'),
  txHash: z.string().nullable(),
  left: z.string().nullable().describe('USDC base units still in the payer, held by payments that may settle'),
  payer: z.string(),
  summary: z.string(),
});

type Reply = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: z.infer<typeof disconnectOutput>;
};

const REFUSALS = {
  paused: 'Payments are paused, so nothing was revoked. Try again later.',
  chain: 'Nothing was revoked: the chain could not be read. Try again.',
  failed: 'Nothing was revoked: the transaction did not go through. Try again.',
};

const RECEIPT_MS = 60_000;

const sendFromSession: DisconnectDeps['send'] = async (t, calls) => {
  const apiKey = config().paymasterApiKey;
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!apiKey || !usdc) throw new Error('no ERC-20 paymaster for this chain');
  const account = await Account.fromLocalAccount(
    {
      chainId: t.chainId,
      apiKey,
      paymasterUrl: jawPaymasterUrl(t.chainId, apiKey),
      paymasterContext: { token: usdc.address },
    },
    privateKeyToAccount(t.sessionKey()),
    { eip7702: true }
  );
  const { id } = await account.sendCalls(calls);
  for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
    const op = await readUserOp({ chainId: t.chainId, account: t.sessionAddress, callsId: id as Hex });
    if (op.status === 'included') {
      if (!op.success) throw new Error('the batch reverted');
      return op.txHash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('the batch was not included in time');
};

const DEFAULTS: DisconnectDeps = {
  readPermission: readOnChain,
  readFloat: async (chainId, payer) =>
    publicClientFor(chainId).readContract({
      address: usdcForNetwork(`eip155:${chainId}`)!.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [payer],
    }),
  send: sendFromSession,
};

interface Returned {
  revoked: Hex[];
  swept: bigint;
  txHash: Hex | null;
  left: bigint | null;
}

/**
 * Revokes the budgets as spender and returns the float in one batch, then ends the
 * connection. The chain goes first: when it fails nothing is revoked, so a retry
 * picks up where this left off.
 */
export async function disconnect(t: Tenant, deps = DEFAULTS): Promise<Reply> {
  if (await isPaymentsPaused()) return refusal(REFUSALS.paused);
  let returned: Returned = { revoked: [], swept: 0n, txHash: null, left: null };
  // Without wallet:send the connection never held a budget, so there is nothing to return.
  if (t.scopes.includes('wallet:send')) {
    const outcome = await returnFunds(t, deps);
    if (typeof outcome === 'string') return refusal(outcome);
    returned = outcome;
  }
  await endConnection(t.connectionId, t.account);

  const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;
  const said = ['Disconnected. Tokens for this connection no longer work.'];
  if (returned.revoked.length) said.push(`Revoked ${returned.revoked.length} budget(s) on chain.`);
  if (returned.swept > 0n) said.push(`Returned ${usdc(returned.swept)} to ${t.account} in ${returned.txHash}.`);
  if (returned.left) said.push(`${usdc(returned.left)} stays in the payer ${t.sessionAddress}.`);
  const out = disconnectOutput.parse({
    revoked: returned.revoked,
    swept: returned.swept.toString(),
    txHash: returned.txHash,
    left: returned.left?.toString() ?? null,
    payer: t.sessionAddress,
    summary: said.join(' '),
  });
  return { content: [{ type: 'text' as const, text: out.summary }], structuredContent: out };
}

async function returnFunds(t: Tenant, deps: DisconnectDeps): Promise<Returned | string> {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return REFUSALS.chain;
  const live = await getDb()
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, t.connectionId), isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`)));

  const toRevoke: { permissionId: Hex; call: SessionCall }[] = [];
  const alreadyRevoked: Hex[] = [];
  for (const g of live) {
    const permission = g.permission as GrantedPermission;
    const struct = toContractPermission(permission);
    const state = await deps
      .readPermission({ chainId: g.chainId, permissionId: g.permissionId as Hex, permission })
      .catch((): PermissionState => ({ status: 'unavailable' }));
    if (!struct || state.status !== 'ok') return REFUSALS.chain;
    if (state.revoked) {
      alreadyRevoked.push(g.permissionId as Hex);
      continue;
    }
    const data = encodeFunctionData({ abi: PERMISSION_MANAGER_ABI, functionName: 'revokeAsSpender', args: [struct] });
    toRevoke.push({ permissionId: g.permissionId as Hex, call: { to: PERMISSIONS_MANAGER_ADDRESS, data } });
  }

  const float = await deps.readFloat(t.chainId, t.sessionAddress).catch(() => undefined);
  if (float === undefined) return REFUSALS.chain;
  // Payments still in flight keep what they may settle, at their ceiling; the batch pays its own fee.
  const rows = await holdingRows(getDb(), t.sessionAddress, '');
  const held = rows.reduce((sum, r) => sum + BigInt((r.state === 'pending' ? r.reserved : r.authorized) ?? 0), 0n);
  const kept = held + firstOperationCost(usdc);
  const swept = float > kept ? float - kept : 0n;

  const calls = toRevoke.map((r) => r.call);
  if (swept > 0n) {
    calls.push({
      to: usdc.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [t.account, swept] }),
    });
  }
  let txHash: Hex | null = null;
  if (calls.length > 0) {
    txHash = await deps.send(t, calls).catch((err) => {
      log('error', { msg: 'disconnect batch failed', error: errorLabel(err) });
      return null;
    });
    if (!txHash) return REFUSALS.failed;
  }

  const revoked = toRevoke.map((r) => r.permissionId);
  const recorded = [...revoked, ...alreadyRevoked];
  if (recorded.length) {
    await getDb().update(grants).set({ revokedAt: new Date() }).where(inArray(grants.permissionId, recorded));
  }
  const left = txHash ? await deps.readFloat(t.chainId, t.sessionAddress).catch(() => null) : float;
  return { revoked, swept, txHash, left };
}
