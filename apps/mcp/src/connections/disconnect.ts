import {
  PERMISSION_MANAGER_ABI,
  toContractPermission,
  usdcForNetwork,
  type ChainClients,
  type PermissionState,
} from '@jaw.id/agent';
import {
  Account,
  estimateErc20PaymasterCosts,
  fetchTokenQuotes,
  jawPaymasterUrl,
  PERMISSIONS_MANAGER_ADDRESS,
} from '@jaw.id/core';
import { and, eq, ne } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, formatUnits, isAddressEqual, maxUint256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { readOnChain, type ReadPermission } from '@/grants/permission';
import { liveGrants, recordRevoked, replacedBudgets, type LiveGrant } from '@/grants/store';
import { publicClientFor, rpcUrl } from '@/lib/chain';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { FloatBusy, LOCK_WAIT_MS, withFloat, type FloatHold } from '@/payments/float-lock';
import { stillHeld } from '@/payments/refill';
import { holdingRows, LEASE_MS, sendInFlight } from '@/payments/store';
import { refusal } from '@/tools/reply';
import type { Tenant } from './auth';
import { config, SUPPORTED_CHAINS } from './config';
import { endConnection, SendInFlight } from './rows';

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

/** What acting as a connection's spender needs: its session key, and the account its float goes back to. */
export type Session = Pick<Tenant, 'connectionId' | 'account' | 'chainId' | 'sessionAddress' | 'sessionKey'>;

export interface DisconnectDeps {
  readPermission: ReadPermission;
  clients: ChainClients;
  sender: (s: Session) => Promise<SessionSender>;
  lockWaitMs?: number;
}

