import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  computeRecoveryId,
  toOwnerBytes,
  type RecoveryChainConfig,
} from '@jaw.id/core';
import {
  formatRecoveryDelay,
  recoveryDelayWarning,
  recoveryMethodAddress,
  recoveryMethodLabel,
  recoveryRelayState,
  recoveryGuardianRows,
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

describe('recoveryGuardianRows', () => {
  const current: RecoveryChainConfig = {
    chainId: 84_532,
    deployed: true,
    enrolled: true,
    threshold: 2,
    recoveries: [registered(ALICE), registered(BOB)],
  };
  const rows = (recoveries: { commitment: `0x${string}`; delay: number }[]) =>
    recoveryGuardianRows(current, recoveries).map(({ method, change, fromDelay }) => ({
      commitment: method.commitment,
      change,
      ...(fromDelay !== undefined && { fromDelay }),
    }));

  // One list: the guardians after the change first, the ones it removes after them.
  it('lists the end state with what is new marked, then what goes', () => {
    expect(rows([{ commitment: CAROL, delay: 48 * HOUR }])).toEqual([
      { commitment: CAROL, change: 'added' },
      { commitment: ALICE, change: 'removed' },
      { commitment: BOB, change: 'removed' },
    ]);
  });

  it('leaves a guardian that stays unmarked', () => {
    expect(
      rows([
        { commitment: ALICE, delay: 48 * HOUR },
        { commitment: BOB, delay: 48 * HOUR },
        { commitment: CAROL, delay: 48 * HOUR },
      ])
    ).toEqual([
      { commitment: ALICE, change: null },
      { commitment: BOB, change: null },
      { commitment: CAROL, change: 'added' },
    ]);
  });

  it('marks a new wait with the old one', () => {
    expect(
      rows([
        { commitment: ALICE, delay: 72 * HOUR },
        { commitment: BOB, delay: 48 * HOUR },
      ])
    ).toEqual([
      { commitment: ALICE, change: 'delay', fromDelay: 48 * HOUR },
      { commitment: BOB, change: null },
    ]);
  });

  it('lists a first setup with nothing marked', () => {
    expect(recoveryGuardianRows(null, [{ commitment: CAROL, delay: 48 * HOUR }]).map((row) => row.change)).toEqual([
      null,
    ]);
  });
});
