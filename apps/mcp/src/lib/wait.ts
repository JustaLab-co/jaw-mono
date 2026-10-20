import type { ServerContext } from '@modelcontextprotocol/server';
import { errorLabel, log } from './edge';

/** Well under the tool call timeouts of MCP clients, which start around 60 seconds. */
export const MAX_WAIT_SECONDS = 45;
export const POLL_MS = 2_000;
export const MAX_POLLING = 50;
export const MAX_POLLING_PER_CONNECTION = 2;

const polling = new Map<string, number>();
let total = 0;

export interface Waiter {
  signal?: AbortSignal;
  progress?: (seconds: number) => Promise<void>;
}

export function waiterOf(ctx: ServerContext, seconds: number): Waiter {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return { signal: ctx.mcpReq.signal };
  return {
    signal: ctx.mcpReq.signal,
    progress: (progress) =>
      ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total: seconds, message: 'Waiting for the owner' },
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

/** A slot to poll in, or undefined past either cap: the wait then only sleeps and reads once at the end. */
function pollSlot(connectionId: string): (() => void) | undefined {
  const mine = polling.get(connectionId) ?? 0;
  if (total >= MAX_POLLING || mine >= MAX_POLLING_PER_CONNECTION) return undefined;
  polling.set(connectionId, mine + 1);
  total++;
  return () => {
    total--;
    const left = (polling.get(connectionId) ?? 1) - 1;
    if (left) polling.set(connectionId, left);
    else polling.delete(connectionId);
  };
}

/** Rereads until `settled`, the deadline or the client's abort, and returns the last read. Nothing is held between reads. */
export async function waitFor<T>(
  connectionId: string,
  first: T,
  seconds: number,
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  { signal, progress }: Waiter = {},
  pollMs = POLL_MS
): Promise<T> {
  if (settled(first) || seconds <= 0) return first;
  const release = pollSlot(connectionId);
  let value = first;
  try {
    const started = Date.now();
    const end = started + seconds * 1000;
    while (!signal?.aborted && Date.now() < end) {
      await pause(release ? Math.min(pollMs, end - Date.now()) : end - Date.now(), signal);
      if (signal?.aborted) break;
      try {
        value = await read();
      } catch (err) {
        log('warn', { msg: 'wait reread failed', error: errorLabel(err) });
        continue;
      }
      if (settled(value)) break;
      void progress?.((Date.now() - started) / 1000).catch(() => undefined);
    }
  } finally {
    release?.();
  }
  return value;
}
