import {
  PERMISSION_MANAGER_ABI,
  toContractPermission,
  usdcForNetwork,
  type ChainClients,
  type GrantedPermission,
  type PermissionState,
} from '@jaw.id/agent';
import {
  Account,
  estimateErc20PaymasterCosts,
  fetchTokenQuotes,
  jawPaymasterUrl,
  PERMISSIONS_MANAGER_ADDRESS,
} from '@jaw.id/core';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, formatUnits, isAddressEqual, maxUint256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { rpcUrl } from '@/approvals/bundler';
import { readOnChain, type ReadPermission } from '@/approvals/page-api';
import { refusal } from '@/approvals/tools';
import { grants } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { errorLabel, log } from '@/lib/edge';
import { FloatBusy, LOCK_WAIT_MS, withFloat, type FloatHold } from '@/payments/float-lock';
import { stillHeld } from '@/payments/refill';
import { holdingRows } from '@/payments/store';
import type { Tenant } from './auth';
import { config, SUPPORTED_CHAINS } from './config';
import { endConnection } from './rows';

type SessionCall = { to: Address; data: Hex };
export type Sent = { status: 'landed'; txHash: Hex } | { status: 'reverted' } | { status: 'unconfirmed' };

/** The session key's own EIP-7702 account, paying its fees in USDC through JAW's ERC-20 paymaster. */
export interface SessionSender {
  paymaster: Address;
  /** The fee these calls are expected to cost and the most the paymaster may charge, in USDC base units. */
  quote: (calls: SessionCall[]) => Promise<{ expected: bigint; max: bigint }>;
  /** Throws when nothing was sent, except for a fee over the cap, which reverts in simulation. */
  send: (calls: SessionCall[]) => Promise<Sent>;
}

