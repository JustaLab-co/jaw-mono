'use client';

import {
  LocalStorageAccount,
  OnboardingDialog,
  RecoveryWarning,
  type CreatedAccountData,
  toLocalStorageAccount,
  getLastAuthenticatedCredentialId,
  formatAddress,
  selectDefaultAccount,
  usePendingRecoveries,
  useReverseIdentity,
} from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useLogin, usePasskeyLogin, usePasskeys, useCreatePasskey, useAuth } from '../../hooks';
import { useState, useMemo } from 'react';
import {
  SUPPORTED_CHAINS,
  Chain,
  SubnameTextRecordCapabilityRequest,
  JAW_RPC_URL,
  RecoveryNotFinishedError,
  listCeremonies,
  type PasskeyAccount,
} from '@jaw.id/core';
import type { Address, Hex } from 'viem';
import { ChainId } from '../../utils/types';
import { RecoveryStartFlow, recoveryApproveUrl } from '../RecoveryStartModal';
import { RecoveryCancelFlow } from '../RecoveryCancelModal';

// Authenticated account data returned after successful login
export interface AuthenticatedAccount {
  address: `0x${string}`;
  credentialId: string;
  username: string;
  publicKey: `0x${string}`;
}

interface SignInScreenProps {
  onComplete: (account: AuthenticatedAccount) => void;
  ensConfig?: string;
  chainId?: ChainId;
  apiKey?: string;
  chainConfig?: { id: number; rpcUrl?: string; paymasterUrl?: string };
  subnameTextRecords?: SubnameTextRecordCapabilityRequest;
  origin?: string; // Origin for per-origin auth session
  /**
   * CredentialId to prefer as the "Continue as" default (embedded only: the
   * account the dApp is currently connected as, from the handshake hint).
   * Takes precedence over this partition's own last-authenticated marker,
   * which goes stale when an account switch happens in the popup's
   * first-party world (Safari routes credential methods there).
   */
  preferredCredentialId?: string;
  /** Escape hatch for contexts where passkey creation cannot run (Safari iframe) — see OnboardingDialogProps.onCreateNewAccount. */
  onCreateNewAccount?: () => void;
  /** Declines the pending request — forwarded to the dialog's close X. See OnboardingDialogProps.onClose. */
  onClose?: () => void;
  /** Open on the create view — see OnboardingDialogProps.startInCreate. */
  startInCreate?: boolean;
  /** The requesting dApp, named on the recovery screens. */
  appName?: string;
  appLogoUrl?: string;
}

/**
 * The request a passkey belongs to when it signs in before its recovery finished: the account's
 * newest request whose subject is this key, whatever its stage, so an ending shows too.
 */
async function recoveryRequestOf(error: RecoveryNotFinishedError, apiKey?: string): Promise<Hex | null> {
  const ceremonies = await listCeremonies(error.account, undefined, apiKey);
  return (
    ceremonies.find((ceremony) => ceremony.subject.toLowerCase() === error.publicKey.toLowerCase())?.requestId ?? null
  );
}

