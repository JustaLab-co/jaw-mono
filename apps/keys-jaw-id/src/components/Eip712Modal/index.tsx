'use client';

import { Eip712Dialog, useChainIconURI } from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useSessionAccount } from '../../hooks';
import { useCallback, useMemo, useState } from 'react';
import type { chain } from '../../lib/sdk-types';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { standardErrorCodes, JAW_RPC_URL } from '@jaw.id/core';
import { apiKeyFromChain } from '../../lib/api-key';

export interface Eip712ModalProps {
  origin: string;
  typedDataJson: string;
  address?: string;
  chain: chain;
  apiKey?: string;
  appName?: string;
  appLogoUrl?: string;
  isSuccess?: boolean;
  onSuccess: (signature: string) => void;
  onError: (error: Error, errorCode?: number) => void;
}

// EIP-712 TypedData structure
interface TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export const Eip712Modal = ({
  origin,
  typedDataJson,
  address,
  chain,
  apiKey,
  appName,
  appLogoUrl,
  isSuccess,
  onSuccess,
  onError,
}: Eip712ModalProps) => {
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

  // Parse typed data
  const typedData = useMemo(() => {
    try {
      return JSON.parse(typedDataJson) as TypedData;
    } catch (error) {
      console.error('Failed to parse typed data:', error);
      return null;
    }
  }, [typedDataJson]);

  const signTypedData = useCallback(async () => {
    try {
      setIsProcessing(true);
      setSignatureStatus('Signing typed data...');

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      if (!typedData) {
        throw new Error('Invalid typed data');
      }

      const signature = await account.signTypedData(
        {
          domain: typedData.domain,
          types: typedData.types as any,
          primaryType: typedData.primaryType,
          message: typedData.message,
        },
        { address: address as `0x${string}` | undefined }
      );

      setSignatureStatus('Signature created successfully!');
      onSuccess(signature);
    } catch (error) {
      console.error('Error signing typed data:', error);
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
  }, [typedData, account, onSuccess, onError]);

  const handleCancel = () => {
    if (!isProcessing) {
      // User rejected request (EIP-1193 code 4001)
      onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
      setSignatureStatus('');
    }
  };

  const canSign = !isProcessing && !isAccountLoading && !!typedDataJson && !!account && !!typedData;

  return (
    <Eip712Dialog
      open={true}
      onOpenChange={() => {
        debugLog('onOpenChange');
      }}
      typedDataJson={typedDataJson}
      origin={origin}
      appName={appName}
      appLogoUrl={appLogoUrl}
      accountAddress={address || walletAddress || undefined}
      chainName={chainName}
      chainIcon={chainIcon}
      chainId={chain.id}
      mainnetRpcUrl={mainnetRpcUrl}
      onSign={signTypedData}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      isSuccess={isSuccess}
      signatureStatus={signatureStatus}
      canSign={canSign}
    />
  );
};
