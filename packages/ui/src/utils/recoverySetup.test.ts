import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  computeRecoveryId,
  planRecoveryChanges,
  toOwnerBytes,
  type RecoveryChainConfig,
} from '@jaw.id/core';
import {
  formatRecoveryDelay,
  recoveryDelayWarning,
  recoveryMethodAddress,
  recoveryMethodLabel,
  recoveryRelayState,
  summarizeRecoveryChanges,
} from './recoverySetup';

const HOUR = 3600;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const ALICE = toOwnerBytes('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB = toOwnerBytes('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const CAROL = toOwnerBytes('0xcccccccccccccccccccccccccccccccccccccccc');
const PASSKEY = `0x${'44'.repeat(64)}` as const;

function registered(commitment: `0x${string}`, delay = 48 * HOUR) {
  return { recoveryId: computeRecoveryId(ACCOUNT, PROVIDER, commitment), provider: PROVIDER, commitment, delay };
}

describe('formatRecoveryDelay', () => {
  it.each([
    [0, '0h'],
    [30, '30 s'],
    [60, '1 min'],
    [90 * 60, '1.5h'],
    [24 * HOUR, '24h'],
    [48 * HOUR, '48h'],
    // The walkthrough's own example of a changed wait: "48h → 72h", not "3 days".
    [72 * HOUR, '72h'],
    [7 * 24 * HOUR, '7 days'],
    [14 * 24 * HOUR, '14 days'],
  ])('says %i seconds as %s', (seconds, text) => {
    expect(formatRecoveryDelay(seconds)).toBe(text);
  });
});

describe('recoveryDelayWarning', () => {
  // Advice only: the user may pick any wait, one guardian alone included.
  it('says nothing at 24h or more, however many guardians must agree', () => {
    expect(recoveryDelayWarning(24 * HOUR)).toBeNull();
    expect(recoveryDelayWarning(4 * 24 * HOUR)).toBeNull();
  });

  it('flags no waiting period', () => {
    expect(recoveryDelayWarning(0)).toBe('zero');
  });

  it('warns under 24h', () => {
    expect(recoveryDelayWarning(60)).toBe('short');
    expect(recoveryDelayWarning(4 * HOUR)).toBe('short');
  });

  it('says nothing while the threshold is not met', () => {
    expect(recoveryDelayWarning(null)).toBeNull();
  });
});

describe('recovery method labels', () => {
  it('names the signature provider by what signs', () => {
    expect(recoveryMethodLabel(PROVIDER, ALICE)).toBe('Wallet');
    expect(recoveryMethodLabel(PROVIDER, PASSKEY)).toBe('Passkey');
  });

  it('shows an unknown provider as its short address', () => {
    expect(recoveryMethodLabel('0x9999999999999999999999999999999999999999', ALICE)).toBe('0x9999...9999');
  });

  it('reads the address back out of a padded commitment, and none out of a passkey', () => {
    expect(recoveryMethodAddress(ALICE)).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(recoveryMethodAddress(PASSKEY)).toBeNull();
  });
});

describe('recoveryRelayState', () => {
  it.each([
    ['PENDING', 'updating'],
    ['CLAIMED', 'updating'],
    ['SUBMITTED', 'updating'],
    ['COMPLETED', 'active'],
    ['SKIPPED', 'up-to-date'],
    ['EXPIRED', 'failed'],
    ['DEAD', 'failed'],
  ] as const)('shows %s as %s', (status, state) => {
    expect(recoveryRelayState(status)).toBe(state);
  });
});

describe('summarizeRecoveryChanges', () => {
  const current: RecoveryChainConfig = {
    chainId: 84_532,
    deployed: true,
    enrolled: true,
    threshold: 2,
    recoveries: [registered(ALICE), registered(BOB)],
  };
  const summary = (recoveries: { commitment: `0x${string}`; delay: number }[], threshold: number) =>
    summarizeRecoveryChanges(current, planRecoveryChanges(current, { recoveries, threshold }));

  it('lists an added guardian once', () => {
    expect(
      summary(
        [
          { commitment: ALICE, delay: 48 * HOUR },
          { commitment: BOB, delay: 48 * HOUR },
          { commitment: CAROL, delay: 48 * HOUR },
        ],
        2
      )
    ).toEqual([{ kind: 'add', method: { commitment: CAROL, delay: 48 * HOUR, provider: PROVIDER } }]);
  });

  // The planner swaps a wait as a remove, an add and a threshold of one in between: the user
  // changed one wait, so one line, and the threshold they did not touch is not listed.
  it('reads a remove and re-add of the same guardian as one changed wait', () => {
    expect(
      summary(
        [
          { commitment: ALICE, delay: 72 * HOUR },
          { commitment: BOB, delay: 48 * HOUR },
        ],
        2
      )
    ).toEqual([
      { kind: 'delay', method: { commitment: ALICE, delay: 72 * HOUR, provider: PROVIDER }, from: 48 * HOUR },
    ]);
  });

  it('lists a removal and the threshold it lowers', () => {
    expect(summary([{ commitment: ALICE, delay: 48 * HOUR }], 1)).toEqual([
      { kind: 'remove', method: registered(BOB) },
      { kind: 'threshold', from: 2, to: 1 },
    ]);
  });

  it('lists nothing when nothing changed', () => {
    expect(
      summary(
        [
          { commitment: ALICE, delay: 48 * HOUR },
          { commitment: BOB, delay: 48 * HOUR },
        ],
        2
      )
    ).toEqual([]);
  });
});
