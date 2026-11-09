import type { SubnameTextRecordCapabilityRequest } from '@jaw.id/core';

export interface LocalStorageAccount {
  username: string;
  creationDate: Date;
  credentialId?: string;
  isImported?: boolean;
  /** Smart-account address; absent on records stored before it was persisted. */
  address?: string;
}

/**
 * Data returned from account creation, passed through to completion handler.
 * This allows data to flow naturally through callbacks without intermediate state.
 */
export interface CreatedAccountData {
  address: string;
  credentialId: string;
  username: string;
  publicKey: `0x${string}`;
}

export interface OnboardingDialogProps {
  // Account list section
  accounts: LocalStorageAccount[];
  onAccountSelect: (account: LocalStorageAccount) => Promise<void>;
  loggingInAccount: string | null;

  // Import existing account section
  onImportAccount: () => void;
  isImporting: boolean;

  /**
   * Overrides the Welcome card's "Create new account" navigation. Hosts set
   * this when passkey creation cannot run in the current context (Safari
   * blocks WebAuthn create() in cross-origin iframes) and the flow must
   * escape to a popup — invoked synchronously from the click so the popup
   * opens within the user-activation window.
   */
  onCreateNewAccount?: () => void;

  /** Open on the sign-in/create view even when a default account exists (popup opened via the Safari create escape). */
  startInCreate?: boolean;

  /**
   * Declines the connect request — the host's existing reject path (userRejected), surfaced as the
   * shell's top-right X. Hidden automatically while a passkey ceremony is running: settling the
   * request under a live WebAuthn prompt would leave the prompt orphaned.
   */
  onClose?: () => void;

  // Create new account section
  onCreateAccount: (username: string) => Promise<CreatedAccountData>;
  onAccountCreationComplete: (account: CreatedAccountData) => Promise<void>;
  /**
   * Called when the create flow fails after onCreateAccount resolved (e.g. subname
   * registration), so hosts managing isCreating themselves can reset it.
   */
  onAccountCreationError?: (error: unknown) => void;
  isCreating: boolean;

  // Configuration
  ensDomain?: string;
  chainId?: number;
  mainnetRpcUrl: string;
  apiKey?: string; // API key for JustaName API authentication (xApiKey header)
  /**
   * credentialId of the currently-authenticated account (from jaw:passkey:authState).
   * Used to pick the "Continue with X" default. When it does not match any stored
   * account, the most recently created account is used instead.
   */
  lastAuthenticatedCredentialId?: string | null;
  supportedChains?: Array<{ id: number }>;
  subnameTextRecords?: SubnameTextRecordCapabilityRequest;

  /** Address the request is for. Preselected when stored here, and named on the screen. */
  expectedAccount?: string;
  /** The account the user ended on when it is not the expected one. Shows the screen naming both. */
  mismatchedAccount?: { address: string; name?: string };
  /** "Use another passkey" on the mismatch screen: back to the sign-in view. */
  onRetryAccount?: () => void;
}
