'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { Chain as chain } from '@jaw.id/core';
import { OnboardingSkeleton, signsFor } from '@jaw.id/ui';

import { useSessionAccount } from '../../hooks';
import type { PendingRequest } from '../../utils/types';
import { AccountMismatchModal } from '../AccountMismatchModal';

/** The account this app is connected as, as the page's session holds it. */
export interface ConnectedAccount {
  address: string | null;
  name: string | null;
}

export interface AccountGateProps {
  pendingRequest: PendingRequest;
  /** The account the request names, if it names one. */
  address: string | undefined;
  connectedAccount: ConnectedAccount;
  /** The origin the app's connection is stored under. */
  sessionOrigin: string | undefined;
  apiKey: string | undefined;
  /** Answers the request when it is refused. */
  onRefuse: (error: Error, errorCode: number) => void;
  children: ReactNode;
}

/**
 * Opens a request's screen only when the passkey this app connected with can sign for the account
 * the request names. A request with no account, or for the connected one, opens as it always did,
 * without restoring anything.
 */
export function AccountGate(props: AccountGateProps): ReactElement {
  const { address, connectedAccount, children } = props;
  if (!address || address.toLowerCase() === connectedAccount.address?.toLowerCase()) return <>{children}</>;
  return <OwnershipCheck {...props} address={address} />;
}

/** `open` when core did not refuse: the passkey signs for it, or the check failed or ran too long. */
type Verdict = 'checking' | 'open' | 'refused';

/**
 * How long the check may run before the screen opens anyway, as it does when the check fails.
 * The skeleton has no Reject, so a stuck network must not leave the person on it.
 */
const CHECK_TIMEOUT_MS = 8_000;

/**
 * Sets the verdict unless one is already set. The first answer stands, so a refusal that arrives
 * after the screen opened doesn't swap it out from under the person.
 */
const unlessDecided =
  (answer: Verdict) =>
  (verdict: Verdict): Verdict =>
    verdict === 'checking' ? answer : verdict;

/** Asks core whether the connected passkey signs for another account, as a co-owner can. */
function OwnershipCheck({
  pendingRequest,
  address,
  connectedAccount,
  sessionOrigin,
  apiKey,
  onRefuse,
  children,
}: AccountGateProps & { address: string }): ReactElement {
  const { account, isLoading } = useSessionAccount({
    origin: sessionOrigin,
    chain: pendingRequest.chain as chain | undefined,
    apiKey,
  });
  const [verdict, setVerdict] = useState<Verdict>('checking');

  useEffect(() => {
    const timer = setTimeout(() => setVerdict(unlessDecided('open')), CHECK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!account) return;
    let current = true;
    signsFor(account, address).then(
      (signs) => current && setVerdict(unlessDecided(signs ? 'open' : 'refused')),
      (error) => {
        // Not core refusing the passkey, so not a reason to refuse the request: the screen opens
        // as it did before this check, and reports what fails there.
        console.error('[AccountGate] Could not check the requested account:', error);
        if (current) setVerdict(unlessDecided('open'));
      }
    );
    return () => {
      current = false;
    };
  }, [account, address]);

  if (verdict === 'refused') {
    return (
      <AccountMismatchModal
        origin={pendingRequest.origin}
        appName={pendingRequest.metadata?.appName}
        appLogoUrl={pendingRequest.metadata?.appLogoUrl}
        requestedAddress={address}
        connectedAddress={connectedAccount.address}
        connectedName={connectedAccount.name}
        onClose={onRefuse}
      />
    );
  }
  // A restore that failed is the screen's own to report, as it was before.
  if (verdict === 'open' || (!isLoading && !account)) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <OnboardingSkeleton />
      </div>
    </div>
  );
}
