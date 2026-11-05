'use client';

import { GuardianApproveDialog, guardianApprovalBlock, usePendingRecoveries, useRecoveryRequest } from '@jaw.id/ui';
import {
  JAW_RPC_URL,
  normalizeRecoveryRequestParams,
  standardErrorCodes,
  type CeremonyApproval,
  type Chain,
} from '@jaw.id/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useAuth, useSessionAccount } from '../../hooks';
import { apiKeyFromChain } from '../../lib/api-key';
import { recoveryErrorCode } from '../../lib/recovery-error';

export interface GuardianApproveModalProps {
  /** The dApp's params: the request id to approve, validated again here. */
  params?: unknown;
  chain?: Chain;
  apiKey: string | undefined;
  origin?: string;
  appName?: string;
  appLogoUrl?: string;
  /** The approval was posted: the dApp gets it now. */
  onApproved: (result: CeremonyApproval) => void;
  /** Done on the approved screen, after the dApp already has its answer. */
  onDone: () => void;
  onError: (error: Error, errorCode?: number) => void;
}

/**
 * The CrossPlatform host for `wallet_approveRecovery`: the SDK's GuardianApproveDialogWrapper in
 * keys' conventions. The guardian signed in first (select-screen sends a signed-out request to
 * onboarding), and the signed-in keys account approves.
 *
 * What is signed is the request this screen shows: only its id goes to core, which reads that
 * request again and checks the id hashes from its account and new passkey before the prompt. A
 * signed-in key that is none of the request's guardians is refused before any prompt.
 */
export const GuardianApproveModal = ({
  params,
  chain,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onApproved,
  onDone,
  onError,
}: GuardianApproveModalProps) => {
  // Single hook handles session lookup + account restoration
  const { account, walletAddress } = useSessionAccount({ origin, chain, apiKey });
  // The signed-in key, known here: a key that is no guardian of the request is refused before
  // any prompt.
  const { publicKey } = useAuth({ origin });

  const [isApproving, setIsApproving] = useState(false);
  const [approval, setApproval] = useState<CeremonyApproval | null>(null);
  // Core refused this key before any prompt (-32602): the screen says it isn't a guardian, and
  // closing answers with core's own error.
  const [refusal, setRefusal] = useState<Error | null>(null);
  // Synchronous re-entry guard: one tap, one approval.
  const submittingRef = useRef(false);
  // The request is answered once: the approved screen stays up after the answer.
  const settledRef = useRef(false);

  const extractedApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return extractedApiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${extractedApiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [extractedApiKey]);

  // The request id the app sent, validated again with the SDK's own normalizer: a page can post
  // to keys without going through the SDK.
  const request = useMemo(() => {
    try {
      return normalizeRecoveryRequestParams(params, 'wallet_approveRecovery');
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [params]);
  const invalid = request instanceof Error ? request : null;
  const requestId = request instanceof Error ? null : request.requestId;

  const { ceremony, failed } = useRecoveryRequest(requestId, extractedApiKey);
  const openRequests = usePendingRecoveries(ceremony?.account, extractedApiKey);
  const block = refusal ? 'not-guardian' : ceremony ? guardianApprovalBlock(ceremony, publicKey ?? undefined) : null;

  // An invalid request id has nothing to show: refused once, before anything renders.
  useEffect(() => {
    if (!invalid || settledRef.current) return;
    settledRef.current = true;
    onError(invalid, standardErrorCodes.rpc.invalidParams);
  }, [invalid, onError]);

  const handleApprove = useCallback(async () => {
    if (submittingRef.current || settledRef.current || block || !requestId) return;
    submittingRef.current = true;
    setIsApproving(true);
    try {
      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }
      // Core reads the request by this id again and signs it: the id hashes from the account and
      // the new passkey this screen shows, and core checks that before the prompt.
      const result = await account.approveRecovery(requestId);
      // Answered now: the approval is posted, so nothing after it may report a rejection.
      settledRef.current = true;
      onApproved(result);
      setApproval(result);
    } catch (error) {
      console.error('Recovery approval failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const errorCode = recoveryErrorCode(error);
      if (errorCode === standardErrorCodes.rpc.invalidParams) {
        setRefusal(errorObj);
      } else {
        settledRef.current = true;
        onError(errorObj, errorCode);
      }
    } finally {
      submittingRef.current = false;
      setIsApproving(false);
    }
  }, [account, block, requestId, onApproved, onError]);

  const handleClose = useCallback(() => {
    // isApproving commits a render late: a same-tick close must not report "rejected" while the
    // approval is being signed and posted.
    if (submittingRef.current) return;
    // The dApp already has its approval: this only closes the screen.
    if (approval) return onDone();
    if (settledRef.current) return;
    settledRef.current = true;
    // A request this account can't approve answers with why, as core would.
    if (refusal) return onError(refusal, standardErrorCodes.rpc.invalidParams);
    if (block) {
      return onError(
        new Error(
          block === 'not-guardian'
            ? 'This account is not a guardian of this recovery request'
            : 'This recovery request no longer takes approvals'
        ),
        standardErrorCodes.rpc.invalidParams
      );
    }
    // User rejected request (EIP-1193 code 4001)
    onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
  }, [approval, refusal, block, onDone, onError]);

  // Signed in is a precondition of this screen (select-screen); the address lands with the auth read.
  if (!requestId || !walletAddress) return null;

  return (
    <GuardianApproveDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      origin={origin || ''}
      appName={appName}
      appLogoUrl={appLogoUrl}
      mainnetRpcUrl={mainnetRpcUrl}
      ceremony={ceremony}
      failed={failed}
      openRequests={openRequests}
      guardian={walletAddress as Address}
      block={block}
      onApprove={handleApprove}
      isApproving={isApproving}
      approval={approval}
      onCancel={handleClose}
      onDone={handleClose}
    />
  );
};
