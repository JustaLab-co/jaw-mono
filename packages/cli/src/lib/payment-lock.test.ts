import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-payment-lock-test');

vi.mock('./paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-payment-lock-test');
  return { PATHS: { root, config: p.join(root, 'config.json'), paymentLock: p.join(root, 'x402-payment.lock') } };
});

const { withPaymentLock } = await import('./payment-lock.js');
const { PATHS } = await import('./paths.js');

// `beatMs` by default: this stands in for a holder on the current version, which
// is the one the staleness threshold is written for. Omit it for a 0.2.0 holder.
const writeLock = (o: Record<string, unknown>) =>
  fs.writeFileSync(
    PATHS.paymentLock,
    JSON.stringify({ pid: process.pid, token: 'other', at: Date.now(), beatMs: 30_000, ...o })
  );

/**
 * Waits for something the heartbeat does, instead of sleeping long enough that
 * it probably happened. A loaded runner stretches a 20ms interval, and a fixed
 * sleep turns that into a flake.
 */
const isNotLanding = (line: string) => line.includes('heartbeat is not landing');

const waitFor = async (done: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
};

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('withPaymentLock', () => {
  it('runs the work and releases afterwards', async () => {
    const result = await withPaymentLock(async () => 'done');
    expect(result).toBe('done');
    expect(fs.existsSync(PATHS.paymentLock)).toBe(false);
  });

  it('releases even when the work throws', async () => {
    await expect(
      withPaymentLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(PATHS.paymentLock)).toBe(false);
  });

  it('holds the lock for the duration', async () => {
    await withPaymentLock(async () => {
      expect(fs.existsSync(PATHS.paymentLock)).toBe(true);
      const held = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8'));
      expect(held.pid).toBe(process.pid);
    });
  });

  // The whole point: a second payer must not run alongside the first.
  it('refuses rather than running while a live lock is held', async () => {
    writeLock({ pid: process.pid, at: Date.now() });
    const work = vi.fn();
    await expect(withPaymentLock(work, { timeoutMs: 200 })).rejects.toThrow(/Another payment/);
    expect(work).not.toHaveBeenCalled();
  });

  it('names the holder and points at the file when it gives up', async () => {
    writeLock({ pid: process.pid, at: Date.now() });
    await expect(withPaymentLock(async () => 'x', { timeoutMs: 100 })).rejects.toThrow(
      new RegExp(`pid ${process.pid}[\\s\\S]*x402-payment.lock`)
    );
  });

  it('reports the wait once before blocking', async () => {
    writeLock({ pid: process.pid, at: Date.now() });
    const onWait = vi.fn();
    await expect(withPaymentLock(async () => 'x', { timeoutMs: 250, onWait })).rejects.toThrow();
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith(process.pid);
  });

  // A crash leaves the file behind; every later payment would wait it out.
  it('breaks a lock whose holder is gone', async () => {
    writeLock({ pid: 999_999_999, at: Date.now() }); // pid that cannot be alive
    await expect(withPaymentLock(async () => 'ran', { timeoutMs: 500 })).resolves.toBe('ran');
  });

  it('breaks a lock held past the staleness threshold', async () => {
    writeLock({ pid: process.pid, at: Date.now() - 10_000 });
    await expect(withPaymentLock(async () => 'ran', { timeoutMs: 500, staleAfterMs: 1000 })).resolves.toBe('ran');
  });

  it('does not break a live lock that is merely slow', async () => {
    writeLock({ pid: process.pid, at: Date.now() - 500 });
    await expect(withPaymentLock(async () => 'ran', { timeoutMs: 150, staleAfterMs: 60_000 })).rejects.toThrow();
  });

  it('treats an unreadable lock as breakable, not as a permanent block', async () => {
    fs.writeFileSync(PATHS.paymentLock, '{ truncated mid-write');
    // Aged past the torn grace: an unreadable file that is not advancing its
    // mtime really is a leftover, unlike one being written right now.
    const old = Date.now() - 10_000;
    fs.utimesSync(PATHS.paymentLock, new Date(old), new Date(old));
    await expect(withPaymentLock(async () => 'ran', { timeoutMs: 500 })).resolves.toBe('ran');
  });

  // If ours was broken as stale and someone else took the file, releasing must
  // not delete theirs: that would let two payers through, the exact failure the
  // lock exists to prevent.
  it('never deletes a lock that is no longer ours', async () => {
    await withPaymentLock(async () => {
      fs.writeFileSync(PATHS.paymentLock, JSON.stringify({ pid: 1, token: 'someone-else', at: Date.now() }));
    });
    expect(fs.existsSync(PATHS.paymentLock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).token).toBe('someone-else');
  });

  // The point of holding it across the network call: whatever the caller does
  // inside, including writing its result, happens before anyone else reads.
  it('admits no one until the work has finished writing', async () => {
    const events: string[] = [];
    const slowPayer = withPaymentLock(async () => {
      events.push('A: pays');
      await new Promise((r) => setTimeout(r, 120));
      events.push('A: records'); // stands in for appendX402Log
    });
    // Starts while A is mid-payment and has to wait out the recording too.
    await new Promise((r) => setTimeout(r, 20));
    const nextPayer = withPaymentLock(async () => events.push('B: reads'), { timeoutMs: 2000 });

    await Promise.all([slowPayer, nextPayer]);
    expect(events).toEqual(['A: pays', 'A: records', 'B: reads']);
  });

  it('creates the lock file with owner-only permissions', async () => {
    await withPaymentLock(async () => {
      expect(fs.statSync(PATHS.paymentLock).mode & 0o777).toBe(0o600);
    });
  });
});