export const disconnectOutput = z.object({
  revoked: z.array(z.string()).describe('Budgets revoked on chain as spender by this call'),
  stillApproved: z
    .array(z.string())
    .describe(
      'Budgets left approved on chain because the payer could not pay the fee; jaw_revoke_permission revokes them'
    ),
  unread: z
    .array(z.string())
    .describe(
      'Grants left approved on chain because the chain could not be read for them; jaw_revoke_permission revokes them'
    ),
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
  landing:
    'A payment or an execute is still in flight, so the connection stays open. Call jaw_session_disconnect again in a moment; it returns what landed.',
  notSent: 'Nothing was revoked: the transaction could not be sent. Try again.',
  reverted: 'Nothing was revoked: the transaction reverted. Try again.',
  unconfirmed:
    'The transaction was sent but is not confirmed yet. Call jaw_session_disconnect again in a minute to finish; it does not repeat what already landed.',
};

const FEE_MARGIN_BPS = 12_500n;
const LANDING_RETRY_MS = 250;
const RECEIPT_MS = 60_000;
/**
 * The fee of a session's first op, which carries the EIP-7702 delegation the
 * paymaster estimate cannot price: the expected fee, as `firstOperationCost`
 * in @jaw.id/agent, and a ceiling for a gas spike.
 */
const FIRST_OP_EXPECTED = 10_000n;
const FIRST_OP_MAX = 50_000n;
const isDelegated = (code: Hex | undefined) => code?.toLowerCase().startsWith('0xef0100') ?? false;

export async function sessionSender(t: Session): Promise<SessionSender> {
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
  const [paymasterQuote] = await fetchTokenQuotes(paymasterUrl, t.chainId, [usdc.address]);
  if (!paymasterQuote) throw new Error('the paymaster returned no quote');
  return {
    paymaster: paymasterQuote.paymasterAddress,
    quote: async (calls) => {
      const code = await publicClientFor(t.chainId).getCode({ address: t.sessionAddress });
      if (!isDelegated(code)) return { expected: FIRST_OP_EXPECTED, max: FIRST_OP_MAX };
      const [estimate] = await estimateErc20PaymasterCosts(
        account.getSmartAccount(),
        calls,
        { ...SUPPORTED_CHAINS[t.chainId], rpcUrl: rpcUrl(t.chainId) },
        paymasterUrl,
        [{ address: usdc.address, symbol: 'USDC', decimals: usdc.decimals, balance: 0n }]
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

const NOTHING_REVOKED: Returned = {
  revoked: [],
  stillApproved: [],
  unread: [],
  swept: 0n,
  txHash: null,
  left: null,
  seenRevoked: [],
};

interface Returned {
  revoked: Hex[];
  stillApproved: Hex[];
  unread: Hex[];
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
    outcome = await returnAndEnd(t, deps);
  } catch (err) {
    if (err instanceof FloatBusy) return refusal(REFUSALS.busy);
    throw err;
  }
  if (typeof outcome === 'string') return refusal(outcome);

  const out: Output = {
    revoked: outcome.revoked,
    stillApproved: outcome.stillApproved,
    unread: outcome.unread,
    swept: outcome.swept.toString(),
    txHash: outcome.txHash,
    left: outcome.left?.toString() ?? null,
    payer: t.sessionAddress,
    summary: summarize(t, outcome),
  };
  return reply(out);
}

/**
 * Returns the float and ends the connection under the float lock. While a top-up
 * or an execute may still move money it does neither and answers `REFUSALS.landing`.
 */
async function returnAndEnd(s: Session, deps: DisconnectDeps): Promise<Returned | string> {
  try {
    return await withFloat(s.connectionId, deps.lockWaitMs ?? LOCK_WAIT_MS, async (hold) => {
      if (await hold.tx((tx) => sendInFlight(tx, s.connectionId))) return REFUSALS.landing;
      const returned = await returnFunds(hold, s, deps, 'everything');
      if (typeof returned === 'string') return returned;
      await hold.tx((tx) => endConnection(s.connectionId, s.account, new Date(), tx));
      return returned;
    });
  } catch (err) {
    if (err instanceof SendInFlight) return REFUSALS.landing;
    throw err;
  }
}

/** Revokes every live budget of a session and returns its free float to the owner, under the float lock. */
export const retire = (s: Session, deps = DEFAULTS): Promise<Returned | string> =>
  withFloat(s.connectionId, deps.lockWaitMs ?? LOCK_WAIT_MS, (hold) => returnFunds(hold, s, deps, 'everything'));

/**
 * Revokes as spender the budgets a newer one replaced, and leaves the float for
 * payments. One it could not revoke stays replaced and unrevoked, for the next
 * call or the disconnect to pick up.
 */
export async function revokeReplaced(s: Session, deps = DEFAULTS): Promise<Returned | string> {
  if (await isPaymentsPaused()) return REFUSALS.paused;
  // Read first, so a connection with nothing to revoke never waits on the float lock.
  if ((await replacedBudgets(s.connectionId)).length === 0) return NOTHING_REVOKED;
  return withFloat(s.connectionId, deps.lockWaitMs ?? LOCK_WAIT_MS, async (hold) => {
    // A payment or execute still in flight may pull under a budget this would revoke.
    if (await hold.tx((tx) => sendInFlight(tx, s.connectionId))) return REFUSALS.landing;
    return returnFunds(hold, s, deps, 'replaced');
  }).catch((err: unknown) => (err instanceof FloatBusy ? REFUSALS.busy : errorLabel(err)));
}

/**
 * Returns the float, revokes the budgets and ends a connection whose refresh
 * token was reused, with the key that token's wrap still opened. The key exists
 * only in this request, so a top-up still landing is waited for, up to the
 * lease that keeps it in flight. Paused payments or a failed return leave the
 * float at the payer.
 */
export async function sweepOnReuse(connectionId: string, key: Hex, deps = DEFAULTS): Promise<void> {
  if (await isPaymentsPaused()) return;
  const [conn] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), ne(connections.status, 'pending')));
  if (!conn?.sessionAddress) return;
  const session: Session = {
    connectionId,
    account: conn.account as Address,
    chainId: conn.chainId,
    sessionAddress: conn.sessionAddress as Address,
    sessionKey: () => key,
  };
  const until = Date.now() + LEASE_MS;
  for (;;) {
    const outcome = await returnAndEnd(session, deps).catch((err: unknown) => errorLabel(err));
    if (outcome !== REFUSALS.landing || Date.now() > until) {
      if (typeof outcome === 'string') log('warn', { msg: `reuse sweep skipped for ${connectionId}`, error: outcome });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LANDING_RETRY_MS));
  }
}

function summarize(t: Tenant, r: Returned): string {
  const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;
  const said = ['Disconnected. Tokens for this connection no longer work.'];
  if (r.revoked.length) said.push(`Revoked ${r.revoked.length} budget(s) on chain.`);
  if (r.swept > 0n) said.push(`Returned ${usdc(r.swept)} to ${t.account} in ${r.txHash}.`);
  if (r.stillApproved.length) {
    said.push(
      `${r.stillApproved.length} budget(s) are still approved on chain until they expire, because the payer cannot pay the fee to revoke them. ` +
        'Nothing can spend from them: the session key went with this connection.'
    );
  }
  if (r.unread.length) {
    said.push(
      `${r.unread.length} grant(s) could not be read on chain, so they were not revoked and stay approved until they expire or the owner revokes them through jaw_revoke_permission. ` +
        'Nothing can spend from them: the session key went with this connection.'
    );
  }
  if (r.left) {
    const why = r.revoked.length && r.swept === 0n ? ': too little to sweep after the fee' : '';
    said.push(`${usdc(r.left)} stays in the payer ${t.sessionAddress}${why}.`);
  }
  return said.join(' ');
}

/**
 * `everything` revokes every live grant and returns the free float to the owner.
 * `replaced` revokes only the budgets a newer one replaced and leaves the float.
 */
