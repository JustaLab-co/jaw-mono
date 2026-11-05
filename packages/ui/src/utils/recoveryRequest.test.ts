// The guardian's and the owner's vocabulary: when a request was opened, the soonest it could
// finish, what stops a guardian approving, and where a veto can land.
import { describe, it, expect } from 'vitest';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS, type CeremonyChain } from '@jaw.id/core';
import type { Hex } from 'viem';
import {
  formatRecoveryCouldFinish,
  formatRecoveryOpened,
  formatRecoveryOpenedAt,
  guardianApprovalBlock,
  recoveryCancellableChainIds,
} from './recoveryRequest';

const NOW = new Date(2026, 10, 4, 15, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const chain = (chainId: number, status: CeremonyChain['status'], executeAt: string | null = null): CeremonyChain => ({
  chainId,
  status,
  executeAt,
  requestTxHash: null,
  executeTxHash: null,
});

describe('when a request was opened', () => {
  it('reads today, yesterday, then the date, in a row and inside a sentence', () => {
    expect(formatRecoveryOpened(at(4, 14, 36), {}, NOW)).toBe('Today, 2:36 PM');
    expect(formatRecoveryOpened(at(4, 14, 35), { midSentence: true }, NOW)).toBe('today, 2:35 PM');
    expect(formatRecoveryOpened(at(3, 9, 2), {}, NOW)).toBe('Yesterday, 9:02 AM');
    expect(formatRecoveryOpened(at(1, 9, 2), { midSentence: true }, NOW)).toBe('1 Nov, 9:02 AM');
    expect(formatRecoveryOpenedAt(at(4, 14, 36), NOW)).toBe('today at 2:36 PM');
    expect(formatRecoveryOpenedAt(at(1, 9, 2), NOW)).toBe('on 1 Nov at 9:02 AM');
  });
});

describe('the soonest a request could finish', () => {
  const DAY2 = 172_800;

  it('counts the wait from the approvals still missing', () => {
    const collecting = { chains: [chain(8453, 'COLLECTING')], threshold: 3 };
    expect(formatRecoveryCouldFinish({ ...collecting, collected: 2 }, DAY2, NOW)).toBe('48h after the next approval');
    expect(formatRecoveryCouldFinish({ ...collecting, collected: 0 }, DAY2, NOW)).toBe('48h after 3 more approvals');
  });

  it('is the first network’s due time once one is waiting, else the wait from now', () => {
    const waiting = {
      chains: [chain(8453, 'REQUESTED', at(6, 14, 52)), chain(1, 'REQUESTED', at(6, 13, 10)), chain(10, 'PENDING')],
      collected: 2,
      threshold: 2,
    };
    expect(formatRecoveryCouldFinish(waiting, DAY2, NOW)).toBe('Fri 1:10 PM');
    expect(formatRecoveryCouldFinish({ ...waiting, chains: [chain(10, 'PENDING')] }, DAY2, NOW)).toBe('48h from now');
  });
});

describe('what stops a guardian approving', () => {
  const KEY = `0x${'51'.repeat(64)}` as Hex;
  const guardians = [
    {
      recoveryId: `0x${'01'.repeat(32)}` as Hex,
      provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
      commitment: KEY,
      delay: 0,
      approvedAt: null,
    },
  ];

  it('a known key that is none of the guardians, then a request that moved on', () => {
    const collecting = { guardians, chains: [chain(8453, 'COLLECTING')] };
    expect(guardianApprovalBlock(collecting, KEY.toUpperCase().replace('0X', '0x') as Hex)).toBeNull();
    expect(guardianApprovalBlock(collecting, `0x${'8f'.repeat(64)}`)).toBe('not-guardian');
    // A key not known here is core's to judge.
    expect(guardianApprovalBlock(collecting)).toBeNull();
    expect(guardianApprovalBlock({ guardians, chains: [chain(8453, 'REQUESTED')] }, KEY)).toBe('closed');
    expect(guardianApprovalBlock({ guardians, chains: [chain(8453, 'CANCELLED')] }, KEY)).toBe('closed');
  });
});

describe('where a veto can land', () => {
  it('the networks where the request is queued or waiting, as core relays it', () => {
    const chains = [chain(8453, 'REQUESTED'), chain(1, 'PENDING'), chain(10, 'EXECUTED'), chain(42_161, 'COLLECTING')];
    expect(recoveryCancellableChainIds({ chains })).toEqual([8453, 1]);
  });
});
