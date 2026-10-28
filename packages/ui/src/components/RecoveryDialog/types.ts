import { ReactElement } from 'react';
import type { RecoveryChainConfig, RecoveryConfig, RecoverySetupResult } from '@jaw.id/core';
import { FeeTokenOption } from '../FeeTokenSelector';
import type { RecoverySetupProblem } from '../../utils/recoverySetup';

export interface RecoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** The account being protected. */
  accountAddress: string;
  origin: string; // Requesting dApp origin
  appName?: string;
  appLogoUrl?: string | null;

  /** What the app asked for: the end state, shown for approval as it is. */
  config: RecoveryConfig;

  // The account's recovery config, from the configs read
  /** The config on the connected chain: a first setup when it holds no method, else an edit. */
  current: RecoveryChainConfig | null;
  /** The config on every supported chain: an edit reaches the deployed and enrolled ones. */
  chains: RecoveryChainConfig[];
  /** The configs read is still in flight. */
  isLoadingConfig?: boolean;
  /** A named reason this setup can't go ahead, resolved from the configs read. Blocks approval. */
  problem?: RecoverySetupProblem | null;

  // Network info
  networkName: string;
  chainId?: number;
  chainIcon?: ReactElement;
  apiKey?: string;

  // The flow: review → sign → done
  /** Sign and send `config`. */
  onConfirm: () => void;
  onCancel: () => void;
  /** Done on the last screen, with the latest status per network; also the answer to a no-op. */
  onDone: (result: RecoverySetupResult) => void;

  // Status
  isProcessing: boolean;
  status?: string;
  /** What the setup returned; shows the done screen. */
  result?: RecoverySetupResult | null;

  // Gas estimation props (first setup only: an edit is relayed, and JustaLab pays)
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
  isPayingWithErc20?: boolean;

  // RPC configuration
  mainnetRpcUrl: string;

  // Native currency symbol for the chain (e.g., 'FLR' for Flare, 'ETH' for Ethereum)
  nativeCurrencySymbol?: string;
}
