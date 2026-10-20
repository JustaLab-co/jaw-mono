import type { ChainClients } from '@jaw.id/agent';
import { toHex, withTimeout } from 'viem';
import { z } from 'zod';
import type { Ask } from '@/connections/relay';
import { refusedBeforeSubmit, USER_REJECTED } from '@/connections/wallet-codes';
import { errorLabel, log } from '@/lib/edge';
import { decline, markSendStarted, markSent, setCode, type OwnerCallRow } from './store';

const SESSION_END_MARGIN_MS = 5_000;
const HEAD_TIMEOUT_MS = 3_000;

const sent = z.object({ id: z.string().min(1).max(256) });

/** Asks the owner's wallet for the account, then for the stored calls, and records what came back. */
export async function approve(ask: Ask, row: OwnerCallRow, clients: ChainClients): Promise<void> {
  let accounts: unknown;
  try {
    accounts = await ask('eth_requestAccounts', []);
  } catch (err) {
    await recordRefusal(row, err);
    return;
  }
  if (!includes(accounts, row.account)) {
    await decline(row, 'wrong_account');
    return;
  }
  if (!(await markSendStarted(row))) return;
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
    const code = codeOf(err);
    if (typeof code !== 'number') throw err;
    if (code === USER_REJECTED) await decline(row, 'owner_declined');
    else if (refusedBeforeSubmit(code)) await decline(row, `wallet_error:${code}`);
    return;
  }
  const callsId = sent.safeParse(answer).data?.id;
  if (callsId !== undefined) await keepCallsId(row, callsId, await headOf(row, clients));
}

const codeOf = (err: unknown) => (err as { code?: unknown } | undefined)?.code;

const includes = (accounts: unknown, account: string) =>
  Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase());

/** Where to start looking for the call on chain later. Null when the node does not answer: the send is recorded anyway. */
async function headOf(row: OwnerCallRow, clients: ChainClients): Promise<bigint | null> {
  try {
    const client = clients.publicClient(row.chainId);
    return await withTimeout(() => client.getBlockNumber({ cacheTime: 0 }), { timeout: HEAD_TIMEOUT_MS });
  } catch (err) {
    log('warn', { msg: 'owner calls head not read', ownerCallId: row.id, error: errorLabel(err) });
    return null;
  }
}

async function keepCallsId(row: OwnerCallRow, callsId: string, head: bigint | null): Promise<void> {
  try {
    await markSent(row, callsId, head);
  } catch (err) {
    log('warn', { msg: 'owner calls id not written, retrying', ownerCallId: row.id, callsId, error: errorLabel(err) });
    await markSent(row, callsId, head);
  }
}

async function recordRefusal(row: OwnerCallRow, err: unknown): Promise<void> {
  const code = codeOf(err);
  if (code === USER_REJECTED) {
    await decline(row, 'owner_declined');
    return;
  }
  if (typeof code === 'number') {
    await setCode(row, `wallet_error:${code}`);
    return;
  }
  if (Date.now() < row.approveBy.getTime() - SESSION_END_MARGIN_MS) {
    await setCode(row, 'wallet_error:unknown', { unlessRejoinable: true });
  }
  throw err;
}
