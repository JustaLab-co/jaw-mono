import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  INSUFFICIENT_FUNDS_ERROR,
  resolveBlockReason,
  type BlockReason,
  type BlockReasonInput,
  type RevertCause,
} from './transactionFailure';

// The oracle restates the fee-block rules in their own terms:
// - nothing blocks while a fee option is selectable and no counted gas error exists;
// - a funded token that failed to estimate, with the asset itself not short, is an estimation failure;
// - otherwise a real shortfall signal reads as funds, and anything else as will-fail.
// A failure is recorded as a non-empty string; '' and undefined both mean none was recorded.
function oracle(i: BlockReasonInput): BlockReason {
  const gasErrorCounts = i.gasEstimationError !== '' && !i.sponsored && !i.isPayingWithErc20;
  if (i.hasSelectablePaymentOption && !gasErrorCounts) return null;

  const fundedTokenFailed =
    !i.hasSelectablePaymentOption && (i.feeEstimationFailure ?? '') !== '' && i.revertCause !== 'balance';
  if (fundedTokenFailed) return 'estimation-failed';

  const shortfall =
    !i.hasSelectablePaymentOption || i.gasEstimationError === INSUFFICIENT_FUNDS_ERROR || i.revertCause === 'balance';
  return shortfall ? 'funds' : 'will-fail';
}

const revertCauses: Array<RevertCause | undefined> = [undefined, 'balance', 'other'];
const gasErrors = ['', INSUFFICIENT_FUNDS_ERROR, 'Failed to estimate gas'];
const failures = [undefined, '', ' ', '\n', 'execution reverted'];

function* domain(): Generator<BlockReasonInput> {
  for (const hasSelectablePaymentOption of [true, false])
    for (const gasEstimationError of gasErrors)
      for (const sponsored of [true, false])
        for (const isPayingWithErc20 of [true, false])
          for (const revertCause of revertCauses)
            for (const feeEstimationFailure of failures)
              yield {
                hasSelectablePaymentOption,
                gasEstimationError,
                sponsored,
                isPayingWithErc20,
                revertCause,
                feeEstimationFailure,
              };
}

const arbInput: fc.Arbitrary<BlockReasonInput> = fc.record({
  hasSelectablePaymentOption: fc.boolean(),
  gasEstimationError: fc.oneof(fc.constant(''), fc.constant(INSUFFICIENT_FUNDS_ERROR), fc.string()),
  sponsored: fc.boolean(),
  isPayingWithErc20: fc.boolean(),
  revertCause: fc.constantFrom<RevertCause | undefined>(...revertCauses),
  feeEstimationFailure: fc.option(fc.oneof(fc.constant(''), fc.string(), fc.string({ unit: 'binary' })), {
    nil: undefined,
  }),
});

describe('resolveBlockReason over its whole finite domain', () => {
  it('agrees with the spec oracle on every input', () => {
    let count = 0;
    for (const i of domain()) {
      expect(resolveBlockReason(i), JSON.stringify(i)).toBe(oracle(i));
      count++;
    }
    expect(count).toBe(2 * 3 * 2 * 2 * 3 * failures.length);
  });

  it('reaches every reason, so the table is not degenerate', () => {
    const seen = new Set([...domain()].map(resolveBlockReason));
    expect(seen).toEqual(new Set([null, 'funds', 'will-fail', 'estimation-failed']));
  });
});

describe('resolveBlockReason properties', () => {
  it('matches the oracle for arbitrary error strings', () => {
    fc.assert(fc.property(arbInput, (i) => resolveBlockReason(i) === oracle(i)));
  });

  it('says funds only when a real shortfall signal is present', () => {
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

  it('never says funds for a funded token whose estimation failed without a balance revert', () => {
    fc.assert(
      fc.property(arbInput, fc.string({ minLength: 1 }), (i, failure) => {
        const reason = resolveBlockReason({
          ...i,
          hasSelectablePaymentOption: false,
          feeEstimationFailure: failure,
          revertCause: i.revertCause === 'balance' ? 'other' : i.revertCause,
        });
        return reason === 'estimation-failed';
      })
    );
  });

  it('never says estimation-failed when the asset itself is short', () => {
    fc.assert(
      fc.property(arbInput, (i) => resolveBlockReason({ ...i, revertCause: 'balance' }) !== 'estimation-failed')
    );
  });

  it('returns null exactly when an option is selectable and no gas error counts', () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const gasErrorCounts = i.gasEstimationError !== '' && !i.sponsored && !i.isPayingWithErc20;
        return (resolveBlockReason(i) === null) === (i.hasSelectablePaymentOption && !gasErrorCounts);
      })
    );
  });
});
