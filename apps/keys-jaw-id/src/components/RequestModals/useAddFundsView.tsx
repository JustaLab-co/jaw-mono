'use client';

import { AddFundsDialog, ADD_FUNDS_REJECTION } from '@jaw.id/ui';
import { useRef, useState, type RefObject } from 'react';
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
// no-op while a submission is in flight, for the same reason cancel is. Once open, it keeps the
// address and chain it opened with until the request settles, and settles it once.
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
  const [target, setTarget] = useState<{ address: string; chainId: number } | null>(null);
  const leftRef = useRef(false);

  if (!target) {
    if (
      chainId === undefined ||
      !walletAddress ||
      !isAddress(walletAddress, { strict: false }) ||
      walletAddress.toLowerCase() !== short?.toLowerCase()
    ) {
      return { addFundsView: null, onAddFunds: undefined };
    }
    const onAddFunds = () => {
      if (!submittingRef.current) setTarget({ address: resolveDestination([walletAddress]), chainId });
    };
    return { addFundsView: null, onAddFunds };
  }

  const leave = () => {
    if (leftRef.current) return;
    leftRef.current = true;
    onError?.(new Error(ADD_FUNDS_REJECTION), standardErrorCodes.provider.userRejectedRequest);
  };
  const addFundsView = (
    <AddFundsDialog
      open
      onOpenChange={(next) => {
        if (!next) leave();
      }}
      address={target.address}
      chainId={target.chainId}
      // Only a deposit on the request's chain unblocks it.
      chains={[target.chainId]}
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
