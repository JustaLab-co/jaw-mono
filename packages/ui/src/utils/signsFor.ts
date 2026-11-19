import type { Account } from '@jaw.id/core';

/**
 * Core's refusals to sign for an account with the restored passkey (`createSmartAccountForAddress`
 * in core's smartAccount.ts). Either way the account's own passkey is the one that can sign:
 * - "Signer is not an owner on account X": the passkey is not among X's owners.
 * - "Account X is not deployed": X has no code, so no extra owner can have been added to it.
 *
 * Matched on the message because core raises both as plain invalid-params errors.
 * signsFor.test.ts gets them from core's own code, so a reworded message fails there.
 */
const REFUSALS = [/Signer is not an owner on account/, /Account 0x[0-9a-fA-F]{40} is not deployed/];

/**
 * Whether `account` (restored from the signed-in passkey) can sign for `address`. False only when
 * core refuses on ownership. Any other failure, such as the network, is thrown as it was.
 */
export async function signsFor(
  account: Pick<Account, 'address' | 'getSmartAccountFor'>,
  address: string | undefined
): Promise<boolean> {
  if (!address || address.toLowerCase() === account.address.toLowerCase()) return true;
  try {
    await account.getSmartAccountFor(address as `0x${string}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (REFUSALS.some((refusal) => refusal.test(message))) return false;
    throw error;
  }
}
