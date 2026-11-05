'use client';

import { RecoveryCancelDialog, useRecoveryRequest } from '@jaw.id/ui';
import {
  JAW_RPC_URL,
  normalizeCancelRecoveryParams,
  standardErrorCodes,
  type Account,
  type Chain,
  type RecoverySetupResult,
} from '@jaw.id/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { useSessionAccount } from '../../hooks';
import { apiKeyFromChain } from '../../lib/api-key';
import { recoveryErrorCode } from '../../lib/recovery-error';

export interface RecoveryCancelFlowProps {
  requestId: Hex;
  /** The owner's account, ready to sign; nothing prompts before the cancel is signed. */
  openAccount: () => Promise<Account>;
  apiKey?: string;
  /** Requesting dApp origin, for the dialog header. */
  origin: string;
  appName?: string;
  appLogoUrl?: string | null;
  /** The cancel was relayed: answer now, while the outcome stays on screen. */
  onCancelled?: (result: RecoverySetupResult) => void;
  /** The cancel failed. Absent, the error stays on screen for another try. */
  onFailed?: (error: Error) => void;
  /** Not now, or the close button, before anything is signed. */
  onClose: () => void;
  /** Done on the outcome screen. */
  onDone: () => void;
}

/**
 * The owner's veto in keys' conventions, shared by `wallet_cancelRecovery` and the connect
 * screen's warning: the SDK's RecoveryCancelFlow.
 *
 * Reads the request, signs the cancel of exactly the request id it shows with the account
 * `openAccount` gives, and shows the outcome per network until Done. Where the account comes from,
 * and what a cancel, a failure and Done answer, is the caller's.
 */
export function RecoveryCancelFlow({
  requestId,
  openAccount,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onCancelled,
  onFailed,
  onClose,
  onDone,
}: RecoveryCancelFlowProps) {
  const [isCancelling, setIsCancelling] = useState(false);
  const [result, setResult] = useState<RecoverySetupResult | null>(null);
  const [error, setError] = useState('');
  // Synchronous re-entry guard: one tap, one signature.
  const submittingRef = useRef(false);
  const { ceremony, failed } = useRecoveryRequest(requestId, apiKey);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return apiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [apiKey]);

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsCancelling(true);
    setError('');
    try {
      const account = await openAccount();
      // The id of the request this screen shows, signed as is: core builds the cancel from it.
      const cancelled = await account.cancelRecovery(requestId);
      // Answered now: once the veto is relayed, nothing after it (closing the window, a crash on
      // the outcome screen) may report a rejection.
      onCancelled?.(cancelled);
      setResult(cancelled);
    } catch (cancelError) {
      console.error('Recovery cancel failed:', cancelError);
      const errorObj = cancelError instanceof Error ? cancelError : new Error(String(cancelError));
      if (onFailed) onFailed(errorObj);
      else setError(`Error: ${errorObj.message}`);
    } finally {
      submittingRef.current = false;
      setIsCancelling(false);
    }
  }, [openAccount, requestId, onCancelled, onFailed]);

  const handleClose = useCallback(() => {
    // isCancelling commits a render late: a same-tick close must not report "rejected" while the
    // signed veto is being relayed.
    if (submittingRef.current) return;
    // Closing the outcome screen is Done: the veto already happened.
    if (result) return onDone();
    onClose();
  }, [result, onDone, onClose]);

  return (
    <RecoveryCancelDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      origin={origin}
      appName={appName}
      appLogoUrl={appLogoUrl}
      apiKey={apiKey}
      mainnetRpcUrl={mainnetRpcUrl}
      ceremony={ceremony}
      failed={failed}
      onConfirm={handleConfirm}
      isCancelling={isCancelling}
      result={result}
      error={error}
      onCancel={handleClose}
      onDone={() => onDone()}
    />
  );
}

export interface RecoveryCancelModalProps {
  /** The dApp's params: the request id to cancel, validated again here. */
  params?: unknown;
  chain?: Chain;
  apiKey: string | undefined;
  origin?: string;
  appName?: string;
  appLogoUrl?: string;
  /** The cancel was relayed: the dApp gets the outcome now. */
  onCancelled: (result: RecoverySetupResult) => void;
  /** Done on the outcome screen, after the dApp already has its answer. */
  onDone: () => void;
  onError: (error: Error, errorCode?: number) => void;
}

/**
 * The CrossPlatform host for `wallet_cancelRecovery`: the SDK's RecoveryCancelDialogWrapper in
 * keys' conventions. The signed-in owner vetoes the request the app names: one signature, relayed
 * by JAW to every network where the request waits.
 */
export const RecoveryCancelModal = ({
  params,
  chain,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onCancelled,
  onDone,
  onError,
}: RecoveryCancelModalProps) => {
  // Single hook handles session lookup + account restoration
  const { account } = useSessionAccount({ origin, chain, apiKey });
  // The request is answered once: the outcome screen stays up after the answer.
  const settledRef = useRef(false);

  const extractedApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // The request id the app sent, validated again with the SDK's own normalizer: a page can post
  // to keys without going through the SDK.
  const request = useMemo(() => {
    try {
      return normalizeCancelRecoveryParams(params);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [params]);
  const invalid = request instanceof Error ? request : null;

  // An invalid request id has nothing to show: refused once, before anything renders.
  useEffect(() => {
    if (!invalid || settledRef.current) return;
    settledRef.current = true;
    onError(invalid, standardErrorCodes.rpc.invalidParams);
  }, [invalid, onError]);

  const openAccount = useCallback(async () => {
    if (!account) throw new Error('Account not initialized. Please try again.');
    return account;
  }, [account]);

  if (request instanceof Error) return null;

  return (
    <RecoveryCancelFlow
      requestId={request.requestId}
      openAccount={openAccount}
      apiKey={extractedApiKey}
      origin={origin || ''}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onCancelled={(result) => {
        settledRef.current = true;
        onCancelled(result);
      }}
      onFailed={(error) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onError(error, recoveryErrorCode(error));
      }}
      onClose={() => {
        if (settledRef.current) return;
        settledRef.current = true;
        // User rejected request (EIP-1193 code 4001)
        onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
      }}
      onDone={onDone}
    />
  );
};
