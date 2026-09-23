'use client';

import { SignatureDialog, useChainIconURI } from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useSessionAccount } from '../../hooks';
import { useCallback, useMemo, useState } from 'react';
import type { chain } from '../../lib/sdk-types';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { standardErrorCodes, JAW_RPC_URL } from '@jaw.id/core';
import { apiKeyFromChain } from '../../lib/api-key';

export interface SignatureModalProps {
  origin: string;
  message: string;
  address?: string;
  chain: chain;
  apiKey?: string;
  appName?: string;
  appLogoUrl?: string;
  isSuccess?: boolean;
  onSuccess: (signature: string, message: string) => void;
  onError: (error: Error, errorCode?: number) => void;
}

export const SignatureModal = ({
  origin,
  message: messageToSign,
  address,
  chain,
  apiKey,
  appName,
  appLogoUrl,
  isSuccess,
  onSuccess,
  onError,
}: SignatureModalProps) => {
  // Single hook handles session lookup + account restoration
  const {
    account,
    walletAddress,
    isLoading: isAccountLoading,
  } = useSessionAccount({
    origin,
    chain,
    apiKey,
  });

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [signatureStatus, setSignatureStatus] = useState<string>('');

  // Extract API key for other uses (chain icon, mainnet RPC)
  const effectiveApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return effectiveApiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${effectiveApiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [effectiveApiKey]);

  // Get chain name and icon
  const chainName = useMemo(() => (chain ? getChainNameFromId(chain.id) : undefined), [chain]);
  const chainIcon = useChainIconURI(chain?.id || 1, effectiveApiKey, 24);

  const signMessage = useCallback(async () => {
    try {
      setIsProcessing(true);
      setSignatureStatus('Signing message...');

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      const signature = await account.signMessage(messageToSign, { address: address as `0x${string}` | undefined });

      setSignatureStatus('Signature created successfully!');
      onSuccess(signature, messageToSign);
    } catch (error) {
      console.error('Error signing message:', error);
      setSignatureStatus(`Error: ${error instanceof Error ? error.message : 'Signature failed'}`);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      // Check if user cancelled passkey prompt (NotAllowedError)
      const errorCode =
        error instanceof Error && error.name === 'NotAllowedError'
          ? standardErrorCodes.provider.userRejectedRequest
          : standardErrorCodes.rpc.internal;
      onError(errorObj, errorCode);
      setIsProcessing(false);
    }
  }, [messageToSign, account, onSuccess, onError]);

  const handleCancel = () => {
    if (!isProcessing) {
      // User rejected request (EIP-1193 code 4001)
      onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
      setSignatureStatus('');
    }
  };

  const canSign = !isProcessing && !isAccountLoading && !!messageToSign && !!account;

  return (
    <SignatureDialog
      open={true}
      onOpenChange={() => {
        debugLog('onOpenChange');
      }}
      message={messageToSign}
      origin={origin}
      appName={appName}
      appLogoUrl={appLogoUrl}
      accountAddress={address || walletAddress || undefined}
      chainName={chainName}
      chainIcon={chainIcon}
      chainId={chain.id}
      mainnetRpcUrl={mainnetRpcUrl}
      onSign={signMessage}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      isSuccess={isSuccess}
      signatureStatus={signatureStatus}
      canSign={canSign}
    />
  );
};
