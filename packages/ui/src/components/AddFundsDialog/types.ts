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
  /**
   * The chains the dapp accepts deposits on, narrowing the icon stack.
   *
   * Undefined when the dapp named none, which is not the same as an empty list:
   * the stack then shows every chain the account works on.
   */
  chains?: number[];
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
