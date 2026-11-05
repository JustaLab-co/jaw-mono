import type { Ceremony, CeremonyApproval, CeremonyListEntry } from '@jaw.id/core';
import type { Address } from 'viem';
import type { GuardianApprovalBlock } from '../../utils/recoveryRequest';

export interface GuardianApproveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** Requesting dApp origin */
  origin: string;
  appName?: string;
  appLogoUrl?: string | null;
  /** Ethereum mainnet RPC: names are shown from mainnet. */
  mainnetRpcUrl: string;

  /** The request as the backend holds it (`useRecoveryRequest`); null until the first read lands. */
  ceremony: Ceremony | null;
  /** The last read failed. */
  failed?: boolean;
  /**
   * The account's requests that can still complete (`usePendingRecoveries`). More than one is
   * said, with when each was opened.
   */
  openRequests?: CeremonyListEntry[] | null;
  /** The signed-in guardian, approving. */
  guardian: Address;
  /**
   * What stops this guardian approving (`guardianApprovalBlock`, or core refusing the key); null
   * when nothing does. A blocked request shows why and offers only Close.
   */
  block?: GuardianApprovalBlock | null;

  // The flow: review → approve → approved
  /** Sign the approval for the request on screen (`Account.approveRecovery`). */
  onApprove: () => void;
  isApproving: boolean;
  /** What the approval returned; shows the approved screen with the count. */
  approval?: CeremonyApproval | null;
  /** Why the last approval failed, shown on the review screen. */
  error?: string;
  /** Cancel, the close button, and Close on a request this guardian can't approve. */
  onCancel: () => void;
  /** Done on the approved screen. */
  onDone: () => void;
}
