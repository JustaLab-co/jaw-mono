import {
  PERMISSION_MANAGER_ABI,
  toContractPermission,
  usdcForNetwork,
  type ChainClients,
  type GrantedPermission,
  type PermissionState,
} from '@jaw.id/agent';
import { Account, estimateErc20PaymasterCosts, jawPaymasterUrl, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, formatUnits, isAddressEqual, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { rpcUrl } from '@/approvals/bundler';
import { readOnChain, type ReadPermission } from '@/approvals/page-api';
import { refusal } from '@/approvals/tools';
import { getDb, type Tx } from '@/db/client';
import { grants } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { errorLabel, log } from '@/lib/edge';
import { LOCK_NOT_AVAILABLE, lockFloat, stillHeld } from '@/payments/refill';
import { holdingRows } from '@/payments/store';
import type { Tenant } from './auth';
import { config, SUPPORTED_CHAINS } from './config';
import { endConnection } from './rows';

type SessionCall = { to: Address; data: Hex };
export type Sent = { status: 'landed'; txHash: Hex } | { status: 'reverted' } | { status: 'unconfirmed' };

/** The session key's own EIP-7702 account, paying its fees in USDC through JAW's ERC-20 paymaster. */
export interface SessionSender {
  /** The most the paymaster may charge for these calls, in USDC base units. */
  quote: (calls: SessionCall[]) => Promise<bigint>;
  /** Throws when nothing was sent. */
  send: (calls: SessionCall[]) => Promise<Sent>;
}

export interface DisconnectDeps {
  readPermission: ReadPermission;
  clients: ChainClients;
  sender: (t: Tenant) => Promise<SessionSender>;
}

export const disconnectOutput = z.object({
  revoked: z.array(z.string()).describe('Budgets revoked on chain as spender by this call'),
  stillApproved: z
    .array(z.string())
    .describe('Budgets left approved on chain because the payer could not pay the fee; the owner revokes them'),
  swept: z.string().describe('USDC base units returned to the account'),
  txHash: z.string().nullable(),
  left: z.string().nullable().describe('USDC base units still in the payer'),
  payer: z.string(),
  summary: z.string(),
});
type Output = z.infer<typeof disconnectOutput>;
type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Output };

const REFUSALS = {
  paused: 'Payments are paused, so nothing was revoked. Try again later.',
  chain: 'Nothing was revoked: the chain could not be read. Try again.',
  busy: 'A payment on this connection is in progress, so nothing was revoked. Try again in a moment.',
  notSent: 'Nothing was revoked: the transaction could not be sent. Try again.',
  reverted: 'Nothing was revoked: the transaction reverted. Try again.',
  unconfirmed:
    'The transaction was sent but is not confirmed yet. Call jaw_disconnect again in a minute to finish; it does not repeat what already landed.',
};

const LOCK_WAIT_MS = 8_000;
const RECEIPT_MS = 60_000;

async function sessionSender(t: Tenant): Promise<SessionSender> {
  const apiKey = config().paymasterApiKey;
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!apiKey || !usdc) throw new Error('no ERC-20 paymaster for this chain');
  const paymasterUrl = jawPaymasterUrl(t.chainId, apiKey);
  const account = await Account.fromLocalAccount(
    { chainId: t.chainId, apiKey, paymasterUrl, paymasterContext: { token: usdc.address } },
    privateKeyToAccount(t.sessionKey()),
    { eip7702: true }
  );
  if (!isAddressEqual(account.address, t.sessionAddress)) throw new Error('the session key is not the payer');
  return {
    quote: async (calls) => {
      const [estimate] = await estimateErc20PaymasterCosts(
        account.getSmartAccount(),
        calls,
        { ...SUPPORTED_CHAINS[t.chainId], rpcUrl: rpcUrl(t.chainId) },
        paymasterUrl,
        [{ address: usdc.address, symbol: 'USDC', decimals: usdc.decimals, balance: 0n }]
      );
      if (!estimate) throw new Error('the paymaster returned no estimate');
      return estimate.tokenCostMax;
    },
    send: async (calls) => {
      const { id } = await account.sendCalls(calls);
      for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
        const status = await account.getCallStatus(id as Hex).catch(() => undefined);
        const txHash = status?.receipts?.[0]?.transactionHash;
        if (status?.status === 200 && txHash) return { status: 'landed', txHash };
        if (status && status.status >= 400) return { status: 'reverted' };
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return { status: 'unconfirmed' };
    },
  };
}

const DEFAULTS: DisconnectDeps = { readPermission: readOnChain, clients: chainClients, sender: sessionSender };

interface Returned {
  revoked: Hex[];
  stillApproved: Hex[];
  swept: bigint;
  txHash: Hex | null;
  left: bigint | null;
}

/**
 * Revokes the budgets as spender and returns the float in one batch, then ends the
 * connection, all under the lock refills take, so no payment funds itself from a
 * float being swept. A failure before the batch lands revokes nothing, so a retry
 * picks up where this left off.
 */
