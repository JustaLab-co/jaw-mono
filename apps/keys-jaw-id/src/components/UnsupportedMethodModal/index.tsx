'use client';

import { useState } from 'react';
import { standardErrorCodes } from '@jaw.id/core';
import { sanitizeDisplayName, isSafeImageUrl } from '@jaw.id/ui';

export interface UnsupportedMethodModalProps {
  origin: string;
  method: string;
  appName?: string;
  appLogoUrl?: string;
  onClose: (error: Error, errorCode?: number) => void;
}

export const UnsupportedMethodModal = ({
  origin,
  method,
  appName,
  appLogoUrl,
  onClose,
}: UnsupportedMethodModalProps) => {
  const [isClosing, setIsClosing] = useState<boolean>(false);

  // appName is externally-controlled (dApp metadata); sanitize before display.
  const safeAppName = sanitizeDisplayName(appName ?? '') || 'dApp';

  const handleClose = () => {
    if (!isClosing) {
      setIsClosing(true);
      // Method not found (JSON-RPC code -32601)
      onClose(new Error(`Method not supported: ${method}`), standardErrorCodes.rpc.methodNotFound);
    }
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="bg-card w-full max-w-md rounded-2xl p-8 shadow-xl">
        {/* App Info */}
        {(appLogoUrl || appName) && (
          <div className="border-border mb-6 flex items-center gap-3 border-b pb-6">
            {isSafeImageUrl(appLogoUrl) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={appLogoUrl} alt={safeAppName} className="h-12 w-12 rounded-lg object-cover" />
            )}
            <div className="flex-1">
              <p className="text-foreground text-sm font-medium">{safeAppName}</p>
              <p className="text-muted-foreground text-xs">{origin}</p>
            </div>
          </div>
        )}

        {/* Error Icon */}
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
          <h3 className="text-foreground mb-2 text-xl font-bold">Unsupported Method</h3>
          <p className="text-muted-foreground mb-4 text-sm">This wallet does not support the following method:</p>
          <div className="bg-muted rounded-lg p-4">
            <code className="text-foreground break-all font-mono text-sm">{method}</code>
          </div>
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
