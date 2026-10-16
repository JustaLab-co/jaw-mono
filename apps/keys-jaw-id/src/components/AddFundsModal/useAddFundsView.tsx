'use client';

import { AddFundsDialog, ADD_FUNDS_REJECTION } from '@jaw.id/ui';
import { useState, type RefObject } from 'react';
import { isAddress } from 'viem';
import { resolveDestination, standardErrorCodes } from '@jaw.id/core';

interface AddFundsViewOptions {
  walletAddress: string | null;
  /** The account the request spends from, or undefined when that is not known to be the signer. */
  short: string | undefined;
  chainId: number | undefined;
  submittingRef: RefObject<boolean>;
  apiKey?: string;
  mainnetRpcUrl: string;
  origin?: string;
  appName?: string;
  appLogoUrl?: string;
  onError?: (error: Error, errorCode?: number) => void;
}

// The Add Funds view a request blocked on funds can switch to. Offered only when the account
// that is short is the connected one, the address Add Funds shows. Leaving it ends the request,
// so the caller retries after the deposit and nothing is ever signed from it. Opening it is a
// no-op while a submission is in flight, for the same reason cancel is.
export function useAddFundsView({
  walletAddress,
  short,
  chainId,
  submittingRef,
  apiKey,
  mainnetRpcUrl,
  origin,
  appName,
  appLogoUrl,
  onError,
}: AddFundsViewOptions) {
  const [view, setView] = useState<'request' | 'add-funds'>('request');
  if (
    chainId === undefined ||
    !walletAddress ||
    !isAddress(walletAddress, { strict: false }) ||
    walletAddress.toLowerCase() !== short?.toLowerCase()
  ) {
    return { addFundsView: null, onAddFunds: undefined };
  }
  if (view === 'request') {
    const onAddFunds = () => {
      if (!submittingRef.current) setView('add-funds');
    };
    return { addFundsView: null, onAddFunds };
  }

  const leave = () => onError?.(new Error(ADD_FUNDS_REJECTION), standardErrorCodes.provider.userRejectedRequest);
  const addFundsView = (
    <AddFundsDialog
      open
      onOpenChange={(next) => {
        if (!next) leave();
      }}
      address={resolveDestination([walletAddress])}
      chainId={chainId}
      // Only a deposit on the request's chain unblocks it.
      chains={[chainId]}
      mainnetRpcUrl={mainnetRpcUrl}
      apiKey={apiKey}
      origin={origin}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onDone={leave}
    />
  );
  return { addFundsView, onAddFunds: undefined };
}
