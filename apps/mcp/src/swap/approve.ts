import { setTimeout as sleep } from 'node:timers/promises';
import { toHex, type Address } from 'viem';
import { z } from 'zod';
import type { Ask } from '@/connections/relay';
import { errorLabel, log } from '@/lib/edge';
import type { BackendDeps } from './backend';
import type { DepositCall } from './check';
import {
  DEPOSIT_FAILED,
  DEPOSIT_REVERTED,
  markSendStarted,
  move,
  recordCallsId,
  recordCode,
  recordSentCode,
  recordTxHash,
  type SwapRow,
} from './store';
import { submit } from './track';

const POLL_MS = 2_000;
const PENDING = 100;
const MINED = 200;
const FAILED_OFF_CHAIN = 400;
const REVERTED = 500;
const USER_REJECTED = 4001;
const SESSION_END_MARGIN_MS = 5_000;

const sent = z.object({ id: z.string().min(1).max(256) });
const callsStatus = z.object({
  status: z.number(),
  receipts: z.array(z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })).optional(),
});

export async function approve(
  ask: Ask,
  row: SwapRow,
  account: Address,
  pollMs = POLL_MS,
  backend?: BackendDeps
): Promise<void> {
  const call = row.call as DepositCall;
  let accounts: unknown;
  try {
    accounts = await ask('eth_requestAccounts', []);
  } catch (err) {
    await recordRefusal(row, err);
    return;
  }
  if (!includes(accounts, account)) {
    await decline(row, 'wrong_account');
    return;
  }
  if (!(await markSendStarted(row.connectionId, row.id))) return;
  let answer: unknown;
  try {
    answer = await ask('wallet_sendCalls', [
      {
        version: '2.0.0',
        chainId: toHex(call.chainId),
        from: account,
        atomicRequired: true,
        calls: [{ to: call.to, data: call.data, value: call.value }],
      },
    ]);
  } catch (err) {
    if (codeOf(err) === USER_REJECTED) await decline(row, 'owner_declined');
    return;
  }
  const callsId = sent.safeParse(answer).data?.id;
  if (callsId === undefined || !(await keepCallsId(row, callsId))) return;
  for (;;) {
    const status = callsStatus.safeParse(await ask('wallet_getCallsStatus', [callsId]));
    if (!status.success) {
      await recordSentCode(row.connectionId, row.id, 'wallet_answer_unreadable');
      return;
    }
    const { status: code, receipts } = status.data;
    if (code === PENDING) {
      await sleep(pollMs);
      continue;
    }
    const hash = receipts?.[0]?.transactionHash;
    if (code === MINED) {
      if (!hash) return;
      const deposited = await recordTxHash(row.connectionId, row.id, hash);
      if (deposited) await submit(deposited, backend);
    } else if (code === FAILED_OFF_CHAIN) {
      await recordSentCode(row.connectionId, row.id, DEPOSIT_FAILED);
    } else if (code === REVERTED) {
      await recordSentCode(row.connectionId, row.id, DEPOSIT_REVERTED, hash);
    } else {
      await recordSentCode(row.connectionId, row.id, 'wallet_answer_unreadable');
    }
    return;
  }
}

const codeOf = (err: unknown) => (err as { code?: unknown } | undefined)?.code;

const includes = (accounts: unknown, account: Address) =>
  Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase());

async function decline(row: SwapRow, code: 'owner_declined' | 'wrong_account'): Promise<void> {
  if (await move(row.connectionId, row.id, ['awaiting_owner'], 'owner_declined', { code })) return;
  await recordCode(row.connectionId, row.id, code);
}

async function keepCallsId(row: SwapRow, callsId: string): Promise<SwapRow | undefined> {
  try {
    return await recordCallsId(row.connectionId, row.id, callsId);
  } catch (err) {
    log('warn', { msg: 'swap calls id not written, retrying', swapId: row.id, callsId, error: errorLabel(err) });
    return recordCallsId(row.connectionId, row.id, callsId);
  }
}

async function recordRefusal(row: SwapRow, err: unknown): Promise<void> {
  const code = codeOf(err);
  if (code === USER_REJECTED) {
    await decline(row, 'owner_declined');
    return;
  }
  if (typeof code === 'number') {
    await recordCode(row.connectionId, row.id, `wallet_error:${code}`);
    return;
  }
  if (Date.now() < (row.approveBy as Date).getTime() - SESSION_END_MARGIN_MS) {
    await recordCode(row.connectionId, row.id, 'wallet_error:unknown');
  }
}
