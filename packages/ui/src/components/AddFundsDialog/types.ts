export interface AddFundsDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * The destination, resolved by the wallet from the session. Never a value the
   * dapp supplied — see `resolveDestination` in core.
   */
  address: string;
  /** The chain the QR pins via EIP-681. */
  chainId: number;
  /** Mainnet RPC for reverse-resolving the destination to an ENS name. */
  mainnetRpcUrl: string;
  apiKey?: string;
  /** The app requesting funds, for the header. */
  appName?: string;
  /** Nullable because the handler config carries an explicit "no logo" as null. */
  appLogoUrl?: string | null;
  origin?: string;
  /**
   * The user is done. Deposits land off-app, so this is a normal finish rather
   * than a rejection, and the request resolves null.
   */
  onDone: () => void;
}