export interface DisconnectDeps {
  readPermission: ReadPermission;
  clients: ChainClients;
  sender: (t: Tenant) => Promise<SessionSender>;
  lockWaitMs?: number;
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

const FEE_MARGIN_BPS = 12_500n;
const RECEIPT_MS = 60_000;

export async function sessionSender(t: Tenant): Promise<SessionSender> {
  const apiKey = config().paymasterApiKey;
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!apiKey || !usdc) throw new Error('no ERC-20 paymaster for this chain');
  const paymasterUrl = jawPaymasterUrl(t.chainId, apiKey);
  const localAccount = privateKeyToAccount(t.sessionKey());
  const account = await Account.fromLocalAccount(
    { chainId: t.chainId, apiKey, paymasterUrl, paymasterContext: { token: usdc.address } },
    localAccount,
    { eip7702: true }
  );
  if (!isAddressEqual(account.address, t.sessionAddress)) throw new Error('the session key is not the payer');
  const [paymasterQuote] = await fetchTokenQuotes(paymasterUrl, t.chainId, [usdc.address]);
  if (!paymasterQuote) throw new Error('the paymaster returned no quote');
  return {
    paymaster: paymasterQuote.paymasterAddress,
    quote: async (calls) => {
      const [estimate] = await estimateErc20PaymasterCosts(
        account.getSmartAccount(),
        calls,
        { ...SUPPORTED_CHAINS[t.chainId], rpcUrl: rpcUrl(t.chainId) },
        paymasterUrl,
        [{ address: usdc.address, symbol: 'USDC', decimals: usdc.decimals, balance: 0n }],
        { localAccount }
      );
      if (!estimate) throw new Error('the paymaster returned no estimate');
      return { expected: estimate.tokenCost, max: estimate.tokenCostMax };
    },
    send: async (calls) => {
      let id: string;
      try {
        ({ id } = await account.sendCalls(calls));
      } catch (err) {
        // The bundler and the paymaster both run its postOp before signing, so a fee
        // above the allowance the batch leaves fails there, before anything is sent.
        if (/AA50 postOp reverted/i.test(String(err))) return { status: 'reverted' };
        throw err;
      }
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
  seenRevoked: Hex[];
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
    outcome = await withFloat(t.connectionId, deps.lockWaitMs ?? LOCK_WAIT_MS, async (hold) => {
      const returned = await returnFunds(hold, t, deps);
      if (typeof returned === 'string') return returned;
      await hold.tx(async (tx) => {
        const ids = [...returned.revoked, ...returned.seenRevoked];
        if (ids.length) await tx.update(grants).set({ revokedAt: new Date() }).where(inArray(grants.permissionId, ids));
        await endConnection(t.connectionId, t.account, new Date(), tx);
      });
      return returned;
    });
  } catch (err) {
    if (err instanceof FloatBusy) return refusal(REFUSALS.busy);
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

async function returnFunds(hold: FloatHold, t: Tenant, deps: DisconnectDeps): Promise<Returned | string> {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return REFUSALS.chain;
  const live = await hold.tx((tx) =>
    tx
      .select()
      .from(grants)
      .where(and(eq(grants.connectionId, t.connectionId), isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`)))
  );

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
  const held = await stillHeld(await hold.tx((tx) => holdingRows(tx, t.sessionAddress, '')), deps.clients, block);
  const free = float > held ? float - held : 0n;
  const transfer = (amount: bigint): SessionCall => ({
    to: usdc.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [t.account, amount] }),
  });
  const nothingSent = { revoked: [], swept: 0n, txHash: null, left: float, seenRevoked };
  if (revokes.length === 0 && free === 0n) return { ...nothingSent, stillApproved: [] };

  const sender = await deps.sender(t).catch((err) => {
    log('error', { msg: 'disconnect sender unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (!sender) return REFUSALS.notSent;
  const batch = (swept: bigint, reserve: bigint): SessionCall[] => [
    ...revokes.map((r) => r.call),
    transfer(swept),
    // Last, so it overwrites any allowance before it: the fee can take the reserve
    // and never what payments hold. A fee above it reverts the whole batch.
    {
      to: usdc.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [sender.paymaster, reserve] }),
    },
  ];
  // Quoted with a one unit transfer and an unbounded allowance: the fee does not
  // depend on either, a simulation that moves the whole float leaves nothing to
  // pay the fee with, and one capped at a unit fails the paymaster's postOp.
  const fee = await sender.quote(batch(1n, maxUint256)).catch((err) => {
    log('error', { msg: 'disconnect quote unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (fee === undefined) return REFUSALS.chain;
  const margin = (fee.expected * FEE_MARGIN_BPS + 9_999n) / 10_000n;
  const reserve = margin < fee.max ? margin : fee.max;
  log('info', {
    msg: 'disconnect fee reserve',
    fee: { expected: fee.expected.toString(), reserve: reserve.toString(), max: fee.max.toString() },
  });
  // What payments hold is not the payer's to spend on fees, so a payer that cannot
  // cover the fee leaves the budgets to the owner's page.
  const leaveToOwner = () => ({ ...nothingSent, stillApproved: revokes.map((r) => r.permissionId) });
  if (free <= reserve) return leaveToOwner();

  const sendWith = (cap: bigint) => {
    hold.assertHeld();
    return sender.send(batch(free - cap, cap)).catch((err) => {
      log('error', { msg: 'disconnect batch not sent', error: errorLabel(err) });
      return undefined;
    });
  };
  let swept = free - reserve;
  let sent = await sendWith(reserve);
  // A fee over the reserve reverts with nothing moved; one more try at the ceiling.
  // A float under the ceiling cannot pay more, so the budgets go to the owner and the
  // connection still ends.
  if (sent?.status === 'reverted' && reserve < fee.max) {
    if (free <= fee.max) return leaveToOwner();
    swept = free - fee.max;
    sent = await sendWith(fee.max);
  }
  if (!sent) return REFUSALS.notSent;
  if (sent.status !== 'landed') return REFUSALS[sent.status];

  const revoked = revokes.map((r) => r.permissionId);
  const left = await balanceAt().catch(() => null);
  return { revoked, stillApproved: [], swept, txHash: sent.txHash, left, seenRevoked };
}
