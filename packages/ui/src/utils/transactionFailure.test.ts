import { describe, expect, it } from 'vitest';
import { ExecutionRevertedError, RpcRequestError } from 'viem';
import { getUserOperationError } from 'viem/account-abstraction';
import {
  INSUFFICIENT_FUNDS_ERROR,
  classifyRevert,
  isRevert,
  resolveBlockReason,
  resolveFeeBlock,
  type BlockReasonInput,
} from './transactionFailure';

/** A bundler JSON-RPC error as viem's `prepareUserOperation` throws it. */
const bundlerError = (code: number, message: string) =>
  getUserOperationError(new RpcRequestError({ body: {}, error: { code, message }, url: 'https://bundler.test' }), {
    callData: '0x',
    sender: '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b',
  } as Parameters<typeof getUserOperationError>[1]);

describe('classifyRevert', () => {
  it('recognises the real message viem produces for a token shortfall', () => {
    // Captured verbatim from simulateCalls against Circle USDC on Base Sepolia
    // (0x036CbD53842c5426634e7929541eC2318f3dCF7e), transferring more than the balance.
    // This is the exact shape the dialog receives, wrapper text and all.
    const real = new Error(
      'The contract function "<unknown>" reverted with the following reason:\n' +
        'ERC20: transfer amount exceeds balance\n\n' +
        'Contract Call:\n  address:  0x036CbD53842c5426634e7929541eC2318f3dCF7e\n\nVersion: viem@2.55.0'
    );
    expect(classifyRevert(real)).toBe('balance');
  });

  it('recognises balance shortfalls across common token implementations', () => {
    const balanceReverts = [
      // OpenZeppelin v4, decoded string revert
      'execution reverted: ERC20: transfer amount exceeds balance',
      'execution reverted: ERC20: burn amount exceeds balance',
      // OpenZeppelin v5 custom error, decoded by viem
      'reverted with the following reason: ERC20InsufficientBalance(0xabc, 0, 1000)',
      // ...and the same error left as raw data when the ABI is unavailable
      'execution reverted with data: 0xe450d38c0000000000000000000000000000000000000000000000000000000000000000',
      'execution reverted: insufficient balance',
      'execution reverted: Insufficient funds for transfer',
      'ds-token-insufficient-balance',
      'execution reverted: TRANSFER_FROM_FAILED',
      'execution reverted: SafeMath: subtraction overflow',
    ];
    for (const message of balanceReverts) {
      expect(classifyRevert(new Error(message)), message).toBe('balance');
    }
  });

  it('leaves every other revert as other', () => {
    const otherReverts = [
      'execution reverted: UniswapV2Router: EXPIRED',
      'execution reverted: Too little received',
      'execution reverted: Pausable: paused',
      'execution reverted: ERC20: insufficient allowance', // an approval problem, not a balance
      'execution reverted: ERC20InsufficientAllowance(0xabc, 0, 1000)',
      'execution reverted',
      '',
    ];
    for (const message of otherReverts) {
      expect(classifyRevert(new Error(message)), message).toBe('other');
    }
  });

  it('recognises a shortfall in a bundler estimation error', () => {
    // useGasEstimation runs the same classifier over the bundler's error, so the shortfall is
    // caught even where the asset simulation (eth_simulateV1) is unavailable.
    const bundlerErrors = [
      'UserOperation reverted during simulation with reason: AA23 reverted: ERC20: transfer amount exceeds balance',
      'execution reverted: AA23 reverted (or OOG): ERC20InsufficientBalance(0xabc, 0, 1000)',
    ];
    for (const message of bundlerErrors) {
      expect(classifyRevert(new Error(message)), message).toBe('balance');
    }
    // A generic AA23 with no balance evidence must stay 'other'.
    expect(classifyRevert(new Error('AA23 reverted (or OOG)'))).toBe('other');
  });

  it('tolerates non-Error inputs', () => {
    expect(classifyRevert(undefined)).toBe('other');
    expect(classifyRevert(null)).toBe('other');
    expect(classifyRevert('exceeds balance')).toBe('balance');
  });
});

const base: BlockReasonInput = {
  hasSelectablePaymentOption: true,
  gasEstimationError: '',
  sponsored: false,
  isPayingWithErc20: false,
};
const input = (over: Partial<BlockReasonInput> = {}): BlockReasonInput => ({ ...base, ...over });

