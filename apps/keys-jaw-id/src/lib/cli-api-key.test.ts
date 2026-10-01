import { describe, it, expect, vi } from 'vitest';
import { resolveBridgeApiKey, fetchCliApiKey } from './cli-api-key';

describe('resolveBridgeApiKey', () => {
  it('keeps the key the CLI sent', async () => {
    const read = vi.fn<[], Promise<string>>();

    await expect(resolveBridgeApiKey('mine', read)).resolves.toBe('mine');
    // Not merely preferred: never asked for. A caller with its own key does not
    // receive ours, so it cannot end up attributing to the wrong workspace.
    expect(read).not.toHaveBeenCalled();
  });

  it('falls back when the CLI sent nothing', async () => {
    const read = vi.fn<[], Promise<string>>().mockResolvedValue('workspace-key');

    await expect(resolveBridgeApiKey(undefined, read)).resolves.toBe('workspace-key');
    await expect(resolveBridgeApiKey('', read)).resolves.toBe('workspace-key');
  });

  it('is empty when neither side has one, so the caller can say so', async () => {
    await expect(resolveBridgeApiKey('', async () => '')).resolves.toBe('');
  });
});

describe('fetchCliApiKey', () => {
  it('reads the key, uncached', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ apiKey: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCliApiKey()).resolves.toBe('k');
    expect(fetchMock).toHaveBeenCalledWith('/api/cli-key', { cache: 'no-store' });

    vi.unstubAllGlobals();
  });

  it('is empty on a refusal and on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(fetchCliApiKey()).resolves.toBe('');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchCliApiKey()).resolves.toBe('');

    vi.unstubAllGlobals();
  });
});