describe('withPaymentLock heartbeat', () => {
  // The reason the heartbeat exists. Written once, `at` makes the threshold
  // predict how long a payment could take, which is a sum of the timeouts on the
  // payment path: `upto` puts two 90s waits on it, and a second payer arriving
  // mid-payment breaks a live lock and ends up in the critical section beside
  // the first, both having read the same ledger total.
  it('does not let a beating holder be broken as stale', async () => {
    const holder = withPaymentLock(async () => new Promise((r) => setTimeout(r, 400)), { heartbeatMs: 25 });
    await new Promise((r) => setTimeout(r, 40));

    // Would have broken the lock at 200ms without a beat, since `at` never moved.
    await expect(withPaymentLock(async () => 'got in', { staleAfterMs: 200, timeoutMs: 300 })).rejects.toThrow(
      /Another payment/
    );
    await holder;
  });

  it('advances `at` while the work runs', async () => {
    let first = 0;
    let last = 0;
    await withPaymentLock(
      async () => {
        first = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).at;
        await new Promise((r) => setTimeout(r, 120));
        last = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).at;
      },
      { heartbeatMs: 20 }
    );
    expect(last).toBeGreaterThan(first);
  });

  // The beat-side twin of "never deletes a lock that is no longer ours". If ours
  // was broken as stale and someone else took the file, writing our timestamp
  // over theirs would hide a live second payer behind our own liveness.
  it('stops beating once the lock is no longer ours', async () => {
    const foreign = { pid: process.pid, token: 'someone-else', at: Date.now() - 10_000 };
    await withPaymentLock(
      async () => {
        fs.writeFileSync(PATHS.paymentLock, JSON.stringify(foreign));
        await new Promise((r) => setTimeout(r, 120));
      },
      { heartbeatMs: 20 }
    );
    expect(JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8'))).toEqual(foreign);
  });

  // Beats are renamed over the lock rather than written in place. A plain write
  // truncates first, so every interval would reopen the window where the file
  // parses as null and `unreadableLockIsTorn` has to adjudicate it.
  it('is never observed half-written by a concurrent reader', async () => {
    await withPaymentLock(
      async () => {
        const until = Date.now() + 200;
        while (Date.now() < until) {
          const raw = fs.readFileSync(PATHS.paymentLock, 'utf-8');
          expect(JSON.parse(raw).pid).toBe(process.pid);
          await new Promise((r) => setTimeout(r, 1));
        }
      },
      { heartbeatMs: 5 }
    );
  });

  // `readLock` returns null for every failure, not just a foreign holder: EMFILE
  // in a long-lived MCP server, a truncated file, the tick between another
  // payer's `wx` and its write. Reading that as "someone took our lock" ends the
  // heartbeat for the rest of the work, and 90s later a waiter breaks a lock
  // that is very much alive.
  it('keeps beating through a read that comes back empty', async () => {
    // The blip is long enough to reach the warning, so the spy is what keeps it
    // out of the suite's output.
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await withPaymentLock(
        async () => {
          const mine = fs.readFileSync(PATHS.paymentLock, 'utf-8');
          const before = JSON.parse(mine).at;

          fs.writeFileSync(PATHS.paymentLock, ''); // beats land on the blip
          await new Promise((r) => setTimeout(r, 50));
          fs.writeFileSync(PATHS.paymentLock, mine);

          const at = () => JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).at;
          await waitFor(() => at() > before);
          expect(at()).toBeGreaterThan(before);
        },
        { heartbeatMs: 20 }
      );
    } finally {
      written.mockRestore();
    }
  });

  // A beat that finds our own lock already past the threshold must not write it
  // back: a payer reading the file at that moment is entitled to unlink it and
  // take it, and our `release` would then delete theirs mid-payment.
  it('stops beating once our own lock is old enough to be broken', async () => {
    const aged = Date.now() - 500;
    let observed = 0;
    await withPaymentLock(
      async () => {
        const mine = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8'));
        fs.writeFileSync(PATHS.paymentLock, JSON.stringify({ ...mine, at: aged }));
        await new Promise((r) => setTimeout(r, 80));
        observed = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).at;
      },
      { heartbeatMs: 20, staleAfterMs: 100 }
    );
    expect(observed).toBe(aged);
  });

  // `at` moves with every beat, so it can no longer say how long the payment has
  // been running. A waiter that polled a beating holder for the full timeout used
  // to be told the holder had been running for one interval, which also undercut
  // the "remove the file if that process is gone" advice next to it.
  it('reports how long the holder has really held it, not the last beat', async () => {
    writeLock({ startedAt: Date.now() - 8_000, at: Date.now() }); // held for 8s, beat a moment ago
    await expect(withPaymentLock(async () => 'x', { timeoutMs: 100 })).rejects.toThrow(/running for 8s/);
  });

  it('falls back to `at` for a holder that has no `startedAt`', async () => {
    writeLock({ at: Date.now() - 8_000 });
    await expect(withPaymentLock(async () => 'x', { timeoutMs: 100 })).rejects.toThrow(/running for 8s/);
  });

  // A catch that swallows every failure and reports the beat as landed makes a
  // heartbeat that can never land look exactly like one momentary miss. A
  // read-only home is the reachable version: `at` freezes and the next payer
  // breaks a live lock, with nothing anywhere saying why.
  // Skipped as root, where a read-only directory stops nothing.
  it.skipIf(process.getuid?.() === 0)('says so when the beats stop landing', async () => {
    const warnings: string[] = [];
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(((line: unknown) => {
      warnings.push(String(line));
      return true;
    }) as typeof process.stderr.write);
    try {
      await withPaymentLock(
        async () => {
          fs.chmodSync(TEST_ROOT, 0o500); // no new files in the directory
          await waitFor(() => warnings.some(isNotLanding));
          await new Promise((r) => setTimeout(r, 60)); // a few more beats, none of which may warn again
          fs.chmodSync(TEST_ROOT, 0o700);
        },
        { heartbeatMs: 20 }
      );
    } finally {
      fs.chmodSync(TEST_ROOT, 0o700);
      written.mockRestore();
    }

    const notLanding = warnings.filter(isNotLanding);
    expect(notLanding).toHaveLength(1); // once, not once per beat
    expect(notLanding[0]).toMatch(/EACCES[\s\S]*another payment may start alongside this one/);
  });

  // The other door to the same failure: the beat never gets as far as the write
  // because the read before it keeps coming back null. Skipping is right, staying
  // silent about it is not, since `at` freezes either way.
  it('says so when the lock cannot be read at all', async () => {
    const warnings: string[] = [];
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(((line: unknown) => {
      warnings.push(String(line));
      return true;
    }) as typeof process.stderr.write);
    try {
      await withPaymentLock(
        async () => {
          fs.writeFileSync(PATHS.paymentLock, 'not json, so every read comes back null');
          await waitFor(() => warnings.some(isNotLanding));
          await new Promise((r) => setTimeout(r, 60)); // a few more beats, none of which may warn again
        },
        { heartbeatMs: 20 }
      );
    } finally {
      written.mockRestore();
    }

    const notLanding = warnings.filter(isNotLanding);
    expect(notLanding).toHaveLength(1);
    expect(notLanding[0]).toMatch(/the lock cannot be read/);
  });

  it('leaves no staging file behind', async () => {
    await withPaymentLock(async () => new Promise((r) => setTimeout(r, 80)), { heartbeatMs: 10 });
    expect(fs.readdirSync(TEST_ROOT)).toEqual([]);
  });
});

