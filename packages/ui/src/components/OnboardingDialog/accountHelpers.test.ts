// The address backfill used to refuse to run without an api key, which left a
// keyless dApp's account chips with no address. It derives for every caller now.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jaw.id/core', () => ({
  Account: {
    backfillStoredAccountAddresses: vi.fn(),
    getStoredAccounts: vi.fn(() => []),
  },
}));

import { Account } from '@jaw.id/core';
import { backfillLocalAccountAddresses } from './accountHelpers';

const backfillMock = vi.mocked(Account.backfillStoredAccountAddresses);

const ADDRESS = '0x1111111111111111111111111111111111111111';

describe('backfillLocalAccountAddresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives with no api key', async () => {
    backfillMock.mockResolvedValue([{ credentialId: 'cred-1', address: ADDRESS }] as never);

    const byCredentialId = await backfillLocalAccountAddresses({ chainId: 1 });

    expect(backfillMock).toHaveBeenCalledWith({ chainId: 1, apiKey: undefined });
    expect(byCredentialId).toEqual({ 'cred-1': ADDRESS });
  });

  it('defaults to mainnet when the dialog has no chain yet', async () => {
    backfillMock.mockResolvedValue([] as never);

    await backfillLocalAccountAddresses({ apiKey: 'test-key' });

    expect(backfillMock).toHaveBeenCalledWith({ chainId: 1, apiKey: 'test-key' });
  });

  // A record whose derivation failed comes back without an address, and the
  // dialog renders it without a chip rather than with somebody else's.
  it('leaves out the records that resolved nothing', async () => {
    backfillMock.mockResolvedValue([{ credentialId: 'cred-1', address: ADDRESS }, { credentialId: 'cred-2' }] as never);

    expect(await backfillLocalAccountAddresses({ chainId: 1 })).toEqual({ 'cred-1': ADDRESS });
  });
});
