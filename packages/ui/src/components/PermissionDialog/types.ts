import { ReactElement } from 'react';
import { FeeTokenOption } from '../FeeTokenSelector';
import type { RevocationProblem } from '../../utils/permissionExecution';

export interface SpendPermission {
  /** Scaled by the token's decimals, or raw base units when `decimalsUnknown`. */
  amount: string;
  amountUsd?: string;
  token: string;
  tokenAddress: string;
  duration: string;
  limit: string;
  /**
   * The token's `decimals()` couldn't be read, so `amount` is unscaled. The row must say so —
   * a guessed 18 would render a 100 USDC cap as "0.0000000001".
   */
  decimalsUnknown?: boolean;
  /**
   * The most this limit can move over the whole life of the permission, scaled the
   * same way `amount` is. `amount` is a rate, and the rate is not what is being
   * approved: 10 a day on a 30-day grant is 300, and that figure appeared nowhere.
   *
   * Absent when it cannot be sized (a unit we do not recognise, an expiry already
   * past) or when it would only repeat `amount`, as a `forever` limit does.
   */
  total?: string;
}

export interface CallPermission {
  target: string;
  selector?: string;
  functionSignature: string;
}

export interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Mode: grant for new permissions, revoke for existing
  mode: 'grant' | 'revoke';

  // Permission details
  permissionId?: string; // Only for revoke mode
  /**
   * Revoke only: a named reason this revocation would revert or achieve nothing, resolved from the
   * fetched permission. The mirror of the transaction screen's `permissionProblem`.
   */
  revocationProblem?: RevocationProblem | null;
  spenderAddress: string;
  /** The granting account — shown as "From", and seeds the processing screen's avatar. */
  accountAddress?: string;
  origin: string; // Requesting dApp origin
  appName?: string;
  appLogoUrl?: string | null;

  // Arrays of permissions
  spends?: SpendPermission[];
  calls?: CallPermission[];
  /**
   * Symbol/decimals for token addresses appearing in spends or call targets. `decimals: null`
   * means the read failed — only `symbol` is consumed here, but the shape matches the resolver's.
   */
  tokenMeta?: Record<string, { symbol: string; decimals?: number | null }>;

  // Period and expiry
  expiryDate: string; // Formatted expiry date
  /** Formatted grant date (revoke only) — the stored permission's `start`. */
  grantedDate?: string;

  // Network info
  networkName: string;
  chainId?: number;
  chainIcon?: ReactElement;
  apiKey?: string;

  // Actions
  onConfirm: () => void;
  onCancel: () => void;

  // Status
  isProcessing: boolean;
  status?: string;
  isLoadingTokenInfo?: boolean;

  // Gas estimation props
  gasFee?: string;
  gasFeeLoading?: boolean;
  gasEstimationError?: string;
  sponsored?: boolean;

  // Fee token selection (for ERC-20 paymaster)
  feeTokens?: FeeTokenOption[];
  feeTokensLoading?: boolean;
  selectedFeeToken?: FeeTokenOption | null;
  onFeeTokenSelect?: (token: FeeTokenOption) => void;
  showFeeTokenSelector?: boolean;

  // ERC-20 payment indicator (when user selected non-native token)
  isPayingWithErc20?: boolean;

  // RPC configuration
  mainnetRpcUrl: string;

  // Native currency symbol for the chain (e.g., 'FLR' for Flare, 'ETH' for Ethereum)
  nativeCurrencySymbol?: string;
}