export async function disconnect(t: Tenant, deps = DEFAULTS): Promise<Reply> {
  if (await isPaymentsPaused()) return refusal(REFUSALS.paused);
  let outcome: Returned | string;
  try {
    outcome = await getDb().transaction(async (tx) => {
      await lockFloat(tx, t.connectionId, LOCK_WAIT_MS);
      const returned = await returnFunds(tx, t, deps);
      if (typeof returned !== 'string') await endConnection(t.connectionId, t.account, new Date(), tx);
      return returned;
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
    if (code === LOCK_NOT_AVAILABLE) return refusal(REFUSALS.busy);
    throw err;
  }
  if (typeof outcome === 'string') return refusal(outcome);

  const out: Output = {
    revoked: outcome.revoked,
    stillApproved: outcome.stillApproved,
    swept: outcome.swept.toString(),
    txHash: outcome.txHash,
    left: outcome.left?.toString() ?? null,
    payer: t.sessionAddress,
    summary: summarize(t, outcome),
  };
  return { content: [{ type: 'text', text: out.summary }], structuredContent: out };
}

function summarize(t: Tenant, r: Returned): string {
  const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;
  const said = ['Disconnected. Tokens for this connection no longer work.'];
  if (r.revoked.length) said.push(`Revoked ${r.revoked.length} budget(s) on chain.`);
  if (r.swept > 0n) said.push(`Returned ${usdc(r.swept)} to ${t.account} in ${r.txHash}.`);
  if (r.stillApproved.length) {
    said.push(
      `${r.stillApproved.length} budget(s) are still approved on chain because the payer cannot pay the fee to revoke them; ` +
        `the owner can revoke them at ${config().keysOrigin}/connections.`
    );
  }
  if (r.left) said.push(`${usdc(r.left)} stays in the payer ${t.sessionAddress}.`);
  return said.join(' ');
}

async function returnFunds(tx: Tx, t: Tenant, deps: DisconnectDeps): Promise<Returned | string> {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return REFUSALS.chain;
  const live = await tx
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, t.connectionId), isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`)));

  const revokes: { permissionId: Hex; call: SessionCall }[] = [];
  const seenRevoked: Hex[] = [];
  for (const g of live) {
    const permission = g.permission as GrantedPermission;
    const struct = toContractPermission(permission);
    const state = await deps
      .readPermission({ chainId: g.chainId, permissionId: g.permissionId as Hex, permission })
      .catch((): PermissionState => ({ status: 'unavailable' }));
    if (!struct || state.status !== 'ok') return REFUSALS.chain;
    if (state.revoked) {
      seenRevoked.push(g.permissionId as Hex);
      continue;
    }
    const data = encodeFunctionData({ abi: PERMISSION_MANAGER_ABI, functionName: 'revokeAsSpender', args: [struct] });
    revokes.push({ permissionId: g.permissionId as Hex, call: { to: PERMISSIONS_MANAGER_ADDRESS, data } });
  }
  const recordRevoked = async (ids: Hex[]) => {
    if (ids.length) await tx.update(grants).set({ revokedAt: new Date() }).where(inArray(grants.permissionId, ids));
  };

  // The balance and the nonces it is netted against are read at one block, as the refill does.
  const client = deps.clients.publicClient(t.chainId);
  const balanceAt = (blockNumber?: bigint) =>
    client.readContract({
      address: usdc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [t.sessionAddress],
      blockNumber,
    });
  const block = await client.getBlockNumber().catch(() => undefined);
  const float = await balanceAt(block).catch(() => undefined);
  if (float === undefined) return REFUSALS.chain;
  const held = await stillHeld(await holdingRows(tx, t.sessionAddress, ''), deps.clients, block);
  const free = float > held ? float - held : 0n;
  const transfer = (amount: bigint): SessionCall => ({
    to: usdc.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [t.account, amount] }),
  });
  const nothingSent = { revoked: [], swept: 0n, txHash: null, left: float };
  if (revokes.length === 0 && free === 0n) {
    await recordRevoked(seenRevoked);
    return { ...nothingSent, stillApproved: [] };
  }

  const sender = await deps.sender(t).catch((err) => {
    log('error', { msg: 'disconnect sender unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (!sender) return REFUSALS.notSent;
  const fee = await sender.quote([...revokes.map((r) => r.call), transfer(free)]).catch((err) => {
    log('error', { msg: 'disconnect quote unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (fee === undefined) return REFUSALS.chain;
  // What payments hold is not the payer's to spend on fees, so a payer that cannot
  // cover the fee leaves the budgets to the owner's page.
  if (free <= fee) {
    await recordRevoked(seenRevoked);
    return { ...nothingSent, stillApproved: revokes.map((r) => r.permissionId) };
  }

  const swept = free - fee;
  const sent = await sender.send([...revokes.map((r) => r.call), transfer(swept)]).catch((err) => {
    log('error', { msg: 'disconnect batch not sent', error: errorLabel(err) });
    return undefined;
  });
  if (!sent) return REFUSALS.notSent;
  if (sent.status !== 'landed') return REFUSALS[sent.status];

  const revoked = revokes.map((r) => r.permissionId);
  await recordRevoked([...revoked, ...seenRevoked]);
  const left = await balanceAt().catch(() => null);
  return { revoked, stillApproved: [], swept, txHash: sent.txHash, left };
}
