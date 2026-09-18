'use client';

import { ConnectDialog, useChainIconURI } from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useMemo, useState } from 'react';
import type { chain } from '../../lib/sdk-types';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { standardErrorCodes, JAW_RPC_URL } from '@jaw.id/core';
import { apiKeyFromChain } from '../../lib/api-key';

export interface ConnectModalProps {
  origin: string;
  appName: string;
  appLogoUrl?: string;
  accountName?: string;
  walletAddress: string;
  chain?: chain;
  apiKey?: string;
  onSuccess: () => void;
  onError: (error: Error, errorCode?: number) => void;
}

export const ConnectModal = ({
  origin,
  appName,
  appLogoUrl,
  accountName,
  walletAddress,
  chain,
  apiKey,
  onSuccess,
  onError,
}: ConnectModalProps) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Extract API key from rpcUrl if not provided as prop
  const effectiveApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // Get chain name and icon
  const chainName = useMemo(() => (chain ? getChainNameFromId(chain.id) : undefined), [chain]);
  const chainIcon = useChainIconURI(chain?.id || 1, effectiveApiKey, 24);

  // Mainnet, for ENS, under whatever key this request carries. The prop is left
  // out on purpose: the other modals build this from the url's key alone.
  const mainnetRpcUrl = useMemo(() => {
    const key = apiKeyFromChain(undefined, chain?.rpcUrl);
    return key ? `${JAW_RPC_URL}?chainId=1&api-key=${key}` : `${JAW_RPC_URL}?chainId=1`;
  }, [chain?.rpcUrl]);

  const handleConnect = async () => {
    try {
      setIsProcessing(true);
      debugLog('🔗 User approved connection to', appName);
      onSuccess();
    } catch (error) {
      console.error('Error connecting:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      // Internal error during connection
      onError(errorObj, standardErrorCodes.rpc.internal);
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    if (!isProcessing) {
      debugLog('❌ User cancelled connection request');
      // User rejected request (EIP-1193 code 4001)
      onError(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
    }
  };

  return (
    <ConnectDialog
      open={true}
      onOpenChange={() => {
        debugLog('onOpenChange');
      }}
      appName={appName}
      appLogoUrl={appLogoUrl}
      origin={origin}
      accountName={accountName}
      walletAddress={walletAddress}
      chainName={chainName}
      chainId={chain?.id}
      chainIcon={chainIcon}
      mainnetRpcUrl={mainnetRpcUrl}
      onConnect={handleConnect}
      onCancel={handleCancel}
      isProcessing={isProcessing}
    />
  );
};