export function SignInScreen({
  onComplete,
  ensConfig,
  chainId,
  apiKey,
  chainConfig,
  subnameTextRecords,
  origin,
  preferredCredentialId,
  onCreateNewAccount,
  startInCreate,
  onClose,
  appName,
  appLogoUrl,
}: SignInScreenProps) {
  const { accounts, accountsLoading, refetchAccounts, restoreAccount } = usePasskeys({ apiKey });
  const { mutateAsync: login } = useLogin();
  const { mutateAsync: passkeyLogin, isPending: isImportingPasskey } = usePasskeyLogin();
  const { refetch: refetchAuth } = useAuth({ origin });
  const [loggingInAccount, setLoggingInAccount] = useState<string | null>(null);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return apiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [apiKey]);

  // The dApp's connected account (hint) outranks this partition's own
  // last-authenticated marker; selectDefaultAccount ignores it gracefully if
  // it doesn't match a listed account.
  const lastAuthenticatedCredentialId = useMemo(
    () => preferredCredentialId ?? getLastAuthenticatedCredentialId(apiKey),
    [preferredCredentialId, apiKey]
  );

  // The recovery flow, opened from "Lost your passkey?" or by a passkey a recovery added signing in
  // before it finished (then with its account and request). The pending request stays open
  // throughout: only signing in with the recovered passkey answers it, and Done declines it.
  const [recovery, setRecovery] = useState<{ account?: Address; requestId?: Hex } | null>(null);

  // The owner's warning: someone is recovering the account the welcome view offers. "Review and
  // cancel" opens the veto for the newest request; a request vetoed here is not warned about again
  // while its cancel is still landing.
  const [cancelling, setCancelling] = useState<{ requestId: Hex; account: PasskeyAccount } | null>(null);
  const [vetoed, setVetoed] = useState<Hex[]>([]);
  const localAccounts = useMemo(() => accounts.map(toLocalStorageAccount), [accounts]);
  const welcomeAccount = useMemo(
    () => selectDefaultAccount(localAccounts, lastAuthenticatedCredentialId),
    [localAccounts, lastAuthenticatedCredentialId]
  );
  const warnedAddress = welcomeAccount?.address as Address | undefined;
  const pendingRecoveries = usePendingRecoveries(warnedAddress, apiKey);
  const warnedIdentity = useReverseIdentity(warnedAddress, 1, mainnetRpcUrl);
  const newestPending = pendingRecoveries
    ?.filter((entry) => !vetoed.some((id) => id.toLowerCase() === entry.requestId.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const warnedAccount = welcomeAccount && accounts.find((a) => a.credentialId === welcomeAccount.credentialId);

  // Safari can't create a passkey in the embedded dialog, and a recovery start creates one: it
  // continues in the popup, switched within this click as account creation is (onCreateNewAccount).
  // The popup opens on the sign-up view, which carries the same link.
  const openRecovery = onCreateNewAccount ?? (() => setRecovery({}));

  debugLog('✅ OnboardingSection: ENS Config =', ensConfig || 'NOT PROVIDED');
  debugLog('✅ OnboardingSection: ChainId =', chainId || 'NOT PROVIDED');
  debugLog('✅ OnboardingSection: ApiKey =', apiKey ? 'PROVIDED' : 'NOT PROVIDED');
  debugLog('✅ OnboardingSection: SubnameTextRecords =', subnameTextRecords);

  const { mutateAsync: register, isPending: isCreatingPasskey } = useCreatePasskey();

  // The chain a sign-in restores the account on: the request's, else the dialog's default.
  const resolveTargetChain = (): Chain => {
    if (chainConfig && chainConfig.rpcUrl) {
      return {
        id: chainConfig.id,
        rpcUrl: chainConfig.rpcUrl,
        ...(chainConfig.paymasterUrl && { paymaster: { url: chainConfig.paymasterUrl } }),
      };
    }
    const fallbackChain = SUPPORTED_CHAINS.find((chain) => chain.id === (chainId ?? 1));
    if (!fallbackChain) {
      throw new Error(`Chain ${chainId ?? 1} is not supported`);
    }
    return { id: fallbackChain.id };
  };

  // A passkey a recovery added, signing in before the recovery finished: show where its request
  // stands instead of the sign-in screen. Any other failure stays on the sign-in screen, as before.
  const showRecoveryOf = async (error: unknown) => {
    if (!(error instanceof RecoveryNotFinishedError)) return;
    try {
      const requestId = await recoveryRequestOf(error, apiKey);
      if (requestId) setRecovery({ account: error.account, requestId });
    } catch (lookupError) {
      console.error('❌ Recovery request lookup failed:', lookupError);
    }
  };

  const handleAccountSelect = async (account: LocalStorageAccount) => {
    try {
      if (!account.credentialId) {
        throw new Error('Credential ID is required');
      }
      setLoggingInAccount(account.username);

      const targetChain = resolveTargetChain();

      const result = await login({
        chainId: targetChain,
        credentialId: account.credentialId,
        isImported: account.isImported,
        apiKey,
      });

      // Find the full account data to get publicKey
      const fullAccount = accounts.find((a) => a.credentialId === account.credentialId);

      const authenticatedAccount: AuthenticatedAccount = {
        address: result.address as `0x${string}`,
        credentialId: account.credentialId,
        username: result.username || account.username,
        publicKey: (fullAccount?.publicKey || '') as `0x${string}`,
      };

      onComplete(authenticatedAccount);
    } catch (error) {
      console.error('❌ Login failed:', error);
      setLoggingInAccount(null);
      await showRecoveryOf(error);
    }
  };

  const handleCreateAccount = async (username: string): Promise<CreatedAccountData> => {
    try {
      if (!username || username.trim().length === 0) {
        console.error('❌ Username is required');
        throw new Error('Username is required');
      }

      const fullUsername = ensConfig ? `${username.trim()}.${ensConfig}` : username.trim();

      const result = await register({ username: fullUsername, apiKey, defaultChainId: chainId });

      if (!result.address) {
        throw new Error('Failed to get address from passkey registration');
      }

      // Return full account data - OnboardingDialog will pass it to onAccountCreationComplete
      return {
        address: result.address,
        credentialId: result.credentialId,
        username: fullUsername,
        publicKey: result.publicKey,
      };
    } catch (error) {
      console.error('❌ Error details:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const handleAccountCreationComplete = async (accountData: CreatedAccountData) => {
    // Refetch to update the accounts list
    await refetchAccounts();
    await refetchAuth();

    // Account data flows through from onCreateAccount - no intermediate state needed
    const authenticatedAccount: AuthenticatedAccount = {
      address: accountData.address as `0x${string}`,
      credentialId: accountData.credentialId,
      username: accountData.username,
      publicKey: accountData.publicKey,
    };

    onComplete(authenticatedAccount);
  };

  const handleImportAccount = async () => {
    try {
      const result = await passkeyLogin({ apiKey, defaultChainId: chainId });

      // Refetch accounts to get the full account data including publicKey
      const accountsResult = await refetchAccounts();
      const importedAccount = (accountsResult.data || []).find((a) => a.credentialId === result.credentialId);

      if (!importedAccount) {
        console.error('❌ Could not find imported account');
        return;
      }

      const authenticatedAccount: AuthenticatedAccount = {
        address: result.address as `0x${string}`,
        credentialId: result.credentialId,
        username: importedAccount.username,
        publicKey: importedAccount.publicKey as `0x${string}`,
      };

      // Signed in: a recovery screen this opened from is done with.
      setRecovery(null);
      onComplete(authenticatedAccount);
    } catch (error) {
      console.error('❌ Import failed:', error);
      await showRecoveryOf(error);
    }
  };

  if (accountsLoading) {
    return null;
  }

  if (cancelling) {
    const { requestId, account } = cancelling;
    return (
      <RecoveryCancelFlow
        requestId={requestId}
        // Restored with no prompt: the cancel signature that follows is the one prompt.
        openAccount={() => restoreAccount(resolveTargetChain(), account.credentialId, account.publicKey, apiKey)}
        apiKey={apiKey}
        origin={origin || ''}
        appName={appName}
        appLogoUrl={appLogoUrl}
        // The request is still open: Not now and Done go back to it, and a failure stays on screen.
        onClose={() => setCancelling(null)}
        onDone={() => {
          setVetoed((ids) => [...ids, requestId]);
          setCancelling(null);
        }}
      />
    );
  }

  if (recovery) {
    // Done ends the pending request as cancelled: nothing signed in.
    const decline = onClose ?? (() => setRecovery(null));
    return (
      <RecoveryStartFlow
        account={recovery.account}
        requestId={recovery.requestId}
        approveUrl={recoveryApproveUrl()}
        chainId={chainConfig?.id ?? chainId ?? 1}
        apiKey={apiKey}
        appName={appName}
        appLogoUrl={appLogoUrl}
        onStarted={(ceremony) => setRecovery((current) => ({ ...current, requestId: ceremony.requestId }))}
        onBack={() => setRecovery(null)}
        onClose={decline}
        onDone={decline}
        onStartAgain={onCreateNewAccount ?? (() => setRecovery((current) => ({ account: current?.account })))}
        onOpenAccount={handleImportAccount}
        isOpeningAccount={isImportingPasskey}
      />
    );
  }

  return (
    <OnboardingDialog
      onClose={onClose}
      onLostPasskey={openRecovery}
      notice={
        newestPending && warnedAccount ? (
          <RecoveryWarning
            request={newestPending}
            accountName={warnedIdentity.plainName ?? (warnedAccount.username || formatAddress(warnedAddress ?? ''))}
            onReview={() => setCancelling({ requestId: newestPending.requestId, account: warnedAccount })}
          />
        ) : undefined
      }
      accounts={localAccounts}
      onAccountSelect={handleAccountSelect}
      loggingInAccount={loggingInAccount}
      onImportAccount={handleImportAccount}
      isImporting={isImportingPasskey}
      onCreateNewAccount={onCreateNewAccount}
      startInCreate={startInCreate}
      onCreateAccount={handleCreateAccount}
      onAccountCreationComplete={handleAccountCreationComplete}
      isCreating={isCreatingPasskey}
      ensDomain={ensConfig}
      chainId={chainId}
      mainnetRpcUrl={mainnetRpcUrl}
      apiKey={apiKey}
      lastAuthenticatedCredentialId={lastAuthenticatedCredentialId}
      supportedChains={SUPPORTED_CHAINS.map((chain) => ({ id: chain.id }))}
      subnameTextRecords={subnameTextRecords}
    />
  );
}
