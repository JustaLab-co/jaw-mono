import type { LocalStorageAccount } from './types';

/**
 * Choose the account to show in the "Continue with X" screen (Layout A).
 *
 * Precedence:
 *   1. No accounts        -> null (caller shows Layout B / "Sign In").
 *   2. Expected address   -> the stored account with that address, when the request is for one.
 *   3. Last signed-in     -> the account whose credentialId matches
 *      `lastAuthenticatedCredentialId` (from jaw:passkey:authState).
 *   4. Fallback           -> the account with the most recent creationDate.
 */
export function selectDefaultAccount(
  accounts: LocalStorageAccount[],
  lastAuthenticatedCredentialId?: string | null,
  expectedAddress?: string
): LocalStorageAccount | null {
  const selectable = accounts.filter((a) => a.credentialId);
  if (selectable.length === 0) return null;

  if (expectedAddress) {
    const expected = selectable.find((a) => a.address?.toLowerCase() === expectedAddress.toLowerCase());
    if (expected) return expected;
  }

  if (lastAuthenticatedCredentialId) {
    const match = selectable.find((a) => a.credentialId === lastAuthenticatedCredentialId);
    if (match) return match;
  }

  return selectable.reduce((latest, a) => (a.creationDate.getTime() > latest.creationDate.getTime() ? a : latest));
}
