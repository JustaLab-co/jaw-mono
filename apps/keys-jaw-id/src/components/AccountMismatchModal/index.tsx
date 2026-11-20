'use client';

import { useState } from 'react';
import { standardErrorCodes } from '@jaw.id/core';
import { formatAddress, isSafeImageUrl, sanitizeDisplayName } from '@jaw.id/ui';

export interface AccountMismatchModalProps {
  origin: string;
  appName?: string;
  appLogoUrl?: string;
  /** The account the request is for. */
  requestedAddress: string;
  /** The account this app is connected as. */
  connectedAddress: string | null;
  /** That account's name, when it has one. */
  connectedName?: string | null;
  onClose: (error: Error, errorCode: number) => void;
}

/**
 * Shown instead of a request's screen when the request is for an account the passkey this app
 * connected with can't sign for. A stale tab still on an account the app has since left, or an
 * app naming an address it likes. Nothing is switched or disconnected, and the user reloads the
 * app to pick up the account it is on.
 *
 * The app gets invalid params (-32602), the code core gives the same refusal in app-specific mode.
 * Not 4100: the SDK disconnects on a 4100 from the popup (JAWProvider), which would log the app
 * out, and could take another tab's working connection with it.
 */
export const AccountMismatchModal = ({
  origin,
  appName,
  appLogoUrl,
  requestedAddress,
  connectedAddress,
  connectedName,
  onClose,
}: AccountMismatchModalProps) => {
  const [isClosing, setIsClosing] = useState<boolean>(false);

  // appName is externally-controlled (dApp metadata); sanitize before display.
  const safeAppName = sanitizeDisplayName(appName ?? '');
  const connectedAs =
    sanitizeDisplayName(connectedName ?? '') ||
    (connectedAddress ? formatAddress(connectedAddress) : 'another account');

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    onClose(
      new Error(`The request is for ${requestedAddress}, which is not the account this app is connected with`),
      standardErrorCodes.rpc.invalidParams
    );
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="bg-card w-full max-w-md rounded-2xl p-8 shadow-xl">
        {/* App Info */}
        {(appLogoUrl || appName) && (
          <div className="border-border mb-6 flex items-center gap-3 border-b pb-6">
            {isSafeImageUrl(appLogoUrl) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={appLogoUrl} alt={safeAppName || 'dApp'} className="h-12 w-12 rounded-lg object-cover" />
            )}
            <div className="flex-1">
              <p className="text-foreground text-sm font-medium">{safeAppName || 'dApp'}</p>
              <p className="text-muted-foreground text-xs">{origin}</p>
            </div>
          </div>
        )}

        {/* Warning Icon */}
        <div className="mb-6 flex justify-center">
          <div className="bg-warning/15 flex h-16 w-16 items-center justify-center rounded-full">
            <svg className="text-warning h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
        </div>

        {/* Content */}
        <div className="mb-8 text-center">
          <h3 className="text-foreground mb-2 text-xl font-bold">Not the connected account</h3>
          <p className="text-muted-foreground text-sm">
            This request is for <span className="text-foreground font-mono">{formatAddress(requestedAddress)}</span>,
            but {safeAppName || 'this app'} is connected as <span className="text-foreground">{connectedAs}</span>.
            Reload {safeAppName || 'the app'} and try again.
          </p>
        </div>

        {/* Close Button */}
        <button
          onClick={handleClose}
          disabled={isClosing}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground w-full rounded-lg px-6 py-3 font-semibold transition-colors"
        >
          {isClosing ? 'Closing...' : 'Close'}
        </button>
      </div>
    </div>
  );
};
