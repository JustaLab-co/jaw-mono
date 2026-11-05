import { JSX } from 'react';
export interface SiweDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Message data
  message: string;
  origin: string;

  // App information
  appName: string;
  appLogoUrl?: string;

  accountAddress?: string;
  chainName?: string;
  chainId?: number;
  chainIcon?: JSX.Element;

  // Actions
  onSign: () => Promise<void>;
  onCancel: () => void;

  // Status
  isProcessing: boolean;
  /** After the signature is delivered — shows the "Signed in ✓" beat before the dialog closes. */
  isSuccess?: boolean;
  siweStatus: string;
  canSign: boolean;

  // Security warning for origin mismatch
  warningMessage?: string;

  /**
   * Asks the user to check the request code against the page that sent them, for a caller
   * that has such a page (the keys popup). Never shown alongside `warningMessage`, since
   * there the sending page wrote the code.
   */
  requestCodeHint?: boolean;

  // RPC configuration
  mainnetRpcUrl: string;
}
