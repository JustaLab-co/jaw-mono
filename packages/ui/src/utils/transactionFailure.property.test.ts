import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  INSUFFICIENT_FUNDS_ERROR,
  resolveBlockReason,
  type BlockReason,
  type BlockReasonInput,
  type RevertCause,
} from './transactionFailure';

const healthy: BlockReasonInput = {
  hasSelectablePaymentOption: true,
  gasEstimationError: '',
  sponsored: false,
  isPayingWithErc20: false,
};

// What the dialog should say in situations a user actually reaches.
const scenarios: Array<[string, Partial<BlockReasonInput>, BlockReason]> = [
  ['ETH pays the fee', {}, null],
  [
    'the fee is sponsored and ETH estimation failed',
    { sponsored: true, gasEstimationError: 'Failed to estimate gas' },
    null,
  ],
  [
    'USDC pays while the ETH leg fell short',
    { isPayingWithErc20: true, gasEstimationError: INSUFFICIENT_FUNDS_ERROR },
    null,
  ],
  [
    'ETH and USDC are both empty',
    { hasSelectablePaymentOption: false, gasEstimationError: INSUFFICIENT_FUNDS_ERROR },
    'funds',
  ],
  ['USDC is quoted short and ETH is empty', { hasSelectablePaymentOption: false }, 'funds'],
  [
    'ETH is empty and the funded USDC failed to estimate',
    {
      hasSelectablePaymentOption: false,
      gasEstimationError: INSUFFICIENT_FUNDS_ERROR,
      feeEstimationFailure: 'reverted',
    },
    'estimation-failed',
  ],
  [
    'ETH is dust and the funded USDC failed to estimate',
    { gasEstimationError: INSUFFICIENT_FUNDS_ERROR, feeEstimationFailure: 'reverted' },
    'estimation-failed',
  ],
  ['ETH is dust and holds no fee token', { gasEstimationError: INSUFFICIENT_FUNDS_ERROR }, 'funds'],
  [
    'the transfer itself exceeds the balance while USDC failed to estimate',
    { hasSelectablePaymentOption: false, feeEstimationFailure: 'reverted', revertCause: 'balance' },
    'funds',
  ],
  [
    'the call reverts for another reason',
    { gasEstimationError: 'Failed to estimate gas', revertCause: 'other' },
    'will-fail',
  ],
  [
    'ETH estimation failed for another reason and USDC failed too',
    { gasEstimationError: 'Failed to estimate gas', feeEstimationFailure: 'reverted' },
    'will-fail',
  ],
];

describe('resolveBlockReason scenarios', () => {
  it.each(scenarios)('%s', (_name, over, expected) => {
    expect(resolveBlockReason({ ...healthy, ...over })).toBe(expected);
  });
});

const arbInput: fc.Arbitrary<BlockReasonInput> = fc.record({
  hasSelectablePaymentOption: fc.boolean(),
  gasEstimationError: fc.oneof(fc.constant(''), fc.constant(INSUFFICIENT_FUNDS_ERROR), fc.string()),
  sponsored: fc.boolean(),
  isPayingWithErc20: fc.boolean(),
  revertCause: fc.constantFrom<RevertCause | undefined>(undefined, 'balance', 'other'),
  feeEstimationFailure: fc.option(fc.string(), { nil: undefined }),
});

describe('resolveBlockReason properties', () => {
  it('says funds only with a shortfall signal: no payable option, a prefund shortfall or a balance revert', () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        if (resolveBlockReason(i) !== 'funds') return true;
        return (
          !i.hasSelectablePaymentOption ||
          i.gasEstimationError === INSUFFICIENT_FUNDS_ERROR ||
          i.revertCause === 'balance'
        );
      })
    );
  });

  it('never says estimation-failed on a balance revert', () => {
    fc.assert(
      fc.property(arbInput, (i) => resolveBlockReason({ ...i, revertCause: 'balance' }) !== 'estimation-failed')
    );
  });

  it('never says estimation-failed when no token recorded a failure', () => {
    fc.assert(
      fc.property(
        arbInput,
        (i) => resolveBlockReason({ ...i, feeEstimationFailure: undefined }) !== 'estimation-failed'
      )
    );
  });

  it('never says funds for a recorded failure unless the asset itself is short', () => {
    fc.assert(
      fc.property(arbInput, fc.string({ minLength: 1 }), (i, failure) => {
        const revertCause = i.revertCause === 'balance' ? 'other' : i.revertCause;
        return resolveBlockReason({ ...i, revertCause, feeEstimationFailure: failure }) !== 'funds';
      })
    );
  });

  it('never blocks a sponsored fee or an ERC-20 payment while an option can pay', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.boolean(),
        (i, sponsored) =>
          resolveBlockReason({ ...i, hasSelectablePaymentOption: true, sponsored, isPayingWithErc20: !sponsored }) ===
          null
      )
    );
  });

  it('always blocks when no option can pay', () => {
    fc.assert(fc.property(arbInput, (i) => resolveBlockReason({ ...i, hasSelectablePaymentOption: false }) !== null));
  });
});
