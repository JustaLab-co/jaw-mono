'use client';

import { RecoveryStartDialog } from '@jaw.id/ui';
import {
  Account,
  JAW_RPC_URL,
  normalizeStartRecoveryParams,
  standardErrorCodes,
  type Chain,
  type CreatedCeremony,
} from '@jaw.id/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { usePasskeyLogin } from '../../hooks';
import { apiKeyFromChain } from '../../lib/api-key';
import { debugLog } from '../../lib/debug-log';

/** The guardian page on this keys deployment; the request id is appended as a path segment. */
export const RECOVERY_APPROVE_PATH = '/recover/approve';

/**
 * The page guardians open: the one the SDK sent (the app's `recoveryApproveUrl`), else this keys
 * deployment's own guardian page.
 */
export function recoveryApproveUrl(sent?: unknown): string {
  if (typeof sent === 'string' && sent) return sent;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://keys.jaw.id';
  return `${origin}${RECOVERY_APPROVE_PATH}`;
}

export interface RecoveryStartFlowProps {
  /** The account to recover, when the request or a sign-in names it. Absent, the first screen asks. */
  account?: Address;
  /** The request to follow: set once started, or when a passkey a recovery added signs in early. */
  requestId?: Hex | null;
  approveUrl: string;
  /** The network the flow runs on: the one "Open my account" signs in on. */
  chainId: number;
  apiKey?: string;
  appName?: string;
  appLogoUrl?: string | null;
  /** The request exists: answer now. The status stays on screen until Done. */
  onStarted: (ceremony: CreatedCeremony) => void;
  /** The start failed. Absent, the error stays on screen for another try. */
  onFailed?: (error: Error, errorCode: number) => void;
  /** Back to the sign-in screen. Absent, the first screen has no Back. */
  onBack?: () => void;
  /** The close button before anything was started. */
  onClose: () => void;
  /** Done on the status screen, and the close button once there is a request. */
  onDone: () => void;
  /** "Start again" after an ending. Absent, an ending offers Done. */
  onStartAgain?: () => void;
  /** "Open my account" once the recovery executed: sign in with the new passkey. */
  onOpenAccount: () => void;
  isOpeningAccount?: boolean;
}

/**
 * The recovering user's screens in keys' conventions, shared by `wallet_startRecovery` and the
 * connect screen's "Lost your passkey?": find the account, create the new passkey and open the
 * request, then follow it. What an answer, a failure and Done mean is the caller's.
 *
 * The new passkey is made with keys' own rpId (this page's hostname), never the dApp's: it is a
 * keys passkey, like one made at sign-up. The account the review screen shows is exactly the one
 * `Account.startRecovery` gets.
 */
export function RecoveryStartFlow({
  account,
  requestId,
  approveUrl,
  chainId,
  apiKey,
  appName,
  appLogoUrl,
  onStarted,
  onFailed,
  onBack,
  onClose,
  onDone,
  onStartAgain,
  onOpenAccount,
  isOpeningAccount,
}: RecoveryStartFlowProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');
  // Synchronous re-entry guard: one tap, one passkey and one request.
  const submittingRef = useRef(false);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return apiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [apiKey]);

  const handleStart = useCallback(
    async (target: Address, username: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setIsStarting(true);
      setError('');
      try {
        const started = await Account.startRecovery(
          { chainId, apiKey, rpId: window.location.hostname, rpName: 'JAW' },
          { account: target, username }
        );
        // What wallet_startRecovery returns: the request as created, not the new passkey's details.
        onStarted({
          requestId: started.requestId,
          account: started.account,
          subject: started.subject,
          salt: started.salt,
          expiry: started.expiry,
        });
      } catch (startError) {
        console.error('Recovery start failed:', startError);
        const errorObj = startError instanceof Error ? startError : new Error(String(startError));
        if (onFailed) {
          // Check if user cancelled passkey prompt (NotAllowedError)
          onFailed(
            errorObj,
            errorObj.name === 'NotAllowedError'
              ? standardErrorCodes.provider.userRejectedRequest
              : standardErrorCodes.rpc.internal
          );
        } else {
          setError(`Error: ${errorObj.message}`);
        }
      } finally {
        submittingRef.current = false;
        setIsStarting(false);
      }
    },
    [chainId, apiKey, onStarted, onFailed]
  );

  const handleClose = useCallback(() => {
    // isStarting commits a render late: a same-tick close must not report "rejected" while the
    // passkey is being made and the request opened.
    if (submittingRef.current) return;
    if (requestId) onDone();
    else onClose();
  }, [requestId, onDone, onClose]);

  return (
    <RecoveryStartDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      account={account}
      approveUrl={approveUrl}
      appName={appName}
      appLogoUrl={appLogoUrl}
      apiKey={apiKey}
      mainnetRpcUrl={mainnetRpcUrl}
      onStart={handleStart}
      isStarting={isStarting}
      error={error}
      requestId={requestId}
      onBack={onBack}
      onClose={handleClose}
      onDone={onDone}
      onStartAgain={
        onStartAgain &&
        (() => {
          setError('');
          onStartAgain();
        })
      }
      onOpenAccount={onOpenAccount}
      isOpeningAccount={isOpeningAccount}
      chainId={chainId}
    />
  );
}

