'use client';

import type { ReactElement } from 'react';
import { standardErrorCodes, type Chain as chain } from '@jaw.id/core';

import { TransactionModal, type TransactionResult, type TransactionRequestData } from '../TransactionModal';
import { SignatureModal } from '../SignatureModal';
import { SiweModal } from '../SiweModal';
import { isSiweMessage, getSiweOriginWarningFromMessage } from '@jaw.id/ui';
import { Eip712Modal } from '../Eip712Modal';
import { PermissionModal, type PermissionRequestData } from '../PermissionModal';
import { AddFundsModal } from '../AddFundsModal';
import type { WalletSendCallsReturn, EthSendTransactionReturn } from '../../lib/tx-handler';
import { SDKRequestType } from '../../lib/sdk-types';
import { debugLog } from '../../lib/debug-log';
import type { Phase } from '../../lib/select-screen';
import type { PendingRequest } from '../../utils/types';
import type { PopupCommunicator } from '../../lib/popup-communicator';

/**
 * Every modal that answers a pending request, in one place.
 *
 * Rendered only when the screen decision says `modal` (lib/select-screen), so
 * this file dispatches on the request type alone — it never re-derives whether a
 * modal should show. It was 355 lines inline in page.tsx, where the guard was
 * repeated five times and could drift from the decision.
 */
export interface RequestModalsProps {
  pendingRequest: PendingRequest;
  communicator: PopupCommunicator;
  apiKey: string | undefined;
  currentOrigin: string | null;
  /**
   * The parsed transaction, or null when the pending request is not one. Parsed
   * by the parent when the request arrives — doing it here would mean reporting
   * a parse failure through the parent's setters during this component's render.
   */
  txData: TransactionRequestData | null;
  setPhase: (phase: Phase) => void;
  setError: (error: string | null) => void;
  scheduleClose: (delayMs: number) => void;
  finishDeliveredFlow: () => void;
  /** Delay before the dialog closes once a flow completes (page-owned). */
  closeDelayMs: number;
  /** True once a signature has been delivered — drives the modals' tick. */
  signDelivered: boolean;
}

