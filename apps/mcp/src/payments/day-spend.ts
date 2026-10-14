import {
  readCurrentPeriods,
  sumSpentSince,
  sumToppedUpSince,
  type ChainClients,
  type OnChainPeriod,
  type X402LogEntry,
} from '@jaw.id/agent';
import type { Address } from 'viem';
import type { Grant } from '@/grants/store';

export interface DaySpend {
  paid: bigint;
  refilled: bigint;
  sentFromAccount: bigint;
}

const floorZero = (n: bigint) => (n > 0n ? n : 0n);

// A chain timestamp can be past what a Date holds (an open-ended permission), and toISOString throws on it.
export function isoOf(seconds: number): string | undefined {
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function daySpendOf(
  period: OnChainPeriod | undefined,
  entries: X402LogEntry[],
  scope: { permissionId: string; payer: Address }
): DaySpend | null {
  if (period?.status === 'outside-window') return { paid: 0n, refilled: 0n, sentFromAccount: 0n };
  if (period?.status !== 'ok') return null;
  const since = isoOf(period.start);
  const refilled = sumToppedUpSince(entries, scope, since);
  return {
    paid: sumSpentSince(entries, scope, since),
    refilled,
    sentFromAccount: floorZero(period.spend - refilled),
  };
}

export const dayLeft = (allowance: bigint, day: DaySpend) => floorZero(allowance - day.paid - day.sentFromAccount);

export async function readDaySpend(
  grant: Grant,
  payer: Address,
  entries: X402LogEntry[],
  clients: ChainClients
): Promise<DaySpend | null> {
  const target = { chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission };
  const [limit] = await readCurrentPeriods({ ...target, token: grant.token }, { clients });
  return daySpendOf(limit?.period, entries, { permissionId: grant.permissionId, payer });
}
