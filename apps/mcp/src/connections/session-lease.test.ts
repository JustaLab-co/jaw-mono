import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepLease, SESSION_RENEW_MS } from './session-lease';

describe('keepLease', () => {
  afterEach(() => vi.useRealTimers());

  it('given a renewal slower than the interval, when stopped, then the lease is cleared after every renewal settled', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const settle: Array<() => void> = [];
    const renew = () =>
      new Promise<boolean>((resolve) => {
        const n = settle.length + 1;
        events.push(`start ${n}`);
        settle.push(() => {
          events.push(`done ${n}`);
          resolve(true);
        });
      });
    const stop = keepLease(renew, async () => void events.push('end'));

    await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS * 2);
    const stopped = stop();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      settle[i]?.();
    }
    await stopped;

    expect(events.at(-1)).toBe('end');
    expect(events.filter((e) => e.startsWith('start')).length).toBe(events.filter((e) => e.startsWith('done')).length);
  });
});