export function RequestModals({
  pendingRequest,
  communicator,
  apiKey,
  currentOrigin,
  txData,
  setPhase,
  setError,
  scheduleClose,
  finishDeliveredFlow,
  closeDelayMs,
  signDelivered,
}: RequestModalsProps): ReactElement | null {
  if (pendingRequest.type === SDKRequestType.SEND_TRANSACTION) {
    // A send-transaction request that failed to parse is rejected before it ever
    // reaches state, so there is nothing to render for it.
    if (!txData) return null;

    return (
      // Keyed by request: the embedded iframe stays mounted across flows, so an
      // unkeyed modal is the SAME React instance for the next request and keeps
      // internal state (isProcessing, status) from the previous flow — which
      // opened request #2 directly on the processing screen. The key forces a
      // fresh mount per request, like the popup's fresh page used to guarantee.
      <TransactionModal
        key={pendingRequest.requestId}
        transactionRequest={txData}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey}
        origin={currentOrigin || undefined}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        onSuccess={async (result: TransactionResult) => {
          setPhase('working');
          try {
            // Type-safe result handling based on method
            let response: WalletSendCallsReturn | EthSendTransactionReturn;

            if (txData.method === 'wallet_sendCalls') {
              // EIP-5792: Return sendCallsId for wallet_sendCalls
              response = {
                id: result.id || `0x${'0'.repeat(64)}`,
                chainId: result.chainId as number,
                // capabilities can be included if supported by the wallet
              } satisfies WalletSendCallsReturn;
            } else {
              // eth_sendTransaction: Return transaction hash
              response = (result.hash || `0x${'0'.repeat(64)}`) as EthSendTransactionReturn;
            }

            debugLog('✅ Transaction response:', response);
            await pendingRequest.onApprove(response);
            setPhase('done');
            scheduleClose(closeDelayMs);
          } catch (err) {
            console.error('❌ Failed to send transaction:', err);
            setError(err instanceof Error ? err.message : 'Failed to send transaction');
            setPhase('failed');
          }
        }}
        onError={async (error, errorCode) => {
          try {
            // Forward error and code directly from modal
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.provider.userRejectedRequest);
            communicator.requestClose();
          } catch (err) {
            console.error('❌ Failed to reject:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }

  if (pendingRequest.type === SDKRequestType.SIGN_MESSAGE) {
    // Extract message and address based on method type
    let messageToSign: string;
    let address: string | undefined;

    if (pendingRequest.method === 'wallet_sign') {
      // wallet_sign: params[0] is SignParams object
      // ERC-7871: For type 0x45, data is { message: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signParams = pendingRequest.params[0] as {
        request: { type: string; data: { message: string } };
        address?: string;
      };
      messageToSign = signParams?.request?.data?.message || '';
      address = signParams?.address;
    } else {
      // personal_sign: params[0] is message, params[1] is address
      messageToSign = pendingRequest.params[0] as string;
      address = pendingRequest.params[1] as string;
    }

    // Check if this is a SIWE (Sign-In with Ethereum) message
    const isSiwe = isSiweMessage(messageToSign);

    // Render SiweModal for SIWE messages, SignatureModal for regular messages
    if (isSiwe) {
      // Deliberately not gated on a successful parse: this warning carries the mandatory
      // acknowledgement checkbox, and a message can detect as SIWE while failing to parse.
      const siweWarning = getSiweOriginWarningFromMessage(pendingRequest.origin, messageToSign);
      return (
        // Keyed by request — see TransactionModal above.
        <SiweModal
          key={pendingRequest.requestId}
          origin={pendingRequest.origin}
          message={messageToSign}
          address={address}
          chain={pendingRequest.chain as chain}
          apiKey={apiKey}
          appName={pendingRequest.metadata?.appName || 'dApp'}
          appLogoUrl={pendingRequest.metadata?.appLogoUrl}
          warningMessage={siweWarning}
          isSuccess={signDelivered}
          onSuccess={async (signature) => {
            setPhase('working');
            try {
              await pendingRequest.onApprove(signature);
              debugLog('✅ SIWE signature sent successfully');
              // Delivery confirmed — show the tick, then close.
              finishDeliveredFlow();
            } catch (err) {
              console.error('❌ Failed to send SIWE signature:', err);
              setError(err instanceof Error ? err.message : 'Failed to send signature');
              setPhase('failed');
            }
          }}
          onError={async (error, errorCode) => {
            try {
              // Forward error and code directly from modal
              await pendingRequest.onReject(
                error.message,
                errorCode ?? standardErrorCodes.provider.userRejectedRequest
              );
              communicator.requestClose();
            } catch (err) {
              console.error('❌ Failed to reject:', err);
              communicator.requestClose();
            }
          }}
        />
      );
    }

    return (
      // Keyed by request — see TransactionModal above.
      <SignatureModal
        key={pendingRequest.requestId}
        origin={pendingRequest.origin}
        // open={true}
        // onOpenChange={() => { }}
        message={messageToSign}
        address={address}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        isSuccess={signDelivered}
        onSuccess={async (signature) => {
          setPhase('working');
          try {
            await pendingRequest.onApprove(signature);
            debugLog('✅ Signature sent successfully');
            // Delivery confirmed — show the tick, then close.
            finishDeliveredFlow();
          } catch (err) {
            console.error('❌ Failed to send signature:', err);
            setError(err instanceof Error ? err.message : 'Failed to send signature');
            setPhase('failed');
          }
        }}
        onError={async (error, errorCode) => {
          try {
            // Forward error and code directly from modal
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.provider.userRejectedRequest);
            communicator.requestClose();
          } catch (err) {
            console.error('❌ Failed to reject:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }

  if (pendingRequest.type === SDKRequestType.SIGN_TYPED_DATA) {
    // Extract typed data JSON and address based on method type
    let address: string | undefined;
    let typedDataJson: string;

    if (pendingRequest.method === 'wallet_sign') {
      // ERC-7871: For type 0x01, data is the TypedData object directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signParams = pendingRequest.params[0] as {
        request: { type: string; data: Record<string, unknown> };
        address?: string;
      };

      const data = signParams?.request?.data;
      typedDataJson = typeof data === 'string' ? data : JSON.stringify(data);

      address = signParams?.address;

      debugLog('🔍 wallet_sign EIP-712 Request:', { type: signParams?.request?.type, address, typedDataJson });
    } else {
      // eth_signTypedData_v4: params[0] is address, params[1] is typed data JSON string
      address = pendingRequest.params[0] as string;
      typedDataJson = pendingRequest.params[1] as string;

      debugLog('🔍 eth_signTypedData_v4 Request:', { address, typedDataJson });
    }

    return (
      // Keyed by request — see TransactionModal above. Eip712Modal's isProcessing
      // never resets on the success path, so instance reuse showed the next
      // request a permanent "Signing..." screen.
      <Eip712Modal
        key={pendingRequest.requestId}
        origin={pendingRequest.origin}
        typedDataJson={typedDataJson}
        address={address}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        isSuccess={signDelivered}
        onSuccess={async (signature) => {
          setPhase('working');
          try {
            await pendingRequest.onApprove(signature);
            debugLog('✅ Typed data signature sent successfully');
            // Delivery confirmed — show the tick, then close.
            finishDeliveredFlow();
          } catch (err) {
            console.error('❌ Failed to send signature:', err);
            setError(err instanceof Error ? err.message : 'Failed to send signature');
            setPhase('failed');
          }
        }}
        onError={async (error, errorCode) => {
          try {
            // Forward error and code directly from modal
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.provider.userRejectedRequest);
            communicator.requestClose();
          } catch (err) {
            console.error('❌ Failed to reject:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }

  if (pendingRequest.type === SDKRequestType.GRANT_PERMISSIONS) {
    const permissionRequestData: PermissionRequestData = {
      method: 'wallet_grantPermissions',
      params: pendingRequest.params as any,
    };

    return (
      // Keyed by request — see TransactionModal above.
      <PermissionModal
        key={pendingRequest.requestId}
        permissionRequest={permissionRequestData}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey || ''}
        origin={pendingRequest.origin}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        onSuccess={async (result) => {
          setPhase('working');
          try {
            await pendingRequest.onApprove(result);
            debugLog('✅ Permission granted successfully');
            setPhase('done');
            scheduleClose(closeDelayMs);
          } catch (err) {
            console.error('❌ Failed to grant permission:', err);
            setError(err instanceof Error ? err.message : 'Failed to grant permission');
            setPhase('failed');
          }
        }}
        onError={async (error, errorCode) => {
          try {
            // Forward error and code directly from modal
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.provider.userRejectedRequest);
            communicator.requestClose();
          } catch (err) {
            console.error('❌ Failed to reject:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }

  if (pendingRequest.type === SDKRequestType.REVOKE_PERMISSIONS) {
    const permissionRequestData: PermissionRequestData = {
      method: 'wallet_revokePermissions',
      params: pendingRequest.params as any,
    };

    return (
      // Keyed by request — see TransactionModal above.
      <PermissionModal
        key={pendingRequest.requestId}
        permissionRequest={permissionRequestData}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey || ''}
        origin={pendingRequest.origin}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        onSuccess={async (result) => {
          setPhase('working');
          try {
            await pendingRequest.onApprove(result);
            debugLog('✅ Permission revoked successfully');
            setPhase('done');
            scheduleClose(closeDelayMs);
          } catch (err) {
            console.error('❌ Failed to revoke permission:', err);
            setError(err instanceof Error ? err.message : 'Failed to revoke permission');
            setPhase('failed');
          }
        }}
        onError={async (error, errorCode) => {
          try {
            // Forward error and code directly from modal
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.provider.userRejectedRequest);
            communicator.requestClose();
          } catch (err) {
            console.error('❌ Failed to reject:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }
  if (pendingRequest.type === SDKRequestType.ADD_FUNDS) {
    return (
      // Keyed by request — see TransactionModal above.
      <AddFundsModal
        key={pendingRequest.requestId}
        params={pendingRequest.params}
        chain={pendingRequest.chain as chain}
        apiKey={apiKey}
        // `currentOrigin`, like every other modal here. This screen feeds its
        // origin to `useAuth`, and the page holds that query under
        // `currentOrigin` — a different string is a different query key, so a
        // per-request origin meant a cold cache and a null address on the first
        // render of every request.
        origin={currentOrigin || undefined}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        // The only failure this screen has: it cannot show an address at all.
        // Everything else is a plain finish, since nothing was asked for approval.
        onError={async (error, errorCode) => {
          try {
            await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.rpc.internal);
          } catch (err) {
            console.error('❌ Failed to reject add funds:', err);
          }
          communicator.requestClose();
        }}
        onDone={async () => {
          try {
            await pendingRequest.onApprove(null);
            debugLog('✅ Add funds screen closed');
            // `scheduleClose`, not a bare `requestClose`: it is the only close
            // that also runs `clearScreen`. `onApprove` already released the
            // flow lock, so the DialogVisibility backstop is gated off and the
            // shell-X path is not taken — nothing else would clear this. The
            // receive screen stayed mounted and flashed for a frame on the next
            // request, which is what `clearScreen` exists to prevent.
            //
            // No delivered-tick beat though: nothing was signed, so a success
            // flourish would claim something happened. Pressing Done is the
            // whole outcome, and 'done' is what makes the screen terminal.
            setPhase('done');
            scheduleClose(closeDelayMs);
          } catch (err) {
            console.error('❌ Failed to resolve add funds:', err);
            communicator.requestClose();
          }
        }}
      />
    );
  }

  return null;
}