describe('resolveBlockReason', () => {
  it('does not block a healthy transaction', () => {
    expect(resolveBlockReason(input())).toBeNull();
  });

  it('reports a reverting call as will-fail, not as insufficient funds', () => {
    // The regression this exists for: plenty of gas money, the call simply reverts.
    expect(resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas' }))).toBe('will-fail');
  });

  it('reports a genuine funding shortfall as funds', () => {
    expect(resolveBlockReason(input({ gasEstimationError: INSUFFICIENT_FUNDS_ERROR }))).toBe('funds');
    expect(resolveBlockReason(input({ hasSelectablePaymentOption: false }))).toBe('funds');
  });

  it('reports a revert caused by a balance shortfall as funds, not will-fail', () => {
    // Sending more of a token than the account holds: the estimator only ever says
    // "Failed to estimate gas", but the revert reason tells us it's a shortfall.
    expect(resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas', revertCause: 'balance' }))).toBe(
      'funds'
    );
  });

  it('keeps a revert with any other cause as will-fail', () => {
    expect(resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas', revertCause: 'other' }))).toBe(
      'will-fail'
    );
    // Unknown cause (simulation unavailable) must not be guessed at.
    expect(resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas' }))).toBe('will-fail');
  });

  it('reports a failed fee estimation on a funded token as estimation-failed, not funds', () => {
    // ETH is empty, so its leg ends in "Insufficient funds"; USDC has a balance but its estimation reverted.
    expect(
      resolveBlockReason(
        input({
          hasSelectablePaymentOption: false,
          gasEstimationError: INSUFFICIENT_FUNDS_ERROR,
          feeEstimationFailure: 'execution reverted',
        })
      )
    ).toBe('estimation-failed');
  });

  it('reports estimation-failed when dust ETH is selectable but short of the prefund', () => {
    expect(
      resolveBlockReason(
        input({
          hasSelectablePaymentOption: true,
          gasEstimationError: INSUFFICIENT_FUNDS_ERROR,
          feeEstimationFailure: 'execution reverted',
        })
      )
    ).toBe('estimation-failed');
  });

  it('reports will-fail when the calls revert for another reason and the fee estimation failed with them', () => {
    expect(
      resolveBlockReason(
        input({
          hasSelectablePaymentOption: false,
          gasEstimationError: 'Failed to estimate gas',
          feeEstimationFailure: 'execution reverted',
          revertCause: 'other',
        })
      )
    ).toBe('will-fail');
  });

  it('keeps funds when the asset itself is short, whatever the estimation said', () => {
    expect(
      resolveBlockReason(
        input({ hasSelectablePaymentOption: false, feeEstimationFailure: 'execution reverted', revertCause: 'balance' })
      )
    ).toBe('funds');
  });

  it('keeps funds when no fee token reports an estimation failure', () => {
    expect(
      resolveBlockReason(input({ hasSelectablePaymentOption: false, gasEstimationError: INSUFFICIENT_FUNDS_ERROR }))
    ).toBe('funds');
  });

  it('does not invent a block from a revert cause alone', () => {
    // A balance revert with a healthy estimate stays submittable — it is a warning, not a block.
    expect(resolveBlockReason(input({ revertCause: 'balance' }))).toBeNull();
  });

  it('prefers the funding cause when both are present', () => {
    // No payment option is what *caused* the estimation failure; "add funds" is the fix.
    expect(
      resolveBlockReason(input({ hasSelectablePaymentOption: false, gasEstimationError: 'Failed to estimate gas' }))
    ).toBe('funds');
  });

  it('ignores gas errors when the transaction is sponsored', () => {
    expect(resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas', sponsored: true }))).toBeNull();
    expect(resolveBlockReason(input({ gasEstimationError: INSUFFICIENT_FUNDS_ERROR, sponsored: true }))).toBeNull();
  });

  it('ignores gas errors while paying with an ERC-20 (the token quote governs)', () => {
    expect(
      resolveBlockReason(input({ gasEstimationError: 'Failed to estimate gas', isPayingWithErc20: true }))
    ).toBeNull();
  });

  it('still blocks a sponsored transaction that has no selectable payment option', () => {
    expect(resolveBlockReason(input({ hasSelectablePaymentOption: false, sponsored: true }))).toBe('funds');
  });
});

describe('resolveBlockReason gating matrix', () => {
  // Pins gating to the original predicate across every input combination.
  it('blocks exactly when the original expression did', () => {
    for (const hasSelectablePaymentOption of [true, false]) {
      for (const gasEstimationError of ['', 'Failed to estimate gas', INSUFFICIENT_FUNDS_ERROR]) {
        for (const sponsored of [true, false]) {
          for (const isPayingWithErc20 of [true, false]) {
            const args = { hasSelectablePaymentOption, gasEstimationError, sponsored, isPayingWithErc20 };
            const original = !hasSelectablePaymentOption || (!!gasEstimationError && !sponsored && !isPayingWithErc20);
            expect(resolveBlockReason(args) !== null, JSON.stringify(args)).toBe(original);
          }
        }
      }
    }
  });
});

// The prefund predicate in useGasEstimation is a substring match, so a bare 'insufficient'
// there also claimed the transaction's OWN reverts and answered them with a fee-token
// switch (clearing the error and showing a hardcoded fee). classifyRevert is what
// distinguishes the two, so these pin the strings on each side of that line.
describe('prefund shortfall vs the call reverting on its own terms', () => {
  it.each([
    'execution reverted: INSUFFICIENT_OUTPUT_AMOUNT',
    'execution reverted: INSUFFICIENT_LIQUIDITY',
    'ERC20: insufficient allowance',
    'InsufficientCollateral()',
  ])('a call-level revert containing "insufficient" is not a prefund shortfall: %s', (message) => {
    // These must NOT read as 'balance' either — they are neither a prefund problem nor an
    // asset shortfall the wallet can describe, so they fall through to a generic failure.
    expect(classifyRevert(new Error(message))).toBe('other');
  });

  it.each([
    'execution reverted: ERC20InsufficientBalance(0x..., 0, 100)',
    'execution reverted: insufficient balance',
    'transfer amount exceeds balance',
  ])('a genuine asset shortfall is classified as balance: %s', (message) => {
    expect(classifyRevert(new Error(message))).toBe('balance');
  });
});

describe('resolveFeeBlock', () => {
  const base = { gasEstimationError: '', sponsored: false, isPayingWithErc20: false };

  it('is payable while one token of several can pay', () => {
    const fee = resolveFeeBlock({ ...base, feeTokens: [{ isSelectable: false }, { isSelectable: true }] });
    expect(fee).toMatchObject({ blockReason: null, hasSelectablePaymentOption: true });
  });

  it('treats a list that has not loaded yet as payable', () => {
    expect(resolveFeeBlock({ ...base, feeTokens: [] }).blockReason).toBeNull();
    expect(resolveFeeBlock(base).blockReason).toBeNull();
  });

  it('reports the first recorded failure', () => {
    const fee = resolveFeeBlock({
      ...base,
      feeTokens: [{ isSelectable: false }, { isSelectable: false, estimationFailure: 'reverted' }],
    });
    expect(fee).toMatchObject({ blockReason: 'estimation-failed', feeEstimationFailure: 'reverted' });
  });

  it('reads a fee estimation that reverted as will-fail when no simulation ran', () => {
    const feeTokens = [{ isSelectable: false, estimationFailure: 'execution reverted', estimationReverted: true }];
    expect(resolveFeeBlock({ ...base, feeTokens }).blockReason).toBe('will-fail');
    expect(resolveFeeBlock({ ...base, feeTokens, revertCause: 'balance' }).blockReason).toBe('funds');
  });

  it('keeps a reverted fee estimation retryable when the simulation saw the calls succeed', () => {
    const feeTokens = [{ isSelectable: false, estimationFailure: 'reverted', estimationReverted: true }];
    expect(resolveFeeBlock({ ...base, feeTokens, callsSimulated: true }).blockReason).toBe('estimation-failed');
    expect(resolveFeeBlock({ ...base, feeTokens, callsSimulated: true, revertCause: 'other' }).blockReason).toBe(
      'will-fail'
    );
  });
});

describe('isRevert', () => {
  it('recognises a call revert the bundler reports during estimation', () => {
    expect(isRevert(bundlerError(-32521, 'execution reverted: paused'))).toBe(true);
  });

  it('recognises a call revert from an RPC node', () => {
    expect(isRevert(new ExecutionRevertedError({ message: 'execution reverted: paused' }))).toBe(true);
  });

  // These fail in the fee path, so the calls may be fine and a retry can still succeed.
  it.each([
    ['the paymaster validation reverting (AA33)', bundlerError(-32500, 'AA33 reverted 0x')],
    ['the account validation reverting (AA23)', bundlerError(-32500, 'AA23 reverted (or OOG)')],
    ['the token quote failing', new Error('pimlico_getTokenQuotes error: execution reverted')],
  ])('leaves %s retryable', (_label, error) => {
    expect(isRevert(error)).toBe(false);
  });

  it('leaves transport and service errors retryable', () => {
    expect(isRevert(new Error('HTTP request failed. Status: 503'))).toBe(false);
    expect(isRevert(new Error('The request took too long to respond.'))).toBe(false);
    expect(isRevert(undefined)).toBe(false);
  });

  it('returns on a cause chain that loops back', () => {
    const self = new Error('wrapper');
    self.cause = self;
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isRevert(self)).toBe(false);
    expect(isRevert(a)).toBe(false);
  });
});
