'use client';

import { SiweDialog, useChainIconURI } from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useSessionAccount } from '../../hooks';
import { useCallback, useMemo, useState } from 'react';
import type { chain } from '../../lib/sdk-types';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { standardErrorCodes, JAW_RPC_URL } from '@jaw.id/core';
import { apiKeyFromChain } from '../../lib/api-key';

export interface SiweModalProps {
  origin: string;
  message: string;
  address?: string;
  chain: chain;
  apiKey?: string;
  appName?: string;
  appLogoUrl?: string;
  warningMessage?: string;
  isSuccess?: boolean;
  onSuccess: (signature: string, message: string) => void;
  onError: (error: Error, errorCode?: number) => void;
}

export const SiweModal = ({
  origin,
  message: messageToSign,
  address,
  chain,
  apiKey,
  appName,
  appLogoUrl,
  warningMessage,
  isSuccess,
  onSuccess,
  onError,
}: SiweModalProps) => {
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
  const [siweStatus, setSiweStatus] = useState<string>('');

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
      setSiweStatus('Signing in...');

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      const signature = await account.signMessage(messageToSign, { address: address as `0x${string}` | undefined });

      setSiweStatus('Sign in successful!');

      onSuccess(signature, messageToSign);
    } catch (error) {
      console.error('Error signing SIWE message:', error);
      setSiweStatus(`Error: ${error instanceof Error ? error.message : 'Sign in failed'}`);
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
      setSiweStatus('');
    }
  };

  const canSign = !isProcessing && !isAccountLoading && !!messageToSign && !!account;

  return (
    <SiweDialog
      open={true}
      onOpenChange={() => {
        debugLog('onOpenChange');
      }}
      message={messageToSign}
      origin={origin}
      appName={appName || 'dApp'}
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
      siweStatus={siweStatus}
      canSign={canSign}
      warningMessage={warningMessage}
    />
  );
};