// `@jaw.id/cli` is published and both versions run on one machine, so a lock
// written by a holder that never beats has to keep the threshold it was written
// under. Breaking it at 90s puts two payers against the same cap.
describe('withPaymentLock, a holder from before the heartbeat', () => {
  it('does not break a lock with no `beatMs` at the heartbeat threshold', async () => {
    writeLock({ at: Date.now() - 100_000, beatMs: undefined });
    await expect(withPaymentLock(async () => 'got in', { timeoutMs: 200 })).rejects.toThrow(/Another payment/);
  });

  it('still breaks one past the threshold its own version used', async () => {
    writeLock({ at: Date.now() - 400_000, beatMs: undefined });
    await expect(withPaymentLock(async () => 'ran', { timeoutMs: 500 })).resolves.toBe('ran');
  });

  it('reads a non-numeric `beatMs` as no promise to beat', async () => {
    writeLock({ at: Date.now() - 100_000, beatMs: 'yes' });
    await expect(withPaymentLock(async () => 'got in', { timeoutMs: 200 })).rejects.toThrow(/Another payment/);
  });

  // The floor is a floor: a caller asking for a shorter window does not get to
  // apply it to a holder that was never going to refresh `at`.
  it('ignores a shorter staleAfterMs for a lock with no `beatMs`', async () => {
    writeLock({ at: Date.now() - 100_000, beatMs: undefined });
    await expect(withPaymentLock(async () => 'got in', { timeoutMs: 200, staleAfterMs: 1_000 })).rejects.toThrow(
      /Another payment/
    );
  });
});

