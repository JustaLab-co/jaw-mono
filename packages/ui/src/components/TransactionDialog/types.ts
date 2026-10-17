import { FeeTokenOption } from '../FeeTokenSelector';
import { AssetDelta } from '../../utils/assetPreview';
import { RevertCause } from '../../utils/transactionFailure';
import { PermissionProblem } from '../../utils/permissionExecution';

export interface TransactionData {
  to: string;
  data?: string;
  value?: string;
  chainId: number;
  // To check if needed
  stepId?: string;
  description?: string;
  action?: string;
}

export interface TransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Transaction data
  transactions: TransactionData[];

  // Wallet info
  walletAddress: string;

  // Gas estimation
  gasFee: string;
  gasFeeLoading: boolean;
  gasEstimationError: string;
  sponsored: boolean;

  // Asset preview (simulated balance changes)
  assetsOut?: AssetDelta[];
  assetsIn?: AssetDelta[];
  assetPreviewError?: boolean;
  assetPreviewWillRevert?: boolean;
  /** Why the simulation reverted, when known — lets a balance shortfall read as insufficient funds. */
  assetPreviewRevertCause?: RevertCause;

  /**
   * Permissioned execution (`capabilities.permissions.id`): the granter whose assets move, while
   * `walletAddress` is the spender that signs and pays the gas. Absent for an ordinary transaction.
   */
  onBehalfOf?: string;
  /** The granter is still being fetched — the row shows a placeholder rather than blocking. */
  onBehalfOfLoading?: boolean;
  /** A permission problem that makes this execution a certain revert. */
  permissionProblem?: PermissionProblem | null;

  // Actions
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  /** Set when the host can show Add Funds: a funds block then offers it instead of a dead end. */
  onAddFunds?: () => void;
  isProcessing: boolean;

  // Display utilities
  networkName: string;
  apiKey?: string;

  /** Requesting dApp: the header names it when `origin` is set too, and the processing screen shows its logo. */
  appName?: string;
  appLogoUrl?: string | null;
  origin?: string;
  /** Replaces the host under the app name. */
  originLabel?: string;

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
