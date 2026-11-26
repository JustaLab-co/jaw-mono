import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasskeyManager } from '@jaw.id/core';
import { PrfUnavailableError } from '@jaw.id/core/internal';
import { PasskeyService } from './passkey-service';

// Hoisted above the imports by vitest; only derivePrfKeys is replaced.
const { derivePrfKeys } = vi.hoisted(() => ({ derivePrfKeys: vi.fn() }));
vi.mock('@jaw.id/core/internal', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  derivePrfKeys,
}));

const CREDENTIAL_ID = 'cred-1';
const LABELS = ['jaw.id/backup-encryption/v1'] as const;

describe('PasskeyService.derivePrfKeys', () => {
  let record: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('window', { location: { hostname: 'keys.jaw.id' }, PublicKeyCredential: vi.fn() });
    record = vi.spyOn(PasskeyManager.prototype, 'recordAuthenticatorInfo').mockResolvedValue({});
    derivePrfKeys.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    record.mockRestore();
  });

  it('derives for the account passkey on the keys origin', async () => {
    const keys = { 'jaw.id/backup-encryption/v1': new Uint8Array(32).fill(1) };
    derivePrfKeys.mockResolvedValue(keys);

    await expect(new PasskeyService({ apiKey: 'k1' }).derivePrfKeys(CREDENTIAL_ID, LABELS)).resolves.toBe(keys);

    expect(derivePrfKeys).toHaveBeenCalledWith({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID }, LABELS);
  });

  it('records that the passkey supports PRF when keys come back', async () => {
    derivePrfKeys.mockResolvedValue({ 'jaw.id/backup-encryption/v1': new Uint8Array(32) });

    await new PasskeyService({ apiKey: 'k1' }).derivePrfKeys(CREDENTIAL_ID, LABELS);

    expect(record).toHaveBeenCalledWith(CREDENTIAL_ID, { prfSupported: true });
  });

  it('records that the passkey does not support PRF, and still throws', async () => {
    derivePrfKeys.mockRejectedValue(new PrfUnavailableError());

    await expect(new PasskeyService({ apiKey: 'k1' }).derivePrfKeys(CREDENTIAL_ID, LABELS)).rejects.toThrow(
      PrfUnavailableError
    );

    expect(record).toHaveBeenCalledWith(CREDENTIAL_ID, { prfSupported: false });
  });

  it('records nothing when the prompt was cancelled or failed for another reason', async () => {
    derivePrfKeys.mockRejectedValue(new Error('NotAllowedError'));

    await expect(new PasskeyService({ apiKey: 'k1' }).derivePrfKeys(CREDENTIAL_ID, LABELS)).rejects.toThrow(
      'NotAllowedError'
    );

    expect(record).not.toHaveBeenCalled();
  });
});
