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

/** The text of a rejection: the value itself when it is a string, else its `message`. */
export function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Classify a revert from its reason. viem puts the decoded reason, or the raw error data when
 * it can't decode, in `error.message` — so one substring sweep covers both. Used on both
 * simulation failures and bundler estimation failures.
 */
export function classifyRevert(error: unknown): RevertCause {
  const haystack = messageOf(error).toLowerCase();
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

/**
 * Funding outranks a revert: "add funds" is actionable, and a shortfall usually caused the revert.
 * A funded token that failed to estimate outranks a shortfall that only the fee shows, because
 * that token might pay once the estimation works.
 */
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

  if (revertCause === 'balance') return 'funds';

  // No option can pay, or the ETH leg fell short of the prefund (dust ETH stays selectable).
  const feeShort = !hasSelectablePaymentOption || gasEstimationError === INSUFFICIENT_FUNDS_ERROR;
  if (feeShort && feeEstimationFailure) return 'estimation-failed';
  return feeShort ? 'funds' : 'will-fail';
}

/** The fee-token facts the block reason depends on. */
interface FeeTokenFacts {
  isSelectable: boolean;
  estimationFailure?: string;
}

/**
 * The block reason read from the fee-token list, shared by every dialog with a fee row so a
 * blocked fee reads the same on each. A list that has not loaded yet counts as payable.
 */
export function resolveFeeBlock({
  feeTokens,
  ...input
}: Omit<BlockReasonInput, 'hasSelectablePaymentOption' | 'feeEstimationFailure'> & {
  feeTokens?: FeeTokenFacts[];
}) {
  const hasSelectablePaymentOption = !feeTokens?.length || feeTokens.some((t) => t.isSelectable);
  const feeEstimationFailure = feeTokens?.find((t) => t.estimationFailure)?.estimationFailure;
  const blockReason = resolveBlockReason({ ...input, hasSelectablePaymentOption, feeEstimationFailure });
  return { blockReason, hasSelectablePaymentOption, feeEstimationFailure };
}
