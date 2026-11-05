import type { Ceremony, RecoverySetupResult } from '@jaw.id/core';

export interface RecoveryCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** Requesting dApp origin */
  origin: string;
  appName?: string;
  appLogoUrl?: string | null;
  apiKey?: string;
  /** Ethereum mainnet RPC: names are shown from mainnet. */
  mainnetRpcUrl: string;

  /** The request as the backend holds it (`useRecoveryRequest`); null until the first read lands. */
  ceremony: Ceremony | null;
  /** The last read failed. */
  failed?: boolean;

  // The flow: review → sign → outcome per network
  /** Veto the request on screen (`Account.cancelRecovery`). */
  onConfirm: () => void;
  /** The veto is being signed and relayed. */
  isCancelling: boolean;
  /** What the cancel returned; shows the outcome per network. */
  result?: RecoverySetupResult | null;
  /** Why the last cancel failed, shown on the review screen. */
  error?: string;
  /** Not now, and the close button before anything is signed. */
  onCancel: () => void;
  /** Done on the outcome screen, with the latest status per network. */
  onDone: (result: RecoverySetupResult) => void;
}
