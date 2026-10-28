import { describe, expect, it, vi } from 'vitest';
import { MAX_POLLING, MAX_POLLING_PER_KEY, waitFor, type Waiter } from './wait';

const POLL = 20;

function source(changeAt = Infinity) {
  const counter = { reads: 0 };
  const read = async () => ++counter.reads >= changeAt;
  return { counter, read };
}
const settled = (v: boolean) => v;
const wait = (key: string, seconds: number, read: () => Promise<boolean>, waiter: Waiter = {}, pollMs = POLL) =>
  waitFor(false, { key, until: Date.now() + seconds * 1000, read, settled, pollMs }, waiter);

describe('waitFor', () => {
  it('given a value that changes on the third reread, then it answers with it before the deadline', async () => {
    const { counter, read } = source(3);
    const started = Date.now();

    expect(await wait('c1', 5, read)).toBe(true);
    expect(counter.reads).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('given a first value already settled, then it never rereads', async () => {
    const { counter, read } = source();

    expect(await waitFor(true, { key: 'c1', until: Date.now() + 5_000, read, settled, pollMs: POLL })).toBe(true);
    expect(counter.reads).toBe(0);
  });

  it('given no change, then it answers the last read once the seconds are up, not before', async () => {
    const { read } = source();
    const started = Date.now();

    expect(await wait('c1', 0.3, read)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('given the client aborts, then the wait ends at once', async () => {
    const { read } = source();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const started = Date.now();

    await wait('c1', 10, read, { signal: abort.signal });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('given the client aborts between slow polls, then the sleep ends at once', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const started = Date.now();

    await wait('c1', 10, source().read, { signal: abort.signal }, 5_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('given a client that aborted before the wait, then it answers the first read without sleeping', async () => {
    const { counter, read } = source();
    const started = Date.now();

    await wait('c1', 10, read, { signal: AbortSignal.abort() }, 5_000);

    expect(counter.reads).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('given a reread still running at the deadline, then the wait answers the last value without waiting for it', async () => {
    let reads = 0;
    const read = () => (++reads === 1 ? Promise.resolve(false) : new Promise<boolean>(() => {}));
    const started = Date.now();

    expect(await wait('c1', 0.2, read, {}, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('given a reread that throws, then the wait keeps the last value and reads again', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      if (reads === 1) throw new Error('connect_timeout');
      return reads >= 3;
    };
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      expect(await wait('c1', 5, read)).toBe(true);
      expect(logged.mock.calls.join()).toContain('wait reread failed');
    } finally {
      logged.mockRestore();
    }
  });

  it('given a progress callback, then it hears after each reread that did not settle', async () => {
    let ticks = 0;

    await wait('c1', 5, source(4).read, { progress: async () => void ticks++ });

    expect(ticks).toBe(3);
  });

  it('given a progress callback that fails, then the wait still answers', async () => {
    const progress = async () => {
      throw new Error('stream closed');
    };

    expect(await wait('c1', 5, source(2).read, { progress })).toBe(true);
  });

  it(`given ${MAX_POLLING_PER_KEY} waits polling on one key, then a third reads once at the end, and another key still polls`, async () => {
    const held = Array.from({ length: MAX_POLLING_PER_KEY }, () => wait('busy', 0.4, source().read));
    const third = source();
    const other = source();

    await Promise.all([...held, wait('busy', 0.2, third.read), wait('calm', 0.2, other.read)]);

    expect(third.counter.reads).toBe(1);
    expect(other.counter.reads).toBeGreaterThan(3);
  });

  it('given a wait past the cap, then it still sends progress while it sleeps', async () => {
    const held = Array.from({ length: MAX_POLLING_PER_KEY }, () => wait('full', 0.4, source().read));
    let ticks = 0;

    await Promise.all([...held, wait('full', 0.2, source().read, { progress: async () => void ticks++ })]);

    expect(ticks).toBeGreaterThan(3);
  });

  it(`given ${MAX_POLLING} waits polling in the process, then the next one only sleeps and reads once`, async () => {
    const held = Array.from({ length: MAX_POLLING }, (_, i) => wait(`c${i}`, 0.4, source().read));
    const next = source();

    await Promise.all([...held, wait('last', 0.2, next.read)]);

    expect(next.counter.reads).toBe(1);
  });

  it('given waits that ended, then their polling slots are free again', async () => {
    await Promise.all(Array.from({ length: MAX_POLLING_PER_KEY }, () => wait('again', 0.05, source().read)));
    const after = source();

    await wait('again', 0.2, after.read);

    expect(after.counter.reads).toBeGreaterThan(3);
  });
});
