import { Account, type PasskeyAccount } from '@jaw.id/core';
import type { LocalStorageAccount } from './types';

/** Map a stored core account to the OnboardingDialog account shape. */
export function toLocalStorageAccount(account: PasskeyAccount): LocalStorageAccount {
  return {
    username: account.username,
    creationDate: new Date(account.creationDate),
    credentialId: account.credentialId,
    isImported: account.isImported,
    address: account.address,
  };
}

/** Stored accounts in the OnboardingDialog account shape. */
export function getStoredLocalAccounts(apiKey?: string): LocalStorageAccount[] {
  return Account.getStoredAccounts(apiKey).map(toLocalStorageAccount);
}

/**
 * Derive + persist addresses for stored records that predate address
 * persistence (ceremony-free factory derivation), returning credentialId →
 * address for every record that has one.
 */
export async function backfillLocalAccountAddresses(params: {
  chainId?: number;
  apiKey?: string;
}): Promise<Record<string, string>> {
  const accounts = await Account.backfillStoredAccountAddresses({
    chainId: params.chainId ?? 1,
    apiKey: params.apiKey ?? '',
  });
  const byCredentialId: Record<string, string> = {};
  for (const account of accounts) {
    if (account.credentialId && account.address) byCredentialId[account.credentialId] = account.address;
  }
  return byCredentialId;
}

/**
 * credentialId of the currently-authenticated account (from jaw:passkey:authState),
 * used to pick the "Continue as" default in OnboardingDialog.
 */
export function getLastAuthenticatedCredentialId(apiKey?: string): string | null {
  return Account.getCurrentAccount(apiKey)?.credentialId ?? null;
}
