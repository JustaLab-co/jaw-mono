import { describe, expect, it, vi } from 'vitest';
import { safeFetch } from './safe-fetch';

describe('safeFetch', () => {
  const guarded = safeFetch(new Set(['127.0.0.1:4021']));

  it.each([
    'http://example.com/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[fd00::1]/x',
    'https://localhost/x',
  ])('refuses %s', async (url) => {
    await expect(guarded(url)).rejects.toMatchObject({ name: 'FetchRefused' });
  });

  it('lets an allowed host through over http and never follows redirects', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302 }));
    await guarded('http://127.0.0.1:4021/exact');
    expect(spy).toHaveBeenCalledWith('http://127.0.0.1:4021/exact', { redirect: 'manual' });
    spy.mockRestore();
  });
});