async function returnFunds(
  hold: FloatHold,
  t: Session,
  deps: DisconnectDeps,
  scope: 'everything' | 'replaced'
): Promise<Returned | string> {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return REFUSALS.chain;
  const live = await hold.tx((tx) =>
    scope === 'everything' ? liveGrants(t.connectionId, tx) : replacedBudgets(t.connectionId, tx)
  );
  if (scope === 'replaced' && live.length === 0) return NOTHING_REVOKED;
  const returned = await sendBatch(hold, t, deps, live, usdc.address, scope === 'everything');
  if (typeof returned === 'string') return returned;
  const ids = [...returned.revoked, ...returned.seenRevoked];
  if (ids.length) await hold.tx((tx) => recordRevoked(ids, tx));
  return returned;
}

async function sendBatch(
  hold: FloatHold,
  t: Session,
  deps: DisconnectDeps,
  live: LiveGrant[],
  token: Address,
  sweep: boolean
): Promise<Returned | string> {
  const revokes: { permissionId: Hex; call: SessionCall }[] = [];
  const seenRevoked: Hex[] = [];
  const unread: Hex[] = [];
  for (const g of live) {
    const struct = toContractPermission(g.permission);
    const state = await deps
      .readPermission({ chainId: g.chainId, permissionId: g.permissionId, permission: g.permission })
      .catch((): PermissionState => ({ status: 'unavailable' }));
    if (!struct || state.status !== 'ok') {
      unread.push(g.permissionId);
      continue;
    }
    if (state.revoked) {
      seenRevoked.push(g.permissionId);
      continue;
    }
    const data = encodeFunctionData({ abi: PERMISSION_MANAGER_ABI, functionName: 'revokeAsSpender', args: [struct] });
    revokes.push({ permissionId: g.permissionId, call: { to: PERMISSIONS_MANAGER_ADDRESS, data } });
  }
  // The balance and the nonces it is netted against are read at one block, as the refill does.
  const client = deps.clients.publicClient(t.chainId);
  const balanceAt = (blockNumber?: bigint) =>
    client.readContract({
      address: token,
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
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [t.account, amount] }),
  });
  const nothingSent = { revoked: [], swept: 0n, txHash: null, left: float, seenRevoked, unread };
  if (revokes.length === 0 && (!sweep || free === 0n)) return { ...nothingSent, stillApproved: [] };

  const sender = await deps.sender(t).catch((err) => {
    log('error', { msg: 'disconnect sender unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (!sender) return REFUSALS.notSent;
  const batch = (swept: bigint, reserve: bigint): SessionCall[] => [
    ...revokes.map((r) => r.call),
    ...(sweep ? [transfer(swept)] : []),
    // Last, so it overwrites any allowance before it: the fee can take the reserve
    // and never what payments hold. A fee above it reverts the whole batch.
    {
      to: token,
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

  // Too little to cover the fee and a sweep: revoke the budgets alone, with the
  // paymaster's fee capped at what the payer holds.
  const tryRevokeOnly = async (): Promise<Returned | null> => {
    if (revokes.length === 0 || free === 0n) return null;
    const calls: SessionCall[] = [
      ...revokes.map((r) => r.call),
      {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [sender.paymaster, free] }),
      },
    ];
    hold.assertHeld();
    const result = await sender.send(calls).catch((err) => {
      log('error', { msg: 'disconnect revoke-only not sent', error: errorLabel(err) });
      return undefined;
    });
    if (!result || result.status !== 'landed') return null;
    const left = await balanceAt().catch(() => null);
    return {
      revoked: revokes.map((r) => r.permissionId),
      stillApproved: [],
      swept: 0n,
      txHash: result.txHash,
      left,
      seenRevoked,
      unread,
    };
  };

  if (free <= reserve) return (await tryRevokeOnly()) ?? leaveToOwner();

  const sendWith = (cap: bigint) => {
    hold.assertHeld();
    return sender.send(batch(free - cap, cap)).catch((err) => {
      log('error', { msg: 'disconnect batch not sent', error: errorLabel(err) });
      return undefined;
    });
  };
  let swept = sweep ? free - reserve : 0n;
  let sent = await sendWith(reserve);
  // A fee over the reserve reverts with nothing moved; one more try at the ceiling.
  // A float under the ceiling cannot pay more, so the budgets go to the owner and the
  // connection still ends.
  if (sent?.status === 'reverted' && reserve < fee.max) {
    if (free <= fee.max) return (await tryRevokeOnly()) ?? leaveToOwner();
    swept = sweep ? free - fee.max : 0n;
    sent = await sendWith(fee.max);
  }
  if (!sent) return REFUSALS.notSent;
  if (sent.status !== 'landed') return REFUSALS[sent.status];

  const revoked = revokes.map((r) => r.permissionId);
  const left = await balanceAt().catch(() => null);
  return { revoked, stillApproved: [], swept, txHash: sent.txHash, left, seenRevoked, unread };
}
