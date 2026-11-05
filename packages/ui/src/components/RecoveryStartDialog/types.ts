import type { Address, Hex } from 'viem';

export interface RecoveryStartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** The account the app named. Absent, the first screen asks for a name or an address. */
  account?: Address;
  /** The page guardians open; the request id is appended as a path segment. */
  approveUrl: string;
  appName?: string;
  appLogoUrl?: string | null;
  apiKey?: string;
  /** Ethereum mainnet RPC: names are resolved and shown from mainnet. */
  mainnetRpcUrl: string;

  // The flow: find the account → review → create the passkey → status
  /**
   * Create the new passkey and open the request (`Account.startRecovery`), for exactly the account
   * the review screen shows. `username` names the new passkey: the account's name, else its short
   * address.
   */
  onStart: (account: Address, username: string) => void;
  /** The passkey is being created and the request opened. */
  isStarting: boolean;
  /** Why the last start failed, shown on the review screen. */
  error?: string;
  /**
   * The request to follow: set once started, or when a passkey a recovery added signs in before
   * it finished. Shows its status instead of the start screens.
   */
  requestId?: Hex | null;

  /** Back to where the user came from (the sign-in screen). Absent, the first screen has no Back. */
  onBack?: () => void;
  /** The close button, and Cancel on the review screen when there is no Back. */
  onClose: () => void;
  /** Done on the status screen. */
  onDone: () => void;
  /** "Start again" after an ending. Absent, an ending offers Done. */
  onStartAgain?: () => void;
  /** "Open my account" once the recovery executed: sign in with the new passkey. */
  onOpenAccount: () => void;
  isOpeningAccount?: boolean;
  /**
   * The network "Open my account" signs in on. A request that executed only on other networks
   * shows those networks instead of a way in.
   */
  chainId?: number;
}