export interface RecoveryStartModalProps {
  /** The dApp's params: the account it names, validated again here, and the guardian page. */
  params?: unknown;
  chain?: Chain;
  apiKey: string | undefined;
  appName?: string;
  appLogoUrl?: string;
  /** The request exists: the dApp gets it now. */
  onStarted: (ceremony: CreatedCeremony) => void;
  /** Done on the status screen, after the dApp already has its answer. */
  onDone: () => void;
  onError: (error: Error, errorCode?: number) => void;
}

/**
 * The CrossPlatform host for `wallet_startRecovery`: the SDK's RecoveryStartDialogWrapper in keys'
 * conventions, as RecoveryModal is RecoveryDialogWrapper.
 *
 * The user recovering has no account on this device, so nothing here needs one (select-screen
 * never sends this request to onboarding). The dApp gets the request the moment it exists; the
 * status stays on screen until Done.
 */
export const RecoveryStartModal = ({
  params,
  chain,
  apiKey,
  appName,
  appLogoUrl,
  onStarted,
  onDone,
  onError,
}: RecoveryStartModalProps) => {
  const { mutateAsync: passkeyLogin, isPending: isOpeningAccount } = usePasskeyLogin();
  const [created, setCreated] = useState<CreatedCeremony | null>(null);
  // The request is answered once: the status screen stays up after the answer.
  const settledRef = useRef(false);

  const extractedApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);
  const chainId = chain?.id ?? 1;

  // The account the app named, validated again with the SDK's own normalizer: a page can post to
  // keys without going through the SDK.
  const request = useMemo(() => {
    try {
      return normalizeStartRecoveryParams(params);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [params]);
  const invalid = request instanceof Error ? request : null;
  const approveUrl = useMemo(
    () => recoveryApproveUrl(Array.isArray(params) ? (params[0] as { approveUrl?: unknown })?.approveUrl : undefined),
    [params]
  );

  // An invalid account has nothing to show: refused once, before anything renders.
  useEffect(() => {
    if (!invalid || settledRef.current) return;
    settledRef.current = true;
    onError(invalid, standardErrorCodes.rpc.invalidParams);
  }, [invalid, onError]);

  const handleStarted = useCallback(
    (ceremony: CreatedCeremony) => {
      settledRef.current = true;
      setCreated(ceremony);
      // Answered now: the request exists, so nothing after it (closing the window, a crash on the
      // status screen) may report a rejection.
      onStarted(ceremony);
    },
    [onStarted]
  );

  const handleFailed = useCallback(
    (error: Error, errorCode: number) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onError(error, errorCode);
    },
    [onError]
  );

  const handleClose = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    // User rejected request (EIP-1193 code 4001)
    onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
  }, [onError]);

  // The recovery executed while the screen was open: sign in with the new passkey here, so the
  // app's next connect finds the account on this device, then close.
  const handleOpenAccount = useCallback(async () => {
    try {
      await passkeyLogin({ apiKey: extractedApiKey, defaultChainId: chainId });
      debugLog('✅ Signed in with the recovered passkey');
      onDone();
    } catch (error) {
      console.error('Sign-in with the recovered passkey failed:', error);
    }
  }, [passkeyLogin, extractedApiKey, chainId, onDone]);

  if (request instanceof Error) return null;

  return (
    <RecoveryStartFlow
      account={request.account}
      requestId={created?.requestId}
      approveUrl={approveUrl}
      chainId={chainId}
      apiKey={extractedApiKey}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onStarted={handleStarted}
      onFailed={handleFailed}
      onClose={handleClose}
      onDone={onDone}
      onOpenAccount={handleOpenAccount}
      isOpeningAccount={isOpeningAccount}
    />
  );
};