describe('withPaymentLock, unreadable and unbreakable locks', () => {
  it('waits out a lock file that is still being written instead of breaking it', async () => {
    // The winner creates the file with `wx` and writes a tick later, so there is
    // a window where its own lock reads as null. Treating that as stale hands
    // the critical section to a second payer, which is what the lock prevents.
    fs.writeFileSync(PATHS.paymentLock, '');

    await expect(withPaymentLock(async () => 'second payer got in', { timeoutMs: 300 })).rejects.toThrow(
      /Another payment has been running/
    );
    expect(fs.existsSync(PATHS.paymentLock)).toBe(true);
  });

  it('still breaks a lock file that has been unreadable long enough to be torn', async () => {
    fs.writeFileSync(PATHS.paymentLock, 'half a json');
    const old = Date.now() - 10_000;
    fs.utimesSync(PATHS.paymentLock, new Date(old), new Date(old));

    await expect(withPaymentLock(async () => 'recovered', { timeoutMs: 2_000 })).resolves.toBe('recovered');
  });

  it('gives up on the deadline when the stale lock cannot be removed', async () => {
    // A directory at the lock path: `wx` keeps returning EEXIST and unlink can
    // never clear it. Retrying without checking the deadline or yielding spins
    // at full CPU forever, which wedges the whole process in `jaw mcp`.
    fs.mkdirSync(PATHS.paymentLock);
    // Aged so it reads as torn, which is what sends the loop down the break
    // path in the first place. Without this the run never gets there.
    const aged = Date.now() - 10_000;
    fs.utimesSync(PATHS.paymentLock, new Date(aged), new Date(aged));
    const timer = vi.fn();
    const handle = setTimeout(timer, 50);

    const started = Date.now();
    await expect(withPaymentLock(async () => 'never', { timeoutMs: 300 })).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(timer).toHaveBeenCalled(); // the event loop kept turning
    clearTimeout(handle);
    fs.rmdirSync(PATHS.paymentLock);
  });
});

describe('withPaymentLock heartbeat staging file', () => {
  // A crash between the staging write and the rename leaves the file behind, and
  // nothing in the CLI sweeps `~/.jaw`. Naming it by pid means the next payment
  // from the same process slot consumes the leftover instead of adding to it; a
  // token, fresh per acquisition, would leave one file per crash forever.
  // `mode` applies only to a write that creates the file, so a leftover with a
  // looser mode was written into and renamed over the lock, carrying its mode
  // onto it. It is the FIRST beat that does it: the one after writes a staging
  // file of its own and puts the mode back, which is why the creation test and
  // any assertion made later both miss it. In production that leaves the lock
  // world-readable for a heartbeat interval.
  it('keeps the lock owner-only across the beat that consumes a leftover', async () => {
    const staging = `${PATHS.paymentLock}.${process.pid}`;
    fs.writeFileSync(staging, 'left over from a crash');
    fs.chmodSync(staging, 0o644);

    let mode = 0;
    await withPaymentLock(
      async () => {
        const at = () => JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')).at;
        const before = at();
        await waitFor(() => at() !== before);
        expect(at()).not.toBe(before); // otherwise the mode below is just the one we created
        mode = fs.statSync(PATHS.paymentLock).mode & 0o777;
      },
      { heartbeatMs: 10 }
    );

    expect(mode).toBe(0o600);
  });

  it('consumes a staging file left behind by an earlier crash', async () => {
    const staging = `${PATHS.paymentLock}.${process.pid}`;
    fs.writeFileSync(staging, 'left over from a crash');

    await withPaymentLock(async () => new Promise((r) => setTimeout(r, 40)), { heartbeatMs: 10 });

    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.readdirSync(TEST_ROOT)).toEqual([]);
  });
});
