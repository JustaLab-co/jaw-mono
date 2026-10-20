import type { ServerContext } from '@modelcontextprotocol/server';
import { errorLabel, log } from './edge';

/** Well under the tool call timeouts of MCP clients, which start around 60 seconds. */
export const MAX_WAIT_SECONDS = 45;
/** What the summaries ask for, leaving room for the reads around the wait and for clients that time out sooner. */
export const SUGGESTED_WAIT_SECONDS = 30;
export const POLL_MS = 2_000;
export const MAX_POLLING = 50;
export const MAX_POLLING_PER_KEY = 2;

const polling = new Map<string, number>();
let total = 0;

export interface Waiter {
  signal?: AbortSignal;
  progress?: () => Promise<void>;
}

export function waiterOf(ctx: ServerContext, seconds: number): Waiter {
  const started = Date.now();
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return { signal: ctx.mcpReq.signal };
  return {
    signal: ctx.mcpReq.signal,
    progress: () =>
      ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: Math.min(seconds, (Date.now() - started) / 1000),
          total: seconds,
          message: 'Waiting for the owner',
        },
      }),
  };
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });

/** A slot to poll in, or undefined past either cap: the wait then reads once at the end. */
function pollSlot(key: string): (() => void) | undefined {
  const mine = polling.get(key) ?? 0;
  if (total >= MAX_POLLING || mine >= MAX_POLLING_PER_KEY) return undefined;
  polling.set(key, mine + 1);
  total++;
  return () => {
    total--;
    const left = (polling.get(key) ?? 1) - 1;
    if (left) polling.set(key, left);
    else polling.delete(key);
  };
}

export interface Wait<T> {
  /** Polling waits are capped per key, such as one tool on one connection. */
  key: string;
  until: number;
  read: () => Promise<T>;
  settled: (value: T) => boolean;
  pollMs?: number;
}

/** Rereads until `settled`, `until` or the client's abort, and returns the last read. Nothing is held between reads. */
export async function waitFor<T>(
  first: T,
  { key, until, read, settled, pollMs = POLL_MS }: Wait<T>,
  { signal, progress }: Waiter = {}
): Promise<T> {
  if (settled(first) || Date.now() >= until) return first;
  const release = pollSlot(key);
  const tick = () => void progress?.().catch(() => undefined);
  let value = first;
  let failed = false;
  try {
    while (!signal?.aborted && Date.now() < until) {
      await pause(Math.min(pollMs, until - Date.now()), signal);
      if (signal?.aborted) break;
      if (!release && Date.now() < until) {
        tick();
        continue;
      }
      try {
        value = await read();
      } catch (err) {
        if (!failed) log('warn', { msg: 'wait reread failed', error: errorLabel(err) });
        failed = true;
        continue;
      }
      if (settled(value)) break;
      tick();
    }
  } finally {
    release?.();
  }
  return value;
}
