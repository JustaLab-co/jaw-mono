import { ReactElement } from 'react';
import type { RecoveryConfig, RecoveryNetworksPlan, RecoverySetupResult } from '@jaw.id/core';
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

  // Where the change goes, from `Account.getRecoveryNetworks`
  /**
   * The networks the change is relayed to and why the others don't take it. Its base config is
   * what the change is planned from: a first setup when it holds no method, else an edit.
   */
  plan: RecoveryNetworksPlan | null;
  /** The networks read is still in flight. */
  isLoadingConfig?: boolean;
  /** A named reason this setup can't go ahead, resolved from the networks read. Blocks approval. */
  problem?: RecoverySetupProblem | null;

  // Network info
  networkName: string;
  chainId?: number;
  chainIcon?: ReactElement;
  apiKey?: string;

  // The flow: review → (activate) → sign → done
  /** Sign and send `config`. */
  onConfirm: () => void;
  /**
   * Send the one transaction that lets the connected network take a change, when no network can
   * yet. The screen reads the networks again once it lands.
   */
  onActivate?: () => void;
  onCancel: () => void;
  /** Done on the last screen, with the latest status per network; also the answer to a no-op. */
  onDone: (result: RecoverySetupResult) => void;

  // Status
  isProcessing: boolean;
  /** The activation transaction is being signed or landing. */
  isActivating?: boolean;
  status?: string;
  /** What the setup returned; shows the done screen. */
  result?: RecoverySetupResult | null;

  // Gas estimation props (the activation transaction only: every change is relayed, and JAW pays)
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
