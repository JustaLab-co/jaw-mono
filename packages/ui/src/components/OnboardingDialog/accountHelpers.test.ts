// The address backfill runs for keyless callers too, so it also has to stop
// hammering the rpc when it turns out nothing can be derived: the dialog reopens
// on every request, and a refused derivation stays refused until a reload.
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

const WITH_ADDRESS = [{ credentialId: 'cred-1', address: '0x1111111111111111111111111111111111111111' }];
const WITHOUT_ADDRESS = [{ credentialId: 'cred-1' }];

// The memo is keyed by chain and key, so each case picks its own pair.
describe('backfillLocalAccountAddresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives with no api key', async () => {
    backfillMock.mockResolvedValue(WITH_ADDRESS as never);

    const byCredentialId = await backfillLocalAccountAddresses({ chainId: 1 });

    expect(backfillMock).toHaveBeenCalledWith({ chainId: 1, apiKey: '' });
    expect(byCredentialId).toEqual({ 'cred-1': WITH_ADDRESS[0].address });
  });

  it('keeps deriving while the answers keep coming', async () => {
    backfillMock.mockResolvedValue(WITH_ADDRESS as never);

    await backfillLocalAccountAddresses({ chainId: 10 });
    await backfillLocalAccountAddresses({ chainId: 10 });

    expect(backfillMock).toHaveBeenCalledTimes(2);
  });

  it('stops asking once a derivation resolves nothing', async () => {
    backfillMock.mockResolvedValue(WITHOUT_ADDRESS as never);

    expect(await backfillLocalAccountAddresses({ chainId: 137 })).toEqual({});
    expect(await backfillLocalAccountAddresses({ chainId: 137 })).toEqual({});

    expect(backfillMock).toHaveBeenCalledTimes(1);
  });

  it('memoizes per chain and key, not globally', async () => {
    backfillMock.mockResolvedValue(WITHOUT_ADDRESS as never);
    await backfillLocalAccountAddresses({ chainId: 8453, apiKey: 'a-key' });

    backfillMock.mockResolvedValue(WITH_ADDRESS as never);
    const byCredentialId = await backfillLocalAccountAddresses({ chainId: 8453, apiKey: 'another-key' });

    expect(byCredentialId).toEqual({ 'cred-1': WITH_ADDRESS[0].address });
  });
});
