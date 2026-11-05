import { standardErrorCodes } from '@jaw.id/core';

/**
 * The code a failed recovery approval or veto answers with, as the App-Specific dialogs answer:
 * a cancelled passkey prompt or wallet is the user's no (4001), core refusing the request before
 * any prompt keeps its -32602 (not a guardian, or a request that no longer matches its id), and
 * anything else is internal.
 */
export function recoveryErrorCode(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    (error instanceof Error && error.name === 'NotAllowedError') ||
    code === standardErrorCodes.provider.userRejectedRequest
  ) {
    return standardErrorCodes.provider.userRejectedRequest;
  }
  if (code === standardErrorCodes.rpc.invalidParams) return standardErrorCodes.rpc.invalidParams;
  return standardErrorCodes.rpc.internal;
}
