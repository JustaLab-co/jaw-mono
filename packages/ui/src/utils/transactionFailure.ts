// ============================================================================
// Why a transaction can't go through, and which of the two causes to report.
// ----------------------------------------------------------------------------
// Two detectors feed one conclusion: the asset simulation's revert reason, and the gas
// estimator's error. Both are read as strings because that is all viem and the bundler
// expose without an extra RPC round trip.
// ============================================================================

/**
 * `balance` — the account can't cover the asset it's spending, which a user reads as
 * "insufficient funds". `other` — any other revert (expired deadline, slippage, paused
 * contract), which must keep reading as a failure.
 */
export type RevertCause = 'balance' | 'other';

/** The `gasEstimationError` value that means a shortfall rather than a generic failure. */
export const INSUFFICIENT_FUNDS_ERROR = 'Insufficient funds';

/** Revert messages meaning "not enough of the asset", across common token implementations. */
const BALANCE_REVERT_PATTERNS = [
  'exceeds balance', // OZ v4: "ERC20: transfer amount exceeds balance"
  'insufficient balance',
  'insufficient funds',
  'insufficient-balance', // ds-token
  'erc20insufficientbalance', // OZ v5, decoded
  '0xe450d38c', // OZ v5 ERC20InsufficientBalance selector, when left as raw data
  'transfer_from_failed', // solmate
  'subtraction overflow', // pre-0.8 SafeMath underflow on a balance decrement
];

/**
 * Classify a revert from its reason. viem puts the decoded reason, or the raw error data when
 * it can't decode, in `error.message` — so one substring sweep covers both. Used on both
 * simulation failures and bundler estimation failures.
 */
export function classifyRevert(error: unknown): RevertCause {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const haystack = message.toLowerCase();
  return BALANCE_REVERT_PATTERNS.some((p) => haystack.includes(p)) ? 'balance' : 'other';
}

/**
 * The single reason a transaction can't be submitted, so the fee row, the fee-token picker and
 * the confirm button can't disagree about why.
 */
export type BlockReason =
  /** No fee token can cover the fee, or the account can't cover what it's spending. */
  | 'funds'
  /** Estimation failed, so no userOp can be built. */
  | 'will-fail'
  /** The account holds a fee token, but the paymaster estimation for it failed for another reason. */
  | 'estimation-failed'
  | null;

export interface BlockReasonInput {
  /** False when every offered fee token lacks the balance for the worst-case fee. */
  hasSelectablePaymentOption: boolean;
  gasEstimationError: string;
  sponsored: boolean;
  isPayingWithErc20: boolean;
  revertCause?: RevertCause;
  /** Why a fee token with a balance could not be estimated, when it was not a shortfall. */
  feeEstimationFailure?: string;
}

/** Funding outranks a revert: "add funds" is actionable, and a shortfall usually caused the revert. */
export function resolveBlockReason({
  hasSelectablePaymentOption,
  gasEstimationError,
  sponsored,
  isPayingWithErc20,
  revertCause,
  feeEstimationFailure,
}: BlockReasonInput): BlockReason {
  const gasError = !!gasEstimationError && !sponsored && !isPayingWithErc20;
  if (hasSelectablePaymentOption && !gasError) return null;

  // The unselectable token has a balance, so "add funds" would be the wrong remedy.
  if (!hasSelectablePaymentOption && feeEstimationFailure && revertCause !== 'balance') return 'estimation-failed';

  const shortfall =
    !hasSelectablePaymentOption || gasEstimationError === INSUFFICIENT_FUNDS_ERROR || revertCause === 'balance';
  return shortfall ? 'funds' : 'will-fail';
}
