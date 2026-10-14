import { toHex } from 'viem';
import { z } from 'zod';
import type { Ask } from '@/connections/relay';
import { errorLabel, log } from '@/lib/edge';
import { decline, markSendStarted, markSent, setCode, type OwnerCallRow } from './store';

const USER_REJECTED = 4001;
const SESSION_END_MARGIN_MS = 5_000;

const sent = z.object({ id: z.string().min(1).max(256) });

/** Asks the owner's wallet for the account, then for the stored calls, and records what came back. */
export async function approve(ask: Ask, row: OwnerCallRow): Promise<void> {
  let accounts: unknown;
  try {
    accounts = await ask('eth_requestAccounts', []);
  } catch (err) {
    await recordRefusal(row, err);
    return;
  }
  if (!includes(accounts, row.account)) {
    await decline(row.connectionId, row.id, 'wrong_account');
    return;
  }
  if (!(await markSendStarted(row.connectionId, row.id))) return;
  let answer: unknown;
  try {
    answer = await ask('wallet_sendCalls', [
      {
        version: '2.0.0',
        chainId: toHex(row.chainId),
        from: row.account,
        atomicRequired: true,
        calls: row.calls.map((c) => ({ to: c.to, data: c.data, value: toHex(BigInt(c.value)) })),
      },
    ]);
  } catch (err) {
    if (codeOf(err) === USER_REJECTED) await decline(row.connectionId, row.id, 'owner_declined');
    return;
  }
  const callsId = sent.safeParse(answer).data?.id;
  if (callsId !== undefined) await keepCallsId(row, callsId);
}

const codeOf = (err: unknown) => (err as { code?: unknown } | undefined)?.code;

const includes = (accounts: unknown, account: string) =>
  Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase());

async function keepCallsId(row: OwnerCallRow, callsId: string): Promise<void> {
  try {
    await markSent(row.connectionId, row.id, callsId);
  } catch (err) {
    log('warn', { msg: 'owner calls id not written, retrying', ownerCallId: row.id, callsId, error: errorLabel(err) });
    await markSent(row.connectionId, row.id, callsId);
  }
}

async function recordRefusal(row: OwnerCallRow, err: unknown): Promise<void> {
  const code = codeOf(err);
  if (code === USER_REJECTED) {
    await decline(row.connectionId, row.id, 'owner_declined');
    return;
  }
  if (typeof code === 'number') {
    await setCode(row.connectionId, row.id, `wallet_error:${code}`);
    return;
  }
  if (Date.now() < row.approveBy.getTime() - SESSION_END_MARGIN_MS) {
    await setCode(row.connectionId, row.id, 'wallet_error:unknown');
  }
}
